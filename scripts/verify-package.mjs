// Installs the packed coldpath package into a fresh project and runs the full workflow
// through its public entry points only: @yceffort/coldpath/rollup, coldpath graph, collect and analyze.
import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {copyFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {extname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const work = join(root, 'artifacts/package')
const project = join(work, 'project')
await rm(work, {recursive: true, force: true})
await mkdir(join(project, 'src'), {recursive: true})
const exec = (command, args, cwd = project) => execFileSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']})

execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const native = exec(
  process.execPath,
  [join(root, 'scripts/pack-native.mjs'), '--binary', join(root, 'target/debug/coldpath'), '--out', work],
  root,
).trim()
const main = join(work, exec('npm', ['pack', '--silent', '--pack-destination', work], root).trim().split('\n').at(-1))
const devDependencies = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies

for (const file of ['entry.js', 'startup.js', 'feature.js']) await copyFile(join(root, 'fixtures', file), join(project, 'src', file))
await writeFile(
  join(project, 'package.json'),
  JSON.stringify({
    name: 'coldpath-fresh-project',
    private: true,
    type: 'module',
    devDependencies: {
      '@yceffort/coldpath': `file:${main}`,
      [`@yceffort/coldpath-${process.platform}-${process.arch}`]: `file:${native}`,
      esbuild: devDependencies.esbuild,
      rollup: devDependencies.rollup,
      playwright: devDependencies['@playwright/test'],
    },
  }),
)
exec('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'])

await writeFile(
  join(project, 'build.mjs'),
  `import {rollup} from 'rollup'
import {build} from 'esbuild'
import coldpathGraph from '@yceffort/coldpath/rollup'
const bundle = await rollup({input: 'src/entry.js', plugins: [coldpathGraph()]})
await bundle.write({dir: 'dist/assets', format: 'esm', sourcemap: true})
await build({entryPoints: ['src/entry.js'], bundle: true, format: 'esm', outdir: 'esbuild', metafile: true, write: false})
  .then(({metafile}) => import('node:fs').then((fs) => fs.writeFileSync('meta.json', JSON.stringify(metafile))))
`,
)
exec(process.execPath, ['build.mjs'])
await writeFile(
  join(project, 'dist/index.html'),
  '<!doctype html><meta charset="utf-8"><script type="module" src="/assets/entry.js"></script>',
)
const coldpath = join(project, 'node_modules/.bin/coldpath')
const graphLog = exec(coldpath, [
  'graph',
  '--format',
  'esbuild',
  '--input',
  'meta.json',
  '--root',
  '.',
  '--out',
  'artifacts/esbuild.graph.json',
])
assert.match(graphLog, /Exported esbuild: 3 modules/)

const server = createServer(async (request, response) => {
  const path = request.url === '/' ? '/index.html' : request.url
  try {
    const body = await readFile(join(project, 'dist', path))
    response.setHeader('content-type', extname(path) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8')
    response.end(body)
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  await writeFile(
    join(project, 'interact.mjs'),
    `export default async function ({page}) {
  if (await page.evaluate(() => globalThis.__coldpathApp.run(true)) !== '한🔥') throw new Error('Interaction did not run')
}\n`,
  )
  await writeFile(
    join(project, 'coldpath.scenarios.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}/`,
      dir: 'dist/assets',
      prefix: '/assets/',
      waitMs: 0,
      out: 'artifacts/coverage',
      scenarios: [{name: 'initial'}, {name: 'interaction', actions: 'interact.mjs'}],
    }),
  )
  // The server runs in this process, so collection must not block the event loop.
  await promisify(execFile)(coldpath, ['collect', '--scenarios', 'coldpath.scenarios.json'], {cwd: project})
  await promisify(execFile)(coldpath, ['profile', '--scenarios', 'coldpath.scenarios.json', '--runs', '2'], {cwd: project})
} finally {
  await new Promise((resolve) => server.close(resolve))
}
exec(coldpath, [
  'analyze',
  '--scenarios',
  'coldpath.scenarios.json',
  '--graph',
  'dist/assets/coldpath.graph.json',
  '--json',
  'artifacts/report.json',
])
const report = JSON.parse(await readFile(join(project, 'artifacts/report.json'), 'utf8'))
assert.deepEqual(report.scenarios, ['initial', 'interaction'])
assert.equal(report.initialScenario, 'initial')
assert(report.importPaths.length > 0, 'graph import paths missing')
assert.equal(report.bundles[0].verification[0].source, 'sha256')
assert(report.totals.unobservedBytes > 0 && report.totals.unmeasuredBytes === 0)
const analyzeScenarios = ['analyze', '--scenarios', 'coldpath.scenarios.json', '--json', 'artifacts/ordered.json']
exec(coldpath, [...analyzeScenarios, '--scenario-order', 'initial,interaction'])
assert.deepEqual(JSON.parse(await readFile(join(project, 'artifacts/ordered.json'), 'utf8')).scenarios, ['initial', 'interaction'])
assert.throws(
  () =>
    execFileSync(coldpath, [...analyzeScenarios, '--scenario-order', 'initial,missing'], {cwd: project, encoding: 'utf8', stdio: 'pipe'}),
  (error) => error.stderr.includes('received ["initial", "missing"], recorded ["initial", "interaction"]'),
)
console.log(
  'Verified a fresh install: @yceffort/coldpath/rollup, coldpath graph, coldpath collect --scenarios, coldpath profile --scenarios, and coldpath analyze --scenarios with and without --scenario-order.',
)
