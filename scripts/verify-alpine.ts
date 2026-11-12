// Runs on Alpine: installs the packed coldpath package and the musl analyzer package into a fresh npm project and analyzes the recorded example there.
// The directory holds both tarballs, from `npm pack` and from `scripts/pack-native.ts --musl` with a binary built for a musl target:
//   docker run --rm --volume "$PWD:/repo:ro" node:24-alpine node /repo/scripts/verify-alpine.ts /repo/artifacts/alpine
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, readdir, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

assert(
  process.platform === 'linux' && !(process.report.getReport() as {header: {glibcVersionRuntime?: string}}).header.glibcVersionRuntime,
  'run this on a musl distribution such as Alpine',
)
const root = fileURLToPath(new URL('../', import.meta.url))
const {version} = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const tarballs = resolve(process.argv[2])
const native = `@yceffort/coldpath-linux-${process.arch}-musl`
const tarball = (name: string) => `file:${join(tarballs, `${name.slice(1).replace('/', '-')}-${version}.tgz`)}`
assert.deepEqual(
  (await readdir(tarballs)).filter((file) => file.endsWith('.tgz')).sort(),
  [`yceffort-coldpath-${version}.tgz`, `yceffort-coldpath-linux-${process.arch}-musl-${version}.tgz`],
  'the directory holds other tarballs than the package and its musl analyzer',
)

const project = await mkdtemp(join(tmpdir(), 'coldpath-alpine-'))
const exec = (command: string, args: string[]) =>
  execFileSync(command, args, {cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']})
await writeFile(
  join(project, 'package.json'),
  JSON.stringify({
    name: 'coldpath-alpine-project',
    private: true,
    dependencies: {'@yceffort/coldpath': tarball('@yceffort/coldpath'), [native]: tarball(native)},
  }),
)
// npm refuses a package whose libc does not match, so this also checks the musl package's manifest.
exec('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'])
assert.deepEqual(JSON.parse(await readFile(join(project, 'node_modules', native, 'package.json'), 'utf8')).libc, ['musl'])

const {analyzerPath} = (await import(
  join(project, 'node_modules/@yceffort/coldpath/build/lib/analyzer.js')
)) as typeof import('../lib/analyzer.ts')
assert.equal(analyzerPath(), join(project, 'node_modules', native, 'bin/coldpath'), 'the wrapper does not pick the musl package')
const coldpath = join(project, 'node_modules/.bin/coldpath')
assert.equal(exec(coldpath, ['--version']).trim(), `coldpath ${version}`)
const example = join(root, 'examples/recorded')
exec(coldpath, [
  'analyze',
  '--dir',
  example,
  '--coverage',
  join(example, 'initial.coverage.json'),
  '--coverage',
  join(example, 'interaction.coverage.json'),
  '--max-unobserved-bytes',
  '85',
  '--max-unmeasured-bytes',
  '0',
  '--json',
  'report.json',
])
assert.deepEqual(JSON.parse(await readFile(join(project, 'report.json'), 'utf8')).totals, {
  bytes: 293,
  observedBytes: 208,
  unobservedBytes: 85,
  unmeasuredBytes: 0,
})
console.log(
  `Verified a fresh install on musl (${process.arch}): npm installs ${native}, the wrapper picks it, and it analyzes the recorded example.`,
)
