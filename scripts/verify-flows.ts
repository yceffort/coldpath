// One scenario across a CDN script and a full-page navigation. Worker coverage is unsupported
// (docs/collecting.md), so the worker started by the second page must stay unmeasured.
import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {RequestListener, ServerResponse} from 'node:http'
import type {AddressInfo} from 'node:net'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = join(root, 'fixtures', 'flows')
const artifacts = join(root, 'artifacts', 'flows')
await rm(artifacts, {recursive: true, force: true})
await mkdir(artifacts, {recursive: true})
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const binary = join(root, 'target', 'debug', 'coldpath')

const listen = async (handler: RequestListener) => {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}
const script = (response: ServerResponse, body: string | Buffer) => {
  response.setHeader('content-type', 'text/javascript; charset=utf-8')
  response.end(body)
}
const html = (response: ServerResponse, body: string) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(`<!doctype html><meta charset="utf-8">${body}`)
}
let cdnSuffix = ''
const cdn = await listen(async (request, response) => {
  if (request.url === '/static/cdn.js') script(response, (await readFile(join(fixture, 'cdn.js'), 'utf8')) + cdnSuffix)
  else response.writeHead(404).end()
})
const cdnPrefix = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}/static/`
const app = await listen(async (request, response) => {
  if (request.url === '/')
    html(response, `<script src="${cdnPrefix}cdn.js"></script><script src="/assets/first.js"></script><a href="/second">next</a>`)
  else if (request.url === '/second') html(response, '<script src="/assets/second.js"></script>')
  else if (request.url!.startsWith('/assets/')) script(response, await readFile(join(fixture, request.url!.slice(8))))
  else response.writeHead(404).end()
})
const actions = join(artifacts, 'flow.mjs')
await writeFile(
  actions,
  `export default async function ({page}) {
  await page.getByRole('link', {name: 'next'}).click()
  await page.waitForURL('**/second')
  await page.waitForFunction(() => globalThis.__worker === 42)
}\n`,
)
const collect = (name: string, extra: string[]) =>
  run(process.execPath, [
    join(root, 'bin', 'coldpath.ts'),
    'collect',
    '--url',
    `http://127.0.0.1:${(app.address() as AddressInfo).port}/`,
    '--dir',
    fixture,
    '--prefix',
    '/assets/',
    '--wait-ms',
    '0',
    '--scenario',
    name,
    '--actions',
    actions,
    '--out',
    join(artifacts, `${name}.coverage.json`),
    ...extra,
  ])

try {
  await collect('flow', ['--cdn-prefix', cdnPrefix])
  const capture = JSON.parse(await readFile(join(artifacts, 'flow.coverage.json'), 'utf8'))
  assert.deepEqual([...new Set(capture.scripts.map((s: any) => s.path))].sort(), ['cdn.js', 'first.js', 'second.js'])
  assert(capture.scripts.find((s: any) => s.path === 'cdn.js').url.startsWith(cdnPrefix))
  // Counters reset at each snapshot, so a function counts as run if any snapshot saw it.
  const calls: Record<string, number> = {}
  for (const {functions} of capture.scripts) {
    for (const f of functions) if (f.functionName) calls[f.functionName] = Math.max(calls[f.functionName] ?? 0, f.ranges[0].count)
  }
  // The page received the worker's message, so the worker ran even though it is not recorded.
  assert.deepEqual(calls, {fromCdn: 1, firstPage: 1, beforeLeaving: 1, secondPage: 1, 'worker.onmessage': 1})

  const report = join(artifacts, 'flow.json')
  await run(binary, ['--dir', fixture, '--coverage', join(artifacts, 'flow.coverage.json'), '--json', report])
  const {bundles, totals} = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(totals.unmeasuredBytes, bundles.find((b: any) => b.path === 'worker.js').bytes)
  for (const bundle of bundles.filter((b: any) => b.path !== 'worker.js')) {
    assert(bundle.verification.length && bundle.verification.every((v: any) => v.source === 'sha256'), bundle.path)
  }

  // Without an explicit CDN prefix the origin stays blocked and nothing is attributed to it.
  await collect('blocked', [])
  const blocked = JSON.parse(await readFile(join(artifacts, 'blocked.coverage.json'), 'utf8'))
  assert.deepEqual(blocked.blockedOrigins, [new URL(cdnPrefix).origin])
  assert(!blocked.scripts.some((s: any) => s.path === 'cdn.js'))

  // A CDN copy that differs from the local build is rejected like a stale local file.
  cdnSuffix = '\n'
  await assert.rejects(collect('stale', ['--cdn-prefix', cdnPrefix]), /browser\/disk source mismatch: cdn\.js/)
} finally {
  await Promise.all([app, cdn].map((server) => new Promise((resolve) => server.close(resolve))))
}
console.log(
  'Verified CDN prefix mapping, pre-navigation snapshots, unmeasured worker code, blocked unlisted origins and stale CDN rejection.',
)
