import * as stylex from '@stylexjs/stylex'
import {treemapSquarify} from 'd3-hierarchy'
import type {HierarchyRectangularNode} from 'd3-hierarchy'
import {useLayoutEffect, useRef, useState} from 'react'
import type {MouseEvent, PointerEvent, RefObject} from 'react'
import {classes} from '../classes.ts'
import type {Segment} from './App.tsx'
import {loadText, number, shortPath, signed, size} from './format.ts'
import {byBytes, compact, within} from './model.ts'
import type {TreeNode, View} from './model.ts'
import {shared} from './styles.ts'

type Rect = {x: number; y: number; w: number; h: number}
// How much of a label fits: name, size, share never run, and action; name and size; name; nothing.
type Tier = 'full' | 'medium' | 'small' | 'none'
interface Tile extends Rect {
  row: View
  depth: number
  group: boolean
  tier: Tier
  // A medium label whose tile is tall enough wraps its name onto a second line instead of cutting it short.
  wrap: boolean
}

// Folders and bundles with room show their contents, up to this many levels below the focus.
const NEST_DEPTH = 3,
  HEADER = 24,
  PAD = 4

// The thresholds are the label heights: 104 px full, 46 px medium (63 px wrapped), 24 px small.
const tier = (width: number, height: number): Tier =>
  width >= 110 && height >= 112 ? 'full' : width >= 60 && height >= 46 ? 'medium' : width >= 36 && height >= 24 ? 'small' : 'none'

// Squarified tiles, so that small entries become boxes rather than slivers. Positions are percentages of the frame.
function layout(items: View[], width: number, height: number) {
  const tiles: Tile[] = [],
    rects = new Map<TreeNode, Rect>()
  if (!width || !height) return {tiles, rects}
  const place = (items: View[], x0: number, y0: number, x1: number, y1: number, depth: number) => {
    const nodes = items.map((row) => ({row, value: row.bytes, x0: 0, y0: 0, x1: 0, y1: 0}))
    const parent = {value: items.reduce((sum, row) => sum + row.bytes, 0), children: nodes}
    treemapSquarify(parent as unknown as HierarchyRectangularNode<unknown>, x0, y0, x1, y1)
    for (const {row, ...box} of nodes) {
      const tileWidth = box.x1 - box.x0,
        tileHeight = box.y1 - box.y0
      // Nested slivers are unreadable and unclickable; the table still lists them.
      if (depth && (tileWidth < 4 || tileHeight < 4)) continue
      const rect = {x: (box.x0 / width) * 100, y: (box.y0 / height) * 100, w: (tileWidth / width) * 100, h: (tileHeight / height) * 100}
      rects.set(row.ref, rect)
      const children =
        row.kind !== 'file' && depth < NEST_DEPTH && tileWidth >= 110 && tileHeight >= 80
          ? byBytes([...row.children.values()].map(compact))
          : []
      tiles.push({row, ...rect, depth, group: children.length > 0, tier: tier(tileWidth, tileHeight), wrap: tileHeight >= 64})
      if (children.length) place(children, box.x0 + PAD, box.y0 + HEADER, box.x1 - PAD, box.y1 - PAD, depth + 1)
    }
  }
  place(items, 0, 0, width, height, 0)
  return {tiles, rects}
}

// The drawn box closest to `node`: itself, or the nearest ancestor that has a box.
const box = (map: Map<TreeNode, Rect>, node: TreeNode | null) => {
  for (; node; node = node.parent) if (map.has(node)) return map.get(node)
}
const fit = (r: Rect) => `translate(${r.x}%,${r.y}%) scale(${r.w / 100},${r.h / 100})`
const fill = (r: Rect) => `translate(${(-100 * r.x) / r.w}%,${(-100 * r.y) / r.h}%) scale(${100 / r.w},${100 / r.h})`

interface Props {
  items: View[]
  focus: TreeNode
  hidden: boolean
  // Changes on every navigation that zooms, but not when the tree is rebuilt.
  zoom: number
  changing: boolean
  color: (row: View) => string
  segments: (row: View) => Segment[]
  onSelect: (node: TreeNode) => void
}

