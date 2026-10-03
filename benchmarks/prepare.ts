import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, readFile, readdir, writeFile, copyFile} from 'node:fs/promises'
import {dirname, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const {values} = parseArgs({
  options: {
    dir: {type: 'string', default: join(root, 'examples/recorded')},
    coverage: {type: 'string', multiple: true},
    name: {type: 'string', default: 'recorded'},
    measured: {type: 'boolean', default: false},
    mapped: {type: 'boolean', default: false},
  },
})
assert(/^[a-z0-9-]+$/.test(values.name))
const input = resolve(values.dir)
const captures = await Promise.all(
  (values.coverage ?? [join(input, 'initial.coverage.json')]).map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
)
const output = join(root, 'artifacts/comparison/inputs', values.name)
const files = join(output, 'files')
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const all = (await readdir(input, {recursive: true, withFileTypes: true}))
  .filter((entry) => entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name))
  .map((entry) => relative(input, join(entry.parentPath, entry.name)))
  .sort()
const observations = new Map()
for (const capture of captures)
  for (const script of capture.scripts) {
    const list = observations.get(script.path) ?? []
    list.push(script)
    observations.set(script.path, list)
  }
const rows = [],
  chrome = [],
  playwright = []
for (const path of all) {
  const records = observations.get(path) ?? []
  if (values.measured && !records.length) continue
  const source = await readFile(join(input, path), 'utf8')
  const annotation = source
    .trimEnd()
    .split('\n')
    .at(-1)!
    .match(/^\/\/[#@]\s*sourceMappingURL=(.+)$/)?.[1]
  let mapPath: string | null = annotation ? relative(input, resolve(input, dirname(path), annotation)) : `${path}.map`
  let map: Buffer | undefined
  try {
    map = await readFile(join(input, mapPath))
  } catch (error) {
    if (annotation || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mapPath = null
  }
  if (values.mapped && !map) continue
  for (const record of records) {
    assert.equal(record.sha256, sha(source), path + ': source hash')
    assert.equal(record.sourceMapSha256, map ? sha(map) : null, path + ': map hash')
  }
  await mkdir(dirname(join(files, path)), {recursive: true})
  await copyFile(join(input, path), join(files, path))
  if (map) {
    await mkdir(dirname(join(files, mapPath!)), {recursive: true})
    await writeFile(join(files, mapPath!), map)
  }
  // Independent point-by-point oracle, not coldpath's interval sweep.
  const used = new Uint8Array(source.length)
  for (const record of records) {
    const points = new Uint8Array(source.length)
    for (const range of record.functions
      .flatMap((fn: any) => fn.ranges)
      .toSorted((a: any, b: any) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset))) {
      points.fill(range.count > 0 ? 1 : 0, range.startOffset, range.endOffset)
    }
    for (let i = 0; i < used.length; i++) used[i] |= points[i]
    playwright.push({
      url: `https://comparison.invalid/${path}`,
      source,
      functions: record.functions,
    })
  }
  let observedBytes = 0,
    unit = 0
  for (const char of source) {
    if (char.length === 2) assert.equal(used[unit], used[unit + 1], 'split surrogate')
    if (used[unit]) observedBytes += Buffer.byteLength(char)
    unit += char.length
  }
  const ranges = []
  for (let i = 0; i < used.length;) {
    if (!used[i]) {
      i++
      continue
    }
    const start = i
    while (i < used.length && used[i]) i++
    ranges.push({start, end: i})
  }
  if (records.length) chrome.push({url: `https://comparison.invalid/${path}`, text: source, ranges})
  rows.push({
    path,
    sha256: sha(source),
    bytes: Buffer.byteLength(source),
    utf16Units: source.length,
    mapPath,
    mapSha256: map ? sha(map) : null,
    mapBytes: map?.length ?? 0,
    measured: !!records.length,
    observedBytes: records.length ? observedBytes : null,
    observedUtf16Units: records.length ? used.reduce((a, b) => a + b, 0) : null,
  })
}
const totals = rows.reduce(
  (a, r) => ({
    bytes: a.bytes + r.bytes,
    utf16Units: a.utf16Units + r.utf16Units,
    observedBytes: a.observedBytes + (r.observedBytes ?? 0),
    unobservedBytes: a.unobservedBytes + (r.measured ? r.bytes - r.observedBytes! : 0),
    unmeasuredBytes: a.unmeasuredBytes + (r.measured ? 0 : r.bytes),
    observedUtf16Units: a.observedUtf16Units + (r.observedUtf16Units ?? 0),
  }),
  {
    bytes: 0,
    utf16Units: 0,
    observedBytes: 0,
    unobservedBytes: 0,
    unmeasuredBytes: 0,
    observedUtf16Units: 0,
  },
)
for (const [name, data] of Object.entries({
  'manifest.json': {name: values.name, totals, bundles: rows},
  'chrome.json': chrome,
  'playwright.json': playwright,
  'envelope.json': {
    schemaVersion: 1,
    scenario: values.name,
    scripts: captures.flatMap((c) => c.scripts),
  },
}))
  await writeFile(join(output, name), JSON.stringify(data) + '\n')
console.log(JSON.stringify({output, bundles: rows.length, totals}))
