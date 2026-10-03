import * as stylex from '@stylexjs/stylex'
import {useState} from 'react'
import type {Counts, Recommendation, Report} from '../types.ts'
import {actionLabels, loaded, phaseColor, shortPath, size} from './format.ts'
import {KEYS} from './model.ts'
import {shared} from './styles.ts'

export function Summary({report, onShowUnloaded}: {report: Report; onShowUnloaded: () => void}) {
  const total = report.totals
  const loadedBytes = loaded(total)
  const unloaded = report.bundles.filter((bundle) => !(bundle.bytes - bundle.unmeasuredBytes))
  const recorded = report.scenarios.length > 0 && loadedBytes > 0
  return (
    <header>
      <p {...stylex.props(styles.brand)}>
        <b {...stylex.props(styles.brandName)}>coldpath</b> JavaScript report
      </p>
      <h1 id="headline" {...stylex.props(styles.headline)}>
        {recorded ? (
          <>
            {'These recordings loaded ' + size(loadedBytes) + ' of JavaScript. '}
            <mark {...stylex.props(styles.never)}>
              {size(total.unobservedBytes) + ' (' + Math.round((total.unobservedBytes / loadedBytes) * 100) + '%)'}
            </mark>
            {' of it never ran.'}
          </>
        ) : (
          size(total.bytes) + ' of JavaScript, with no execution recordings'
        )}
      </h1>
      <p id="subline" {...stylex.props(styles.subline)}>
        {recorded ? (
          <>
            {'Recordings: '}
            {report.scenarios.flatMap((name, index) => [
              ...(index ? [' → '] : []),
              <span key={name} {...stylex.props(styles.chip)}>
                <i style={{background: phaseColor(index)}} {...stylex.props(shared.swatch)} />
                {name}
              </span>,
            ])}
            {'.'}
            {unloaded.length > 0 && (
              <>
                {' ' +
                  unloaded.length +
                  ' other files (' +
                  size(unloaded.reduce((sum, bundle) => sum + bundle.bytes, 0)) +
                  ') were never loaded and are hidden below. '}
                <button onClick={onShowUnloaded} {...stylex.props(shared.link)}>
                  Show them
                </button>
              </>
            )}
          </>
        ) : (
          'Add coverage recordings to see which code runs.'
        )}
      </p>
    </header>
  )
}

interface Finding {
  name: string
  value: string
  detail: string
  share?: number
  query: string
}

