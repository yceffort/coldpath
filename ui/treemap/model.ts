import type {Change, Compression, FirstObserved, Loading, Report, SourceLabel} from '../types.ts'
import {loadGroups, loaded, shortPath} from './format.ts'

export const KEYS = ['bytes', 'observedBytes', 'unobservedBytes', 'unmeasuredBytes'] as const
const SUM_KEYS = [
  ...KEYS,
  'initialObserved',
  'interactionOnly',
  'initialUnknown',
  'earlierUnknown',
  'newSources',
  'growingSources',
  'shrinkingSources',
] as const
type SumKey = (typeof SUM_KEYS)[number]
// `first[i]`: bytes first observed in scenario i.
export type Sums = Record<SumKey, number> & {first: number[]}

export interface TreeNode extends Sums {
  name: string
  parent: TreeNode | null
  kind: 'root' | 'folder' | 'bundle' | 'file'
  children: Map<string, TreeNode>
  change?: Change
  loading?: Loading
  label?: SourceLabel
  source?: string
  package?: string
  bundleIndex?: number
  sourceIndex?: number
  estimatedCompression?: Compression | null
  firstObserved?: FirstObserved[]
  search?: string
}
// A node as the current filters see it; `ref` is the node in the full tree.
export type View = Omit<TreeNode, 'children'> & {ref: TreeNode; children: Map<string, View>}

const add = (a: Sums, b: Partial<Sums>) => {
  for (const key of SUM_KEYS) a[key] += b[key] || 0
  a.first.forEach((_, index) => (a.first[index] += b.first?.[index] || 0))
}
const zero = (scenarios: number) =>
  ({...Object.fromEntries(SUM_KEYS.map((key) => [key, 0])), first: Array.from({length: scenarios}, () => 0)}) as Sums

export function build(report: Report, {group, scenario, initial}: {group: string; scenario: string; initial: string}) {
  const scenarioReports = new Map(report.scenarioReports.map((row) => [row.scenario, row]))
  const make = (name: string, parent: TreeNode | null, kind: TreeNode['kind']): TreeNode => ({
    name,
    parent,
    kind,
    children: new Map(),
    ...zero(report.scenarios.length),
  })
  const grouped = report.bundles.some((bundle) => bundle.loading)
  const selected = scenarioReports.get(scenario)
  const selectedBundles = new Map((selected?.bundles || []).map((b) => [b.path, b]))
  const initialReport = scenarioReports.get(initial)
  const initialBundles = new Map((initialReport?.bundles || []).map((b) => [b.path, b]))
  const changes = selected ? report.baseline?.scenarios.find((s) => s.scenario === selected.scenario) : report.baseline
  const sourceChanges = new Map((changes?.sources || []).map((row) => [row.name, row]))
  const bundleChanges = new Map((changes?.bundles || []).map((row) => [row.name, row]))
  const root = make('All bundles', null, 'root')
  for (const [bundleIndex, bundle] of report.bundles.entries()) {
    let parent = root
    if (grouped) {
      const key = 'load:' + (bundle.loading?.load || 'unknown')
      if (!root.children.has(key))
        root.children.set(key, make(loadGroups[bundle.loading?.load ?? ''] || 'Load cause unknown', root, 'folder'))
      parent = root.children.get(key)!
    }
    const node = make(bundle.path, parent, 'bundle')
    node.change = bundleChanges.get(bundle.path)
    node.loading = bundle.loading
    parent.children.set(bundle.path, node)
    const selectedSources = new Map((selectedBundles.get(bundle.path)?.sources || []).map((s) => [s.source, s]))
    const initialSources = new Map((initialBundles.get(bundle.path)?.sources || []).map((s) => [s.source, s]))
    for (const [sourceIndex, original] of bundle.sources.entries()) {
      const source = selectedSources.get(original.source) || original
      const parts = group === 'package' ? [source.package, shortPath(source.source)] : shortPath(source.source).split('/').filter(Boolean)
      if (group === 'path' && parts[0] === '..') {
        let prefix = ''
        while (parts[0] === '..') {
          prefix += '../'
          parts.shift()
        }
        parts.unshift('Outside analysis root (' + prefix + ')')
      }
      if (!parts.length) parts.push(source.source || '(unnamed source)')
      let parent = node
      for (let i = 0; i < parts.length; i++) {
        const leaf = i === parts.length - 1,
          key = (leaf ? 'file:' : 'folder:') + parts[i]
        if (!parent.children.has(key))
          parent.children.set(
            key,
            make(
              leaf && original.label?.shortName ? '≈ ' + original.label.shortName + ' (' + parts[i] + ')' : parts[i],
              parent,
              leaf ? 'file' : 'folder',
            ),
          )
        parent = parent.children.get(key)!
      }
      parent.label = original.label
      parent.source = source.source
      parent.package = source.package
      parent.bundleIndex = bundleIndex
      parent.sourceIndex = sourceIndex
      parent.change = sourceChanges.get(source.source)
      parent.estimatedCompression = original.estimatedCompression
      parent.firstObserved = original.firstObserved || []
      for (const phase of parent.firstObserved) {
        const index = report.scenarios.indexOf(phase.scenario)
        if (phase.earlierUnmeasured) parent.earlierUnknown += phase.bytes
        else if (index >= 0) parent.first[index] += phase.bytes
      }
      const first = initialSources.get(source.source)
      parent.initialObserved = first?.observedBytes || 0
      parent.interactionOnly = first && !first.unmeasuredBytes ? original.observedBytes - first.observedBytes : 0
      parent.initialUnknown = first?.unmeasuredBytes ? original.observedBytes : 0
      parent.newSources = Number(parent.change?.change === 'added')
      parent.growingSources = Number((parent.change?.delta.bytes ?? 0) > 0)
      parent.shrinkingSources = Number((parent.change?.delta.bytes ?? 0) < 0)
      parent.search = (
        source.source +
        ' ' +
        source.package +
        ' ' +
        bundle.path +
        ' ' +
        [
          original.label?.name,
          original.label?.shortName,
          original.label?.summary,
          ...(original.label?.contents || []).map((part) => part.name),
        ]
          .filter(Boolean)
          .join(' ')
      ).toLowerCase()
      add(parent, source)
    }
  }
  const total = (node: TreeNode) => {
    for (const child of node.children.values()) {
      total(child)
      add(node, child)
    }
  }
  total(root)
  return {root, changes}
}

