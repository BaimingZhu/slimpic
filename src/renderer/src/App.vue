<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type {
  FileState, OutputFormat, ProgressEvent, RunSummaryEvent, ScanItem, ScanSummary
} from '../../shared/types'

type Step = 'pick' | 'review' | 'running' | 'done'
type Mode = 'folder' | 'files'

interface Row extends ScanItem {
  runState?: FileState
  beforeSize?: number
  afterSize?: number
  outPath?: string
  ms?: number
  error?: string
}

interface Task {
  step: Step
  rows: Row[]
  summary: ScanSummary | null
  baseDir: string
  error: string
  runSummary: RunSummaryEvent | null
}

const mode = ref<Mode>('files')
const dir = ref('')
const scanning = ref(false)
const dragOver = ref(false)
const showAll = ref(false)
const force = ref(false)
const includeIgnored = ref(false)
const format = ref<OutputFormat>('original')
const cancelling = ref(false)
const thumbs = reactive<Record<string, string>>({})
let offProgress: (() => void) | null = null

const blankTask = (): Task => ({ step: 'pick', rows: [], summary: null, baseDir: '', error: '', runSummary: null })
const folderTask = reactive<Task>(blankTask())
const fileTask = reactive<Task>(blankTask())

// The visible task: each mode keeps its own results when switching back and forth.
const task = computed(() => (mode.value === 'folder' ? folderTask : fileTask))
const busy = computed(() => scanning.value || task.value.step === 'running')

const pendingRows = computed(() => task.value.rows.filter((r) => r.status === 'pending'))
const shownRows = computed(() =>
  mode.value === 'files' ? task.value.rows : (showAll.value ? task.value.rows : pendingRows.value)
)
const processedCount = computed(() =>
  pendingRows.value.filter((r) => r.runState && r.runState !== 'queued' && r.runState !== 'running').length
)
const progressPct = computed(() =>
  pendingRows.value.length ? Math.round((processedCount.value / pendingRows.value.length) * 100) : 0
)
const savedBytes = computed(() =>
  task.value.rows.reduce((n, r) => n + (r.runState === 'done' ? (r.beforeSize ?? 0) - (r.afterSize ?? 0) : 0), 0)
)
const pendingBytes = computed(() => pendingRows.value.reduce((n, r) => n + r.size, 0))
const finishedRows = computed(() => task.value.rows.filter((r) => r.runState === 'done' || r.runState === 'optimal'))
const finishedBytes = computed(() => finishedRows.value.reduce((n, r) => n + (r.afterSize ?? 0), 0))
const unsupportedCount = computed(() => task.value.rows.filter((r) => r.status === 'unsupported').length)
const tooLargeCount = computed(() => task.value.rows.filter((r) => r.status === 'tooLarge').length)
const headerPath = computed(() => (mode.value === 'folder' ? dir.value : fileTask.baseDir))
const headerEmpty = computed(() => (mode.value === 'folder' ? '未选择文件夹' : '未选择图片'))

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}
function savedPct(r: Row): string {
  if (!r.beforeSize || r.afterSize === undefined) return ''
  const pct = Math.round((1 - r.afterSize / r.beforeSize) * 100)
  if (pct > 0) return `−${pct}%`
  if (pct < 0) return `+${-pct}%`
  return '±0%'
}
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function switchMode(m: Mode): void {
  if (busy.value || m === mode.value) return
  mode.value = m
  dragOver.value = false
}

// --- folder mode ---

async function doScan(target: string): Promise<void> {
  folderTask.error = ''
  scanning.value = true
  try {
    const result = await window.slim.scan(target, { force: force.value, includeIgnored: includeIgnored.value })
    dir.value = result.summary.dir
    folderTask.summary = result.summary
    folderTask.rows = result.items.map((it) => ({ ...it }))
    folderTask.runSummary = null
    showAll.value = false
    folderTask.step = 'review'
  } catch (e) {
    folderTask.error = msg(e)
    if (folderTask.step === 'pick') dir.value = ''
  } finally {
    scanning.value = false
  }
}

async function pickFolder(): Promise<void> {
  const p = await window.slim.selectFolder()
  if (p) await doScan(p)
}

async function rescan(): Promise<void> {
  if (mode.value === 'folder' && dir.value) await doScan(dir.value)
}

