// Recover module boundaries from map-less webpack and Turbopack chunks as synthetic source maps.
// Each module factory body becomes one source; chunk wrappers and factory headers (`id:(e,t,n)=>`) stay unmapped,
// because V8 counts a header as observed when its chunk runs even if the factory is never called.
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, relative, resolve, sep} from 'node:path'
import {parse} from '@babel/parser'
import {sha256} from './graph.ts'
import type {Graph, GraphEdge, GraphModule, ImportKind} from './graph.ts'

// Babel AST nodes. The recognizers below check their shapes at runtime.
type AstNode = any
type TableEntry = [id: string, factory: AstNode, node: AstNode]
// `start`/`end`: the recovered source (the factory body). `header`: where the entry, id included, begins.
interface RecoveredModule {
  id: string
  header: number
  start: number
  end: number
  factory?: AstNode
}
type FactoryEdge = {id: string; kind: ImportKind; offset: number}
// Every copy of each module, keyed by chunk global and module id.
type Factories = Map<string, {global: string; copies: {content: string; edges: FactoryEdge[]}[]}>

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const vlq = (value: number) => {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1,
    out = ''
  do {
    let digit = rest & 31
    rest >>>= 5
    if (rest) digit |= 32
    out += B64[digit]
  } while (rest)
  return out
}

async function scripts(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await scripts(path)))
    else if (/\.(m|c)?js$/.test(entry.name)) files.push(path)
  }
  return files
}

const isFunction = (node: AstNode) => /Function|Method/.test(node?.type) && node.params

// A module table entry: `id: factory`, `id(e, t, n) {...}` (webpack 5 method shorthand), or an array element.
function tableEntries(table: AstNode): TableEntry[] {
  if (table?.type === 'ObjectExpression') {
    return table.properties
      .filter((p: AstNode) => ['ObjectProperty', 'ObjectMethod'].includes(p.type) && !p.computed)
      .map((p: AstNode) => [String(p.key.value ?? p.key.name), p.type === 'ObjectProperty' ? p.value : p, p])
  }
  if (table?.type === 'ArrayExpression') return table.elements.map((e: AstNode, i: number) => e && [String(i), e, e]).filter(Boolean)
  return []
}
const tableModules = (entries: TableEntry[]): RecoveredModule[] =>
  entries.map(([id, factory, node]) =>
    isFunction(factory)
      ? {id, header: node.start, start: factory.body.start, end: factory.end, factory}
      : {id, header: node.start, start: node.start, end: node.end},
  )
const isModuleTable = (entries: TableEntry[]) => entries.length > 0 && entries.every(([, factory]) => isFunction(factory))

// The webpack runtime keeps entry modules in its own table: `(() => {var e = {id(e, t, n) {...}}; ...})()` (webpack 5)
// or `!function(e){...}([function(e, t, n) {...}])` (webpack 4). The table must be called as `e[id](...)` or
// `e[id].call(...)` with (module, exports, require). Its chunk global comes from the runtime's `self.X = self.X || []`;
// a runtime without one loads no chunks, and its ids are named after the file.
function runtimeModules(program: AstNode): {global: string | null; modules: RecoveredModule[]; runtime: true} | null {
  for (const statement of program.body) {
    let call = statement.expression
    if (call?.type === 'UnaryExpression') call = call.argument
    if (call?.type !== 'CallExpression' || !isFunction(call.callee) || call.callee.body.type !== 'BlockStatement') continue
    const fn = call.callee
    const tables = [
      [fn.params[0], call.arguments[0]],
      ...fn.body.body
        .filter((s: AstNode) => s.type === 'VariableDeclaration')
        .flatMap((s: AstNode) => s.declarations.map((d: AstNode) => [d.id, d.init])),
    ]
    let names: Set<string> | null = null,
      global: string | null = null
    const scan = (node: AstNode) => {
      if (node.type === 'CallExpression') {
        let callee = node.callee
        if (callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'call') callee = callee.object
        if (callee.type === 'MemberExpression' && callee.computed && callee.object.type === 'Identifier' && node.arguments.length >= 3) {
          names!.add(callee.object.name)
        }
      }
      if (
        node.type === 'AssignmentExpression' &&
        node.left.type === 'MemberExpression' &&
        node.right.type === 'LogicalExpression' &&
        node.right.right.type === 'ArrayExpression' &&
        !node.right.right.elements.length &&
        !node.left.computed
      )
        global ??= node.left.property.name
      children(node).forEach(scan)
    }
    for (const [id, table] of tables) {
      const entries = tableEntries(table)
      if (id?.type !== 'Identifier' || !isModuleTable(entries)) continue
      if (!names) {
        names = new Set()
        scan(fn.body)
      }
      if (names.has(id.name)) return {global, modules: tableModules(entries), runtime: true}
    }
  }
  return null
}

