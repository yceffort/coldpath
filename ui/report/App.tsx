import * as stylex from '@stylexjs/stylex'
import {useLayoutEffect, useRef, useState} from 'react'
import {classes} from '../classes.ts'
import type {Report} from '../types.ts'
import {Explorer} from './Explorer.tsx'
import {number, size, sizeParts} from './format.ts'
import {Inspector} from './Inspector.tsx'
import type {Disclosures, View} from './Inspector.tsx'

const narrow = () => matchMedia('(max-width:1050px)').matches
const closed: Disclosures = {sourceInfo: false, mapping: false, ranges: false}

// The treemap opens this page in a frame named `coldpath:{"bundle":…,"source":…,"scenario":…}`.
function frameSelection(report: Report) {
  if (!window.name.startsWith('coldpath:')) return null
  const selection = JSON.parse(window.name.slice('coldpath:'.length))
  if (!Number.isInteger(selection.bundle) || !Number.isInteger(selection.source)) return null
  const row = report.bundles[selection.bundle]?.sources[selection.source]
  if (!row) return null
  return {
    bundle: selection.bundle as number,
    source: selection.source as number,
    scenario: report.scenarios.includes(selection.scenario) ? (selection.scenario as string) : '',
    view: (row.hasContent ? 'original' : 'generated') as View,
  }
}

export function Header({meta}: {meta: string}) {
  const [theme, setTheme] = useState('system')
  return (
    <header {...stylex.props(styles.header)}>
      <div>
        <div {...stylex.props(styles.eyebrow)}>COLDPATH</div>
        <h1>Bundle coverage</h1>
      </div>
      <div {...stylex.props(styles.headerTools)}>
        <span id="meta" {...classes('muted', stylex.props(styles.meta))}>
          {meta}
        </span>
        <select
          id="theme"
          aria-label="Color theme"
          value={theme}
          onChange={(event) => {
            const value = event.currentTarget.value
            setTheme(value)
            if (value === 'system') delete document.documentElement.dataset.theme
            else document.documentElement.dataset.theme = value
          }}
        >
          <option value="system">System theme</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
    </header>
  )
}

// Shown while the report data decodes, or when it cannot be opened.
export function Pending({meta}: {meta: string}) {
  return (
    <main {...stylex.props(styles.main)}>
      <Header meta={meta} />
      <p {...stylex.props(styles.intro)}>Follow unobserved code back to its source.</p>
    </main>
  )
}

