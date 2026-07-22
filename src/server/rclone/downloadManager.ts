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
}

interface InternalTransfer {
  progress: TransferProgress
  input: RcloneEnqueueInput
  group: string
  jobid: number | null
  canceled: boolean
  cleaned: boolean
  samples: SpeedSample[]
}

const POLL_INTERVAL_MS = 400

export class RcloneDownloadManager extends EventEmitter {
  private readonly transfers = new Map<string, InternalTransfer>()
  private readonly order: string[] = []
  private activeId: string | null = null
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

  list(): TransferProgress[] {
    return this.order.map((id) => ({ ...this.transfers.get(id)!.progress }))
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
      status: 'queued'
    }
    this.transfers.set(id, {
      progress,
      input,
      group: `job-${id}`,
      jobid: null,
      canceled: false,
      cleaned: false,
      samples: []
    })
    this.order.push(id)
    this.emitUpdate(id)
    void this.pump()
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
      if (t.jobid !== null) void this.client.jobStop(t.jobid).catch(() => undefined)
    }
  }

  cancelAll(): void {
    for (const id of [...this.order]) this.cancel(id)
  }

  remove(id: string): void {
    const t = this.transfers.get(id)
    if (!t || t.progress.status === 'downloading') return
    this.transfers.delete(id)
    const idx = this.order.indexOf(id)
    if (idx >= 0) this.order.splice(idx, 1)
  }

  clearFinished(): void {
    for (const id of [...this.order]) {
      const status = this.transfers.get(id)?.progress.status
      if (status === 'completed' || status === 'canceled' || status === 'error') this.remove(id)
    }
  }

  private async pump(): Promise<void> {
    if (this.activeId) return
    const nextId = this.order.find((id) => this.transfers.get(id)!.progress.status === 'queued')
    if (!nextId) {
      this.stopTicker()
      return
    }
    const t = this.transfers.get(nextId)!
    if (t.canceled) {
      t.progress.status = 'canceled'
      this.emitUpdate(nextId)
      void this.pump()
      return
    }

    this.activeId = nextId
    t.progress.status = 'downloading'
    t.samples = [{ time: Date.now(), bytes: 0 }]
    const plan = planMultiThread(t.input.size, t.input.segments)
    t.progress.segments = plan.streams
    this.emitUpdate(nextId)

    try {
      await this.client.coreStatsDelete(t.group).catch(() => undefined)
      t.jobid = await this.client.copyFileAsync({
        srcFs: t.input.srcFs,
        srcRemote: t.input.srcRemote,
        dstFs: t.input.dstFs,
        dstRemote: t.input.dstRemote,
        group: t.group,
        config: multiThreadConfig(plan)
      })
      this.startTicker()
    } catch (err) {
      t.progress.status = 'error'
      t.progress.error = err instanceof Error ? err.message : String(err)
      this.activeId = null
      this.emitUpdate(nextId)
      void this.pump()
    }
  }

  private startTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => {
      void this.poll()
    }, POLL_INTERVAL_MS)
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  private async poll(): Promise<void> {
    const id = this.activeId
    if (!id) return
    const t = this.transfers.get(id)
    if (!t || t.jobid === null) return

    try {
      const stats = await this.client.coreStats(t.group)
      const transferred = stats.bytes ?? t.progress.transferred
      t.progress.transferred = Math.min(transferred, t.progress.size || transferred)
      const inFlight = (stats.transferring?.length ?? 0) > 0
      t.progress.activeSegments = inFlight ? t.progress.segments : 0
      pushSample(t.samples, { time: Date.now(), bytes: t.progress.transferred })
      t.progress.speedBytesPerSec = rollingSpeed(t.samples)

      const job = await this.client.jobStatus(t.jobid)
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
        this.activeId = null
        this.finalize(t)
        this.emitUpdate(id)
        await this.client.coreStatsDelete(t.group).catch(() => undefined)
        void this.pump()
      } else {
        this.emitUpdate(id)
      }
    } catch {
    }
  }

  private finalize(t: InternalTransfer): void {
    const name = t.input.cleanupRemote
    if (name && !t.cleaned) {
      t.cleaned = true
      void this.client.deleteRemote(name).catch(() => undefined)
    }
  }

  private emitUpdate(id: string): void {
    const t = this.transfers.get(id)
    if (t) this.emit('update', { ...t.progress })
  }
}
