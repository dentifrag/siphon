import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { TransferProgress } from '../../shared/types'
import { pushSample, rollingSpeed, type SpeedSample } from './speed'
import type { RcloneClient } from './client'
import { multiThreadConfig, planMultiThread } from './chunk'

export interface RcloneEnqueueInput {
  srcFs: string
  srcRemote: string
  dstFs: string
  dstRemote: string
  displayName: string
  localPath: string
  size: number
  segments: number
  cleanupRemote?: string
  direction?: 'download' | 'upload'
  uploadRemoteDir?: string
}

interface InternalTransfer {
  progress: TransferProgress
  input: RcloneEnqueueInput
  group: string
  jobid: number | null
  canceled: boolean
  canceledAt: number | null
  cleaned: boolean
  removePending: boolean
  polling: boolean
  samples: SpeedSample[]
}

export const POLL_INTERVAL_MS = 400
export const DEFAULT_MAX_CONCURRENT = 3
export const MIN_MAX_CONCURRENT = 1
export const MAX_MAX_CONCURRENT = 8
export const CANCEL_SETTLE_TIMEOUT_MS = 4000

function clampMaxConcurrent(value: number): number {
  const n = Math.floor(value)
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT
  return Math.max(MIN_MAX_CONCURRENT, Math.min(MAX_MAX_CONCURRENT, n))
}

export class RcloneDownloadManager extends EventEmitter {
  private readonly transfers = new Map<string, InternalTransfer>()
  private readonly order: string[] = []
  private readonly activeIds = new Set<string>()
  private readonly remoteRefs = new Map<string, number>()
  private maxConcurrent = DEFAULT_MAX_CONCURRENT
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(private readonly client: RcloneClient) {
    super()
  }

  onUpdate(listener: (transfer: TransferProgress) => void): () => void {
    this.on('update', listener)
    return () => {
      this.off('update', listener)
    }
  }

  onRemove(listener: (id: string) => void): () => void {
    this.on('remove', listener)
    return () => {
      this.off('remove', listener)
    }
  }

  list(): TransferProgress[] {
    return this.order.map((id) => ({ ...this.transfers.get(id)!.progress }))
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent
  }

  setMaxConcurrent(max: number): number {
    this.maxConcurrent = clampMaxConcurrent(max)
    this.pump()
    return this.maxConcurrent
  }

  enqueue(input: RcloneEnqueueInput): TransferProgress {
    const id = randomUUID()
    const progress: TransferProgress = {
      id,
      remotePath: input.displayName,
      localPath: input.localPath,
      size: input.size,
      transferred: 0,
      speedBytesPerSec: 0,
      activeSegments: 0,
      segments: input.segments,
      status: 'queued',
      direction: input.direction ?? 'download',
      uploadRemoteDir: input.uploadRemoteDir
    }
    this.transfers.set(id, {
      progress,
      input,
      group: `job-${id}`,
      jobid: null,
      canceled: false,
      canceledAt: null,
      cleaned: false,
      removePending: false,
      polling: false,
      samples: []
    })
    this.order.push(id)
    if (input.cleanupRemote) {
      const name = input.cleanupRemote
      this.remoteRefs.set(name, (this.remoteRefs.get(name) ?? 0) + 1)
    }
    this.emitUpdate(id)
    this.pump()
    return { ...progress }
  }

  cancel(id: string): void {
    const t = this.transfers.get(id)
    if (!t) return
    if (t.progress.status === 'queued') {
      t.progress.status = 'canceled'
      this.finalize(t)
      this.emitUpdate(id)
    } else if (t.progress.status === 'downloading') {
      t.canceled = true
      t.canceledAt = Date.now()
      t.progress.canceling = true
      if (t.jobid !== null) void this.client.jobStop(t.jobid).catch(() => undefined)
      this.emitUpdate(id)
    }
  }

  cancelAll(): void {
    for (const id of [...this.order]) this.cancel(id)
  }

  remove(id: string): boolean {
    const t = this.transfers.get(id)
    if (!t || t.progress.status === 'downloading') return false
    this.finalize(t)
    this.deleteTransfer(id)
    this.emitRemove(id)
    return true
  }

  clearFinished(): void {
    for (const id of [...this.order]) {
      const status = this.transfers.get(id)?.progress.status
      if (status === 'completed' || status === 'canceled' || status === 'error') this.remove(id)
    }
  }

  clearAll(): void {
    for (const id of [...this.order]) {
      const t = this.transfers.get(id)
      if (!t) continue
      if (t.progress.status === 'downloading') {
        t.canceled = true
        t.canceledAt = Date.now()
        t.progress.canceling = true
        t.removePending = true
        if (t.jobid !== null) void this.client.jobStop(t.jobid).catch(() => undefined)
        this.emitUpdate(id)
        continue
      }
      if (t.progress.status === 'queued') t.progress.status = 'canceled'
      this.remove(id)
    }
  }

  private deleteTransfer(id: string): void {
    this.transfers.delete(id)
    const idx = this.order.indexOf(id)
    if (idx >= 0) this.order.splice(idx, 1)
  }

