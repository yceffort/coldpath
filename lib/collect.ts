// Chromium creates the input; the Rust analyzer consumes it offline.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import type {Browser, BrowserContextOptions, CDPSession, Page} from 'playwright'

import {readMap} from './maps.ts'

export interface Network {
  latencyMs: number
  downloadKbps: number
  uploadKbps: number
}

// Scenario options shared by collect and profile (docs/collecting.md).
export interface CaptureOptions {
  url?: string
  dir?: string
  prefix?: string
  scenario?: string
  actions?: string
  waitMs?: number
  cdnPrefixes?: string[]
  allowOrigins?: string[]
  device?: string
  viewport?: {width: number; height: number}
  userAgent?: string
  deviceScaleFactor?: number
  isMobile?: boolean
  hasTouch?: boolean
  network?: Network
  cpuSlowdown?: number
  storageState?: string
  extraHTTPHeaders?: Record<string, string>
  // Playwright selectors that must match a visible element in the final page state.
  expect?: string[]
  // true, or regular expressions that a tolerated page error's message matches.
  allowPageErrors?: boolean | string[]
  browserPath?: string
  browserChannel?: string
}

type Playwright = typeof import('playwright')
// Custom interactions run after the page loads; an actions module's `setup` export runs before the first navigation.
export type Action = (page: {page: Page; context: Awaited<ReturnType<Browser['newContext']>>}) => Promise<void>

// Playwright is an optional peer: only collection needs it.
export function loadPlaywright(command = 'collect'): {chromium: Playwright['chromium']; devices: Playwright['devices']; version: string} {
  for (const base of [import.meta.url, pathToFileURL(resolve('package.json')).href]) {
    const require = createRequire(base)
    for (const name of ['playwright', '@playwright/test']) {
      try {
        const {chromium, devices} = require(name)
        return {chromium, devices, version: require(`${name}/package.json`).version}
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
      }
    }
  }
  throw new Error(`coldpath ${command} requires Playwright: npm install --save-dev playwright && npx playwright install chromium`)
}

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

// Playwright's own Chromium unless an installed browser is named.
export function launchOptions({browserPath, browserChannel}: {browserPath?: string; browserChannel?: string}) {
  assert(!(browserPath && browserChannel), '--browser-path and --browser-channel cannot be combined')
  return {headless: true, executablePath: browserPath && resolve(browserPath), channel: browserChannel}
}

