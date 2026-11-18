<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type {
  FileState, OutputFormat, ProgressEvent, RunSummaryEvent, ScanItem, ScanResult
} from '../../shared/types'

type Step = 'pick' | 'review' | 'running' | 'done'

interface Row extends ScanItem {
  runState?: FileState
  beforeSize?: number
  afterSize?: number
  outPath?: string
  ms?: number
  error?: string
}

const step = ref<Step>('pick')
const dir = ref('')
const scanning = ref(false)
const scanError = ref('')
const force = ref(false)
const includeIgnored = ref(false)
const format = ref<OutputFormat>('original')
const rows = ref<Row[]>([])
const summary = ref<ScanResult['summary'] | null>(null)
const runSummary = ref<RunSummaryEvent | null>(null)
const dragOver = ref(false)
const showAll = ref(false)
const cancelling = ref(false)
let offProgress: (() => void) | null = null

const pendingRows = computed(() => rows.value.filter((r) => r.status === 'pending'))
const otherRows = computed(() => rows.value.filter((r) => r.status !== 'pending'))
const visibleRows = computed(() => (showAll.value ? rows.value : pendingRows.value))
const processedCount = computed(() =>
  rows.value.filter((r) => r.runState && r.runState !== 'queued' && r.runState !== 'running').length
)
const progressPct = computed(() =>
  pendingRows.value.length ? Math.round((processedCount.value / pendingRows.value.length) * 100) : 0
)
const savedBytes = computed(() =>
  rows.value.reduce((n, r) => n + (r.runState === 'done' ? (r.beforeSize ?? 0) - (r.afterSize ?? 0) : 0), 0)
)
const busy = computed(() => scanning.value || step.value === 'running')

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
  return `−${Math.round((1 - r.afterSize / r.beforeSize) * 100)}%`
}

async function doScan(target: string): Promise<void> {
  scanError.value = ''
  scanning.value = true
  try {
    const result = await window.slim.scan(target, { force: force.value, includeIgnored: includeIgnored.value })
    dir.value = result.summary.dir
    summary.value = result.summary
    rows.value = result.items.map((it) => ({ ...it }))
    runSummary.value = null
    showAll.value = false
    step.value = 'review'
  } catch (e) {
    scanError.value = e instanceof Error ? e.message : String(e)
    if (step.value === 'pick') dir.value = ''
  } finally {
    scanning.value = false
  }
}

async function pickFolder(): Promise<void> {
  const p = await window.slim.selectFolder()
  if (p) await doScan(p)
}

async function rescan(): Promise<void> {
  if (dir.value) await doScan(dir.value)
}

async function start(): Promise<void> {
  const paths = pendingRows.value.map((r) => r.path)
  if (!paths.length) return
  for (const r of rows.value) {
    if (r.status === 'pending') {
      r.runState = 'queued'
      r.error = undefined
    }
  }
  cancelling.value = false
  step.value = 'running'
  try {
    runSummary.value = await window.slim.startCompress(paths, format.value)
  } catch (e) {
    scanError.value = e instanceof Error ? e.message : String(e)
  } finally {
    step.value = 'done'
  }
}

function cancel(): void {
  cancelling.value = true
  void window.slim.cancel()
}

function openFolder(): void {
  void window.slim.openPath(dir.value)
}

async function clearHistory(): Promise<void> {
  if (!dir.value) return
  await window.slim.clearHistory(dir.value)
  await doScan(dir.value)
}

function onFileProgress(e: ProgressEvent): void {
  if (e.type !== 'file') return
  const row = rows.value.find((r) => r.path === e.path)
  if (!row) return
  row.runState = e.state
  row.beforeSize = e.beforeSize
  row.afterSize = e.afterSize
  row.outPath = e.outPath
  row.ms = e.ms
  row.error = e.error
}

