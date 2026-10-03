// Repeated CPU profiles of a scenario file's scenarios. Only the profiler runs while a window is
// measured; scripts are checked against --dir after it stops, because the debugger affects timing.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {cpus} from 'node:os'
import {dirname, resolve} from 'node:path'
import {promisify} from 'node:util'

import {environment, open, prepare, verifyScript} from './collect.mjs'

// Chosen from the CPU noise measurements in issue #24.
export const SAMPLING_INTERVAL_US = 100
export const DEFAULT_RUNS = 10

const SCRIPT = /\.(?:js|mjs|cjs)$/i

// Profiles are comparable only on one machine within one boot. GitHub-hosted runners share a
// hostname, but every job boots a new VM.
async function machine() {
  let boot = null
  try {
    if (process.platform === 'linux') boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    else if (process.platform === 'darwin') boot = (await promisify(execFile)('sysctl', ['-n', 'kern.bootsessionuuid'])).stdout.trim()
  } catch {
    boot = null
  }
  return {cpu: cpus()[0]?.model ?? null, cores: cpus().length, boot: boot || null}
}

// UTF-16 offsets of line starts, with V8's line terminators.
function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) i++
      starts.push(i + 1)
    } else if (code === 10 || code === 0x2028 || code === 0x2029) starts.push(i + 1)
  }
  return starts
}

// Self samples and time of one window by leaf frame: functions of verified scripts by start offset,
// each script's top level, and buckets for everything that belongs to no analyzed source. A sample
// lasts until the next sample, or the end of the window.
function reduce(profile, scripts, localPath, unverified) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node)
  const kind = (node) => {
    const {scriptId, url, functionName, lineNumber, columnNumber} = node.callFrame
    if (scriptId === '0') {
      if (functionName.startsWith('(')) return {bucket: functionName}
      // A native API call counts toward profiled code only when that code called it directly.
      let caller = parents.get(node.id)
      while (caller?.callFrame.scriptId === '0') caller = parents.get(caller.id)
      return {bucket: caller && scripts.has(caller.callFrame.scriptId) ? '(native)' : '(other scripts)'}
    }
    const script = scripts.get(scriptId)
    if (!script) {
      // Without the debugger, V8 may collect a script that ran once before it can be verified.
      const path = localPath(url)
      if (path !== null && SCRIPT.test(path)) unverified.add(url)
      return {bucket: '(other scripts)'}
    }
    if (lineNumber === 0 && columnNumber === 0 && functionName === '') return {path: script.path}
    const start = script.lines[lineNumber]
    const end = lineNumber + 1 < script.lines.length ? script.lines[lineNumber + 1] : script.length
    assert(
      start !== undefined && columnNumber >= 0 && start + columnNumber < end,
      `${script.path}: profile position ${lineNumber}:${columnNumber} is outside the script`,
    )
    return {path: script.path, offset: start + columnNumber}
  }
  const kinds = new Map()
  const times = []
  let time = profile.startTime
  for (const delta of profile.timeDeltas) times.push((time += delta))
  const order = times.map((_, index) => index).sort((a, b) => times[a] - times[b] || a - b)
  const window = {durationUs: profile.endTime - profile.startTime, samples: order.length, buckets: {}, topLevel: {}, functions: {}}
  for (const [rank, index] of order.entries()) {
    const id = profile.samples[index]
    if (!kinds.has(id)) kinds.set(id, kind(nodes.get(id)))
    const {bucket, path, offset} = kinds.get(id)
    const cells = bucket ? window.buckets : offset === undefined ? window.topLevel : (window.functions[path] ??= {})
    const cell = (cells[bucket ?? (offset === undefined ? path : offset)] ??= {samples: 0, selfUs: 0})
    cell.samples++
    cell.selfUs += Math.max(0, (rank + 1 < order.length ? times[order[rank + 1]] : profile.endTime) - times[index])
  }
  return window
}

async function measure(entry) {
  const {setup} = entry
  const {target, root, action, waitMs, localPath} = setup
  const browser = await setup.playwright.chromium.launch({headless: true})
  try {
    const {context, page, cdp, errors, blocked} = await open(browser, setup)
    // The first navigation is page.goto; redirects continue it. Any other one starts a new document.
    let documents = 0
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !request.redirectedFrom()) documents++
    })
    let workers = 0
    page.on('worker', () => workers++)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', {interval: SAMPLING_INTERVAL_US})
    await cdp.send('Profiler.start')
    const response = await page.goto(target.href, {waitUntil: 'networkidle'})
    assert(response?.ok(), `navigation failed: ${response?.status()}`)
    await page.waitForTimeout(waitMs)
    const profiles = {load: (await cdp.send('Profiler.stop')).profile}
    if (action) {
      await cdp.send('Profiler.start')
      await action({page, context})
      profiles.action = (await cdp.send('Profiler.stop')).profile
    }
    assert.equal(documents, 1, 'coldpath profile does not support multi-document navigation flows; profile each page as its own scenario')
    assert.deepEqual(errors, [], 'page threw runtime errors')

    const urls = new Map()
    cdp.on('Debugger.scriptParsed', ({scriptId, url}) => urls.set(scriptId, url))
    await cdp.send('Debugger.enable')
    // A `debugger` statement in a later timer must not stop the page while scripts are checked.
    await cdp.send('Debugger.setSkipAllPauses', {skip: true})
    const scripts = new Map()
    for (const [scriptId, url] of urls) {
      const path = localPath(url)
      if (path === null || !SCRIPT.test(path)) continue
      const {scriptSource, ...evidence} = await verifyScript(cdp, root, scriptId, path)
      scripts.set(scriptId, {path, url, ...evidence, lines: lineStarts(scriptSource), length: scriptSource.length})
    }
    const unverified = new Set()
    const windows = Object.fromEntries(
      Object.entries(profiles).map(([name, profile]) => [name, reduce(profile, scripts, localPath, unverified)]),
    )
    entry.environment ??= await environment(browser, page, setup)
    return {windows, scripts: [...scripts.values()], blocked, workers, unverified}
  } finally {
    await browser.close()
  }
}

