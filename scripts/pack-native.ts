// Packs a built analyzer as @yceffort/coldpath-<platform>-<arch>, the package lib/analyzer.ts resolves.
import {execFileSync} from 'node:child_process'
import {chmod, copyFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {parseArgs} from 'node:util'

const {values} = parseArgs({options: {binary: {type: 'string'}, out: {type: 'string'}}})
if (!values.binary || !values.out) throw new Error('Usage: node scripts/pack-native.ts --binary target/release/coldpath --out DIRECTORY')
const {version, license, repository} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const name = `@yceffort/coldpath-${process.platform}-${process.arch}`
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
      description: `coldpath analyzer binary for ${process.platform}-${process.arch}`,
      os: [process.platform],
      cpu: [process.arch],
      files: ['bin'],
    },
    null,
    2,
  ) + '\n',
)
const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], {cwd: dir, encoding: 'utf8'}).trim().split('\n').at(-1)
console.log(join(out, tarball!))