function onDrop(ev: DragEvent): void {
  dragOver.value = false
  if (busy.value) return
  const file = ev.dataTransfer?.files?.[0]
  if (!file) return
  const p = window.slim.pathForFile(file)
  if (p) void doScan(p)
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
      <div class="dir num" :title="dir">{{ dir || '未选择文件夹' }}</div>
      <button data-test="pick" :disabled="busy" @click="pickFolder">选择文件夹</button>
      <button v-if="step !== 'pick'" data-test="rescan" :disabled="busy" @click="rescan">重新扫描</button>
    </header>

    <p v-if="scanError" class="error card" data-test="error">{{ scanError }}</p>

    <!-- 第一步：选择 -->
    <section v-if="step === 'pick'" class="drop card" :class="{ over: dragOver }" data-test="dropzone">
      <div class="drop-inner">
        <div class="drop-icon">🗂️</div>
        <h2>{{ scanning ? '正在扫描…' : '拖入文件夹，或点击选择' }}</h2>
        <p>递归扫描子目录中的 PNG / JPEG（含 APNG 动图），压缩后原地覆盖，已压缩过的自动跳过。</p>
        <button class="primary" data-test="pick-big" :disabled="scanning" @click="pickFolder">
          {{ scanning ? '扫描中…' : '选择文件夹' }}
        </button>
        <button v-if="dir" :disabled="scanning" data-test="scan-last" @click="rescan">扫描上次目录</button>
      </div>
    </section>

    <!-- 汇总卡片 -->
    <section v-if="summary && step !== 'pick'" class="stats">
      <div class="stat card">
        <b class="num" data-test="stat-pending">{{ summary.pending }}</b>
        <span>待压缩</span>
        <i class="num">{{ fmtBytes(summary.pendingBytes) }}</i>
      </div>
      <div class="stat card">
        <b class="num" data-test="stat-skipped">{{ summary.skipped }}</b>
        <span>已压缩跳过</span>
      </div>
      <div class="stat card">
        <b class="num" data-test="stat-unsupported">{{ summary.unsupported }}</b>
        <span>不支持</span>
      </div>
      <div class="stat card">
        <b class="num" data-test="stat-toolarge">{{ summary.tooLarge }}</b>
        <span>过大跳过</span>
      </div>
      <div v-if="step === 'done' || step === 'running'" class="stat card save">
        <b class="num green" data-test="stat-saved">{{ fmtBytes(savedBytes) }}</b>
        <span>已节省</span>
      </div>
    </section>

    <!-- 第二步：确认 -->
    <section v-if="step === 'review'" class="controls card">
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
      <div class="spacer"></div>
      <button data-test="clear-history" :disabled="scanning" @click="clearHistory">清除跳过记录</button>
      <button class="primary" data-test="start" :disabled="scanning || !summary || summary.pending === 0" @click="start">
        开始压缩（{{ summary?.pending ?? 0 }} 张）
      </button>
    </section>

    <p v-if="step === 'review' && format !== 'original'" class="note card">
      转换为 {{ format.toUpperCase() }} 会生成同名 .{{ format }} 文件并删除原图，项目中的引用路径需要相应改后缀。
    </p>

    <!-- 第三步：进度 -->
    <section v-if="step === 'running' || step === 'done'" class="runbar card">
      <template v-if="step === 'running'">
        <div class="progress"><div class="bar" :style="{ width: progressPct + '%' }"></div></div>
        <span class="num" data-test="progress-text">{{ processedCount }} / {{ pendingRows.length }}</span>
        <div class="spacer"></div>
        <button class="danger" data-test="cancel" :disabled="cancelling" @click="cancel">
          {{ cancelling ? '正在取消…' : '取消' }}
        </button>
      </template>
      <template v-else-if="runSummary">
        <span class="tag green">完成 {{ runSummary.done }}</span>
        <span class="tag green">已最优 {{ runSummary.optimal }}</span>
        <span v-if="runSummary.failed" class="tag red">失败 {{ runSummary.failed }}</span>
        <span v-if="runSummary.cancelled" class="tag gray">取消 {{ runSummary.cancelled }}</span>
        <span class="num muted">耗时 {{ fmtMs(runSummary.elapsedMs) }}</span>
        <div class="spacer"></div>
        <button data-test="open-folder" @click="openFolder">打开文件夹</button>
        <button class="primary" data-test="rescan-done" @click="rescan">重新扫描</button>
      </template>
    </section>

    <!-- 文件列表 -->
    <section v-if="step !== 'pick' && rows.length" class="list card">
      <div class="list-head">
        <span>文件（{{ visibleRows.length }}）</span>
        <label class="check small">
          <input v-model="showAll" type="checkbox" data-test="show-all" />
          显示跳过与不支持的文件
        </label>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-path">文件</th>
              <th>尺寸</th>
              <th class="r">原大小</th>
              <th class="r">压缩后</th>
              <th class="r">耗时</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in visibleRows" :key="r.path" :data-test="'row'" :data-path="r.rel">
              <td class="col-path num" :title="r.error || r.reason || r.path">
                {{ showAll && r.outPath && r.outPath !== r.path ? r.rel + ' → ' + r.outPath.split('\\').pop() : r.rel }}
                <div v-if="r.error" class="row-error">{{ r.error }}</div>
                <div v-else-if="r.reason && r.status !== 'skipped'" class="row-reason">{{ r.reason }}</div>
              </td>
              <td class="num muted">{{ r.width ? `${r.width}×${r.height}` : '—' }}<template v-if="r.frames > 1"> ×{{ r.frames }}帧</template></td>
              <td class="r num">{{ fmtBytes(r.beforeSize ?? r.size) }}</td>
              <td class="r num" :class="{ green: r.runState === 'done' }">{{ r.afterSize !== undefined ? fmtBytes(r.afterSize) : '—' }}</td>
              <td class="r num muted">{{ r.ms !== undefined ? fmtMs(r.ms) : '—' }}</td>
              <td><span class="tag" :class="stateTag(r).cls">{{ stateTag(r).text }}</span></td>
            </tr>
          </tbody>
        </table>
        <p v-if="!visibleRows.length" class="empty">没有待压缩的图片 🎉</p>
      </div>
    </section>

    <footer class="foot">
      引擎：slimdeer（MIT，WebAssembly，本地运行）· 压缩记录保存在本机，可随时清除
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

.controls { display: flex; align-items: center; gap: 18px; padding: 12px 16px; flex-wrap: wrap; }
.control { display: flex; align-items: center; gap: 8px; }
.control label { color: var(--muted); font-size: 13px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; padding: 6px 12px; font-size: 13px; }
.seg button.on { background: var(--accent); color: #fff; }
.check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text); cursor: pointer; }
.check.small { font-size: 12px; color: var(--muted); }
.spacer { flex: 1; }
.note { margin: 0; padding: 10px 16px; background: var(--amber-soft); border-color: #fde68a; color: var(--amber); font-size: 13px; }

.runbar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; }
.progress { flex: 1; height: 10px; border-radius: 5px; background: #edf0f5; overflow: hidden; }
.bar { height: 100%; background: var(--accent); border-radius: 5px; transition: width 0.3s; }
.muted { color: var(--muted); }

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
.empty { text-align: center; color: var(--muted); padding: 26px 0; }
.foot { text-align: center; color: var(--muted); font-size: 12px; margin-top: auto; }
.foot a { color: var(--muted); }
</style>