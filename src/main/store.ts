import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Settings } from '../shared/types'

export interface HistoryEntry {
  hash: string
  size: number
  mtimeMs: number
  format: string
  ts: number
}

const ENGINE = 'slimdeer-wasm-2026-11'

export function fileHash(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex')
}

export function normPath(p: string): string {
  return path.resolve(p).toLowerCase()
}

export class Store {
  private history = new Map<string, HistoryEntry>()
  private settings: Settings = { lastDir: '', lastImageDir: '', format: 'original', includeIgnored: false }
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private dir: string) {}

  private get historyFile(): string {
    return path.join(this.dir, 'compressed.json')
  }

  private get settingsFile(): string {
    return path.join(this.dir, 'settings.json')
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    try {
      const raw = JSON.parse(await readFile(this.historyFile, 'utf8'))
      if (raw.engine === ENGINE && raw.entries) {
        this.history = new Map(Object.entries(raw.entries))
      }
    } catch { /* first run or unreadable: start empty */ }
    try {
      Object.assign(this.settings, JSON.parse(await readFile(this.settingsFile, 'utf8')))
    } catch { /* keep defaults */ }
  }

  getSettings(): Settings {
    return { ...this.settings }
  }

  async setSettings(patch: Partial<Settings>): Promise<void> {
    Object.assign(this.settings, patch)
    await writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2))
  }

  entry(p: string): HistoryEntry | undefined {
    return this.history.get(normPath(p))
  }

  // Whether this exact file content was already processed by us.
  alreadyDone(p: string, size: number, mtimeMs: number, buf?: Buffer): boolean {
    const e = this.entry(p)
    if (!e) return false
    if (e.size === size && Math.abs(e.mtimeMs - mtimeMs) < 2) return true
    if (buf && e.size === size && e.hash === fileHash(buf)) return true
    return false
  }

  record(p: string, buf: Buffer, mtimeMs: number, format: string): void {
    this.history.set(normPath(p), {
      hash: fileHash(buf),
      size: buf.length,
      mtimeMs,
      format,
      ts: Date.now()
    })
    this.scheduleSave()
  }

  clearFile(p: string): void {
    if (this.history.delete(normPath(p))) this.scheduleSave()
  }

  // Remove records for a directory subtree; returns how many were dropped.
  clearUnder(dir: string): number {
    const prefix = normPath(dir) + path.sep
    let n = 0
    for (const key of [...this.history.keys()]) {
      if (key === normPath(dir) || key.startsWith(prefix)) {
        this.history.delete(key)
        n++
      }
    }
    if (n) this.scheduleSave()
    return n
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, 400)
  }

  async flush(): Promise<void> {
    const payload = JSON.stringify({ engine: ENGINE, entries: Object.fromEntries(this.history) })
    const tmp = this.historyFile + '.tmp'
    await writeFile(tmp, payload)
    await rename(tmp, this.historyFile)
  }
}