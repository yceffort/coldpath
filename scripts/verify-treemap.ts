import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {chromium} from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'artifacts/treemap')
const input = join(output, 'input')
await mkdir(input, {recursive: true})
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const binary = join(root, 'target/debug/coldpath')
const source = ';'.repeat(80)
await writeFile(join(input, 'app.js'), source)
await writeFile(join(input, 'lazy.js'), ';'.repeat(10))
await writeFile(
  join(input, 'app.js.map'),
  JSON.stringify({
    version: 3,
    sections: Array.from({length: 40}, (_, i) => ({
      offset: {line: 0, column: i * 2},
      map: {
        version: 3,
        sources: [
          i < 30
            ? `src/${i % 2 ? 'features' : 'components'}/file${String(i).padStart(2, '0')}.ts`
            : `[project]/node_modules/@scope/pkg/file${i}.ts`,
        ],
        names: [],
        mappings: 'AAAA',
      },
    })),
  }),
)
const coverage = join(output, 'coverage.json')
await writeFile(coverage, JSON.stringify([{url: 'https://fixture.invalid/app.js', text: source, ranges: [{start: 0, end: 40}]}]))
const html = join(output, 'index.html')
execFileSync(
  binary,
  [join(input, '*.js'), '--dir', input, '--coverage', coverage, '--url-prefix', 'https://fixture.invalid/', '--treemap', html],
  {stdio: 'pipe'},
)
// Tiles directly inside the focus; nested tiles repeat their contents' bytes.
const top = '.tile[data-depth="0"]'
const browser = await chromium.launch({headless: true})
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}})
  const errors: string[] = [],
    requests: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url())
  })
  await page.goto(pathToFileURL(html).href)
  // Bundles without any recording are hidden until requested, and the summary says so.
  assert.equal(await page.locator('#rows tr').count(), 1)
  assert.match((await page.locator('#headline').textContent())!, /loaded 80 B of JavaScript\. 40 B \(50%\) of it never ran/)
  assert.match((await page.locator('#subline').textContent())!, /1 other files \(10 B\) were never loaded/)
  await page.getByRole('button', {name: 'Show them'}).click()
  await page.locator('#options summary').click()
  assert(await page.getByLabel('Show files not loaded in any recording').isChecked())
  assert.equal(await page.locator('#rows tr').count(), 2)
  assert.equal(await page.locator(top).count(), 2)
  assert.equal(await page.locator(top).evaluateAll((tiles) => tiles.reduce((sum, tile) => sum + Number(tile.dataset.bytes), 0)), 90)
  // Bundles with room show their folders inside; selecting a nested box zooms straight to it.
  assert.deepEqual(await page.locator('.tile.group[data-depth="0"]').evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), [
    'app.js, 80 bytes',
    'lazy.js, 10 bytes',
  ])
  assert.equal(await page.locator('.tile[data-depth="1"]').first().getAttribute('tabindex'), '-1')
  await page.locator('.tile.group[data-depth="1"][aria-label^="src,"]').click({position: {x: 16, y: 10}})
  assert.equal(await page.locator('#scope').textContent(), 'src')
  assert.equal(await page.locator('#treemap .layer').count(), 1)
  await page.getByRole('button', {name: 'All bundles', exact: true}).click()
  assert.deepEqual(await page.locator('#stats strong').allTextContents(), ['90 B', '40 B', '40 B', '10 B'])
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByRole('button', {name: 'src', exact: true}).click()
  await page.getByRole('button', {name: 'components', exact: true}).click()
  assert.equal(await page.locator('#rows tr').count(), 15)
  assert.equal(await page.locator(top).count(), 15, 'small files must remain reachable')
  await page.getByRole('button', {name: 'file00.ts', exact: true}).focus()
  await page.keyboard.press('Enter')
  assert.match((await page.locator('#file').textContent())!, /src\/components\/file00.ts/)
  // The browser's back button walks back up the zoom levels, then leaves the report.
  await page.goBack()
  assert.equal(await page.locator('#scope').textContent(), 'components')
  await page.goBack()
  await page.goBack()
  assert.equal(await page.locator('#scope').textContent(), 'app.js')
  await page.goForward()
  assert.equal(await page.locator('#scope').textContent(), 'src')
  await page.getByRole('button', {name: 'All bundles', exact: true}).click()
  await page.getByRole('searchbox').fill('file00')
  assert.equal(await page.locator('#rows tr').count(), 1)
  assert.equal(await page.locator(top).getAttribute('data-bytes'), '2')
  await page.getByRole('searchbox').fill('not-found')
  assert(await page.locator('#empty').isVisible())
  await page.getByRole('searchbox').fill('')
  await page.getByLabel('Mapped only', {exact: true}).check()
  assert.equal(await page.locator('#rows tr').count(), 1)
  assert.equal(await page.locator(top).getAttribute('data-bytes'), '80')
  assert.deepEqual(await page.locator('#stats strong').allTextContents(), ['90 B', '40 B', '40 B', '10 B'])
  await page.getByLabel('Mapped only', {exact: true}).uncheck()
  await page.getByLabel('Group sources').selectOption('package')
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  assert.equal(await page.locator('#rows tr').count(), 2)
  await page.getByRole('button', {name: '@scope/pkg', exact: true}).click()
  assert.equal(await page.locator('#rows tr').count(), 10)
  await page.getByRole('button', {name: 'All bundles', exact: true}).click()
  await page.screenshot({path: join(output, 'desktop.png'), fullPage: true})
  await page.setViewportSize({width: 390, height: 844})
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({path: join(output, 'mobile.png'), fullPage: true})
  await page.emulateMedia({colorScheme: 'dark'})
  await page.screenshot({path: join(output, 'dark.png'), fullPage: true})

  // One source shipped in two bundles: JSON counts the copies, and the treemap lists the extra bytes.
  const shared = join(output, 'shared')
  await mkdir(shared, {recursive: true})
  for (const [name, length] of [
    ['a.js', 30],
    ['b.js', 20],
  ] as [string, number][]) {
    await writeFile(join(shared, name), ';'.repeat(length))
    await writeFile(join(shared, name + '.map'), JSON.stringify({version: 3, sources: ['src/shared.ts'], names: [], mappings: 'AAAA'}))
  }
  const sharedJson = join(output, 'shared.json'),
    sharedHtml = join(output, 'shared.html')
  execFileSync(binary, ['--dir', shared, '--json', sharedJson, '--treemap', sharedHtml], {stdio: 'pipe'})
  const sharedReport = JSON.parse(await readFile(sharedJson, 'utf8'))
  assert.deepEqual(sharedReport.sources.find((row: any) => row.source.endsWith('src/shared.ts')).duplicates, {bundles: 2, extraBytes: 20})
  assert.equal(sharedReport.totals.bytes, 50, 'duplicates do not change totals')
  await page.setViewportSize({width: 1440, height: 1000})
  await page.goto(pathToFileURL(sharedHtml).href)
  assert(await page.locator('#duplicate-finding').isVisible())
  assert.match((await page.locator('#duplicate-list').textContent())!, /shared\.ts.*20 B extra.*2 copies, 50 B in total/)
  await page.goto(pathToFileURL(html).href)
  assert(await page.locator('#duplicate-finding').isHidden(), 'no finding without duplicates')

  // Source-map names are data even when they contain a script closing tag.
  const hostile = '</script><script>globalThis.injected=true</script>'
  await writeFile(join(input, 'app.js.map'), JSON.stringify({version: 3, sources: [hostile], names: [], mappings: 'AAAA'}))
  const hostileHtml = join(output, 'hostile.html')
  execFileSync(binary, [join(input, 'app.js'), '--treemap', hostileHtml], {stdio: 'pipe'})
  assert(!(await readFile(hostileHtml, 'utf8')).includes(hostile))
  await page.goto(pathToFileURL(hostileHtml).href)
  assert.equal(await page.evaluate(() => globalThis.injected), undefined)
  assert.equal(await page.locator('#rows tr').count(), 1)
  assert.deepEqual(errors, [])
  assert.deepEqual(requests, [])
  console.log(
    'Verified offline nested zoomable treemap, all 15 small entries, exact area totals, coverage states, keyboard navigation, search, package grouping, mapped filter, mobile layout and hostile source names.',
  )
} finally {
  await browser.close()
}
