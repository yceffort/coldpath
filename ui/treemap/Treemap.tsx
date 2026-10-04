import * as stylex from '@stylexjs/stylex'
import {treemapSquarify} from 'd3-hierarchy'
import type {HierarchyRectangularNode} from 'd3-hierarchy'
import {useLayoutEffect, useRef, useState} from 'react'
import type {RefObject} from 'react'
import {classes} from '../classes.ts'
import type {Segment} from './App.tsx'
import {loadText, number, shortPath, signed, size} from './format.ts'
import {byArea, compact, keysUnder, merge, within} from './model.ts'
import type {Area, TreeNode, View} from './model.ts'
import {shared} from './styles.ts'

type Rect = {x: number; y: number; w: number; h: number}
interface Tile extends Rect {
  key: string
  row: View
  // A tile that stands for several small children of `row.ref`: those rows and their keys.
  more?: {rows: View[]; keys: string[]}
  depth: number
  // A folder or bundle drawn as one line of header text over its own children.
  group: boolean
}

const GROUP_GAP = 6,
  TILE_GAP = 2,
  HEADER = 24,
  // Children with less area than this, in square pixels, are merged into one tile that zooms to them.
  MIN_AREA = 700

// Keeps the rows, largest first, that get enough of `space` to see, and merges the rest into one "N smaller items" row.
function visible(rows: View[], parent: TreeNode, area: Area, space: number): Pick<Tile, 'row' | 'more'>[] {
  const total = rows.reduce((sum, row) => sum + row[area], 0)
  let kept = 1
  while (kept < rows.length && (rows[kept][area] / total) * space >= MIN_AREA) kept++
  const rest = rows.slice(kept)
  if (rest.length < 2) return rows.map((row) => ({row}))
  return [
    ...rows.slice(0, kept).map((row) => ({row})),
    {row: merge(rest.length + ' smaller items', parent, rest), more: {rows: rest, keys: keysUnder(parent, rest)}},
  ]
}

// Squarified boxes, so that small entries become boxes rather than slivers, with `gap` pixels between them.
function pack<T extends {row: View}>(items: T[], area: Area, x0: number, y0: number, x1: number, y1: number, gap: number) {
  const nodes = items.map((item) => ({item, value: item.row[area], x0: 0, y0: 0, x1: 0, y1: 0}))
  const parent = {value: nodes.reduce((sum, node) => sum + node.value, 0), children: nodes}
  // Every box gives up half the gap on each side, so the outer edges stay flush with the area.
  const half = gap / 2
  treemapSquarify(parent as unknown as HierarchyRectangularNode<unknown>, x0 - half, y0 - half, x1 + half, y1 + half)
  return nodes.map(({item, ...box}) => ({
    ...item,
    x: box.x0 + half,
    y: box.y0 + half,
    w: Math.max(0, box.x1 - box.x0 - gap),
    h: Math.max(0, box.y1 - box.y0 - gap),
  }))
}

// One view: the focus's children, each drawn as a tile or, with room, as a group of its own children.
function layout(items: View[], focus: TreeNode, area: Area, width: number, height: number) {
  const tiles: Tile[] = []
  if (!width || !height) return tiles
  const name = (tile: Pick<Tile, 'row' | 'more'>) => (tile.more ? 'more' : tile.row.kind + ':' + tile.row.name)
  for (const box of pack(visible(byArea(items, area), focus, area, width * height), area, 0, 0, width, height, GROUP_GAP)) {
    const children =
      box.more || box.row.kind === 'file' || box.w < 150 || box.h < 110 ? [] : byArea([...box.row.children.values()].map(compact), area)
    const group = children.length > 1
    tiles.push({...box, key: name(box), depth: 0, group})
    if (group)
      for (const tile of pack(
        visible(children, box.row.ref, area, box.w * (box.h - HEADER)),
        area,
        box.x,
        box.y + HEADER,
        box.x + box.w,
        box.y + box.h,
        TILE_GAP,
      ))
        tiles.push({...tile, key: name(box) + '/' + name(tile), depth: 1, group: false})
  }
  return tiles
}

// Whether a drawn tile holds a view, so that a zoom between the two starts from or lands in that tile.
const holds = (tile: Tile, focus: TreeNode, only: string[] | null) =>
  tile.more
    ? (focus === tile.row.ref && only !== null && only.every((key) => tile.more!.keys.includes(key))) ||
      tile.more.rows.some((row) => within(focus, row.ref))
    : within(focus, tile.row.ref)
