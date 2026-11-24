import { utilityProcess, UtilityProcess } from 'electron'
import { readFile, writeFile, rename, stat, unlink, access } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { OutputFormat, ProgressEvent, RunSummaryEvent } from '../shared/types'
import { imageDims, sizeLimitReason, sniff } from './image-info'
import type { Store } from './store'

interface WorkerSlot {
  proc: UtilityProcess
  ready: Promise<void>
  busy: boolean
  current: Job | null
  dead: boolean
}

interface Job {
  id: number
  filePath: string
  format: 'png' | 'jpeg' | 'webp' | 'avif'
  resolve: (r: { file: Buffer; report: string; ms: number } | { error: string }) => void
}

export interface RunDeps {
  workerPath: string
  vendorDir: string
  store: Store
  emit: (e: ProgressEvent) => void
}

export class CompressRunner {
  private slots: WorkerSlot[] = []
  private queue: string[] = []
  private cancelled = false
  private running = false
  private nextId = 1
  private stats = { done: 0, optimal: 0, failed: 0, cancelled: 0, savedBytes: 0 }
  private startedAt = 0
  private finish: ((s: RunSummaryEvent) => void) | null = null
  private active = 0

  constructor(
    private deps: RunDeps,
    private format: OutputFormat
  ) {}

  isRunning(): boolean {
    return this.running
  }

  cancel(): void {
    this.cancelled = true
  }

  async run(paths: string[]): Promise<RunSummaryEvent> {
    if (this.running) throw new Error('已有压缩任务在进行')
    this.running = true
    this.startedAt = Date.now()
    this.queue = [...paths]
    const n = Math.max(1, Math.min(4, os.cpus().length - 1, paths.length))
    for (let i = 0; i < n; i++) this.slots.push(this.spawn())
    try {
      return await new Promise<RunSummaryEvent>((resolve) => {
        this.finish = resolve
        for (const slot of this.slots) void this.pump(slot)
        if (paths.length === 0) this.maybeFinish()
      })
    } finally {
      this.running = false
      for (const slot of this.slots) {
        if (!slot.dead) slot.proc.kill()
      }
      await this.deps.store.flush()
    }
  }

  private spawn(): WorkerSlot {
    const proc = utilityProcess.fork(this.deps.workerPath, [], {
      env: { ...process.env, SLIM_VENDOR_DIR: this.deps.vendorDir },
      stdio: 'pipe',
      serviceName: 'slimdeer-compress'
    })
    const slot: WorkerSlot = { proc, ready: null!, busy: false, current: null, dead: false }
    let markReady: () => void
    slot.ready = new Promise((resolve) => { markReady = resolve })
    // One message router per process: ready signal and job replies.
    proc.on('message', (m: { type?: string; id?: number; file?: Buffer; report?: string; ms?: number; error?: string }) => {
      if (m?.type === 'ready') {
        markReady()
        return
      }
      const job = slot.current
      if (!job || m?.id !== job.id) return
      slot.current = null
      if (m.error !== undefined) job.resolve({ error: m.error })
      else job.resolve({ file: Buffer.from(m.file!), report: m.report!, ms: m.ms! })
    })
    proc.stdout?.on('data', (d: Buffer) => console.log('[slimdeer]', d.toString().trim()))
    proc.stderr?.on('data', (d: Buffer) => console.error('[slimdeer]', d.toString().trim()))
    proc.on('exit', (code) => {
      slot.dead = true
      markReady() // unblock anyone awaiting a worker that will never come up
      const job = slot.current
      slot.current = null
      if (job) job.resolve({ error: `压缩进程异常退出（code ${code}）` })
      if (!slot.busy) {
        // Idle worker died: replace it while work remains, else it may let us finish.
        if (!this.cancelled && this.queue.length > 0 && this.running) {
          const fresh = this.spawn()
          this.slots[this.slots.indexOf(slot)] = fresh
          void this.pump(fresh)
        } else {
          this.maybeFinish()
        }
      }
      // A busy worker's pump loop settles the job and re-pumps or finishes.
    })
    return slot
  }

  private async pump(slot: WorkerSlot): Promise<void> {
    if (slot.dead || slot.busy) return
    await slot.ready
    if (slot.dead) return
    if (this.cancelled) {
      const p = this.queue.shift()
      if (p === undefined) {
        this.maybeFinish()
        return
      }
      this.stats.cancelled++
      this.deps.emit({ type: 'file', path: p, state: 'cancelled' })
      void this.pump(slot)
      return
    }
    const filePath = this.queue.shift()
    if (filePath === undefined) {
      this.maybeFinish()
      return
    }
    slot.busy = true
    this.active++
    this.deps.emit({ type: 'file', path: filePath, state: 'running' })

    const outcome = await this.processOne(slot, filePath)
    slot.busy = false
    slot.current = null
    this.active--
    this.settle(filePath, outcome)
    if (!slot.dead) {
      void this.pump(slot)
    } else if (!this.cancelled && this.queue.length > 0 && this.running) {
      const fresh = this.spawn()
      const idx = this.slots.indexOf(slot)
      if (idx >= 0) this.slots[idx] = fresh
      else this.slots.push(fresh)
      void this.pump(fresh)
    }
    this.maybeFinish()
  }

