// Packs a built analyzer as @yceffort/coldpath-<platform>-<arch>, the package lib/analyzer.ts resolves.
// --musl packs a binary built for a musl target as @yceffort/coldpath-<platform>-<arch>-musl.
import {execFileSync} from 'node:child_process'
import {chmod, copyFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {parseArgs} from 'node:util'

const {values} = parseArgs({options: {binary: {type: 'string'}, out: {type: 'string'}, musl: {type: 'boolean'}}})
if (!values.binary || !values.out)
  throw new Error('Usage: node scripts/pack-native.ts --binary target/release/coldpath --out DIRECTORY [--musl]')
if (values.musl && process.platform !== 'linux') throw new Error('--musl packs a Linux analyzer, and this is not Linux')
const {version, license, repository} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const name = `@yceffort/coldpath-${process.platform}-${process.arch}${values.musl ? '-musl' : ''}`
const out = resolve(values.out)
const dir = join(out, name)
const executable = process.platform === 'win32' ? 'coldpath.exe' : 'coldpath'
await rm(dir, {recursive: true, force: true})
await mkdir(join(dir, 'bin'), {recursive: true})
await copyFile(values.binary, join(dir, 'bin', executable))
await chmod(join(dir, 'bin', executable), 0o755)
await writeFile(
  join(dir, 'package.json'),
  JSON.stringify(
    {
      name,
      version,
      license,
      repository,
      description: `coldpath analyzer binary for ${process.platform}-${process.arch}${values.musl ? ' (musl)' : ''}`,
      os: [process.platform],
      cpu: [process.arch],
      // The default Linux binary is linked against glibc; package managers that honor libc install the one that matches.
      ...(process.platform === 'linux' && {libc: [values.musl ? 'musl' : 'glibc']}),
      files: ['bin'],
    },
    null,
    2,
  ) + '\n',
)
const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], {cwd: dir, encoding: 'utf8'}).trim().split('\n').at(-1)
console.log(join(out, tarball!))