const smallest = (tiles: Tile[], focus: TreeNode, only: string[] | null) =>
  tiles
    .filter((tile) => tile.w >= 1 && tile.h >= 1 && holds(tile, focus, only))
    .reduce<Tile | undefined>((best, tile) => (best && best.w * best.h <= tile.w * tile.h ? best : tile), undefined)
// `fit` draws the whole map inside the box; `fill` draws the box over the whole map.
const fit = (r: Rect, width: number, height: number) => `translate(${r.x}px, ${r.y}px) scale(${r.w / width}, ${r.h / height})`
const fill = (r: Rect, width: number, height: number) => `scale(${width / r.w}, ${height / r.h}) translate(${-r.x}px, ${-r.y}px)`

// "N% never ran", or null when none of the bytes were measured.
const share = (row: View) => {
  const measured = row.bytes - row.unmeasuredBytes
  return measured > 0 ? Math.round((row.unobservedBytes / measured) * 100) + '% never ran' : null
}

interface Props {
  items: View[]
  focus: TreeNode
  // The keys of the focus's children that a "smaller items" view shows, or null for all of them.
  only: string[] | null
  // What the panel shows when no tile is pointed at or focused: the view's totals and its files with the most code that never ran.
  scope: View | null
  coldest: View[]
  hidden: boolean
  // Changes on every navigation that zooms, but not when the tree is rebuilt.
  zoom: number
  area: Area
  changing: boolean
  paint: (row: View) => [fill: string, ink: string]
  segments: (row: View) => Segment[]
  onSelect: (node: TreeNode, only?: string[]) => void
}

