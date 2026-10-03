import type {Bundle, ChunkDetails, CompactSpan, Report, Source} from '../types.ts'

// Large payloads arrive gzip-compressed and base64-encoded (src/report.rs).
export async function decodeData<T>(id: string): Promise<T> {
  const data = document.getElementById(id)!
  let payload = data.textContent!
  if (data.dataset.encoding === 'gzip-base64') {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    payload = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  }
  const decoded = JSON.parse(payload)
  data.dataset.decodeCount = String(Number(data.dataset.decodeCount || 0) + 1)
  return decoded
}

export type CodeSource = Source & {content: string | null}
export type CodeBundle = Omit<Bundle, 'sources'> & Omit<ChunkDetails, 'contents'> & {sources: CodeSource[]}

// One chunk's code is decoded when it is first inspected and kept only while it stays open.
let loaded: {index: number; bundle: CodeBundle} | null = null
let pending: {index: number; promise: Promise<CodeBundle>} | null = null

export function loadChunk(report: Report, index: number, keep: () => boolean): Promise<CodeBundle> {
  if (loaded?.index === index) return Promise.resolve(loaded.bundle)
  if (pending?.index === index) return pending.promise
  loaded = null
  const promise = decodeData<ChunkDetails>('chunk-data-' + index)
    .then((details) => {
      const meta = report.bundles[index]
      const bundle = {...meta, ...details, sources: meta.sources.map((source, i) => ({...source, content: details.contents[i]}))}
      if (keep()) loaded = {index, bundle}
      return bundle
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null
    })
  pending = {index, promise}
  return promise
}

export function forgetChunk() {
  loaded = null
}

export type Status = 'observed' | 'unobserved' | 'unmeasured'

export interface Span {
  index: number
  start: number
  end: number
  startUtf16: number
  endUtf16: number
  source: number
  status: Status
  original: {line: number; column: number} | null
}

export const spanAt = (bundle: {spans: CompactSpan[]}, index: number): Span => {
  const s = bundle.spans[index]
  return {
    index,
    start: s[0],
    end: s[1],
    startUtf16: s[2],
    endUtf16: s[3],
    source: s[4],
    status: (['observed', 'unobserved', 'unmeasured'] as const)[s[5]],
    original: s[6] === null ? null : {line: s[6], column: s[7]!},
  }
}