// Validates the scenario options that collect and profile share.
export async function prepare(
  {
    url,
    dir,
    prefix = '/',
    scenario = 'initial',
    actions,
    waitMs = 1000,
    cdnPrefixes = [],
    allowOrigins = [],
    device,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    network,
    cpuSlowdown,
    storageState,
    extraHTTPHeaders,
    expect = [],
    allowPageErrors = false,
    browserPath,
    browserChannel,
  }: CaptureOptions,
  command: string,
) {
  assert(url && dir, 'url and dir are required')
  assert(prefix.startsWith('/') && prefix.endsWith('/') && !/[?#\\]/.test(prefix), '--prefix must be a URL path starting and ending with /')
  assert(Number.isSafeInteger(waitMs) && waitMs >= 0, '--wait-ms must be a nonnegative integer')
  assert(scenario.trim(), '--scenario must not be empty')
  const target = new URL(url)
  assert(['http:', 'https:'].includes(target.protocol), '--url must use http or https')
  const remotes = cdnPrefixes.map((value) => {
    const remote = new URL(value)
    assert(
      ['http:', 'https:'].includes(remote.protocol) && value.endsWith('/') && !remote.search && !remote.hash,
      `--cdn-prefix must be an http(s) URL ending with / and without query or hash: ${value}`,
    )
    return remote.href
  })
  // Requests that pass through, such as an API, without attributing the scripts they serve.
  const origins = allowOrigins.map((value) => {
    const origin = new URL(value)
    assert(
      ['http:', 'https:'].includes(origin.protocol) && origin.pathname === '/' && !origin.search && !origin.hash,
      `--allow-origin must be an http(s) origin such as https://api.example.com: ${value}`,
    )
    return origin.origin
  })
  const allowed = new Set([target.origin, ...remotes.map((remote) => new URL(remote).origin), ...origins])
  const root = await realpath(resolve(dir))
  let action: Action | undefined
  let beforeNavigation: Action | undefined
  if (actions) {
    const module = await import(pathToFileURL(resolve(actions)).href)
    action = module.default
    beforeNavigation = module.setup
    assert(
      [action, beforeNavigation].every((f) => f === undefined || typeof f === 'function') && (action || beforeNavigation),
      '--actions must export a default function, a setup function, or both',
    )
  }
  assert(
    extraHTTPHeaders === undefined ||
      (typeof extraHTTPHeaders === 'object' && Object.values(extraHTTPHeaders).every((value) => typeof value === 'string')),
    'extraHTTPHeaders must map header names to strings',
  )
  assert(
    Array.isArray(expect) && expect.every((selector) => typeof selector === 'string' && selector.trim()),
    'expect must list Playwright selectors',
  )
  assert(
    typeof allowPageErrors === 'boolean' || (Array.isArray(allowPageErrors) && allowPageErrors.every((p) => typeof p === 'string')),
    'allowPageErrors must be true or a list of regular expressions',
  )
  const patterns = typeof allowPageErrors === 'boolean' ? (allowPageErrors ? [/(?:)/] : []) : allowPageErrors.map((p) => new RegExp(p))
  const tolerated = (message: string) => patterns.some((pattern) => pattern.test(message))
  if (network) {
    for (const key of ['latencyMs', 'downloadKbps', 'uploadKbps'] as const) {
      assert(Number.isFinite(network[key]) && network[key] >= 0, `network.${key} must be a nonnegative number`)
    }
  }
  assert(cpuSlowdown === undefined || (Number.isFinite(cpuSlowdown) && cpuSlowdown >= 1), '--cpu-slowdown must be a number >= 1')
  const launch = launchOptions({browserPath, browserChannel})
  const playwright = loadPlaywright(command)
  let emulation: BrowserContextOptions = {viewport: {width: 1280, height: 900}}
  if (device) {
    assert(playwright.devices[device], `unknown Playwright device: ${device}`)
    // Coverage needs CDP, so only the descriptor is used, not its browser type.
    const {defaultBrowserType, ...descriptor} = playwright.devices[device]
    emulation = descriptor
  }
  const overrides = {viewport, userAgent, deviceScaleFactor, isMobile, hasTouch}
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) (emulation as Record<string, unknown>)[key] = value

  // Same-origin scripts under --prefix, or scripts under an explicit --cdn-prefix URL.
  const localPath = (scriptUrl: string) => {
    let url
    try {
      url = new URL(scriptUrl)
    } catch {
      return null
    }
    if (url.origin === target.origin && url.pathname.startsWith(prefix)) {
      return decodeURIComponent(url.pathname.slice(prefix.length))
    }
    const bare = url.origin + url.pathname
    const remote = remotes.find((remote) => bare.startsWith(remote))
    return remote ? decodeURIComponent(bare.slice(remote.length)) : null
  }
  return {
    target,
    remotes,
    origins,
    allowed,
    root,
    action,
    beforeNavigation,
    waitMs,
    scenario,
    device,
    network,
    cpuSlowdown,
    storageState,
    extraHTTPHeaders,
    expect,
    tolerated,
    browserPath,
    browserChannel,
    launch,
    playwright,
    emulation,
    localPath,
  }
}

// A page with the shared emulation, network policy, and throttling. `beforeunload` adds the
// listener that lets collect pause each document before it unloads. The actions module's
// `setup` runs last, so its routes take precedence over the origin policy.
export type Setup = Awaited<ReturnType<typeof prepare>>

export async function open(browser: Browser, setup: Setup, {beforeunload = false} = {}) {
  const {target, allowed, emulation, storageState, extraHTTPHeaders, network, cpuSlowdown, beforeNavigation} = setup
  const context = await browser.newContext({
    ...emulation,
    serviceWorkers: 'block',
    ...(storageState ? {storageState: resolve(storageState)} : {}),
    ...(extraHTTPHeaders ? {extraHTTPHeaders} : {}),
  })
  // Aborted requests per origin.
  const blocked = new Map<string, number>()
  const requests: {path: string; type: string}[] = []
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (allowed.has(url.origin)) {
      requests.push({
        path: url.origin === target.origin ? url.pathname + url.search : url.href,
        type: route.request().resourceType(),
      })
      return route.continue()
    }
    blocked.set(url.origin, (blocked.get(url.origin) ?? 0) + 1)
    // Named after the policy, so the request shows as net::ERR_BLOCKED_BY_CLIENT in failedRequests.
    return route.abort('blockedbyclient')
  })
  // A listener makes Chromium dispatch beforeunload, where the debugger pauses the
  // old document so its coverage and sources can be saved before navigation.
  if (beforeunload) await context.addInitScript(() => addEventListener('beforeunload', () => {}))
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // What the page ended up showing: the last main document response, console errors and warnings, and
  // requests that failed or were aborted, with the browser's reason.
  const state: PageState = {status: null, consoleErrors: 0, consoleMessages: [], failedRequests: []}
  page.on('response', (response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) state.status = response.status()
  })
  page.on('console', (message) => {
    const type = message.type()
    if (type === 'error') state.consoleErrors++
    if (type === 'error' || type === 'warning') state.consoleMessages.push({type, text: message.text()})
  })
  page.on('requestfailed', (request) => state.failedRequests.push({url: request.url(), reason: request.failure()?.errorText ?? 'unknown'}))
  const cdp = await context.newCDPSession(page)
  if (network) {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: network.latencyMs,
      downloadThroughput: (network.downloadKbps * 1000) / 8,
      uploadThroughput: (network.uploadKbps * 1000) / 8,
    })
  }
  if (cpuSlowdown) await cdp.send('Emulation.setCPUThrottlingRate', {rate: cpuSlowdown})
  if (beforeNavigation) await beforeNavigation({page, context})
  return {context, page, cdp, errors, blocked, requests, state}
}