export interface Filters {
  search: string
  mapped: boolean
  // Bundles no recording loaded are hidden unless this is set.
  unloaded: boolean
  recorded: boolean
}

export function filtered(node: TreeNode, filters: Filters): View | null {
  if (node.kind === 'bundle' && filters.recorded && !filters.unloaded && !loaded(node)) return null
  if (node.kind === 'file')
    return (!filters.mapped || node.source !== '[unmapped]') && node.search!.includes(filters.search.toLowerCase())
      ? ({...node, ref: node} as View)
      : null
  const result: View = {...node, ref: node, children: new Map(), ...zero(node.first.length)}
  for (const [key, child] of node.children) {
    const match = filtered(child, filters)
    if (match) {
      result.children.set(key, match)
      add(result, match)
    }
  }
  return result.children.size ? result : null
}

// A chain of single folders reads as one path.
export function compact(node: View): View {
  let name = node.name
  while (node.kind === 'folder' && node.children.size === 1) {
    const child = node.children.values().next().value!
    if (child.kind !== 'folder') break
    node = child
    name += '/' + node.name
  }
  return {...node, name}
}

// Each zoom is a history entry, so the browser's back button goes up a level.
export function keyPath(node: TreeNode) {
  const path = []
  for (; node.parent; node = node.parent) path.unshift([...node.parent.children].find(([, child]) => child === node)![0])
  return path
}

export function resolve(root: TreeNode, path: string[]) {
  let node = root
  for (const key of path) {
    const child = node.children.get(key)
    if (!child) break
    node = child
  }
  return node
}

export const within = (node: TreeNode | null, ancestor: TreeNode) => {
  for (; node; node = node.parent) if (node === ancestor) return true
  return false
}

// What tile area shows: loaded bytes, or the bytes that never ran.
export type Area = 'bytes' | 'unobservedBytes'
export const byArea = (rows: View[], area: Area) => rows.filter((row) => row[area] > 0).sort((a, b) => b[area] - a[area])

// One row that adds up `rows`, the children of `parent`, as the "N smaller items" tile and its view do.
export function merge(name: string, parent: TreeNode, rows: View[]): View {
  const row: View = {...zero(parent.first.length), name, parent, kind: 'folder', ref: parent, children: new Map()}
  for (const each of rows) add(row, each)
  return row
}

// The keys under `parent` of the children that hold `rows`, which compact() may have replaced with descendants.
export function keysUnder(parent: TreeNode, rows: View[]) {
  const keys = new Map([...parent.children].map(([key, child]) => [child, key]))
  return rows.map((row) => {
    let node = row.ref
    while (node.parent !== parent) node = node.parent!
    return keys.get(node)!
  })
}

// The files under `rows` with the most bytes that never ran.
export function coldest(rows: View[], count: number) {
  const files: View[] = []
  const walk = (row: View) => (row.kind === 'file' ? row.unobservedBytes > 0 && files.push(row) : row.children.forEach(walk))
  rows.forEach(walk)
  return files.sort((a, b) => b.unobservedBytes - a.unobservedBytes).slice(0, count)
}
