// Builds a fixture image tree used by selftest and e2e.
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'

function gradientPng(w, h, seed = 0) {
  const png = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      png.data[i] = ((x + seed * 37) * 255 / w) | 0
      png.data[i + 1] = (y * 255 / h) | 0
      png.data[i + 2] = ((x + y + seed * 11) * 255 / (w + h)) | 0
      png.data[i + 3] = 255
    }
  }
  return png
}

export async function makeFixtures(root) {
  await rm(root, { recursive: true, force: true })
  await mkdir(path.join(root, 'sub', 'deep'), { recursive: true })
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(path.join(root, '.hidden'), { recursive: true })

  const files = {}

  // Compressible PNGs at three depths.
  for (const [rel, seed] of [['a.png', 1], ['sub/b.png', 2], ['sub/deep/c.png', 3]]) {
    const png = gradientPng(320, 240, seed)
    const buf = PNG.sync.write(png)
    await writeFile(path.join(root, rel), buf)
    files[rel] = buf.length
  }

  // JPEG photo-ish gradient.
  const pj = gradientPng(320, 240, 4)
  const jpg = jpeg.encode({ data: Buffer.from(pj.data), width: 320, height: 240 }, 95).data
  await writeFile(path.join(root, 'photo.jpg'), jpg)
  files['photo.jpg'] = jpg.length

  // Tiny 1x1 PNG: already optimal, must not be replaced.
  const tiny = new PNG({ width: 1, height: 1 })
  tiny.data.set([255, 0, 0, 255])
  const tinyBuf = PNG.sync.write(tiny)
  await writeFile(path.join(root, 'tiny.png'), tinyBuf)
  files['tiny.png'] = tinyBuf.length

  // Unsupported formats.
  await writeFile(path.join(root, 'anim.gif'), Buffer.from('GIF89a' + '\0'.repeat(40)))
  await writeFile(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')
  await writeFile(path.join(root, 'pic.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]))

  // Oversized PNG: hand-built signature + IHDR claiming 7000x6000 = 42 MP > 40 MP limit.
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(7000, 8)
  ihdr.writeUInt32BE(6000, 12)
  ihdr[16] = 8; ihdr[17] = 6 // 8-bit RGBA
  const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(16)])
  await writeFile(path.join(root, 'huge.png'), huge)

  // Corrupt .png that is really text.
  await writeFile(path.join(root, 'broken.png'), 'this is not a png at all')

  // Ignored dirs.
  const nm = PNG.sync.write(gradientPng(64, 64, 5))
  await writeFile(path.join(root, 'node_modules', 'pkg', 'x.png'), nm)
  await writeFile(path.join(root, '.hidden', 'h.png'), nm)

  // Conversion conflict: d.png plus an existing d.webp.
  const pd = PNG.sync.write(gradientPng(200, 150, 6))
  await writeFile(path.join(root, 'd.png'), pd)
  await writeFile(path.join(root, 'd.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]))
  files['d.png'] = pd.length

  return files
}

if (process.argv[1] && process.argv[1].endsWith('make-fixtures.mjs')) {
  const root = process.argv[2]
  if (!root) throw new Error('usage: node make-fixtures.mjs <dir>')
  const files = await makeFixtures(root)
  console.log('fixtures at', root)
  console.log(files)
}