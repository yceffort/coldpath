import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const base = 'artifacts/comparison'
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const datasets =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ['recorded', 'recorded-union', 'blog-measured', 'blog-all', 'regex-template', 'regex-plain', 'regex-control']
const results = []
for (const name of datasets) {
  const input = join(base, 'inputs', name)
  const manifest = await read(join(input, 'manifest.json'))
  const output = join(base, 'evaluation', name)
  await mkdir(output, {recursive: true})
  const reportPath = join(output, 'coldpath.json')
  execFileSync(
    'target/release/coldpath',
    [
      '--dir',
      join(input, 'files'),
      '--coverage',
      join(input, 'playwright.json'),
      '--url-prefix',
      'https://comparison.invalid/',
      '--json',
      reportPath,
    ],
    {stdio: 'pipe'},
  )
  const rust = await read(reportPath)
  for (const key of ['bytes', 'observedBytes', 'unobservedBytes', 'unmeasuredBytes'])
    assert.equal(rust.totals[key], manifest.totals[key], name + ': ' + key)
  for (const bundle of rust.bundles) {
    const expected = manifest.bundles.find((row: any) => row.path === bundle.path)
    if (expected.measured) assert.equal(bundle.observedUtf16Units, expected.observedUtf16Units)
  }
  const result = {
    dataset: name,
    bundles: manifest.bundles.length,
    oracle: manifest.totals,
    coldpath: {
      totals: rust.totals,
      warnings: rust.warnings.length,
      oracleMatch: true,
      mappedObservedBytes: rust.sources
        .filter((row: any) => row.source !== '[unmapped]')
        .reduce((n: number, row: any) => n + row.observedBytes, 0),
    },
    sourceMapExplorer: {} as Record<string, unknown>,
    monocart: {} as Record<string, unknown>,
  }
  const run = async (tool: string, policy: string) => {
    const directory = join(output, `${tool}-${policy}`)
    const child = spawnSync(process.execPath, ['benchmarks/run-tool.ts', tool, input, directory, 'json', policy], {
      encoding: 'utf8',
      env: {...process.env, COMPARISON_DIAGNOSTICS: '1'},
    })
    await writeFile(join(directory, 'process.log'), child.stdout + child.stderr)
    return {exitCode: child.status, data: await read(join(directory, 'summary.json'))}
  }
  for (const policy of ['default', 'relaxed']) {
    const {exitCode, data} = await run('sme', policy)
    result.sourceMapExplorer[policy] = {
      exitCode,
      bundles: data.bundles,
      expectedBundles: data.expectedBundles,
      fatalErrors: data.errors
        .filter((row: any) => !row.isWarning)
        .map(({code, message}: {code: string; message: string}) => ({code, message})),
      warnings: data.errors.filter((row: any) => row.isWarning).length,
      totalBytes: data.rows.reduce((n: number, row: any) => n + row.totalBytes, 0),
      mappedBytes: data.rows.reduce((n: number, row: any) => n + row.mappedBytes, 0),
      mappedCoveredBytes: data.rows.reduce(
        (n: number, row: any) => n + Object.values<{coveredSize?: number}>(row.files).reduce((n, f) => n + (f.coveredSize ?? 0), 0),
        0,
      ),
    }
  }
  for (const policy of ['default', 'generated']) {
    const {exitCode, data} = await run('monocart', policy)
    assert.equal(exitCode, 0)
    result.monocart[policy] = {exitCode, files: data.fileCount, summary: data.summary}
  }
  results.push(result)
  console.log(name + ': native totals/UTF-16 oracle verified; comparator outcomes recorded')
}
// Isolate the observed range loss using the installed dependency, without patches.
const require = createRequire(import.meta.url)
const mcrRequire = createRequire(require.resolve('monocart-coverage-reports'))
const {Locator} = mcrRequire('monocart-locator')
const util = mcrRequire('./utils/util.js')
const repro = await read(join(base, 'inputs/regex-template/playwright.json'))
const entry = repro[0]
const range = entry.functions.flatMap((fn: any) => fn.ranges).find((range: any) => range.count === 0)
const locator = new Locator(entry.source)
const diagnosis = {
  dependencyVersion: mcrRequire('monocart-locator/package.json').version,
  source: entry.source,
  nativeUncalledRange: range,
  detectedComments: locator.lineParser.commentParser.comments,
  adjustedRange: util.fixSourceRange(locator, range.startOffset, range.endOffset),
}
assert(diagnosis.adjustedRange.fixedStart > diagnosis.adjustedRange.fixedEnd)
await mkdir('benchmarks/results', {recursive: true})
await writeFile('benchmarks/results/correctness.json', JSON.stringify({datasets: results, regression: diagnosis}, null, 2) + '\n')
