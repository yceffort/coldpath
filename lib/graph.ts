import {parse} from '@babel/parser'
import {createHash} from 'node:crypto'
import {readFile, realpath} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {isAbsolute, resolve, dirname, relative, join, sep} from 'node:path'

export type ImportKind = 'static' | 'dynamic' | 'require' | 'unknown'
export type LocationEvidence = 'parsed-source' | 'plugin-input' | 'webpack-stats' | 'recovered-factory'
// One-based line and column.
export interface Location {
  line: number
  column: number
}
export interface ImportSite {
  specifier: string
  kind: ImportKind
  location: Location
  locationEvidence: LocationEvidence
}
// The graph JSON format in docs/graphs.md.
export interface GraphModule {
  id: string
  source: string
  entry?: boolean
  emittedBytes?: number | null
  sourceSha256?: string
  chunks?: string[]
}
export interface GraphEdge {
  from: string
  to: string
  kind: ImportKind
  specifier?: string | null
  location?: Location
  locationEvidence?: LocationEvidence
  sourceSha256?: string
}
export interface Graph {
  schemaVersion: 1
  bundler: string
  modules: GraphModule[]
  edges: GraphEdge[]
  warnings: string[]
}

export const sha256 = (source: string | Buffer) => createHash('sha256').update(source).digest('hex')
export const slash = (path: string) => path.replaceAll('\\', '/')
export const sourcePath = (path: string, root: string) =>
  path.startsWith('[project]/') ? path.slice(10) : isAbsolute(path) ? slash(relative(root, path)) : path.replace(/^\.\//, '')

// Parse syntax, never execute a module. Dynamic expressions stay unresolved.
export function importSites(code: string, filename: string): ImportSite[] {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    sourceFilename: filename,
    createImportExpressions: true,
    plugins: ['jsx', 'typescript', 'decorators-legacy', 'importAttributes'],
  })
  const sites: ImportSite[] = []
  // Babel AST nodes, walked generically.
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return
    let value: unknown, kind: ImportKind | undefined
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
      if (node.importKind === 'type' || node.exportKind === 'type') return
      if (node.specifiers?.length && node.specifiers.every((s: any) => s.importKind === 'type' || s.exportKind === 'type')) return
      value = node.source?.value
      kind = 'static'
    } else if (node.type === 'ImportExpression') {
      value = node.source?.value
      kind = 'dynamic'
    } else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
      value = node.arguments[0]?.value
      kind = 'require'
    }
    if (typeof value === 'string')
      sites.push({
        specifier: value,
        kind: kind!,
        location: {line: node.loc.start.line, column: node.loc.start.column + 1},
        locationEvidence: 'parsed-source',
      })
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast.program)
  return sites
}

// Node's require conditions (module-sync included) and realpath; exportedFiles covers a file the bundler chose under other conditions.
function resolvePackage(importer: string, specifier: string) {
  try {
    return createRequire(importer).resolve(specifier)
  } catch {
    return null
  }
}

// Every file the specifier's exports entry names under any condition, read from the package under node_modules that holds `file`.
async function exportedFiles(file: string, specifier: string) {
  const name = specifier.match(/^(?:@[^/]+\/)?[^/]+/)?.[0] ?? ''
  const marker = sep + join('node_modules', name) + sep
  const at = file.lastIndexOf(marker)
  if (!name || at < 0) return []
  const dir = file.slice(0, at + marker.length - 1)
  const {exports} = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8').catch(() => '{}'))
  const map =
    exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports)[0]?.startsWith('.') ? exports : {'.': exports}
  const subpath = '.' + specifier.slice(name.length)
  const leaves = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : []
  return Object.entries(map)
    .flatMap(([key, value]) => {
      if (key === subpath) return leaves(value)
      const [prefix, suffix] = key.split('*')
      if (suffix === undefined || !subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length - 1) return []
      return leaves(value).map((leaf) => leaf.replaceAll('*', subpath.slice(prefix.length, subpath.length - suffix.length)))
    })
    .map((leaf) => resolve(dir, leaf))
}

