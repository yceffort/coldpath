// Module recovery against real builds. Recovery ignores source maps; the maps are the ground truth for its boundaries.
// Run after verify-corpus.ts, whose Next.js build is reused.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {copyFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {globSync} from 'node:fs'
import {createRequire} from 'node:module'
import {join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {AnyMap, eachMapping} from '@jridgewell/trace-mapping'
import webpack from 'webpack'
import {readMap} from '../lib/maps.ts'
import {chunkModules} from '../lib/modules.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const work = join(root, 'artifacts/recovery')
const NEXT15 = '15.5.25'
await rm(work, {recursive: true, force: true})
await mkdir(join(work, 'src'), {recursive: true})
for (const file of ['entry.js', 'startup.js', 'chart.js', 'register.js', 'mixed.js', 'search.js', 'page.jsx'])
  await copyFile(join(root, 'fixtures/corpus', file), join(work, 'src', file))
// React supplies real package modules next to the corpus sources.
await writeFile(
  join(work, 'src/app.js'),
  "import {createRoot} from 'react-dom/client'\nimport {createElement} from 'react'\nimport './entry.js'\n" +
    "createRoot(document.body).render(createElement('p', null, 'corpus'))\n",
)

const builds = []
const variants: Record<string, webpack.Configuration> = {
  'webpack-object': {},
  'webpack-array': {optimization: {moduleIds: 'natural', chunkIds: 'natural'}},
  'webpack-global': {output: {chunkLoadingGlobal: 'corpusChunks'}},
  'webpack-federation': {
    plugins: [
      new webpack.container.ModuleFederationPlugin({name: 'corpus', filename: 'remoteEntry.js', exposes: {'./chart': './src/chart.js'}}),
    ],
  },
  'webpack-concatenated': {optimization: {concatenateModules: true}},
}
for (const [name, extra] of Object.entries(variants)) {
  const dir = join(work, name)
  const config: webpack.Configuration = {
    mode: 'production',
    context: work,
    entry: './src/app.js',
    devtool: 'source-map',
    plugins: extra.plugins ?? [],
    output: {path: dir, filename: '[name].js', chunkFilename: 'chunks/[name].js', publicPath: '/', ...extra.output},
    optimization: {concatenateModules: false, splitChunks: {chunks: 'all', minSize: 0}, ...extra.optimization},
  }
  await new Promise<void>((resolve, reject) =>
    webpack(config, (error, stats) => (error || stats!.hasErrors() ? reject(error || new Error(stats!.toString())) : resolve())),
  )
  builds.push({name, version: require('webpack/package.json').version, dir, merges: name === 'webpack-concatenated'})
}

const next16 = join(root, 'artifacts/accuracy-corpus/project/next/.next/static')
assert(globSync('**/*.js', {cwd: next16}).length, 'run scripts/verify-corpus.ts first; its Next.js build is reused')
builds.push({name: 'next-turbopack', version: require('next/package.json').version, dir: next16, merges: true})

// An older Turbopack in its own npm project, so its `next` never resolves to the workspace's.
const next15 = join(work, 'next15')
await mkdir(join(next15, 'pages'), {recursive: true})
await copyFile(join(root, 'fixtures/corpus/page.jsx'), join(next15, 'pages/index.jsx'))
for (const file of ['startup.js', 'chart.js', 'search.js']) await copyFile(join(root, 'fixtures/corpus', file), join(next15, 'pages', file))
await writeFile(
  join(next15, 'package.json'),
  JSON.stringify({
    name: 'coldpath-recovery-next15',
    private: true,
    dependencies: {next: NEXT15, react: require('react/package.json').version, 'react-dom': require('react-dom/package.json').version},
  }),
)
await writeFile(join(next15, 'next.config.mjs'), 'export default {productionBrowserSourceMaps: true, pageExtensions: ["jsx"]};\n')
const env = {...process.env, NEXT_TELEMETRY_DISABLED: '1'}
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {cwd: next15, env, stdio: 'inherit'})
execFileSync(process.execPath, [join(next15, 'node_modules/next/dist/bin/next'), 'build', '--turbopack'], {
  cwd: next15,
  env,
  stdio: 'inherit',
})
builds.push({name: 'next-turbopack', version: NEXT15, dir: join(next15, '.next/static'), merges: true})