export function App({report}: {report: Report}) {
  const [opened] = useState(() => frameSelection(report))
  const [bundle, setBundle] = useState<number | null>(opened?.bundle ?? null)
  const [source, setSource] = useState<number | null>(opened?.source ?? null)
  const [page, setPage] = useState(0)
  const [inspector, setInspector] = useState(Boolean(opened))
  const [focus, setFocus] = useState(Boolean(opened))
  const [view, setView] = useState<View>(opened?.view ?? 'original')
  const [scenario, setScenario] = useState(opened?.scenario ?? '')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState(report.totals.unobservedBytes ? 'unobservedBytes' : 'bytes')
  const [appOnly, setAppOnly] = useState(false)
  const [status, setStatus] = useState('all')
  const [disclosures, setDisclosures] = useState(closed)
  // Every action that reloads the code view starts a new run, even when nothing else changed.
  const [codeRun, setCodeRun] = useState(0)
  const runCode = () => setCodeRun((run) => run + 1)
  const explorerRef = useRef<HTMLElement>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const scrollTo = useRef<'explorer' | 'inspector' | null>(opened ? 'inspector' : null)
  useLayoutEffect(() => {
    const target = scrollTo.current === 'explorer' ? explorerRef : scrollTo.current === 'inspector' ? inspectorRef : null
    scrollTo.current = null
    target?.current?.scrollIntoView({block: 'start'})
  })

  function select(index: number) {
    if (bundle === null) {
      setBundle(index)
      setSource(null)
      setPage(0)
      setInspector(false)
      setFocus(false)
      setSearch('')
    } else {
      const row = report.bundles[bundle].sources[index]
      setSource(index)
      setInspector(true)
      setFocus(false)
      setView(row.hasContent ? 'original' : 'generated')
      setStatus(row.unobservedBytes ? 'unobserved' : 'all')
      if (narrow()) scrollTo.current = 'inspector'
    }
    setDisclosures(closed)
    runCode()
  }

  const totalsNote = report.compression
    ? 'Sum of compressed files: gzip (level 6) ' +
      size(report.compression.gzipBytes) +
      ' / Brotli (quality 5) ' +
      size(report.compression.brotliBytes) +
      '. This is not actual server transfer size or removable code.'
    : null
  return (
    <main {...stylex.props(styles.main)}>
      <Header meta={report.bundles.length + ' chunks'} />
      <p {...stylex.props(styles.intro)}>Follow unobserved code back to its source.</p>
      <div id="summary" {...stylex.props(styles.summary)}>
        {(
          [
            ['bytes', 'Total generated', ''],
            ['observedBytes', 'Observed', 'observed'],
            ['unobservedBytes', 'Unobserved', 'unobserved'],
            ['unmeasuredBytes', 'Unmeasured', 'unmeasured'],
          ] as const
        ).map(([key, label, className]) => {
          const [value, unit] = sizeParts(report.totals[key])
          return (
            <div key={key} title={number(report.totals[key]) + ' UTF-8 bytes'} {...stylex.props(styles.stat)}>
              <small {...stylex.props(styles.statLabel)}>{label}</small>
              <strong {...classes(className, stylex.props(styles.statValue))}>
                {value}
                <span {...stylex.props(styles.statUnit)}>{unit}</span>
              </strong>
            </div>
          )
        })}
      </div>
      <p {...stylex.props(styles.note)}>
        Sizes are uncompressed generated code. Unobserved means not executed in these recordings, not safe to delete. Unmeasured means no
        recording is available.
      </p>
      <div id="workspace" {...stylex.props(styles.workspace, inspector && styles.inspecting, inspector && focus && styles.focused)}>
        <Explorer
          sectionRef={explorerRef}
          report={report}
          bundle={bundle}
          source={source}
          inspecting={inspector}
          hidden={inspector && focus}
          page={page}
          search={search}
          sort={sort}
          appOnly={appOnly}
          onSelect={select}
          onPage={setPage}
          onSearch={(value) => {
            setSearch(value)
            setPage(0)
          }}
          onSort={(value) => {
            setSort(value)
            setPage(0)
          }}
          onAppOnly={(value) => {
            setAppOnly(value)
            setPage(0)
          }}
          onBack={() => {
            setBundle(null)
            setSource(null)
            setPage(0)
            setInspector(false)
            setFocus(false)
            setSearch('')
            setAppOnly(false)
            runCode()
          }}
          onInspectBundle={() => {
            setSource(null)
            setInspector(true)
            setView('generated')
            setDisclosures((open) => ({...open, sourceInfo: false, ranges: false}))
            runCode()
            if (narrow()) scrollTo.current = 'inspector'
          }}
        />
        <Inspector
          sectionRef={inspectorRef}
          report={report}
          bundle={bundle}
          source={source}
          open={inspector}
          focus={focus}
          view={view}
          status={status}
          scenario={scenario}
          codeRun={codeRun}
          disclosures={disclosures}
          onDisclosures={setDisclosures}
          onView={setView}
          onStatus={(value) => {
            setStatus(value)
            runCode()
          }}
          onScenario={(value) => {
            setScenario(value)
            runCode()
          }}
          onToggleFocus={() => setFocus((value) => !value)}
          onClose={() => {
            setInspector(false)
            setSource(null)
            setFocus(false)
            runCode()
            scrollTo.current = 'explorer'
          }}
        />
      </div>
      <section {...stylex.props(styles.panel, styles.notes)}>
        <details open={report.budgetFailures.length > 0}>
          <summary id="warnings-title">
            {'Analysis details and warnings · ' +
              report.warnings.length +
              (report.budgetFailures.length ? ' · Budget failures: ' + report.budgetFailures.length : '')}
          </summary>
          <div id="scenarios">
            <p {...stylex.props(styles.noteText)}>Scenarios: {report.scenarios.join(', ') || 'Static analysis · no recordings'}</p>
            <p {...stylex.props(styles.noteText)}>
              {report.excludedBundles.length} chunks excluded by analysis filters. Totals and budgets cover selected chunks. On-screen
              search and app-code filtering do not change overall totals.
            </p>
            {totalsNote && <p {...stylex.props(styles.noteText)}>{totalsNote}</p>}
          </div>
          <ul id="warnings" {...stylex.props(styles.warnings)}>
            {report.warnings.map((warning, index) => (
              <li key={'w' + index} {...stylex.props(styles.noteText)}>
                {warning}
              </li>
            ))}
            {report.budgetFailures.map((failure, index) => (
              <li key={'b' + index} {...classes('unobserved', stylex.props(styles.noteText))}>
                {'Budget exceeded: ' + failure}
              </li>
            ))}
          </ul>
        </details>
      </section>
    </main>
  )
}

