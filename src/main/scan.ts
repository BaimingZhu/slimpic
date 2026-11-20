import { readdir, stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ScanItem, ScanOptions, ScanResult, ScanSummary } from '../shared/types'
import { sizeLimitReason } from './image-info'
import { inspectImageFile } from './inspect'
import type { Store } from './store'

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg'])
const IMAGE_EXTS = new Set(['.png', '.apng', '.jpg', '.jpeg', '.jpe', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg', '.tif', '.tiff'])
const HEAD_BYTES = 64 * 1024

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
      const info = await inspectImageFile(full, st.size, ext)
      if (!info) continue
      const kind = info.kind

      const rel = path.relative(root, full)
      const base: ScanItem = {
        path: full, rel, kind: kind === 'png' || kind === 'jpeg' ? kind : 'other',
        ext, size: st.size, width: info.width, height: info.height, frames: info.frames, status: 'pending'
      }

      if (kind !== 'png' && kind !== 'jpeg') {
        base.status = 'unsupported'
        base.reason = kind === 'unknown' ? '无法识别的图片内容' : `${kind.toUpperCase()} 暂不支持（slimdeer 仅接受 PNG/JPEG）`
        items.push(base)
        continue
      }

      const limit = sizeLimitReason(info, 'original', kind)
      if (limit) {
        base.status = 'tooLarge'
        base.reason = limit
        items.push(base)
        continue
      }

      let content: Buffer | undefined = st.size <= HEAD_BYTES ? info.head : undefined
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
