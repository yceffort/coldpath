import assert from 'node:assert/strict'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {enrichLocations, importSites, webpackGraph, turbopackGraph} from '../lib/graph.ts'

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
  console.log(
    'Verified import declaration/use distinction, type-only imports, source snapshot evidence and malformed native graph rejection.',
  )
} finally {
  await rm(root, {recursive: true, force: true})
}
