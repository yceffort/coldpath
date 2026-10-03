// Real Chromium CPU profiles through `coldpath profile`, joined into the report.
import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {join, relative, resolve, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {promisify} from 'node:util'

import {chromium} from '@playwright/test'
import {build as vite} from 'vite'

import {DEFAULT_RUNS, SAMPLING_INTERVAL_US} from '../lib/profile.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const work = join(root, 'artifacts', 'profile')
await rm(work, {recursive: true, force: true})
await mkdir(work, {recursive: true})
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const env = {...process.env, COLDPATH_ANALYZER: join(root, 'target', 'debug', 'coldpath')}
const coldpath = (...args) =>
  promisify(execFile)(process.execPath, [join(root, 'bin', 'coldpath.mjs'), ...args], {cwd: work, env, maxBuffer: 64 << 20})
const read = async (path) => JSON.parse(await readFile(join(work, path), 'utf8'))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// Serves `dir`; `edit` may change the bytes of a served file.
async function serve(dir, edit = (path, body) => body) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://fixture').pathname
    const path = resolve(dir, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!path.startsWith(dir + sep)) return response.writeHead(403).end()
    try {
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8')
      response.end(edit(path, await readFile(path)))
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done))}
}
const scenarios = (name, config) => writeFile(join(work, name), JSON.stringify(config))
const actions = (name) => relative(work, join(root, 'examples', 'demo', 'scenarios', name))

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
const profiles = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await read(`demo-out/${name}.profile.json`)])))
assert.equal(DEFAULT_RUNS, 10)
for (const [name, profile] of Object.entries(profiles)) {
  assert.equal(profile.runs, DEFAULT_RUNS)
  assert.equal(profile.samplingIntervalUs, SAMPLING_INTERVAL_US)
  assert.deepEqual(Object.keys(profile.windows), name === 'initial' ? ['load'] : ['load', 'action'], name)
  for (const window of Object.values(profile.windows)) {
    assert.equal(window.durationUs.length, DEFAULT_RUNS)
    assert(window.samples.every((count) => count > 0))
  }
  const bundle = profile.scripts.find((script) => script.path.startsWith('assets/index-'))
  assert.equal(bundle.sha256, sha256(await readFile(join(work, 'demo', bundle.path))))
  assert.equal(profile.environment.machine.cores > 0, true)
}
assert(
  profiles.search.scripts.some((script) => script.path.startsWith('assets/search-')),
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
const window = (scenario, name) => report.cpu.scenarios.find((s) => s.scenario === scenario).windows.find((w) => w.window === name)
assert(
  window('initial', 'load').sources.some((row) => row.status === 'measured'),
  'page load has measurable sources',
)
// ReportChart.jsx runs for microseconds: shown, but never as a reliable (or zero) cost.
const chart = window('open-report', 'action').sources.find((row) => row.source.endsWith('src/ReportChart.jsx'))
assert(!chart || chart.status === 'insufficient')
assert(report.cpu.scenarios.find((s) => s.scenario === 'open-report').bundles.some((path) => path.startsWith('assets/index-')))
const markdown = await readFile(join(work, 'demo.md'), 'utf8')
assert.match(markdown, /## CPU self time/)
assert.match(markdown, /### CPU: open-report, action window/)

const browser = await chromium.launch({headless: true})
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}})
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(pathToFileURL(join(work, 'demo.html')).href)
  await page.locator('#action-list button').filter({hasText: 'ReportChart.jsx'}).filter({hasText: 'open-report'}).click()
  const detail = page.locator('#file')
  await detail.getByRole('heading', {name: 'CPU self time'}).waitFor()
  const item = detail.locator('.facts div').filter({hasText: 'open-report, action window'})
  assert.match(await item.locator('dd').textContent(), /^(Insufficient samples|Not sampled)$/)
  // A measured source: the Intl formatter in format.js during page load.
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
  assert.match(await load.locator('dd').textContent(), /^\d+(\.\d+)? ms$/)
  assert.match(await load.locator('small').textContent(), /^Q1 to Q3: .* ms to .* ms, \d+(\.\d+)? samples per run in 10 runs$/)
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
} finally {
  await stale.close()
}
const flows = join(root, 'fixtures', 'flows')
const pages = createServer(async (request, response) => {
  const html = (body) => response.setHeader('content-type', 'text/html; charset=utf-8').end(`<!doctype html><meta charset="utf-8">${body}`)
  if (request.url === '/') html('<script src="/assets/first.js"></script><a href="/second">next</a>')
  else if (request.url === '/second') html('<script src="/assets/second.js"></script>')
  else if (request.url.startsWith('/assets/'))
    response.setHeader('content-type', 'text/javascript; charset=utf-8').end(await readFile(join(flows, request.url.slice(8))))
  else response.writeHead(404).end()
})
await new Promise((done) => pages.listen(0, '127.0.0.1', done))
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
  const url = `http://127.0.0.1:${pages.address().port}/`
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
  assert(!(await read('worker-out/worker.profile.json')).scripts.some((script) => script.path === 'worker.js'))
} finally {
  await new Promise((done) => pages.close(done))
}

console.log(
  `Verified ${DEFAULT_RUNS}-run demo profiles at ${SAMPLING_INTERVAL_US} µs with load and action windows, stale-build, multi-document and run-count rejection, the worker warning, and CPU rows in JSON, Markdown and the treemap.`,
)
