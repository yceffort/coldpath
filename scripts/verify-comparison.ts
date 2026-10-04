import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, readFile, writeFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {chromium} from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'artifacts/scenario-comparison')
const input = join(output, 'input')
await rm(input, {recursive: true, force: true})
await mkdir(input, {recursive: true})
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const binary = join(root, 'target/debug/coldpath')
const initial = join(output, 'initial.json')
const interaction = join(output, 'interaction.json')
const search = join(output, 'search.json')
const baseline = join(output, 'main.json')
const report = join(output, 'pr.json')
const html = join(output, 'pr.html')
const meta = join(output, 'graph.json')
const write = (path: string, data: unknown) => writeFile(path, JSON.stringify(data))
const map = (sources: string[]) => ({
  version: 3,
  sources,
  sourcesContent: sources.map((s) => '// original ' + s),
  names: [],
  mappings: sources.map((_, i) => (i ? 'ICAA' : 'AAAA')).join(','),
})
const record = (url: string, text: string, ranges: [number, number][]) => ({
  url,
  text,
  ranges: ranges.map(([start, end]) => ({start, end})),
})
const args = [
  '--dir',
  input,
  '--coverage',
  search,
  '--coverage',
  initial,
  '--coverage',
  interaction,
  '--initial-scenario',
  'initial.json',
  '--scenario-order',
  'initial.json,interaction.json,search.json',
  '--source-compression',
]

await writeFile(join(input, 'app.js'), 'abcdefghijkl')
await write(join(input, 'app.js.map'), map(['src/initial.ts', 'src/removed.ts', 'src/later.ts']))
await write(initial, [record('app.js', 'abcdefghijkl', [[0, 4]])])
await write(interaction, [record('app.js', 'abcdefghijkl', [[8, 12]])])
await write(search, [record('app.js', 'abcdefghijkl', [[8, 12]])])
execFileSync(binary, [...args, '--json', baseline], {stdio: 'pipe'})

await writeFile(join(input, 'app.js'), 'abcdefghijklmnop')
await write(join(input, 'app.js.map'), map(['src/initial.ts', 'src/later.ts', 'src/never.ts', 'src/mixed.ts']))
await writeFile(join(input, 'lazy.js'), 'lazy')
await write(join(input, 'lazy.js.map'), map(['src/lazy.ts']))
await writeFile(join(input, 'absent.js'), 'none')
await write(initial, [
  record('app.js', 'abcdefghijklmnop', [
    [0, 4],
    [12, 14],
  ]),
])
await write(interaction, [
  record('app.js', 'abcdefghijklmnop', [
    [4, 8],
    [13, 15],
  ]),
  record('lazy.js', 'lazy', [[0, 4]]),
])
await write(search, [record('app.js', 'abcdefghijklmnop', [[14, 16]])])
await write(meta, {
  schemaVersion: 1,
  bundler: 'webpack',
  modules: [
    {id: 'dashboard', source: 'src/dashboard.ts', entry: true},
    {id: 'later', source: 'src/later.ts'},
  ],
  edges: [{from: 'dashboard', to: 'later', kind: 'static', location: {line: 12, column: 1}, locationEvidence: 'webpack-stats'}],
})
execFileSync(
  binary,
  [...args, '--baseline', baseline, '--graph', meta, '--graph-root', input, '--details', '--json', report, '--treemap', html],
  {stdio: 'pipe'},
)
const data = JSON.parse(await readFile(report, 'utf8'))
assert.equal(data.baseline.totals.delta.bytes, 12)
assert.equal(data.scenarioReports[1].interactionCandidates.find((s: any) => s.source === 'src/mixed.ts').interactionOnlyBytes, 1)
assert.equal(data.scenarioReports[1].interactionCandidates.find((s: any) => s.source === 'src/lazy.ts').initialUnmeasuredObservedBytes, 4)

