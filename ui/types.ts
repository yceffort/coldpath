// The JSON that src/report.rs embeds in both pages (HtmlReport and ChunkDetails).
export interface Counts {
  bytes: number
  observedBytes: number
  unobservedBytes: number
  unmeasuredBytes: number
}
export type CountKey = keyof Counts

export interface Compression {
  gzipBytes: number
  brotliBytes: number
}

export interface Verification {
  scenario: string
  format: string
  source: string
  sourceMap: string
}

export interface FirstObserved {
  scenario: string
  bytes: number
  earlierUnmeasured: boolean
}

export interface SourceLabel {
  name?: string
  shortName?: string
  kind?: string
  summary?: string
  reasoning?: string
  evidence?: string[]
  contents?: {name: string; kind?: string; evidence: string[]}[]
}

export interface Loading {
  load: 'html' | 'inline' | 'dynamic'
  initiator?: string
  startMs?: number
}

export interface Position {
  line: number
  column: number
}

export interface MappingRef {
  generatedLine: number
  generatedColumn: number
  source: string
  original: Position | null
}

export interface MappingDiagnostic extends MappingRef {
  reason: 'insideSurrogatePair' | 'columnOutsideLine'
  previous: MappingRef | null
  next: MappingRef | null
  inspectRegion: {start: number; end: number}
  assignments: {source: string; start: number; end: number}[]
}

export interface Source extends Counts {
  source: string
  package: string
  hasContent: boolean
  firstObserved: FirstObserved[]
  estimatedCompression: Compression | null
  label?: SourceLabel
  mappingDiagnostics?: number[]
}

export interface Bundle extends Counts {
  path: string
  sources: Source[]
  verification: Verification[]
  loading?: Loading
  mappingDiagnostics?: MappingDiagnostic[]
}

export interface InteractionCandidate {
  source: string
  package: string
  interactionOnlyBytes: number
  initialUnmeasuredObservedBytes: number
  estimatedDeferrableCompression: Compression | null
}

export interface ScenarioReport {
  scenario: string
  totals: Counts
  bundles: (Counts & {path: string; sources: (Counts & {source: string; package: string})[]})[]
  interactionCandidates: InteractionCandidate[]
}

export interface Change {
  name: string
  change: 'added' | 'removed' | 'changed' | 'unchanged'
  before: Counts
  after: Counts
  delta: Counts
}

export interface Comparison {
  totals: Change
  sources: Change[]
  bundles: Change[]
  scenarios: (Omit<Comparison, 'scenarios'> & {scenario: string})[]
}

export interface ImportStep {
  from: string
  to: string
  kind: string
  location: Position | null
}

export interface ImportPath {
  source: string
  resolvedSource?: string
  path?: string[]
  graphFormat: string
  edges: ImportStep[]
}

export interface Recommendation {
  kind: string
  source: string
  scenario: string | null
  bytes: number
  estimatedCompression: Compression | null
  explanation: string
}

export interface Cost {
  status: 'measured' | 'insufficient'
  medianSamples: number
  medianUs: number
  q1Us: number
  q3Us: number
}

export interface CpuReport {
  minSamples: number
  scenarios: {
    scenario: string
    runs: number
    bundles: string[]
    windows: {
      window: string
      sources: (Cost & {source: string})[]
      topLevel: (Cost & {path: string})[]
    }[]
  }[]
}

export interface Report {
  totals: Counts
  scenarios: string[]
  initialScenario: string | null
  scenarioReports: ScenarioReport[]
  baseline: Comparison | null
  importPaths: ImportPath[] | null
  recommendations: Recommendation[]
  inspectorHtml?: string
  warnings: string[]
  excludedBundles: string[]
  budgetFailures: string[]
  compression: Compression | null
  labelGenerator?: {provider?: string; model?: string}
  cpu?: CpuReport | null
  duplicateSources: (Counts & {source: string; label?: SourceLabel; duplicates: {bundles: number; extraBytes: number}})[]
  bundles: Bundle[]
}

// [start, end, startUtf16, endUtf16, source index, status (0 observed, 1 unobserved, 2 unmeasured), original line, original column]
export type CompactSpan = [number, number, number, number, number, 0 | 1 | 2, number | null, number | null]

export interface ChunkDetails {
  generatedSource: string
  contents: (string | null)[]
  spans: CompactSpan[]
  scenarioSpans?: Record<string, CompactSpan[]>
}
