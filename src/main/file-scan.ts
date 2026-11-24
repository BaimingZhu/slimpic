import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { FileInspectResult, ScanItem } from '../shared/types'
import { sizeLimitReason } from './image-info'
import { inspectImageFile } from './inspect'

// Review list for a batch of individually picked/dropped files (image mode).
// The skip history is not consulted here: picked files are always compressed,
// and results overwrite the source files in place.
export async function inspectFiles(paths: string[]): Promise<FileInspectResult> {
  const items: ScanItem[] = []
  const seen = new Set<string>()
  let baseDir = ''

  for (const raw of paths) {
    const full = path.resolve(raw)
    if (seen.has(full)) continue
    seen.add(full)
    let st
    try {
      st = await stat(full)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    if (!baseDir) baseDir = path.dirname(full)

    const ext = path.extname(full).toLowerCase()
    const info = await inspectImageFile(full, st.size, ext)
    if (!info) continue

    const item: ScanItem = {
      path: full,
      rel: path.basename(full),
      kind: info.kind === 'png' || info.kind === 'jpeg' ? info.kind : 'other',
      ext,
      size: st.size,
      width: info.width,
      height: info.height,
      frames: info.frames,
      status: 'pending'
    }
    if (info.kind !== 'png' && info.kind !== 'jpeg') {
      item.status = 'unsupported'
      item.reason = info.kind === 'unknown'
        ? '无法识别的图片内容'
        : `${info.kind.toUpperCase()} 暂不支持（slimdeer 仅接受 PNG/JPEG）`
    } else {
      const limit = sizeLimitReason(info, 'original', info.kind)
      if (limit) {
        item.status = 'tooLarge'
        item.reason = limit
      }
    }
    items.push(item)
  }

  if (!items.length) throw new Error('没有可读取的图片文件')
  items.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN'))
  return { baseDir, items }
}
