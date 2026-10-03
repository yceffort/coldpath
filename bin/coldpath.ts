#!/usr/bin/env node
import {readFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {parseArgs} from 'node:util'
import {runAnalyzer} from '../lib/analyzer.ts'
import {collect} from '../lib/collect.ts'
import {exportGraph} from '../lib/export-graph.ts'
import {label} from '../lib/label.ts'
import {inferModules} from '../lib/modules.ts'
import {profile} from '../lib/profile.ts'
import {loadScenarios} from '../lib/scenarios.ts'
import {snapshot} from '../lib/snapshot.ts'
import type {Network} from '../lib/collect.ts'

const usage = `Usage:
  coldpath collect --scenarios coldpath.scenarios.json
  coldpath collect --url URL --dir DIRECTORY --out FILE [--prefix PATH] [--scenario NAME] [--actions FILE] [--wait-ms N]
                   [--cdn-prefix URL]... [--device NAME] [--viewport WxH] [--user-agent UA] [--device-scale-factor N] [--mobile] [--touch]
                   [--latency-ms N --download-kbps N --upload-kbps N] [--cpu-slowdown N] [--storage-state FILE]
  coldpath profile --scenarios coldpath.scenarios.json [--runs N]
  coldpath graph --format esbuild|webpack|turbopack --input FILE --root BUILD_ROOT --out graph.json [--environment client|server|all]
  coldpath snapshot --url URL --out DIRECTORY [--wait-ms N] [--actions FILE] [--scenario NAME]
  coldpath modules --dir DIRECTORY --out MAP_DIRECTORY [--maps-json maps.json]... [--chunks] [--graph FILE]
  coldpath label --report report.json --out labels.json [--mode identify|describe] [--provider anthropic|openai]
                 [--model NAME] [--base-url URL] [--top N] [--lang LANGUAGE]
  coldpath analyze [--scenarios coldpath.scenarios.json] [--maps-json maps.json]... [ANALYZER OPTIONS...] [--export DIRECTORY]
  coldpath --replay DIRECTORY [--json FILE] [--html FILE]
  coldpath [ANALYZER OPTIONS...]

Run \`coldpath analyze --help\` for analyzer options. See docs/collecting.md, docs/cpu.md, docs/graphs.md and docs/third-party.md.`

const [command, ...rest] = process.argv.slice(2)

async function main() {
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(usage)
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
    await collect({
      url: values.url,
      dir: values.dir,
      out: values.out,
      prefix: values.prefix,
      scenario: values.scenario,
      actions: values.actions,
      waitMs: number('wait-ms'),
      cdnPrefixes: values['cdn-prefix'],
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
      },
    })
    await snapshot({...values, waitMs: values['wait-ms'] === undefined ? undefined : Number(values['wait-ms'])})
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
