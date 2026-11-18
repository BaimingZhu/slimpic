// Crops the rounded badge out of the source artwork, resizes with box
// filtering via pngjs, and writes build/icon.png + build/icon.ico + build/icon.icns.
// Usage: node scripts/make-icon.mjs <source.jpg|png>
//        node scripts/make-icon.mjs --icns-only   (rebuild icon.icns from build/icon.png)
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import pngToIco from 'png-to-ico'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Box-filter downscale of a crop region (sx,sy,side x side) to dw x dh.
function boxResize(srcData, srcWidth, side, sx, sy, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  const ratio = side / dw
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = sy + Math.floor(dy * ratio), sy1 = sy + Math.max(Math.floor((dy + 1) * ratio), Math.floor(dy * ratio) + 1)
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = sx + Math.floor(dx * ratio), sx1 = sx + Math.max(Math.floor((dx + 1) * ratio), Math.floor(dx * ratio) + 1)
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0; xx < sx1; xx++) {
          const i = (yy * srcWidth + xx) * 4
          r += srcData[i]; g += srcData[i + 1]; b += srcData[i + 2]; a += srcData[i + 3]; n++
        }
      }
      const o = (dy * dw + dx) * 4
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// Apple icon container: a header plus (type, length, PNG data) chunks.
async function writeIcns(pngBySize, dest) {
  const types = new Map([
    [16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'],
    [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']
  ])
  const chunks = []
  for (const [size, buf] of pngBySize) {
    const type = types.get(size)
    if (!type) continue
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(buf.length + 8, 4)
    chunks.push(head, buf)
  }
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'latin1')
  header.writeUInt32BE(body.length + 8, 4)
  await writeFile(dest, Buffer.concat([header, body]))
}

if (process.argv[2] === '--icns-only') {
  const master = PNG.sync.read(await readFile(path.join(ROOT, 'build', 'icon.png')))
  const map = new Map()
  for (const size of [16, 32, 64, 128, 256]) {
    const out = new PNG({ width: size, height: size })
    boxResize(master.data, master.width, master.width, 0, 0, size, size).copy(out.data)
    map.set(size, PNG.sync.write(out))
  }
  await writeIcns(map, path.join(ROOT, 'build', 'icon.icns'))
  console.log('wrote build/icon.icns from build/icon.png')
  process.exit(0)
}

const src = process.argv[2]
if (!src) throw new Error('usage: node scripts/make-icon.mjs <source-image> | --icns-only')

const buf = await readFile(src)
let rgba, width, height
if (buf[0] === 0xff && buf[1] === 0xd8) {
  const img = jpeg.decode(buf, { maxMemoryUsageInMB: 1024 })
  rgba = img.data; width = img.width; height = img.height
} else {
  const img = PNG.sync.read(buf)
  rgba = img.data; width = img.width; height = img.height
}

// Locate the bright rounded-square border: scan for near-white pixels.
let minX = width, minY = height, maxX = 0, maxY = 0
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    if (rgba[i] > 200 && rgba[i + 1] > 200 && rgba[i + 2] > 200) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
}
if (maxX <= minX || maxY <= minY) throw new Error('badge border not found')
// Square crop centred on the badge, small margin outside the border.
const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
const side = Math.round(Math.max(maxX - minX, maxY - minY) * 1.02)
const x0 = Math.max(0, Math.round(cx - side / 2))
const y0 = Math.max(0, Math.round(cy - side / 2))
const cropSide = Math.min(side, width - x0, height - y0)
console.log(`badge at (${minX},${minY})-(${maxX},${maxY}), crop ${cropSide}x${cropSide} @ (${x0},${y0})`)

const SIZES = [256, 128, 64, 48, 32, 24, 16]
await mkdir(path.join(ROOT, 'build'), { recursive: true })
const pngBufs = []
const icnsMap = new Map()
for (const size of SIZES) {
  const data = boxResize(rgba, width, cropSide, x0, y0, size, size)
  const png = new PNG({ width: size, height: size })
  data.copy(png.data)
  const encoded = PNG.sync.write(png)
  pngBufs.push(encoded)
  if (size === 256) await writeFile(path.join(ROOT, 'build', 'icon.png'), encoded)
  if ([16, 32, 64, 128, 256].includes(size)) icnsMap.set(size, encoded)
}
const ico = await pngToIco(pngBufs)
await writeFile(path.join(ROOT, 'build', 'icon.ico'), ico)
await writeIcns(icnsMap, path.join(ROOT, 'build', 'icon.icns'))
console.log('wrote build/icon.png (256), build/icon.ico (' + SIZES.join(',') + '), build/icon.icns')