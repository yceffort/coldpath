// Identification accuracy of `coldpath label` on the corpus builds: drop the source maps, recover modules, label them,
// and score each guess against the package the real maps say the module came from. Calls the model provider.
// Run after verify-corpus.ts and verify-recovery.ts. Extra arguments go to `coldpath label` (for example --model).
import {execFileSync} from 'node:child_process'
import {globSync} from 'node:fs'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {moduleOwners, score} from './label-score.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const work = join(root, 'artifacts/label-accuracy')
const builds = {
  webpack: join(root, 'artifacts/recovery/webpack-object'),
  'next-turbopack': join(root, 'artifacts/accuracy-corpus/project/next/.next/static'),
}
const env = {...process.env, COLDPATH_ANALYZER: join(root, 'target/debug/coldpath')}
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [join(root, 'bin/coldpath.ts'), ...args], {env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8'})
const percent = ({correct, total}: {correct: number; total: number}) =>
  `${correct}/${total} (${total ? ((100 * correct) / total).toFixed(1) : '0.0'}%)`

await rm(work, {recursive: true, force: true})
const results = []
for (const [name, dir] of Object.entries(builds)) {
  const out = join(work, name)
  // Scripts only, without their sourceMappingURL comments: recovery and labeling must not see the maps.
  for (const path of globSync('**/*.js', {cwd: dir})) {
    const code = await readFile(join(dir, path), 'utf8')
    await mkdir(dirname(join(out, 'files', path)), {recursive: true})
    await writeFile(join(out, 'files', path), code.replace(/\n\/\/[#@] sourceMappingURL=\S+\s*$/, '\n'))
  }
  cli('modules', '--dir', join(out, 'files'), '--out', join(out, 'modules'))
  cli(
    'analyze',
    '--dir',
    join(out, 'files'),
    '--maps-json',
    join(out, 'modules/maps.json'),
    '--details',
    '--json',
    join(out, 'report.json'),
  )
  process.stdout.write(
    cli('label', '--report', join(out, 'report.json'), '--out', join(out, 'labels.json'), '--top', '500', ...process.argv.slice(2)),
  )
  const labels = JSON.parse(await readFile(join(out, 'labels.json'), 'utf8'))
  const result = score(await moduleOwners(dir), labels.sources)
  await writeFile(join(out, 'score.json'), JSON.stringify({generator: labels.generator, ...result}, null, 2) + '\n')
  results.push({name, generator: labels.generator, ...result})
}
console.log(
  '| Build | Model | Labeled modules | Several owners | Guess dropped | Package or app | Exact package | App features (unscored) |',
)
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const r of results) {
  console.log(
    `| ${r.name} | ${r.generator.model} | ${r.modules} | ${r.mixed} | ${r.withoutGuess} | ${percent(r.classification)} | ${percent(r.packageIdentity)} | ${r.applicationFeatureUnscored} |`,
  )
}