  private async processOne(
    slot: WorkerSlot,
    filePath: string
  ): Promise<{ ok: true; before: number; after: number; outPath: string; ms: number; optimal: boolean } | { error: string }> {
    let input: Buffer
    let st
    try {
      st = await stat(filePath)
      input = await readFile(filePath)
    } catch (e) {
      return { error: `读取失败：${msg(e)}` }
    }
    const kind = sniff(input)
    if (kind !== 'png' && kind !== 'jpeg') return { error: '文件内容已变化，不再是 PNG/JPEG' }
    if (this.cancelled) return { error: '__cancelled__' }

    const dims = imageDims(input, kind)
    const limit = sizeLimitReason(dims, this.format, kind)
    if (limit) return { error: limit }

    const outFormat = this.format === 'original' ? kind : this.format
    const job: Job = {
      id: this.nextId++,
      filePath,
      format: outFormat,
      resolve: null!
    }
    const result = await new Promise<{ file: Buffer; report: string; ms: number } | { error: string }>((resolve) => {
      job.resolve = resolve
      slot.current = job
      slot.proc.postMessage({ id: job.id, bytes: input, format: outFormat })
    })
    if ('error' in result) return { error: result.error }
    if (this.cancelled) return { error: '__cancelled__' }

    const before = input.length
    const after = result.file.length

    const converting = outFormat !== kind
    const outPath = converting
      ? path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + '.' + outFormat)
      : filePath

    try {
      if (converting) {
        // Never overwrite a different existing file silently.
        try {
          await access(outPath)
          return { error: `目标已存在：${path.basename(outPath)}，未覆盖` }
        } catch { /* does not exist: good */ }
        if (after >= before) {
          // Even a conversion that does not shrink is recorded as done at original format.
          this.deps.store.record(filePath, input, st.mtimeMs, 'original')
          return { ok: true, before, after: before, outPath: filePath, ms: result.ms, optimal: true }
        }
        await writeFile(outPath, result.file)
        const outStat = await stat(outPath)
        await unlink(filePath)
        this.deps.store.clearFile(filePath)
        this.deps.store.record(outPath, result.file, outStat.mtimeMs, outFormat)
        return { ok: true, before, after, outPath, ms: result.ms, optimal: false }
      }

      if (after >= before) {
        this.deps.store.record(filePath, input, st.mtimeMs, outFormat)
        return { ok: true, before, after: before, outPath: filePath, ms: result.ms, optimal: true }
      }
      const tmp = outPath + '.slimtmp-' + randomBytes(4).toString('hex')
      await writeFile(tmp, result.file)
      try {
        await rename(tmp, outPath)
      } catch (e) {
        await unlink(tmp).catch(() => {})
        return { error: `替换原文件失败：${msg(e)}` }
      }
      const outStat = await stat(outPath)
      this.deps.store.record(outPath, result.file, outStat.mtimeMs, outFormat)
      return { ok: true, before, after, outPath, ms: result.ms, optimal: false }
    } catch (e) {
      return { error: `写入失败：${msg(e)}` }
    }
  }

  private settle(
    filePath: string,
    outcome: { ok: true; before: number; after: number; outPath: string; ms: number; optimal: boolean } | { error: string }
  ): void {
    if ('error' in outcome) {
      if (outcome.error === '__cancelled__') {
        this.stats.cancelled++
        this.deps.emit({ type: 'file', path: filePath, state: 'cancelled' })
      } else {
        this.stats.failed++
        this.deps.emit({ type: 'file', path: filePath, state: 'failed', error: outcome.error })
      }
      return
    }
    if (outcome.optimal) {
      this.stats.optimal++
      this.deps.emit({
        type: 'file', path: filePath, state: 'optimal',
        beforeSize: outcome.before, afterSize: outcome.after, outPath: outcome.outPath, ms: outcome.ms
      })
    } else {
      this.stats.done++
      this.stats.savedBytes += outcome.before - outcome.after
      this.deps.emit({
        type: 'file', path: filePath, state: 'done',
        beforeSize: outcome.before, afterSize: outcome.after, outPath: outcome.outPath, ms: outcome.ms
      })
    }
  }

  private maybeFinish(): void {
    if (!this.running || !this.finish) return
    if (this.queue.length > 0 || this.active > 0) return
    const summary: RunSummaryEvent = {
      type: 'summary',
      ...this.stats,
      elapsedMs: Date.now() - this.startedAt,
      finished: !this.cancelled
    }
    const f = this.finish
    this.finish = null
    f(summary)
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}