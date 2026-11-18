// Downloads slimdeer's official prebuilt WebAssembly packages into vendor/slimdeer.
// The Rust toolchain is not needed: these are the same binaries heydeer.ai serves.
import { mkdir, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST = path.join(ROOT, 'vendor', 'slimdeer')
const BASE = 'https://heydeer.ai/open-source/slimdeer'
const RAW = 'https://raw.githubusercontent.com/heydeer/slimdeer/main'

const FILES = [
  [`${BASE}/pkg/slimdeer_wasm.js`, 'pkg/slimdeer_wasm.js'],
  [`${BASE}/pkg/slimdeer_wasm_bg.wasm`, 'pkg/slimdeer_wasm_bg.wasm'],
  [`${BASE}/pkg-avif/slimdeer_wasm.js`, 'pkg-avif/slimdeer_wasm.js'],
  [`${BASE}/pkg-avif/slimdeer_wasm_bg.wasm`, 'pkg-avif/slimdeer_wasm_bg.wasm'],
  [`${RAW}/web/THIRD_PARTY_LICENSES.txt`, 'THIRD_PARTY_LICENSES.txt'],
  [`${RAW}/LICENSE`, 'LICENSE']
]

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

for (const [url, rel] of FILES) {
  const dest = path.join(DEST, rel)
  if (await exists(dest)) {
    console.log(`skip  ${rel}`)
    continue
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, buf)
  console.log(`saved ${rel} (${buf.length} bytes)`)
}

// Mark the glue dirs as ESM so Node loads them without reparse warnings.
for (const dir of ['pkg', 'pkg-avif']) {
  await writeFile(path.join(DEST, dir, 'package.json'), '{ "type": "module" }\n')
}
console.log('slimdeer vendor assets ready')