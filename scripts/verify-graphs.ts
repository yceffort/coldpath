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
  // A require() is top level only when it runs whenever its module evaluates (#46).
  assert.deepEqual(
    importSites(
      "const a = require('a'); module.exports = {b: require('b').b}; try { require('c') } catch { require('d') }\n" +
        "if (x) require('e'); x && require('f'); function g() { require('g') } const h = () => require('h'); class I { i = require('i') } y ||= require('j')\n" +
        "if (process.env.NODE_ENV === 'production') { module.exports = require('k') } else { module.exports = require('l') }\n" +
        "module.exports = 'production' !== process.env.NODE_ENV ? require('m') : require('n'); if (process.env.FLAG === 'on') require('o')",
      'cjs.js',
    ).map((s) => [s.specifier, s.topLevel]),
    [
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', false],
      ['e', false],
      ['f', false],
      ['g', false],
      ['h', false],
      ['i', false],
      ['j', false],
      ['k', true],
      ['l', true],
      ['m', true],
      ['n', true],
      ['o', false],
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
  assert.equal(turbopack.edges[1].topLevel, true)

  // A warm persistent cache (such as .next/cache) restores modules without building them.
  const cached = join(root, 'cached')
  await mkdir(cached)
  await writeFile(join(cached, 'entry.js'), "import {draw} from './chart.js'\ndraw()\n")
  await writeFile(join(cached, 'chart.js'), 'export function draw() {}\n')
  const buildGraph = async (context = cached) => {
    const compiler = webpack({
      mode: 'production',
      context,
      entry: './entry.js',
      cache: {type: 'filesystem', cacheDirectory: join(context, '.cache')},
      output: {path: join(context, 'dist')},
      plugins: [new ColdpathGraphPlugin()],
    })
    await new Promise((resolve, reject) =>
      compiler.run((error, stats) => (error || stats!.hasErrors() ? reject(error || new Error(stats!.toString())) : resolve(stats))),
    )
    await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())))
    return readFile(join(context, 'dist/coldpath.graph.json'), 'utf8')
  }
  const cold = await buildGraph()
  assert.equal(await buildGraph(), cold, 'modules restored from the webpack cache must stay in the graph')

  // A concatenated inner module keeps every importer, not only webpack's first issuer, which can differ
  // between identical builds (#44).
  const shared = join(root, 'shared')
  await mkdir(shared)
  await writeFile(join(shared, 'entry.js'), "import {a} from './a.js'\nimport {b} from './b.js'\nconsole.log(a(), b())\n")
  await writeFile(join(shared, 'a.js'), "import {value} from './shared.js'\nexport const a = () => value\n")
  await writeFile(join(shared, 'b.js'), "import {value} from './shared.js'\nexport const b = () => value + 1\n")
  await writeFile(join(shared, 'shared.js'), 'export const value = Math.random()\n')
  const concatenated = JSON.parse(await buildGraph(shared))
  const file = (id: string) =>
    concatenated.modules
      .find((m: {id: string}) => m.id === id)
      .source.split('/')
      .at(-1)
  const importers = concatenated.edges.filter((e: {to: string}) => file(e.to) === 'shared.js').map((e: {from: string}) => file(e.from))
  assert.deepEqual([...new Set(importers)].sort(), ['a.js', 'b.js'])
  const sources = concatenated.modules.map((m: {source: string}) => m.source)
  assert.equal(new Set(sources).size + 1, sources.length, 'only the concatenated module repeats its root source')

  // A production build folds process.env.NODE_ENV and keeps only the taken branch's require() (#46).
  const dispatch = join(root, 'dispatch')
  await mkdir(dispatch)
  await writeFile(join(dispatch, 'entry.js'), "import dispatch from './dispatch.js'\nconsole.log(dispatch.name)\n")
  await writeFile(
    join(dispatch, 'dispatch.js'),
    "if (process.env.NODE_ENV === 'production') {\n  module.exports = require('./prod.js')\n} else {\n  module.exports = require('./dev.js')\n}\n",
  )
  await writeFile(join(dispatch, 'prod.js'), "exports.name = 'prod'\n")
  await writeFile(join(dispatch, 'dev.js'), "exports.name = 'dev'\n")
  const dispatched = JSON.parse(await buildGraph(dispatch))
  const name = (id: string) =>
    dispatched.modules
      .find((m: {id: string}) => m.id === id)
      .source.split('/')
      .at(-1)
  assert.deepEqual(
    dispatched.edges
      .filter((e: {from: string}) => name(e.from) === 'dispatch.js')
      .map((e: {to: string; kind: string; topLevel?: boolean}) => [name(e.to), e.kind, e.topLevel]),
    [['prod.js', 'require', true]],
  )

  // Top-level orphans are left out; a concatenated module's root takes its reasons; the issuer is used only
  // when stats carry no reasons (saved without orphanModules).
  const orphans = (rootIssuer: string, innerReasons: object[]) =>
    webpackGraph(
      {
        modules: [
          {identifier: 'main', nameForCondition: '/p/main.js', reasons: [{type: 'entry'}]},
          {identifier: 'other', nameForCondition: '/p/other.js', reasons: [{type: 'entry'}]},
          {
            identifier: 'concat',
            nameForCondition: '/p/page.js',
            reasons: ['main', 'other'].map((from) => ({moduleIdentifier: from, type: 'import()', userRequest: './page.js'})),
            modules: [
              {identifier: 'page', nameForCondition: '/p/page.js', issuer: rootIssuer, reasons: []},
              {identifier: 'inner', nameForCondition: '/p/inner.js', issuer: 'page', reasons: innerReasons},
            ],
          },
          {identifier: 'inner', nameForCondition: '/p/inner.js', orphan: true, reasons: []},
        ],
      },
      '/p',
    )
  const edgeList = (graph: ReturnType<typeof webpackGraph>) => graph.edges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort()
  const inner = [{moduleIdentifier: 'page', type: 'harmony side effect evaluation', userRequest: './inner.js'}]
  assert.deepEqual(edgeList(orphans('main', inner)), edgeList(orphans('other', inner)))
  assert.deepEqual(edgeList(orphans('main', inner)), [
    '0:main dynamic 0:concat',
    '0:main dynamic 0:page',
    '0:other dynamic 0:concat',
    '0:other dynamic 0:page',
    '0:page static 0:inner',
  ])
  assert.deepEqual(
    orphans('main', inner).modules.map((m) => m.id),
    ['0:main', '0:other', '0:concat', '0:page', '0:inner'],
  )
  assert(edgeList(orphans('main', [])).includes('0:page unknown 0:inner'))
  console.log(
    'Verified import declaration/use distinction, type-only imports, source snapshot evidence, malformed native graph rejection, Turbopack import/require separation and webpack graphs from a warm cache.',
  )
} finally {
  await rm(root, {recursive: true, force: true})
}
