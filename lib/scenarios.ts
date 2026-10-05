import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import type {CaptureOptions} from './collect.ts'

export type Scenario = CaptureOptions & {scenario: string; out: string; profileOut: string}

// Paths in the file are relative to the file; scenario URLs resolve against `url`.
export async function loadScenarios(file: string): Promise<{dir: string; scenarios: Scenario[]}> {
  const config = JSON.parse(await readFile(file, 'utf8'))
  const base = dirname(resolve(file))
  assert(config.dir, `${file}: "dir" is required`)
  assert(Array.isArray(config.scenarios) && config.scenarios.length, `${file}: "scenarios" must be a nonempty array`)
  const names = new Set()
  const out = resolve(base, config.out ?? 'coldpath-coverage')
  const scenarios = config.scenarios.map((scenario: any) => {
    assert(
      typeof scenario.name === 'string' && /^[\w.-]+$/.test(scenario.name),
      `${file}: invalid scenario name ${JSON.stringify(scenario.name)}`,
    )
    assert(!names.has(scenario.name), `${file}: duplicate scenario ${scenario.name}`)
    names.add(scenario.name)
    const url = scenario.url ?? config.url
    assert(url, `${file}: scenario ${scenario.name} needs "url" (or a top-level "url")`)
    const option = (key: string) => scenario[key] ?? config[key]
    const storageState = option('storageState')
    return {
      device: option('device'),
      viewport: option('viewport'),
      userAgent: option('userAgent'),
      deviceScaleFactor: option('deviceScaleFactor'),
      isMobile: option('isMobile'),
      hasTouch: option('hasTouch'),
      network: option('network'),
      cpuSlowdown: option('cpuSlowdown'),
      cdnPrefixes: option('cdnPrefixes'),
      allowOrigins: option('allowOrigins'),
      storageState: storageState && resolve(base, storageState),
      url: config.url ? new URL(url, config.url).href : url,
      dir: resolve(base, config.dir),
      prefix: scenario.prefix ?? config.prefix,
      waitMs: scenario.waitMs ?? config.waitMs,
      scenario: scenario.name,
      actions: scenario.actions && resolve(base, scenario.actions),
      out: join(out, `${scenario.name}.coverage.json`),
      profileOut: join(out, `${scenario.name}.profile.json`),
    }
  })
  return {dir: resolve(base, config.dir), scenarios}
}