export async function enrichLocations(graph: Graph, root: string) {
  const modules = new Map(graph.modules.map((m) => [m.id, m]))
  const byFrom = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) {
    if (!byFrom.has(edge.from)) byFrom.set(edge.from, [])
    byFrom.get(edge.from)!.push(edge)
  }
  const cache = new Map<string, {sites: ImportSite[]; hash: string}>()
  const result: GraphEdge[] = []
  let unclassified = 0
  for (const [from, edges] of byFrom) {
    const mod = modules.get(from)
    let sites: ImportSite[] = []
    if (mod && !mod.source.startsWith('[') && !mod.source.includes('\0')) {
      const filename = resolve(root, mod.source)
      try {
        let parsed = cache.get(filename)
        if (!parsed) {
          const code = await readFile(filename, 'utf8')
          parsed = {sites: importSites(code, filename), hash: sha256(code)}
          cache.set(filename, parsed)
        }
        sites = parsed.sites
        mod.sourceSha256 = parsed.hash
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EISDIR')
          graph.warnings.push(`No parsed import locations for ${mod.source}: ${(error as Error).message}`)
      }
    }
    const packages = new Map<string, string | null>()
    for (const edge of edges) {
      const target = modules.get(edge.to)
      const matches: ImportSite[] = []
      let real: string | undefined
      for (const site of sites) {
        if (edge.specifier && site.specifier === edge.specifier) {
          matches.push(site)
          continue
        }
        if (!target) continue
        // Resolve only to a target already established by the bundler graph.
        const expected = resolve(root, target.source)
        if (!site.specifier.startsWith('.')) {
          if (!packages.has(site.specifier)) packages.set(site.specifier, resolvePackage(resolve(root, mod!.source), site.specifier))
          real ??= await realpath(expected).catch(() => expected)
          if (packages.get(site.specifier) === real || (await exportedFiles(real, site.specifier)).includes(real)) matches.push(site)
          continue
        }
        const stem = resolve(root, dirname(mod!.source), site.specifier)
        const candidates = [
          stem,
          ...['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].map((ext) => stem + ext),
          ...['.js', '.jsx', '.ts', '.tsx'].map((ext) => resolve(stem, 'index' + ext)),
        ]
        if (candidates.includes(expected)) matches.push(site)
        else if ((await realpath(stem).catch(() => null)) === expected) matches.push(site)
      }
      // modules.data lists static imports and require() calls together as synchronous edges (see turbopackGraph).
      const synchronous = graph.bundler === 'turbopack' && edge.kind === 'static'
      const compatible = matches.filter(
        (site) => edge.kind === 'unknown' || site.kind === edge.kind || (synchronous && site.kind === 'require'),
      )
      if (compatible.length) for (const site of compatible) result.push({...edge, ...site})
      else if (synchronous && sites.some((site) => site.kind === 'require')) {
        result.push({...edge, kind: 'unknown'})
        unclassified++
      } else result.push(edge)
    }
  }
  graph.edges = result
  if (unclassified)
    graph.warnings.push(
      `${unclassified} synchronous Turbopack edges come from files that also call require() and match neither an import nor a require; they are marked unknown.`,
    )
  return graph
}

// The fields of an esbuild metafile that the adapter reads.
export interface Metafile {
  inputs: Record<string, {imports?: {path: string; kind: string; external?: boolean; original?: string}[]}>
  outputs: Record<string, {entryPoint?: string; inputs?: Record<string, {bytesInOutput: number}>}>
}

