import * as stylex from '@stylexjs/stylex'
import {useLayoutEffect, useMemo, useRef, useState} from 'react'
import type {Report} from '../types.ts'
import {FileDetails} from './FileDetails.tsx'
import {Actions, Findings, Summary} from './Findings.tsx'
import {loadText, number, phaseColor, signed, size} from './format.ts'
import {KEYS, build, compact, filtered, keyPath, resolve} from './model.ts'
import type {TreeNode, View} from './model.ts'
import {shared} from './styles.ts'
import {Treemap} from './Treemap.tsx'

type ColorMode = 'coverage' | 'phases' | 'initial' | 'changes'

export function App({report}: {report: Report}) {
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState('path')
  const [color, setColor] = useState<ColorMode>(report.scenarios.length > 1 ? 'phases' : report.baseline ? 'changes' : 'coverage')
  const [unloaded, setUnloaded] = useState(false)
  const [mapped, setMapped] = useState(false)
  const [sort, setSort] = useState('bytes')
  const [scenario, setScenario] = useState('')
  const [initial, setInitial] = useState(report.initialScenario || '')
  const [optionsOpen, setOptionsOpen] = useState(false)
  // The focused node as a key path from the root; `zoom` counts navigations, which animate.
  const [location, setLocation] = useState({path: [] as string[], zoom: 0})
  const {root, changes} = useMemo(() => build(report, {group, scenario, initial}), [report, group, scenario, initial])
  const focus = resolve(root, location.path)
  const explorerRef = useRef<HTMLElement>(null)
  const scrollToExplorer = useRef(false)
  useLayoutEffect(() => {
    if (scrollToExplorer.current) explorerRef.current!.scrollIntoView({block: 'start'})
    scrollToExplorer.current = false
  })

  const zoom = (node: TreeNode) => setLocation((location) => ({path: keyPath(node), zoom: location.zoom + 1}))
  const select = (node: TreeNode) => {
    if (node === focus) return
    history.pushState({coldpath: keyPath(node)}, '')
    zoom(node)
  }
  const popstate = useRef<(event: PopStateEvent) => void>(null)
  popstate.current = (event) => {
    zoom(resolve(root, event.state?.coldpath || []))
  }
  useLayoutEffect(() => {
    const listener = (event: PopStateEvent) => popstate.current!(event)
    addEventListener('popstate', listener)
    return () => removeEventListener('popstate', listener)
  }, [])
  // Changing what the tree holds starts again at the root.
  const reset = () => setLocation((location) => ({path: [], zoom: location.zoom}))
  function choose(id: 'scenario' | 'initial' | 'color', value: string) {
    let next = {scenario, initial, color}
    next = {...next, [id]: value}
    if (id === 'initial' && next.initial) next.color = 'initial'
    if (id === 'scenario' && next.scenario) next.color = report.baseline ? 'changes' : 'coverage'
    if (['phases', 'initial'].includes(next.color)) next.scenario = ''
    setScenario(next.scenario)
    setInitial(next.initial)
    setColor(next.color)
    reset()
  }

  const phases = color === 'phases' && report.scenarios.length > 0
  const initialView = color === 'initial' && Boolean(initial)
  const changing = color === 'changes' && Boolean(changes)
  function tileColor(row: View) {
    if (changing) {
      return row.growingSources || (row.change?.delta.bytes ?? 0) > 0
        ? 'var(--growth)'
        : row.shrinkingSources || (row.change?.delta.bytes ?? 0) < 0
          ? 'var(--reduction)'
          : 'var(--unmeasured)'
    }
    if (phases || initialView) {
      let offset = 0
      const stops: [number, string][] = phases
        ? [...row.first.map((value, index): [number, string] => [value, phaseColor(index)]), [row.earlierUnknown, 'var(--unknown-initial)']]
        : [
            [row.initialObserved, 'var(--observed)'],
            [row.interactionOnly, 'var(--interaction)'],
            [row.initialUnknown, 'var(--unknown-initial)'],
          ]
      stops.push([row.unobservedBytes, 'var(--unobserved)'], [row.unmeasuredBytes, 'var(--unmeasured)'])
      return `linear-gradient(90deg,${stops
        .map(([value, color]) => {
          const start = offset
          offset += (value / (row.bytes || 1)) * 100
          return `${color} ${start}% ${offset}%`
        })
        .join(',')})`
    }
    const total = row.bytes || 1,
      observed = (row.observedBytes / total) * 100,
      unobserved = ((row.observedBytes + row.unobservedBytes) / total) * 100
    return `linear-gradient(90deg,var(--observed) 0% ${observed}%,var(--unobserved) ${observed}% ${unobserved}%,var(--unmeasured) ${unobserved}% 100%)`
  }
  function tooltip(row: View) {
    return (
      (row.source || row.name) +
      '\n' +
      (row.label?.name ? 'Inferred (AI guess): ' + row.label.name + '\n' : '') +
      (row.label?.contents?.length
        ? 'Inferred contents (AI guess): ' + row.label.contents.map((part) => part.name).join(', ') + '\n'
        : '') +
      (row.loading ? 'Loaded: ' + loadText(row.loading) + '\n' : '') +
      KEYS.map((key, i) => ['Size', 'Observed', 'Unobserved', 'Unmeasured'][i] + ': ' + number(row[key]) + ' B').join('\n') +
      (initial
        ? '\nInitial observed: ' +
          number(row.initialObserved) +
          ' B' +
          '\nInteraction only (initial measured): ' +
          number(row.interactionOnly) +
          ' B' +
          '\nLater observed (initial unmeasured): ' +
          number(row.initialUnknown) +
          ' B'
        : '') +
      (row.change
        ? '\nBaseline ' +
          (row.kind === 'file' ? '(source across all bundles)' : '(bundle)') +
          ': ' +
          signed(row.change.delta.bytes) +
          ' B; unobserved ' +
          signed(row.change.delta.unobservedBytes) +
          ' B'
        : '')
    )
  }

  const view = filtered(focus, {search, mapped, unloaded, recorded: report.scenarios.length > 0})
  const items = view ? (focus.kind === 'file' ? [view] : [...view.children.values()].map(compact)) : []
  const order = sort as 'bytes' | 'unobservedBytes' | 'name'
  items.sort((a, b) => (order === 'name' ? 0 : b[order] - a[order]) || a.name.localeCompare(b.name))
  const ancestors: TreeNode[] = []
  for (let node = focus.parent; node; node = node.parent) ancestors.unshift(node)
  const treemapHidden = focus.kind === 'file' || items.length === 0
  const totals = report.scenarioReports.find((row) => row.scenario === scenario)?.totals || report.totals
  const removed = (changes?.sources || []).filter((row) => row.change === 'removed')

  // The details panel keeps showing the last selected source while hidden, so its inspector frame survives zooming out and back.
  const selection = [focus.bundleIndex, focus.sourceIndex, scenario, initial].join('|')
  const [file, setFile] = useState<{selection: string; node: TreeNode; view: View; scenario: string; initial: string} | null>(null)
  const fileShown = focus.kind === 'file' && view !== null
  if (fileShown && file?.selection !== selection) setFile({selection, node: focus, view, scenario, initial})

  const legends: [string, string][] = phases
    ? [
        ...report.scenarios.map((name, i): [string, string] => [phaseColor(i), 'First observed: ' + name]),
        ['var(--unknown-initial)', 'Observed · earlier scenarios unmeasured'],
        ['var(--unobserved)', 'No observed execution'],
        ['var(--unmeasured)', 'Unmeasured'],
      ]
    : changing
      ? [
          ['var(--growth)', 'Growth'],
          ['var(--reduction)', 'Reduction'],
          ['var(--unmeasured)', 'Unchanged · dashed border = new source'],
        ]
      : initialView
        ? [
            ['var(--observed)', 'Initial executed'],
            ['var(--interaction)', 'Interaction only'],
            ['var(--unknown-initial)', 'Later executed · initial unmeasured'],
            ['var(--unobserved)', 'No observed execution'],
            ['var(--unmeasured)', 'Unmeasured'],
          ]
        : [
            ['var(--observed)', 'Observed'],
            ['var(--unobserved)', 'Unobserved'],
            ['var(--unmeasured)', 'Unmeasured'],
          ]

  return (
    <main {...stylex.props(styles.main)}>
      <Summary report={report} onShowUnloaded={() => setUnloaded(true)} />
      <Findings
        report={report}
        onSearch={(query) => {
          setSearch(query)
          scrollToExplorer.current = true
        }}
      />
      <Actions
        report={report}
        onAction={(action) => {
          const find = (node: TreeNode): TreeNode | undefined =>
            node.kind === 'file' && node.source === action.source ? node : [...node.children.values()].map(find).find(Boolean)
          const target = find(root)
          if (target) {
            setSearch('')
            select(target)
            scrollToExplorer.current = true
          }
        }}
      />
      <section id="explorer" ref={explorerRef} {...stylex.props(shared.panel)}>
        <div {...stylex.props(shared.toolbar)}>
          <input
            id="search"
            type="search"
            aria-label="Search sources or packages"
            placeholder="Search sources or packages"
            value={search}
            onInput={(event) => setSearch(event.currentTarget.value)}
            {...stylex.props(styles.search)}
          />
          <label {...stylex.props(styles.label)}>
            Group{' '}
            <select
              id="group"
              aria-label="Group sources"
              value={group}
              onChange={(event) => {
                setGroup(event.currentTarget.value)
                reset()
              }}
            >
              <option value="path">Folders</option>
              <option value="package">Packages</option>
            </select>
          </label>
          <label {...stylex.props(styles.label)}>
            Color{' '}
            <select id="color" aria-label="Color tiles by" value={color} onChange={(event) => choose('color', event.currentTarget.value)}>
              <option value="coverage">Coverage</option>
              <option value="phases">First observed scenario</option>
              <option value="initial">Initial comparison</option>
              <option value="changes" disabled={!report.baseline}>
                Change from baseline
              </option>
            </select>
          </label>
        </div>
        <details
          id="options"
          onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
          {...stylex.props(optionsOpen && styles.optionsOpen)}
        >
          <summary {...stylex.props(styles.optionsSummary)}>More options</summary>
          <div id="stats" {...stylex.props(styles.stats)}>
            {KEYS.map((key, i) => (
              <div
                key={key}
                title={number(totals[key]) + ' UTF-8 bytes · ' + (scenario || 'All scenarios combined')}
                {...stylex.props(styles.stat)}
              >
                <small>{['Total generated', 'Observed', 'Unobserved', 'Unmeasured'][i]}</small>
                <strong {...stylex.props(styles.statValue)}>{size(totals[key])}</strong>
              </div>
            ))}
          </div>
          <p {...stylex.props(shared.note)}>
            Generated UTF-8 bytes, before compression, including files hidden below. Unobserved means not executed in these recordings;
            unmeasured means no recording is available.
          </p>
          <div {...stylex.props(shared.toolbar, styles.options)}>
            <label {...stylex.props(styles.label)}>
              <input id="unloaded" type="checkbox" checked={unloaded} onChange={(event) => setUnloaded(event.currentTarget.checked)} /> Show
              files not loaded in any recording
            </label>
            <label {...stylex.props(styles.label)}>
              <input id="mapped" type="checkbox" checked={mapped} onChange={(event) => setMapped(event.currentTarget.checked)} /> Mapped
              only
            </label>
            <select id="sort" aria-label="Sort entries" value={sort} onChange={(event) => setSort(event.currentTarget.value)}>
              <option value="bytes">Largest first</option>
              <option value="unobservedBytes">Most unobserved</option>
              <option value="name">Name</option>
            </select>
            <label hidden={!report.scenarios.length} {...stylex.props(styles.label)}>
              Coverage{' '}
              <select
                id="scenario"
                aria-label="Coverage scenario"
                value={scenario}
                onChange={(event) => choose('scenario', event.currentTarget.value)}
              >
                <option value="">All scenarios</option>
                {report.scenarios.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label hidden={!report.scenarios.length} {...stylex.props(styles.label)}>
              Initial{' '}
              <select
                id="initial"
                aria-label="Initial scenario"
                value={initial}
                onChange={(event) => choose('initial', event.currentTarget.value)}
              >
                <option value="">Choose initial scenario</option>
                {report.scenarios.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
        <div {...stylex.props(styles.location)}>
          <nav id="breadcrumbs" aria-label="Location" {...stylex.props(styles.nav)}>
            {ancestors.flatMap((node, index) => [
              <button key={'b' + index} onClick={() => select(node)} {...stylex.props(styles.crumb)}>
                {node.name}
              </button>,
              <span key={'s' + index} aria-hidden="true" {...stylex.props(styles.sep)}>
                /
              </span>,
            ])}
          </nav>
          <h2 id="scope" {...stylex.props(styles.scope)}>
            {focus.name}
          </h2>
          <span id="scope-count" aria-live="polite" {...stylex.props(styles.count)}>
            {focus.kind === 'file'
              ? size(view?.bytes || 0)
              : items.length + (items.length === 1 ? ' entry, ' : ' entries, ') + size(view?.bytes || 0)}
          </span>
        </div>
        <div id="legend" {...stylex.props(styles.legend)}>
          {legends.map(([color, text]) => (
            <span key={text} {...stylex.props(styles.legendItem)}>
              <i style={{background: color}} {...stylex.props(shared.swatch)} />
              {text}
            </span>
          ))}
        </div>
        <p id="phase-note" {...stylex.props(shared.note, styles.wrap)}>
          {phases
            ? 'Color shows the first recording that ran each byte. Yellow: an earlier recording did not load that file, so its first run is unknown.'
            : initialView
              ? 'Initial: ' +
                initial +
                '. Purple bytes are deferral candidates in scripts measured during initial. Yellow bytes have no initial recording. Execution evidence does not prove loading time or that removal is safe.'
              : color === 'initial'
                ? 'Choose an initial scenario to compare execution phases.'
                : ''}
        </p>
        <p id="comparison" {...stylex.props(shared.note, styles.wrap)}>
          {changes
            ? 'Baseline: ' +
              signed(changes.totals.delta.bytes) +
              ' generated B · ' +
              signed(changes.totals.delta.unobservedBytes) +
              ' unobserved B. Source deltas aggregate all bundles; moved sources keep their identity. Folder colors indicate contained changes.'
            : report.baseline
              ? 'No matching baseline for this scenario.'
              : ''}
        </p>
        <p id="treemap-note" hidden={treemapHidden} {...stylex.props(shared.note)}>
          Tile area is generated size. Select a box to zoom in; use the path above or the browser's back button to zoom out.
        </p>
        <Treemap
          items={items}
          focus={focus}
          hidden={treemapHidden}
          zoom={location.zoom}
          changing={changing}
          color={tileColor}
          tooltip={tooltip}
          onSelect={select}
        />
        <div id="file" hidden={!fileShown} {...stylex.props(styles.file)}>
          {file && <FileDetails key={file.selection} report={report} {...file} />}
        </div>
        <p id="empty" hidden={items.length !== 0} {...stylex.props(styles.empty)}>
          No matching sources in this location.
        </p>
        <div {...stylex.props(styles.tableWrap)}>
          <table {...stylex.props(styles.table)}>
            <thead>
              <tr>
                {['Name', 'Bytes', 'Observed', 'Unobserved', 'Unmeasured'].map((name, i) => (
                  <th key={name} {...stylex.props(styles.cell, styles.th, !i && styles.first)}>
                    {name}
                  </th>
                ))}
                <th id="delta-heading" hidden={!changes} {...stylex.props(styles.cell, styles.th)}>
                  Δ bytes / unobserved
                </th>
              </tr>
            </thead>
            <tbody id="rows">
              {items.map((row, index) => (
                <tr key={index} {...stylex.props(styles.row)}>
                  <td {...stylex.props(styles.cell, styles.first, styles.name, index === items.length - 1 && styles.last)}>
                    <button title={tooltip(row)} onClick={() => select(row.ref)} {...stylex.props(styles.rowButton)}>
                      {row.name}
                    </button>
                  </td>
                  {KEYS.map((key) => (
                    <td key={key} {...stylex.props(styles.cell, index === items.length - 1 && styles.last)}>
                      {number(row[key])}
                    </td>
                  ))}
                  {changes && (
                    <td {...stylex.props(styles.cell, index === items.length - 1 && styles.last)}>
                      {row.change ? signed(row.change.delta.bytes) + ' / ' + signed(row.change.delta.unobservedBytes) : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p id="filter-note" {...stylex.props(shared.note)}>
          {search || mapped
            ? 'Search and mapped-only filtering affect this view. Overall totals and CI budgets remain unchanged.'
            : 'Every entry is available in the table, including tiles too small for a label.'}
        </p>
        <details id="removed" hidden={!removed.length}>
          <summary>Removed sources</summary>
          <ul id="removed-list" {...stylex.props(styles.removed)}>
            {removed.map((row, index) => (
              <li key={index}>{row.name + ': ' + signed(row.delta.bytes) + ' B'}</li>
            ))}
          </ul>
        </details>
      </section>
      <details open={report.budgetFailures.length > 0} {...stylex.props(shared.panel)}>
        <summary id="warnings-title">{'Analysis details · ' + report.warnings.length + ' warnings'}</summary>
        <p id="scenarios" {...stylex.props(shared.note)}>
          {'Scenarios: ' +
            (report.scenarios.join(', ') || 'Static analysis · no recordings') +
            '. ' +
            report.excludedBundles.length +
            ' bundles excluded by analysis filters.'}
        </p>
        <p id="compression" {...stylex.props(shared.note)}>
          {report.compression
            ? 'Sum of independently compressed bundles: gzip ' +
              size(report.compression.gzipBytes) +
              ', Brotli ' +
              size(report.compression.brotliBytes) +
              '.'
            : ''}
        </p>
        <ul id="warnings" {...stylex.props(styles.warnings)}>
          {[...report.warnings, ...report.budgetFailures.map((s) => 'Budget exceeded: ' + s)].map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      </details>
    </main>
  )
}

const narrow = '@media (max-width: 650px)'
const styles = stylex.create({
  main: {
    maxWidth: 1440,
    margin: 'auto',
    paddingTop: {default: 40, [narrow]: 24},
    paddingBottom: {default: 64, [narrow]: 40},
    paddingInline: {default: 32, [narrow]: 16},
  },
  search: {flex: '1', minWidth: 200, flexBasis: {default: null, [narrow]: '100%'}},
  label: {color: 'var(--muted)', fontSize: 13},
  optionsOpen: {marginBottom: 4},
  optionsSummary: {display: 'inline-block', color: 'var(--accent)', marginTop: 12, fontSize: 14},
  options: {marginTop: 12, padding: 14, borderRadius: 10, backgroundColor: 'var(--raised)'},
  stats: {
    display: 'grid',
    gridTemplateColumns: {default: 'repeat(4, 1fr)', [narrow]: 'repeat(2, 1fr)'},
    gap: 10,
    marginTop: 14,
    marginBottom: 6,
    marginInline: 0,
  },
  stat: {borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)', borderRadius: 10, paddingBlock: 12, paddingInline: 14},
  statValue: {display: 'block', fontSize: 22, marginTop: 2, fontVariantNumeric: 'tabular-nums'},
  location: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    rowGap: 2,
    columnGap: 4,
    marginTop: 22,
    marginBottom: 6,
    marginInline: 0,
    minWidth: 0,
  },
  nav: {display: 'contents'},
  crumb: {
    color: 'var(--accent)',
    borderWidth: 0,
    paddingBlock: 2,
    paddingInline: 4,
    backgroundColor: 'transparent',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textDecoration: 'underline',
    textDecorationColor: {default: 'color-mix(in srgb, var(--accent) 40%, transparent)', ':hover': 'currentColor'},
    textUnderlineOffset: 3,
  },
  sep: {color: 'var(--muted)'},
  scope: {fontSize: 20, paddingBlock: 0, paddingInline: 4, overflowWrap: 'anywhere'},
  count: {
    marginLeft: {default: 'auto', [narrow]: 0},
    flexBasis: {default: null, [narrow]: '100%'},
    fontSize: 13,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--muted)',
  },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: 6,
    columnGap: 16,
    fontSize: 13,
    color: 'var(--muted)',
    marginTop: 6,
    marginBottom: 4,
    marginInline: 0,
  },
  legendItem: {display: 'inline-flex', alignItems: 'center', gap: 6},
  wrap: {overflowWrap: 'anywhere'},
  file: {marginTop: 14, marginBottom: 18, marginInline: 0, overflowWrap: 'anywhere'},
  empty: {textAlign: 'center', padding: 40, color: 'var(--muted)'},
  tableWrap: {overflow: 'auto', maxHeight: 460, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)', borderRadius: 10},
  table: {borderCollapse: 'collapse', width: '100%', fontVariantNumeric: 'tabular-nums'},
  cell: {
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--border)',
    textAlign: 'right',
    paddingBlock: {default: 9, [narrow]: 8},
    paddingInline: {default: 14, [narrow]: 8},
    whiteSpace: 'nowrap',
    fontSize: {default: null, [narrow]: 13},
  },
  th: {
    color: 'var(--muted)',
    fontSize: {default: 12, [narrow]: 13},
    fontWeight: 600,
    position: 'sticky',
    top: 0,
    backgroundColor: 'var(--panel)',
  },
  first: {textAlign: 'left'},
  name: {width: '50%', maxWidth: 260},
  last: {borderBottomWidth: 0},
  row: {backgroundColor: {default: null, ':hover': 'var(--raised)'}},
  rowButton: {
    borderWidth: 0,
    padding: 0,
    backgroundColor: 'transparent',
    textAlign: 'left',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--accent)',
    textDecoration: 'underline',
    textDecorationColor: {default: 'color-mix(in srgb, var(--accent) 40%, transparent)', ':hover': 'currentColor'},
    textUnderlineOffset: 3,
  },
  removed: {maxHeight: 240, overflow: 'auto', overflowWrap: 'anywhere'},
  warnings: {maxHeight: 240, overflow: 'auto', overflowWrap: 'anywhere'},
})
