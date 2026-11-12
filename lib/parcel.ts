import {dirname, join, relative, resolve} from 'node:path'
import {enrichLocations, graphRoot, slash, sourcePath} from './graph.ts'
import type {Graph, GraphEdge, GraphModule} from './graph.ts'

// The parts of Parcel's reporter API used here, so the types need no Parcel package.
interface Asset {
  id: string
  filePath: string
  type: string
}
interface Dependency {
  id: string
  specifier: string
  specifierType: 'esm' | 'commonjs' | 'url' | 'custom'
  priority: 'sync' | 'parallel' | 'lazy'
}
interface Bundle {
  type: string
  filePath: string
  target: {distDir: string}
  traverseAssets(visit: (asset: Asset) => void): void
}
interface BundleGraph {
  getBundles(): Bundle[]
  getAssetById(id: string): Asset
  getDependencies(asset: Asset): Dependency[]
  getIncomingDependencies(asset: Asset): Dependency[]
  isDependencySkipped(dependency: Dependency): boolean
  getResolvedAsset(dependency: Dependency, bundle: Bundle): Asset | null | undefined
  resolveAsyncDependency(
    dependency: Dependency,
    bundle: Bundle,
  ): {type: 'bundle_group'; value: {entryAssetId: string}} | {type: 'asset'; value: Asset} | null | undefined
}
interface ReportArguments {
  event: {type: string; bundleGraph?: BundleGraph}
  options: {
    projectRoot: string
    outputFS: {readFile(path: string, encoding: 'utf8'): Promise<string>; writeFile(path: string, contents: string): Promise<unknown>}
  }
}

const fileName = 'coldpath.graph.json'

async function report({event, options}: ReportArguments) {
  if (event.type !== 'buildSuccess') return
  const bundleGraph = event.bundleGraph!
  const root = options.projectRoot
  // One graph for each output directory, so a build with several targets writes several.
  const targets = new Map<string, Bundle[]>()
  for (const bundle of bundleGraph.getBundles()) targets.set(bundle.target.distDir, [...(targets.get(bundle.target.distDir) ?? []), bundle])
  for (const [distDir, bundles] of targets) {
    const modules = new Map<string, GraphModule & {chunks: string[]}>()
    for (const bundle of bundles)
      bundle.traverseAssets((asset) => {
        if (asset.type !== 'js') return
        if (!modules.has(asset.id)) modules.set(asset.id, {id: asset.id, source: sourcePath(asset.filePath, root), chunks: []})
        modules.get(asset.id)!.chunks.push(slash(relative(distDir, bundle.filePath)))
      })
    const edges = new Map<string, GraphEdge>()
    const fromModules = new Set<string>()
    for (const bundle of bundles)
      bundle.traverseAssets((asset) => {
        if (!modules.has(asset.id)) return
        for (const dependency of bundleGraph.getDependencies(asset)) {
          fromModules.add(dependency.id)
          if (bundleGraph.isDependencySkipped(dependency)) continue
          const kind =
            dependency.specifierType === 'commonjs'
              ? 'require'
              : dependency.specifierType !== 'esm'
                ? 'unknown'
                : dependency.priority === 'lazy'
                  ? 'dynamic'
                  : 'static'
          // A dependency that loads another bundle resolves, in this bundle, to the runtime module Parcel adds for it.
          // The module it loads is the entry of the bundle group.
          const loaded = dependency.priority === 'lazy' ? bundleGraph.resolveAsyncDependency(dependency, bundle) : null
          for (const to of [
            bundleGraph.getResolvedAsset(dependency, bundle),
            loaded?.type === 'bundle_group' ? bundleGraph.getAssetById(loaded.value.entryAssetId) : loaded?.value,
          ])
            if (to && modules.has(to.id))
              edges.set([asset.id, to.id, kind, dependency.specifier].join('\0'), {
                from: asset.id,
                to: to.id,
                kind,
                specifier: dependency.specifier,
              })
        }
      })
    // A root is a module that something other than a module asks for: the build's entry, or a script element of a page.
    // The entry of a bundle is not one when a module loads that bundle.
    for (const module of modules.values())
      module.entry = bundleGraph
        .getIncomingDependencies(bundleGraph.getAssetById(module.id))
        .some((dependency) => !fromModules.has(dependency.id))
    if (![...modules.values()].some((module) => module.entry)) continue

    const graph: Graph = {schemaVersion: 1, bundler: 'parcel', modules: [...modules.values()], edges: [...edges.values()], warnings: []}
    // Parcel names the sources of a map from the project root. A production build for the browser writes no sourceRoot,
    // so the analyzer resolves them from the directory of the bundle, and the graph must name that directory as its root.
    const roots = new Map<string, string>()
    for (const bundle of bundles) {
      const directory = dirname(bundle.filePath)
      if (bundle.type !== 'js' || roots.has(directory)) continue
      const map = await options.outputFS.readFile(bundle.filePath + '.map', 'utf8').then(JSON.parse, () => null)
      if (map) roots.set(directory, resolve(directory, typeof map.sourceRoot === 'string' ? map.sourceRoot : '.'))
    }
    const [mapped = root, ...others] = new Set(roots.values())
    if (others.length)
      graph.warnings.push(
        `Parcel's source maps resolve their sources from ${others.length + 1} directories (${[mapped, ...others].map((directory) => slash(relative(distDir, directory)) || '.').join(', ')} in the output directory), and the graph matches only the first. Set the target's sourceMap.inlineSources to false so that Parcel writes a sourceRoot.`,
      )
    const out = join(distDir, fileName)
    await options.outputFS.writeFile(out, JSON.stringify({...(await enrichLocations(graph, root)), root: graphRoot(mapped, out)}) + '\n')
  }
}

// Parcel reads a plugin's hooks from this registered symbol, which is all the Reporter class of @parcel/plugin sets,
// so the reporter needs no Parcel package.
export default {[Symbol.for('parcel-plugin-config')]: {report}}
