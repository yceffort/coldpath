import * as stylex from '@stylexjs/stylex'
import {useLayoutEffect, useMemo, useRef, useState} from 'react'
import type {RefObject} from 'react'
import {classes} from '../classes.ts'
import type {MappingDiagnostic, MappingRef, Report} from '../types.ts'
import {styles as page} from './App.tsx'
import {forgetChunk, loadChunk, spanAt} from './data.ts'
import type {CodeBundle, Span} from './data.ts'
import {basename, labels, number, rejectedCount, size} from './format.ts'

export type View = 'original' | 'generated'
export interface Disclosures {
  sourceInfo: boolean
  mapping: boolean
  ranges: boolean
}

interface Props {
  sectionRef: RefObject<HTMLElement | null>
  report: Report
  bundle: number | null
  source: number | null
  open: boolean
  focus: boolean
  view: View
  status: string
  scenario: string
  codeRun: number
  disclosures: Disclosures
  onDisclosures: (value: Disclosures) => void
  onView: (view: View) => void
  onStatus: (value: string) => void
  onScenario: (value: string) => void
  onToggleFocus: () => void
  onClose: () => void
}

// What one run of the code view shows: the chunk with the selection, filter, and scenario it ran with.
type Code =
  | {phase: 'idle' | 'loading'}
  | {phase: 'error'; message: string}
  | {phase: 'ready'; bundle: CodeBundle; source: number | null; status: string; scenario: string}

const RANGE_PAGE = 100
const NO_MATCH = 'No code ranges match this coverage state.'

// A scenario's spans and counts replace the combined ones.
function withScenario(report: Report, bundle: CodeBundle, scenario: string): CodeBundle {
  if (!scenario) return bundle
  const counts = report.scenarioReports.find((row) => row.scenario === scenario)?.bundles.find((row) => row.path === bundle.path)
  const sources = new Map((counts?.sources || []).map((row) => [row.source, row]))
  return {
    ...bundle,
    ...counts,
    spans: bundle.scenarioSpans?.[scenario] || [],
    sources: bundle.sources.map((source) => ({...source, ...sources.get(source.source)})),
  }
}

const at = (m: MappingRef | null) =>
  m
    ? m.generatedLine +
      1 +
      ':' +
      (m.generatedColumn + 1) +
      ' → ' +
      m.source +
      (m.original ? ':' + (m.original.line + 1) + ':' + (m.original.column + 1) : '')
    : 'none on this line'