// webpack: `(self.webpackChunkX = self.webpackChunkX || []).push([[chunkIds], {id: factory} | [factory]])`; webpack 4 uses
// `this.webpackJsonp`. A renamed global (`output.chunkLoadingGlobal`, webpack 4 `jsonpFunction`) is recognized when
// every module is a function. Entry chunks: see runtimeModules.
// Turbopack: `(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([currentScript, id, factory, id, factory, ...])`
export function chunkModules(code: string): {global: string | null; modules: RecoveredModule[]; runtime?: true} | null {
  let ast
  try {
    ast = parse(code, {sourceType: 'script', errorRecovery: true})
  } catch {
    return null
  }
  // A prelude such as Sentry's debug-id snippet can join the registration with a comma: `!function(){...}(),(self.X=...).push(...)`.
  const calls = ast.program.body.flatMap(({expression: e}: AstNode) => (e?.type === 'SequenceExpression' ? e.expressions : [e]))
  for (const call of calls) {
    if (call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || call.callee.property.name !== 'push') continue
    let target = call.callee.object
    if (target.type === 'LogicalExpression') target = target.left
    if (target.type === 'AssignmentExpression') target = target.left
    const global = target.type === 'MemberExpression' ? target.property.name : target.name
    const elements = call.arguments[0]?.elements
    if (global === 'TURBOPACK' && elements) {
      const modules: RecoveredModule[] = []
      for (let i = 1; i + 1 < elements.length; i += 2) {
        const [id, factory] = [elements[i], elements[i + 1]]
        if (!['NumericLiteral', 'StringLiteral'].includes(id?.type) || !/Function/.test(factory?.type)) return null
        modules.push({id: String(id.value), header: id.start, start: factory.body.start, end: factory.end, factory})
      }
      return {global, modules}
    }
    if (!global || elements?.[0]?.type !== 'ArrayExpression') continue
    const entries = tableEntries(elements[1])
    if (/^webpack(Chunk|Jsonp)/.test(global) || isModuleTable(entries)) return {global, modules: tableModules(entries)}
  }
  return runtimeModules(ast.program)
}

const literalId = (node: AstNode) => (['NumericLiteral', 'StringLiteral'].includes(node?.type) ? String(node.value) : null)
const children = (node: AstNode): AstNode[] =>
  Object.entries(node)
    .filter(([key]) => !['loc', 'start', 'end', 'extra', 'comments'].includes(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value.type === 'string')

function bindingNames(pattern: AstNode, names: Set<string>): Set<string> {
  if (!pattern) return names
  if (pattern.type === 'Identifier') names.add(pattern.name)
  else if (pattern.type === 'ObjectPattern')
    pattern.properties.forEach((p: AstNode) => bindingNames(p.type === 'RestElement' ? p.argument : p.value, names))
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((e: AstNode) => bindingNames(e, names))
  else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, names)
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument, names)
  return names
}

// Every name a function binds anywhere inside it. Over-approximating only drops edges, never invents them.
function declaresName(fn: AstNode, name: string) {
  const names = new Set<string>()
  const visit = (node: AstNode) => {
    if (isFunction(node)) node.params.forEach((p: AstNode) => bindingNames(p, names))
    if (node.type === 'VariableDeclarator') bindingNames(node.id, names)
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id) names.add(node.id.name)
    if (node.type === 'CatchClause') bindingNames(node.param, names)
    children(node).forEach(visit)
  }
  visit(fn)
  return names.has(name)
}

