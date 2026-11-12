import {spawnSync} from 'node:child_process'
import {closeSync, existsSync, openSync, readSync, statSync} from 'node:fs'
import {createRequire} from 'node:module'
import {delimiter, dirname, join} from 'node:path'

const executable = process.platform === 'win32' ? 'coldpath.exe' : 'coldpath'

// npm and pnpm install this package's `coldpath` bin as a script or a symlink to one;
// the Rust analyzer is a native binary, so a candidate starting with `#!` is the wrapper itself.
function isScript(path: string) {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(2)
    return readSync(fd, head, 0, 2, 0) === 2 && head.toString() === '#!'
  } finally {
    closeSync(fd)
  }
}

// Node's report names the glibc it runs on, and the field is absent on musl.
const musl = () =>
  process.platform === 'linux' && !(process.report.getReport() as {header: {glibcVersionRuntime?: string}}).header.glibcVersionRuntime

// COLDPATH_ANALYZER, then the platform package, then the native coldpath on PATH.
export function analyzerPath() {
  if (process.env.COLDPATH_ANALYZER) return process.env.COLDPATH_ANALYZER
  const platform = `@yceffort/coldpath-${process.platform}-${process.arch}`
  // Linux has a package linked against glibc and a static one built for musl, which runs on either.
  const installed = (process.platform === 'linux' ? [platform, `${platform}-musl`] : [platform]).flatMap((name) => {
    try {
      const candidate = join(dirname(createRequire(import.meta.url).resolve(`${name}/package.json`)), 'bin', executable)
      return existsSync(candidate) ? [candidate] : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
      return []
    }
  })
  // A package manager that honors libc installs one of the two. One that does not installs both, and only then is the libc asked.
  if (installed.length) return installed[installed.length > 1 && musl() ? 1 : 0]
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, executable)
    if (directory && statSync(candidate, {throwIfNoEntry: false})?.isFile() && !isScript(candidate)) return candidate
  }
  return executable
}

export function runAnalyzer(args: string[]) {
  const binary = analyzerPath()
  const result = spawnSync(binary, args, {stdio: 'inherit'})
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    // The analyzer linked against glibc fails to start on musl with ENOENT for its missing loader although the file is installed.
    if (musl())
      throw new Error(
        `No Rust analyzer that runs here (${binary}). This system uses musl (Alpine), where the analyzer linked against glibc cannot start. Install @yceffort/coldpath-linux-${process.arch}-musl, or build the analyzer from source with Rust 1.88 or newer (cargo install --git https://github.com/yceffort/coldpath --locked) and set COLDPATH_ANALYZER to its path.`,
      )
    throw new Error(
      `Rust analyzer not found (${binary}). Install @yceffort/coldpath-${process.platform}-${process.arch}, set COLDPATH_ANALYZER, or install the native coldpath binary on PATH.`,
    )
  }
  if (result.error) throw result.error
  return result.status ?? 1
}