export function Inspector(props: Props) {
  const {report} = props
  const [code, setCode] = useState<Code>({phase: 'idle'})
  const [busy, setBusy] = useState<boolean | null>(null)
  const [heading, setHeading] = useState({title: 'Inspect code', meta: '', path: '', binding: ''})
  // `current`: the span shown; `selected`: its position among the matching spans; `visible`: listed range buttons.
  const [nav, setNav] = useState({current: -1, selected: 0, visible: RANGE_PAGE})
  const latest = useRef(props)
  latest.current = props
  const originalRef = useRef<HTMLPreElement>(null)

  // A layout effect, so the code view updates before the next paint, as the original handlers did.
  useLayoutEffect(() => {
    const {open, bundle, source, status, scenario} = latest.current
    if (!open || bundle === null) {
      forgetChunk()
      setCode({phase: 'idle'})
      return
    }
    let current = true
    setCode({phase: 'loading'})
    setBusy(true)
    loadChunk(report, bundle, () => latest.current.open && latest.current.bundle === bundle).then(
      (loaded) => {
        if (!current) return
        const merged = withScenario(report, loaded, scenario)
        const row = source === null ? null : merged.sources[source]
        const path = row ? row.source : merged.path
        setHeading({
          title: basename(path),
          meta:
            (row ? (row.package === '[application]' ? 'App code' : row.package) : 'Entire chunk') +
            ' · ' +
            size((row || merged).bytes) +
            ' · ' +
            (scenario || 'All scenarios combined'),
          path,
          binding: merged.verification.length
            ? merged.verification.map((v) => v.scenario + ' · source ' + v.source + ' / map ' + v.sourceMap).join(' | ')
            : 'No recording · all ranges are unmeasured',
        })
        const first = merged.spans.findIndex((_, index) => matches(spanAt(merged, index), source, status))
        setNav({current: first, selected: 0, visible: RANGE_PAGE})
        setCode({phase: 'ready', bundle: merged, source, status, scenario})
        setBusy(false)
      },
      (error) => {
        if (!current) return
        setCode({phase: 'error', message: (error as Error).message})
        setBusy(false)
      },
    )
    return () => {
      current = false
    }
  }, [props.codeRun])

  const ready = code.phase === 'ready' ? code : null
  const spans = useMemo(() => {
    if (!ready) return []
    return ready.bundle.spans.map((_, index) => index).filter((index) => matches(spanAt(ready.bundle, index), ready.source, ready.status))
  }, [ready])
  const bytes = ready ? spans.reduce((sum, index) => sum + (ready.bundle.spans[index][1] - ready.bundle.spans[index][0]), 0) : 0
  const span = ready && nav.current !== -1 ? spanAt(ready.bundle, nav.current) : null
  const focus = (index: number) =>
    setNav((nav) => {
      const position = spans.indexOf(index)
      return {...nav, current: index, selected: position === -1 ? nav.selected : position}
    })

  useLayoutEffect(() => {
    const scroll = () => {
      const code = originalRef.current!,
        anchor = code.querySelector<HTMLElement>('.source-line.active')
      if (anchor && latest.current.view === 'original') code.scrollTop = Math.max(0, anchor.offsetTop - code.clientHeight * 0.3)
    }
    scroll()
    addEventListener('resize', scroll)
    return () => removeEventListener('resize', scroll)
  }, [span?.index, props.view, props.focus, ready])

  const sourceRow = ready && ready.source !== null ? ready.bundle.sources[ready.source] : null
  const diagnostics: MappingDiagnostic[] = !ready
    ? []
    : sourceRow
      ? (sourceRow.mappingDiagnostics || []).map((i) => ready.bundle.mappingDiagnostics![i])
      : ready.bundle.mappingDiagnostics || []
  const {disclosures} = props
  const toggle = (key: keyof Disclosures) => (event: {currentTarget: HTMLDetailsElement}) => {
    if (disclosures[key] !== event.currentTarget.open) props.onDisclosures({...disclosures, [key]: event.currentTarget.open})
  }

  let activeRange = '',
    activeTitle: string | undefined
  if (code.phase === 'loading') activeRange = 'Loading code…'
  else if (code.phase === 'error') activeRange = 'Could not load code: ' + code.message
  else if (ready && span) {
    activeRange = labels[span.status] + ' · ' + size(span.end - span.start)
    activeTitle = 'Generated UTF-8 range [' + span.start + ', ' + span.end + ')'
  } else if (ready) activeRange = 'No matching ranges'

  return (
    <section
      ref={props.sectionRef}
      id="inspector"
      hidden={!props.open}
      aria-busy={busy === null ? undefined : busy}
      {...stylex.props(page.panel, styles.inspector)}
    >
      <div {...stylex.props(styles.heading)}>
        <div {...stylex.props(styles.headingText)}>
          <h2 id="source-title" {...stylex.props(styles.title)}>
            {heading.title}
          </h2>
          <p id="source-meta" {...stylex.props(styles.meta)}>
            {heading.meta}
          </p>
        </div>
        <div {...stylex.props(styles.tools)}>
          <button id="toggle-explorer" aria-pressed={props.focus} onClick={props.onToggleFocus} {...stylex.props(styles.toggle)}>
            {props.focus ? 'Show file list' : 'Expand code'}
          </button>
          <button
            id="close-inspector"
            aria-label="Close code inspector"
            onClick={props.onClose}
            {...stylex.props(styles.quiet, styles.close)}
          >
            ×
          </button>
        </div>
      </div>
      <details id="source-info" open={disclosures.sourceInfo} onToggle={toggle('sourceInfo')} {...stylex.props(styles.sourceInfo)}>
        <summary>Full path and verification</summary>
        <code id="full-path" {...stylex.props(styles.fullPath)}>
          {heading.path}
        </code>
        <p id="binding" {...stylex.props(styles.binding)}>
          {heading.binding}
        </p>
      </details>
      <details id="mapping-info" hidden={!diagnostics.length} open={disclosures.mapping} onToggle={toggle('mapping')}>
        <summary id="mapping-title">{rejectedCount(diagnostics.length)}</summary>
        <p className="muted">
          These source-map mappings could not be placed and were skipped. Each region lists the bytes whose attribution may differ; it is a
          place to inspect, not a proven error. Totals are unchanged.
        </p>
        <ul id="mapping-list">
          {ready &&
            diagnostics.map((d, i) => {
              const region = d.inspectRegion
              const index = ready.bundle.spans.findIndex((s) => s[1] > region.start)
              return (
                <li key={i}>
                  <strong>
                    {(d.reason === 'insideSurrogatePair' ? 'Inside a surrogate pair' : 'Column outside its line') + ' · generated ' + at(d)}
                  </strong>
                  <div className="muted">{'Previous: ' + at(d.previous) + ' · Next: ' + at(d.next)}</div>
                  <div>
                    {'Inspect UTF-8 [' +
                      region.start +
                      ', ' +
                      region.end +
                      '): ' +
                      (d.assignments.map((a) => a.source + ' [' + a.start + ', ' + a.end + ')').join(', ') || 'no bytes')}
                  </div>
                  {region.start < region.end && index !== -1 && (
                    <button
                      onClick={() => {
                        props.onView('generated')
                        focus(index)
                      }}
                    >
                      Show in generated code
                    </button>
                  )}
                </li>
              )
            })}
        </ul>
      </details>
      <div {...stylex.props(styles.controls)}>
        <div role="group" aria-label="Code view" {...stylex.props(styles.tabs)}>
          {(
            [
              ['original', 'Original source'],
              ['generated', 'Generated code'],
            ] as const
          ).map(([view, label]) => (
            <button
              key={view}
              id={'view-' + view}
              aria-pressed={props.view === view}
              onClick={() => props.onView(view)}
              {...stylex.props(styles.tab, props.view === view && styles.tabPressed)}
            >
              {label}
            </button>
          ))}
        </div>
        <label {...stylex.props(styles.label)}>
          Coverage state{' '}
          <select
            id="status"
            value={props.status}
            onChange={(event) => props.onStatus(event.currentTarget.value)}
            {...stylex.props(styles.select)}
          >
            <option value="all">All</option>
            <option value="unobserved">Unobserved</option>
            <option value="observed">Observed</option>
            <option value="unmeasured">Unmeasured</option>
          </select>
        </label>
        <label {...stylex.props(styles.label)}>
          Scenario{' '}
          <select
            id="code-scenario"
            aria-label="Code scenario"
            value={props.scenario}
            onChange={(event) => props.onScenario(event.currentTarget.value)}
            {...stylex.props(styles.select)}
          >
            <option value="">All scenarios combined</option>
            {report.scenarios.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div {...stylex.props(styles.rangeNav)}>
        <span id="active-range" title={activeTitle} {...stylex.props(styles.activeRange)}>
          {activeRange}
        </span>
        <div {...stylex.props(styles.rangeButtons)}>
          <button
            id="range-prev"
            aria-label="Previous code range"
            disabled={!ready || nav.selected === 0}
            onClick={() => {
              if (nav.selected > 0) focus(spans[nav.selected - 1])
            }}
            {...stylex.props(styles.small)}
          >
            ←
          </button>
          <span id="range-position" aria-live="polite">
            {ready ? (spans.length ? nav.selected + 1 + ' / ' + number(spans.length) : '0 / 0') : ''}
          </span>
          <button
            id="range-next"
            aria-label="Next code range"
            disabled={!ready || nav.selected + 1 >= spans.length}
            onClick={() => {
              if (nav.selected + 1 < spans.length) focus(spans[nav.selected + 1])
            }}
            {...stylex.props(styles.small)}
          >
            →
          </button>
        </div>
      </div>
      <div id="original-view" hidden={props.view !== 'original'}>
        <p {...stylex.props(styles.caption)}>
          Blue marks the selected source-map location, not execution. Coverage applies to the generated range; it does not describe this
          entire original line.
        </p>
        <OriginalLabel bundle={ready?.bundle} span={span} />
        <pre id="original-code" ref={originalRef} tabIndex={0} {...stylex.props(styles.code)}>
          <Original bundle={ready?.bundle} span={span} />
        </pre>
      </div>
      <div id="generated-view" hidden={props.view !== 'generated'}>
        <p {...stylex.props(styles.caption)}>
          Green: observed execution. Orange: unobserved. Gray: unmeasured. Blue outline: selected range.
        </p>
        <pre id="generated" tabIndex={0} {...stylex.props(styles.code)}>
          {ready && span ? (
            <Generated bundle={ready.bundle} span={span} source={ready.source} status={ready.status} onFocus={focus} />
          ) : ready ? (
            NO_MATCH
          ) : null}
        </pre>
      </div>
      <details id="range-details" open={disclosures.ranges} onToggle={toggle('ranges')} {...stylex.props(styles.rangePicker)}>
        <summary {...stylex.props(styles.rangeSummary)}>
          Choose a range
          <span id="range-count" {...stylex.props(styles.rangeCount)}>
            {ready ? number(spans.length) + ' ranges · ' + number(bytes) + ' B' : ''}
          </span>
        </summary>
        <div id="ranges" {...stylex.props(styles.rangeList)}>
          {ready &&
            spans.slice(0, nav.visible).map((index) => {
              const span = spanAt(ready.bundle, index)
              return (
                <button
                  key={index}
                  title={labels[span.status] + ' · generated UTF-8 byte range'}
                  onClick={() => focus(index)}
                  {...classes(span.status, stylex.props(styles.rangeButton))}
                >
                  {'[' + span.start + ', ' + span.end + ')'}
                </button>
              )
            })}
          {ready && nav.visible < spans.length && (
            <button onClick={() => setNav((nav) => ({...nav, visible: nav.visible + RANGE_PAGE}))} {...stylex.props(styles.rangeButton)}>
              Load more ranges
            </button>
          )}
        </div>
      </details>
    </section>
  )
}

const matches = (span: Span, source: number | null, status: string) =>
  (source === null || span.source === source) && (status === 'all' || span.status === status)

function OriginalLabel({bundle, span}: {bundle?: CodeBundle; span: Span | null}) {
  let text = '',
    title: string | undefined
  if (bundle && span) {
    const source = bundle.sources[span.source],
      position = span.original
    if (!position) text = 'No source mapping is available for this range.'
    else {
      text = basename(source.source) + ':' + (position.line + 1) + ':' + (position.column + 1) + ' · source-map anchor (approximate)'
      title = source.source + ' — this is not an exact original-source coverage range.'
    }
  }
  return (
    <p id="original-label" title={title} {...stylex.props(styles.caption)}>
      {text}
    </p>
  )
}

// The source-map anchor's line, with 20 lines before it and 60 after.
function Original({bundle, span}: {bundle?: CodeBundle; span: Span | null}) {
  if (!bundle) return '—'
  if (!span) return NO_MATCH
  const source = bundle.sources[span.source],
    position = span.original
  if (!position) return 'Switch to Generated code to inspect the bundle.'
  if (source.content == null) return 'This source map has no sourcesContent. Only the original location is available.'
  const lines = source.content.split(/\r\n|[\n\r\u2028\u2029]/),
    start = Math.max(0, position.line - 20),
    end = Math.min(lines.length, position.line + 61)
  return lines.slice(start, end).map((text, offset) => {
    const line = start + offset,
      active = line === position.line
    return (
      <span
        key={line}
        {...classes(active ? 'source-line active' : 'source-line', stylex.props(styles.sourceLine, active && styles.activeLine))}
      >
        {String(line + 1).padStart(String(end).length, ' ') + '  ' + text}
      </span>
    )
  })
}

// The selected span with 12 spans before and after it; spans outside the filter are dimmed.
function Generated({
  bundle,
  span,
  source,
  status,
  onFocus,
}: {
  bundle: CodeBundle
  span: Span
  source: number | null
  status: string
  onFocus: (index: number) => void
}) {
  const first = Math.max(0, span.index - 12),
    last = Math.min(bundle.spans.length, span.index + 13)
  const marks = []
  for (let i = first; i < last; i++) {
    const part = spanAt(bundle, i),
      matching = matches(part, source, status)
    const length = part.endUtf16 - part.startUtf16,
      limit = 10000
    const text =
      bundle.generatedSource.slice(part.startUtf16, Math.min(part.endUtf16, part.startUtf16 + limit)) +
      (length > limit ? '\n… ' + (length - limit) + ' UTF-16 units omitted …\n' : '')
    const name = part.status + (matching ? '' : ' dim') + (i === span.index ? ' active' : '')
    marks.push(
      <mark
        key={i}
        title={labels[part.status] + ' · UTF-8 [' + part.start + ', ' + part.end + ') · ' + bundle.sources[part.source].source}
        onClick={matching ? () => onFocus(i) : undefined}
        {...classes(name, stylex.props(styles.mark, styles[part.status], !matching && styles.dim, i === span.index && styles.activeMark))}
      >
        {text}
      </mark>,
    )
  }
  return (
    <>
      {first > 0 && <span className="muted">{'… preceding code omitted …\n'}</span>}
      {marks}
      {last < bundle.spans.length && <span className="muted">{'\n… following code omitted …'}</span>}
    </>
  )
}

const styles = stylex.create({
  inspector: {
    position: {default: 'sticky', '@media (max-width: 1050px)': 'static'},
    top: 24,
    scrollMarginTop: {default: null, '@media (max-width: 1050px)': 16},
  },
  heading: {
    display: 'flex',
    alignItems: 'start',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: {default: null, '@media (max-width: 600px)': 'wrap'},
  },
  headingText: {minWidth: 0},
  title: {fontSize: 20, overflowWrap: 'anywhere'},
  meta: {marginTop: 5, fontSize: 12, color: 'var(--muted)'},
  tools: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    marginLeft: {default: null, '@media (max-width: 600px)': 'auto'},
  },
  toggle: {fontSize: 12},
  quiet: {
    backgroundColor: {default: 'transparent', ':hover:not(:disabled)': 'var(--hover)'},
    borderColor: 'transparent',
  },
  close: {flexShrink: 0, fontSize: 18, lineHeight: 1, padding: 7},
  sourceInfo: {marginTop: 10},
  fullPath: {display: 'block', padding: 12, backgroundColor: 'var(--subtle)', borderRadius: 6, fontSize: 11},
  binding: {fontSize: 11, marginTop: 10, color: 'var(--muted)'},
  controls: {display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', marginTop: 20},
  tabs: {display: 'flex', gap: 4, padding: 4, borderRadius: 9, backgroundColor: 'var(--subtle)'},
  tab: {
    borderColor: 'transparent',
    fontSize: 12,
    backgroundColor: {default: 'transparent', ':hover:not(:disabled)': 'var(--hover)'},
    paddingBlock: 7,
    paddingInline: 12,
  },
  tabPressed: {color: 'var(--text)', borderColor: 'var(--border)', backgroundColor: 'var(--panel)'},
  label: {display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 12},
  select: {flex: {default: null, '@media (max-width: 600px)': '1'}},
  rangeNav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 18,
    marginBottom: 12,
    marginInline: 0,
    gap: 8,
    fontSize: 12,
  },
  rangeButtons: {display: 'flex', alignItems: 'center', gap: 12, color: 'var(--muted)'},
  small: {paddingBlock: 4, paddingInline: 10},
  activeRange: {fontVariantNumeric: 'tabular-nums', color: 'var(--muted)', fontSize: 11},
  caption: {marginBottom: 10, fontSize: 11, color: 'var(--muted)', overflowWrap: 'anywhere'},
  code: {
    position: 'relative',
    backgroundColor: 'var(--code)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    margin: 0,
    padding: {default: 20, '@media (max-width: 600px)': 14},
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 9,
    height: {
      default: 'clamp(520px, calc(100vh - 320px), 1000px)',
      '@media (max-width: 600px)': '65vh',
    },
    minHeight: {default: null, '@media (max-width: 600px)': 420},
    overflow: 'auto',
    fontFamily: 'ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.85,
    tabSize: 2,
  },
  sourceLine: {display: 'block', minHeight: '1.85em'},
  activeLine: {backgroundColor: 'var(--selected)', boxShadow: '-3px 0 var(--selection)'},
  mark: {color: 'inherit', cursor: 'pointer', borderRadius: 2, backgroundColor: 'transparent'},
  observed: {backgroundColor: 'var(--mark-observed)'},
  unobserved: {backgroundColor: 'var(--mark-unobserved)'},
  unmeasured: {backgroundColor: 'var(--mark-unmeasured)'},
  dim: {backgroundColor: 'transparent', color: 'var(--muted)'},
  activeMark: {outlineWidth: 2, outlineStyle: 'solid', outlineColor: 'var(--selection)'},
  rangePicker: {marginTop: 14, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--border)'},
  rangeSummary: {display: 'list-item'},
  rangeCount: {marginLeft: 8, fontVariantNumeric: 'tabular-nums'},
  rangeList: {maxHeight: 180, overflow: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6},
  rangeButton: {fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 'normal', paddingBlock: 7, paddingInline: 10},
})
