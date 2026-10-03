import * as stylex from '@stylexjs/stylex'
import {useLayoutEffect, useMemo, useRef, useState} from 'react'
import type {RefObject} from 'react'
import {classes} from '../classes.ts'
import type {Counts, Report, Source} from '../types.ts'
import {styles as page} from './App.tsx'
import {basename, number, rejectedCount, size} from './format.ts'

type Row = Counts & {index: number; name: string; package?: string; sources?: Source[]; mappingDiagnostics?: unknown[]}
type Order = 'bytes' | 'unobservedBytes' | 'name'

const PAGE_SIZE = 10

interface Props {
  sectionRef: RefObject<HTMLElement | null>
  report: Report
  bundle: number | null
  source: number | null
  inspecting: boolean
  hidden: boolean
  page: number
  search: string
  sort: string
  appOnly: boolean
  onSelect: (index: number) => void
  onPage: (page: number) => void
  onSearch: (value: string) => void
  onSort: (value: string) => void
  onAppOnly: (value: boolean) => void
  onBack: () => void
  onInspectBundle: () => void
}

export function Explorer(props: Props) {
  const {report, bundle, source, inspecting, search, sort, appOnly} = props
  const searchText = useMemo(
    () =>
      report.bundles.map((row) => [row.path, ...row.sources.flatMap((source) => [source.source, source.package])].join(' ').toLowerCase()),
    [report],
  )
  const inside = bundle !== null
  const query = search.toLowerCase()
  const order = sort as Order
  const list: Row[] = (inside ? report.bundles[bundle].sources : report.bundles)
    .map((row, index): Row => ({...row, index, name: 'path' in row ? row.path : row.source}))
    .filter(
      (row) =>
        (inside ? (row.name + ' ' + row.package).toLowerCase() : searchText[row.index]).includes(query) &&
        (!appOnly || !inside || row.package === '[application]'),
    )
    .sort((a, b) => (order === 'name' ? 0 : b[order] - a[order]) || a.name.localeCompare(b.name))
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const current = Math.min(props.page, pages - 1)

  function context(row: Row) {
    if (inside) {
      if (row.package === '[unmapped]') return 'No source mapping'
      if (row.package !== '[application]') return row.package
      const parent = row.name.split('/').slice(-2, -1)[0]
      return parent ? 'App code · ' + parent : 'App code'
    }
    const names = [...new Set(row.sources!.map((source) => source.package).filter((name) => !name.startsWith('[')))]
    const context = names.slice(0, 2).join(', ') || row.sources!.length + ' sources'
    return row.unmeasuredBytes === row.bytes ? 'Unmeasured · ' + context : context
  }
  const subtitle = (row: Row) => (row.mappingDiagnostics?.length ? rejectedCount(row.mappingDiagnostics.length) + ' · ' : '') + context(row)

  return (
    <section
      ref={props.sectionRef}
      id="explorer"
      {...stylex.props(page.panel, inspecting && styles.inspecting, props.hidden && styles.hidden)}
    >
      <div {...stylex.props(styles.head)}>
        <h2 id="explorer-title">{inside ? 'Source files' : 'Explore chunks'}</h2>
        <small id="selection" {...stylex.props(styles.selection, inspecting && styles.fullRow)}>
          {number(list.length) + ' files · ' + size(list.reduce((sum, row) => sum + row.bytes, 0))}
        </small>
      </div>
      <div {...stylex.props(styles.breadcrumbs, inspecting && styles.wrap)}>
        <button id="back" hidden={!inside} onClick={props.onBack} {...stylex.props(styles.quiet, styles.back)}>
          ← All chunks
        </button>
        <span id="scope" hidden={!inside} title={inside ? report.bundles[bundle].path : ''} {...stylex.props(styles.scope)}>
          {inside ? basename(report.bundles[bundle].path) : ''}
        </span>
        <button
          id="inspect-bundle"
          hidden={!inside}
          onClick={props.onInspectBundle}
          {...stylex.props(styles.inspectBundle, inspecting && styles.inspectBundleInspecting)}
        >
          Inspect chunk
        </button>
      </div>
      <div {...stylex.props(styles.controls)}>
        <input
          id="search"
          type="search"
          aria-label="Search files or packages"
          placeholder="Find a file or package"
          value={search}
          onInput={(event) => props.onSearch(event.currentTarget.value)}
          {...stylex.props(styles.search, inspecting && styles.fullRow)}
        />
        <select
          id="sort"
          aria-label="Sort files"
          value={sort}
          onChange={(event) => props.onSort(event.currentTarget.value)}
          {...stylex.props(styles.select)}
        >
          <option value="unobservedBytes">Most unobserved</option>
          <option value="bytes">Largest first</option>
          <option value="name">Name</option>
        </select>
        <label id="app-filter" hidden={!inside} {...stylex.props(styles.check)}>
          <input
            id="app-only"
            type="checkbox"
            checked={appOnly}
            onChange={(event) => props.onAppOnly(event.currentTarget.checked)}
            {...stylex.props(styles.checkbox)}
          />{' '}
          App code only
        </label>
      </div>
      <div {...stylex.props(styles.tableWrap, inspecting && styles.tableWrapInspecting)}>
        <table {...stylex.props(styles.table)}>
          <thead>
            <tr>
              <th id="name-heading" {...stylex.props(styles.th, styles.thName, inspecting && styles.thNameInspecting)}>
                File
              </th>
              <th {...stylex.props(styles.th, inspecting && styles.hidden)}>Total</th>
              <th {...stylex.props(styles.th)}>Unobserved</th>
              <th {...stylex.props(styles.th, inspecting && styles.hidden)}>Unmeasured</th>
            </tr>
          </thead>
          <tbody id="rows">
            {list.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((row) => {
              const selected = inside && source === row.index
              return (
                <tr key={row.index} {...stylex.props(styles.row, selected && styles.selectedRow)}>
                  <td {...stylex.props(styles.td, styles.tdName)}>
                    <button
                      aria-label={row.name}
                      aria-pressed={selected}
                      title={row.name}
                      onClick={() => props.onSelect(row.index)}
                      {...stylex.props(styles.fileButton, selected && styles.fileButtonPressed)}
                    >
                      <span {...stylex.props(styles.fileText, styles.fileName)}>{basename(row.name)}</span>
                      <span {...stylex.props(styles.fileText, styles.fileSubtitle)}>{subtitle(row)}</span>
                    </button>
                  </td>
                  {(
                    [
                      ['bytes', ''],
                      ['unobservedBytes', 'unobserved'],
                      ['unmeasuredBytes', 'unmeasured'],
                    ] as const
                  ).map(([key, className], column) => (
                    <td
                      key={key}
                      title={number(row[key]) + ' UTF-8 bytes'}
                      {...classes(
                        row[key] ? className : 'muted',
                        stylex.props(styles.td, styles.tdNumber, inspecting && column !== 1 && styles.hidden),
                      )}
                    >
                      {size(row[key])}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        <p id="files-empty" hidden={list.length !== 0} {...stylex.props(styles.empty)}>
          No files match your search.
        </p>
      </div>
      <div {...stylex.props(styles.pager)}>
        <span id="file-page" aria-live="polite">
          {list.length
            ? current * PAGE_SIZE + 1 + '–' + Math.min((current + 1) * PAGE_SIZE, list.length) + ' / ' + number(list.length) + ' files'
            : '0 files'}
        </span>
        <div {...stylex.props(styles.pagerButtons)}>
          <button
            id="files-prev"
            aria-label="Previous file page"
            disabled={current === 0}
            onClick={() => props.onPage(current - 1)}
            {...stylex.props(styles.small)}
          >
            ←
          </button>
          <button
            id="files-next"
            aria-label="Next file page"
            disabled={current + 1 >= pages}
            onClick={() => props.onPage(current + 1)}
            {...stylex.props(styles.small)}
          >
            →
          </button>
        </div>
      </div>
      <SizeMap rows={list} onSelect={props.onSelect} />
    </section>
  )
}

type Tile = Counts & {name: string; index?: number; rest?: boolean}

function color(row: Counts) {
  const total = row.bytes || 1,
    u = (row.unobservedBytes / total) * 100,
    o = (row.observedBytes / total) * 100
  return (
    'linear-gradient(90deg,var(--tile-unobserved) 0%,var(--tile-unobserved) ' +
    u +
    '%,var(--tile-observed) ' +
    u +
    '%,var(--tile-observed) ' +
    (u + o) +
    '%,var(--tile-unmeasured) ' +
    (u + o) +
    '%)'
  )
}

// Up to 11 large files; the rest share one tile.
function SizeMap({rows, onSelect}: {rows: Row[]; onSelect: (index: number) => void}) {
  const [open, setOpen] = useState(false)
  const box = useSize(open)
  let tiles: {row: Tile; x: number; y: number; w: number; h: number}[] = []
  if (open && box) {
    const list: Tile[] = rows.filter((row) => row.bytes > 0).sort((a, b) => b.bytes - a.bytes)
    const total = list.reduce((sum, row) => sum + row.bytes, 0)
    const visible = list.filter((row, index) => index < 11 && row.bytes >= total * 0.025)
    const other = list.slice(visible.length)
    if (other.length) {
      const rest: Tile = {
        name: other.length + ' other files',
        rest: true,
        bytes: 0,
        observedBytes: 0,
        unobservedBytes: 0,
        unmeasuredBytes: 0,
      }
      for (const row of other)
        for (const key of ['bytes', 'observedBytes', 'unobservedBytes', 'unmeasuredBytes'] as const) rest[key] += row[key]
      visible.push(rest)
    }
    tiles = split(visible, 0, 0, 100, 100, box.width, box.height)
  }
  return (
    <details id="map-details" onToggle={(event) => setOpen(event.currentTarget.open)} {...stylex.props(styles.visualization)}>
      <summary>Show size distribution</summary>
      <div {...stylex.props(styles.legend)}>
        {(['observed', 'unobserved', 'unmeasured'] as const).map((state) => (
          <span key={state} className={state}>
            <i {...stylex.props(styles.swatch)} />
            {state[0].toUpperCase() + state.slice(1)}
          </span>
        ))}
      </div>
      <div id="treemap" aria-label="Size treemap" ref={box?.ref ?? undefined} {...stylex.props(styles.treemap)}>
        {tiles.map(({row, x, y, w, h}) => {
          const Tag = row.rest ? 'div' : 'button'
          const title = row.name + ' · ' + number(row.bytes) + ' B'
          return (
            <Tag
              key={row.rest ? 'rest' : row.index}
              title={title}
              aria-label={title}
              style={{left: x + '%', top: y + '%', width: w + '%', height: h + '%', background: color(row)}}
              onClick={row.rest ? undefined : () => onSelect(row.index!)}
              {...stylex.props(styles.tile, row.rest && styles.rest)}
            >
              <div hidden={(w / 100) * box!.width < 100 || (h / 100) * box!.height < 65} {...stylex.props(styles.tileLabel)}>
                <span {...stylex.props(styles.tileName)}>{basename(row.name)}</span>
                <strong {...stylex.props(styles.tileSize)}>{size(row.bytes)}</strong>
              </div>
            </Tag>
          )
        })}
      </div>
      <p {...stylex.props(page.note)}>
        Up to 11 large files are shown individually. Smaller files are grouped; every file remains available in the list.
      </p>
    </details>
  )
}

// Halves by bytes, along the longer side.
function split(items: Tile[], x: number, y: number, w: number, h: number, width: number, height: number) {
  const tiles: {row: Tile; x: number; y: number; w: number; h: number}[] = []
  const place = (items: Tile[], x: number, y: number, w: number, h: number) => {
    if (!items.length) return
    if (items.length === 1) {
      tiles.push({row: items[0], x, y, w, h})
      return
    }
    const total = items.reduce((sum, row) => sum + row.bytes, 0)
    let partial = 0,
      index = 0
    while (index < items.length - 1 && partial < total / 2) partial += items[index++].bytes
    const ratio = partial / total
    if (w * width >= h * height) {
      place(items.slice(0, index), x, y, w * ratio, h)
      place(items.slice(index), x + w * ratio, y, w * (1 - ratio), h)
    } else {
      place(items.slice(0, index), x, y, w, h * ratio)
      place(items.slice(index), x, y + h * ratio, w, h * (1 - ratio))
    }
  }
  place(items, x, y, w, h)
  return tiles
}

// The element's client size while `active`, measured again when the window resizes.
function useSize(active: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{width: number; height: number} | null>(null)
  useLayoutEffect(() => {
    if (!active) return
    const measure = () => {
      const element = ref.current!
      setSize((size) =>
        size?.width === element.clientWidth && size.height === element.clientHeight
          ? size
          : {width: element.clientWidth, height: element.clientHeight},
      )
    }
    measure()
    addEventListener('resize', measure)
    return () => removeEventListener('resize', measure)
  }, [active])
  return active ? {ref, width: size?.width ?? 0, height: size?.height ?? 0} : null
}

const styles = stylex.create({
  inspecting: {paddingBlock: 22, paddingInline: 16},
  hidden: {display: 'none'},
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: {default: 16, '@media (max-width: 600px)': 6},
    marginBottom: {default: 22, '@media (max-width: 600px)': 16},
    flexWrap: 'wrap',
  },
  selection: {fontSize: 12},
  fullRow: {flexBasis: '100%'},
  breadcrumbs: {
    display: 'flex',
    alignItems: 'center',
    gap: {default: 10, '@media (max-width: 600px)': 6},
    minWidth: 0,
    marginTop: -4,
    marginBottom: 16,
    marginInline: 0,
  },
  wrap: {flexWrap: 'wrap'},
  quiet: {
    backgroundColor: {default: 'transparent', ':hover:not(:disabled)': 'var(--hover)'},
    borderColor: 'transparent',
  },
  back: {flexShrink: 0, paddingLeft: 0, color: 'var(--text)'},
  scope: {
    color: 'var(--muted)',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: {default: null, '@media (max-width: 600px)': 12},
  },
  inspectBundle: {
    marginLeft: 'auto',
    fontSize: {default: 12, '@media (max-width: 600px)': 11},
    flexShrink: 0,
    paddingBlock: {default: null, '@media (max-width: 600px)': 5},
    paddingInline: {default: null, '@media (max-width: 600px)': 7},
  },
  inspectBundleInspecting: {marginLeft: 0},
  controls: {display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: {default: 12, '@media (max-width: 600px)': 10}},
  search: {flex: '1', minWidth: 170, paddingBlock: 11, paddingInline: 14, flexBasis: {default: null, '@media (max-width: 600px)': '100%'}},
  select: {flex: {default: null, '@media (max-width: 600px)': '1'}},
  check: {display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap'},
  checkbox: {accentColor: 'var(--selection)'},
  tableWrap: {marginTop: 20},
  tableWrapInspecting: {maxHeight: '55vh', overflow: 'auto'},
  table: {borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed', fontSize: 13},
  th: {
    textAlign: 'right',
    paddingTop: 0,
    paddingBottom: 12,
    paddingInline: {default: 8, '@media (max-width: 600px)': 4},
    fontSize: 11,
    color: 'var(--muted)',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  thName: {
    textAlign: 'left',
    width: {default: '49%', '@media (max-width: 600px)': '44%'},
    paddingLeft: {default: 10, '@media (max-width: 600px)': 2},
  },
  thNameInspecting: {width: '68%'},
  row: {backgroundColor: {default: null, ':hover': 'var(--hover)'}},
  selectedRow: {backgroundColor: {default: 'var(--selected)', ':hover': 'var(--hover)'}},
  td: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: 'var(--border)',
    paddingBlock: 13,
    paddingInline: {default: 8, '@media (max-width: 600px)': 4},
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  tdName: {textAlign: 'left', paddingLeft: {default: 10, '@media (max-width: 600px)': 2}},
  tdNumber: {fontSize: {default: 12, '@media (max-width: 600px)': 11}},
  fileButton: {
    display: 'block',
    minWidth: 0,
    width: '100%',
    borderWidth: 0,
    backgroundColor: 'transparent',
    padding: 0,
    textAlign: 'left',
    borderRadius: 2,
  },
  // The pressed state's background outranked .file-button's in the original stylesheet.
  fileButtonPressed: {backgroundColor: 'var(--selected)'},
  fileText: {display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'},
  fileName: {fontSize: {default: 13, '@media (max-width: 600px)': 12}, fontWeight: 500},
  fileSubtitle: {fontSize: {default: 11, '@media (max-width: 600px)': 10}, marginTop: 3, color: 'var(--muted)'},
  empty: {textAlign: 'center', paddingBlock: 40, paddingInline: 16, color: 'var(--muted)'},
  pager: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    marginTop: 18,
    color: 'var(--muted)',
    fontSize: 12,
  },
  pagerButtons: {display: 'flex', alignItems: 'center', gap: 8},
  small: {paddingBlock: 4, paddingInline: 10},
  visualization: {marginTop: 22, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--border)'},
  legend: {display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 11},
  swatch: {display: 'inline-block', width: 7, height: 7, marginRight: 5, borderRadius: 2, backgroundColor: 'currentColor'},
  treemap: {position: 'relative', height: 280, marginBlock: 14, marginInline: 0},
  tile: {
    position: 'absolute',
    minWidth: 0,
    minHeight: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: 6,
    boxShadow: 'inset 0 0 0 3px var(--panel)',
    overflow: 'hidden',
    textAlign: 'left',
    fontSize: 12,
  },
  rest: {color: 'var(--muted)'},
  tileLabel: {padding: 14},
  tileName: {display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'},
  tileSize: {display: 'block', fontWeight: 500, marginTop: 4, fontSize: 13},
})