// Literal module ids a factory loads through its own require binding. Nested functions that rebind that name,
// such as a browserify bundle inside a module, are skipped. Offsets are UTF-16 offsets into the chunk.
// webpack: `n(id)` (a static import or a require, indistinguishable after compilation), `n.bind(n, id)` and `n.t.bind(n, id, mode)`
// after `n.e(chunk)` (dynamic), or with arrow functions `n.e(chunk).then(() => n(id))` and `() => n.t(id, mode)`.
// Turbopack: `e.i(id)` (ESM import), `e.r(id)` (require), `e.A(id)` and the loader's `e.v(t => ...t(id))` (dynamic).
export function factoryEdges(factory: AstNode, bundler: string) {
  const turbopack = bundler === 'turbopack'
  const param = factory.params[turbopack ? 0 : 2]
  if (param?.type !== 'Identifier') return []
  const name = param.name
  const edges: FactoryEdge[] = []
  const isName = (node: AstNode) => node?.type === 'Identifier' && node.name === name
  const isEnsure = (node: AstNode) =>
    node?.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    isName(node.callee.object) &&
    node.callee.property.name === 'e'
  // The promise webpack's import() chains `.then` on: `n.e(chunk)` or `Promise.all([n.e(a), n.e(b)])`. Its `Promise.resolve()`
  // for a module that needs no chunk is left out, since user code `Promise.resolve().then(() => require(x))` compiles the same.
  const isImportPromise = (node: AstNode) =>
    isEnsure(node) ||
    (node?.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'Promise' &&
      node.callee.property.name === 'all' &&
      node.arguments[0]?.type === 'ArrayExpression' &&
      node.arguments[0].elements.length > 0 &&
      node.arguments[0].elements.every(isEnsure))
  const deferred = new Set<AstNode>()
  const visit = (node: AstNode, loaders: Set<string>) => {
    if (node !== factory && isFunction(node) && declaresName(node, name)) return
    if (node.type === 'CallExpression') {
      const {callee, arguments: args} = node
      let id: string | null = null,
        kind: ImportKind | undefined
      const then = args[0]
      if (
        !turbopack &&
        callee.type === 'MemberExpression' &&
        callee.property.name === 'then' &&
        isImportPromise(callee.object) &&
        then?.type === 'ArrowFunctionExpression' &&
        !then.params.length &&
        then.body.type === 'CallExpression' &&
        (isName(then.body.callee) ||
          (then.body.callee.type === 'MemberExpression' && isName(then.body.callee.object) && then.body.callee.property.name === 't'))
      ) {
        deferred.add(then.body)
        ;[id, kind] = [literalId(then.body.arguments[0]), 'dynamic']
      } else if (!turbopack && isName(callee) && !deferred.has(node)) [id, kind] = [literalId(args[0]), 'unknown']
      else if (
        !turbopack &&
        callee.type === 'MemberExpression' &&
        callee.property.name === 'bind' &&
        isName(args[0]) &&
        (isName(callee.object) ||
          (callee.object.type === 'MemberExpression' && isName(callee.object.object) && callee.object.property.name === 't'))
      ) {
        ;[id, kind] = [literalId(args[1]), 'dynamic']
      } else if (turbopack && callee.type === 'MemberExpression' && isName(callee.object)) {
        kind = ({i: 'static', r: 'require', A: 'dynamic'} as Record<string, ImportKind>)[callee.property.name]
        if (kind) id = literalId(args[0])
        if (callee.property.name === 'v' && isFunction(args[0] ?? {}) && args[0].params[0]?.type === 'Identifier') {
          loaders = new Set([...loaders, args[0].params[0].name])
        }
      } else if (callee.type === 'Identifier' && loaders.has(callee.name)) [id, kind] = [literalId(args[0]), 'dynamic']
      if (id !== null) edges.push({id, kind: kind!, offset: node.start})
    }
    children(node).forEach((child) => visit(child, loaders))
  }
  visit(factory, new Set())
  return edges
}

// `ranges`: [{source, start, end}] in UTF-16 offsets; each range becomes one source.
export function moduleMap(code: string, ranges: {source: string; start: number; end: number}[]) {
  const lineStarts = [0]
  for (const match of code.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) lineStarts.push(match.index + match[0].length)
  const position = (offset: number) => {
    const line = lineStarts.findLastIndex((start) => start <= offset)
    return [line, offset - lineStarts[line]]
  }
  const sources: string[] = [],
    sourcesContent: string[] = [],
    points: [offset: number, index: number | null, original?: number][] = []
  for (const {source, start, end} of ranges) {
    const index = sources.push(source) - 1
    sourcesContent.push(code.slice(start, end))
    const [first] = position(start)
    points.push([start, index, 0])
    for (let line = first + 1; line < lineStarts.length && lineStarts[line] < end; line++)
      points.push([lineStarts[line], index, line - first])
    points.push([end, null])
  }
  let line = 0,
    column = 0,
    source = 0,
    originalLine = 0,
    mappings = '',
    first = true
  for (const [offset, index, original] of points) {
    const [l, c] = position(offset)
    for (; line < l; line++, column = 0, first = true) mappings += ';'
    mappings += (first ? '' : ',') + vlq(c - column)
    first = false
    column = c
    if (index === null) continue
    mappings += vlq(index - source) + vlq(original! - originalLine) + 'A'
    source = index
    originalLine = original!
  }
  return {version: 3, sources, sourcesContent, names: [], mappings}
}