export function Treemap({items, focus, only, scope, coldest, hidden, zoom, area, changing, paint, segments, onSelect}: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const leavingRef = useRef<HTMLDivElement>(null)
  const panel = useRef<PanelControl>(null)
  const [frame, setFrame] = useState({width: 0, height: 0})
  // Layout reads the drawn size, which changes with the window, scroll bars, and visibility.
  const measure = () => {
    const {clientWidth: width, clientHeight: height} = mapRef.current!
    setFrame((frame) => (frame.width === width && frame.height === height ? frame : {width, height}))
  }
  useLayoutEffect(measure)
  useLayoutEffect(() => {
    let request = 0
    const resize = () => {
      cancelAnimationFrame(request)
      request = requestAnimationFrame(measure)
    }
    addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(request)
      removeEventListener('resize', resize)
    }
  }, [])
  const tiles = hidden ? [] : layout(items, focus, area, frame.width, frame.height)

  // Zooming in grows the selected tile to fill the map while the old view moves outward and fades. Zooming out shrinks
  // the view back into its tile. The old view stays drawn until the motion ends, and labels wait for it.
  const [leaving, setLeaving] = useState<{zoom: number; tiles: Tile[]; rect: Rect; inward: boolean} | null>(null)
  const previous = useRef({zoom, focus, only, tiles, shown: !hidden})
  useLayoutEffect(() => {
    panel.current?.show(null)
    setLeaving(null)
    const before = previous.current
    if (before.zoom === zoom || !before.shown || hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const into = smallest(before.tiles, focus, only)
    const rect = into || smallest(tiles, before.focus, before.only)
    if (rect) setLeaving({zoom: before.zoom, tiles: before.tiles, rect, inward: Boolean(into)})
    else layerRef.current!.animate([{opacity: 0.3}, {opacity: 1}], {duration: 180, easing: 'ease-out'})
  }, [zoom])
  useLayoutEffect(() => {
    previous.current = {zoom, focus, only, tiles, shown: !hidden}
  })
  useLayoutEffect(() => {
    if (!leaving) return
    const {width, height} = frame
    const small = fit(leaving.rect, width, height),
      large = fill(leaving.rect, width, height)
    const timing = {duration: 380, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)'}
    layerRef.current!.animate([{transform: leaving.inward ? small : large}, {transform: 'none'}], timing)
    const motion = leavingRef.current!.animate(
      [
        {transform: 'none', opacity: 1},
        {transform: leaving.inward ? large : small, opacity: 0},
      ],
      timing,
    )
    motion.finished.then(
      () => setLeaving(null),
      () => {},
    )
    return () => motion.cancel()
  }, [leaving])

  const meta = (row: View, wide: boolean) =>
    area === 'unobservedBytes'
      ? size(row.unobservedBytes) + ' never ran'
      : size(row.bytes) + (wide && !changing && share(row) ? ', ' + share(row) : '')
  const tileElement = (tile: Tile, state?: 'entering' | 'leaving') => {
    const {key, row, more, x, y, w, h, depth, group} = tile
    const newSource = changing && row.newSources > 0
    const [background, color] = group ? ['transparent', 'var(--text)'] : paint(row)
    const big = w >= 220 && h >= 100
    const fade = state === 'leaving' ? styles.fading : state === 'entering' ? styles.waiting : styles.shown
    // Each line is drawn only when it fits: the name needs 22 px of height and the size line 38 px.
    const name = group || (w >= 40 && h >= 22),
      sized = group || (w >= 64 && h >= 38)
    return (
      <button
        key={key}
        type="button"
        data-depth={depth}
        tabIndex={depth ? -1 : undefined}
        data-bytes={row.bytes}
        data-interaction-only={row.interactionOnly}
        data-initial-unknown={row.initialUnknown}
        data-first-observed={JSON.stringify(row.first)}
        data-earlier-unknown={row.earlierUnknown}
        data-change={row.change?.change || ''}
        data-kind={more ? 'more' : row.kind}
        style={{left: x, top: y, width: w, height: group ? HEADER : h, background, color}}
        aria-label={row.name + ', ' + number(row.bytes) + ' bytes'}
        onPointerEnter={() => panel.current?.show(tile)}
        onFocus={() => panel.current?.show(tile)}
        onClick={() => onSelect(row.ref, more?.keys)}
        {...classes(
          'tile' + (group ? ' group' : '') + (newSource ? ' new-source' : ''),
          stylex.props(stylex.defaultMarker(), styles.tile, group ? styles.group : big && styles.big, newSource && styles.newSource),
        )}
      >
        {name && (
          <span {...stylex.props(group ? styles.groupLabel : styles.label, fade)}>
            <span {...stylex.props(styles.name, group && styles.groupName, big && styles.bigName)}>{row.name}</span>
            {sized && (
              <span {...stylex.props(styles.meta, group && styles.groupMeta, big && styles.bigMeta)}>
                {meta(row, group ? w > 260 : w >= 150)}
              </span>
            )}
          </span>
        )}
      </button>
    )
  }
  const layer = (tiles: Tile[], key: number, state?: 'entering' | 'leaving') => (
    <div
      key={key}
      ref={state === 'leaving' ? leavingRef : layerRef}
      inert={state === 'leaving'}
      {...classes('layer' + (state ? ' ' + state : ''), stylex.props(styles.layer, state === 'leaving' && styles.leaving))}
    >
      {tiles.map((tile) => tileElement(tile, state))}
    </div>
  )
  const current = layer(tiles, zoom, leaving ? 'entering' : undefined)
  // The view that grows or shrinks into its tile is drawn on top.
  const layers = leaving
    ? leaving.inward
      ? [layer(leaving.tiles, leaving.zoom, 'leaving'), current]
      : [current, layer(leaving.tiles, leaving.zoom, 'leaving')]
    : current

  return (
    <div hidden={hidden} {...stylex.props(styles.frame)}>
      <div
        id="treemap"
        ref={mapRef}
        aria-label="Bundle size treemap"
        onPointerLeave={() => panel.current?.show(null)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) panel.current?.show(null)
        }}
        {...stylex.props(styles.treemap)}
      >
        {layers}
        {area === 'unobservedBytes' && !tiles.length && <p {...stylex.props(styles.nothing)}>Nothing here never ran.</p>}
      </div>
      <Panel control={panel} scope={scope} coldest={coldest} paint={paint} segments={segments} onSelect={onSelect} />
    </div>
  )
}

interface PanelControl {
  show: (tile: Tile | null) => void
}

