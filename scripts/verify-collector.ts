import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = join(root, 'artifacts', 'collector')
const fixture = join(root, 'examples', 'recorded')
await mkdir(artifacts, {recursive: true})
const binary = join(root, 'target', 'debug', 'coldpath')
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const source = await readFile(join(fixture, 'entry.js'), 'utf8')
let servedSource = source
// Scripts served under /site/ from artifacts/collector/site, each loaded by /site/NAME.html.
const site = join(artifacts, 'site')
const siteScripts: Record<string, string> = {
  // A `debugger` statement must not stop the page (#67).
  'debugger.js': 'function afterDebugger(){return 1}\nsetTimeout(() => { debugger; window.done = afterDebugger() }, 200)\n',
  // V8 reports a final `//# sourceURL` comment as the script's url (#74).
  'renamed.js': 'function renamed(){return 2}\nwindow.result = renamed()\n//# sourceURL=renamed-bundle.js\n',
}
await mkdir(site, {recursive: true})
for (const [name, text] of Object.entries(siteScripts)) await writeFile(join(site, name), text)
const server = createServer((request, response) => {
  if (request.url!.startsWith('/site/') && Object.hasOwn(siteScripts, request.url!.slice('/site/'.length))) {
    response.setHeader('content-type', 'text/javascript; charset=utf-8')
    response.end(siteScripts[request.url!.slice('/site/'.length)])
  } else if (/^\/site\/\w+\.html$/.test(request.url!)) {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><script src="${request.url!.replace(/html$/, 'js')}"></script>`)
  } else if (request.url === '/assets/entry.js') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8')
    response.end(servedSource)
  } else if (request.url === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    // A console error and a request to another origin, which the origin policy aborts.
    response.end(
      '<!doctype html><meta charset="utf-8"><script src="/assets/entry.js"></script><script>console.error("boom"); fetch("http://127.0.0.1:1/x").catch(() => {})</script>',
    )
  } else {
    response.writeHead(404).end()
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const args = [
    join(root, 'bin', 'coldpath.ts'),
    'collect',
    '--url',
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    '--dir',
    fixture,
    '--prefix',
    '/assets/',
    '--wait-ms',
    '0',
  ]
  const actions = join(artifacts, 'interact.mjs')
  await writeFile(
    actions,
    `export default async function ({page}) {
    const result = await page.evaluate(() => globalThis.__coldpathApp.run(true))
    if (result !== '한🔥') throw new Error('Interaction did not run')
  }\n`,
  )
  for (const scenario of ['initial', 'interaction']) {
    const output = join(artifacts, `${scenario}.coverage.json`)
    const {stderr} = await run(process.execPath, [
      ...args,
      '--scenario',
      scenario,
      '--out',
      output,
      ...(scenario === 'interaction' ? ['--actions', actions] : []),
    ])
    const capture = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(capture.scenario, scenario)
    assert.equal(capture.scripts.length, 1)
    assert.equal(capture.scripts[0].path, 'entry.js')
    // Console messages and failed requests are in the envelope and the summary (#64).
    // Chromium also logs the aborted request as a console error, which is where many "console errors" come from.
    assert.equal(capture.consoleMessages.length, 2)
    assert.deepEqual(capture.consoleMessages[0], {type: 'error', text: 'boom'})
    assert.match(capture.consoleMessages[1].text, /^Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/)
    assert.equal(capture.failedRequests.length, 1)
    assert.equal(capture.failedRequests[0].url, 'http://127.0.0.1:1/x')
    assert.match(capture.failedRequests[0].reason, /^net::ERR_BLOCKED_BY_CLIENT/)
    assert.deepEqual(capture.blockedOrigins, ['http://127.0.0.1:1'])
    assert.match(
      stderr,
      /, 2 console errors, 0 page errors\n.*: console errors: "boom", "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT[^"]*"\n.*: failed requests: http:\/\/127\.0\.0\.1:1\/x \(net::ERR_BLOCKED_BY_CLIENT[^)]*\)\n/,
    )
    const analyze = async (inputs: string[], name: string) => {
      const report = join(artifacts, `${name}.json`)
      await run(binary, ['--dir', fixture, ...inputs.flatMap((input) => ['--coverage', input]), '--json', report])
      return JSON.parse(await readFile(report, 'utf8'))
    }
    const actual = await analyze([output], scenario)
    // The recorded interaction is a counter-reset delta; a fresh capture
    // includes initial load, so compare it with the union of both recordings.
    const expected = await analyze(
      [join(fixture, 'initial.coverage.json'), ...(scenario === 'interaction' ? [join(fixture, 'interaction.coverage.json')] : [])],
      `${scenario}-expected`,
    )
    assert.deepEqual(actual.totals, expected.totals)
    assert.equal(actual.bundles[0].verification[0].source, 'sha256')
    assert.equal(actual.bundles[0].verification[0].sourceMap, 'capture-bound')
  }
  // --repeat records fresh browsers into numbered files; analyze --scenarios picks every run up and reports
  // the spread, and a shorter repeat removes stale runs.
  const repeated = join(artifacts, 'repeated.coverage.json')
  const {stdout: repeatLog} = await run(process.execPath, [...args, '--scenario', 'repeated', '--out', repeated, '--repeat', '3'])
  assert.match(repeatLog, /repeated: 1 scripts, \d+ snapshots -> .*repeated\.coverage\.json \(run 1 of 3\)\n/)
  assert.match(repeatLog, /repeated\.run3\.coverage\.json \(run 3 of 3\)\n/)
  const runs = [1, 2, 3].map((run) => (run === 1 ? repeated : join(artifacts, `repeated.run${run}.coverage.json`)))
  for (const [index, file] of runs.entries()) {
    const capture = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(capture.run, index + 1)
    assert.equal(capture.runs, 3)
  }
  const scenarioFile = join(artifacts, 'repeated.scenarios.json')
  await writeFile(
    scenarioFile,
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      dir: fixture,
      prefix: '/assets/',
      out: '.',
      scenarios: [{name: 'repeated'}],
    }),
  )
  const spreadReport = join(artifacts, 'repeated.json')
  await run(process.execPath, [join(root, 'bin', 'coldpath.ts'), 'analyze', '--scenarios', scenarioFile, '--json', spreadReport], {
    env: {...process.env, COLDPATH_ANALYZER: binary},
  })
  const spread = JSON.parse(await readFile(spreadReport, 'utf8'))
  assert.equal(spread.scenarios.length, 1)
  assert.deepEqual(
    spread.runs.map((r: any) => [r.scenario, r.runs, r.totals.observedBytes.min === r.totals.observedBytes.max]),
    [['repeated', 3, true]],
  )
  // The wrapper reads the `--name=value` forms too, and an option it reads needs its value.
  const emptyMaps = join(artifacts, 'empty.maps.json')
  await writeFile(emptyMaps, '{}')
  const equalsReport = join(artifacts, 'repeated-equals.json')
  const analyzeCli = (...extra: string[]) =>
    run(process.execPath, [join(root, 'bin', 'coldpath.ts'), 'analyze', ...extra], {env: {...process.env, COLDPATH_ANALYZER: binary}})
  await analyzeCli(
    `--scenarios=${scenarioFile}`,
    `--dir=${fixture}`,
    '--initial-scenario=repeated',
    '--scenario-order=repeated',
    `--maps-json=${emptyMaps}`,
    '--json',
    equalsReport,
  )
  assert.deepEqual(JSON.parse(await readFile(equalsReport, 'utf8')).totals, spread.totals)
  for (const option of ['--maps-json', '--scenarios'])
    await assert.rejects(analyzeCli(option), new RegExp(`coldpath: ${option} requires a file`))
  await run(process.execPath, [...args, '--scenario', 'repeated', '--out', repeated, '--repeat', '1'])
  assert.deepEqual(
    (await readdir(artifacts)).filter((name) => name.startsWith('repeated.run')),
    [],
  )
  assert.equal(JSON.parse(await readFile(repeated, 'utf8')).run, undefined)
  // Command-line options override the scenario file; the options that name the scenario's page and files conflict with it.
  const overrideFile = join(artifacts, 'override.scenarios.json')
  await writeFile(
    overrideFile,
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      dir: fixture,
      prefix: '/assets/',
      out: '.',
      waitMs: 1000,
      scenarios: [{name: 'override'}],
    }),
  )
  await run(process.execPath, [join(root, 'bin', 'coldpath.ts'), 'collect', '--scenarios', overrideFile, '--wait-ms', '0'])
  assert.match(
    JSON.parse(await readFile(join(artifacts, 'override.coverage.json'), 'utf8')).environment.observation,
    /^navigation networkidle \+ 0ms;/,
  )
  await assert.rejects(
    run(process.execPath, [join(root, 'bin', 'coldpath.ts'), 'collect', '--scenarios', overrideFile, '--out', 'x.json']),
    /--scenarios does not take --url\/--dir\/--out\/--scenario\/--actions/,
  )

  const siteCollect = async (name: string) => {
    const output = join(artifacts, `${name}.coverage.json`)
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/site/${name}.html`
    // A paused page would otherwise hang the run.
    await run(
      process.execPath,
      [join(root, 'bin', 'coldpath.ts'), 'collect', '--url', url, '--dir', site, '--prefix', '/site/', '--wait-ms', '0', '--out', output],
      {timeout: 60000},
    )
    return JSON.parse(await readFile(output, 'utf8'))
  }
  // Other debugger pauses are resumed, so collect finishes and records the code after the statement.
  const paused = await siteCollect('debugger')
  assert.equal(paused.scripts[0].functions.find((f: any) => f.functionName === 'afterDebugger').ranges[0].count, 1)
  // A renamed script is recorded under the path it was served from.
  const renamed = await siteCollect('renamed')
  assert.deepEqual(
    renamed.scripts.map((s: any) => [s.path, new URL(s.url).pathname]),
    [['renamed.js', '/site/renamed.js']],
  )
  assert.equal(renamed.scripts[0].functions.find((f: any) => f.functionName === 'renamed').ranges[0].count, 1)

  // The browser and disk must match even when the URL still looks correct.
  servedSource = source + '\n'
  await assert.rejects(run(process.execPath, [...args, '--out', join(artifacts, 'stale.coverage.json')]), /browser\/disk source mismatch/)
  await assert.rejects(
    run(process.execPath, [...args, '--prefix', '/assets', '--out', join(artifacts, 'invalid.coverage.json')]),
    /--prefix must be/,
  )
} finally {
  await new Promise((resolve) => server.close(resolve))
}
console.log(
  'Verified standalone collector, custom actions, console and failed-request records, repeated runs, source/map evidence, and stale-source rejection.',
)