// `mapsJson`: existing bindings (such as snapshot's maps.json); scripts bound to a map with sources are left alone.
// `chunks`: a script without recognizable modules becomes one whole-chunk source instead of staying unmapped.
// `graph`: also write a dependency graph (docs/graphs.md format) whose edges are the factories' literal require calls.
export async function inferModules({
  dir,
  out,
  mapsJson = [],
  chunks = false,
  graph,
}: {
  dir?: string
  out?: string
  mapsJson?: string[]
  chunks?: boolean
  graph?: string
}) {
  if (!dir || !out)
    throw new Error('Usage: coldpath modules --dir DIRECTORY --out MAP_DIRECTORY [--maps-json maps.json]... [--chunks] [--graph FILE]')
  dir = resolve(dir)
  out = resolve(out)
  const mapped = new Set()
  for (const file of mapsJson) {
    for (const [bundle, map] of Object.entries(JSON.parse(await readFile(file, 'utf8')))) {
      if (JSON.parse(await readFile(resolve(dirname(file), map as string), 'utf8')).sources?.length) mapped.add(bundle)
    }
  }
  const bindings: Record<string, string> = {}
  const factories: Factories = new Map()
  let modules = 0,
    wholeChunks = 0
  for (const file of await scripts(dir)) {
    const path = relative(dir, file).split(sep).join('/')
    if (mapped.has(path)) continue
    const code = await readFile(file, 'utf8')
    const found = chunkModules(code)
    let ranges
    if (found?.modules.length) {
      found.global ??= `runtime/${path}`
      ranges = found.modules.map(({id, start, end}) => ({source: `webpack://inferred/${found.global}/${id}.js`, start, end}))
      modules += ranges.length
      const bundler = found.global === 'TURBOPACK' ? 'turbopack' : 'webpack'
      for (const {id, start, end, factory} of found.modules) {
        const key = `${found.global}/${id}`
        if (!factories.has(key)) factories.set(key, {global: found.global, copies: []})
        factories.get(key)!.copies.push({
          content: code.slice(start, end),
          edges: factory ? factoryEdges(factory, bundler).map((edge) => ({...edge, offset: edge.offset - start})) : [],
        })
      }
    } else if (chunks && code) {
      ranges = [{source: `webpack://inferred/chunk/${path}`, start: 0, end: code.length}]
      wholeChunks++
    } else continue
    const mapFile = join(out, path + '.map')
    await mkdir(dirname(mapFile), {recursive: true})
    await writeFile(mapFile, JSON.stringify(moduleMap(code, ranges)))
    bindings[path] = relative(out, mapFile).split(sep).join('/')
  }
  await mkdir(out, {recursive: true})
  await writeFile(join(out, 'maps.json'), JSON.stringify(bindings, null, 2) + '\n')
  if (graph) await writeFile(resolve(graph), JSON.stringify(recoveredGraph(factories), null, 2) + '\n')
  console.log(
    `Recovered ${modules} modules in ${Object.keys(bindings).length - wholeChunks} chunks` +
      (chunks ? `, ${wholeChunks} whole-chunk sources` : '') +
      ` -> ${join(out, 'maps.json')}` +
      (graph ? `, ${resolve(graph)}` : ''),
  )
  return bindings
}

const location = (text: string, offset: number) => {
  const before = text.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/)
  return {line: before.length, column: before.at(-1)!.length + 1}
}

// Module ids resolve only within one chunk global. A module shipped in several chunks becomes one graph module;
// its locations and hash are kept only when every copy has the same text.
function recoveredGraph(factories: Factories): Graph {
  const modules: GraphModule[] = [],
    edges: GraphEdge[] = [],
    incoming = new Set<string>()
  let self = 0,
    unresolved = 0
  for (const [key, {global, copies}] of factories) {
    const same = copies.every((copy) => copy.content === copies[0].content)
    modules.push({id: key, source: `${key}.js`, ...(same && {sourceSha256: sha256(copies[0].content)})})
    const seen = new Set()
    for (const copy of same ? copies.slice(0, 1) : copies) {
      for (const {id, kind, offset} of copy.edges) {
        const to = `${global}/${id}`
        if (to === key) {
          self++
          continue
        }
        if (!factories.has(to)) {
          unresolved++
          continue
        }
        if (seen.has(to + kind)) continue
        seen.add(to + kind)
        incoming.add(to)
        edges.push({from: key, to, kind, ...(same && {location: location(copy.content, offset), locationEvidence: 'recovered-factory'})})
      }
    }
  }
  for (const module of modules) if (!incoming.has(module.id)) module.entry = true
  return {
    schemaVersion: 1,
    bundler: 'recovered',
    modules,
    edges,
    warnings: [
      "Graph recovered from minified module factories, not exported by a bundler: edges are literal module ids passed to each factory's require binding, " +
        'and entries are modules that no recovered factory loads.',
      unresolved &&
        `${unresolved} require calls named ids without a recovered factory (runtime modules, chunks not captured, or nested bundles) and were left out.`,
      self && `${self} self references were left out.`,
    ].filter(Boolean) as string[],
  }
}
