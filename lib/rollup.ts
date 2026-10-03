import {resolve} from 'node:path'
import {importSites, sha256, sourcePath} from './graph.ts'
import type {GraphEdge, GraphModule, ImportKind, ImportSite} from './graph.ts'

// The parts of the Rollup and Rolldown plugin APIs used here, so the types need neither package.
interface PluginContext {
  getModuleIds(): IterableIterator<string>
  getModuleInfo(
    id: string,
  ): {isEntry: boolean; isExternal: boolean; importedIds: readonly string[]; dynamicallyImportedIds: readonly string[]} | null
  resolve(source: string, importer?: string): Promise<{id: string; external: boolean | 'absolute' | 'relative'} | null>
  emitFile(file: {type: 'asset'; fileName: string; source: string}): string
}
type OutputBundle = Record<string, {type: 'asset'} | {type: 'chunk'; fileName: string; modules: Record<string, {renderedLength: number}>}>

// Compatible with Rollup and Vite (including the Rolldown-backed Vite build).
export default function coldpathGraph({fileName = 'coldpath.graph.json', root = process.cwd()}: {fileName?: string; root?: string} = {}) {
  const inputs = new Map<string, {sites: ImportSite[]; sourceSha256: string}>()
  let bundler = 'rollup'
  return {
    name: 'coldpath-graph',
    enforce: 'pre' as const,
    configResolved(config: {root: string}) {
      root = config.root
      bundler = 'vite'
    },
    buildStart() {
      inputs.clear()
    },
    transform(code: string, id: string) {
      if (!/\.[cm]?[jt]sx?(?:\?|$)/.test(id)) return null
      try {
        inputs.set(id, {sites: importSites(code, id), sourceSha256: sha256(code)})
      } catch {
        inputs.set(id, {sites: [], sourceSha256: sha256(code)})
      }
      return null
    },
    async generateBundle(this: PluginContext, _options: unknown, bundle: OutputBundle) {
      const ids = [...this.getModuleIds()]
      const sizes = new Map<string, number>(),
        chunks = new Map<string, string[]>()
      for (const output of Object.values(bundle))
        if (output.type === 'chunk') {
          for (const [id, mod] of Object.entries(output.modules)) {
            sizes.set(id, (sizes.get(id) || 0) + (mod.renderedLength || 0))
            if (!chunks.has(id)) chunks.set(id, [])
            chunks.get(id)!.push(output.fileName)
          }
        }
      const modules: GraphModule[] = [],
        edges: GraphEdge[] = [],
        warnings: string[] = []
      for (const id of ids) {
        const info = this.getModuleInfo(id)
        if (!info || info.isExternal) continue
        modules.push({
          id,
          source: sourcePath(id, resolve(root)),
          entry: info.isEntry,
          emittedBytes: sizes.get(id) || 0,
          sourceSha256: inputs.get(id)?.sourceSha256,
          chunks: chunks.get(id) || [],
        })
        const known = new Map([
          ...info.importedIds.map((to): [string, ImportKind] => [to, 'static']),
          ...info.dynamicallyImportedIds.map((to): [string, ImportKind] => [to, 'dynamic']),
        ])
        const located = new Set()
        for (const site of inputs.get(id)?.sites || []) {
          const target = await this.resolve(site.specifier, id)
          if (!target || target.external || !known.has(target.id)) continue
          edges.push({from: id, to: target.id, ...site, locationEvidence: 'plugin-input', sourceSha256: inputs.get(id)!.sourceSha256})
          located.add(target.id)
        }
        for (const [to, kind] of known) {
          if (!located.has(to) && !this.getModuleInfo(to)?.isExternal) edges.push({from: id, to, kind})
        }
      }
      this.emitFile({type: 'asset', fileName, source: JSON.stringify({schemaVersion: 1, bundler, modules, edges, warnings})})
    },
  }
}
