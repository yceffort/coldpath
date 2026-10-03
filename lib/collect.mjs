// Chromium creates the input; the Rust analyzer consumes it offline.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, readFile, realpath, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path'
import {pathToFileURL} from 'node:url'

import {readMap} from './maps.mjs'

// Playwright is an optional peer: only collection needs it.
export function loadPlaywright(command = 'collect') {
  for (const base of [import.meta.url, pathToFileURL(resolve('package.json')).href]) {
    const require = createRequire(base)
    for (const name of ['playwright', '@playwright/test']) {
      try {
        const {chromium, devices} = require(name)
        return {chromium, devices, version: require(`${name}/package.json`).version}
      } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error
      }
    }
  }
  throw new Error(`coldpath ${command} requires Playwright: npm install --save-dev playwright && npx playwright install chromium`)
}

const digest = (data) => createHash('sha256').update(data).digest('hex')

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
    device,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    network,
    cpuSlowdown,
    storageState,
  },
  command,
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
  const allowed = new Set([target.origin, ...remotes.map((remote) => new URL(remote).origin)])
  const root = await realpath(resolve(dir))
  let action
  if (actions) {
    action = (await import(pathToFileURL(resolve(actions)).href)).default
    assert.equal(typeof action, 'function', '--actions must default-export a function')
  }
  if (network) {
    for (const key of ['latencyMs', 'downloadKbps', 'uploadKbps']) {
      assert(Number.isFinite(network[key]) && network[key] >= 0, `network.${key} must be a nonnegative number`)
    }
  }
  assert(cpuSlowdown === undefined || (Number.isFinite(cpuSlowdown) && cpuSlowdown >= 1), '--cpu-slowdown must be a number >= 1')
  const playwright = loadPlaywright(command)
  let emulation = {viewport: {width: 1280, height: 900}}
  if (device) {
    assert(playwright.devices[device], `unknown Playwright device: ${device}`)
    // Coverage needs CDP, so only the descriptor is used, not its browser type.
    const {defaultBrowserType, ...descriptor} = playwright.devices[device]
    emulation = descriptor
  }
  const overrides = {viewport, userAgent, deviceScaleFactor, isMobile, hasTouch}
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) emulation[key] = value

  // Same-origin scripts under --prefix, or scripts under an explicit --cdn-prefix URL.
  const localPath = (scriptUrl) => {
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
    allowed,
    root,
    action,
    waitMs,
    scenario,
    device,
    network,
    cpuSlowdown,
    storageState,
    playwright,
    emulation,
    localPath,
  }
}

// A page with the shared emulation, network policy, and throttling. `beforeunload` adds the
// listener that lets collect pause each document before it unloads.
export async function open(browser, setup, {beforeunload = false} = {}) {
  const {target, allowed, emulation, storageState, network, cpuSlowdown} = setup
  const context = await browser.newContext({
    ...emulation,
    serviceWorkers: 'block',
    ...(storageState ? {storageState: resolve(storageState)} : {}),
  })
  const blocked = new Set()
  const requests = []
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (allowed.has(url.origin)) {
      requests.push({
        path: url.origin === target.origin ? url.pathname + url.search : url.href,
        type: route.request().resourceType(),
      })
      return route.continue()
    }
    blocked.add(url.origin)
    return route.abort()
  })
  // A listener makes Chromium dispatch beforeunload, where the debugger pauses the
  // old document so its coverage and sources can be saved before navigation.
  if (beforeunload) await context.addInitScript(() => addEventListener('beforeunload', () => {}))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
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
  return {context, page, cdp, errors, blocked, requests}
}

// Checks script text the browser had against the file under --dir.
export async function checkScript(root, path, browserSource) {
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
export async function verifyScript(cdp, root, scriptId, path) {
  const {scriptSource} = await cdp.send('Debugger.getScriptSource', {scriptId})
  return {...(await checkScript(root, path, scriptSource)), scriptSource}
}

// Capture settings recorded in coverage and profile files.
export async function environment(browser, page, setup) {
  const {playwright, device, emulation, network, cpuSlowdown, storageState, remotes} = setup
  return {
    browser: browser.version(),
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
    serviceWorkers: 'blocked',
    externalRequests: remotes.length ? 'blocked except --cdn-prefix origins' : 'blocked',
    cdnPrefixes: remotes,
  }
}

export async function collect(options) {
  const {out} = options
  assert(options.url && options.dir && out, 'url, dir and out are required')
  const setup = await prepare(options, 'collect')
  const {target, root, action, waitMs, scenario, localPath} = setup

  const browser = await setup.playwright.chromium.launch({headless: true})
  try {
    const {context, page, cdp, errors, blocked, requests} = await open(browser, setup, {beforeunload: true})

    const failures = []
    const scripts = []
    const excluded = new Set()
    const verified = new Map()
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
          ...verified.get(script.scriptId),
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
    assert.deepEqual(errors, [], 'page threw runtime errors')
    assert(scripts.length > 0, 'no scripts matched --prefix or --cdn-prefix')
    scripts.sort((a, b) => a.path.localeCompare(b.path))
    const artifact = {
      schemaVersion: 1,
      scenario,
      capturedAt: new Date().toISOString(),
      environment: {
        ...(await environment(browser, page, setup)),
        scope: 'page CDP target only; no worker coverage',
        observation: `navigation networkidle + ${waitMs}ms${action ? '; then custom actions' : ''}; ${snapshots} coverage snapshots (before each unload and at the end)`,
      },
      url: target.href,
      requests,
      blockedOrigins: [...blocked].sort(),
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
