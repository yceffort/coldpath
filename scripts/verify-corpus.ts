// Real builds + native V8 recordings + an independent source-map/byte oracle.
import assert from 'node:assert/strict'
import {execFileSync, spawn} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {createServer} from 'node:http'
import type {Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {mkdir, readFile, writeFile, copyFile, rm} from 'node:fs/promises'
import {resolve, join, dirname, relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {chromium} from '@playwright/test'
import {build as esbuild} from 'esbuild'
import {rollup} from 'rollup'
import {build as vite} from 'vite'
import webpack from 'webpack'
import {AnyMap, originalPositionFor, decodedMappings, LEAST_UPPER_BOUND} from '@jridgewell/trace-mapping'
import graphPlugin from '@yceffort/coldpath/rollup'
import vitePlugin from '@yceffort/coldpath/vite'
import ColdpathGraphPlugin from '@yceffort/coldpath/webpack'
import {esbuildGraph, turbopackGraph, enrichLocations, sha256} from '../lib/graph.ts'
import {assertIntervals} from './reference.ts'
import {readMap} from '../lib/maps.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const work = join(root, 'artifacts/accuracy-corpus')
const project = join(work, 'project')
await rm(work, {recursive: true, force: true})
await mkdir(join(project, 'src'), {recursive: true})
for (const file of ['entry.js', 'startup.js', 'chart.js', 'register.js', 'mixed.js', 'search.js', 'page.jsx']) {
  await copyFile(join(root, 'fixtures/corpus', file), join(project, 'src', file))
}
await writeFile(join(project, 'package.json'), JSON.stringify({name: 'coldpath-accuracy-corpus', private: true, type: 'module'}))
await writeFile(join(project, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="/src/entry.js"></script>')
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const binary = join(root, 'target/debug/coldpath')
const artifacts: {name: string; dir: string; graphFile: string; graphRoot: string}[] = []
const expectations = JSON.parse(await readFile(join(root, 'fixtures/corpus/expectations.json'), 'utf8'))
const save = async (filename: string, value: unknown) => {
  await mkdir(dirname(filename), {recursive: true})
  await writeFile(filename, JSON.stringify(value) + '\n')
}

async function finish(name: string, dir: string, entry: string | null, graph?: Parameters<typeof enrichLocations>[0], graphRoot = project) {
  const graphFile = join(work, name + '.graph.json')
  if (graph) await save(graphFile, await enrichLocations(graph, graphRoot))
  else await copyFile(join(dir, 'coldpath.graph.json'), graphFile)
  if (entry)
    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><script type="module" src="/${entry}"></script>`)
  artifacts.push({name, dir, graphFile, graphRoot})
}

const esDir = join(work, 'esbuild')
const es = await esbuild({
  absWorkingDir: project,
  entryPoints: {'entry/main': 'src/entry.js'},
  outdir: esDir,
  bundle: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/deep/[name]-[hash]',
  minify: true,
  sourcemap: true,
  charset: 'utf8',
  metafile: true,
})
await finish('esbuild', esDir, 'entry/main.js', esbuildGraph(es.metafile, project))

const rollupDir = join(work, 'rollup')
const built = await rollup({input: join(project, 'src/entry.js'), plugins: [graphPlugin({root: project})]})
await built.write({
  dir: rollupDir,
  format: 'esm',
  sourcemap: true,
  entryFileNames: 'entry/main.js',
  chunkFileNames: 'chunks/deep/[name]-[hash].js',
})
await built.close()
await finish('rollup', rollupDir, 'entry/main.js')

const viteDir = join(work, 'vite')
await vite({
  root: project,
  logLevel: 'warn',
  plugins: [vitePlugin()],
  build: {
    outDir: viteDir,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {output: {entryFileNames: 'entry/[name]-[hash].js', chunkFileNames: 'chunks/deep/[name]-[hash].js'}},
  },
})
await finish('vite', viteDir, null)

const webpackDir = join(work, 'webpack')
const compiler = webpack({
  mode: 'production',
  context: project,
  entry: './src/entry.js',
  devtool: 'source-map',
  output: {path: webpackDir, filename: 'entry/main.js', chunkFilename: 'chunks/deep/[name].js', publicPath: '/'},
  optimization: {concatenateModules: true},
  plugins: [new ColdpathGraphPlugin()],
})
await new Promise((resolve, reject) =>
  compiler.run((error, stats) => (error || stats!.hasErrors() ? reject(error || new Error(stats!.toString())) : resolve(stats))),
)
await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())))
await finish('webpack', webpackDir, 'entry/main.js')

const nextProject = join(project, 'next')
await mkdir(join(nextProject, 'pages'), {recursive: true})
await writeFile(join(nextProject, 'pages/index.jsx'), "export {default} from '../../src/page.jsx';\n")
await save(join(nextProject, 'package.json'), {
  name: 'coldpath-corpus-next',
  private: true,
  dependencies: {
    next: require('next/package.json').version,
    react: require('react/package.json').version,
    'react-dom': require('react-dom/package.json').version,
  },
})
await writeFile(
  join(nextProject, 'next.config.mjs'),
  'export default ' + JSON.stringify({productionBrowserSourceMaps: true, turbopack: {root}, experimental: {cpus: 2}}) + ';\n',
)
const nextBin = join(root, 'node_modules/next/dist/bin/next')
const env = {...process.env, NEXT_TELEMETRY_DISABLED: '1'}
execFileSync(process.execPath, [nextBin, 'experimental-analyze', nextProject, '--output'], {cwd: root, env, stdio: 'inherit'})
// next build clears .next, so retain the native graph before building.
const nextNative = join(work, 'next.modules.data')
await copyFile(join(nextProject, '.next/diagnostics/analyze/data/modules.data'), nextNative)
const nextGraph = turbopackGraph(await readFile(nextNative), root)
execFileSync(process.execPath, [nextBin, 'build', nextProject], {cwd: root, env, stdio: 'inherit'})
await finish('next-turbopack', join(nextProject, '.next/static'), null, nextGraph, root)

const canonicalSource = (source: string, mapFile: string, dir: string) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return source.replaceAll('/./', '/')
  return relative(dir, resolve(dirname(mapFile), source)).replaceAll('\\', '/')
}
const markers = new Map([
  ['CP_CORPUS_STARTUP_', 'startup.js'],
  ['CP_CORPUS_CHART_', 'chart.js'],
  ['CP_CORPUS_NEVER_', 'chart.js'],
  ['CP_CORPUS_SEARCH_', 'search.js'],
])

async function checkAttribution(report: any, dir: string) {
  let oracleBytes = 0,
    disagreement = 0,
    probeBytes = 0,
    probeWrong = 0,
    duplicateMappingBytes = 0,
    defaultOracleDisagreementBytes = 0
  const probes = new Set()
  for (const bundle of report.bundles) {
    const filename = join(dir, bundle.path)
    const source = await readFile(filename, 'utf8')
    const mapData = await readMap(filename, source, dir)
    const reference = source
      .trimEnd()
      .split('\n')
      .at(-1)
      ?.match(/^\/\/[#@]\s*sourceMappingURL=(.+)$/)?.[1]
    const mapFile = reference ? resolve(dirname(filename), decodeURIComponent(reference.split(/[?#]/)[0])) : filename + '.map'
    const map = mapData ? AnyMap(JSON.parse(mapData as unknown as string)) : null
    const duplicates = new Set()
    if (map)
      decodedMappings(map).forEach((segments, line) => {
        for (let i = 1; i < segments.length; i++) if (segments[i][0] === segments[i - 1][0]) duplicates.add(`${line + 1}:${segments[i][0]}`)
      })
    let byte = 0,
      column = 0,
      line = 1,
      index = 0,
      previousCR = false
    for (const char of source) {
      while (bundle.spans[index]?.end <= byte) index++
      const actual = bundle.sources[bundle.spans[index].source].source
      const newline = /[\r\n\u2028\u2029]/.test(char)
      const standard = !newline && map ? originalPositionFor(map, {line, column}).source : null
      // The analyzer documents last-mapping-wins. trace-mapping's default picks
      // the FIRST duplicate at an exact coordinate, then the last between anchors.
      // Use its upper-bound lookup only at exact duplicates; publish these bytes.
      const duplicate = !newline && map && duplicates.has(`${line}:${column}`)
      const original = duplicate ? originalPositionFor(map, {line, column, bias: LEAST_UPPER_BOUND}).source : standard
      const expected = original === null ? '[unmapped]' : canonicalSource(original, mapFile, dir)
      const bytes = Buffer.byteLength(char)
      oracleBytes += bytes
      if (duplicate) duplicateMappingBytes += bytes
      if (actual !== (standard === null ? '[unmapped]' : canonicalSource(standard, mapFile, dir))) defaultOracleDisagreementBytes += bytes
      if (actual !== expected) disagreement += bytes
      if (newline) {
        if (!(char === '\n' && previousCR)) line++
        column = 0
      } else column += char.length
      previousCR = char === '\r'
      byte += bytes
    }
    for (const [marker, file] of markers) {
      let at = source.indexOf(marker)
      while (at >= 0) {
        probes.add(marker)
        const start = Buffer.byteLength(source.slice(0, at)),
          end = start + marker.length
        for (const span of bundle.spans)
          if (span.start < end && span.end > start) {
            const bytes = Math.min(end, span.end) - Math.max(start, span.start)
            probeBytes += bytes
            const owner = bundle.sources[span.source].source
            if (!(owner.endsWith('/' + file) || owner === file)) probeWrong += bytes
          }
        at = source.indexOf(marker, at + marker.length)
      }
    }
  }
  assert.equal(probes.size, markers.size, 'all known-origin probes must survive the real build')
  return {
    generatedBytes: oracleBytes,
    oracleDisagreementBytes: disagreement,
    oracleDisagreementPercent: (disagreement / oracleBytes) * 100,
    markerBytes: probeBytes,
    markerErrorBytes: probeWrong,
    markerErrorPercent: (probeWrong / probeBytes) * 100,
    duplicateMappingBytes,
    defaultOracleDisagreementBytes,
  }
}

const browser = await chromium.launch({headless: true})
const results = []
try {
  for (const artifact of artifacts) {
    let server: Server | undefined, child: ChildProcess | undefined, base: string
    if (artifact.name === 'next-turbopack') {
      const reservation = createServer()
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
      const port = (reservation.address() as AddressInfo).port
      await new Promise((resolve) => reservation.close(resolve))
      child = spawn(process.execPath, [nextBin, 'start', nextProject, '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      base = `http://127.0.0.1:${port}`
      let log = ''
      child.stdout!.on('data', (b) => {
        log += b
      })
      child.stderr!.on('data', (b) => {
        log += b
      })
      for (let attempt = 0; ; attempt++) {
        try {
          if ((await fetch(base)).ok) break
        } catch {}
        if (attempt > 100 || child.exitCode !== null) throw new Error('Next server did not start: ' + log)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } else {
      server = createServer(async (req, res) => {
        const path = resolve(artifact.dir, '.' + new URL(req.url!, 'http://fixture').pathname)
        if (!path.startsWith(artifact.dir + '/') && path !== artifact.dir) {
          res.writeHead(403)
          res.end()
          return
        }
        try {
          const file = path === artifact.dir ? join(path, 'index.html') : path
          res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8')
          res.end(await readFile(file))
        } catch {
          res.writeHead(404)
          res.end()
        }
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
    const page = await browser.newPage()
    try {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.startPreciseCoverage', {callCount: true, detailed: true})
      await page.goto(base)
      const next = artifact.name === 'next-turbopack'
      if (next) await page.waitForFunction(() => window.__btCorpusReady)
      else await page.waitForFunction(() => globalThis.corpus?.initial)
      const captures = []
      for (const scenario of ['initial', 'open-report', 'search']) {
        if (scenario === 'open-report') {
          if (next) {
            await page.locator('#report').click()
            await page.locator('#result').filter({hasText: 'CP_CORPUS_CHART_'}).waitFor()
          } else assert.match(await page.evaluate(() => globalThis.corpus!.openReport()), /CP_CORPUS_CHART_/)
        }
        if (scenario === 'search') {
          if (next) {
            await page.locator('#search').click()
            await page.locator('#result').filter({hasText: 'CP_CORPUS_SEARCH_'}).waitFor()
          } else assert.match(await page.evaluate(() => globalThis.corpus!.search()), /CP_CORPUS_SEARCH_/)
        }
        const {result} = await cdp.send('Profiler.takePreciseCoverage')
        const scripts = []
        for (const script of result) {
          if (!script.url.startsWith(base + '/')) continue
          const pathname = decodeURIComponent(new URL(script.url).pathname)
          if (next && !pathname.startsWith('/_next/static/')) continue
          const path = next ? pathname.slice('/_next/static/'.length) : pathname.slice(1)
          if (!/\.[cm]?js$/.test(path)) continue
          const filename = join(artifact.dir, path),
            source = await readFile(filename, 'utf8')
          const map = await readMap(filename, source, artifact.dir)
          scripts.push({path, sha256: sha256(source), sourceMapSha256: map ? sha256(map) : null, functions: script.functions})
        }
        assert(scripts.length, `${artifact.name}: missing native V8 recordings`)
        const capture = {schemaVersion: 1, scenario, scripts}
        const path = join(work, artifact.name + '.' + scenario + '.json')
        await save(path, capture)
        captures.push({path, capture})
      }
      await cdp.send('Profiler.stopPreciseCoverage')
      const output = join(work, artifact.name + '.report.json')
      execFileSync(
        binary,
        [
          '--dir',
          artifact.dir,
          ...captures.flatMap((c) => ['--coverage', c.path]),
          '--initial-scenario',
          'initial',
          '--scenario-order',
          'initial,open-report,search',
          '--source-compression',
          '--graph',
          artifact.graphFile,
          '--graph-root',
          artifact.graphRoot,
          '--details',
          '--json',
          output,
          '--treemap',
          join(work, artifact.name + '.html'),
        ],
        {stdio: 'pipe', maxBuffer: 16 * 1024 * 1024},
      )
      const report = JSON.parse(await readFile(output, 'utf8'))
      const metrics = await checkAttribution(report, artifact.dir)
      assert.equal(metrics.oracleDisagreementBytes, 0, artifact.name + ': attribution oracle disagreement')
      assert(
        metrics.markerErrorBytes <= expectations[artifact.name].maxMarkerErrorBytes,
        `${artifact.name}: known-origin error ${metrics.markerErrorBytes} B exceeds published corpus budget`,
      )
      let checkedScenarios = 0
      for (const {capture} of captures)
        for (const script of capture.scripts) {
          const bundle = report.bundles.find((b: {path: string}) => b.path === script.path)
          const points = new Uint8Array(bundle.generatedSource.length)
          const ranges = script.functions
            .flatMap((fn) => fn.ranges)
            .toSorted((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset))
          for (const range of ranges) points.fill(Number(range.count > 0), range.startOffset, range.endOffset)
          assertIntervals({...bundle, spans: bundle.scenarioSpans[capture.scenario]}, bundle.generatedSource, points)
          checkedScenarios++
        }
      for (const bundle of report.bundles)
        for (const source of bundle.sources) {
          assert.equal(
            source.firstObserved.reduce((sum: number, phase: {bytes: number}) => sum + phase.bytes, 0),
            source.observedBytes,
          )
        }
      const chart = report.importPaths.find((p: {source: string}) => p.source.endsWith('/chart.js'))
      const search = report.importPaths.find((p: {source: string}) => p.source.endsWith('/search.js'))
      assert(
        chart?.edges.some(
          (edge: {to: string; kind: string; location?: {line: number}}) =>
            edge.to.endsWith('/chart.js') && edge.kind === 'static' && edge.location?.line === (next ? 4 : 2),
        ),
        artifact.name + ': static chart import location',
      )
      assert(
        search?.edges.some(
          (edge: {to: string; kind: string; location?: {line: number}}) =>
            edge.to.endsWith('/search.js') && edge.kind === 'dynamic' && edge.location?.line === (next ? 12 : 9),
        ),
        artifact.name + ': dynamic search boundary/location',
      )
      if (artifact.name === 'vite' || artifact.name === 'webpack') {
        const action = (file: string) =>
          report.recommendations.find(
            (r: {scenario: string; source: string}) => r.scenario === 'open-report' && r.source.endsWith('/' + file),
          )?.kind
        assert.equal(action('chart.js'), 'defer-review', artifact.name + ': functions-only module')
        assert.equal(action('register.js'), 'split-review', artifact.name + ': top-level registration')
        assert.equal(action('mixed.js'), 'split-review', artifact.name + ': function called initially')
      }
      // Negative control: preserving every count while corrupting source ownership must fail.
      const changed = structuredClone(report)
      for (const bundle of changed.bundles)
        for (const source of bundle.sources) if (source.source.endsWith('/startup.js')) source.source = 'wrong-origin.js'
      const negative = await checkAttribution(changed, artifact.dir)
      assert(negative.markerErrorBytes > 0 && negative.oracleDisagreementBytes > 0)
      results.push({
        bundler: artifact.name,
        version: require((artifact.name === 'next-turbopack' ? 'next' : artifact.name) + '/package.json').version,
        ...metrics,
        checkedScenarioBundles: checkedScenarios,
        graphMatchedSources: report.importPaths.length,
        negativeControlDetected: true,
      })
      console.log('Verified real build:', artifact.name, metrics)
    } finally {
      await page.close()
      if (server) await new Promise((resolve) => server.close(resolve))
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    }
  }
} finally {
  await browser.close()
}
await save(join(work, 'results.json'), {node: process.version, results})
const md =
  '# Real-build accuracy corpus\n\nGenerated by `pnpm test:corpus`. These checks measure agreement with an independent source-map oracle and known-origin literal probes, not exact semantic ownership of every minified byte.\n\n' +
  '| Build | Version | Generated B | Source-map oracle disagreement | Known-origin probe errors | Scenario/bundle checks |\n| --- | --- | ---: | ---: | ---: | ---: |\n' +
  results
    .map(
      (r) =>
        `| ${r.bundler} | ${r.version} | ${r.generatedBytes} | ${r.oracleDisagreementPercent.toFixed(4)}% | ${r.markerErrorPercent.toFixed(4)}% (${r.markerErrorBytes}/${r.markerBytes} B) | ${r.checkedScenarioBundles} |`,
    )
    .join('\n') +
  '\n\nOracle lookup follows the documented last-mapping-wins rule at duplicate generated coordinates. `results.json` also publishes `duplicateMappingBytes` and disagreement with the reference library’s default first-duplicate lookup (`defaultOracleDisagreementBytes`); these ambiguities are not hidden.\n\nAll builds check static and dynamic import locations, UTF-8 ownership, per-scenario native V8 ranges, and first-observation byte conservation. A negative control relabels a real source while preserving counts and must be detected. This small corpus does not establish an error bound for arbitrary applications or source maps. Re-run on both Linux and macOS in CI; counts can change with pinned toolchain updates.\n'
await writeFile(join(work, 'RESULTS.md'), md)
console.log(md)