async function startFolder(): Promise<void> {
  const paths = pendingRows.value.map((r) => r.path)
  if (!paths.length) return
  for (const r of folderTask.rows) {
    if (r.status === 'pending') {
      r.runState = 'queued'
      r.error = undefined
    }
  }
  cancelling.value = false
  folderTask.error = ''
  folderTask.step = 'running'
  try {
    folderTask.runSummary = await window.slim.startCompress(paths, format.value)
    folderTask.step = 'done'
  } catch (e) {
    folderTask.error = msg(e)
    for (const r of folderTask.rows) if (r.runState === 'queued') r.runState = undefined
    folderTask.step = 'review'
  }
}

// --- image mode ---

async function pickImages(): Promise<void> {
  try {
    const paths = await window.slim.selectImages()
    if (paths?.length) await openPaths(paths)
  } catch (e) {
    fileTask.error = msg(e)
  }
}

// Accepts dropped paths: a folder switches to folder mode, files load into image mode.
async function openPaths(paths: string[]): Promise<void> {
  scanning.value = true
  fileTask.error = ''
  try {
    const res = await window.slim.openPaths(paths)
    if (res.type === 'folder') {
      mode.value = 'folder'
      await doScan(res.dir)
      return
    }
    mode.value = 'files'
    for (const k of Object.keys(thumbs)) delete thumbs[k]
    fileTask.rows = res.result.items.map((it) => ({ ...it }))
    fileTask.baseDir = res.result.baseDir
    fileTask.runSummary = null
    fileTask.step = 'review'
    void window.slim
      .thumbs(res.result.items.map((it) => it.path))
      .then((map) => Object.assign(thumbs, map))
      .catch(() => {})
  } catch (e) {
    fileTask.error = msg(e)
    fileTask.step = 'pick'
  } finally {
    scanning.value = false
  }
}

async function startFiles(): Promise<void> {
  const paths = pendingRows.value.map((r) => r.path)
  if (!paths.length) return
  for (const r of fileTask.rows) {
    if (r.status === 'pending') {
      r.runState = 'queued'
      r.error = undefined
    }
  }
  cancelling.value = false
  fileTask.error = ''
  fileTask.step = 'running'
  try {
    fileTask.runSummary = await window.slim.startCompress(paths, format.value)
    fileTask.step = 'done'
  } catch (e) {
    fileTask.error = msg(e)
    for (const r of fileTask.rows) if (r.runState === 'queued') r.runState = undefined
    fileTask.step = 'review'
  }
}

// --- shared ---

function cancel(): void {
  cancelling.value = true
  void window.slim.cancel()
}

function openFolder(): void {
  const p = mode.value === 'folder' ? dir.value : fileTask.baseDir
  if (p) void window.slim.openPath(p)
}

async function clearHistory(): Promise<void> {
  if (mode.value !== 'folder' || !dir.value) return
  await window.slim.clearHistory(dir.value)
  await doScan(dir.value)
}

function onFileProgress(e: ProgressEvent): void {
  if (e.type !== 'file') return
  // A run belongs to one task, but either list may hold the matching row.
  for (const t of [folderTask, fileTask]) {
    const row = t.rows.find((r) => r.path === e.path)
    if (!row) continue
    row.runState = e.state
    row.beforeSize = e.beforeSize
    row.afterSize = e.afterSize
    row.outPath = e.outPath
    row.ms = e.ms
    row.error = e.error
    return
  }
}

function onDrop(ev: DragEvent): void {
  dragOver.value = false
  if (busy.value) return
  const files = Array.from(ev.dataTransfer?.files ?? [])
  if (!files.length) return
  const paths = files.map((f) => window.slim.pathForFile(f)).filter(Boolean)
  if (paths.length) void openPaths(paths)
}

function stateTag(r: Row): { cls: string; text: string } {
  if (r.status === 'skipped') return { cls: 'gray', text: '已跳过' }
  if (r.status === 'unsupported') return { cls: 'gray', text: '不支持' }
  if (r.status === 'tooLarge') return { cls: 'amber', text: '过大' }
  switch (r.runState) {
    case 'running': return { cls: 'blue', text: '压缩中…' }
    case 'done': return { cls: 'green', text: `完成 ${savedPct(r)}` }
    case 'optimal': return { cls: 'green', text: '已最优' }
    case 'failed': return { cls: 'red', text: '失败' }
    case 'cancelled': return { cls: 'gray', text: '已取消' }
    case 'queued': return { cls: 'gray', text: '等待' }
    default: return { cls: 'blue', text: '待压缩' }
  }
}