// Packages that mostly sat idle, application code that ran only after an action, and sources shipped more than once.
export function Findings({report, onSearch}: {report: Report; onSearch: (query: string) => void}) {
  // Duplication does not depend on recordings.
  const duplicates: Finding[] = [...(report.duplicateSources || [])]
    .sort((a, b) => b.duplicates.extraBytes - a.duplicates.extraBytes)
    .slice(0, 6)
    .map((row) => {
      const path = shortPath(row.source)
      return {
        name: row.label?.shortName ? '≈ ' + row.label.shortName + ' (' + path.split('/').pop() + ')' : path.split('/').pop()!,
        value: size(row.duplicates.extraBytes) + ' extra',
        detail: row.duplicates.bundles + ' copies, ' + size(row.bytes) + ' in total: ' + path,
        query: path,
      }
    })
  let idle: Finding[] = [],
    later: Finding[] = []
  if (report.scenarios.length && loaded(report.totals)) {
    const packages = new Map<string, Counts & {name: string}>()
    for (const bundle of report.bundles) {
      for (const source of bundle.sources) {
        const row = packages.get(source.package) || {
          name: source.package,
          bytes: 0,
          observedBytes: 0,
          unobservedBytes: 0,
          unmeasuredBytes: 0,
        }
        for (const key of KEYS) row[key] += source[key]
        packages.set(source.package, row)
      }
    }
    idle = [...packages.values()]
      .filter(
        (row) => row.name !== '[unmapped]' && loaded(row) >= 1000 && row.unobservedBytes >= 1000 && row.observedBytes / loaded(row) < 0.5,
      )
      .sort((a, b) => b.unobservedBytes - a.unobservedBytes)
      .slice(0, 6)
      .map((row) => {
        const ran = row.observedBytes / loaded(row)
        return {
          name: row.name === '[application]' ? 'Your own code' : row.name,
          value: Math.round((1 - ran) * 100) + '% never ran',
          detail: size(loaded(row)) + ' loaded, ' + size(row.observedBytes) + ' ran',
          share: ran,
          query: row.name === '[application]' ? '' : row.name,
        }
      })
    // Application sources whose bytes first ran in a later recording.
    const first = new Map<string, {scenario: string; bytes: number}>()
    for (const scenario of report.scenarioReports || []) {
      for (const row of scenario.interactionCandidates || []) {
        if (row.package !== '[application]' || !row.interactionOnlyBytes) continue
        const current = first.get(row.source)
        if (!current || current.bytes < row.interactionOnlyBytes)
          first.set(row.source, {scenario: scenario.scenario, bytes: row.interactionOnlyBytes})
      }
    }
    later = [...first]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 6)
      .map(([source, row]) => {
        const path = shortPath(source)
        return {
          name: path.split('/').pop()!,
          value: size(row.bytes),
          detail: 'Runs only in "' + row.scenario + '": ' + path,
          query: path.split('/').pop()!,
        }
      })
  }
  const card = (id: string, title: string, text: string, rows: Finding[]) => (
    <section id={id + '-finding'} hidden={!rows.length} {...stylex.props(styles.card)}>
      <h2>{title}</h2>
      <p {...stylex.props(styles.cardText)}>{text}</p>
      <ol id={id + '-list'} {...stylex.props(styles.rows)}>
        {rows.map((row, index) => (
          <li key={index}>
            <button onClick={() => onSearch(row.query)} {...stylex.props(stylex.defaultMarker(), styles.row, !index && styles.firstRow)}>
              <strong {...stylex.props(styles.rowTitle)}>{row.name}</strong>
              <span {...stylex.props(styles.value)}>{row.value}</span>
              {row.share !== undefined && (
                <span {...stylex.props(styles.meter)}>
                  <i style={{width: row.share * 100 + '%'}} {...stylex.props(styles.fill)} />
                </span>
              )}
              <small {...stylex.props(styles.detail)}>{row.detail}</small>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
  return (
    <div id="findings" hidden={!idle.length && !later.length && !duplicates.length} {...stylex.props(styles.findings)}>
      {card('unused', 'Loaded, but mostly never ran', 'Select a package to find it in the explorer.', idle)}
      {card(
        'later',
        'Your code that runs only after an action',
        'Candidates for loading later. Select one to find it in the explorer.',
        later,
      )}
      {card(
        'duplicate',
        'Shipped in more than one file',
        'Extra copies of the same source, whether or not they ran. Select one to find it in the explorer.',
        duplicates,
      )}
    </div>
  )
}

export function Actions({report, onAction}: {report: Report; onAction: (action: Recommendation) => void}) {
  const [open, setOpen] = useState(true)
  return (
    <details
      id="actions"
      open
      hidden={!report.recommendations.length}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      {...stylex.props(shared.panel)}
    >
      <summary {...stylex.props(styles.actionsSummary, !open && styles.actionsClosed)}>
        <h2 {...stylex.props(styles.inline)}>Review actions</h2>
      </summary>
      <p id="actions-note" {...stylex.props(shared.note)}>
        {'Sources in all selected bundles whose bytes first run after the initial load' +
          (report.initialScenario ? ' (initial: ' + report.initialScenario + ')' : '') +
          '. Estimates are for review, not guaranteed savings; rebuild and record again to measure.'}
      </p>
      <ul id="action-list" {...stylex.props(styles.rows)}>
        {report.recommendations.slice(0, 20).map((action, index) => (
          <li key={index}>
            <button onClick={() => onAction(action)} {...stylex.props(stylex.defaultMarker(), styles.row, !index && styles.firstRow)}>
              <strong {...stylex.props(styles.rowTitle, styles.mono)}>{shortPath(action.source)}</strong>
              <span {...stylex.props(styles.value)}>{size(action.bytes)}</span>
              <small {...stylex.props(styles.detail)}>
                <span {...stylex.props(styles.kind)}>{actionLabels[action.kind]}</span>
                {(action.scenario ? ' in ' + action.scenario : '') +
                  (action.estimatedCompression ? ', isolated gzip estimate ' + size(action.estimatedCompression.gzipBytes) : '')}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

const motion = '@media (prefers-reduced-motion: no-preference)'
const styles = stylex.create({
  brand: {marginTop: 0, marginBottom: 14, marginInline: 0, fontWeight: 650, letterSpacing: -0.2, color: 'var(--muted)'},
  brandName: {color: 'var(--text)'},
  headline: {
    fontSize: 'clamp(28px, 3.6vw, 40px)',
    lineHeight: 1.15,
    letterSpacing: '-0.03em',
    fontWeight: 720,
    maxWidth: '24em',
    marginTop: 0,
    marginBottom: 14,
    marginInline: 0,
    fontVariantNumeric: 'tabular-nums',
  },
  never: {
    color: 'inherit',
    backgroundColor: 'var(--unobserved)',
    borderRadius: 6,
    paddingBlock: 0,
    paddingInline: 6,
    boxDecorationBreak: 'clone',
  },
  subline: {fontSize: 15, color: 'var(--muted)'},
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    paddingBlock: 1,
    paddingRight: 10,
    paddingLeft: 7,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 999,
    backgroundColor: 'var(--panel)',
    color: 'var(--text)',
    whiteSpace: 'nowrap',
  },
  findings: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
    gap: 20,
    marginTop: 32,
    marginBottom: 0,
    marginInline: 0,
  },
  card: {
    backgroundColor: 'var(--panel)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 12,
    paddingTop: {default: 18, '@media (max-width: 650px)': 14},
    paddingBottom: {default: 12, '@media (max-width: 650px)': 14},
    paddingInline: {default: 20, '@media (max-width: 650px)': 14},
    minWidth: 0,
  },
  cardText: {marginTop: 4, marginBottom: 10, marginInline: 0, fontSize: 13, color: 'var(--muted)'},
  rows: {listStyle: 'none', padding: 0, marginTop: 10, marginBottom: 0, marginInline: -10},
  row: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    rowGap: 4,
    columnGap: 14,
    width: '100%',
    textAlign: 'left',
    borderWidth: 0,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: 'var(--border)',
    borderRadius: {default: 0, ':hover': 8},
    paddingBlock: 11,
    paddingRight: 34,
    paddingLeft: 10,
    backgroundColor: {default: 'transparent', ':hover': 'var(--raised)'},
    overflowWrap: 'anywhere',
    transition: {default: null, [motion]: 'box-shadow 0.12s, background-color 0.12s'},
    '::after': {
      content: '""',
      position: 'absolute',
      right: 14,
      top: '50%',
      width: 7,
      height: 7,
      borderStyle: 'solid',
      borderColor: {default: 'var(--muted)', ':hover': 'var(--text)'},
      borderTopWidth: 2,
      borderRightWidth: 2,
      borderBottomWidth: 0,
      borderLeftWidth: 0,
      transform: 'translateY(-50%) rotate(45deg)',
    },
  },
  firstRow: {borderTopColor: 'transparent'},
  rowTitle: {
    textDecoration: {default: null, [stylex.when.ancestor(':hover')]: 'underline'},
    textUnderlineOffset: {default: null, [stylex.when.ancestor(':hover')]: 3},
  },
  mono: {fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600},
  value: {fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontWeight: 600},
  detail: {gridColumnStart: 1, gridColumnEnd: -1, fontSize: 13},
  meter: {
    gridColumnStart: 1,
    gridColumnEnd: -1,
    display: 'block',
    height: 8,
    borderRadius: 4,
    backgroundColor: 'var(--never)',
    overflow: 'hidden',
  },
  fill: {display: 'block', height: '100%', backgroundColor: 'var(--ran)'},
  kind: {fontWeight: 600, color: 'var(--text)'},
  actionsSummary: {
    listStyle: 'none',
    '::after': {content: '"Hide"', float: 'right', color: 'var(--accent)', fontSize: 13},
  },
  actionsClosed: {'::after': {content: '"Show"'}},
  inline: {display: 'inline'},
})
