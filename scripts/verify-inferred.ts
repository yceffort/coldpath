// snapshot -> modules -> label -> analyze against a local site whose chunk has no reachable map.
import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {chromium} from 'playwright'
import {chunkModules, factoryEdges, inferModules} from '../lib/modules.ts'

const run = promisify(execFile)
assert.deepEqual(
  chunkModules('(this.webpackJsonp=this.webpackJsonp||[]).push([["a"],{x1:function(t,e){e.a=1},"y2":function(){}}]);')?.modules.map(
    (m) => m.id,
  ),
  ['x1', 'y2'],
  'webpack 4 chunks',
)
assert.deepEqual(
  chunkModules(
    '!function(){try{self._sentryDebugIds={}}catch(e){}}(),(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[1],{34:(e)=>{e.exports=1}}]);',
  )?.modules.map((m) => m.id),
  ['34'],
  'chunks joined to a prelude by a comma',
)
// webpack emits import() with arrow functions when the target supports them; a `.then` on anything else stays a plain call,
// including `Promise.resolve()`, which a require in user code shares with import() of a module that needs no chunk.
const arrows = chunkModules(
  '(self.webpackChunk_t=self.webpackChunk_t||[]).push([[1],{5:(e,t,n)=>{n(6);n.e(2).then(()=>n(7));Promise.all([n.e(2),n.e(3)]).then(()=>n.t(8,23));Promise.resolve().then(()=>(n(9)));x.then(()=>n(10));Promise.all([fetch(a)]).then(()=>n(11))}}]);',
)!.modules[0]
assert.deepEqual(
  factoryEdges(arrows.factory, 'webpack').map((edge) => [edge.id, edge.kind]),
  [
    ['6', 'unknown'],
    ['7', 'dynamic'],
    ['8', 'dynamic'],
    ['9', 'unknown'],
    ['10', 'unknown'],
    ['11', 'unknown'],
  ],
  'webpack import() with arrow functions',
)
// A directory with no recognizable modules still writes an empty maps.json into a fresh output directory.
const scopeHoisted = await mkdtemp(join(tmpdir(), 'coldpath-inferred-'))
try {
  await writeFile(join(scopeHoisted, 'index.js'), 'function a(){return 1}\nwindow.v=a()')
  await inferModules({dir: scopeHoisted, out: join(scopeHoisted, 'maps/out')})
  assert.equal(await readFile(join(scopeHoisted, 'maps/out/maps.json'), 'utf8'), '{}\n')
} finally {
  await rm(scopeHoisted, {recursive: true, force: true})
}
const root = fileURLToPath(new URL('../', import.meta.url))
const out = join(root, 'artifacts', 'inferred')
await rm(out, {recursive: true, force: true})
await mkdir(out, {recursive: true})
execFileSync('cargo', ['build', '--locked'], {cwd: root, stdio: 'inherit'})
const env = {...process.env, COLDPATH_ANALYZER: join(root, 'target', 'debug', 'coldpath')}
const cli = (...args: string[]) => run(process.execPath, [join(root, 'bin', 'coldpath.ts'), ...args], {env})

const modules = {
  10: '(e)=>{e.exports="coldpath-sentinel 한🔥"}',
  11: 'function(e){\n  e.exports=function never(){return "shared-common-text only-in-eleven"}\n}',
  12: '(e)=>{e.exports="shared-common-text"}',
  13: '(e)=>{e.exports="shared-common-text"}',
  14: '(e)=>{e.exports="shared-common-text"}',
  // Never executed; recovered graph edges come from these require calls. The nested functions rebind `n`,
  // like a browserify bundle inside a module, so their ids are not edges.
  15: '(e,t,n)=>{n(16);n(15);n.e(3).then(n.bind(n,17));(function(n){n(13)})(0);!function(){var n=function(i){return i};n(14)}()}',
  16: 'function(e,t,n){\n  n(17);n(99)\n}',
  17: '(e,t,n)=>{e.exports=1}',
}
const chunk = `(self.webpackChunk_test=self.webpackChunk_test||[]).push([[1],{${Object.entries(modules)
  .map(([id, code]) => `${id}:${code}`)
  .join(',')}}]);
(function(){var m=self.webpackChunk_test[0][1],x={};m[10](x);var s=document.createElement("script");s.src="/a/"+"dy"+"n.js";document.head.append(s)})()
//# sourceMappingURL=chunk.js.map`
const turbo =
  '(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,20,e=>{e.x="turbo-sentinel"},"21",function(e){\n  e.y=1\n},' +
  '22,e=>{e.i(20);e.A(23)},23,e=>{e.v(t=>Promise.all([]).then(()=>t(21)))}]);'
