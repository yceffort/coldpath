import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
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
const server = createServer((request, response) => {
  if (request.url === '/assets/entry.js') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8')
    response.end(servedSource)
  } else if (request.url === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><meta charset="utf-8"><script src="/assets/entry.js"></script>')
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
    await run(process.execPath, [
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
console.log('Verified standalone collector, custom actions, source/map evidence, and stale-source rejection.')
