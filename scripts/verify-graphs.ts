import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import webpack from 'webpack'
import {enrichLocations, importSites, webpackGraph, turbopackGraph} from '../lib/graph.ts'
import ColdpathGraphPlugin from '../lib/webpack.ts'

const root = await mkdtemp(join(tmpdir(), 'coldpath-graphs-'))
try {
  const code = "import {draw} from './chart.js';\n\ndraw();\n"
  await writeFile(join(root, 'entry.js'), code)
  const stats = {
    modules: [
      {identifier: 'entry', nameForCondition: join(root, 'entry.js'), reasons: [{type: 'entry'}]},
      {
        identifier: 'chart',
        nameForCondition: join(root, 'chart.js'),
        reasons: [{moduleIdentifier: 'entry', type: 'harmony import specifier', userRequest: './chart.js', loc: '3:0-4', active: true}],
      },
    ],
  }
  const raw = webpackGraph(stats, root)
  assert.equal(raw.edges[0].location, undefined, 'a use location must not be presented as an import')
  const graph = await enrichLocations(raw, root)
  assert.equal(graph.edges[0].location!.line, 1)
  assert.equal(graph.edges[0].locationEvidence, 'parsed-source')
  assert.match(graph.modules[0].sourceSha256!, /^[a-f0-9]{64}$/)
  const sites = importSites(
    "import type {A} from 'a'; import {type B} from 'b'; export type {C} from 'c'; import {D} from 'd'; import('e'); require('f');",
    'source.ts',
  )
  assert.deepEqual(
    sites.map((s) => [s.specifier, s.kind]),
    [
      ['d', 'static'],
      ['e', 'dynamic'],
      ['f', 'require'],
    ],
  )
  assert.throws(() => turbopackGraph(Buffer.from([0, 0, 0, 99]), root), /Truncated/)
  const header = Buffer.from(
    JSON.stringify({modules: [], module_dependencies: {offset: 1, length: 100}, async_module_dependencies: {offset: 0, length: 0}}),
  )
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(header.length)
  assert.throws(() => turbopackGraph(Buffer.concat([prefix, header]), root), /bounds/)

  // modules.data puts static imports and require() calls in one synchronous list; the importer's source tells them apart.
  await writeFile(join(root, 'page.js'), "import {a} from './esm.js'\nconst c = require('./cjs.js')\n")
  await writeFile(join(root, 'mixed.js'), "import 'pkg'\nrequire('dep')\nrequire('cond/_/x')\n")
  await writeFile(join(root, 'pure.js'), "import 'pkg'\n")
  await mkdir(join(root, 'node_modules/dep'), {recursive: true})
  await writeFile(join(root, 'node_modules/dep/index.js'), '')
  // Node's require takes module-sync (esm); the bundler took the default (cjs) file.
  await mkdir(join(root, 'node_modules/cond/esm'), {recursive: true})
  await mkdir(join(root, 'node_modules/cond/cjs'), {recursive: true})
  await writeFile(
    join(root, 'node_modules/cond/package.json'),
    JSON.stringify({exports: {'./_/*': {'module-sync': './esm/*.js', default: './cjs/*.cjs'}}}),
  )
  await writeFile(join(root, 'node_modules/cond/esm/x.js'), '')
  await writeFile(join(root, 'node_modules/cond/cjs/x.cjs'), '')
  const names = ['page.js', 'esm.js', 'cjs.js', 'mixed.js', 'pure.js', 'pkg.js', 'node_modules/dep/index.js', 'node_modules/cond/cjs/x.cjs']
  const sync: [number, number][] = [
    [0, 1],
    [0, 2],
    [3, 5],
    [3, 6],
    [3, 7],
    [4, 5],
  ]
  const block = Buffer.alloc(4 + names.length * 4 + sync.length * 4)
  block.writeUInt32BE(names.length)
  names.forEach((_, from) => block.writeUInt32BE(sync.filter(([f]) => f <= from).length, 4 + from * 4))
  sync.forEach(([, to], i) => block.writeUInt32BE(to, 4 + names.length * 4 + i * 4))
  const syncHeader = Buffer.from(
    JSON.stringify({
      modules: names.map((name) => ({ident: `[project]/${name} [client] (ecmascript)`, path: `[project]/${name}`})),
      module_dependencies: {offset: 0, length: block.length},
      async_module_dependencies: {offset: 0, length: 0},
    }),
  )
  const syncPrefix = Buffer.alloc(4)
  syncPrefix.writeUInt32BE(syncHeader.length)
  const turbopack = await enrichLocations(turbopackGraph(Buffer.concat([syncPrefix, syncHeader, block]), root), root)
  assert.deepEqual(
    turbopack.edges.map((e) => [names[Number(e.from)], names[Number(e.to)], e.kind, e.location?.line ?? null]),
    [
      ['page.js', 'esm.js', 'static', 1],
      ['page.js', 'cjs.js', 'require', 2],
      ['mixed.js', 'pkg.js', 'unknown', null],
      ['mixed.js', 'node_modules/dep/index.js', 'require', 2],
      ['mixed.js', 'node_modules/cond/cjs/x.cjs', 'require', 3],
      ['pure.js', 'pkg.js', 'static', null],
    ],
  )
  assert.match(turbopack.warnings.join('\n'), /1 synchronous Turbopack edges/)

  // A warm persistent cache (such as .next/cache) restores modules without building them.
  const cached = join(root, 'cached')
  await mkdir(cached)
  await writeFile(join(cached, 'entry.js'), "import {draw} from './chart.js'\ndraw()\n")
  await writeFile(join(cached, 'chart.js'), 'export function draw() {}\n')
  const buildGraph = async () => {
    const compiler = webpack({
      mode: 'production',
      context: cached,
      entry: './entry.js',
      cache: {type: 'filesystem', cacheDirectory: join(cached, '.cache')},
      output: {path: join(cached, 'dist')},
      plugins: [new ColdpathGraphPlugin()],
    })
    await new Promise((resolve, reject) =>
      compiler.run((error, stats) => (error || stats!.hasErrors() ? reject(error || new Error(stats!.toString())) : resolve(stats))),
    )
    await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())))
    return readFile(join(cached, 'dist/coldpath.graph.json'), 'utf8')
  }
  const cold = await buildGraph()
  assert.equal(await buildGraph(), cold, 'modules restored from the webpack cache must stay in the graph')
  console.log(
    'Verified import declaration/use distinction, type-only imports, source snapshot evidence, malformed native graph rejection, Turbopack import/require separation and webpack graphs from a warm cache.',
  )
} finally {
  await rm(root, {recursive: true, force: true})
}
