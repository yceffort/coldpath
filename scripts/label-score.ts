// Scores `coldpath label` identity guesses against the package each recovered module came from.
// Package identity is exact: scoped names are kept whole, and a different name counts only through an explicit alias.
// Application feature names have no reference to check against, so they stay unscored.
import {readFile} from 'node:fs/promises'
import {globSync} from 'node:fs'
import {join} from 'node:path'
import {AnyMap, eachMapping} from '@jridgewell/trace-mapping'
import {readMap} from '../lib/maps.ts'
import {chunkModules} from '../lib/modules.ts'

export const APPLICATION = '[application]'
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

// Packages that ship copies of other packages inside themselves. Each entry is explicit and documented.
const VENDORED = [
  // Next.js precompiles dependencies such as path-to-regexp and process into next/dist/compiled/<package>.
  /node_modules\/next\/dist\/compiled\/((?:@[^/]+\/)?[^/]+)\//,
]

// The package that owns an original source path: a vendored copy's own package, else the last node_modules segment,
// so pnpm's .pnpm store resolves.
export function packageOf(source: string) {
  for (const pattern of VENDORED) {
    const vendored = source.match(pattern)?.[1]
    if (vendored) return vendored
  }
  const match = [...source.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].at(-1)?.[1]
  return match && match !== '.pnpm' ? match : APPLICATION
}

// The npm package a label names, or null. `react-dom/client` names react-dom; `@scope/pkg/sub` names @scope/pkg.
export function guessedPackage(name: string) {
  const token = name.trim().split(/[\s(]/)[0].toLowerCase()
  const parts = token.split('/')
  const candidate = token.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return NPM_NAME.test(candidate) && (!token.startsWith('@') || parts.length > 1) ? candidate : null
}

const PACKAGE_KINDS = new Set(['package', 'polyfill'])

type Label = {name?: string; kind?: string; summary?: string}
type ScoreRow = {
  source: string
  owner: string
  name: string
  kind: string
  guess: string | null
  classified: boolean
  identity: boolean | null
}

// `truth`: Map of recovered source -> owning package, APPLICATION, or null when the module mixes owners.
// `aliases`: {guessed name: owning package} for documented vendor or rename relationships only.
export function score(truth: Map<string, string | null>, labels: Record<string, Label>, aliases: Record<string, string> = {}) {
  const result = {
    modules: 0,
    mixed: 0,
    withoutGuess: 0,
    classification: {correct: 0, total: 0},
    packageIdentity: {correct: 0, total: 0},
    applicationFeatureUnscored: 0,
    rows: [] as ScoreRow[],
  }
  for (const [source, label] of Object.entries(labels)) {
    if (!truth.has(source)) continue
    result.modules++
    const owner = truth.get(source) as string | null
    if (owner === null) {
      result.mixed++
      continue
    }
    if (!label.name || !label.kind) {
      result.withoutGuess++
      continue
    }
    const guess = guessedPackage(label.name)
    const resolved = guess && (aliases[guess] ?? guess)
    const classified = (owner !== APPLICATION) === PACKAGE_KINDS.has(label.kind)
    result.classification.total++
    if (classified) result.classification.correct++
    let identity = null
    if (owner === APPLICATION) result.applicationFeatureUnscored++
    else {
      identity = resolved === owner
      result.packageIdentity.total++
      if (identity) result.packageIdentity.correct++
    }
    result.rows.push({source, owner, name: label.name, kind: label.kind, guess: resolved, classified, identity})
  }
  return result
}

// For each module recovered from a build that has source maps: the owners of the mapping segments that start inside it.
export async function moduleOwners(dir: string) {
  const owners = new Map<string, Set<string>>()
  for (const path of globSync('**/*.js', {cwd: dir})) {
    const filename = join(dir, path)
    const code = await readFile(filename, 'utf8')
    const found = chunkModules(code)
    const mapText = found?.modules.length && (await readMap(filename, code, dir))
    if (!mapText) continue
    const lineStarts = [0]
    for (const match of code.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) lineStarts.push(match.index + match[0].length)
    const segments: [number, string][] = []
    eachMapping(AnyMap(JSON.parse(mapText as unknown as string)), ({generatedLine, generatedColumn, source}) => {
      if (source) segments.push([lineStarts[generatedLine - 1] + generatedColumn, source])
    })
    const global = found.global ?? `runtime/${path}`
    for (const {id, start, end} of found.modules) {
      const name = `webpack://inferred/${global}/${id}.js`
      const set = owners.get(name) ?? new Set()
      for (const [offset, source] of segments) {
        if (offset >= start && offset < end && !/webpack\/runtime|\[turbopack\]/.test(source)) set.add(packageOf(source))
      }
      owners.set(name, set)
    }
  }
  return new Map([...owners].map(([name, set]) => [name, set.size === 1 ? [...set][0] : null]))
}
