export type OutputFormat = 'original' | 'webp' | 'avif'

export interface ScanOptions {
  force: boolean
  includeIgnored: boolean
}

export type ItemKind = 'png' | 'jpeg'
export type ItemStatus = 'pending' | 'skipped' | 'unsupported' | 'tooLarge'

export interface ScanItem {
  path: string
  rel: string
  kind: ItemKind | 'other'
  ext: string
  size: number
  width: number
  height: number
  frames: number
  status: ItemStatus
  reason?: string
}

export interface ScanSummary {
  dir: string
  pending: number
  skipped: number
  unsupported: number
  tooLarge: number
  pendingBytes: number
  scannedFiles: number
}

export interface ScanResult {
  summary: ScanSummary
  items: ScanItem[]
}

export type FileState = 'queued' | 'running' | 'done' | 'optimal' | 'failed' | 'cancelled'

export interface ProgressEvent {
  type: 'file'
  path: string
  state: FileState
  beforeSize?: number
  afterSize?: number
  outPath?: string
  ms?: number
  error?: string
}

export interface RunSummaryEvent {
  type: 'summary'
  done: number
  optimal: number
  failed: number
  cancelled: number
  savedBytes: number
  elapsedMs: number
  finished: boolean
}

export interface Settings {
  lastDir: string
  format: OutputFormat
  includeIgnored: boolean
}

export interface SlimAPI {
  selectFolder(): Promise<string | null>
  scan(dir: string, opts: ScanOptions): Promise<ScanResult>
  startCompress(paths: string[], format: OutputFormat): Promise<RunSummaryEvent>
  cancel(): Promise<void>
  clearHistory(dir: string): Promise<number>
  openPath(p: string): Promise<void>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<void>
  onProgress(cb: (e: ProgressEvent) => void): () => void
}

export const IPC = {
  selectFolder: 'slim:select-folder',
  scan: 'slim:scan',
  start: 'slim:start',
  cancel: 'slim:cancel',
  clearHistory: 'slim:clear-history',
  openPath: 'slim:open-path',
  getSettings: 'slim:get-settings',
  setSettings: 'slim:set-settings',
  progress: 'slim:progress'
} as const