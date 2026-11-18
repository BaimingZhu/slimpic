// Proves slimdeer's browser wasm runs under plain Node: compress a generated PNG and JPEG.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(ROOT, 'vendor', 'slimdeer', 'pkg')
const mod = await import(pathToFileURL(path.join(pkgDir, 'slimdeer_wasm.js')).href)
await mod.default({ module_or_path: await readFile(path.join(pkgDir, 'slimdeer_wasm_bg.wasm')) })

// A noisy gradient PNG: quantizable, so slimdeer should shrink it a lot.
const W = 512, H = 512
const png = new PNG({ width: W, height: H })
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    png.data[i] = (x * 255 / W) | 0
    png.data[i + 1] = (y * 255 / H) | 0
    png.data[i + 2] = ((x + y) * 255 / (W + H)) | 0
    png.data[i + 3] = 255
  }
}
const pngBytes = PNG.sync.write(png)
const raw = { data: Buffer.from(png.data), width: W, height: H }
const jpgBytes = jpeg.encode(raw, 92).data

console.log('input png', pngBytes.length, 'jpeg', jpgBytes.length)

// The result getters consume the Rust object; read once, then free().
let t = Date.now()
const r1 = mod.compress(new Uint8Array(pngBytes))
const outPng = r1.png, rep1 = r1.report
r1.free()
console.log('png ->', outPng.length, `(${Date.now() - t} ms)`, rep1)

t = Date.now()
const r2 = mod.compress_jpeg(new Uint8Array(jpgBytes))
const outJpg = r2.jpeg, rep2 = r2.report
r2.free()
console.log('jpeg ->', outJpg.length, `(${Date.now() - t} ms)`, rep2)

t = Date.now()
const r3 = mod.compress_webp(new Uint8Array(pngBytes))
const outWebp = r3.webp, rep3 = r3.report
r3.free()
console.log('webp ->', outWebp.length, `(${Date.now() - t} ms)`, rep3)

if (outPng.length >= pngBytes.length || outJpg.length >= jpgBytes.length) {
  throw new Error('compression did not shrink the inputs')
}
console.log('SMOKE OK')