  private pump(): void {
    while (this.activeIds.size < this.maxConcurrent) {
      const nextId = this.order.find((id) => this.transfers.get(id)!.progress.status === 'queued')
      if (!nextId) break
      this.activeIds.add(nextId)
      void this.runJob(nextId).catch((err) => {
        const t = this.transfers.get(nextId)
        if (!t) {
          this.activeIds.delete(nextId)
          this.pump()
          return
        }
        t.progress.status = 'error'
        t.progress.error = err instanceof Error ? err.message : String(err)
        t.progress.activeSegments = 0
        this.settleTerminal(nextId, t)
      })
    }
    if (this.activeIds.size > 0) this.startTicker()
    else this.stopTicker()
  }

  private async runJob(id: string): Promise<void> {
    const t = this.transfers.get(id)
    if (!t) {
      this.activeIds.delete(id)
      this.pump()
      return
    }

    try {
      if (t.canceled) {
        t.progress.status = 'canceled'
        this.settleTerminal(id, t)
        return
      }

      t.progress.status = 'downloading'
      t.samples = [{ time: Date.now(), bytes: 0 }]
      const plan = planMultiThread(t.input.size, t.input.segments)
      t.progress.segments = plan.streams
      this.emitUpdate(id)

      await this.client.coreStatsDelete(t.group).catch(() => undefined)
      t.jobid = await this.client.copyFileAsync({
        srcFs: t.input.srcFs,
        srcRemote: t.input.srcRemote,
        dstFs: t.input.dstFs,
        dstRemote: t.input.dstRemote,
        group: t.group,
        config: multiThreadConfig(plan)
      })

      if (t.canceled) {
        void this.client.jobStop(t.jobid).catch(() => undefined)
        t.progress.status = 'canceled'
        t.progress.activeSegments = 0
        this.settleTerminal(id, t)
        await this.client.coreStatsDelete(t.group).catch(() => undefined)
        return
      }
      this.pump()
    } catch (err) {
      t.progress.status = 'error'
      t.progress.error = err instanceof Error ? err.message : String(err)
      t.progress.activeSegments = 0
      this.settleTerminal(id, t)
    }
  }

  private startTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => {
      for (const id of [...this.activeIds]) void this.poll(id)
    }, POLL_INTERVAL_MS)
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  private async poll(id: string): Promise<void> {
    const t = this.transfers.get(id)
    if (!t) return

    if (
      t.canceled &&
      t.canceledAt !== null &&
      Date.now() - t.canceledAt > CANCEL_SETTLE_TIMEOUT_MS
    ) {
      t.progress.status = 'canceled'
      t.progress.activeSegments = 0
      t.progress.speedBytesPerSec = 0
      if (t.jobid !== null) void this.client.jobStop(t.jobid).catch(() => undefined)
      this.settleTerminal(id, t)
      await this.client.coreStatsDelete(t.group).catch(() => undefined)
      return
    }

    if (t.polling || t.jobid === null) return
    t.polling = true

    try {
      const stats = await this.client.coreStats(t.group)
      const transferred = stats.bytes ?? t.progress.transferred
      t.progress.transferred = Math.min(transferred, t.progress.size || transferred)
      const inFlight = (stats.transferring?.length ?? 0) > 0
      t.progress.activeSegments = inFlight ? t.progress.segments : 0
      pushSample(t.samples, { time: Date.now(), bytes: t.progress.transferred })
      t.progress.speedBytesPerSec = rollingSpeed(t.samples)

      const job = await this.client.jobStatus(t.jobid)
      if (!this.activeIds.has(id)) return
      if (job.finished) {
        if (job.success) {
          t.progress.status = 'completed'
          t.progress.transferred = t.progress.size || t.progress.transferred
        } else if (t.canceled) {
          t.progress.status = 'canceled'
        } else {
          t.progress.status = 'error'
          t.progress.error = job.error || 'Download failed.'
        }
        t.progress.activeSegments = 0
        t.progress.speedBytesPerSec = 0
        this.settleTerminal(id, t)
        await this.client.coreStatsDelete(t.group).catch(() => undefined)
      } else {
        this.emitUpdate(id)
      }
    } catch {
    } finally {
      t.polling = false
    }
  }

  private settleTerminal(id: string, t: InternalTransfer): void {
    this.activeIds.delete(id)
    this.finalize(t)
    if (t.removePending) {
      this.deleteTransfer(id)
      this.emitRemove(id)
    } else {
      this.emitUpdate(id)
    }
    this.pump()
  }

  private finalize(t: InternalTransfer): void {
    const name = t.input.cleanupRemote
    if (name && !t.cleaned) {
      t.cleaned = true
      const remaining = (this.remoteRefs.get(name) ?? 1) - 1
      if (remaining <= 0) {
        this.remoteRefs.delete(name)
        void this.client.deleteRemote(name).catch(() => undefined)
      } else {
        this.remoteRefs.set(name, remaining)
      }
    }
  }

  private emitUpdate(id: string): void {
    const t = this.transfers.get(id)
    if (t) this.emit('update', { ...t.progress })
  }

  private emitRemove(id: string): void {
    this.emit('remove', id)
  }
}