// Beside the map, or below it on narrow screens: the numbers of the tile under the pointer or keyboard focus, and
// otherwise the current view's totals and its files with the most code that never ran.
function Panel({
  control,
  scope,
  coldest,
  paint,
  segments,
  onSelect,
}: {
  control: RefObject<PanelControl | null>
  scope: View | null
  coldest: View[]
  paint: (row: View) => [fill: string, ink: string]
  segments: (row: View) => Segment[]
  onSelect: (node: TreeNode) => void
}) {
  const [tile, setTile] = useState<Tile | null>(null)
  useLayoutEffect(() => {
    control.current = {show: setTile}
  }, [])
  const row = tile?.row || scope
  if (!row) return null
  const parts = segments(row).filter(([bytes]) => bytes > 0)
  const percent = (bytes: number) => Math.round((bytes / (row.bytes || 1)) * 100) + '%'
  return (
    <aside id="tile-panel" {...stylex.props(styles.panel)}>
      <div>
        {!tile && <small {...stylex.props(styles.eyebrow)}>This view</small>}
        <h3 {...stylex.props(styles.panelName)}>{row.name}</h3>
        {row.kind === 'file' && row.source && <code {...stylex.props(styles.path)}>{shortPath(row.source)}</code>}
      </div>
      <p {...stylex.props(styles.amount)}>
        <strong {...stylex.props(styles.amountValue)}>{size(row.bytes)}</strong> {share(row) || 'not measured'}
      </p>
      <div {...stylex.props(styles.meter)}>
        {parts.map(([bytes, color], index) => (
          <i key={index} style={{width: (bytes / (row.bytes || 1)) * 100 + '%', background: color}} {...stylex.props(styles.meterPart)} />
        ))}
      </div>
      <ul {...stylex.props(styles.parts)}>
        {parts.map(([bytes, color, label], index) => (
          <li key={index} {...stylex.props(styles.part)}>
            <i style={{background: color}} {...stylex.props(shared.swatch)} />
            <span {...stylex.props(styles.partLabel)}>{label}</span>
            <span {...stylex.props(styles.partValue)}>{size(bytes)}</span>
            <span {...stylex.props(styles.partShare)}>{percent(bytes)}</span>
          </li>
        ))}
      </ul>
      {row.label?.name && <p {...stylex.props(styles.note)}>{'Inferred (AI guess): ' + row.label.name}</p>}
      {row.label?.contents?.length ? (
        <p {...stylex.props(styles.note)}>{'Inferred contents (AI guess): ' + row.label.contents.map((part) => part.name).join(', ')}</p>
      ) : null}
      {row.loading && <p {...stylex.props(styles.note)}>{'Loaded: ' + loadText(row.loading)}</p>}
      {row.change && (
        <p {...stylex.props(styles.note)}>
          {'Baseline ' +
            (row.kind === 'file' ? '(source across all bundles)' : '(bundle)') +
            ': ' +
            signed(row.change.delta.bytes) +
            ' B; unobserved ' +
            signed(row.change.delta.unobservedBytes) +
            ' B'}
        </p>
      )}
      {tile ? (
        <small {...stylex.props(styles.hint)}>{row.kind === 'file' ? 'Select to see details' : 'Select to zoom in'}</small>
      ) : (
        <>
          {coldest.length > 0 && (
            <div>
              <small {...stylex.props(styles.eyebrow)}>Most code that never ran</small>
              <ul id="coldest" {...stylex.props(styles.list)}>
                {coldest.map((file, index) => (
                  <li key={index}>
                    <button type="button" onClick={() => onSelect(file.ref)} {...stylex.props(styles.listButton)}>
                      <i style={{background: paint(file)[0]}} {...stylex.props(shared.swatch)} />
                      <span {...stylex.props(styles.listName)}>{file.name}</span>
                      <span {...stylex.props(styles.listValue)}>{size(file.unobservedBytes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <small {...stylex.props(styles.hint)}>Point at or focus a tile to see its numbers here.</small>
        </>
      )}
    </aside>
  )
}

const motion = '@media (prefers-reduced-motion: no-preference)'
const stack = '@media (max-width: 900px)'
const mapHeight = {default: 'clamp(320px, 58vh, 680px)', '@media (max-width: 650px)': 380}
const styles = stylex.create({
  frame: {
    display: 'grid',
    gridTemplateColumns: {default: 'minmax(0, 1fr) 300px', [stack]: 'minmax(0, 1fr)'},
    gap: 16,
    alignItems: 'start',
    marginTop: 14,
    marginBottom: 18,
  },
  treemap: {position: 'relative', height: mapHeight, overflow: 'hidden'},
  layer: {position: 'absolute', inset: 0, transformOrigin: '0 0'},
  leaving: {pointerEvents: 'none'},
  tile: {
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    borderWidth: 0,
    borderRadius: 4,
    paddingBlock: 4,
    paddingInline: 6,
    overflow: 'hidden',
    textAlign: 'left',
    boxShadow: {default: null, ':hover': 'inset 0 0 0 2px var(--text)', ':focus-visible': 'inset 0 0 0 3px var(--text)'},
    outline: {default: null, ':focus-visible': 'none'},
  },
  big: {paddingBlock: 9, paddingInline: 11},
  // The header line of a folder or bundle drawn with its contents.
  group: {
    justifyContent: 'center',
    paddingBlock: 0,
    paddingInline: 2,
    boxShadow: {default: null, ':hover': null, ':focus-visible': 'inset 0 0 0 2px var(--text)'},
  },
  newSource: {outlineWidth: 3, outlineStyle: 'dashed', outlineColor: 'var(--accent)', outlineOffset: -7},
  label: {display: 'flex', flexDirection: 'column', maxWidth: '100%'},
  groupLabel: {display: 'flex', alignItems: 'baseline', gap: 8, maxWidth: '100%', fontSize: 12.5, lineHeight: '16px'},
  name: {
    maxWidth: '100%',
    fontSize: 12,
    lineHeight: '16px',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    maxWidth: '100%',
    fontSize: 11.5,
    lineHeight: '15px',
    opacity: 0.85,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  bigName: {fontSize: 15, lineHeight: '20px'},
  bigMeta: {fontSize: 13, lineHeight: '18px'},
  groupName: {
    minWidth: 0,
    fontSize: 12.5,
    fontWeight: 650,
    textDecoration: {default: null, [stylex.when.ancestor(':hover')]: 'underline'},
    textUnderlineOffset: 3,
  },
  groupMeta: {flex: 'none', fontSize: 12.5, lineHeight: '16px', opacity: 1, color: 'var(--muted)'},
  shown: {opacity: 1, transition: {default: null, [motion]: 'opacity 160ms ease-out'}},
  waiting: {opacity: 0},
  fading: {opacity: 0, transition: {default: null, [motion]: 'opacity 80ms'}},
  nothing: {position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', margin: 0, color: 'var(--muted)'},
  panel: {
    display: 'grid',
    alignContent: 'start',
    rowGap: 12,
    minWidth: 0,
    maxHeight: {default: mapHeight.default, [stack]: 'none'},
    overflow: 'auto',
    paddingBlock: 16,
    paddingInline: 16,
    borderRadius: 10,
    backgroundColor: 'var(--raised)',
    fontSize: 13,
    lineHeight: 1.45,
    overflowWrap: 'anywhere',
  },
  eyebrow: {display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase'},
  panelName: {margin: 0, fontSize: 17, lineHeight: 1.3},
  path: {display: 'block', marginTop: 2, color: 'var(--muted)'},
  amount: {margin: 0, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums'},
  amountValue: {fontSize: 24, fontWeight: 700, color: 'var(--text)'},
  meter: {display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: 'var(--su)'},
  meterPart: {display: 'block', height: '100%'},
  parts: {listStyle: 'none', margin: 0, padding: 0, display: 'grid', rowGap: 4},
  part: {display: 'flex', alignItems: 'center', gap: 8},
  partLabel: {flex: '1', color: 'var(--muted)'},
  partValue: {fontVariantNumeric: 'tabular-nums', fontWeight: 600},
  partShare: {minWidth: '4ch', textAlign: 'right', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums'},
  note: {margin: 0, color: 'var(--muted)'},
  hint: {display: 'block'},
  list: {listStyle: 'none', marginTop: 6, marginBottom: 0, marginInline: 0, padding: 0, display: 'grid', rowGap: 2},
  listButton: {
    width: '100%',
    display: 'grid',
    gridTemplateColumns: '12px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 8,
    borderWidth: 0,
    borderRadius: 6,
    paddingBlock: 5,
    paddingInline: 6,
    backgroundColor: {default: 'transparent', ':hover': 'var(--panel)'},
    textAlign: 'left',
  },
  listName: {overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'},
  listValue: {color: 'var(--muted)', fontVariantNumeric: 'tabular-nums'},
})