// Bundler runtime code belongs to no module.
const runtime =
  /webpack\/(runtime|bootstrap|before-startup|startup|after-startup)|webpack\/container|\[turbopack\]|turbopack\/.*runtime|\[next\]\/entry|\[externals\]/

async function measure({dir}: {dir: string}) {
  const metrics = {
    files: 0,
    modules: 0,
    loaders: 0,
    single: 0,
    merged: 0,
    unmapped: 0,
    split: 0,
    moduleBytes: 0,
    outsideSegments: 0,
    examples: [] as string[],
  }
  for (const path of globSync('**/*.js', {cwd: dir})) {
    const filename = join(dir, path)
    const code = await readFile(filename, 'utf8')
    const found = chunkModules(code)
    if (!found?.modules.length) continue
    const mapText = await readMap(filename, code, dir)
    assert(mapText, `${path}: every recovered chunk in these builds has a source map`)
    const map = AnyMap(JSON.parse(mapText as unknown as string))
    // Mapping segments by generated UTF-16 offset. A segment's source runs on past a module's end until the next
    // segment, so only segments that start inside a range are evidence about that range.
    const lineStarts = [0]
    for (const match of code.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) lineStarts.push(match.index + match[0].length)
    const segments: [number, string][] = []
    eachMapping(map, ({generatedLine, generatedColumn, source}) => {
      if (source && !runtime.test(source)) segments.push([lineStarts[generatedLine - 1] + generatedColumn, source])
    })
    metrics.files++
    const claimed = new Map()
    const covered = new Uint8Array(code.length)
    for (const {id, header, start, end} of found.modules) {
      covered.fill(1, header, end)
      const sources = new Set(segments.filter(([offset]) => offset >= start && offset < end).map(([, source]) => source))
      metrics.modules++
      metrics.moduleBytes += end - start
      // Turbopack's generated async loaders (`e.v(t => ...t(id))`) have no source of their own; maps attribute them to a neighbor.
      if (/^\{\w+\.v\(/.test(code.slice(start, end))) {
        metrics.loaders++
        continue
      }
      if (sources.size === 1) metrics.single++
      else if (sources.size) {
        metrics.merged++
        if (metrics.examples.length < 3) metrics.examples.push(`${path} ${id}: ${[...sources].slice(0, 3).join(', ')}`)
      } else metrics.unmapped++
      // A source owning the whole of one recovered module must not also own code in another one.
      if (sources.size === 1) {
        const [source] = sources
        if (claimed.has(source)) metrics.split++
        claimed.set(source, id)
      }
    }
    metrics.outsideSegments += segments.filter(([offset]) => !covered[offset]).length
  }
  return metrics
}

const results = []
for (const build of builds) {
  const metrics = await measure(build)
  assert(metrics.modules > 0, `${build.name} ${build.version}: no modules recovered`)
  assert.equal(metrics.split, 0, `${build.name} ${build.version}: a recovered boundary splits one original module`)
  if (!build.merges)
    assert.equal(
      metrics.merged,
      0,
      `${build.name} ${build.version}: without concatenation every module maps to one source: ${metrics.examples}`,
    )
  results.push({build: build.name, version: build.version, ...metrics})
  console.log('Recovered', build.name, build.version, metrics)
}
await writeFile(join(work, 'results.json'), JSON.stringify(results, null, 2) + '\n')
const md =
  '| Build | Version | Chunks | Modules | Loaders | One source | Several sources | No mapped source | Mappings outside modules |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n' +
  results
    .map(
      (r) =>
        `| ${r.build} | ${r.version} | ${r.files} | ${r.modules} | ${r.loaders} | ${r.single} | ${r.merged} | ${r.unmapped} | ${r.outsideSegments} |`,
    )
    .join('\n') +
  '\n'
await writeFile(join(work, 'RESULTS.md'), md)
console.log(md)
console.log(`Checked recovered module boundaries against source maps in ${relative(root, work)}`)