onMounted(async () => {
  offProgress = window.slim.onProgress(onFileProgress)
  const s = await window.slim.getSettings()
  format.value = s.format
  includeIgnored.value = s.includeIgnored
  if (s.lastDir) dir.value = s.lastDir
})
onBeforeUnmount(() => offProgress?.())
</script>

<template>
  <div class="shell" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="onDrop">
    <header class="top card">
      <img class="logo" src="./assets/logo.png" alt="纤图 SlimPic" />
      <div class="title">
        <h1>纤图 SlimPic</h1>
        <span class="sub">图片批量压缩 · slimdeer 引擎 · 本地处理，不上传</span>
      </div>
      <div class="dir num" :title="headerPath">{{ headerPath || headerEmpty }}</div>
      <button v-if="mode === 'folder'" data-test="pick" :disabled="busy" @click="pickFolder">选择文件夹</button>
      <button v-else data-test="pick-images" :disabled="busy" @click="pickImages">选择图片</button>
      <button v-if="mode === 'folder' && task.step !== 'pick'" data-test="rescan" :disabled="busy" @click="rescan">重新扫描</button>
    </header>

    <nav class="modes card" data-test="modes">
      <button :class="{ on: mode === 'files' }" data-test="mode-files" :disabled="busy" @click="switchMode('files')">
        图片模式
      </button>
      <button :class="{ on: mode === 'folder' }" data-test="mode-folder" :disabled="busy" @click="switchMode('folder')">
        文件夹模式
      </button>
      <span class="modes-hint">
        {{ mode === 'files'
          ? '拖入或选择图片，原地压缩覆盖原图，文件名不变'
          : '选一个目录，递归原地压缩，已压缩过的自动跳过' }}
      </span>
    </nav>

    <p v-if="task.error" class="error card" data-test="error">{{ task.error }}</p>

    <!-- 第一步：选择 -->
    <section v-if="task.step === 'pick'" class="drop card" :class="{ over: dragOver }" data-test="dropzone">
      <div class="drop-inner">
        <div class="drop-icon">{{ mode === 'folder' ? '🗂️' : '🖼️' }}</div>
        <h2>
          {{ scanning
            ? (mode === 'folder' ? '正在扫描…' : '正在读取…')
            : (mode === 'folder' ? '拖入文件夹，或点击选择' : '拖入图片，或点击选择') }}
        </h2>
        <p v-if="mode === 'folder'">递归扫描子目录中的 PNG / JPEG（含 APNG 动图），压缩后原地覆盖，已压缩过的自动跳过。</p>
        <p v-else>支持 PNG / JPEG（含 APNG 动图），可一次拖入或选择多张；压缩结果原地覆盖原图，没有变小就保留原样。</p>
        <button class="primary" data-test="pick-big" :disabled="scanning" @click="mode === 'folder' ? pickFolder() : pickImages()">
          {{ scanning ? '处理中…' : mode === 'folder' ? '选择文件夹' : '选择图片' }}
        </button>
        <button v-if="mode === 'folder' && dir" :disabled="scanning" data-test="scan-last" @click="rescan">扫描上次目录</button>
      </div>
    </section>

    <!-- 汇总卡片：文件夹模式 -->
    <section v-if="mode === 'folder' && task.summary && task.step !== 'pick'" class="stats">
      <div class="stat card">
        <b class="num" data-test="stat-pending">{{ task.summary.pending }}</b>
        <span>待压缩</span>
        <i class="num">{{ fmtBytes(task.summary.pendingBytes) }}</i>
      </div>
      <div class="stat card">
        <b class="num" data-test="stat-skipped">{{ task.summary.skipped }}</b>
        <span>已压缩跳过</span>
      </div>
      <div class="stat card">
        <b class="num" data-test="stat-unsupported">{{ task.summary.unsupported }}</b>
        <span>不支持</span>
      </div>
      <div class="stat card">
        <b class="num" data-test="stat-toolarge">{{ task.summary.tooLarge }}</b>
        <span>过大跳过</span>
      </div>
      <div v-if="task.step === 'done' || task.step === 'running'" class="stat card save">
        <b class="num green" data-test="stat-saved">{{ fmtBytes(savedBytes) }}</b>
        <span>已节省</span>
      </div>
    </section>

    <!-- 汇总卡片：图片模式 -->
    <section v-if="mode === 'files' && task.step !== 'pick'" class="stats">
      <div class="stat card">
        <b class="num" data-test="file-pending">{{ task.step === 'done' ? finishedRows.length : pendingRows.length }}</b>
        <span>{{ task.step === 'done' ? '已压缩' : '待压缩' }}</span>
        <i class="num">{{ fmtBytes(task.step === 'done' ? finishedBytes : pendingBytes) }}</i>
      </div>
      <div class="stat card">
        <b class="num" data-test="file-unsupported">{{ unsupportedCount }}</b>
        <span>不支持</span>
      </div>
      <div class="stat card">
        <b class="num" data-test="file-toolarge">{{ tooLargeCount }}</b>
        <span>过大跳过</span>
      </div>
      <div class="stat card">
        <b class="num" data-test="file-total">{{ task.rows.length }}</b>
        <span>图片总数</span>
      </div>
      <div v-if="task.step === 'done' || task.step === 'running'" class="stat card save">
        <b class="num green" data-test="stat-saved-files">{{ fmtBytes(savedBytes) }}</b>
        <span>已节省</span>
      </div>
    </section>

    <!-- 第二步：确认（文件夹） -->
    <section v-if="mode === 'folder' && task.step === 'review'" class="controls card">
      <div class="control">
        <label>输出格式</label>
        <div class="seg" data-test="format">
          <button :class="{ on: format === 'original' }" data-test="fmt-original" @click="format = 'original'">保持原格式</button>
          <button :class="{ on: format === 'webp' }" data-test="fmt-webp" @click="format = 'webp'">转 WebP</button>
          <button :class="{ on: format === 'avif' }" data-test="fmt-avif" @click="format = 'avif'">转 AVIF（慢）</button>
        </div>
      </div>
      <label class="check">
        <input v-model="force" type="checkbox" data-test="force" @change="rescan" />
        忽略跳过记录，强制重新压缩
      </label>
      <label class="check">
        <input v-model="includeIgnored" type="checkbox" data-test="include-ignored" @change="rescan" />
        包含隐藏目录与 node_modules 等
      </label>
      <div class="action-row">
        <button data-test="clear-history" :disabled="scanning" @click="clearHistory">清除跳过记录</button>
        <div class="spacer"></div>
        <button class="primary" data-test="start" :disabled="scanning || !task.summary || task.summary.pending === 0" @click="startFolder">
          开始压缩（{{ task.summary?.pending ?? 0 }} 张）
        </button>
      </div>
    </section>

    <p v-if="mode === 'folder' && task.step === 'review' && format !== 'original'" class="note card">
      转换为 {{ format.toUpperCase() }} 会生成同名 .{{ format }} 文件并删除原图，项目中的引用路径需要相应改后缀。
    </p>

    <!-- 第二步：确认（图片） -->
    <section v-if="mode === 'files' && task.step === 'review'" class="controls file-controls card">
      <div class="control">
        <label>输出格式</label>
        <div class="seg">
          <button :class="{ on: format === 'original' }" data-test="fmt-original" @click="format = 'original'">保持原格式</button>
          <button :class="{ on: format === 'webp' }" data-test="fmt-webp" @click="format = 'webp'">转 WebP</button>
          <button :class="{ on: format === 'avif' }" data-test="fmt-avif" @click="format = 'avif'">转 AVIF（慢）</button>
        </div>
      </div>
      <div class="spacer"></div>
      <button class="primary" data-test="start-files" :disabled="!pendingRows.length" @click="startFiles">
        压缩 {{ pendingRows.length }} 张
      </button>
    </section>

    <p v-if="mode === 'files' && task.step === 'review'" class="note card">
      压缩结果原地覆盖原图，文件名不变；压缩后没有变小则保留原图。
      <template v-if="format !== 'original'">转换为 {{ format.toUpperCase() }} 会生成同名 .{{ format }} 文件并删除原图，项目中的引用路径需要相应改后缀。</template>
    </p>

    <!-- 第三步：进度 / 完成 -->
    <section v-if="task.step === 'running' || task.step === 'done'" class="runbar card">
      <template v-if="task.step === 'running'">
        <div class="progress"><div class="bar" :style="{ width: progressPct + '%' }"></div></div>
        <span class="num" data-test="progress-text">{{ processedCount }} / {{ pendingRows.length }}</span>
        <div class="spacer"></div>
        <button class="danger" data-test="cancel" :disabled="cancelling" @click="cancel">
          {{ cancelling ? '正在取消…' : '取消' }}
        </button>
      </template>
      <template v-else-if="task.runSummary">
        <span class="tag green">完成 {{ task.runSummary.done }}</span>
        <span class="tag green">已最优 {{ task.runSummary.optimal }}</span>
        <span v-if="task.runSummary.failed" class="tag red">失败 {{ task.runSummary.failed }}</span>
        <span v-if="task.runSummary.cancelled" class="tag gray">取消 {{ task.runSummary.cancelled }}</span>
        <span class="num muted">耗时 {{ fmtMs(task.runSummary.elapsedMs) }}</span>
        <div class="spacer"></div>
        <button data-test="open-folder" @click="openFolder">打开文件夹</button>
        <button v-if="mode === 'folder'" class="primary" data-test="rescan-done" @click="rescan">重新扫描</button>
        <button v-else class="primary" data-test="pick-more" @click="pickImages">再选一批</button>
      </template>
    </section>

    <!-- 文件列表 -->
    <section v-if="task.step !== 'pick' && task.rows.length" class="list card">
      <div class="list-head">
        <span>{{ mode === 'folder' ? '文件' : '图片' }}（{{ shownRows.length }}）</span>
        <label v-if="mode === 'folder'" class="check small">
          <input v-model="showAll" type="checkbox" data-test="show-all" />
          显示跳过与不支持的文件
        </label>
        <span v-else class="small muted">
          {{ task.step === 'done'
            ? '压缩结果已写回原图'
            : `${pendingRows.length} 张待压缩 · 结果原地覆盖原图` }}
        </span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-path">{{ mode === 'folder' ? '文件' : '图片' }}</th>
              <th>尺寸</th>
              <th class="r">原大小</th>
              <th class="r">压缩后</th>
              <th class="r">耗时</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shownRows" :key="r.path" :data-test="'row'" :data-path="r.rel">
              <td class="col-path num" :title="r.error || r.reason || r.path">
                <div v-if="mode === 'files'" class="file-cell">
                  <img v-if="thumbs[r.path]" class="thumb" :src="thumbs[r.path]" alt="" />
                  <span v-else class="thumb thumb-ph">IMG</span>
                  <div class="file-text">
                    {{ r.rel }}<template v-if="r.outPath && baseName(r.outPath) !== r.rel"> → {{ baseName(r.outPath) }}</template>
                    <div v-if="r.error" class="row-error">{{ r.error }}</div>
                    <div v-else-if="r.reason" class="row-reason">{{ r.reason }}</div>
                  </div>
                </div>
                <template v-else>
                  {{ showAll && r.outPath && r.outPath !== r.path ? r.rel + ' → ' + r.outPath.split('\\').pop() : r.rel }}
                  <div v-if="r.error" class="row-error">{{ r.error }}</div>
                  <div v-else-if="r.reason && r.status !== 'skipped'" class="row-reason">{{ r.reason }}</div>
                </template>
              </td>
              <td class="num muted">{{ r.width ? `${r.width}×${r.height}` : '—' }}<template v-if="r.frames > 1"> ×{{ r.frames }}帧</template></td>
              <td class="r num">{{ fmtBytes(r.beforeSize ?? r.size) }}</td>
              <td class="r num" :class="{ green: r.runState === 'done' }">{{ r.afterSize !== undefined ? fmtBytes(r.afterSize) : '—' }}</td>
              <td class="r num muted">{{ r.ms !== undefined ? fmtMs(r.ms) : '—' }}</td>
              <td><span class="tag" :class="stateTag(r).cls">{{ stateTag(r).text }}</span></td>
            </tr>
          </tbody>
        </table>
        <p v-if="!shownRows.length" class="empty">没有待压缩的图片 🎉</p>
      </div>
    </section>

    <footer class="foot">
      引擎：slimdeer（MIT，WebAssembly，本地运行）· 两种模式均原地覆盖原图 · 压缩记录保存在本机，可随时清除
    </footer>
  </div>
