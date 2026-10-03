// Regenerates the payloads that the development server shows in place of an analyzer run: the recorded example with two
// scenarios, as a code inspector (report-payloads.html) and as a treemap without the embedded inspector (treemap.json).
import {execFileSync} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const example = join(root, 'examples/recorded')
const work = await mkdtemp(join(tmpdir(), 'coldpath-ui-sample-'))
try {
  execFileSync(
    'cargo',
    [
      'run',
      '--locked',
      '--quiet',
      '--',
      '--dir',
      example,
      '--coverage',
      join(example, 'initial.coverage.json'),
      '--coverage',
      join(example, 'interaction.coverage.json'),
      '--initial-scenario',
      'initial',
      '--source-compression',
      '--details',
      '--html',
      join(work, 'report.html'),
      '--treemap',
      join(work, 'treemap.html'),
    ],
    {cwd: root, stdio: 'inherit'},
  )
  const report = await readFile(join(work, 'report.html'), 'utf8')
  const payloads = report.match(/<script type="application\/json" data-encoding="[^"]*" id="[^"]*">[^<]*<\/script>\n/g)
  if (!payloads) throw new Error('no payloads in the report page')
  await writeFile(new URL('report-payloads.html', import.meta.url), payloads.join(''))
  const treemap = await readFile(join(work, 'treemap.html'), 'utf8')
  const data = JSON.parse(treemap.match(/<script type="application\/json" id="report-data">([^<]*)<\/script>/)![1])
  delete data.inspectorHtml
  await writeFile(new URL('treemap.json', import.meta.url), JSON.stringify(data, null, 2) + '\n')
} finally {
  await rm(work, {recursive: true, force: true})
}
