import type {Counts, Loading} from '../types.ts'

export const number = (value: number) => value.toLocaleString('en-US')
export const milliseconds = (us: number) => (us / 1000).toLocaleString('en-US', {maximumFractionDigits: 2}) + ' ms'
export const size = (value: number) =>
  value < 1000
    ? number(value) + ' B'
    : (value / (value < 1e6 ? 1e3 : 1e6)).toLocaleString('en-US', {maximumFractionDigits: 1}) + (value < 1e6 ? ' KB' : ' MB')
export const signed = (value: number) => (value > 0 ? '+' : '') + number(value)
// Display only: drop bundler URL prefixes and pnpm's store directories.
export const shortPath = (source: string) =>
  source
    .replaceAll('\\', '/')
    .replace(/^turbopack:\/\/\/\[project\]\//, '')
    .replace(/^webpack:\/\/[^/]*\//, '')
    .replace(/^(?:.*\/)?node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'node_modules/')
export const loaded = (row: Counts) => row.bytes - row.unmeasuredBytes

const phaseColors = ['var(--observed)', 'var(--interaction)', 'var(--phase-2)', 'var(--phase-3)']
export const phaseColor = (index: number) =>
  phaseColors[index] || `hsl(${(index * 137 + 30) % 360} 50% ${matchMedia('(prefers-color-scheme: dark)').matches ? 34 : 74}%)`

export const actionLabels: Record<string, string> = {
  'defer-review': 'Review lazy loading',
  'split-review': 'Split later-only functionality',
  'dynamic-boundary-review': 'Inspect existing dynamic import',
  'inspect-imports': 'Inspect import paths',
  'measure-initial': 'Measure initial execution',
  'removal-review': 'Review unused source',
}

// Present only with --loading. Groups are ordered from earliest to latest cause.
export const loadGroups: Record<string, string> = {
  html: 'Initial HTML tags',
  inline: 'Named in initial HTML data',
  dynamic: 'Loaded by scripts',
}
export const loadText = (loading?: Loading) =>
  loading
    ? loadGroups[loading.load] +
      (loading.initiator ? ' (initiator: ' + loading.initiator + ')' : '') +
      (loading.startMs !== undefined ? ', requested at ' + number(loading.startMs) + ' ms' : '')
    : ''