export interface PageState {
  status: number | null
  consoleErrors: number
  consoleMessages: {type: string; text: string}[]
  failedRequests: {url: string; reason: string}[]
}

// The state the recording describes, so that an error or loading screen does not pass as the application.
function summary(
  scenario: string,
  url: string,
  state: PageState,
  blocked: Map<string, number>,
  errors: string[],
  prefetched: Prefetched[],
  evaluated: Prefetched[],
) {
  const lines = [
    `${scenario}: final page ${url} (document status ${state.status ?? 'none'}), ${state.consoleErrors} console errors, ${errors.length} page errors`,
  ]
  const few = (items: string[]) => items.slice(0, 3).join(', ') + (items.length > 3 ? `, and ${items.length - 3} more` : '')
  const consoleErrors = state.consoleMessages
    .filter((message) => message.type === 'error')
    .map((message) => JSON.stringify(message.text.length > 160 ? message.text.slice(0, 160) + '...' : message.text))
  if (consoleErrors.length) lines.push(`${scenario}: console errors: ${few(consoleErrors)}`)
  if (state.failedRequests.length)
    lines.push(`${scenario}: failed requests: ${few(state.failedRequests.map(({url, reason}) => `${url} (${reason})`))}`)
  if (blocked.size) {
    const origins = [...blocked].sort(([a], [b]) => a.localeCompare(b)).map(([origin, count]) => `${origin} (${count})`)
    lines.push(`${scenario}: aborted requests to origins outside --allow-origin and --cdn-prefix: ${origins.join(', ')}`)
  }
  const list = (scripts: Prefetched[]) => scripts.map(({path, routes}) => `${path} (${routes.join(', ')})`).join(', ')
  if (prefetched.length)
    lines.push(`${scenario}: left out scripts that only router prefetches for other routes loaded: ${list(prefetched)}`)
  if (evaluated.length)
    lines.push(
      `${scenario}: router prefetches for other routes also loaded scripts whose modules evaluated; the analyzer leaves them out when nothing else ran: ${list(evaluated)}`,
    )
  return lines.join('\n')
}

