// Checks which analyzer package lib/analyzer.ts picks on Linux and what it says when none can start on musl.
// The platform, Node's glibc report and the installed packages are faked; scripts/verify-alpine.ts runs on Alpine.
import assert from 'node:assert/strict'
import {copyFile, mkdir, mkdtemp, realpath, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

const fake = (glibcVersionRuntime?: string) => {
  Object.defineProperty(process, 'platform', {value: 'linux'})
  Object.defineProperty(process.report, 'getReport', {value: () => ({header: {glibcVersionRuntime}}), configurable: true})
}
const {runAnalyzer} = await import('../lib/analyzer.ts')
delete process.env.COLDPATH_ANALYZER
process.env.PATH = await mkdtemp(join(tmpdir(), 'coldpath-analyzer-'))

fake()
assert.throws(
  () => runAnalyzer(['--version']),
  ({message}: Error) =>
    /This system uses musl/.test(message) &&
    message.includes(`@yceffort/coldpath-linux-${process.arch}-musl`) &&
    /COLDPATH_ANALYZER/.test(message),
  'musl names the way out',
)
fake('2.35')
assert.throws(
  () => runAnalyzer(['--version']),
  ({message}: Error) => /Rust analyzer not found/.test(message) && !/musl/.test(message),
  'glibc keeps the generic message',
)

// A copy of the module resolves packages from its own directory, where the test installs empty ones.
const project = await realpath(await mkdtemp(join(tmpdir(), 'coldpath-analyzer-')))
await copyFile(new URL('../lib/analyzer.ts', import.meta.url), join(project, 'analyzer.ts'))
const {analyzerPath} = (await import(pathToFileURL(join(project, 'analyzer.ts')).href)) as typeof import('../lib/analyzer.ts')
const install = async (suffix: string) => {
  const directory = join(project, 'node_modules', `@yceffort/coldpath-linux-${process.arch}${suffix}`)
  await mkdir(join(directory, 'bin'), {recursive: true})
  await writeFile(join(directory, 'package.json'), '{}')
  await writeFile(join(directory, 'bin/coldpath'), '')
  return join(directory, 'bin/coldpath')
}
const musl = await install('-musl')
fake()
assert.equal(analyzerPath(), musl, 'musl with the musl package')
fake('2.35')
assert.equal(analyzerPath(), musl, 'the only installed package is used whatever the libc')
const glibc = await install('')
assert.equal(analyzerPath(), glibc, 'glibc with both packages')
fake()
assert.equal(analyzerPath(), musl, 'musl with both packages')
console.log('Verified the analyzer package the wrapper picks and its message for musl, with a faked platform report and packages.')