// Runs alternate between scenarios, so slow drift on the machine affects every scenario alike.
export async function profile(scenarios, {runs = DEFAULT_RUNS} = {}) {
  assert(Number.isSafeInteger(runs) && runs >= 2, '--runs must be an integer of at least 2')
  const entries = []
  for (const scenario of scenarios) {
    assert(scenario.profileOut, `${scenario.scenario}: no profile output path`)
    const setup = await prepare(scenario, 'profile')
    const names = setup.action ? ['load', 'action'] : ['load']
    entries.push({
      out: scenario.profileOut,
      setup,
      windows: Object.fromEntries(names.map((name) => [name, {durationUs: [], samples: [], buckets: {}}])),
      scripts: new Map(),
      blocked: new Set(),
      unverified: new Set(),
      workers: 0,
    })
  }
  // One cell per window: self samples and microseconds for every run.
  const cell = () => ({samples: Array.from({length: runs}, () => 0), selfUs: Array.from({length: runs}, () => 0)})
  const cells = (entry) => Object.fromEntries(Object.keys(entry.windows).map((name) => [name, cell()]))
  const record = (target, run, {samples, selfUs}) => {
    target.samples[run] = samples
    target.selfUs[run] = selfUs
  }
  for (let run = 0; run < runs; run++) {
    for (const entry of entries) {
      const result = await measure(entry)
      for (const origin of result.blocked) entry.blocked.add(origin)
      for (const url of result.unverified) entry.unverified.add(url)
      entry.workers += result.workers
      for (const script of result.scripts) {
        const known = entry.scripts.get(script.path)
        if (known) {
          assert(known.sha256 === script.sha256 && known.sourceMapSha256 === script.sourceMapSha256, `${script.path}: changed between runs`)
          continue
        }
        const {path, url, sha256, sourceMapSha256} = script
        entry.scripts.set(path, {path, url, sha256, sourceMapSha256, topLevel: cells(entry), functions: new Map()})
      }
      for (const [name, window] of Object.entries(result.windows)) {
        const target = entry.windows[name]
        target.durationUs.push(window.durationUs)
        target.samples.push(window.samples)
        for (const [bucket, value] of Object.entries(window.buckets)) record((target.buckets[bucket] ??= cell()), run, value)
        for (const [path, value] of Object.entries(window.topLevel)) record(entry.scripts.get(path).topLevel[name], run, value)
        for (const [path, functions] of Object.entries(window.functions)) {
          const script = entry.scripts.get(path)
          for (const [offset, value] of Object.entries(functions)) {
            if (!script.functions.has(Number(offset))) script.functions.set(Number(offset), cells(entry))
            record(script.functions.get(Number(offset))[name], run, value)
          }
        }
      }
    }
  }
  const host = await machine()
  for (const entry of entries) {
    const {setup, windows} = entry
    for (const window of Object.values(windows))
      window.buckets = Object.fromEntries(Object.entries(window.buckets).sort(([a], [b]) => a.localeCompare(b)))
    const scripts = [...entry.scripts.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({functions, ...script}) => ({
        ...script,
        functions: [...functions].sort(([a], [b]) => a - b).map(([offset, windows]) => ({offset, windows})),
      }))
    const artifact = {
      schemaVersion: 1,
      scenario: setup.scenario,
      capturedAt: new Date().toISOString(),
      runs,
      samplingIntervalUs: SAMPLING_INTERVAL_US,
      environment: {
        ...entry.environment,
        machine: host,
        scope: 'page main thread only; no worker CPU time',
        observation: `a fresh browser per run; load window: navigation networkidle + ${setup.waitMs}ms${setup.action ? '; action window: custom actions' : ''}; only the profiler runs during windows`,
      },
      url: setup.target.href,
      blockedOrigins: [...entry.blocked].sort(),
      windows,
      scripts,
    }
    await mkdir(dirname(resolve(entry.out)), {recursive: true})
    await writeFile(entry.out, JSON.stringify(artifact, null, 2) + '\n')
    const sampled = scripts.reduce((sum, script) => sum + script.functions.length, 0)
    console.log(`${setup.scenario}: ${runs} runs, ${scripts.length} scripts, ${sampled} sampled functions -> ${entry.out}`)
    if (entry.workers) console.warn(`${setup.scenario}: ${entry.workers} workers started across runs; worker CPU time is not recorded`)
    for (const url of entry.unverified)
      console.warn(`${setup.scenario}: ${url} was collected before it could be verified; its samples count as (other scripts)`)
  }
}
