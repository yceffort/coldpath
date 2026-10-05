import {mkdir, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import type {Compiler} from 'webpack'
import {enrichLocations, webpackGraph} from './graph.ts'

// Writes the graph after the build, next to the emitted assets.
export default class ColdpathGraphPlugin {
  fileName: string
  root: string | undefined

  constructor({fileName = 'coldpath.graph.json', root}: {fileName?: string; root?: string} = {}) {
    this.fileName = fileName
    this.root = root
  }

  apply(compiler: Compiler) {
    compiler.hooks.done.tapPromise('ColdpathGraphPlugin', async (stats) => {
      if (stats.hasErrors()) return
      const root = resolve(this.root ?? compiler.context)
      const data = stats.toJson({
        all: false,
        modules: true,
        nestedModules: true,
        reasons: true,
        children: true,
        ids: true,
        cachedModules: true,
        // Otherwise reasons from modules outside every chunk, which concatenated inner modules are, are dropped.
        orphanModules: true,
        groupModulesByType: false,
        groupModulesByPath: false,
        groupModulesByAttributes: false,
        modulesSpace: Infinity,
        nestedModulesSpace: Infinity,
      })
      const graph = await enrichLocations(webpackGraph(data, root), root)
      const out = resolve(compiler.outputPath, this.fileName)
      await mkdir(dirname(out), {recursive: true})
      await writeFile(out, JSON.stringify(graph) + '\n')
    })
  }
}
