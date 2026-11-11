// Checks what lib/analyzer.ts says when no analyzer can start on musl Linux. The platform and Node's glibc report are faked: this is not run on Alpine.
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

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
  ({message}: Error) => /needs glibc and this system uses musl/.test(message) && /COLDPATH_ANALYZER/.test(message),
  'musl names the way out',
)
fake('2.35')
assert.throws(
  () => runAnalyzer(['--version']),
  ({message}: Error) => /Rust analyzer not found/.test(message) && !/glibc/.test(message),
  'glibc keeps the generic message',
)
console.log('Verified the analyzer wrapper message for musl with a faked platform report (not run on Alpine).')