type Recorded = {path: string; url: string; functions: {ranges: {startOffset: number; endOffset: number; count: number}[]}[]}
type Prefetched = {path: string; url: string; routes: string[]}

// Whether a function other than the script's top level, the widest range, ran.
const ranFunction = ({functions}: Recorded) => {
  const width = ({ranges: [range]}: Recorded['functions'][number]) => range.endOffset - range.startOffset
  const top = Math.max(...functions.map(width))
  return functions.some((f) => f.ranges[0].count > 0 && width(f) < top)
}

// Scripts that only a router prefetch for another route loaded: a prefetch response or the build manifest of
// another route names them and no document or other RSC response does. `leftOut` are those in which nothing
// ran beyond the top level, so none of their modules was evaluated (Turbopack App Router prefetches). In
// `evaluated` a function ran: webpack and Pages Router prefetches evaluate the route's modules as the chunk
// loads, so the analyzer decides with the source maps whether more than module evaluation ran. A path
// matches as a whole segment suffix, which covers both `/_next/static/chunks/a.js` and `static/chunks/a.js`
// for `chunks/a.js`.
function prefetchedScripts(
  scripts: Recorded[],
  prefetches: {route: string; body: string}[],
  pageBodies: string[],
  sourceText: Map<string, string>,
) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matchers = new Map(scripts.map(({path}) => [path, new RegExp(`(?<![\\w.-])${escape(path)}(?![\\w.-])`)]))
  const names = (path: string, body: string) => matchers.get(path)!.test(body)
  // Bodies that name scripts, with the routes they stand for: prefetch responses and manifest entries, and the
  // text of each script found, which can load further scripts for the same routes (a Turbopack page chunk list).
  const bodies: {routes: () => string[]; body: string}[] = prefetches.map(({route, body}) => ({routes: () => [route], body}))
  const found = new Map<string, Prefetched & {ran: boolean}>()
  for (let grew = true; grew;) {
    grew = false
    for (const {path, url} of scripts) {
      if (found.has(url) || pageBodies.some((body) => names(path, body)) || !bodies.some(({body}) => names(path, body))) continue
      const entry = {path, url, routes: [] as string[], ran: scripts.some((script) => script.url === url && ranFunction(script))}
      found.set(url, entry)
      const text = sourceText.get(url)
      if (text) bodies.push({routes: () => entry.routes, body: text})
      grew = true
    }
  }
  // Routes settle once the scripts that name a script have theirs.
  for (let changed = true; changed;) {
    changed = false
    for (const entry of found.values()) {
      const routes = [...new Set(bodies.filter(({body}) => names(entry.path, body)).flatMap(({routes}) => routes()))].sort()
      if (routes.join('\n') !== entry.routes.join('\n')) {
        entry.routes = routes
        changed = true
      }
    }
  }
  const sorted = (ran: boolean) =>
    [...found.values()]
      .filter((entry) => entry.ran === ran)
      .map(({path, url, routes}) => ({path, url, routes}))
      .sort((a, b) => a.path.localeCompare(b.path))
  return {leftOut: sorted(false), evaluated: sorted(true)}
}

// `<out>` for run 1 of a repeated recording, and `<out>` with `.runN` before the extension for the others.
export function runPath(out: string, run: number) {
  if (run === 1) return out
  const suffix = ['.coverage.json', '.json'].find((s) => out.endsWith(s)) ?? ''
  return `${out.slice(0, out.length - suffix.length)}.run${run}${suffix}`
}

