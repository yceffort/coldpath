// A real Next.js App Router build with Turbopack, whose home page links to two routes. Chunks that only router
// prefetches for those routes loaded are left out of the recording; a chunk the page went on to use stays.
import assert from 'node:assert/strict'
import {execFile, execFileSync, spawn} from 'node:child_process'
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const project = join(root, 'artifacts', 'next-prefetch')
const out = join(project, 'out')
await rm(project, {recursive: true, force: true})
const files: Record<string, string> = {
  'package.json': JSON.stringify({name: 'coldpath-next-prefetch', private: true}),
  'next.config.mjs': 'export default {productionBrowserSourceMaps: true}\n',
  'app/layout.jsx': 'export default function Layout({children}) {\n  return <html lang="en"><body>{children}</body></html>\n}\n',
  'app/page.jsx':
    'import Link from \'next/link\'\n\nexport default function Home() {\n  return <main><Link href="/about">about</Link> <Link href="/tags">tags</Link></main>\n}\n',
}
for (const name of ['about', 'tags']) {
  files[`app/${name}/page.jsx`] = "import View from './View'\n\nexport default function Page() {\n  return <View />\n}\n"
  files[`app/${name}/View.jsx`] =
    `'use client'\nimport {useState} from 'react'\n\nexport default function View() {\n  const [open, setOpen] = useState(false)\n  return <button onClick={() => setOpen(!open)}>{open ? '${name} details' : '${name} view'}</button>\n}\n`
}
for (const [file, text] of Object.entries(files)) {
  await mkdir(dirname(join(project, file)), {recursive: true})
  await writeFile(join(project, file), text)
}
const nextBin = join(root, 'node_modules/next/dist/bin/next')
const env = {...process.env, NEXT_TELEMETRY_DISABLED: '1'}
execFileSync(process.execPath, [nextBin, 'build', project], {cwd: root, env, stdio: 'inherit'})
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const binary = join(root, 'target', 'debug', 'coldpath')

// The chunk that holds each route's client component, found by its button text.
const statics = join(project, '.next', 'static')
const chunks = (await readdir(join(statics, 'chunks'))).filter((file) => file.endsWith('.js'))
const holding = async (text: string) => {
  const found = []
  for (const file of chunks) if ((await readFile(join(statics, 'chunks', file), 'utf8')).includes(text)) found.push(`chunks/${file}`)
  assert.equal(found.length, 1, `${text}: ${found}`)
  return found[0]
}
const about = await holding('about view')
const tags = await holding('tags view')

const reservation = createServer()
await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = (reservation.address() as AddressInfo).port
await new Promise((resolve) => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [nextBin, 'start', project, '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: root,
  env,
  stdio: 'ignore',
})
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(base)).ok) break
    } catch {}
    assert(attempt < 100 && server.exitCode === null, 'Next server did not start')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const collect = (scenario: string, extra: string[]) =>
    run(process.execPath, [
      join(root, 'bin', 'coldpath.ts'),
      'collect',
      '--url',
      `${base}/`,
      '--dir',
      statics,
      '--prefix',
      '/_next/static/',
      '--scenario',
      scenario,
      '--out',
      join(out, `${scenario}.coverage.json`),
      ...extra,
    ])
  const read = async (scenario: string) => JSON.parse(await readFile(join(out, `${scenario}.coverage.json`), 'utf8'))
  const prefetched = (path: string, route: string) => ({path, url: `${base}/_next/static/${path}`, routes: [route]})

  // The home page prefetches both linked routes, which load their client chunks without evaluating them.
  const {stderr} = await collect('initial', [])
  assert(stderr.includes('initial: left out scripts that only router prefetches for other routes loaded: '), stderr)
  const initial = await read('initial')
  assert.deepEqual(
    initial.prefetchedScripts,
    [prefetched(about, '/about'), prefetched(tags, '/tags')].sort((a, b) => a.path.localeCompare(b.path)),
  )
  assert(!initial.scripts.some((s: any) => s.path === about || s.path === tags))

  // After navigating to /about, its chunk ran, so it is recorded; the tags chunk is still only prefetched.
  const actions = join(out, 'navigate.mjs')
  await writeFile(
    actions,
    "export default async function ({page}) {\n  await page.getByRole('link', {name: 'about'}).click()\n  await page.getByRole('button', {name: 'about view'}).click()\n  await page.getByRole('button', {name: 'about details'}).waitFor()\n}\n",
  )
  await collect('navigate', ['--actions', actions])
  const navigate = await read('navigate')
  assert.deepEqual(navigate.prefetchedScripts, [prefetched(tags, '/tags')])
  assert(navigate.scripts.some((s: any) => s.path === about))

  // Another route's component that no scenario ran is unmeasured, not a removal-review candidate.
  const {stdout} = await run(binary, [
    '--dir',
    statics,
    ...['initial', 'navigate'].flatMap((scenario) => ['--coverage', join(out, `${scenario}.coverage.json`)]),
    '--initial-scenario',
    'initial',
    '--json',
    '-',
  ])
  const report = JSON.parse(stdout)
  assert(report.recordingWarnings.some((w: string) => w.startsWith('initial: the collector left out 2 scripts')))
  const view = report.sources.find((s: any) => s.source.endsWith('app/tags/View.jsx'))
  assert(view && view.observedBytes === 0 && view.unobservedBytes === 0 && view.unmeasuredBytes > 0, JSON.stringify(view))
  assert(!report.recommendations.some((r: any) => r.kind === 'removal-review' && r.source.endsWith('app/tags/View.jsx')))
} finally {
  server.kill('SIGTERM')
}
console.log(
  'Verified a Next.js App Router build with Turbopack: prefetched route chunks left out, a navigated route kept, no removal-review for the unvisited route.',
)
