import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {chromium} from '@playwright/test'
import type {Page} from '@playwright/test'

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
// Tiles with a label line that runs past their right or bottom edge. Each line is drawn only when it fits.
const overflowing = (page: Page) =>
  page.locator('#treemap .tile').evaluateAll((tiles) =>
    tiles
      .filter((tile) => {
        const edge = tile.getBoundingClientRect()
        return [...tile.querySelectorAll('span')].some((line) => {
          const box = line.getBoundingClientRect()
          return box.right > edge.right + 0.5 || box.bottom > edge.bottom + 0.5
        })
      })
      .map((tile) => tile.ariaLabel),
  )
const browser = await chromium.launch({headless: true})
try {
  // Without motion a view's tiles are the only tiles on the page. The zoom motion is checked on its own below.
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'})
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
  // Bundles with room and more than one entry show their contents inside, one level deep; selecting a nested tile zooms
  // straight to it.
  assert.deepEqual(await page.locator('.tile.group[data-depth="0"]').evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), [
    'app.js, 80 bytes',
  ])
  assert.equal(await page.locator('.tile.group[data-depth="1"], .tile[data-depth="2"]').count(), 0)
  assert.equal(await page.locator('.tile[data-depth="1"]').first().getAttribute('tabindex'), '-1')
  await page.locator('.tile[data-depth="1"][aria-label^="src,"]').click()
  assert.equal(await page.locator('#scope').textContent(), 'src')
  await page.getByRole('button', {name: 'All bundles', exact: true}).click()
  // The Area switch sizes tiles by the bytes that never ran, so lazy.js, which no recording measured, leaves the map.
  await page.getByRole('button', {name: 'Never-ran bytes'}).click()
  assert.equal(await page.getByRole('button', {name: 'Never-ran bytes'}).getAttribute('aria-pressed'), 'true')
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), ['app.js, 80 bytes'])
  assert.match((await page.locator('.tile.group').textContent())!, /^app\.js40 B never ran$/)
  await page.getByRole('button', {name: 'Loaded bytes'}).click()
  assert.equal(await page.locator(top).count(), 2)
  assert.deepEqual(await page.locator('#stats strong').allTextContents(), ['90 B', '40 B', '40 B', '10 B'])
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByRole('button', {name: 'src', exact: true}).click()
  await page.getByRole('button', {name: 'components', exact: true}).click()
  assert.equal(await page.locator('#rows tr').count(), 15)
  assert.equal(await page.locator(top).count(), 15, 'small files must remain reachable')
  // The panel beside the map shows the view's totals and its files with the most code that never ran, and the numbers of
  // a tile while it is pointed at or focused. Tiles have no native tooltip.
  assert.equal(await page.locator('.tile[title]').count(), 0)
  const panel = page.locator('#tile-panel')
  assert.match((await panel.textContent())!, /^This viewcomponents30 B 33% never ran.*Most code that never ranfile20\.ts2 B/)
  await page.locator(top).first().hover()
  assert.match((await panel.textContent())!, /^file00\.tssrc\/components\/file00\.ts2 B 0% never ranObserved2 B100%Select to see details$/)
  await page.mouse.move(0, 0)
  assert.match((await panel.textContent())!, /^This viewcomponents/)
  await page.locator(top).last().focus()
  assert.match((await panel.textContent())!, /^file\d\d\.ts/)
  await page.getByRole('button', {name: 'Never-ran bytes'}).click()
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => tile.dataset.bytes)), ['2', '2', '2', '2', '2'])
  await page.getByRole('button', {name: 'Loaded bytes'}).click()
  await panel.getByRole('button').first().click()
  assert.equal(await page.locator('#scope').textContent(), 'file20.ts')
  await page.goBack()
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
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({path: join(output, 'desktop.png'), fullPage: true})
  assert.deepEqual(await overflowing(page), [])
  await page.setViewportSize({width: 390, height: 844})
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.deepEqual(await overflowing(page), [])
  await page.screenshot({path: join(output, 'mobile.png'), fullPage: true})
  await page.emulateMedia({colorScheme: 'dark'})
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({path: join(output, 'dark.png'), fullPage: true})
  // On a touch screen one tap zooms in, and the panel below the map shows the numbers.
  const touch = await browser.newPage({viewport: {width: 390, height: 844}, hasTouch: true, reducedMotion: 'reduce'})
  touch.on('pageerror', (error) => errors.push(error.message))
  await touch.goto(pathToFileURL(html).href)
  await touch.locator(top).first().tap()
  assert.equal(await touch.locator('#scope').textContent(), 'app.js')
  assert.match((await touch.locator('#tile-panel').textContent())!, /^This viewapp\.js80 B 50% never ran/)
  assert((await touch.locator('#tile-panel').boundingBox())!.y >= (await touch.locator('#treemap').boundingBox())!.y + 380)
  await touch.close()
  // At 800 by 700 px the nested files get one- and two-line labels, and none may run past its tile.
  const narrow = await browser.newPage({viewport: {width: 800, height: 700}})
  narrow.on('pageerror', (error) => errors.push(error.message))
  await narrow.goto(pathToFileURL(html).href)
  assert((await narrow.locator('.tile[data-depth="1"] span').count()) > 0)
  assert.deepEqual(await overflowing(narrow), [])
  await narrow.close()

  // Zooming in grows the selected tile while the old view moves outward and fades; labels wait for the motion to end, and
  // the old view is removed after it. Zooming out shrinks the view back into its tile, drawn over the new view.
  const motion = await browser.newPage({viewport: {width: 1440, height: 1000}})
  motion.on('pageerror', (error) => errors.push(error.message))
  await motion.goto(pathToFileURL(html).href)
  await motion.locator('.tile[data-depth="1"][aria-label^="src,"]').click()
  await motion.locator('#treemap .layer.leaving').waitFor()
  assert.equal(
    await motion
      .locator('#treemap .layer.entering .tile span')
      .first()
      .evaluate((label) => getComputedStyle(label).opacity),
    '0',
  )
  await motion.locator('#treemap .layer.leaving').waitFor({state: 'detached'})
  assert.equal(await motion.locator('#treemap .layer').count(), 1)
  assert.equal(await motion.locator('#treemap .layer.entering').count(), 0)
  await motion.goBack()
  assert.match((await motion.locator('#treemap > .layer').last().getAttribute('class'))!, /\bleaving\b/)
  await motion.locator('#treemap .layer.leaving').waitFor({state: 'detached'})
  assert.equal(await motion.locator('#scope').textContent(), 'All bundles')
  await motion.emulateMedia({reducedMotion: 'reduce'})
  await motion.locator('.tile[data-depth="1"][aria-label^="src,"]').click()
  assert.equal(await motion.locator('#treemap .layer').count(), 1)
  await motion.close()

  // Children too small to see are merged into one tile, which zooms to a view of just them; back leaves that view.
  const many = join(output, 'many')
  await mkdir(many, {recursive: true})
  await writeFile(join(many, 'big.js'), ';'.repeat(2200))
  await writeFile(
    join(many, 'big.js.map'),
    JSON.stringify({
      version: 3,
      sections: Array.from({length: 101}, (_, i) => ({
        offset: {line: 0, column: i && 1998 + i * 2},
        map: {version: 3, sources: [i ? `src/t${String(i).padStart(3, '0')}.ts` : 'src/main.ts'], names: [], mappings: 'AAAA'},
      })),
    }),
  )
  const manyHtml = join(output, 'many.html')
  execFileSync(binary, ['--dir', many, '--treemap', manyHtml], {stdio: 'pipe'})
  await page.setViewportSize({width: 1440, height: 1000})
  await page.emulateMedia({colorScheme: 'light'})
  await page.goto(pathToFileURL(manyHtml).href)
  await page.getByRole('button', {name: 'big.js', exact: true}).click()
  assert.equal(await page.locator('.tile[data-kind="more"][data-depth="1"]').getAttribute('aria-label'), '100 smaller items, 200 bytes')
  await page.getByRole('button', {name: 'src', exact: true}).click()
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), [
    'main.ts, 2,000 bytes',
    '100 smaller items, 200 bytes',
  ])
  await page.locator('.tile[data-kind="more"]').hover()
  assert.equal(await page.locator('#tile-panel').textContent(), '100 smaller items200 B not measuredUnmeasured200 B100%Select to zoom in')
  await page.locator('.tile[data-kind="more"]').click()
  assert.equal(await page.locator('#scope').textContent(), '100 smaller items')
  assert.equal(await page.locator('#rows tr').count(), 100)
  assert.equal(await page.locator(top).count(), 100)
  await page.mouse.move(0, 0)
  assert.equal(await page.locator('#tile-panel h3').textContent(), '100 smaller items')
  assert.deepEqual(await overflowing(page), [])
  await page.goBack()
  assert.equal(await page.locator('#scope').textContent(), 'src')
  assert.equal(await page.locator(top).count(), 2)
  await page.goForward()
  assert.equal(await page.locator('#scope').textContent(), '100 smaller items')
  await page.getByRole('button', {name: 'src', exact: true}).click()
  assert.equal(await page.locator(top).count(), 2)

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
    'Verified offline zoomable treemap one level deep, all 15 small entries, merged small tiles, the Area switch, exact area totals, coverage states, keyboard navigation, the details panel on hover, focus and touch, labels that fit their tiles, zoom motion, search, package grouping, mapped filter, mobile layout and hostile source names.',
  )
} finally {
  await browser.close()
}
