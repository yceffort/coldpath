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
let apiHits = 0
const api = await listen((_request, response) => {
  apiHits++
  response.setHeader('access-control-allow-origin', '*')
  response.end('pong')
})
const apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
let header: string | undefined
const app = await listen(async (request, response) => {
  if (request.url === '/api') header = request.headers['x-coldpath'] as string | undefined
  if (request.url === '/')
    html(response, `<script src="${cdnPrefix}cdn.js"></script><script src="/assets/first.js"></script><a href="/second">next</a>`)
  else if (request.url === '/api')
    html(
      response,
      `<script src="/assets/first.js"></script><script>fetch('${apiOrigin}/ping').then((r) => r.text(), () => 'failed').then((text) => { document.body.append(text) })</script>`,
    )
  else if (request.url === '/error')
    html(response, `<script src="/assets/first.js"></script><script>Promise.reject(new Error('flaky request'))</script>`)
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

  // Other origins, such as an API, are reachable only with --allow-origin, and scripts are never attributed to them.
  const record = (name: string, path: string, extra: string[]) =>
    run(process.execPath, [
      join(root, 'bin', 'coldpath.ts'),
      'collect',
      '--url',
      `http://127.0.0.1:${(app.address() as AddressInfo).port}${path}`,
      '--dir',
      fixture,
      '--prefix',
      '/assets/',
      '--wait-ms',
      '0',
      '--scenario',
      name,
      '--out',
      join(artifacts, `${name}.coverage.json`),
      ...extra,
    ])
  const recordApi = (name: string, extra: string[]) => record(name, '/api', extra)
  // The summary names the final page and the aborted requests, and an expect selector rejects the fallback screen.
  const {stderr: summary} = await recordApi('api-blocked', [])
  assert.match(
    summary,
    /api-blocked: final page http:\/\/127\.0\.0\.1:\d+\/api \(document status 200\), [1-9]\d* console errors, 0 page errors/,
  )
  assert(summary.includes(`api-blocked: aborted requests to origins outside --allow-origin and --cdn-prefix: ${apiOrigin} (1)`), summary)
  await assert.rejects(
    recordApi('api-expect', ['--expect', 'text=pong']),
    /no visible element matches expect "text=pong" on the final page/,
  )
  const apiBlocked = JSON.parse(await readFile(join(artifacts, 'api-blocked.coverage.json'), 'utf8'))
  assert.equal(apiHits, 0)
  assert.deepEqual(apiBlocked.blockedOrigins, [apiOrigin])
  assert.deepEqual(apiBlocked.pageErrors, [])
  assert.equal(apiBlocked.environment.externalRequests, 'blocked')
  assert(!('allowedOrigins' in apiBlocked.environment), 'an unused option must not change the environment')
  await recordApi('api-allowed', ['--allow-origin', `${apiOrigin}/`, '--expect', 'text=pong'])
  const apiAllowed = JSON.parse(await readFile(join(artifacts, 'api-allowed.coverage.json'), 'utf8'))
  assert.equal(apiHits, 1)
  assert.deepEqual(apiAllowed.blockedOrigins, [])
  assert.deepEqual(apiAllowed.environment.allowedOrigins, [apiOrigin])
  assert.equal(apiAllowed.environment.externalRequests, 'blocked except --allow-origin origins')
  assert(apiAllowed.requests.some((r: any) => r.path === `${apiOrigin}/ping` && r.type === 'fetch'))
  await assert.rejects(recordApi('api-path', ['--allow-origin', `${apiOrigin}/v1`]), /--allow-origin must be an http\(s\) origin/)

  // A setup export runs before navigation, so its routes answer API calls before the origin policy; header values stay out of the file.
  const mock = join(artifacts, 'mock.mjs')
  await writeFile(
    mock,
    `export async function setup({context}) {
  await context.route('${apiOrigin}/**', (route) => route.fulfill({body: 'mocked', headers: {'access-control-allow-origin': '*'}}))
}\n`,
  )
  await recordApi('api-mocked', ['--actions', mock, '--expect', 'text=mocked', '--header', 'x-coldpath: secret-value'])
  const apiMocked = JSON.parse(await readFile(join(artifacts, 'api-mocked.coverage.json'), 'utf8'))
  assert.equal(apiHits, 1)
  assert.equal(header, 'secret-value')
  assert.deepEqual(apiMocked.blockedOrigins, [])
  assert.deepEqual(apiMocked.environment.extraHTTPHeaders, ['x-coldpath'])
  assert(!JSON.stringify(apiMocked).includes('secret-value'))
  assert.match(apiMocked.environment.observation, /^setup before navigation; navigation networkidle \+ 0ms; \d+ coverage snapshots/)
  await assert.rejects(recordApi('api-header', ['--header', 'x-coldpath']), /--header must be 'NAME: VALUE'/)

  // A page error fails the scenario unless allowPageErrors tolerates it; tolerated errors stay in the recording.
  await assert.rejects(record('error-strict', '/error', []), /page threw 1 runtime errors \(allow expected ones[^]*\n {2}flaky request/)
  await assert.rejects(record('error-other', '/error', ['--allow-page-error', '^other']), /page threw 1 runtime errors/)
  await record('error-allowed', '/error', ['--allow-page-error', '^flaky'])
  assert.deepEqual(JSON.parse(await readFile(join(artifacts, 'error-allowed.coverage.json'), 'utf8')).pageErrors, ['flaky request'])

  // A CDN copy that differs from the local build is rejected like a stale local file.
  cdnSuffix = '\n'
  await assert.rejects(collect('stale', ['--cdn-prefix', cdnPrefix]), /browser\/disk source mismatch: cdn\.js/)
} finally {
  await Promise.all([app, cdn, api].map((server) => new Promise((resolve) => server.close(resolve))))
}
console.log(
  'Verified CDN prefix mapping, pre-navigation snapshots, unmeasured worker code, blocked unlisted origins, allowed API origins, the final state summary, expect selectors, setup routes, extra headers, tolerated page errors and stale CDN rejection.',
)
