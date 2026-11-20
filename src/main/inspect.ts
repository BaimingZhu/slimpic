import { open, readFile } from 'node:fs/promises'
import { sniff, imageDims, type SniffKind } from './image-info'

const HEAD_BYTES = 64 * 1024
const JPEG_EXTS = new Set(['.jpg', '.jpeg', '.jpe'])

async function readHead(p: string, size: number): Promise<Buffer> {
  const fh = await open(p, 'r')
  try {
    const len = Math.min(size, HEAD_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    return buf
  } finally {
    await fh.close()
  }
}

export interface InspectInfo {
  kind: SniffKind
  width: number
  height: number
  frames: number
  head: Buffer
}

// Sniffs the content and reads dimensions from the header. `null` means the
// file could not be read at all (as opposed to readable but unsupported).
export async function inspectImageFile(p: string, size: number, ext: string): Promise<InspectInfo | null> {
  let head: Buffer
  try {
    head = await readHead(p, size)
  } catch {
    return null
  }
  let kind = sniff(head)
  if (kind === 'unknown' && JPEG_EXTS.has(ext) && size > HEAD_BYTES) {
    // A camera JPEG's EXIF can push the SOF marker past the head window.
    try {
      kind = sniff(await readFile(p))
    } catch { /* keep unknown */ }
  }
  if (kind !== 'png' && kind !== 'jpeg') return { kind, width: 0, height: 0, frames: 1, head }
  let dims = imageDims(head, kind)
  if (kind === 'jpeg' && dims.width === 0 && size > HEAD_BYTES) {
    try {
      dims = imageDims(await readFile(p), kind)
    } catch { /* keep zeros; encoder will judge */ }
  }
  return { kind, ...dims, head }
}