// Scope-hoisted like Rollup/Vite output: no module registrations, so only a whole-chunk source is possible.
const vite = 'function a(){return "vite-sentinel-a"}\nfunction b(){return "vite-other-b"}\nwindow.v=a()'
const mapped = 'window.mapped=1\n//# sourceMappingURL=mapped.js.map'
const pages: Record<string, [string, string]> = {
  '/': [
    'text/html',
    '<!doctype html><meta charset="utf-8"><script src="/a/chunk.js"></script><script src="/a/turbo.js"></script><script src="/a/vite.js"></script><script src="/a/mapped.js"></script><script>var s=document.createElement("script");s.src="/a/late.js";document.head.append(s)</script>',
  ],
  '/a/chunk.js': ['text/javascript', chunk],
  '/a/turbo.js': ['text/javascript', turbo],
  '/a/vite.js': ['text/javascript', vite],
  '/a/mapped.js': ['text/javascript', mapped],
  '/a/mapped.js.map': [
    'application/json',
    JSON.stringify({version: 3, sources: ['src/mapped.ts'], sourcesContent: ['window.mapped = 1'], names: [], mappings: 'AAAA'}),
  ],
  '/a/dyn.js': ['text/javascript', 'window.dyn=1'],
  '/a/late.js': ['text/javascript', 'window.late=1'],
  // A two-document flow: the click handler runs just before unloading, and shared.js runs different code per page.
  '/start.html': [
    'text/html',
    '<!doctype html><a id="next" href="/second.html">next</a><script src="/f/leave.js"></script><script src="/f/shared.js"></script>',
  ],
  '/second.html': [
    'text/html',
    '<!doctype html><script src="/f/shared.js"></script><script src="/f/second.js"></script><script>var s=document.createElement("script");s.src="/f/"+"late2.js";document.head.append(s);window.x="late2.js"</script>',
  ],
  '/f/leave.js': [
    'text/javascript',
    'function leaving(){return "leave-sentinel"}\ndocument.getElementById("next").onclick=()=>{window.left=leaving()}',
  ],
  '/f/shared.js': ['text/javascript', 'function onlySecond(){return 2}\nif(location.pathname==="/second.html")onlySecond()'],
  '/f/second.js': ['text/javascript', 'window.second=1'],
  '/f/late2.js': ['text/javascript', 'window.late2=1'],
}
const site = createServer((request, response) => {
  const page = pages[request.url!]
  if (!page) return response.writeHead(404).end()
  response.setHeader('content-type', page[0] + '; charset=utf-8')
  response.end(page[1])
})
// Answers from source text: module 10 gets real evidence, 11 only a common string, the rest an absent one.
const answer = (text: string) => {
  const source = JSON.parse(text).source
  if (source.includes('/chunk/')) {
    return {
      summary: 'chunk summary',
      shortName: 'guess-chunk',
      reasoning: 'because',
      contents: source.endsWith('/vite.js')
        ? [
            {name: 'lib-a', kind: 'package', evidence: ['vite-sentinel-a']},
            {name: 'lib-b', kind: 'package', evidence: ['absent from the chunk']},
          ]
        : [{name: 'lib-x', kind: 'package', evidence: ['absent from the chunk']}],
    }
  }
  const evidence = source.endsWith('/10.js')
    ? ['coldpath-sentinel', 'absent from the module']
    : source.endsWith('/11.js')
      ? ['shared-common-text']
      : ['absent from the module']
  return {
    summary: 'summary of ' + source,
    name: 'guess-' + source.split('/').pop(),
    shortName: 'guess',
    kind: 'app',
    reasoning: 'because',
    evidence,
  }
}
const requests: {url: string | undefined; json: unknown}[] = []
const model = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const json = JSON.parse(body)
    requests.push({url: request.url, json})
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/chat/completions') {
      assert.equal(json.response_format.json_schema.strict, true)
      response.end(
        JSON.stringify({
          choices: [{message: {content: JSON.stringify(answer(json.messages[1].content))}}],
          usage: {prompt_tokens: 3, completion_tokens: 2},
        }),
      )
    } else {
      assert.equal(json.output_config.format.type, 'json_schema')
      const value = answer(json.messages[0].content)
      response.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: json.model,
          stop_reason: 'end_turn',
          content: [{type: 'text', text: JSON.stringify({summary: value.summary})}],
          usage: {input_tokens: 3, output_tokens: 2},
        }),
      )
    }
  })
})
await Promise.all([site, model].map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))))
const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`
try {
  await cli('snapshot', '--url', origin + '/', '--out', out, '--wait-ms', '500')
  const host = new URL(origin).host
  const loading = JSON.parse(await readFile(join(out, 'loading.json'), 'utf8')).bundles
  assert.equal(loading[`${host}/a/chunk.js`].load, 'html')
  assert.equal(loading[`${host}/a/late.js`].load, 'inline')
  assert.equal(loading[`${host}/a/dyn.js`].load, 'dynamic')
  assert.equal(loading[`${host}/a/chunk.js`].initiator, 'parser')
  // The declared map is a 404: snapshot binds an empty map so analysis does not fail.
  assert.deepEqual(JSON.parse(await readFile(join(out, 'maps.json'), 'utf8')), {
    [`${host}/a/chunk.js`]: `maps/${host}/a/chunk.js.map`,
    [`${host}/a/mapped.js`]: `files/${host}/a/mapped.js.map`,
  })
  assert.equal(await readFile(join(out, 'files', host, 'a', 'chunk.js'), 'utf8'), chunk)

  await cli(
    'modules',
    '--dir',
    join(out, 'files'),
    '--out',
    join(out, 'modules'),
    '--maps-json',
    join(out, 'maps.json'),
    '--chunks',
    '--graph',
    join(out, 'modules', 'graph.json'),
  )
  const graph = JSON.parse(await readFile(join(out, 'modules', 'graph.json'), 'utf8'))
  assert.equal(graph.bundler, 'recovered')
  assert.match(graph.warnings.join(' '), /not exported by a bundler/)
  assert.deepEqual(
    graph.edges
      .map(({from, to, kind, location}: {from: string; to: string; kind: string; location: unknown}) => [from, to, kind, location])
      .sort(),
    [
      ['TURBOPACK/22', 'TURBOPACK/20', 'static', {line: 1, column: 2}],
      ['TURBOPACK/22', 'TURBOPACK/23', 'dynamic', {line: 1, column: 10}],
      ['TURBOPACK/23', 'TURBOPACK/21', 'dynamic', {line: 1, column: 34}],
      ['webpackChunk_test/15', 'webpackChunk_test/16', 'unknown', {line: 1, column: 2}],
      ['webpackChunk_test/15', 'webpackChunk_test/17', 'dynamic', {line: 1, column: 26}],
      ['webpackChunk_test/16', 'webpackChunk_test/17', 'unknown', {line: 2, column: 3}],
    ].sort(),
    'require calls become edges; self references, rebound names and unknown ids do not',
  )
  assert.deepEqual(
    graph.modules
      .filter((m: {entry?: boolean}) => !m.entry)
      .map((m: {id: string}) => m.id)
      .sort(),
    ['TURBOPACK/20', 'TURBOPACK/21', 'TURBOPACK/23', 'webpackChunk_test/16', 'webpackChunk_test/17'],
  )
  const recovered = JSON.parse(await readFile(join(out, 'modules', 'maps.json'), 'utf8'))
  assert(!recovered[`${host}/a/mapped.js`], 'a script with a real map is left alone')
  assert(recovered[`${host}/a/vite.js`] && recovered[`${host}/a/chunk.js`])
  const analyze = (...extra: string[]) =>
    cli(
      'analyze',
      '--dir',
      join(out, 'files'),
      '--coverage',
      join(out, 'coverage.json'),
      '--url-prefix',
      'http://',
      '--maps-json',
      join(out, 'maps.json'),
      '--maps-json',
      join(out, 'modules', 'maps.json'),
      '--loading',
      join(out, 'loading.json'),
      '--details',
      ...extra,
    )
  await analyze('--json', join(out, 'report.json'))
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'))
  const bundle = report.bundles.find((row: {path: string}) => row.path === `${host}/a/chunk.js`)
  assert.equal(bundle.loading.load, 'html')
  // A source is the factory body; the `id:(e)=>` header stays unmapped, as do line terminators.
  const body = (code: string) => code.slice(code.indexOf('{'))
  for (const [id, code] of Object.entries(modules)) {
    const row = bundle.sources.find((source: {source: string}) => source.source === `webpack://inferred/webpackChunk_test/${id}.js`)
    assert.equal(row.bytes, Buffer.byteLength(body(code).replaceAll('\n', '')), `module ${id} bytes`)
    assert.equal(row.content, body(code))
  }
  const byId = (id: number) => bundle.sources.find((source: {source: string}) => source.source.endsWith(`/${id}.js`))
  assert.equal(byId(10).unobservedBytes, 0, 'module 10 ran completely')
  assert.equal(byId(10).observedBytes, byId(10).bytes)
  assert.equal(byId(11).observedBytes, 0, 'module 11 factory never ran')
  assert.equal(
    bundle.sources.reduce((sum: number, row: {bytes: number}) => sum + row.bytes, 0),
    bundle.bytes,
  )
  assert.equal(bundle.bytes, Buffer.byteLength(chunk), 'bundle totals keep the header bytes, under [unmapped]')
  const why = await analyze('--graph', join(out, 'modules', 'graph.json'), '--why', 'webpack://inferred/webpackChunk_test/16.js')
  assert.match(
    why.stdout + why.stderr,
    /Import path \(recovered graph\): webpackChunk_test\/15\.js -> webpackChunk_test\/16\.js\n\s+webpackChunk_test\/15\.js:1:2 --Unknown--> webpackChunk_test\/16\.js/,
  )
  assert.match(why.stderr, /Graph source snapshots: 12 matched sourcesContent/)
  const turbopack = report.bundles.find((row: {path: string}) => row.path === `${host}/a/turbo.js`)
  for (const [id, text] of [
    ['20', '{e.x="turbo-sentinel"}'],
    ['21', '{\n  e.y=1\n}'],
  ]) {
    const row = turbopack.sources.find((source: {source: string}) => source.source === `webpack://inferred/TURBOPACK/${id}.js`)
    assert.equal(row.content, text)
    assert.equal(row.bytes, Buffer.byteLength(text.replaceAll('\n', '')), `Turbopack module ${id} bytes`)
  }

  // Line terminators stay [unmapped]; everything else belongs to the one whole-chunk source.
  const whole = report.bundles
    .find((row: {path: string}) => row.path === `${host}/a/vite.js`)
    .sources.filter((row: {source: string}) => row.source !== '[unmapped]')
  assert.deepEqual(
    whole.map((row: {source: string}) => row.source),
    [`webpack://inferred/chunk/${host}/a/vite.js`],
  )
  assert.equal(whole[0].bytes, Buffer.byteLength(vite.replaceAll('\n', '')))
  assert.deepEqual(
    report.bundles
      .find((row: {path: string}) => row.path === `${host}/a/mapped.js`)
      .sources.map((row: {source: string}) => row.source)
      .filter((s: string) => s !== '[unmapped]'),
    [`${host}/a/src/mapped.ts`],
  )

  await run(
    process.execPath,
    [
      join(root, 'bin', 'coldpath.ts'),
      'label',
      '--report',
      join(out, 'report.json'),
      '--out',
      join(out, 'labels.json'),
      '--provider',
      'openai',
      '--model',
      'test-model',
      '--base-url',
      modelUrl + '/v1',
    ],
    {env},
  )
  const labels = JSON.parse(await readFile(join(out, 'labels.json'), 'utf8'))
  assert.deepEqual(labels.generator, {provider: 'openai', model: 'test-model', mode: 'identify'})
  const label = (id: number) => labels.sources[`webpack://inferred/webpackChunk_test/${id}.js`]
  assert.deepEqual(label(10).evidence, ['coldpath-sentinel'], 'absent evidence is dropped')
  assert.deepEqual(label(11), {summary: 'summary of webpack://inferred/webpackChunk_test/11.js'}, 'common evidence rejects the guess')
  assert.deepEqual(Object.keys(label(12)), ['summary'], 'absent-only evidence rejects the guess')
  assert(
    !Object.keys(labels.sources).some((source) => !source.startsWith('webpack://inferred/')),
    'identify mode only guesses recovered modules',
  )
  assert.deepEqual(
    labels.sources[`webpack://inferred/chunk/${host}/a/vite.js`],
    {
      shortName: 'guess-chunk',
      summary: 'chunk summary',
      reasoning: 'because',
      contents: [{name: 'lib-a', kind: 'package', evidence: ['vite-sentinel-a']}],
    },
    'chunk parts keep only evidenced entries',
  )
  assert.deepEqual(
    labels.sources[`webpack://inferred/chunk/${host}/a/dyn.js`],
    {summary: 'chunk summary'},
    'a chunk with no evidenced part keeps its summary',
  )

  await run(
    process.execPath,
    [
      join(root, 'bin', 'coldpath.ts'),
      'label',
      '--report',
      join(out, 'report.json'),
      '--out',
      join(out, 'described.json'),
      '--mode',
      'describe',
    ],
    {env: {...env, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: modelUrl}},
  )
  const described = JSON.parse(await readFile(join(out, 'described.json'), 'utf8'))
  assert.equal(described.generator.provider, 'anthropic')
  // Describe covers every source with content; here only recovered modules have content.
  const withContent = new Set(
    report.bundles
      .flatMap((row: {sources: unknown[]}) => row.sources)
      .filter((row: {content?: string}) => row.content)
      .map((row: {source: string}) => row.source),
  )
  assert.equal(Object.keys(described.sources).length, withContent.size)
  assert(described.sources[`${host}/a/src/mapped.ts`], 'describe covers real source-mapped sources')
  assert(Object.values<object>(described.sources).every((row) => Object.keys(row).join() === 'summary'))
  assert(requests.some((row) => row.url === '/v1/messages'))

  await analyze('--labels', join(out, 'labels.json'), '--json', join(out, 'labeled.json'), '--treemap', join(out, 'labeled.html'))
  const labeled = JSON.parse(await readFile(join(out, 'labeled.json'), 'utf8'))
  assert.equal(labeled.totals.bytes, report.totals.bytes)
  assert.equal(labeled.sources.find((row: {source: string}) => row.source.endsWith('/10.js')).label.name, 'guess-10.js')

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const errors: Error[] = []
    page.on('pageerror', (error) => errors.push(error))
    await page.goto('file://' + join(out, 'labeled.html'))
    const rows = await page.locator('#rows button').allTextContents()
    assert.deepEqual(rows.sort(), ['Initial HTML tags', 'Loaded by scripts', 'Named in initial HTML data'])
    await page.fill('#search', 'guess-10')
    for (let i = 0; i < 6 && (await page.locator('#file').isHidden()); i++) await page.locator('#rows button').first().click()
    assert.match((await page.locator('#scope').textContent())!, /^≈ guess \(10\.js\)$/)
    assert.match(
      (await page.locator('#file').textContent())!,
      /Inferred identity: guess-10\.js \(app\).*coldpath-sentinel.*not source-map evidence/s,
    )
    assert.match((await page.locator('#file').textContent())!, /Bundle loaded.*Initial HTML tags \(initiator: parser\)/s)
    await page.goto('file://' + join(out, 'labeled.html'))
    await page.fill('#search', 'lib-a')
    for (let i = 0; i < 6 && (await page.locator('#file').isHidden()); i++) await page.locator('#rows button').first().click()
    assert.match((await page.locator('#file').textContent())!, /Inferred contents of this chunk.*lib-a \(package\): vite-sentinel-a/s)
    assert.doesNotMatch((await page.locator('#file').textContent())!, /lib-b/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
  // A full-page navigation: each document is recorded before it unloads, and load causes use that document's HTML.
  const multi = join(out, 'multi')
  await mkdir(multi, {recursive: true})
  await writeFile(
    join(multi, 'next.mjs'),
    "export default async ({page}) => { await Promise.all([page.waitForURL('**/second.html'), page.click('#next')]); await page.waitForTimeout(300) }",
  )
  await cli('snapshot', '--url', origin + '/start.html', '--out', multi, '--wait-ms', '0', '--actions', join(multi, 'next.mjs'))
  const multiLoading = JSON.parse(await readFile(join(multi, 'loading.json'), 'utf8')).bundles
  assert.deepEqual(
    Object.fromEntries(['leave', 'shared', 'second', 'late2'].map((name) => [name, multiLoading[`${host}/f/${name}.js`]?.load])),
    {leave: 'html', shared: 'html', second: 'html', late2: 'inline'},
    'second-page scripts are classified against the second document',
  )
  await cli(
    'analyze',
    '--dir',
    join(multi, 'files'),
    '--coverage',
    join(multi, 'coverage.json'),
    '--url-prefix',
    'http://',
    '--json',
    join(multi, 'report.json'),
  )
  const multiReport = JSON.parse(await readFile(join(multi, 'report.json'), 'utf8'))
  const multiBundle = (name: string) => multiReport.bundles.find((row: {path: string}) => row.path === `${host}/f/${name}.js`)
  assert.equal(multiBundle('leave').unobservedBytes, 0, 'code that ran just before unloading is recorded')
  assert.equal(multiBundle('shared').unobservedBytes, 0, 'recordings of both documents are unioned')
  assert.equal(multiBundle('second').unobservedBytes, 0)

  // Scenarios accumulate in one directory until the site serves a different copy of a script.
  const flows = join(out, 'flows')
  for (const scenario of ['first', 'second'])
    await cli('snapshot', '--url', origin + '/', '--out', flows, '--wait-ms', '0', '--scenario', scenario)
  const first = JSON.parse(await readFile(join(flows, 'coverage', 'first.json'), 'utf8'))
  const second = JSON.parse(await readFile(join(flows, 'coverage', 'second.json'), 'utf8'))
  assert.equal(first.length, second.length)
  assert.equal(JSON.parse(await readFile(join(flows, 'loading.json'), 'utf8')).bundles[`${host}/a/chunk.js`].load, 'html')
  pages['/a/dyn.js'][1] = 'window.dyn=2'
  await assert.rejects(
    cli('snapshot', '--url', origin + '/', '--out', flows, '--wait-ms', '500', '--scenario', 'third'),
    /dyn\.js differs from the copy an earlier snapshot saved/,
  )
  // An installed browser by Playwright channel; an unknown channel fails in Playwright's launch.
  const channel = join(out, 'channel')
  await cli('snapshot', '--url', origin + '/', '--out', channel, '--wait-ms', '0', '--browser-channel', 'chromium')
  assert(JSON.parse(await readFile(join(channel, 'coverage.json'), 'utf8')).length)
  await assert.rejects(cli('snapshot', '--url', origin + '/', '--out', channel, '--browser-channel', 'no-such-channel'), /no-such-channel/)
  console.log('verified snapshot, module recovery, labeling and annotated reports')
} finally {
  site.close()
  model.close()
}
