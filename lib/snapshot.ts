// Record a deployed site you do not build: the scripts it served, their V8 coverage, and what caused each load.
// The saved script text is the evidence; the analyzer compares coverage against it offline.
import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

import {launchOptions, loadPlaywright} from './collect.ts'

const EMPTY_MAP = JSON.stringify({version: 3, sources: [], names: [], mappings: ''})

// Analysis-root-relative path, matching the analyzer's `--url-prefix https://` mapping.
const bundlePath = (url: URL) => {
  const {host, pathname} = new URL(url)
  return host + decodeURIComponent(pathname)
}

const readJson = async (file: string, fallback: unknown) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

// With `scenario`, repeated visits share one directory: coverage/<scenario>.json per visit, and scripts,
// maps and load causes accumulate. A script that differs from an earlier visit's copy is an error.
export async function snapshot({
  url,
  out,
  waitMs = 5000,
  actions,
  scenario,
  browserPath,
  browserChannel,
}: {
  url?: string
  out?: string
  waitMs?: number
  actions?: string
  scenario?: string
  browserPath?: string
  browserChannel?: string
}) {
  assert(
    url && out,
    'Usage: coldpath snapshot --url URL --out DIRECTORY [--wait-ms N] [--actions FILE] [--scenario NAME] [--browser-path FILE | --browser-channel NAME]',
  )
  const launch = launchOptions({browserPath, browserChannel})
  assert(scenario === undefined || /^[\w.-]+$/.test(scenario), '--scenario may contain letters, digits, _, . and -')
  assert(Number.isSafeInteger(waitMs) && waitMs >= 0, '--wait-ms must be a nonnegative integer')
  const target = new URL(url)
  assert(['http:', 'https:'].includes(target.protocol), '--url must use http or https')
  let action
  if (actions) {
    action = (await import(pathToFileURL(resolve(actions)).href)).default
    assert.equal(typeof action, 'function', '--actions must default-export a function')
  }
  const {chromium} = loadPlaywright('snapshot')
  const browser = await chromium.launch(launch)
  const entries: {url: string; source: string; functions: unknown[]}[] = [],
    documents = new Map<string | undefined, Promise<string | undefined>>(),
    requests = new Map<string, {initiator: string; startMs: number; documentURL: string}>()
  let snapshots = 0,
    initial
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}})
    // As in collect: a beforeunload listener lets the debugger pause each document before it unloads,
    // so its coverage and script text are saved before a full-page navigation discards them.
    await context.addInitScript(() => addEventListener('beforeunload', () => {}))
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    // Load causes compare a script with the HTML of the document that requested it.
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        documents.set(
          response.url(),
          response.text().catch(() => undefined),
        )
      }
    })
    await cdp.send('Network.enable')
    let origin
    cdp.on('Network.requestWillBeSent', ({request, initiator, timestamp, documentURL}) => {
      origin ??= timestamp
      const key = request.url.split(/[?#]/)[0]
      if (!requests.has(key)) requests.set(key, {initiator: initiator.type, startMs: Math.round((timestamp - origin) * 1000), documentURL})
    })
    const sources = new Map<string, string>(),
      failures: unknown[] = []
    const record = async () => {
      const {result} = await cdp.send('Profiler.takePreciseCoverage')
      for (const {scriptId, url, functions} of result) {
        if (!/^https?:/.test(url)) continue
        if (!sources.has(scriptId)) sources.set(scriptId, (await cdp.send('Debugger.getScriptSource', {scriptId})).scriptSource)
        entries.push({url, source: sources.get(scriptId)!, functions})
      }
      snapshots++
    }
    let queue = Promise.resolve()
    const snapshot = () => (queue = queue.then(record))
    cdp.on('Debugger.paused', ({reason, data}) => {
      if (reason !== 'EventListener' || data?.eventName !== 'listener:beforeunload') return
      // The initial about:blank document unloads before the first response and has nothing to record.
      if (!documents.size) return cdp.send('Debugger.resume').catch(() => {})
      snapshot()
        .catch((error) => failures.push(error))
        .finally(() => cdp.send('Debugger.resume').catch(() => {}))
    })
    await cdp.send('Debugger.enable')
    await cdp.send('DOMDebugger.setEventListenerBreakpoint', {eventName: 'beforeunload'})
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.startPreciseCoverage', {callCount: true, detailed: true})
    const response = await page.goto(target.href, {waitUntil: 'load', timeout: 60000})
    assert(response?.ok(), `navigation failed: ${response?.status()}`)
    initial = response!.url()
    await page.waitForTimeout(waitMs)
    if (action) await action({page, context})
    await snapshot()
    await cdp.send('Profiler.stopPreciseCoverage')
    if (failures.length) throw failures[0]
  } finally {
    await browser.close()
  }

  out = resolve(out)
  const files = join(out, 'files')
  const bindings = await readJson(join(out, 'maps.json'), {})
  const loading = (await readJson(join(out, 'loading.json'), {bundles: {}})).bundles
  const coverage: typeof entries = [],
    seen = new Set<string>(),
    inHtml = new Map<string | undefined, Set<string>>()
  const loadCause = async (key: string, name: string, documentURL: string | undefined) => {
    if (!documents.has(documentURL)) documentURL = initial
    const html = (await documents.get(documentURL)) ?? ''
    if (!inHtml.has(documentURL)) {
      inHtml.set(
        documentURL,
        new Set(
          [...html.matchAll(/<(?:script\b[^>]*\ssrc|link\b[^>]*\shref)\s*=\s*["']([^"']+)["']/gi)].map(
            (m) => new URL(m[1].replaceAll('&amp;', '&'), documentURL).href.split(/[?#]/)[0],
          ),
        ),
      )
    }
    return inHtml.get(documentURL)!.has(key) ? 'html' : html.includes(name) ? 'inline' : 'dynamic'
  }
  for (const entry of entries) {
    let scriptUrl
    try {
      scriptUrl = new URL(entry.url)
    } catch {
      continue
    }
    if (!/\.(m|c)?js$/.test(scriptUrl.pathname)) continue
    const path = bundlePath(scriptUrl)
    // A script appears once per snapshot; the analyzer unions repeated entries of one recording.
    coverage.push(entry)
    if (seen.has(path)) {
      assert((await readFile(join(files, path), 'utf8')) === entry.source, `${path} changed between documents of one visit`)
      continue
    }
    seen.add(path)
    const earlier = await readFile(join(files, path), 'utf8').catch(() => undefined)
    assert(earlier === undefined || earlier === entry.source, `${path} differs from the copy an earlier snapshot saved in ${out}`)
    if (earlier !== undefined) continue
    await mkdir(dirname(join(files, path)), {recursive: true})
    await writeFile(join(files, path), entry.source)

    const key = scriptUrl.href.split(/[?#]/)[0]
    const {documentURL, ...request} = requests.get(key) ?? {}
    loading[path] = {load: await loadCause(key, scriptUrl.pathname.split('/').pop()!, documentURL), ...request}

    // The analyzer never fetches maps. A reachable map is saved at its own URL path under files/, so its
    // relative source paths resolve as they would on the site; an unreachable one is bound to an empty map.
    const reference = entry.source
      .trimEnd()
      .split(/\r\n|[\r\n\u2028\u2029]/)
      .at(-1)!
      .match(/^\/\/[#@]\s*sourceMappingURL=(\S+)$/)?.[1]
    if (!reference || reference.startsWith('data:')) continue
    const mapUrl = new URL(reference, scriptUrl)
    let text
    try {
      const fetched = await fetch(mapUrl)
      if (fetched.ok) {
        text = await fetched.text()
        JSON.parse(text)
      }
    } catch {
      text = undefined
    }
    const mapPath = text === undefined ? `maps/${path}.map` : `files/${bundlePath(mapUrl)}`
    await mkdir(dirname(join(out, mapPath)), {recursive: true})
    await writeFile(join(out, mapPath), text ?? EMPTY_MAP)
    bindings[path] = mapPath
  }
  const coverageFile = scenario ? join(out, 'coverage', `${scenario}.json`) : join(out, 'coverage.json')
  await mkdir(dirname(coverageFile), {recursive: true})
  await writeFile(coverageFile, JSON.stringify(coverage))
  await writeFile(join(out, 'maps.json'), JSON.stringify(bindings, null, 2) + '\n')
  await writeFile(join(out, 'loading.json'), JSON.stringify({schemaVersion: 1, bundles: loading}, null, 2) + '\n')
  const counts = [...seen].map((path) => loading[path]).reduce((sum, {load}) => ({...sum, [load]: (sum[load] || 0) + 1}), {})
  console.log(
    `${seen.size} scripts (${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}), ${snapshots} snapshots, ` + `${Object.keys(bindings).length} declared maps -> ${coverageFile}`,
  )
}
