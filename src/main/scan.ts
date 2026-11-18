import { readdir, stat, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ScanItem, ScanOptions, ScanResult, ScanSummary } from '../shared/types'
import { sniff, imageDims, sizeLimitReason } from './image-info'
import type { Store } from './store'

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg'])
const IMAGE_EXTS = new Set(['.png', '.apng', '.jpg', '.jpeg', '.jpe', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg', '.tif', '.tiff'])
const HEAD_BYTES = 64 * 1024

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

export async function scanDir(dir: string, opts: ScanOptions, store: Store): Promise<ScanResult> {
  const root = path.resolve(dir)
  const items: ScanItem[] = []
  let scannedFiles = 0

  async function walk(d: string): Promise<void> {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return // unreadable directory: skip
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) {
        if (!opts.includeIgnored && (IGNORED_DIRS.has(ent.name) || ent.name.startsWith('.'))) continue
        await walk(full)
        continue
      }
      if (!ent.isFile()) continue
      scannedFiles++
      const ext = path.extname(ent.name).toLowerCase()
      if (!IMAGE_EXTS.has(ext)) continue

      let st
      try {
        st = await stat(full)
      } catch {
        continue
      }
      let head: Buffer
      try {
        head = await readHead(full, st.size)
      } catch {
        continue
      }
      let kind = sniff(head)
      if (kind === 'unknown' && (ext === '.jpg' || ext === '.jpeg' || ext === '.jpe') && st.size > HEAD_BYTES) {
        // A camera JPEG's EXIF can push the SOF marker past the head window.
        try {
          kind = sniff(await readFile(full))
        } catch { /* keep unknown */ }
      }
      const rel = path.relative(root, full)
      const base: ScanItem = {
        path: full, rel, kind: kind === 'png' || kind === 'jpeg' ? kind : 'other',
        ext, size: st.size, width: 0, height: 0, frames: 1, status: 'pending'
      }

      if (kind !== 'png' && kind !== 'jpeg') {
        base.status = 'unsupported'
        base.reason = kind === 'unknown' ? '无法识别的图片内容' : `${kind.toUpperCase()} 暂不支持（slimdeer 仅接受 PNG/JPEG）`
        items.push(base)
        continue
      }

      let dims = imageDims(head, kind)
      if (kind === 'jpeg' && dims.width === 0 && st.size > HEAD_BYTES) {
        try {
          dims = imageDims(await readFile(full), kind)
        } catch { /* keep zeros; encoder will judge */ }
      }
      Object.assign(base, dims)

      const limit = sizeLimitReason(dims, 'original', kind)
      if (limit) {
        base.status = 'tooLarge'
        base.reason = limit
        items.push(base)
        continue
      }

      let content: Buffer | undefined = st.size <= HEAD_BYTES ? head : undefined
      if (!opts.force && !content && store.entry(full)?.size === st.size) {
        // mtime moved but size matches the record: hash the full content before deciding
        try {
          content = await readFile(full)
        } catch { /* unreadable: fall through to pending */ }
      }
      if (!opts.force && store.alreadyDone(full, st.size, st.mtimeMs, content)) {
        base.status = 'skipped'
        base.reason = '已压缩过'
        items.push(base)
        continue
      }
      items.push(base)
    }
  }

  await walk(root)
  items.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN'))

  const summary: ScanSummary = {
    dir: root,
    pending: 0, skipped: 0, unsupported: 0, tooLarge: 0, pendingBytes: 0, scannedFiles
  }
  for (const it of items) {
    if (it.status === 'pending') {
      summary.pending++
      summary.pendingBytes += it.size
    } else if (it.status === 'skipped') summary.skipped++
    else if (it.status === 'unsupported') summary.unsupported++
    else summary.tooLarge++
  }
  return { summary, items }
}