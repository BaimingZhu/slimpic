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
  lastImageDir: string
  format: OutputFormat
  includeIgnored: boolean
}

// A batch of individually picked or dropped image files (image mode).
export interface FileInspectResult {
  // Directory the files came from, and where compressed copies go by default.
  baseDir: string
  outDir: string
  items: ScanItem[]
}

// Dropped paths may be a folder (folder mode) or image files (image mode).
export type OpenPathsResult =
  | { type: 'folder'; dir: string }
  | { type: 'files'; result: FileInspectResult }

export interface SlimAPI {
  selectFolder(): Promise<string | null>
  selectImages(): Promise<string[] | null>
  selectOutputDir(current: string): Promise<string | null>
  openPaths(paths: string[]): Promise<OpenPathsResult>
  scan(dir: string, opts: ScanOptions): Promise<ScanResult>
  startCompress(paths: string[], format: OutputFormat): Promise<RunSummaryEvent>
  compressFiles(paths: string[], format: OutputFormat, outDir: string): Promise<RunSummaryEvent>
  thumbs(paths: string[]): Promise<Record<string, string>>
  cancel(): Promise<void>
  clearHistory(dir: string): Promise<number>
  openPath(p: string): Promise<void>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<void>
  onProgress(cb: (e: ProgressEvent) => void): () => void
}

export const IPC = {
  selectFolder: 'slim:select-folder',
  selectImages: 'slim:select-images',
  selectOutputDir: 'slim:select-output-dir',
  openPaths: 'slim:open-paths',
  scan: 'slim:scan',
  start: 'slim:start',
  compressFiles: 'slim:compress-files',
  thumbs: 'slim:thumbs',
  cancel: 'slim:cancel',
  clearHistory: 'slim:clear-history',
  openPath: 'slim:open-path',
  getSettings: 'slim:get-settings',
  setSettings: 'slim:set-settings',
  progress: 'slim:progress'
} as const