</template>

<style scoped>
.shell { max-width: 1060px; margin: 0 auto; padding: 18px 20px 30px; display: flex; flex-direction: column; gap: 14px; min-height: 100%; }
.top { display: flex; align-items: center; gap: 12px; padding: 12px 16px; }
.logo { width: 34px; height: 34px; border-radius: 8px; display: block; }
.title h1 { margin: 0; font-size: 17px; line-height: 1.2; }
.title .sub { font-size: 12px; color: var(--muted); }
.dir { flex: 1; text-align: right; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
.error { padding: 10px 16px; color: var(--red); background: var(--red-soft); border-color: #fecaca; margin: 0; }

.modes { display: flex; align-items: center; gap: 6px; padding: 6px; }
.modes button { border: 0; background: transparent; padding: 6px 14px; border-radius: 8px; color: var(--muted); font-weight: 600; font-size: 13px; }
.modes button:hover:not(:disabled) { background: #f5f7fa; }
.modes button.on { background: var(--accent-soft); color: var(--accent); }
.modes-hint { margin-left: 8px; font-size: 12px; color: var(--muted); }

.drop { padding: 60px 20px; text-align: center; border-style: dashed; border-width: 2px; }
.drop.over { border-color: var(--accent); background: var(--accent-soft); }
.drop-inner h2 { margin: 10px 0 6px; font-size: 20px; }
.drop-inner p { color: var(--muted); margin: 0 0 20px; }
.drop-inner button { margin: 0 5px; }
.drop-icon { font-size: 42px; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.stat { padding: 12px 16px; display: flex; flex-direction: column; }
.stat b { font-size: 24px; line-height: 1.2; }
.stat span { color: var(--muted); font-size: 12px; }
.stat i { font-style: normal; color: var(--muted); font-size: 12px; }
.stat .green { color: var(--green); }

.controls { display: flex; align-items: center; column-gap: 18px; row-gap: 10px; padding: 12px 16px; flex-wrap: wrap; }
.file-controls { gap: 12px; }
.control { display: flex; align-items: center; gap: 8px; }
.control label { color: var(--muted); font-size: 13px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; padding: 6px 12px; font-size: 13px; }
.seg button.on { background: var(--accent); color: #fff; }
.check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text); cursor: pointer; }
.check.small { font-size: 12px; color: var(--muted); }
.spacer { flex: 1; }
.note { margin: 0; padding: 10px 16px; background: var(--amber-soft); border-color: #fde68a; color: var(--amber); font-size: 13px; }

.action-row { flex-basis: 100%; display: flex; align-items: center; gap: 8px; padding-top: 10px; border-top: 1px dashed var(--line); }

.runbar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; }
.progress { flex: 1; height: 10px; border-radius: 5px; background: #edf0f5; overflow: hidden; }
.bar { height: 100%; background: var(--accent); border-radius: 5px; transition: width 0.3s; }
.muted { color: var(--muted); }
.small { font-size: 12px; }

.list { overflow: hidden; }
.list-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--line); font-weight: 600; }
.table-wrap { max-height: 46vh; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 7px 12px; text-align: left; border-bottom: 1px solid #f0f2f6; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--card); color: var(--muted); font-weight: 500; font-size: 12px; z-index: 1; }
th.r, td.r { text-align: right; }
.col-path { max-width: 380px; overflow: hidden; text-overflow: ellipsis; }
td.green { color: var(--green); font-weight: 600; }
.row-error { color: var(--red); font-size: 12px; white-space: normal; }
.row-reason { color: var(--muted); font-size: 12px; white-space: normal; }
.file-cell { display: flex; align-items: center; gap: 10px; }
.thumb { width: 34px; height: 34px; border-radius: 6px; object-fit: cover; background: #f1f3f7; flex: none; }
.thumb-ph { display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: var(--muted); border: 1px dashed var(--line); }
.file-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.empty { text-align: center; color: var(--muted); padding: 26px 0; }
.foot { text-align: center; color: var(--muted); font-size: 12px; margin-top: auto; }
.foot a { color: var(--muted); }
</style>