export function esbuildGraph(meta: Metafile, root: string): Graph {
  const sizes = new Map<string, number>(),
    entries = new Set<string>()
  const dynamicallyImported = new Set(
    Object.values(meta.inputs).flatMap((input) =>
      (input.imports || []).filter((i) => !i.external && i.kind === 'dynamic-import').map((i) => i.path),
    ),
  )
  for (const [filename, output] of Object.entries(meta.outputs)) {
    if (!/\.[cm]?js$/.test(filename)) continue
    if (output.entryPoint && !dynamicallyImported.has(output.entryPoint)) entries.add(output.entryPoint)
    for (const [id, input] of Object.entries(output.inputs || {})) sizes.set(id, (sizes.get(id) || 0) + input.bytesInOutput)
  }
  return {
    schemaVersion: 1,
    bundler: 'esbuild',
    warnings: [],
    modules: Object.keys(meta.inputs).map((id) => ({
      id,
      source: sourcePath(id, root),
      entry: entries.has(id),
      emittedBytes: sizes.get(id) || 0,
    })),
    edges: Object.entries(meta.inputs).flatMap(([from, input]) =>
      (input.imports || [])
        .filter((i) => !i.external)
        .map((i) => ({
          from,
          to: i.path,
          specifier: i.original,
          kind: i.kind === 'dynamic-import' ? 'dynamic' : i.kind?.startsWith('require') ? 'require' : 'static',
        })),
    ),
  }
}

// The fields of webpack's stats JSON that the adapter reads.
interface WebpackStatsReason {
  type?: string | null
  moduleIdentifier?: string | null
  userRequest?: string | null
  active?: boolean
  loc?: string | null
}
interface WebpackStatsModule {
  identifier?: string
  name?: string
  nameForCondition?: string | null
  issuer?: string | null
  orphan?: boolean
  reasons?: WebpackStatsReason[]
  modules?: WebpackStatsModule[]
}
export interface WebpackStats {
  modules?: WebpackStatsModule[]
  children?: WebpackStats[]
}

export function webpackGraph(stats: WebpackStats, root: string): Graph {
  const graph: Graph = {schemaVersion: 1, bundler: 'webpack', modules: [], edges: [], warnings: []}
  let compilationIndex = 0
  const compilation = (stats: WebpackStats) => {
    const prefix = `${compilationIndex++}:`
    const all: WebpackStatsModule[] = []
    const parents = new Map<WebpackStatsModule, WebpackStatsModule>()
    const entries = new Set<string | undefined>()
    const flatten = (modules: WebpackStatsModule[] | undefined, parent?: WebpackStatsModule) => {
      for (const mod of modules || []) {
        // orphanModules lists modules outside every chunk, such as concatenated inner modules,
        // which also appear nested in their concatenated module.
        if (!parent && mod.orphan) continue
        if (mod.identifier) {
          all.push(mod)
          if (parent) parents.set(mod, parent)
          if (
            (mod.reasons || []).some((r) => r.type === 'entry') ||
            (parent && mod.nameForCondition && entries.has(parent.identifier) && mod.nameForCondition === parent.nameForCondition)
          )
            entries.add(mod.identifier)
        }
        flatten(mod.modules, mod)
      }
    }
    flatten(stats.modules)
    const known = new Set<string | null | undefined>(all.map((m) => m.identifier))
    for (const mod of all) {
      const source = mod.nameForCondition || mod.name || mod.identifier
      graph.modules.push({
        id: prefix + mod.identifier,
        source: sourcePath(source!, root),
        entry: entries.has(mod.identifier),
        emittedBytes: null,
      })
      // A concatenated module holds the incoming reasons of its root module.
      const parent = parents.get(mod)
      const isRoot = parent && mod.nameForCondition && mod.nameForCondition === parent.nameForCondition
      const reasons = [...(mod.reasons || []), ...((isRoot && parent.reasons) || [])].filter(
        (reason) => reason.active !== false && known.has(reason.moduleIdentifier),
      )
      for (const reason of reasons) {
        const kind = /import\(\)/.test(reason.type!)
          ? 'dynamic'
          : /harmony/.test(reason.type!)
            ? 'static'
            : /cjs|require/.test(reason.type!)
              ? 'require'
              : 'unknown'
        // An import-specifier reason points to a USE, not the declaration.
        // Recover the declaration from syntax instead of presenting that use as an import.
        const loc = /harmony import specifier/.test(reason.type!) ? null : /^(\d+):(\d+)(?:-|$)/.exec(reason.loc || '')
        graph.edges.push({
          from: prefix + reason.moduleIdentifier,
          to: prefix + mod.identifier,
          kind,
          specifier: reason.userRequest,
          ...(loc ? {location: {line: Number(loc[1]), column: Number(loc[2]) + 1}, locationEvidence: 'webpack-stats' as const} : {}),
        })
      }
      // Stats without orphanModules drop the reasons of concatenated inner modules. Their first issuer is then
      // the only evidence, though webpack can record a different one for an identical build. Syntax
      // enrichment can prove its import kind and position.
      if (known.has(mod.issuer) && !reasons.length) {
        graph.edges.push({from: prefix + mod.issuer, to: prefix + mod.identifier, kind: 'unknown'})
      }
    }
    for (const child of stats.children || []) compilation(child)
  }
  compilation(stats)
  if (!graph.modules.length) throw new Error('webpack stats needs modules, nestedModules and reasons (without grouped modules)')
  return graph
}

