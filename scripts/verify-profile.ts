// Real Chromium CPU profiles through `coldpath profile`, joined into the report and compared with a baseline.
import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {join, relative, resolve, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {promisify} from 'node:util'

import {chromium} from '@playwright/test'
import {build as esbuild} from 'esbuild'
import {build as vite} from 'vite'

import {DEFAULT_RUNS, SAMPLING_INTERVAL_US} from '../lib/profile.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const work = join(root, 'artifacts', 'profile')
await rm(work, {recursive: true, force: true})
await mkdir(work, {recursive: true})
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const env = {...process.env, COLDPATH_ANALYZER: join(root, 'target', 'debug', 'coldpath')}
const coldpath = (...args: string[]) =>
  promisify(execFile)(process.execPath, [join(root, 'bin', 'coldpath.ts'), ...args], {cwd: work, env, maxBuffer: 64 << 20})
const read = async (path: string) => JSON.parse(await readFile(join(work, path), 'utf8'))
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

// Serves `dir`; `edit` may change the bytes of a served file.
async function serve(dir: string, edit = (path: string, body: Buffer) => body) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://fixture').pathname
    const path = resolve(dir, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!path.startsWith(dir + sep)) return response.writeHead(403).end()
    try {
      response.setHeader('content-type', path.toLowerCase().endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8')
      response.end(edit(path, await readFile(path)))
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((done) => server.close(done))}
}
const scenarios = (name: string, config: unknown) => writeFile(join(work, name), JSON.stringify(config))
const actions = (name: string) => relative(work, join(root, 'examples', 'demo', 'scenarios', name))

// The README demo: default runs and sampling interval, joined with coverage in one report.
await vite({root: join(root, 'examples', 'demo'), logLevel: 'warn', build: {outDir: join(work, 'demo'), emptyOutDir: true}})
const demo = await serve(join(work, 'demo'))
try {
  await scenarios('demo.scenarios.json', {
    url: demo.origin + '/',
    dir: 'demo',
    out: 'demo-out',
    scenarios: [
      {name: 'initial'},
      {name: 'open-report', actions: actions('open-report.mjs')},
      {name: 'search', actions: actions('search.mjs')},
    ],
  })
  await coldpath('profile', '--scenarios', 'demo.scenarios.json')
  await coldpath('collect', '--scenarios', 'demo.scenarios.json')
} finally {
  await demo.close()
}
const names = ['initial', 'open-report', 'search']
const profiles: Record<string, any> = Object.fromEntries(
  await Promise.all(names.map(async (name) => [name, await read(`demo-out/${name}.profile.json`)])),
)
assert.equal(DEFAULT_RUNS, 10)
for (const [name, profile] of Object.entries(profiles)) {
  assert.equal(profile.runs, DEFAULT_RUNS)
  assert.equal(profile.samplingIntervalUs, SAMPLING_INTERVAL_US)
  assert.deepEqual(Object.keys(profile.windows), name === 'initial' ? ['load'] : ['load', 'action'], name)
  for (const window of Object.values<any>(profile.windows)) {
    assert.equal(window.durationUs.length, DEFAULT_RUNS)
    assert(window.samples.every((count: number) => count > 0))
  }
  const bundle = profile.scripts.find((script: {path: string}) => script.path.startsWith('assets/index-'))
  assert.equal(bundle.sha256, sha256(await readFile(join(work, 'demo', bundle.path))))
  // Comparisons need one machine and boot: Linux boot_id and macOS kern.bootsessionuuid are UUIDs.
  assert(profile.environment.machine.cores > 0)
  assert.match(profile.environment.machine.boot, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
}
assert(
  profiles.search.scripts.some((script: {path: string}) => script.path.startsWith('assets/search-')),
  'the dynamically imported chunk is profiled',
)

await coldpath(
  'analyze',
  '--scenarios',
  'demo.scenarios.json',
  ...names.flatMap((name) => ['--profile', `demo-out/${name}.profile.json`]),
  '--json',
  'demo.json',
  '--markdown',
  'demo.md',
  '--treemap',
  'demo.html',
)
const report = await read('demo.json')
const window = (scenario: string, name: string) =>
  report.cpu.scenarios.find((s: {scenario: string}) => s.scenario === scenario).windows.find((w: {window: string}) => w.window === name)
// Whether a demo source clears 10 samples per run depends on the machine: GitHub's macOS runner VMs sampled
// every 0.5 to 1.3 ms instead of 100 µs. Samples still reach format.js, and every status follows its samples.
const format = window('initial', 'load').sources.find((row: {source: string}) => row.source.endsWith('src/format.js'))
assert(format?.medianSamples > 0, 'page load samples reach format.js')
for (const scenario of report.cpu.scenarios)
  for (const {sources, topLevel, other} of scenario.windows)
    for (const row of [...sources, ...topLevel, ...other])
      assert.equal(row.status, row.medianSamples >= report.cpu.minSamples ? 'measured' : 'insufficient', row.source ?? row.path ?? row.name)
// ReportChart.jsx runs for microseconds: shown, but never as a reliable (or zero) cost.
const chart = window('open-report', 'action').sources.find((row: {source: string}) => row.source.endsWith('src/ReportChart.jsx'))
assert(!chart || chart.status === 'insufficient')
assert(
  report.cpu.scenarios
    .find((s: {scenario: string}) => s.scenario === 'open-report')
    .bundles.some((path: string) => path.startsWith('assets/index-')),
)
const markdown = await readFile(join(work, 'demo.md'), 'utf8')
assert.match(markdown, /## CPU self time/)
assert.match(markdown, /### CPU: open-report, action window/)

const browser = await chromium.launch({headless: true})
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}})
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(pathToFileURL(join(work, 'demo.html')).href)
  await page.locator('#action-list button').filter({hasText: 'ReportChart.jsx'}).filter({hasText: 'open-report'}).click()
  const detail = page.locator('#file')
  await detail.getByRole('heading', {name: 'CPU self time'}).waitFor()
  const item = detail.locator('.facts div').filter({hasText: 'open-report, action window'})
  assert.match((await item.locator('dd').textContent())!, /^(Insufficient samples|No function samples)$/)
  // The Intl formatter in format.js during page load, shown as its status says.
  await page.getByRole('button', {name: 'All bundles', exact: true}).click()
  await page
    .locator('#rows button')
    .filter({hasText: /^assets\/index-/})
    .click()
  await page
    .locator('#rows button')
    .filter({hasText: /^Outside analysis root .*\/examples\/demo\/src$/})
    .click()
  await page
    .locator('#rows button')
    .filter({hasText: /^format\.js$/})
    .click()
  const load = detail.locator('.facts div').filter({hasText: 'initial, load window'})
  if (format.status === 'measured') {
    assert.match((await load.locator('dd').textContent())!, /^\d+(\.\d+)? ms$/)
    assert.match((await load.locator('small').textContent())!, /^Q1 to Q3: .* ms to .* ms, \d+(\.\d+)? samples per run in 10 runs$/)
  } else {
    assert.equal(await load.locator('dd').textContent(), 'Insufficient samples')
    assert.match((await load.locator('small').textContent())!, /^median .* ms, \d+(\.\d+)? samples? per run in 10 runs$/)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}

// Stale builds, multi-document flows, workers, and run counts.
const stale = await serve(join(work, 'demo'), (path, body) =>
  path.includes(`${sep}assets${sep}index-`) ? Buffer.concat([body, Buffer.from('\n')]) : body,
)
try {
  await scenarios('stale.scenarios.json', {url: stale.origin + '/', dir: 'demo', out: 'stale-out', scenarios: [{name: 'initial'}]})
  await assert.rejects(
    coldpath('profile', '--scenarios', 'stale.scenarios.json', '--runs', '2'),
    /browser\/disk source mismatch: assets\/index-/,
  )
  await assert.rejects(coldpath('profile', '--scenarios', 'stale.scenarios.json', '--runs', '1'), /--runs must be an integer of at least 2/)
  await scenarios('prefix.scenarios.json', {
    url: stale.origin + '/',
    dir: 'demo',
    prefix: '/static/',
    out: 'prefix-out',
    scenarios: [{name: 'initial'}],
  })
  await assert.rejects(
    coldpath('profile', '--scenarios', 'prefix.scenarios.json', '--runs', '2'),
    /no scripts matched --prefix or --cdn-prefix/,
  )
} finally {
  await stale.close()
}
const flows = join(root, 'fixtures', 'flows')
const pages = createServer(async (request, response) => {
  const html = (body: string) =>
    response.setHeader('content-type', 'text/html; charset=utf-8').end(`<!doctype html><meta charset="utf-8">${body}`)
  if (request.url === '/')
    html('<script src="/assets/first.js"></script><a href="/second">next</a><a href="/download">download</a><a href="/empty">empty</a>')
  else if (request.url === '/second') html('<script src="/assets/second.js"></script>')
  else if (request.url === '/download')
    response.writeHead(200, {'content-type': 'text/csv', 'content-disposition': 'attachment; filename="orders.csv"'}).end('id\n1\n')
  else if (request.url === '/empty') response.writeHead(204).end()
  else if (request.url!.startsWith('/assets/'))
    response.setHeader('content-type', 'text/javascript; charset=utf-8').end(await readFile(join(flows, request.url!.slice(8))))
  else response.writeHead(404).end()
})
await new Promise<void>((done) => pages.listen(0, '127.0.0.1', done))
try {
  await writeFile(
    join(work, 'navigate.mjs'),
    `export default async function ({page}) {
  await page.getByRole('link', {name: 'next'}).click()
  await page.waitForURL('**/second')
}\n`,
  )
  await writeFile(
    join(work, 'worker.mjs'),
    'export default async function ({page}) {\n  await page.waitForFunction(() => globalThis.__worker === 42)\n}\n',
  )
  // Navigations that commit no new document: a download and a 204 response.
  await writeFile(
    join(work, 'stay.mjs'),
    `export default async function ({page}) {
  const download = page.waitForEvent('download')
  await page.getByRole('link', {name: 'download'}).click()
  await download
  await page.getByRole('link', {name: 'empty'}).click()
}\n`,
  )
  const url = `http://127.0.0.1:${(pages.address() as AddressInfo).port}/`
  await scenarios('flows.scenarios.json', {
    url,
    dir: flows,
    prefix: '/assets/',
    waitMs: 0,
    out: 'flows-out',
    scenarios: [{name: 'navigate', actions: 'navigate.mjs'}],
  })
  await assert.rejects(
    coldpath('profile', '--scenarios', 'flows.scenarios.json', '--runs', '2'),
    /does not support multi-document navigation flows/,
  )
  await scenarios('stay.scenarios.json', {
    url,
    dir: flows,
    prefix: '/assets/',
    waitMs: 0,
    out: 'stay-out',
    scenarios: [{name: 'stay', actions: 'stay.mjs'}],
  })
  await coldpath('profile', '--scenarios', 'stay.scenarios.json', '--runs', '2')
  assert.deepEqual(Object.keys((await read('stay-out/stay.profile.json')).windows), ['load', 'action'])
  await scenarios('worker.scenarios.json', {
    url,
    dir: flows,
    prefix: '/assets/',
    waitMs: 0,
    out: 'worker-out',
    scenarios: [{name: 'worker', url: '/second', actions: 'worker.mjs'}],
  })
  const {stderr} = await coldpath('profile', '--scenarios', 'worker.scenarios.json', '--runs', '2')
  assert.match(stderr, /worker: 2 workers started across runs; worker CPU time is not recorded/)
  assert(!(await read('worker-out/worker.profile.json')).scripts.some((script: {path: string}) => script.path === 'worker.js'))
} finally {
  await new Promise((done) => pages.close(done))
}

// Scripts the debugger cannot read: one renamed by `//# sourceURL`, and one that V8 collects after it
// ran once (garbage collection is forced). A `.JS` script is not a bundle the analyzer scans.
const odd = join(work, 'odd')
await mkdir(odd, {recursive: true})
const busy = 'let x = 0; for (let i = 0; i < 20000000; i++) x = (x * 31 + i) % 1000003; globalThis.__busy = x'
await writeFile(join(odd, 'named.js'), `function named() { ${busy} }\nnamed()\nglobalThis.named = named\n//# sourceURL=named.js\n`)
// Blocks keep each classic script's `let` out of the shared global scope.
await writeFile(join(odd, 'once.js'), `{ ${busy} }\n`)
await writeFile(join(odd, 'UPPER.JS'), `{ ${busy} }\n`)
await writeFile(
  join(odd, 'index.html'),
  '<!doctype html><meta charset="utf-8"><script src="/named.js"></script><script src="/once.js"></script><script src="/UPPER.JS"></script>',
)
await writeFile(
  join(work, 'collect-garbage.mjs'),
  `export default async function ({page, context}) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.detach()
}\n`,
)
const oddServer = await serve(odd)
try {
  await scenarios('odd.scenarios.json', {
    url: oddServer.origin + '/',
    dir: 'odd',
    waitMs: 0,
    out: 'odd-out',
    scenarios: [{name: 'odd', actions: 'collect-garbage.mjs'}],
  })
  await coldpath('profile', '--scenarios', 'odd.scenarios.json', '--runs', '2')
} finally {
  await oddServer.close()
}
const oddProfile = await read('odd-out/odd.profile.json')
assert.deepEqual(
  oddProfile.scripts.map((script: {path: string}) => script.path),
  ['named.js', 'once.js'],
)
const oddScript = (path: string) => oddProfile.scripts.find((script: {path: string}) => script.path === path)
assert(
  oddScript('named.js').functions.some((f: {windows: {load: {samples: number[]}}}) => f.windows.load.samples.every((count) => count > 0)),
)
assert(
  oddScript('once.js').topLevel.load.samples.every((count: number) => count > 0),
  'a collected script keeps its samples in every run',
)
await coldpath('--dir', 'odd', '--profile', 'odd-out/odd.profile.json', '--json', 'odd.json')
assert((await read('odd.json')).cpu.scenarios[0].windows[0].topLevel.some((row: {path: string}) => row.path === 'once.js'))

// A controlled regression: a busy loop added to a function that only runs after a click. The source
// file keeps its path, so both builds' maps name the same source.
const regression = join(work, 'regression')
await mkdir(join(regression, 'src'), {recursive: true})
await writeFile(
  join(regression, 'src', 'app.js'),
  `import {report} from './report.js'
document.querySelector('button').addEventListener('click', () => {
  document.querySelector('output').textContent = 'report ' + report(20000000)
})
`,
)
const reportSource = (busy: boolean) => `export function report(size) {
  let x = 0
  for (let i = 0; i < size; i++) x = (x * 31 + i) % 1000003
${busy ? '  for (let i = 0; i < size; i++) x = (x * 17 + i) % 1000033\n' : ''}  return x
}
`
for (const [name, busy] of [
  ['base', false],
  ['regressed', true],
] as [string, boolean][]) {
  await writeFile(join(regression, 'src', 'report.js'), reportSource(busy))
  await esbuild({
    absWorkingDir: regression,
    entryPoints: ['src/app.js'],
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'esm',
    outdir: join(regression, name),
  })
  await writeFile(
    join(regression, name, 'index.html'),
    '<!doctype html><meta charset="utf-8"><button>Open report</button><output></output><script type="module" src="/app.js"></script>',
  )
}
await writeFile(
  join(regression, 'open-report.mjs'),
  `export default async function ({page}) {
  await page.getByRole('button', {name: 'Open report'}).click()
  await page.getByText(/^report \\d+$/).waitFor()
}\n`,
)
for (const [build, out] of [
  ['base', 'base-out'],
  ['regressed', 'regressed-out'],
  ['base', 'again-out'],
]) {
  const server = await serve(join(regression, build))
  try {
    await scenarios(`regression/${out}.scenarios.json`, {
      url: server.origin + '/',
      dir: build,
      waitMs: 0,
      out,
      scenarios: [{name: 'open-report', actions: 'open-report.mjs'}],
    })
    await coldpath('profile', '--scenarios', `regression/${out}.scenarios.json`)
  } finally {
    await server.close()
  }
}
const analyze = (build: string, out: string, ...args: string[]) =>
  coldpath(
    '--dir',
    `regression/${build}`,
    '--profile',
    `regression/${out}/open-report.profile.json`,
    '--json',
    `regression/${out}.json`,
    ...args,
  )
await analyze('base', 'base-out')
const base = await read('regression/base-out.json')
const reportRow = (cpu: any) =>
  cpu.scenarios[0].windows
    .find((w: {window: string}) => w.window === 'action')
    .sources.find((row: {source: string}) => row.source.endsWith('src/report.js'))
assert.equal(reportRow(base.cpu).status, 'measured', 'the later-only function is measurable before the regression')
await analyze('regressed', 'regressed-out', '--baseline', 'regression/base-out.json', '--markdown', 'regression/regressed.md')
const regressed = (await read('regression/regressed-out.json')).baseline.cpu
const change = regressed.sources.find(
  (row: {window: string; source: string}) => row.window === 'action' && row.source.endsWith('src/report.js'),
)
assert.equal(change.change, 'regressed', JSON.stringify(change))
assert(change.relativeShift >= 0.25 && change.adjustedPValue < 0.05)
assert.match(await readFile(join(regression, 'regressed.md'), 'utf8'), /\| open-report \| action \| \.\.\/src\/report\.js \| regressed \|/)
await analyze('base', 'again-out', '--baseline', 'regression/base-out.json')
const again = (await read('regression/again-out.json')).baseline.cpu
assert(
  again.sources.every((row: {change: string}) => !['regressed', 'improved'].includes(row.change)),
  JSON.stringify(again.sources.filter((row: {change: string}) => ['regressed', 'improved'].includes(row.change))),
)
console.log(
  `Verified ${DEFAULT_RUNS}-run demo profiles at ${SAMPLING_INTERVAL_US} µs with load and action windows, stale-build, multi-document and run-count rejection, the worker warning, CPU rows in JSON, Markdown and the treemap, and a controlled regression (report.js +${Math.round(change.relativeShift * 100)}%) against an unchanged rerun.`,
)