// Tiles directly inside the focus; nested tiles repeat their contents' bytes.
const top = '.tile[data-depth="0"]'
const browser = await chromium.launch({headless: true})
try {
  // Without motion a view's tiles are the only tiles on the page.
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}, reducedMotion: 'reduce'})
  const errors: string[] = [],
    requests: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url())
  })
  await page.goto(pathToFileURL(html).href)
  assert.match((await page.locator('#headline').textContent())!, /loaded 20 B of JavaScript\. 4 B \(20%\) of it never ran/)
  assert.match(await page.locator('#later-list').innerText(), /later\.ts\s+4 B\s+Runs only in "interaction\.json": src\/later\.ts/)
  assert.match(await page.locator('#later-list').innerText(), /mixed\.ts\s+2 B\s+Runs only in "search\.json"/)
  await page.getByRole('button', {name: 'Show them'}).click()
  // Reports open in Coverage, even with several scenarios. First observed scenario colors each tile by its largest part.
  assert.equal(await page.getByLabel('Color tiles by').inputValue(), 'coverage')
  await page.getByLabel('Color tiles by').selectOption('phases')
  assert.equal(await page.locator(top).evaluateAll((tiles) => tiles.reduce((n, t) => n + Number(t.dataset.bytes), 0)), 24)
  assert.equal(await page.locator(top).evaluateAll((tiles) => tiles.reduce((n, t) => n + Number(t.dataset.interactionOnly), 0)), 6)
  assert.equal(await page.locator(top).evaluateAll((tiles) => tiles.reduce((n, t) => n + Number(t.dataset.initialUnknown), 0)), 4)
  assert.match((await page.locator('#legend').textContent())!, /earlier scenarios unmeasured/)
  assert.match((await page.locator('#legend').textContent())!, /First observed: search.json/)
  assert.equal(await page.locator(top).evaluateAll((tiles) => tiles.reduce((n, t) => n + JSON.parse(t.dataset.firstObserved!)[2], 0)), 1)
  assert.match((await page.locator('#action-list').textContent())!, /Review lazy loading/)
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByRole('button', {name: 'src', exact: true}).click()
  assert.match((await page.locator('.tile').filter({hasText: 'later.ts'}).getAttribute('style'))!, /--interaction/)
  await page.screenshot({path: join(output, 'phases.png'), fullPage: true})
  await page.getByRole('button', {name: 'later.ts', exact: true}).click()
  assert.match((await page.locator('#file').textContent())!, /src\/dashboard.ts → src\/later.ts/)
  assert.match((await page.locator('#file').textContent())!, /src\/dashboard.ts:12:1/)
  assert.match((await page.locator('#file').textContent())!, /Estimated isolated source size: gzip/)
  const inspector = page.frameLocator('#code-frame')
  await inspector.locator('#source-title').filter({hasText: 'later.ts'}).waitFor()
  await inspector.locator('#view-generated').click()
  assert.match((await inspector.locator('#generated').textContent())!, /efgh/)
  assert((await inspector.locator('#generated mark.observed:not(.dim)').count()) > 0)
  await inspector.getByLabel('Code scenario').selectOption('initial.json')
  assert.equal(await inspector.locator('#generated mark.observed:not(.dim)').count(), 0)
  assert((await inspector.locator('#generated mark.unobserved:not(.dim)').count()) > 0)
  await inspector.getByLabel('Code scenario').selectOption('interaction.json')
  assert((await inspector.locator('#generated mark.observed:not(.dim)').count()) > 0)
  assert.equal(await inspector.locator('#generated mark.unobserved:not(.dim)').count(), 0)
  await page.screenshot({path: join(output, 'inspector.png'), fullPage: true})
  assert(await inspector.locator('#generated-view').isVisible())
  assert.equal(await inspector.locator('#view-generated').getAttribute('aria-pressed'), 'true')
  await page.locator('#options summary').click()
  await page.getByLabel('Color tiles by').selectOption('changes')
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByRole('button', {name: 'src', exact: true}).click()
  assert.equal(await page.locator(top + '.new-source').count(), 2)
  assert.match((await page.locator('#removed-list').textContent())!, /src\/removed.ts: -4 B/)
  assert.match((await page.locator('#comparison').textContent())!, /\+12 generated B/)
  await page.screenshot({path: join(output, 'changes.png'), fullPage: true})
  await page.getByLabel('Coverage scenario').selectOption('initial.json')
  assert.deepEqual(await page.locator('#stats strong').allTextContents(), ['24 B', '6 B', '10 B', '8 B'])
  assert.match((await page.locator('#comparison').textContent())!, /\+2 unobserved B/)
  assert(await page.locator('#actions').evaluate((details: HTMLDetailsElement) => details.open), 'review actions are expanded by default')
  await page.locator('#action-list button').filter({hasText: 'src/later.ts'}).click()
  await page.frameLocator('#code-frame').getByLabel('Code scenario').waitFor()
  assert.equal(await page.frameLocator('#code-frame').getByLabel('Code scenario').inputValue(), 'initial.json')
  assert.equal(await page.frameLocator('#code-frame').locator('#generated mark.observed:not(.dim)').count(), 0)
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByRole('button', {name: 'src', exact: true}).click()
  await page.getByRole('searchbox').fill('never')
  assert.equal(await page.locator('#rows tr').count(), 1)
  assert.equal(await page.locator(top).getAttribute('data-bytes'), '4')
  await page.getByRole('searchbox').fill('')
  await page.setViewportSize({width: 390, height: 844})
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({path: join(output, 'mobile.png'), fullPage: true})
  await page.emulateMedia({colorScheme: 'dark'})
  await page.screenshot({path: join(output, 'dark.png'), fullPage: true})
  assert.deepEqual(errors, [])
  assert.deepEqual(requests, [])
  console.log(
    'Verified three ordered phases, missing initial evidence, baseline changes, import locations, compressed estimates, review actions, per-scenario inspector, mobile layout and offline operation.',
  )
} finally {
  await browser.close()
}
