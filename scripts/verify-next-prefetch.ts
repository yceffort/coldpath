// Four real Next.js builds (App and Pages Router, each with Turbopack and webpack) whose home page links to two
// routes. Chunks that only router prefetches for those routes loaded are left out of the recording, by the
// collector when nothing in them ran, by the analyzer when only module evaluation ran; a chunk the page went on
// to use stays. The same builds check that a prerendered document names the initial load without a browser
// (#61) and that per-package attribution does not depend on coverage (#65).
import assert from 'node:assert/strict'
import {execFile, execFileSync, spawn} from 'node:child_process'
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = join(root, 'artifacts', 'next-prefetch')
await rm(workspace, {recursive: true, force: true})
const nextBin = join(root, 'node_modules/next/dist/bin/next')
const env = {...process.env, NEXT_TELEMETRY_DISABLED: '1'}
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const binary = join(root, 'target', 'debug', 'coldpath')

const view = (name: string) =>
  `import {useState} from 'react'\n\nexport default function View() {\n  const [open, setOpen] = useState(false)\n  return <button onClick={() => setOpen(!open)}>{open ? '${name} details' : '${name} view'}</button>\n}\n`
const home =
  'import Link from \'next/link\'\n\nexport default function Home() {\n  return <main><Link href="/about">about</Link> <Link href="/tags">tags</Link></main>\n}\n'

// The files of each router, and the report source of each route's component.
const routers = {
  app: {
    files: {
      'app/layout.jsx': 'export default function Layout({children}) {\n  return <html lang="en"><body>{children}</body></html>\n}\n',
      'app/page.jsx': home,
      ...Object.fromEntries(
        ['about', 'tags'].flatMap((name) => [
          [`app/${name}/page.jsx`, "import View from './View'\n\nexport default function Page() {\n  return <View />\n}\n"],
          [`app/${name}/View.jsx`, `'use client'\n${view(name)}`],
        ]),
      ),
    },
    source: (name: string) => `app/${name}/View.jsx`,
    html: join('server', 'app', 'index.html'),
  },
  pages: {
    files: {
      'pages/index.jsx': home,
      'pages/about.jsx': view('about'),
      'pages/tags.jsx': view('tags'),
    },
    source: (name: string) => `pages/${name}.jsx`,
    html: join('server', 'pages', 'index.html'),
  },
}

