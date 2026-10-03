// Emulation and saved state must change which code the recording observes.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = join(root, 'artifacts', 'environment')
await rm(artifacts, {recursive: true, force: true})
await mkdir(artifacts, {recursive: true})
const server = createServer(async (request, response) => {
  if (request.url === '/assets/environment.js') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8')
    response.end(await readFile(join(root, 'fixtures', 'environment.js')))
  } else if (request.url === '/' || request.url === '/?probe') {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><script src="/assets/environment.js"></script>',
    )
  } else {
    response.writeHead(404).end()
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const probe = join(artifacts, 'probe.mjs')
await writeFile(
  probe,
  `import {writeFile} from 'node:fs/promises'
export default async function ({page}) {
  // Navigation Timing does not include CDP-emulated latency; a request's duration does.
  const timing = await page.evaluate(async () => {
    const start = performance.now()
    await (await fetch('/?probe', {cache: 'no-store'})).text()
    return {waitMs: performance.now() - start}
  })
  await writeFile(process.env.PROBE_OUT, JSON.stringify(timing))
}\n`,
)
const state = join(artifacts, 'state.json')
await writeFile(
  state,
  JSON.stringify({
    cookies: [
      {name: 'session', value: 'fixture', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax'},
    ],
    origins: [],
  }),
)

async function record(name: string, options: string[]) {
  const out = join(artifacts, `${name}.coverage.json`)
  const probeOut = join(artifacts, `${name}.probe.json`)
  await run(
    process.execPath,
    [
      join(root, 'bin', 'coldpath.ts'),
      'collect',
      '--url',
      `${origin}/`,
      '--dir',
      join(root, 'fixtures'),
      '--prefix',
      '/assets/',
      '--wait-ms',
      '0',
      '--scenario',
      name,
      '--out',
      out,
      '--actions',
      probe,
      ...options,
    ],
    {env: {...process.env, PROBE_OUT: probeOut}},
  )
  const capture = JSON.parse(await readFile(out, 'utf8'))
  const calls = Object.fromEntries(
    capture.scripts[0].functions.filter((f: any) => f.functionName).map((f: any) => [f.functionName, f.ranges[0].count]),
  )
  return {environment: capture.environment, calls, probe: JSON.parse(await readFile(probeOut, 'utf8'))}
}

try {
  const desktop = await record('desktop', [])
  assert.deepEqual(desktop.calls, {mobileLayout: 0, desktopLayout: 1, signedIn: 0, signedOut: 1})
  assert.deepEqual(desktop.environment.viewport, {width: 1280, height: 900})
  assert.equal(desktop.environment.isMobile, false)
  assert.equal(desktop.environment.storageState, false)
  assert.equal(desktop.environment.network, null)
  assert(desktop.probe.waitMs < 400, `unthrottled request took ${desktop.probe.waitMs}ms`)

  const phone = await record('phone', [
    '--device',
    'Pixel 7',
    '--storage-state',
    state,
    '--latency-ms',
    '400',
    '--download-kbps',
    '1600',
    '--upload-kbps',
    '750',
    '--cpu-slowdown',
    '4',
  ])
  assert.deepEqual(phone.calls, {mobileLayout: 1, desktopLayout: 0, signedIn: 1, signedOut: 0})
  assert.equal(phone.environment.device, 'Pixel 7')
  assert.equal(phone.environment.isMobile, true)
  assert.equal(phone.environment.hasTouch, true)
  assert.match(phone.environment.userAgent, /Pixel 7/)
  assert.equal(phone.environment.storageState, true)
  assert.deepEqual(phone.environment.network, {latencyMs: 400, downloadKbps: 1600, uploadKbps: 750})
  assert.equal(phone.environment.cpuSlowdown, 4)
  assert(!JSON.stringify(phone.environment).includes('fixture'), 'cookie values must not be recorded')
  assert(phone.probe.waitMs >= 400, `network latency was not applied: ${phone.probe.waitMs}ms`)

  // An explicit viewport overrides the device and moves the page back to the desktop path.
  const wide = await record('wide', ['--device', 'Pixel 7', '--viewport', '1024x768'])
  assert.deepEqual(wide.calls, {mobileLayout: 0, desktopLayout: 1, signedIn: 0, signedOut: 1})
  assert.deepEqual(wide.environment.viewport, {width: 1024, height: 768})
} finally {
  await new Promise((resolve) => server.close(resolve))
}
console.log('Verified device emulation, viewport overrides, network throttling, CPU slowdown metadata and saved authenticated state.')