export function Treemap({items, focus, hidden, zoom, changing, color, segments, onSelect}: Props) {
  const frameRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const card = useRef<CardControl>(null)
  const [frame, setFrame] = useState({width: 0, height: 0})
  // Layout reads the drawn size, which changes with the window, scroll bars, and visibility.
  const measure = () => {
    const {clientWidth: width, clientHeight: height} = layerRef.current!
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
  const {tiles, rects} = hidden ? {tiles: [], rects: new Map<TreeNode, Rect>()} : layout(byBytes(items), frame.width, frame.height)

  // Zooming in grows the new focus from the box that was selected; zooming out shrinks the previous focus back into its box.
  const previous = useRef({focus, rects, shown: !hidden})
  useLayoutEffect(() => {
    card.current?.hide()
    const before = previous.current
    if (!before.shown || hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const zoomingIn = within(focus, before.focus)
    const rect = zoomingIn ? box(before.rects, focus) : within(before.focus, focus) ? box(rects, before.focus) : undefined
    if (rect)
      layerRef.current!.animate([{transform: zoomingIn ? fit(rect) : fill(rect)}, {transform: 'none'}], {
        duration: 320,
        easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      })
  }, [zoom])
  useLayoutEffect(() => {
    previous.current = {focus, rects, shown: !hidden}
  })

  // A touch has no hover: the first tap on a tile shows its card, and a second tap selects it.
  const pointer = useRef({touch: false, shown: false})
  const near = (element: HTMLElement) => {
    const frame = frameRef.current!.getBoundingClientRect(),
      tile = element.getBoundingClientRect()
    return {x: tile.left - frame.left + 12, y: tile.top - frame.top + 12}
  }
  const at = (event: PointerEvent | MouseEvent) => {
    const frame = frameRef.current!.getBoundingClientRect()
    return {x: event.clientX - frame.left, y: event.clientY - frame.top}
  }

  return (
    <div ref={frameRef} hidden={hidden} onPointerLeave={() => card.current?.hide()} {...stylex.props(styles.frame)}>
      <div id="treemap" aria-label="Bundle size treemap" {...stylex.props(styles.treemap)}>
        <div ref={layerRef} {...classes('layer', stylex.props(styles.layer))}>
          {tiles.map(({row, x, y, w, h, depth, group, tier, wrap}) => {
            const newSource = changing && row.newSources > 0
            const measured = row.bytes - row.unmeasuredBytes
            return (
              <button
                key={depth + '/' + row.ref.name + '/' + x + '/' + y}
                data-depth={depth}
                tabIndex={depth ? -1 : undefined}
                data-bytes={row.bytes}
                data-interaction-only={row.interactionOnly}
                data-initial-unknown={row.initialUnknown}
                data-first-observed={JSON.stringify(row.first)}
                data-earlier-unknown={row.earlierUnknown}
                data-change={row.change?.change || ''}
                data-kind={row.kind}
                style={{left: x + '%', top: y + '%', width: w + '%', height: h + '%', background: group ? 'var(--raised)' : color(row)}}
                aria-label={row.name + ', ' + number(row.bytes) + ' bytes'}
                onPointerDown={(event) => {
                  pointer.current = {touch: event.pointerType === 'touch', shown: card.current?.showing() === row.ref}
                }}
                onPointerMove={(event) => {
                  if (event.pointerType !== 'touch') card.current?.show(row, at(event))
                }}
                onFocus={(event) => card.current?.show(row, near(event.currentTarget))}
                onBlur={() => card.current?.hide()}
                onClick={(event) => {
                  // Keyboard activation reports no clicks (`detail` 0) and always selects.
                  if (event.detail && pointer.current.touch && !pointer.current.shown) {
                    card.current?.show(row, near(event.currentTarget), true)
                    return
                  }
                  onSelect(row.ref)
                }}
                {...classes(
                  'tile' + (group ? ' group' : '') + (newSource ? ' new-source' : ''),
                  stylex.props(stylex.defaultMarker(), styles.tile, group && styles.group, newSource && styles.newSource),
                )}
              >
                {group ? (
                  <span {...stylex.props(styles.groupLabel)}>
                    {row.name}
                    <strong {...stylex.props(styles.groupSize)}>{size(row.bytes)}</strong>
                  </span>
                ) : (
                  <span
                    hidden={tier === 'none'}
                    {...stylex.props(styles.label, tier === 'medium' && styles.medium, tier === 'small' && styles.small)}
                  >
                    <span {...stylex.props(styles.name, tier === 'medium' && wrap && styles.wrap)}>{row.name}</span>
                    {tier !== 'small' && (
                      <strong {...stylex.props(styles.size, tier === 'medium' && styles.mediumSize)}>{size(row.bytes)}</strong>
                    )}
                    {tier === 'full' && measured > 0 && !changing && (
                      <span {...stylex.props(styles.share)}>{Math.round((row.unobservedBytes / measured) * 100) + '% never ran'}</span>
                    )}
                    {tier === 'full' && (
                      <small {...stylex.props(styles.action)}>
                        {changing && row.newSources ? 'Contains new source' : row.kind === 'file' ? 'View details' : 'Open'}
                      </small>
                    )}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
      <Card control={card} frameRef={frameRef} segments={segments} />
    </div>
  )
}

interface CardControl {
  show: (row: View, point: {x: number; y: number}, touch?: boolean) => void
  hide: () => void
  showing: () => TreeNode | undefined
}

// The numbers behind one tile, beside the pointer, the focused tile, or the tapped tile.
function Card({
  control,
  frameRef,
  segments,
}: {
  control: RefObject<CardControl | null>
  frameRef: RefObject<HTMLDivElement | null>
  segments: (row: View) => Segment[]
}) {
  const [card, setCard] = useState<{row: View; x: number; y: number; touch: boolean} | null>(null)
  const current = useRef(card)
  current.current = card
  useLayoutEffect(() => {
    control.current = {
      show: (row, {x, y}, touch = false) =>
        setCard((card) => (card?.row === row && card.x === x && card.y === y && card.touch === touch ? card : {row, x, y, touch})),
      hide: () => setCard(null),
      showing: () => current.current?.row.ref,
    }
  }, [])
  if (!card) return null
  const {row, x, y, touch} = card
  const frame = frameRef.current!
  const width = frame.clientWidth,
    height = frame.clientHeight
  const parts = segments(row).filter(([bytes]) => bytes > 0)
  const measured = row.bytes - row.unmeasuredBytes
  // Narrow frames put the card across the full width; wider ones keep it on the roomier side of the pointer.
  const narrow = width < 520
  const left = x > width / 2,
    above = y > height / 2
  return (
    <div
      id="tile-card"
      aria-hidden="true"
      style={{
        left: narrow ? 8 : x + (left ? -14 : 14),
        top: y + (above ? -14 : 14),
        transform: `translate(${narrow || !left ? 0 : '-100%'}, ${above ? '-100%' : 0})`,
        ...(narrow ? {right: 8} : {}),
      }}
      {...stylex.props(styles.card, narrow && styles.cardNarrow)}
    >
      <strong {...stylex.props(styles.cardName)}>{row.name}</strong>
      {row.kind === 'file' && row.source && <code {...stylex.props(styles.cardPath)}>{shortPath(row.source)}</code>}
      <div {...stylex.props(styles.cardSize)}>
        {size(row.bytes)}
        {measured > 0 && (
          <span {...stylex.props(styles.cardShare)}>{' · ' + Math.round((row.unobservedBytes / measured) * 100) + '% never ran'}</span>
        )}
      </div>
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
          </li>
        ))}
      </ul>
      {row.label?.name && <p {...stylex.props(styles.cardNote)}>{'Inferred (AI guess): ' + row.label.name}</p>}
      {row.label?.contents?.length ? (
        <p {...stylex.props(styles.cardNote)}>
          {'Inferred contents (AI guess): ' + row.label.contents.map((part) => part.name).join(', ')}
        </p>
      ) : null}
      {row.loading && <p {...stylex.props(styles.cardNote)}>{'Loaded: ' + loadText(row.loading)}</p>}
      {row.change && (
        <p {...stylex.props(styles.cardNote)}>
          {'Baseline ' +
            (row.kind === 'file' ? '(source across all bundles)' : '(bundle)') +
            ': ' +
            signed(row.change.delta.bytes) +
            ' B; unobserved ' +
            signed(row.change.delta.unobservedBytes) +
            ' B'}
        </p>
      )}
      <small {...stylex.props(styles.cardHint)}>
        {(touch ? 'Tap again' : 'Select') + (row.kind === 'file' ? ' to see details' : ' to zoom in')}
      </small>
    </div>
  )
}

const motion = '@media (prefers-reduced-motion: no-preference)'
const styles = stylex.create({
  frame: {position: 'relative', marginTop: 14, marginBottom: 18},
  treemap: {
    position: 'relative',
    height: {default: 'clamp(320px, 58vh, 680px)', '@media (max-width: 650px)': 380},
    borderRadius: 8,
    overflow: 'hidden',
  },
  layer: {position: 'absolute', inset: 0, transformOrigin: '0 0'},
  tile: {
    position: 'absolute',
    borderWidth: 0,
    padding: 0,
    overflow: 'hidden',
    borderRadius: 6,
    boxShadow: {
      default: 'inset 0 0 0 2px var(--panel), inset 0 0 0 3px var(--edge)',
      ':hover': 'inset 0 0 0 2px var(--panel), inset 0 0 0 4px var(--text)',
      ':focus-visible': 'inset 0 0 0 2px var(--panel), inset 0 0 0 4px var(--text)',
    },
    zIndex: {default: null, ':hover': 1, ':focus-visible': 1},
    outline: {default: null, ':focus-visible': 'none'},
    textAlign: 'left',
    color: 'var(--text)',
    transition: {default: null, [motion]: 'box-shadow 0.12s, background-color 0.12s'},
  },
  // A folder or bundle drawn with its contents: a title strip over nested tiles.
  group: {display: 'flex', flexDirection: 'column'},
  newSource: {outlineWidth: 3, outlineStyle: 'dashed', outlineColor: 'var(--accent)', outlineOffset: -7},
  label: {
    display: 'inline-block',
    maxWidth: 'calc(100% - 16px)',
    margin: 8,
    paddingTop: 7,
    paddingInline: 10,
    paddingBottom: 8,
    borderRadius: 6,
    backgroundColor: 'var(--chip)',
    boxShadow: '0 1px 2px rgb(0 0 0 / 0.12)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
  },
  medium: {maxWidth: 'calc(100% - 8px)', margin: 4, paddingBlock: 3, paddingInline: 6, fontSize: 13, lineHeight: '17px'},
  small: {maxWidth: 'calc(100% - 6px)', margin: 3, paddingBlock: 1, paddingInline: 5, fontSize: 12, lineHeight: '16px'},
  name: {display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'},
  wrap: {whiteSpace: 'normal', overflowWrap: 'anywhere', maxHeight: 34},
  size: {display: 'block', fontSize: 17, fontVariantNumeric: 'tabular-nums'},
  mediumSize: {fontSize: 13, fontWeight: 500, color: 'var(--muted)'},
  share: {display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--muted)'},
  action: {
    display: 'block',
    fontWeight: 500,
    color: 'var(--accent)',
    textDecoration: {default: null, [stylex.when.ancestor(':hover')]: 'underline'},
  },
  groupLabel: {
    display: 'flex',
    gap: 8,
    maxWidth: 'none',
    margin: 0,
    paddingBlock: 4,
    paddingInline: 8,
    borderRadius: 6,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
    fontSize: 12,
    lineHeight: '16px',
  },
  groupSize: {display: 'inline', fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums'},
  card: {
    position: 'absolute',
    zIndex: 2,
    width: 'max-content',
    maxWidth: 320,
    paddingBlock: 12,
    paddingInline: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    backgroundColor: 'var(--panel)',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
    pointerEvents: 'none',
    fontSize: 13,
    lineHeight: 1.45,
    overflowWrap: 'anywhere',
  },
  cardNarrow: {width: 'auto', maxWidth: 'none'},
  cardName: {display: 'block', fontSize: 15},
  cardPath: {display: 'block', color: 'var(--muted)', marginTop: 2},
  cardSize: {marginTop: 6, fontWeight: 650, fontVariantNumeric: 'tabular-nums'},
  cardShare: {fontWeight: 500, color: 'var(--muted)'},
  meter: {display: 'flex', height: 8, marginTop: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: 'var(--unmeasured)'},
  meterPart: {display: 'block', height: '100%'},
  parts: {listStyle: 'none', margin: 0, marginTop: 8, padding: 0, display: 'grid', rowGap: 3},
  part: {display: 'flex', alignItems: 'center', gap: 8},
  partLabel: {flex: '1', color: 'var(--muted)'},
  partValue: {fontVariantNumeric: 'tabular-nums', fontWeight: 600},
  cardNote: {marginBlock: 6, marginInline: 0, color: 'var(--muted)'},
  cardHint: {display: 'block', marginTop: 8, color: 'var(--accent)', fontWeight: 500},
})