for (const router of ['app', 'pages'] as const) {
  for (const bundler of ['turbopack', 'webpack'] as const) {
    const name = `${router}-${bundler}`
    const project = join(workspace, name)
    const out = join(project, 'out')
    const files: Record<string, string> = {
      'package.json': JSON.stringify({name: `coldpath-next-prefetch-${name}`, private: true}),
      'next.config.mjs': 'export default {productionBrowserSourceMaps: true}\n',
      ...routers[router].files,
    }
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(project, file)), {recursive: true})
      await writeFile(join(project, file), text)
    }
    execFileSync(process.execPath, [nextBin, 'build', project, ...(bundler === 'webpack' ? ['--webpack'] : [])], {
      cwd: root,
      env,
      stdio: 'inherit',
    })

    // The chunk that holds each route's component, found by its button text.
    const statics = join(project, '.next', 'static')
    const chunks = (await readdir(statics, {recursive: true})).filter((file) => file.endsWith('.js'))
    const holding = async (text: string) => {
      const found = []
      for (const file of chunks) if ((await readFile(join(statics, file), 'utf8')).includes(text)) found.push(file)
      assert.equal(found.length, 1, `${name}: ${text}: ${found}`)
      return found[0]
    }
    const about = await holding('about view')
    const tags = await holding('tags view')

    const reservation = createServer()
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
    const port = (reservation.address() as AddressInfo).port
    await new Promise((resolve) => reservation.close(resolve))
    const base = `http://127.0.0.1:${port}`
    const server = spawn(process.execPath, [nextBin, 'start', project, '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root,
      env,
      stdio: 'ignore',
    })
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if ((await fetch(base)).ok) break
        } catch {}
        assert(attempt < 100 && server.exitCode === null, `${name}: Next server did not start`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const collect = (scenario: string, extra: string[]) =>
        run(process.execPath, [
          join(root, 'bin', 'coldpath.ts'),
          'collect',
          '--url',
          `${base}/`,
          '--dir',
          statics,
          '--prefix',
          '/_next/static/',
          '--scenario',
          scenario,
          '--out',
          join(out, `${scenario}.coverage.json`),
          ...extra,
        ])
      const read = async (scenario: string) => JSON.parse(await readFile(join(out, `${scenario}.coverage.json`), 'utf8'))
      const named = (envelope: any) =>
        [...envelope.prefetchedScripts, ...envelope.prefetchEvaluatedScripts].sort((a, b) => a.path.localeCompare(b.path))
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const html = join(project, '.next', routers[router].html)
      const document = await readFile(html, 'utf8')
      const namedByDocument = (path: string) => new RegExp(`(?<![\\w.-])${escape(path)}(?![\\w.-])`).test(document)

      // The home page prefetches both linked routes. Everything it loaded beyond what its document names came
      // from those prefetches: the route chunks, and in the Turbopack Pages Router a chunk list per route that
      // loads them. Turbopack App Router chunks only register their modules, so the collector leaves them out;
      // the others evaluate modules, so the collector records them with the prefetch evidence for the analyzer.
      const {stderr} = await collect('initial', [])
      const initial = await read('initial')
      const prefetchLoaded = [
        ...new Set<string>(
          initial.requests
            .filter((r: any) => r.type === 'script' && r.path.startsWith('/_next/static/'))
            .map((r: any) => r.path.slice('/_next/static/'.length)),
        ),
      ]
        .filter((path) => !namedByDocument(path))
        .sort()
      assert(prefetchLoaded.includes(about) && prefetchLoaded.includes(tags), `${name}: ${prefetchLoaded}`)
      assert.deepEqual(
        named(initial).map((s: any) => s.path),
        prefetchLoaded,
        `${name}: ${stderr}`,
      )
      for (const script of named(initial))
        assert(
          script.routes.length && script.routes.every((r: string) => ['/about', '/tags'].includes(r)),
          `${name}: ${JSON.stringify(script)}`,
        )
      assert.deepEqual([...new Set(named(initial).flatMap((s: any) => s.routes))].sort(), ['/about', '/tags'])
      const byCollector = initial.prefetchedScripts.length
      const byAnalyzer = initial.prefetchEvaluatedScripts.length
      if (byCollector) {
        assert(stderr.includes('initial: left out scripts that only router prefetches for other routes loaded: '), stderr)
        assert(!initial.scripts.some((s: any) => initial.prefetchedScripts.some((p: any) => p.path === s.path)))
      }
      if (byAnalyzer)
        assert(stderr.includes('initial: router prefetches for other routes also loaded scripts whose modules evaluated'), stderr)
      // Turbopack App Router chunks run nothing when prefetched; webpack chunks always run their entry.
      if (bundler === 'turbopack' && router === 'app') assert.equal(byAnalyzer, 0)
      if (bundler === 'webpack') assert.equal(byCollector, 0)

      // After navigating to /about, its chunks ran, so they are recorded; the tags chunks are still only prefetched.
      const actions = join(out, 'navigate.mjs')
      await writeFile(
        actions,
        "export default async function ({page}) {\n  await page.getByRole('link', {name: 'about'}).click()\n  await page.getByRole('button', {name: 'about view'}).click()\n  await page.getByRole('button', {name: 'about details'}).waitFor()\n}\n",
      )
      await collect('navigate', ['--actions', actions])
      const navigate = await read('navigate')
      const tagsOnly = named(initial).filter((s: any) => s.routes.join() === '/tags')
      assert(tagsOnly.some((s: any) => s.path === tags))
      assert.deepEqual(named(navigate), tagsOnly, name)
      assert(navigate.scripts.some((s: any) => s.path === about))

      // Another route's component that no scenario ran is unmeasured, not a removal-review candidate, and the
      // visited route's component ran. A prerendered document names the initial load without a browser.
      const analyze = async (extra: string[]) => {
        const {stdout} = await run(binary, ['--dir', statics, '--json', '-', ...extra], {maxBuffer: 64 * 1024 * 1024})
        return JSON.parse(stdout)
      }
      const report = await analyze([
        ...['initial', 'navigate'].flatMap((scenario) => ['--coverage', join(out, `${scenario}.coverage.json`)]),
        '--initial-scenario',
        'initial',
        '--initial-html',
        html,
      ])
      const source = (file: string) => report.sources.find((s: any) => s.source.endsWith(file))
      const tagsView = source(routers[router].source('tags'))
      assert(
        tagsView && tagsView.observedBytes === 0 && tagsView.unobservedBytes === 0 && tagsView.unmeasuredBytes > 0,
        `${name}: ${JSON.stringify(tagsView)}`,
      )
      assert(!report.recommendations.some((r: any) => r.kind === 'removal-review' && r.source.endsWith(routers[router].source('tags'))))
      const aboutView = source(routers[router].source('about'))
      assert(aboutView && aboutView.observedBytes > 0, `${name}: ${JSON.stringify(aboutView)}`)
      const scenario = (scenarioName: string) => report.scenarioReports.find((s: any) => s.scenario === scenarioName)
      for (const path of prefetchLoaded) {
        const bundle = scenario('initial').bundles.find((b: any) => b.path === path)
        assert(bundle && bundle.unmeasuredBytes === bundle.bytes, `${name}: ${path} counted in initial: ${JSON.stringify(bundle)}`)
      }
      const warnings = report.recordingWarnings.filter((w: string) => w.startsWith('initial: '))
      assert.equal(
        warnings.some((w: string) => w.startsWith(`initial: the collector left out ${byCollector} scripts`)),
        byCollector > 0,
        `${name}: ${warnings}`,
      )
      assert.equal(
        warnings.some((w: string) => w.startsWith(`initial: the analyzer left out ${byAnalyzer} scripts`)),
        byAnalyzer > 0,
        `${name}: ${warnings}`,
      )
      assert(!warnings.some((w: string) => w.startsWith('initial: kept')), `${name}: ${warnings}`)
      assert.deepEqual(
        scenario('initial')
          .unmeasuredBundles.filter((b: any) => b.reason === 'prefetch-only')
          .map((b: any) => b.path)
          .sort(),
        prefetchLoaded,
      )
      const loaded = report.initialLoad
      assert(
        loaded.bundles.length > 0 && !loaded.bundles.some((path: string) => prefetchLoaded.includes(path)),
        `${name}: ${JSON.stringify(loaded)}`,
      )
      // Everything the browser loaded for the home page, other than the prefetched chunks, the document names.
      const recorded = [...new Set(initial.scripts.map((s: any) => s.path))].filter((path) => !prefetchLoaded.includes(path as string))
      assert.deepEqual(
        recorded.filter((path) => !loaded.bundles.includes(path)),
        [],
        `${name}: loaded ${JSON.stringify(loaded.bundles)}`,
      )
      assert.equal(
        loaded.bytes,
        report.bundles.filter((b: any) => loaded.bundles.includes(b.path)).reduce((sum: number, b: any) => sum + b.bytes, 0),
      )

      // Attribution is independent of coverage: the static mode and the coverage mode agree per package and source.
      const fixed = await analyze([])
      assert.equal(fixed.mode, 'static')
      assert.equal(report.mode, 'coverage')
      const bytes = (rows: any[], key: string) => rows.map((row) => [row[key], row.bytes])
      assert.deepEqual(bytes(fixed.packages, 'package'), bytes(report.packages, 'package'), name)
      assert.deepEqual(bytes(fixed.sources, 'source'), bytes(report.sources, 'source'), name)
    } finally {
      server.kill('SIGTERM')
    }
    console.log(
      `${name}: prefetched route chunks left out, the navigated route kept, no removal-review for the unvisited route, initial load named by the document, attribution equal in both modes.`,
    )
  }
}
console.log('Verified Next.js App and Pages Router builds with Turbopack and webpack.')
