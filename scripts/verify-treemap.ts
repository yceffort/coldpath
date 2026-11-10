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
// The element with keyboard focus: its id, or a tile's name, or BODY when focus was lost.
const focused = (page: Page) =>
  page.evaluate(() => document.activeElement!.id || document.activeElement!.ariaLabel || document.activeElement!.tagName)
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
  // Bundles with room and more than one entry show their contents inside, one level deep; Tab reaches them after the
  // header, and selecting a nested tile zooms straight to it. A tile's name says the share that never ran, as the panel does.
  assert.equal(await page.getByRole('group', {name: 'Bundle size treemap'}).count(), 1)
  assert.deepEqual(await page.locator('.tile.group[data-depth="0"]').evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), [
    'app.js, 80 bytes, 50% never ran',
  ])
  assert.equal(await page.locator('.tile.group[data-depth="1"], .tile[data-depth="2"]').count(), 0)
  await page.locator('.tile.group[data-depth="0"]').focus()
  await page.keyboard.press('Tab')
  assert.equal(await focused(page), 'src, 60 bytes, 33% never ran')
  assert.equal(await page.locator('#tile-panel h3').textContent(), 'src')
  // A zoom moves keyboard focus that was in the map into the new view, and zooming out returns it to the tile it left. Focus
  // elsewhere stays where it is.
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#scope').textContent(), 'src')
  assert.equal(await focused(page), await page.locator(top).first().getAttribute('aria-label'))
  await page.goBack()
  assert.equal(await focused(page), 'src, 60 bytes, 33% never ran')
  await page.getByRole('searchbox').focus()
  await page.goForward()
  assert.equal(await page.locator('#scope').textContent(), 'src')
  assert.equal(await focused(page), 'search')
  await page.goBack()
  // A pointer zoom moves focus too, but does not scroll the page to the tile that receives it: here the top of the map,
  // where that tile is, is above the viewport and stays there.
  await page.setViewportSize({width: 1440, height: 400})
  await page.evaluate(() => scrollTo(0, scrollY + document.getElementById('treemap')!.getBoundingClientRect().top + 60))
  const mapTop = () => page.evaluate(() => Math.round(document.getElementById('treemap')!.getBoundingClientRect().top))
  assert.equal(await mapTop(), -60)
  const src = (await page.locator('.tile[data-depth="1"][aria-label^="src,"]').boundingBox())!
  await page.mouse.click(src.x + src.width / 2, src.y + src.height / 2)
  assert.equal(await page.locator('#scope').textContent(), 'src')
  assert.equal(await focused(page), await page.locator(top).first().getAttribute('aria-label'))
  assert.equal(await mapTop(), -60, 'a pointer zoom must not scroll the page')
  await page.setViewportSize({width: 1440, height: 1000})
  // Focus on a breadcrumb moves into the view it selects, to the tile that was left, as after any zoom out (#107).
  await page.locator('#breadcrumbs button', {hasText: 'app.js'}).focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#scope').textContent(), 'app.js')
  assert.equal(await focused(page), 'src, 60 bytes, 33% never ran')
  await page.locator('#breadcrumbs button').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#scope').textContent(), 'All bundles')
  assert.equal(await focused(page), 'app.js, 80 bytes, 50% never ran')
  // The Area switch sizes tiles by the bytes that never ran, so lazy.js, which no recording measured, leaves the map.
  await page.getByRole('button', {name: 'Never-ran bytes'}).click()
  assert.equal(await page.getByRole('button', {name: 'Never-ran bytes'}).getAttribute('aria-pressed'), 'true')
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), ['app.js, 80 bytes, 50% never ran'])
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
  // Opening a file hides the map, so focus moves to the file's name, and back returns it to the file's tile.
  const last = await focused(page)
  await page.keyboard.press('Enter')
  assert.equal(await focused(page), 'scope')
  await page.goBack()
  assert.equal(await focused(page), last)
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
  // Changing the colors or the grouping starts again at the root, and the root becomes the current history entry, so back
  // after the next zoom returns to the root rather than to the view that was left or to its keys in the old grouping.
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByLabel('Color tiles by').selectOption('phases')
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.goBack()
  assert.equal(await page.locator('#scope').textContent(), 'All bundles')
  await page.getByLabel('Color tiles by').selectOption('coverage')
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByRole('button', {name: 'src', exact: true}).click()
  await page.getByLabel('Group sources').selectOption('package')
  assert.equal(await page.locator('#scope').textContent(), 'All bundles')
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.goBack()
  assert.equal(await page.locator('#scope').textContent(), 'All bundles')
  // Back skips an entry that shows the view already on screen: after app.js, the root, a zoom and a Color change, the
  // history ends with the root twice, and one back press from there returns to app.js (#108).
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByRole('button', {name: 'All bundles', exact: true}).click()
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByLabel('Color tiles by').selectOption('phases')
  assert.equal(await page.locator('#scope').textContent(), 'All bundles')
  await page.goBack()
  await page
    .locator('#scope')
    .filter({hasText: /^app\.js$/})
    .waitFor({timeout: 5000})
  await page.getByLabel('Color tiles by').selectOption('coverage')
  assert.equal(await page.locator('#scope').textContent(), 'All bundles')
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
  // The search box's placeholder says what the search matches, and is not cut off on a phone.
  const [placeholder, box] = await page.getByRole('searchbox').evaluate((input: HTMLInputElement) => {
    const style = getComputedStyle(input)
    const context = document.createElement('canvas').getContext('2d')!
    context.font = style.font
    return [
      context.measureText(input.placeholder).width,
      input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    ]
  })
  assert(placeholder <= box, `the search placeholder is ${placeholder}px wide in a ${box}px box`)
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
  // Keyboard focus moves into the view that grows in and stays there through the motion.
  await motion.locator('.tile[data-depth="1"][aria-label^="src,"]').focus()
  await motion.keyboard.press('Enter')
  await motion.locator('#treemap .layer.leaving').waitFor()
  assert(await motion.evaluate(() => document.activeElement!.closest('.layer')!.classList.contains('entering')))
  await motion.locator('#treemap .layer.leaving').waitFor({state: 'detached'})
  assert.equal(await focused(motion), await motion.locator(top).first().getAttribute('aria-label'))
  await motion.goBack()
  await motion.locator('#treemap .layer.leaving').waitFor({state: 'detached'})
  assert.equal(await focused(motion), 'src, 60 bytes, 33% never ran')
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

  // Beside one file that fills the map, the merged tile still gets room to see and select, nested and at the top level.
  const dominant = join(output, 'dominant')
  await mkdir(dominant, {recursive: true})
  await writeFile(join(dominant, 'one.js'), ';'.repeat(5006))
  await writeFile(
    join(dominant, 'one.js.map'),
    JSON.stringify({
      version: 3,
      sections: ['big.ts', 'a.ts', 'b.ts', 'c.ts'].map((name, i) => ({
        offset: {line: 0, column: i && 4998 + i * 2},
        map: {version: 3, sources: [name], names: [], mappings: 'AAAA'},
      })),
    }),
  )
  const dominantHtml = join(output, 'dominant.html')
  execFileSync(binary, ['--dir', dominant, '--treemap', dominantHtml], {stdio: 'pipe'})
  // The size the layout gives the tile: its padding alone would draw it outside the map.
  const sized = (tile = '.tile[data-kind="more"]') =>
    page.locator(tile).evaluate((tile) => parseFloat(tile.style.width) > 0 && parseFloat(tile.style.height) > 0)
  await page.goto(pathToFileURL(dominantHtml).href)
  assert(await sized(), 'the nested merged tile has a width and a height')
  await page.locator('.tile[data-kind="more"]').click()
  assert.equal(await page.locator('#scope').textContent(), '3 smaller items')
  await page.getByRole('button', {name: 'one.js', exact: true}).click()
  assert(await sized(), 'the merged tile has a width and a height')
  await page.locator('.tile[data-kind="more"]').click()
  assert.equal(await page.locator('#scope').textContent(), '3 smaller items')
  // A view whose files have no bytes says so instead of drawing an empty map.
  const emptyHtml = join(output, 'empty.html')
  await writeFile(emptyHtml, (await readFile(dominantHtml, 'utf8')).replaceAll(/(?<="\w*[bB]ytes":)\d+/g, '0'))
  await page.goto(pathToFileURL(emptyHtml).href)
  assert.equal(await page.locator('#treemap').textContent(), 'Nothing here has any bytes.')
  // A single file too small to see is not merged, but gets the same room beside the large one, nested and at the top level.
  const lone = join(output, 'lone')
  await mkdir(lone, {recursive: true})
  await writeFile(join(lone, 'one.js'), ';'.repeat(5002))
  await writeFile(
    join(lone, 'one.js.map'),
    JSON.stringify({
      version: 3,
      sections: ['big.ts', 'tiny.ts'].map((name, i) => ({
        offset: {line: 0, column: i * 5000},
        map: {version: 3, sources: [name], names: [], mappings: 'AAAA'},
      })),
    }),
  )
  const loneHtml = join(output, 'lone.html')
  execFileSync(binary, ['--dir', lone, '--treemap', loneHtml], {stdio: 'pipe'})
  await page.goto(pathToFileURL(loneHtml).href)
  assert(await sized('.tile[aria-label^="tiny.ts,"]'), 'the nested single small tile has a width and a height')
  await page.getByRole('button', {name: 'one.js', exact: true}).click()
  assert(await sized('.tile[aria-label^="tiny.ts,"]'), 'the single small tile has a width and a height')
  await page.locator('.tile[aria-label^="tiny.ts,"]').click()
  assert.equal(await page.locator('#scope').textContent(), 'tiny.ts')
  // A file with just enough area to keep its own tile is not drawn as a sliver beside the large one either (#106).
  const strip = join(output, 'strip')
  await mkdir(strip, {recursive: true})
  await writeFile(join(strip, 'two.js'), ';'.repeat(5012))
  await writeFile(
    join(strip, 'two.js.map'),
    JSON.stringify({
      version: 3,
      sections: ['big.ts', 'small.ts'].map((name, i) => ({
        offset: {line: 0, column: i * 5000},
        map: {version: 3, sources: [name], names: [], mappings: 'AAAA'},
      })),
    }),
  )
  const stripHtml = join(output, 'strip.html')
  execFileSync(binary, ['--dir', strip, '--treemap', stripHtml], {stdio: 'pipe'})
  await page.goto(pathToFileURL(stripHtml).href)
  const thinnest = () =>
    page.locator('.tile[aria-label^="small.ts,"]').evaluate((tile) => Math.min(parseFloat(tile.style.width), parseFloat(tile.style.height)))
  assert((await thinnest()) >= 4, `the nested small tile is ${await thinnest()}px thin`)
  await page.getByRole('button', {name: 'two.js', exact: true}).click()
  assert((await thinnest()) >= 4, `the small tile is ${await thinnest()}px thin`)

  // Two pnpm copies of one package shorten to the same path, but each keeps its own tile, named by its version.
  const pnpm = join(output, 'pnpm')
  await mkdir(pnpm, {recursive: true})
  await writeFile(join(pnpm, 'vendor.js'), ';'.repeat(40))
  await writeFile(
    join(pnpm, 'vendor.js.map'),
    JSON.stringify({
      version: 3,
      sections: ['tslib@1.14.1', 'tslib@2.6.2'].map((store, i) => ({
        offset: {line: 0, column: i * 30},
        map: {version: 3, sources: [`node_modules/.pnpm/${store}/node_modules/tslib/tslib.js`], names: [], mappings: 'AAAA'},
      })),
    }),
  )
  // Three copies that first differ at different depths: two would still share `(web)`, so those show their full source.
  await writeFile(join(pnpm, 'apps.js'), ';'.repeat(60))
  await writeFile(
    join(pnpm, 'apps.js.map'),
    JSON.stringify({
      version: 3,
      sections: ['web/node_modules/.pnpm/tslib@2.6.2', 'web/node_modules/.pnpm/tslib@1.14.1', 'docs/node_modules/.pnpm/tslib@2.6.2'].map(
        (store, i) => ({
          offset: {line: 0, column: [0, 30, 50][i]},
          map: {version: 3, sources: [`apps/${store}/node_modules/tslib/tslib.js`], names: [], mappings: 'AAAA'},
        }),
      ),
    }),
  )
  const pnpmHtml = join(output, 'pnpm.html')
  execFileSync(binary, ['--dir', pnpm, '--treemap', pnpmHtml], {stdio: 'pipe'})
  await page.goto(pathToFileURL(pnpmHtml).href)
  await page.getByRole('button', {name: 'vendor.js', exact: true}).click()
  await page.getByRole('button', {name: 'node_modules/tslib', exact: true}).click()
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => [tile.ariaLabel, tile.dataset.bytes])), [
    ['tslib.js (tslib@1.14.1), 30 bytes', '30'],
    ['tslib.js (tslib@2.6.2), 10 bytes', '10'],
  ])
  await page.goto(pathToFileURL(pnpmHtml).href)
  await page.getByRole('button', {name: 'apps.js', exact: true}).click()
  await page.getByRole('button', {name: 'node_modules/tslib', exact: true}).click()
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => [tile.ariaLabel, tile.dataset.bytes])), [
    ['tslib.js (apps/web/node_modules/.pnpm/tslib@2.6.2/node_modules/tslib/tslib.js), 30 bytes', '30'],
    ['tslib.js (apps/web/node_modules/.pnpm/tslib@1.14.1/node_modules/tslib/tslib.js), 20 bytes', '20'],
    ['tslib.js (docs), 10 bytes', '10'],
  ])

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
  await page.locator('#duplicate-list button').click()
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), [
    'a.js, 30 bytes',
    'b.js, 20 bytes',
  ])
  await page.goto(pathToFileURL(html).href)
  assert(await page.locator('#duplicate-finding').isHidden(), 'no finding without duplicates')

  // A findings card selects its package or source itself in every bundle, from the root, instead of searching for its name
  // in the current view: react's card leaves out react-dom and src/react-utils.ts, and the card of src/features/a/index.js
  // leaves out the packages' index.js files. Typing in the search box still matches text.
  const findings = join(output, 'findings')
  await mkdir(findings, {recursive: true})
  await writeFile(join(findings, 'app.js'), ';'.repeat(2600))
  await writeFile(
    join(findings, 'app.js.map'),
    JSON.stringify({
      version: 3,
      sections: ['node_modules/react/index.js', 'node_modules/react-dom/index.js', 'src/react-utils.ts', 'src/features/a/index.js'].map(
        (name, i) => ({
          offset: {line: 0, column: [0, 1200, 2400, 2500][i]},
          map: {version: 3, sources: [name], names: [], mappings: 'AAAA'},
        }),
      ),
    }),
  )
  const ran = (ranges: number[][]) =>
    JSON.stringify([{url: 'app.js', text: ';'.repeat(2600), ranges: ranges.map(([start, end]) => ({start, end}))}])
  await writeFile(
    join(output, 'initial.json'),
    ran([
      [0, 100],
      [1200, 1300],
      [2400, 2500],
    ]),
  )
  await writeFile(
    join(output, 'click.json'),
    ran([
      [0, 100],
      [1200, 1300],
      [2400, 2600],
    ]),
  )
  const findingsHtml = join(output, 'findings.html')
  execFileSync(
    binary,
    [
      '--dir',
      findings,
      '--coverage',
      join(output, 'initial.json'),
      '--coverage',
      join(output, 'click.json'),
      '--initial-scenario',
      'initial.json',
      '--treemap',
      findingsHtml,
    ],
    {stdio: 'pipe'},
  )
  await page.goto(pathToFileURL(findingsHtml).href)
  assert.equal(await page.getByRole('searchbox').getAttribute('placeholder'), 'Search paths, packages or labels')
  assert.match(
    await page.locator('#later-list').innerText(),
    /index\.js\s+100 B\s+100 B run only in "click\.json": src\/features\/a\/index\.js/,
  )
  await page.getByRole('button', {name: 'app.js', exact: true}).click()
  await page.getByRole('button', {name: 'src', exact: true}).click()
  await page
    .locator('#unused-list button')
    .filter({has: page.getByText('react', {exact: true})})
    .click()
  assert.equal(await page.locator('#scope').textContent(), 'All bundles')
  assert.deepEqual(await page.evaluate(() => history.state), {coldpath: [], only: null, index: 2})
  assert.equal(await page.getByRole('searchbox').inputValue(), 'react')
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), [
    'app.js, 1,200 bytes, 92% never ran',
  ])
  await page.locator('#later-list button').click()
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), ['app.js, 100 bytes, 0% never ran'])
  await page.getByRole('searchbox').fill('index.js')
  assert.deepEqual(await page.locator(top).evaluateAll((tiles) => tiles.map((tile) => tile.ariaLabel)), [
    'app.js, 2,500 bytes, 88% never ran',
  ])

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
