// utilityProcess entry: loads slimdeer's wasm and compresses one file per message.
// Messages in:  { id, bytes: Buffer, format: 'png'|'jpeg'|'webp'|'avif' }
// Messages out: { id, file: Buffer, report: string, ms } | { id, error }
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type Mod = {
  default: (arg: { module_or_path: Buffer }) => Promise<unknown>
  compress: (b: Uint8Array) => { png: Uint8Array; report: string; free(): void }
  compress_jpeg: (b: Uint8Array) => { jpeg: Uint8Array; report: string; free(): void }
  compress_webp: (b: Uint8Array) => { webp: Uint8Array; report: string; free(): void }
  compress_avif?: (b: Uint8Array) => { avif: Uint8Array; report: string; free(): void }
}

const vendorDir = process.env.SLIM_VENDOR_DIR!
let baseMod: Promise<Mod> | null = null
let avifMod: Promise<Mod> | null = null

function loadPkg(name: 'pkg' | 'pkg-avif'): Promise<Mod> {
  return (async () => {
    const dir = path.join(vendorDir, name)
    const mod: Mod = await import(pathToFileURL(path.join(dir, 'slimdeer_wasm.js')).href)
    await mod.default({ module_or_path: await readFile(path.join(dir, 'slimdeer_wasm_bg.wasm')) })
    return mod
  })()
}

const parentPort = process.parentPort
parentPort.on('message', async (e: { data: unknown }) => {
  const { id, bytes, format } = e.data as { id: number; bytes: Buffer; format: string }
  try {
    const input = new Uint8Array(bytes)
    const start = Date.now()
    let file: Uint8Array
    let report: string
    if (format === 'avif') {
      avifMod ??= loadPkg('pkg-avif')
      const mod = await avifMod
      const r = mod.compress_avif!(input)
      file = r.avif
      report = r.report
      r.free()
    } else {
      baseMod ??= loadPkg('pkg')
      const mod = await baseMod
      if (format === 'webp') {
        const r = mod.compress_webp(input)
        file = r.webp
        report = r.report
        r.free()
      } else if (format === 'jpeg') {
        const r = mod.compress_jpeg(input)
        file = r.jpeg
        report = r.report
        r.free()
      } else {
        const r = mod.compress(input)
        file = r.png
        report = r.report
        r.free()
      }
    }
    // Copy into a plain Buffer: MessagePort clones ArrayBuffers, not Node Buffer views.
    parentPort.postMessage({ id, file: Buffer.from(file), report, ms: Date.now() - start })
  } catch (err) {
    parentPort.postMessage({ id, error: String(err instanceof Error ? err.message : err) })
  }
})

parentPort.postMessage({ type: 'ready' })