// The run files next to `out` from runs 2 and up, in run order.
export async function runFiles(out: string) {
  const suffix = ['.coverage.json', '.json'].find((s) => out.endsWith(s)) ?? ''
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escape(basename(out.slice(0, out.length - suffix.length)))}\\.run(\\d+)${escape(suffix)}$`)
  const directory = dirname(resolve(out))
  const names = await readdir(directory).catch(() => [] as string[])
  return names
    .map((name) => ({path: join(directory, name), run: Number(pattern.exec(name)?.[1])}))
    .filter(({run}) => run >= 2)
    .sort((a, b) => a.run - b.run)
}

// Page errors that no allowPageErrors pattern tolerates fail the scenario.
export function checkErrors(setup: Setup, errors: string[]) {
  const failed = errors.filter((message) => !setup.tolerated(message))
  assert(
    !failed.length,
    `page threw ${failed.length} runtime errors (allow expected ones with allowPageErrors or --allow-page-error):\n${failed.map((message) => `  ${message}`).join('\n')}`,
  )
}

// Every expect selector must match a visible element; checked without waiting, after the scenario ends.
export async function checkExpected(setup: Setup, page: Page) {
  const missing = []
  for (const selector of setup.expect) if (!(await page.locator(`${selector} >> visible=true`).count())) missing.push(selector)
  assert(
    !missing.length,
    `${setup.scenario}: no visible element matches expect ${missing.map((s) => JSON.stringify(s)).join(', ')} on the final page ${page.url()}`,
  )
}

// Checks script text the browser had against the file under --dir.
export async function checkScript(root: string, path: string, browserSource: string | Buffer) {
  assert(!path.includes('\\') && !path.split('/').includes('..'), 'script path escapes --dir')
  const diskPath = await realpath(resolve(root, path))
  const local = relative(root, diskPath)
  assert(local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local), 'script path escapes --dir')
  const source = await readFile(diskPath)
  assert.equal(digest(source), digest(browserSource), `browser/disk source mismatch: ${path}`)
  const map = await readMap(diskPath, String(browserSource), root)
  return {sha256: digest(source), sourceMapSha256: map ? digest(map) : null}
}

// Checks the browser's copy of a script against --dir. Needs the Debugger domain.
export async function verifyScript(cdp: CDPSession, root: string, scriptId: string, path: string) {
  const {scriptSource} = await cdp.send('Debugger.getScriptSource', {scriptId})
  return {...(await checkScript(root, path, scriptSource)), scriptSource}
}

// Capture settings recorded in coverage and profile files.
export async function environment(browser: Browser, page: Page, setup: Setup) {
  const {
    playwright,
    device,
    emulation,
    network,
    cpuSlowdown,
    storageState,
    extraHTTPHeaders,
    remotes,
    origins,
    browserPath,
    browserChannel,
  } = setup
  const exceptions = [remotes.length && '--cdn-prefix', origins.length && '--allow-origin'].filter(Boolean)
  return {
    browser: browser.version(),
    // Only when set, like allowedOrigins below. The executable's path can name the user, so only its use is recorded.
    ...(browserChannel ? {browserChannel} : {}),
    ...(browserPath ? {browserPath: true} : {}),
    node: process.version,
    platform: process.platform,
    playwright: playwright.version,
    device: device ?? null,
    viewport: emulation.viewport,
    userAgent: await page.evaluate(() => navigator.userAgent),
    deviceScaleFactor: emulation.deviceScaleFactor ?? 1,
    isMobile: emulation.isMobile ?? false,
    hasTouch: emulation.hasTouch ?? false,
    network: network ?? null,
    cpuSlowdown: cpuSlowdown ?? 1,
    // Records only whether a saved state was loaded; its cookies stay out of the artifact.
    storageState: Boolean(storageState),
    // Header names only, when set: values can be credentials.
    ...(extraHTTPHeaders && Object.keys(extraHTTPHeaders).length ? {extraHTTPHeaders: Object.keys(extraHTTPHeaders).sort()} : {}),
    serviceWorkers: 'blocked',
    externalRequests: exceptions.length ? `blocked except ${exceptions.join(' and ')} origins` : 'blocked',
    cdnPrefixes: remotes,
    // Only when set, so profiles stay comparable with baselines recorded before the option existed.
    ...(origins.length ? {allowedOrigins: origins} : {}),
  }
}

// Records the scenario `repeat` times, each in a fresh browser: run 1 at `out`, the others next to it (runPath).
export async function collect(options: CaptureOptions & {out?: string; repeat?: number}) {
  const {out, repeat = 1} = options
  assert(options.url && options.dir && out, 'url, dir and out are required')
  assert(Number.isInteger(repeat) && repeat >= 1, '--repeat must be a positive integer')
  const setup = await prepare(options, 'collect')
  // Runs of an earlier, longer repeat would otherwise be analyzed together with these.
  for (const stale of await runFiles(out)) if (stale.run > repeat) await rm(stale.path)
  let first
  for (let run = 1; run <= repeat; run++) {
    const artifact = await record(setup, runPath(out, run), repeat > 1 ? {run, runs: repeat} : {})
    first ??= artifact
  }
  return first!
}

async function record(setup: Setup, out: string, numbering: {run?: number; runs?: number}) {
  const {target, root, action, beforeNavigation, waitMs, scenario, localPath} = setup

  const browser = await setup.playwright.chromium.launch(setup.launch)
  try {
    const {context, page, cdp, errors, blocked, requests, state} = await open(browser, setup, {beforeunload: true})

    const failures: unknown[] = []
    const scripts: (Recorded & {sha256: string; sourceMapSha256: string | null})[] = []
    const excluded = new Set<string>()
    const verified = new Map<string, {sha256: string; sourceMapSha256: string | null}>()
    // Each script's text by URL: a script that only a prefetch loaded can name the scripts it loads in turn.
    const sourceText = new Map<string, string>()
    // A `//# sourceURL` comment replaces `url`; `embedderName` keeps the URL the script came from.
    const embedderNames = new Map<string, string>()
    const record = async () => {
      const {result} = await cdp.send('Profiler.takePreciseCoverage')
      for (const script of result) {
        const url = (localPath(script.url) === null && embedderNames.get(script.scriptId)) || script.url
        const path = localPath(url)
        if (path === null) {
          if (url) excluded.add(url)
          continue
        }
        // Inline/eval scripts have no matching generated file under --dir.
        if (!/\.(?:js|mjs|cjs)$/i.test(path)) {
          excluded.add(url)
          continue
        }
        if (!verified.has(script.scriptId)) {
          const {sha256, sourceMapSha256, scriptSource} = await verifyScript(cdp, root, script.scriptId, path)
          verified.set(script.scriptId, {sha256, sourceMapSha256})
          sourceText.set(url, scriptSource)
        }
        scripts.push({
          path,
          url,
          ...verified.get(script.scriptId)!,
          functions: script.functions,
        })
      }
    }

    // Bodies that name scripts: Next.js router prefetches (by route) and what the page itself requested.
    const prefetches: {route: string; body: string}[] = []
    // Routes the page navigated to, client-side navigations included: a prefetch for one of them is not for another route.
    const visited = new Set<string>()
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      try {
        visited.add(new URL(frame.url()).pathname)
      } catch {}
    })
    const pageBodies: string[] = []
    const reads: Promise<void>[] = []
    page.on('response', (response) => {
      const request = response.request()
      const headers = request.headers()
      const prefetch = 'next-router-prefetch' in headers
      if (!prefetch && !('rsc' in headers) && !(request.isNavigationRequest() && response.frame() === page.mainFrame())) return
      reads.push(
        response.text().then(
          (body) => {
            if (prefetch) prefetches.push({route: new URL(request.url()).pathname, body})
            else pageBodies.push(body)
          },
          // Redirects have no body to name scripts in.
          () => {},
        ),
      )
    })

    let snapshots = 0
    let queue = Promise.resolve()
    const snapshot = () =>
      (queue = queue.then(async () => {
        await record()
        snapshots++
      }))
    cdp.on('Debugger.paused', ({reason, data}) => {
      // Any other pause, such as a `debugger` statement in page code, would stop the page for good.
      if (reason !== 'EventListener' || data?.eventName !== 'listener:beforeunload') return cdp.send('Debugger.resume').catch(() => {})
      snapshot()
        .catch((error) => failures.push(error))
        .finally(() => cdp.send('Debugger.resume').catch(() => {}))
    })
    // Before Debugger.enable, which reports the scripts already parsed.
    cdp.on('Debugger.scriptParsed', ({scriptId, embedderName}) => embedderNames.set(scriptId, embedderName ?? ''))

    await cdp.send('Debugger.enable')
    await cdp.send('DOMDebugger.setEventListenerBreakpoint', {eventName: 'beforeunload'})
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.startPreciseCoverage', {callCount: true, detailed: true})
    const response = await page.goto(target.href, {waitUntil: 'networkidle'})
    assert(response?.ok(), `navigation failed: ${response?.status()}`)
    // A fixed observation window, not a performance measurement.
    await page.waitForTimeout(waitMs)
    if (action) await action({page, context})
    await snapshot()
    await cdp.send('Profiler.stopPreciseCoverage')
    if (failures.length) throw failures[0]
    await Promise.all(reads)
    // The Pages Router prefetches other pages' chunks from its build manifest, without a request that names
    // them; the manifest lists each route's chunks, and the current page is `__NEXT_DATA__.page`.
    prefetches.push(
      ...(await page
        .evaluate(() => {
          const manifest = (globalThis as {__BUILD_MANIFEST?: unknown}).__BUILD_MANIFEST
          const current = (globalThis as {__NEXT_DATA__?: {page?: string}}).__NEXT_DATA__?.page
          if (!manifest || typeof manifest !== 'object') return []
          return Object.entries(manifest)
            .filter(([route, files]) => route.startsWith('/') && route !== current && Array.isArray(files))
            .map(([route, files]) => ({route, body: (files as string[]).join('\n')}))
        })
        .catch(() => [])),
    )
    const {leftOut: prefetched, evaluated} = prefetchedScripts(
      scripts,
      prefetches.filter(({route}) => !visited.has(route)),
      pageBodies,
      sourceText,
    )
    const recorded = scripts.filter(({url}) => !prefetched.some((script) => script.url === url))
    // Printed before the page error and expect checks, so a failing scenario still shows its final state.
    console.warn(summary(scenario, page.url(), state, blocked, errors, prefetched, evaluated))
    checkErrors(setup, errors)
    await checkExpected(setup, page)
    assert(recorded.length > 0, 'no scripts matched --prefix or --cdn-prefix')
    recorded.sort((a, b) => a.path.localeCompare(b.path))
    const artifact = {
      schemaVersion: 1,
      scenario,
      ...numbering,
      capturedAt: new Date().toISOString(),
      environment: {
        ...(await environment(browser, page, setup)),
        scope: 'page CDP target only; no worker coverage',
        observation: `${beforeNavigation ? 'setup before navigation; ' : ''}navigation networkidle + ${waitMs}ms${action ? '; then custom actions' : ''}; ${snapshots} coverage snapshots (before each unload and at the end)`,
      },
      url: target.href,
      requests,
      blockedOrigins: [...blocked.keys()].sort(),
      failedRequests: state.failedRequests,
      consoleMessages: state.consoleMessages,
      pageErrors: errors,
      excludedScripts: [...excluded].sort(),
      prefetchedScripts: prefetched,
      prefetchEvaluatedScripts: evaluated,
      scripts: recorded,
    }
    await mkdir(dirname(resolve(out)), {recursive: true})
    await writeFile(out, JSON.stringify(artifact, null, 2) + '\n')
    console.log(
      `${scenario}: ${new Set(recorded.map((s) => s.path)).size} scripts, ${snapshots} snapshots -> ${out}${numbering.run ? ` (run ${numbering.run} of ${numbering.runs})` : ''}`,
    )
    return artifact
  } finally {
    await browser.close()
  }
}
