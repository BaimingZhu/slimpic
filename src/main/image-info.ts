// Header-only image inspection, ported from slimdeer's web/worker.js so the
// browser build's limits apply identically here.

export const MAX_PIXELS = 40e6
export const MAX_ANIMATION_PIXELS = 30e6
export const AVIF_MAX_PIXELS = 24e6
export const WEBP_MAX_SIDE = 16383

export type SniffKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'bmp' | 'ico' | 'svg' | 'unknown'

export function sniff(head: Buffer): SniffKind {
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.length >= 6 && head.toString('latin1', 0, 3) === 'GIF') return 'gif'
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp' && /avif|avis/.test(head.toString('latin1', 8, 12))) return 'avif'
  if (head.length >= 2 && head.toString('latin1', 0, 2) === 'BM') return 'bmp'
  if (head.length >= 4 && head.readUInt16LE(0) === 0 && head.readUInt16LE(2) === 1) return 'ico'
  const text = head.toString('utf8', 0, Math.min(head.length, 512)).trimStart()
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'svg'
  return 'unknown'
}

// Number of frames of an animated PNG (its acTL chunk, ahead of the image data), else 1.
export function pngFrames(png: Buffer): number {
  let pos = 8
  while (pos + 16 <= png.length) {
    const len = png.readUInt32BE(pos)
    const kind = png.toString('latin1', pos + 4, pos + 8)
    if (kind === 'IDAT') return 1
    if (kind === 'acTL') return png.readUInt32BE(pos + 8)
    if (len > 0x7fffffff) break // malformed chunk
    pos += 12 + len
  }
  return 1
}

// A JPEG's width and height from its frame header (SOF0-SOF15 but DHT, JPG and DAC); [0,0] if none.
export function jpegSize(jpeg: Buffer): [number, number] {
  let pos = 2
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const marker = jpeg[pos + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2 // no payload
      continue
    }
    if (marker === 0xda || marker === 0xd9) break // scan data / end
    if (pos + 4 > jpeg.length) break
    const len = jpeg.readUInt16BE(pos + 2)
    if (len < 2) break // malformed segment
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (pos + 9 > jpeg.length) break
      return [jpeg.readUInt16BE(pos + 7), jpeg.readUInt16BE(pos + 5)]
    }
    pos += 2 + len
  }
  return [0, 0]
}

export interface ImageDims {
  width: number
  height: number
  frames: number
}

export function imageDims(buf: Buffer, kind: 'png' | 'jpeg'): ImageDims {
  if (kind === 'png') {
    if (buf.length < 24) return { width: 0, height: 0, frames: 1 }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), frames: pngFrames(buf) }
  }
  const [width, height] = jpegSize(buf)
  return { width, height, frames: 1 }
}

// Returns a human-readable reason when the file exceeds a build limit, else null.
export function sizeLimitReason(dims: ImageDims, format: 'original' | 'webp' | 'avif', kind: 'png' | 'jpeg'): string | null {
  const { width, height, frames } = dims
  const pixels = width * height
  const mp = (n: number): string => (n / 1e6).toFixed(1)
  if (width === 0 || height === 0) return null // unknown dims: let the encoder decide
  if (pixels > MAX_PIXELS) return `图片过大：${width}×${height}（${mp(pixels)} MP），上限 ${MAX_PIXELS / 1e6} MP`
  if (frames > 1 && pixels * frames > MAX_ANIMATION_PIXELS) {
    return `动画过大：${frames} 帧 × ${width}×${height}（${mp(pixels * frames)} MP），上限 ${MAX_ANIMATION_PIXELS / 1e6} MP`
  }
  if (format === 'avif' && pixels > AVIF_MAX_PIXELS) return `AVIF 输出上限 ${AVIF_MAX_PIXELS / 1e6} MP，此图 ${mp(pixels)} MP`
  if (format === 'webp' && Math.max(width, height) > WEBP_MAX_SIDE) {
    return `WebP 单边上限 ${WEBP_MAX_SIDE}px，此图 ${width}×${height}；请保持 ${kind === 'jpeg' ? 'JPEG' : 'PNG'} 格式`
  }
  return null
}