// Next 16.3 analyzer: big-endian JSON header followed by offset-table adjacency lists.
export function turbopackGraph(bytes: Buffer, root: string, environment = 'client'): Graph {
  const get = (offset: number, data = bytes) => {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > data.length) throw new Error('Invalid Turbopack edge offset')
    return data.readUInt32BE(offset)
  }
  const length = get(0)
  if (length > bytes.length - 4) throw new Error('Truncated Turbopack module header')
  const header = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'))
  const binary = bytes.subarray(4 + length)
  if (!Array.isArray(header.modules) || !header.module_dependencies || !header.async_module_dependencies)
    throw new Error('Unsupported Turbopack modules.data schema')
  // Header JSON: {modules: [{ident, path}], <field>: {offset, length}}.
  const keep = (mod: any) =>
    environment === 'all' || (environment === 'client' ? /\[(?:app-)?client\]/.test(mod.ident) : !/\[(?:app-)?client\]/.test(mod.ident))
  const modules: GraphModule[] = header.modules.flatMap((mod: any, i: number) =>
    keep(mod) ? [{id: String(i), source: sourcePath(mod.path, root), entry: mod.path.startsWith('[next]/entry/'), emittedBytes: null}] : [],
  )
  const ids = new Set(modules.map((m) => m.id)),
    edges: GraphEdge[] = []
  // module_dependencies holds static imports and require() calls alike; enrichLocations tells them apart from source.
  for (const [field, kind] of [
    ['module_dependencies', 'static'],
    ['async_module_dependencies', 'dynamic'],
    ['traced_module_dependencies', 'unknown'],
  ] as const) {
    const ref = header[field]
    if (!ref?.length) continue
    if (ref.offset < 0 || ref.offset + ref.length > binary.length) throw new Error('Invalid Turbopack adjacency bounds')
    const block = binary.subarray(ref.offset, ref.offset + ref.length)
    const count = get(0, block)
    if (count > header.modules.length || 4 + count * 4 > block.length) throw new Error('Invalid Turbopack adjacency count')
    let previous = 0
    for (let from = 0; from < count; from++) {
      const end = get(4 + from * 4, block)
      if (end < previous || 4 + count * 4 + end * 4 > block.length) throw new Error('Invalid Turbopack adjacency range')
      for (let j = previous; j < end; j++) {
        const to = get(4 + count * 4 + j * 4, block)
        if (to >= header.modules.length) throw new Error('Invalid Turbopack dependency index')
        if (ids.has(String(from)) && ids.has(String(to))) edges.push({from: String(from), to: String(to), kind})
      }
      previous = end
    }
  }
  if (!modules.some((m) => m.entry)) {
    const targets = new Set(edges.map((e) => e.to))
    for (const mod of modules) mod.entry = !targets.has(mod.id)
  }
  return {
    schemaVersion: 1,
    bundler: 'turbopack',
    modules,
    edges,
    warnings: [
      'Turbopack analyzer graphs are experimental and produced separately from the application build. Keep both from the same source revision.',
    ],
  }
}