export const styles = stylex.create({
  main: {
    maxWidth: 1720,
    margin: 'auto',
    paddingBlock: {default: 40, '@media (max-width: 1050px)': 32, '@media (max-width: 600px)': 28},
    paddingInline: {default: 40, '@media (max-width: 1050px)': 24, '@media (max-width: 600px)': 16},
  },
  header: {
    display: 'flex',
    alignItems: {default: 'center', '@media (max-width: 600px)': 'start'},
    justifyContent: 'space-between',
    gap: {default: 16, '@media (max-width: 600px)': 10},
    flexWrap: {default: null, '@media (max-width: 600px)': 'wrap'},
  },
  eyebrow: {color: 'var(--observed)', fontSize: 11, letterSpacing: 2},
  headerTools: {display: 'flex', alignItems: 'center', gap: {default: 14, '@media (max-width: 600px)': 12}},
  meta: {fontSize: {default: null, '@media (max-width: 600px)': 11}},
  intro: {
    marginTop: 14,
    color: 'var(--muted)',
    fontSize: {default: null, '@media (max-width: 600px)': 12},
    maxWidth: {default: null, '@media (max-width: 600px)': '30em'},
  },
  summary: {
    display: 'grid',
    gridTemplateColumns: {default: 'repeat(4, minmax(0, 1fr))', '@media (max-width: 600px)': 'repeat(2, minmax(0, 1fr))'},
    gap: {default: 16, '@media (max-width: 600px)': 10},
    marginTop: {default: 32, '@media (max-width: 600px)': 24},
    marginBottom: {default: 14, '@media (max-width: 600px)': 14},
    marginInline: {default: 0, '@media (max-width: 600px)': 0},
  },
  stat: {
    paddingBlock: {default: 22, '@media (max-width: 600px)': 16},
    paddingInline: {default: 24, '@media (max-width: 600px)': 16},
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 12,
  },
  statLabel: {fontSize: {default: null, '@media (max-width: 600px)': 11}},
  statValue: {
    display: 'block',
    marginTop: 8,
    fontSize: {default: 30, '@media (max-width: 600px)': 25},
    lineHeight: 1.3,
    fontWeight: 600,
    letterSpacing: -0.7,
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  statUnit: {
    marginLeft: 5,
    fontSize: {default: 15, '@media (max-width: 600px)': 12},
    letterSpacing: 0,
    color: 'var(--muted)',
    fontWeight: 400,
  },
  note: {fontSize: 12, color: 'var(--muted)'},
  workspace: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: {default: 24, '@media (max-width: 600px)': 18},
    marginTop: {default: 32, '@media (max-width: 600px)': 24},
    alignItems: 'start',
  },
  inspecting: {gridTemplateColumns: {default: '300px minmax(0, 1fr)', '@media (max-width: 1050px)': 'minmax(0, 1fr)'}},
  focused: {gridTemplateColumns: 'minmax(0, 1fr)'},
  panel: {
    minWidth: 0,
    paddingBlock: {default: 26, '@media (max-width: 600px)': 18},
    paddingInline: {default: 26, '@media (max-width: 600px)': 14},
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 14,
    backgroundColor: 'var(--panel)',
  },
  notes: {
    marginTop: 24,
    paddingBlock: {default: 10, '@media (max-width: 600px)': 8},
    paddingInline: {default: 24, '@media (max-width: 600px)': 16},
    backgroundColor: 'transparent',
  },
  noteText: {fontSize: 12, color: 'var(--muted)'},
  warnings: {maxHeight: 250, overflow: 'auto'},
})
