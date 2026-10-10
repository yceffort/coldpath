#!/usr/bin/env node
import {readFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {parseArgs} from 'node:util'
import {runAnalyzer} from '../lib/analyzer.ts'
import {collect} from '../lib/collect.ts'
import {exportGraph} from '../lib/export-graph.ts'
import {label} from '../lib/label.ts'
import {inferModules} from '../lib/modules.ts'
import {DEFAULT_RUNS, profile} from '../lib/profile.ts'
import {loadScenarios} from '../lib/scenarios.ts'
import {snapshot} from '../lib/snapshot.ts'
import type {Network} from '../lib/collect.ts'

const usage = `Usage:
  coldpath collect --scenarios coldpath.scenarios.json
  coldpath collect --url URL --dir DIRECTORY --out FILE [COLLECT OPTIONS...]
  coldpath profile --scenarios coldpath.scenarios.json [--runs N]
  coldpath graph --format esbuild|webpack|turbopack --input FILE --root BUILD_ROOT --out graph.json [--environment client|server|all]
  coldpath snapshot --url URL --out DIRECTORY [--wait-ms N] [--actions FILE] [--scenario NAME] [--browser-path FILE | --browser-channel NAME]
  coldpath modules --dir DIRECTORY --out MAP_DIRECTORY [--maps-json maps.json]... [--chunks] [--graph FILE]
  coldpath label --report report.json --out labels.json [--mode identify|describe] [--provider anthropic|openai]
                 [--model NAME] [--base-url URL] [--top N] [--lang LANGUAGE]
  coldpath analyze [--scenarios coldpath.scenarios.json] [--maps-json maps.json]... [ANALYZER OPTIONS...] [--export DIRECTORY]
  coldpath --replay DIRECTORY [--json FILE] [--html FILE]
  coldpath [ANALYZER OPTIONS...]

Run \`coldpath COMMAND --help\` for a command's options, and \`coldpath analyze --help\` for analyzer options.
See docs/collecting.md, docs/cpu.md, docs/graphs.md and docs/third-party.md.`

const browserOptions = `  --browser-channel NAME     Installed browser by Playwright channel, such as chrome or msedge
  --browser-path FILE        Installed Chromium-based browser executable (not with --browser-channel)`

const help: Record<string, string> = {
  collect: `Usage:
  coldpath collect --scenarios coldpath.scenarios.json
  coldpath collect --url URL --dir DIRECTORY --out FILE [OPTIONS...]

Records V8 coverage of one browser scenario with Playwright's Chromium (docs/collecting.md).

  --scenarios FILE           Collect every scenario of a scenario file, in order
  --url URL                  Page to open
  --dir DIRECTORY            Build output the served scripts must match
  --out FILE                 Coverage file to write
  --prefix PATH              URL path under which --dir is served (default /)
  --scenario NAME            Scenario name (default initial)
  --actions FILE             Module whose default export runs after load; its setup export runs before navigation
  --wait-ms N                Observation window after networkidle (default 1000)
  --header 'NAME: VALUE'     Extra HTTP request header; repeatable
  --cdn-prefix URL           Also record scripts under this URL; repeatable
  --allow-origin ORIGIN      Let requests to this origin through; repeatable
  --device NAME              Playwright device descriptor, such as 'Pixel 7'
  --viewport WxH             Viewport (default 1280x900)
  --user-agent UA            User agent
  --device-scale-factor N    Pixel ratio
  --mobile, --touch          Mobile viewport handling and touch events
  --latency-ms N --download-kbps N --upload-kbps N
                             Network emulation; all three are required
  --cpu-slowdown N           CPU throttling rate (default 1, no slowdown)
  --storage-state FILE       Playwright storage state with cookies and local storage
${browserOptions}`,
  profile: `Usage: coldpath profile --scenarios coldpath.scenarios.json [--runs N]

Records repeated CPU profiles of every scenario in a scenario file (docs/cpu.md).

  --scenarios FILE           Scenario file, as for collect
  --runs N                   Runs per scenario, at least 2 (default ${DEFAULT_RUNS})`,
  graph: `Usage: coldpath graph --format esbuild|webpack|turbopack --input FILE --root BUILD_ROOT --out graph.json [--environment client|server|all]

Exports a bundler's module graph for the analyzer's --graph (docs/graphs.md).

  --format NAME              esbuild metafile, webpack stats, or Turbopack analyzer output
  --input FILE               Metafile, stats JSON, or the Turbopack analyze directory or modules.data
  --root BUILD_ROOT          Directory the bundler's module paths are relative to (default .)
  --out FILE                 Graph JSON to write
  --environment NAME         Turbopack module variants: client, server, or all (default client)`,
  snapshot: `Usage: coldpath snapshot --url URL --out DIRECTORY [OPTIONS...]

Records the scripts a deployed site serves, their V8 coverage, and what caused each load (docs/third-party.md).

  --url URL                  Page to open
  --out DIRECTORY            Output directory
  --wait-ms N                Wait after load (default 5000)
  --actions FILE             Module whose default export runs after load
  --scenario NAME            Write coverage/NAME.json and accumulate visits in --out
${browserOptions}`,
  modules: `Usage: coldpath modules --dir DIRECTORY --out MAP_DIRECTORY [OPTIONS...]

Recovers module boundaries from map-less webpack and Turbopack chunks as source maps (docs/third-party.md).

  --dir DIRECTORY            Scripts to read
  --out MAP_DIRECTORY        Directory for recovered maps and maps.json
  --maps-json FILE           Existing bindings, such as snapshot's maps.json; repeatable
  --chunks                   Turn a script without recognizable modules into one whole-chunk source
  --graph FILE               Also write a dependency graph`,
  label: `Usage: coldpath label --report report.json --out labels.json [OPTIONS...]

Asks a language model to label sources of a --details report. This sends code to the provider (docs/third-party.md).

  --report FILE              Report JSON written with --details
  --out FILE                 Labels JSON to write
  --mode identify|describe   Recovered sources only, or every source with content (default identify)
  --provider anthropic|openai
                             Model provider (default anthropic)
  --model NAME               Model (default claude-haiku-4-5 for anthropic; required for openai)
  --base-url URL             OpenAI-compatible server
  --top N                    Sources with the most unobserved bytes to label (default 50)
  --lang LANGUAGE            Language of summaries (default English)`,
}

const [command, ...rest] = process.argv.slice(2)

async function main() {
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(usage)
    return 0
  }
  if (Object.hasOwn(help, command) && (rest.includes('--help') || rest.includes('-h'))) {
    console.log(help[command])
    return 0
  }
  if (command === 'collect') {
    const {values} = parseArgs({
      args: rest,
      options: {
        scenarios: {type: 'string'},
        url: {type: 'string'},
        dir: {type: 'string'},
        out: {type: 'string'},
        prefix: {type: 'string'},
        scenario: {type: 'string'},
        actions: {type: 'string'},
        'wait-ms': {type: 'string'},
        'cdn-prefix': {type: 'string', multiple: true},
        'allow-origin': {type: 'string', multiple: true},
        device: {type: 'string'},
        viewport: {type: 'string'},
        'user-agent': {type: 'string'},
        'device-scale-factor': {type: 'string'},
        mobile: {type: 'boolean'},
        touch: {type: 'boolean'},
        'latency-ms': {type: 'string'},
        'download-kbps': {type: 'string'},
        'upload-kbps': {type: 'string'},
        'cpu-slowdown': {type: 'string'},
        'storage-state': {type: 'string'},
        header: {type: 'string', multiple: true},
        'browser-path': {type: 'string'},
        'browser-channel': {type: 'string'},
      },
    })
    if (values.scenarios) {
      const {scenarios} = await loadScenarios(values.scenarios)
      for (const scenario of scenarios) await collect(scenario)
      return 0
    }
    const number = (key: 'wait-ms' | 'device-scale-factor' | 'cpu-slowdown' | 'latency-ms' | 'download-kbps' | 'upload-kbps') =>
      values[key] === undefined ? undefined : Number(values[key])
    let viewport
    if (values.viewport) {
      const match = /^(\d+)x(\d+)$/.exec(values.viewport)
      if (!match) throw new Error('--viewport must be WIDTHxHEIGHT')
      viewport = {width: Number(match[1]), height: Number(match[2])}
    }
    const throttled = (['latency-ms', 'download-kbps', 'upload-kbps'] as const).some((key) => values[key] !== undefined)
    let extraHTTPHeaders: Record<string, string> | undefined
    for (const header of values.header ?? []) {
      const match = /^([^:\s]+):\s*(.*)$/.exec(header)
      if (!match) throw new Error(`--header must be 'NAME: VALUE': ${header}`)
      extraHTTPHeaders = {...extraHTTPHeaders, [match[1]]: match[2]}
    }
    await collect({
      url: values.url,
      dir: values.dir,
      out: values.out,
      prefix: values.prefix,
      scenario: values.scenario,
      actions: values.actions,
      waitMs: number('wait-ms'),
      cdnPrefixes: values['cdn-prefix'],
      allowOrigins: values['allow-origin'],
      device: values.device,
      viewport,
      userAgent: values['user-agent'],
      deviceScaleFactor: number('device-scale-factor'),
      isMobile: values.mobile,
      hasTouch: values.touch,
      cpuSlowdown: number('cpu-slowdown'),
      network: throttled
        ? ({latencyMs: number('latency-ms'), downloadKbps: number('download-kbps'), uploadKbps: number('upload-kbps')} as Network)
        : undefined,
      storageState: values['storage-state'],
      extraHTTPHeaders,
      browserPath: values['browser-path'],
      browserChannel: values['browser-channel'],
    })
    return 0
  }
  if (command === 'profile') {
    const {values} = parseArgs({args: rest, options: {scenarios: {type: 'string'}, runs: {type: 'string'}}})
    if (!values.scenarios) throw new Error('profile requires --scenarios FILE')
    const {scenarios} = await loadScenarios(values.scenarios)
    await profile(scenarios, values.runs === undefined ? {} : {runs: Number(values.runs)})
    return 0
  }
  if (command === 'graph') {
    const {values} = parseArgs({
      args: rest,
      options: {
        format: {type: 'string'},
        input: {type: 'string'},
        root: {type: 'string'},
        out: {type: 'string'},
        environment: {type: 'string'},
      },
    })
    await exportGraph(values)
    return 0
  }
  if (command === 'snapshot') {
    const {values} = parseArgs({
      args: rest,
      options: {
        url: {type: 'string'},
        out: {type: 'string'},
        'wait-ms': {type: 'string'},
        actions: {type: 'string'},
        scenario: {type: 'string'},
        'browser-path': {type: 'string'},
        'browser-channel': {type: 'string'},
      },
    })
    await snapshot({
      ...values,
      waitMs: values['wait-ms'] === undefined ? undefined : Number(values['wait-ms']),
      browserPath: values['browser-path'],
      browserChannel: values['browser-channel'],
    })
    return 0
  }
  if (command === 'modules') {
    const {values} = parseArgs({
      args: rest,
      options: {
        dir: {type: 'string'},
        out: {type: 'string'},
        'maps-json': {type: 'string', multiple: true},
        chunks: {type: 'boolean'},
        graph: {type: 'string'},
      },
    })
    await inferModules({...values, mapsJson: values['maps-json']})
    return 0
  }
  if (command === 'label') {
    const {values} = parseArgs({
      args: rest,
      options: {
        report: {type: 'string'},
        out: {type: 'string'},
        mode: {type: 'string'},
        provider: {type: 'string'},
        model: {type: 'string'},
        'base-url': {type: 'string'},
        top: {type: 'string'},
        lang: {type: 'string'},
      },
    })
    await label({...values, baseUrl: values['base-url']})
    return 0
  }
  const args = command === 'analyze' ? rest : [command, ...rest]
  // Each maps.json maps bundle paths to map files relative to itself; later files override earlier ones.
  const bindings: Record<string, string> = {}
  for (let at; (at = args.indexOf('--maps-json')) >= 0;) {
    const [, file] = args.splice(at, 2)
    for (const [bundle, map] of Object.entries(JSON.parse(await readFile(file, 'utf8'))))
      bindings[bundle] = resolve(dirname(file), map as string)
  }
  args.push(...Object.entries(bindings).flatMap(([bundle, map]) => ['--map', `${bundle}=${map}`]))
  const at = args.indexOf('--scenarios')
  if (at < 0) return runAnalyzer(args)
  const [, file] = args.splice(at, 2)
  const {dir, scenarios} = await loadScenarios(file)
  const names = scenarios.map((s) => s.scenario)
  return runAnalyzer([
    ...(args.includes('--dir') ? [] : ['--dir', dir]),
    ...scenarios.flatMap((s) => ['--coverage', s.out]),
    ...(args.includes('--scenario-order') ? [] : ['--scenario-order', names.join(',')]),
    ...(args.includes('--initial-scenario') ? [] : ['--initial-scenario', names[0]]),
    ...args,
  ])
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`coldpath: ${(error as Error).message}`)
  process.exitCode = 1
}
