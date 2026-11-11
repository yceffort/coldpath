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

// COLDPATH_ANALYZER, then the platform package, then the native coldpath on PATH.
export function analyzerPath() {
  if (process.env.COLDPATH_ANALYZER) return process.env.COLDPATH_ANALYZER
  try {
    const manifest = createRequire(import.meta.url).resolve(`@yceffort/coldpath-${process.platform}-${process.arch}/package.json`)
    const candidate = join(dirname(manifest), 'bin', executable)
    if (existsSync(candidate)) return candidate
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
  }
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
    // The prebuilt analyzer is linked against glibc, so on musl it fails to start with ENOENT for its missing loader
    // although the file is installed. Node's report names the glibc it runs on, and the field is absent on musl.
    if (
      process.platform === 'linux' &&
      !(process.report.getReport() as {header: {glibcVersionRuntime?: string}}).header.glibcVersionRuntime
    )
      throw new Error(
        `No Rust analyzer that runs here (${binary}). The prebuilt analyzer needs glibc and this system uses musl (Alpine). Build the analyzer from source with Rust 1.88 or newer (cargo install --git https://github.com/yceffort/coldpath --locked) and set COLDPATH_ANALYZER to its path.`,
      )
    throw new Error(
      `Rust analyzer not found (${binary}). Install @yceffort/coldpath-${process.platform}-${process.arch}, set COLDPATH_ANALYZER, or install the native coldpath binary on PATH.`,
    )
  }
  if (result.error) throw result.error
  return result.status ?? 1
}
