import * as stylex from '@stylexjs/stylex'
import {useLayoutEffect, useRef, useState} from 'react'
import {classes} from '../classes.ts'
import {number, size} from './format.ts'
import {byBytes, compact, within} from './model.ts'
import type {TreeNode, View} from './model.ts'

type Rect = {x: number; y: number; w: number; h: number}
interface Tile extends Rect {
  row: View
  depth: number
  group: boolean
  width: number
  height: number
}

// Folders and bundles with room show their contents, up to this many levels below the focus.
const NEST_DEPTH = 3,
  HEADER = 24,
  PAD = 4

// Splits each level in two halves by bytes, along the longer side.
function layout(items: View[], width: number, height: number) {
  const tiles: Tile[] = [],
    rects = new Map<TreeNode, Rect>()
  const place = (items: View[], x: number, y: number, w: number, h: number, depth: number) => {
    if (!items.length) return
    if (items.length === 1) {
      const row = items[0],
        tileWidth = (w / 100) * width,
        tileHeight = (h / 100) * height
      // Nested slivers are unreadable and unclickable; the table still lists them.
      if (depth && (tileWidth < 4 || tileHeight < 4)) return
      rects.set(row.ref, {x, y, w, h})
      const children =
        row.kind !== 'file' && depth < NEST_DEPTH && tileWidth >= 110 && tileHeight >= 80
          ? byBytes([...row.children.values()].map(compact))
          : []
      tiles.push({row, x, y, w, h, depth, group: children.length > 0, width: tileWidth, height: tileHeight})
      if (children.length) {
        const px = (PAD / width) * 100,
          py = (PAD / height) * 100,
          top = (HEADER / height) * 100
        place(children, x + px, y + top, w - 2 * px, h - top - py, depth + 1)
      }
      return
    }
    const total = items.reduce((sum, row) => sum + row.bytes, 0)
    let sum = 0,
      index = 0
    while (index < items.length - 1 && sum < total / 2) sum += items[index++].bytes
    const ratio = sum / total
    if (w * width >= h * height) {
      place(items.slice(0, index), x, y, w * ratio, h, depth)
      place(items.slice(index), x + w * ratio, y, w * (1 - ratio), h, depth)
    } else {
      place(items.slice(0, index), x, y, w, h * ratio, depth)
      place(items.slice(index), x, y + h * ratio, w, h * (1 - ratio), depth)
    }
  }
  place(items, 0, 0, 100, 100, 0)
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
  tooltip: (row: View) => string
  onSelect: (node: TreeNode) => void
}

export function Treemap({items, focus, hidden, zoom, changing, color, tooltip, onSelect}: Props) {
  const layerRef = useRef<HTMLDivElement>(null)
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

  return (
    <div id="treemap" hidden={hidden} aria-label="Bundle size treemap" {...stylex.props(styles.treemap)}>
      <div ref={layerRef} {...classes('layer', stylex.props(styles.layer))}>
        {tiles.map(({row, x, y, w, h, depth, group, width, height}) => {
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
              title={tooltip(row)}
              aria-label={row.name + ', ' + number(row.bytes) + ' bytes'}
              onClick={() => onSelect(row.ref)}
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
                <span hidden={width < 85 || height < 96} {...stylex.props(styles.label)}>
                  {row.name}
                  <strong {...stylex.props(styles.size)}>{size(row.bytes)}</strong>
                  {measured > 0 && !changing && (
                    <span {...stylex.props(styles.share)}>{Math.round((row.unobservedBytes / measured) * 100) + '% never ran'}</span>
                  )}
                  <small {...stylex.props(styles.action)}>
                    {changing && row.newSources ? 'Contains new source' : row.kind === 'file' ? 'View details' : 'Open'}
                  </small>
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const motion = '@media (prefers-reduced-motion: no-preference)'
const styles = stylex.create({
  treemap: {
    position: 'relative',
    height: {default: 'clamp(320px, 58vh, 680px)', '@media (max-width: 650px)': 380},
    marginTop: 14,
    marginBottom: 18,
    marginInline: 0,
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
    paddingBottom: 8,
    paddingInline: 10,
    borderRadius: 6,
    backgroundColor: 'var(--chip)',
    boxShadow: '0 1px 2px rgb(0 0 0 / 0.12)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
  },
  size: {display: 'block', fontSize: 17, fontVariantNumeric: 'tabular-nums'},
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
})
