// Negative and positive controls for the label scorer; no model is called.
import assert from 'node:assert/strict'
import {APPLICATION, guessedPackage, packageOf, score} from './label-score.ts'

assert.equal(packageOf('webpack://app/./node_modules/.pnpm/react-dom@19.3.0/node_modules/react-dom/cjs/client.js'), 'react-dom')
assert.equal(packageOf('webpack:///../node_modules/@gitlab/ui/src/link.vue'), '@gitlab/ui')
assert.equal(packageOf('webpack:///src/entry.js'), APPLICATION)
assert.equal(
  packageOf('turbopack:///[project]/node_modules/.pnpm/next@16.3.6/node_modules/next/dist/compiled/path-to-regexp/index.js'),
  'path-to-regexp',
)
assert.equal(packageOf('turbopack:///[project]/node_modules/.pnpm/next@16.3.6/node_modules/next/src/shared/lib/omit.ts'), 'next')
assert.equal(guessedPackage('react-dom/client'), 'react-dom')
assert.equal(guessedPackage('@gitlab/ui (button)'), '@gitlab/ui')
assert.equal(guessedPackage('@gitlab'), null)
assert.equal(guessedPackage('Unrelated feature'), 'unrelated')

const cases: [string, {name: string; kind: string}, boolean, boolean][] = [
  // [truth, label, identity, classification]
  ['@gitlab/ui', {name: '@gitlab/does-not-exist', kind: 'package'}, false, true],
  ['@snowplow/browser-tracker-core', {name: '@snowplow/browser-tracker', kind: 'package'}, false, true],
  ['@snowplow/browser-tracker', {name: '@snowplow/browser-tracker-core', kind: 'package'}, false, true],
  ['react', {name: 'react-dom/server', kind: 'package'}, false, true],
  ['@gitlab/ui', {name: '@gitlab/ui', kind: 'package'}, true, true],
  ['react-dom', {name: 'react-dom/client', kind: 'package'}, true, true],
  ['core-js', {name: 'core-js/modules/es.iterator.every', kind: 'polyfill'}, true, true],
  ['bootstrap-vue', {name: 'bootstrap-vue-next', kind: 'package'}, false, true],
  ['react', {name: 'Counter component', kind: 'app'}, false, false],
]
const truth = new Map(cases.map(([owner], i) => [`m${i}`, owner]))
const result = score(truth, Object.fromEntries(cases.map(([, label], i) => [`m${i}`, label])))
for (const [i, [owner, label, identity, classified]] of cases.entries()) {
  const row = result.rows.find((r) => r.source === `m${i}`)
  assert.equal(row!.identity, identity, `${label.name} vs ${owner}: identity`)
  assert.equal(row!.classified, classified, `${label.name} vs ${owner}: classification`)
}

// Application features are classified but never counted as identified, whatever their name.
const app = score(
  new Map([
    ['a', APPLICATION],
    ['b', APPLICATION],
  ]),
  {a: {name: 'Unrelated feature', kind: 'app'}, b: {name: 'lodash', kind: 'package'}},
)
assert.deepEqual(
  [app.classification, app.packageIdentity, app.applicationFeatureUnscored],
  [{correct: 1, total: 2}, {correct: 0, total: 0}, 2],
)
assert.equal(app.rows[0].identity, null)

// Aliases are explicit, and only they bridge different names.
const vendored = score(
  new Map([['v', 'bootstrap-vue']]),
  {v: {name: 'bootstrap-vue-next', kind: 'package'}},
  {'bootstrap-vue-next': 'bootstrap-vue'},
)
assert.equal(vendored.packageIdentity.correct, 1)

// Guesses the evidence filter removed, and modules with several owners, are counted but not scored.
const rest = score(
  new Map([
    ['s', 'react'],
    ['x', null],
  ]),
  {s: {summary: 'only a summary'}, x: {name: 'react', kind: 'package'}},
)
assert.deepEqual([rest.withoutGuess, rest.mixed, rest.classification.total], [1, 1, 0])
console.log('Verified label scoring controls: scoped names, same-family packages, application features, explicit aliases.')
