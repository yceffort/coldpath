import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const slashRegex = '/' + String.fromCharCode(92) + '//g'
const cases = {
  'regex-template': "const label = `${'a/b'.replace(" + slashRegex + ", '-')}`; globalThis.never = () => { throw Error('never'); };",
  'regex-plain': "const label = 'a/b'.replace(" + slashRegex + ", '-'); globalThis.never = () => { throw Error('never'); };",
  'regex-control': "const label = `${'a/b'.replaceAll('/', '-')}`; globalThis.never = () => { throw Error('never'); };",
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
let source: string
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/app.js' ? 'text/javascript' : 'text/html')
  response.end(request.url === '/app.js' ? source : '<!doctype html><script src="/app.js"></script>')
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({headless: true})
try {
  for (const [name, text] of Object.entries(cases)) {
    source = text
    const dir = join(root, 'artifacts/comparison/repros', name)
    await mkdir(dir, {recursive: true})
    const map = JSON.stringify({
      version: 3,
      sources: ['original.js'],
      sourcesContent: [source],
      names: [],
      mappings: 'AAAA',
    })
    await writeFile(join(dir, 'app.js'), source)
    await writeFile(join(dir, 'app.js.map'), map)
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.coverage.startJSCoverage()
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    assert.equal(await page.evaluate(() => typeof globalThis.never), 'function')
    const records = await page.coverage.stopJSCoverage()
    assert.deepEqual(errors, [])
    const record = records.find((row) => row.url.endsWith('/app.js'))
    assert.equal(record!.source, source)
    await writeFile(
      join(dir, 'initial.coverage.json'),
      JSON.stringify({
        schemaVersion: 1,
        scenario: name,
        environment: {browser: browser.version(), node: process.version},
        scripts: [
          {
            path: 'app.js',
            sha256: hash(source),
            sourceMapSha256: hash(map),
            functions: record!.functions,
          },
        ],
      }) + '\n',
    )
    await page.close()
    execFileSync(process.execPath, [join(root, 'benchmarks/prepare.ts'), '--dir', dir, '--name', name], {stdio: 'inherit'})
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
