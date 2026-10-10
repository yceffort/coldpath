// Chromium creates the input; the Rust analyzer consumes it offline.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, readFile, realpath, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path'
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
    return route.abort()
  })
  // A listener makes Chromium dispatch beforeunload, where the debugger pauses the
  // old document so its coverage and sources can be saved before navigation.
  if (beforeunload) await context.addInitScript(() => addEventListener('beforeunload', () => {}))
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // What the page ended up showing: the last main document response and console errors.
  const state = {status: null as number | null, consoleErrors: 0}
  page.on('response', (response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) state.status = response.status()
  })
  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors++
  })
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

// The state the recording describes, so that an error or loading screen does not pass as the application.
function summary(
  scenario: string,
  url: string,
  state: {status: number | null; consoleErrors: number},
  blocked: Map<string, number>,
  errors: string[],
) {
  const lines = [
    `${scenario}: final page ${url} (document status ${state.status ?? 'none'}), ${state.consoleErrors} console errors, ${errors.length} page errors`,
  ]
  if (blocked.size) {
    const origins = [...blocked].sort(([a], [b]) => a.localeCompare(b)).map(([origin, count]) => `${origin} (${count})`)
    lines.push(`${scenario}: aborted requests to origins outside --allow-origin and --cdn-prefix: ${origins.join(', ')}`)
  }
  return lines.join('\n')
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

export async function collect(options: CaptureOptions & {out?: string}) {
  const {out} = options
  assert(options.url && options.dir && out, 'url, dir and out are required')
  const setup = await prepare(options, 'collect')
  const {target, root, action, beforeNavigation, waitMs, scenario, localPath} = setup

  const browser = await setup.playwright.chromium.launch(setup.launch)
  try {
    const {context, page, cdp, errors, blocked, requests, state} = await open(browser, setup, {beforeunload: true})

    const failures: unknown[] = []
    const scripts: {path: string; url: string; sha256: string; sourceMapSha256: string | null; functions: unknown[]}[] = []
    const excluded = new Set<string>()
    const verified = new Map<string, {sha256: string; sourceMapSha256: string | null}>()
    const record = async () => {
      const {result} = await cdp.send('Profiler.takePreciseCoverage')
      for (const script of result) {
        const path = localPath(script.url)
        if (path === null) {
          if (script.url) excluded.add(script.url)
          continue
        }
        // Inline/eval scripts have no matching generated file under --dir.
        if (!/\.(?:js|mjs|cjs)$/i.test(path)) {
          excluded.add(script.url)
          continue
        }
        if (!verified.has(script.scriptId)) {
          const {sha256, sourceMapSha256} = await verifyScript(cdp, root, script.scriptId, path)
          verified.set(script.scriptId, {sha256, sourceMapSha256})
        }
        scripts.push({
          path,
          url: script.url,
          ...verified.get(script.scriptId)!,
          functions: script.functions,
        })
      }
    }

    let snapshots = 0
    let queue = Promise.resolve()
    const snapshot = () =>
      (queue = queue.then(async () => {
        await record()
        snapshots++
      }))
    cdp.on('Debugger.paused', ({reason, data}) => {
      if (reason !== 'EventListener' || data?.eventName !== 'listener:beforeunload') return
      snapshot()
        .catch((error) => failures.push(error))
        .finally(() => cdp.send('Debugger.resume').catch(() => {}))
    })

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
    // Printed before the page error and expect checks, so a failing scenario still shows its final state.
    console.warn(summary(scenario, page.url(), state, blocked, errors))
    checkErrors(setup, errors)
    await checkExpected(setup, page)
    assert(scripts.length > 0, 'no scripts matched --prefix or --cdn-prefix')
    scripts.sort((a, b) => a.path.localeCompare(b.path))
    const artifact = {
      schemaVersion: 1,
      scenario,
      capturedAt: new Date().toISOString(),
      environment: {
        ...(await environment(browser, page, setup)),
        scope: 'page CDP target only; no worker coverage',
        observation: `${beforeNavigation ? 'setup before navigation; ' : ''}navigation networkidle + ${waitMs}ms${action ? '; then custom actions' : ''}; ${snapshots} coverage snapshots (before each unload and at the end)`,
      },
      url: target.href,
      requests,
      blockedOrigins: [...blocked.keys()].sort(),
      pageErrors: errors,
      excludedScripts: [...excluded].sort(),
      scripts,
    }
    await mkdir(dirname(resolve(out)), {recursive: true})
    await writeFile(out, JSON.stringify(artifact, null, 2) + '\n')
    console.log(`${scenario}: ${new Set(scripts.map((s) => s.path)).size} scripts, ${snapshots} snapshots -> ${out}`)
    return artifact
  } finally {
    await browser.close()
  }
}
