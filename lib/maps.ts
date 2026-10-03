import assert from 'node:assert/strict'
import {readFile, realpath} from 'node:fs/promises'
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path'

export async function readMap(file: string, content: string, root: string) {
  const lastLine = content
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .findLast((line) => line.trim())
    ?.trim()
  const reference = lastLine?.match(/^\/\/[#@]\s*sourceMappingURL=(.*)$/)?.[1].trim()
  if (reference !== undefined) {
    assert(
      reference && !reference.includes(':') && !reference.startsWith('/') && !reference.includes('\\'),
      `only relative local sourceMappingURL is supported: ${reference}`,
    )
  }
  const path = reference === undefined ? `${file}.map` : resolve(dirname(file), decodeURIComponent(reference.split(/[?#]/)[0]))
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && reference === undefined) return null
    throw error
  }
  const local = relative(await realpath(root), canonical)
  assert(local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local), 'source map escapes --dir')
  return readFile(canonical)
}
