import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { TransferProgress } from '../../shared/types'
import { pushSample, rollingSpeed, type SpeedSample } from './speed'
import type { RcloneClient } from './client'
import { multiThreadConfig, planMultiThread } from './chunk'
import { httpError } from '../http'
import { downloadDestinationKey } from '../localFs'
import { basename, dirname } from 'node:path'
import {
  assertDestination,
  cleanupDownloadStage,
  createDownloadStage,
  publishDownload,
  type DestinationSnapshot,
  type DownloadStage
} from '../downloadPublication'

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
  destinationKey?: string
  destinationSnapshot?: DestinationSnapshot
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
  settled: boolean
  submission: 'none' | 'pending' | 'known'
  observedFinish: boolean
  finishedFailure: boolean
  retryAdmission: Promise<TransferProgress> | null
  stage: DownloadStage | null
  publishing: boolean
}

export const POLL_INTERVAL_MS = 400
export const DEFAULT_MAX_CONCURRENT = 3
export const MIN_MAX_CONCURRENT = 1
export const MAX_MAX_CONCURRENT = 8
export const CANCEL_SETTLE_TIMEOUT_MS = 4000
const TARGET_WAIT_REASON = 'Waiting for another download to this file.'
const QUARANTINE_REASON =
  'A previous download may still be writing to this file. Retry is blocked. Restart Siphon only after confirming its old rclone backend has stopped.'

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
  private readonly activeByKey = new Map<string, string>()
  private readonly quarantined = new Set<string>()
  private maxConcurrent = DEFAULT_MAX_CONCURRENT
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly client: RcloneClient,
    private readonly validateDestination?: (input: RcloneEnqueueInput) => Promise<string>,
    private readonly log: (message: string) => void = (message) => console.warn(message)
  ) {
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

  hasUncertainWriters(): boolean {
    return this.quarantined.size > 0
  }

  setMaxConcurrent(max: number): number {
    this.maxConcurrent = clampMaxConcurrent(max)
    this.pump()
    return this.maxConcurrent
  }

  enqueue(input: RcloneEnqueueInput): TransferProgress {
    return this.enqueueBatch([input])[0]
  }

  enqueueBatch(inputs: RcloneEnqueueInput[]): TransferProgress[] {
    const created = inputs.map((input) => this.createTransfer(input))
    for (const t of created) {
      const key = this.destinationKey(t)
      if (key && this.quarantined.has(key)) this.failQuarantined(t)
      else this.emitUpdate(t.progress.id)
    }
    this.pump()
    return created.map((t) => ({ ...t.progress }))
  }

  private createTransfer(input: RcloneEnqueueInput, retained = false): InternalTransfer {
    input = Object.freeze({ ...input, direction: input.direction ?? 'download' })
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
    const t: InternalTransfer = {
      progress,
      input,
      group: `job-${id}`,
      jobid: null,
      canceled: false,
      canceledAt: null,
      cleaned: false,
      removePending: false,
      polling: false,
      samples: [],
      settled: false,
      submission: 'none',
      observedFinish: false,
      finishedFailure: false,
      retryAdmission: null,
      stage: null,
      publishing: false
    }
    this.transfers.set(id, t)
    this.order.push(id)
    if (!retained) this.retainRemote(input.cleanupRemote)
    return t
  }

  async retry(
    id: string,
    validate: (input: RcloneEnqueueInput) => Promise<RcloneEnqueueInput>
  ): Promise<TransferProgress> {
    const t = this.transfers.get(id)
    if (!t) throw httpError(404, 'Transfer not found.')
    if (t.progress.retriedAs) {
      const successor = this.transfers.get(t.progress.retriedAs)
      if (!successor) throw httpError(409, 'The retry successor has been removed.')
      return { ...successor.progress }
    }

    if (t.retryAdmission) return t.retryAdmission
    this.assertRetryable(t)
    this.retainRemote(t.input.cleanupRemote)
    const admission = Promise.resolve().then(() => this.admitRetry(id, t, validate))
    t.retryAdmission = admission
    try {
      return await admission
    } finally {
      if (t.retryAdmission === admission) t.retryAdmission = null
    }
  }

  acquireRetryInput(id: string): { input: RcloneEnqueueInput; release: () => void } {
    const t = this.transfers.get(id)
    if (!t) throw httpError(404, 'Transfer not found.')
    this.assertRetryable(t)
    this.retainRemote(t.input.cleanupRemote)
    let released = false
    return {
      input: { ...t.input },
      release: () => {
        if (released) return
        released = true
        this.releaseRemote(t.input.cleanupRemote)
      }
    }
  }

  private async admitRetry(
    id: string,
    t: InternalTransfer,
    validate: (input: RcloneEnqueueInput) => Promise<RcloneEnqueueInput>
  ): Promise<TransferProgress> {
    let transferredLease = false
    try {
      const refreshed = await validate(Object.freeze({ ...t.input }))
      if (this.transfers.get(id) !== t) throw httpError(404, 'Transfer not found.')
      this.assertRetryable(t)
      if (!Number.isFinite(refreshed.size)) throw httpError(400, 'Invalid source file size.')
      const key = this.destinationKey(t)
      if (refreshed.destinationKey !== undefined && refreshed.destinationKey !== key) {
        throw httpError(409, 'The download destination has changed.', 'DESTINATION_CHANGED')
      }
      const successor = this.createTransfer(
        {
          ...t.input,
          size: Math.max(0, refreshed.size),
          destinationSnapshot: refreshed.destinationSnapshot,
          destinationKey: refreshed.destinationKey ?? t.input.destinationKey
        },
        true
      )
      transferredLease = true
      successor.progress.retryOf = id
      t.progress.retriedAs = successor.progress.id
      t.progress.retryable = false
      this.finalize(t)
      this.emitUpdate(id)
      this.emitUpdate(successor.progress.id)
      this.pump()
      return { ...successor.progress }
    } finally {
      if (!transferredLease) this.releaseRemote(t.input.cleanupRemote)
    }
  }

  private assertRetryable(t: InternalTransfer): void {
    if (
      !t.finishedFailure ||
      t.progress.direction !== 'download' ||
      t.progress.status !== 'error' ||
      t.canceled ||
      t.cleaned ||
      t.removePending ||
      t.progress.retriedAs
    ) {
      throw httpError(409, t.progress.retryUnavailableReason ?? 'This transfer cannot be retried.')
    }
    const key = this.destinationKey(t)
    if (key && this.quarantined.has(key)) {
      throw httpError(409, QUARANTINE_REASON, 'DESTINATION_BUSY')
    }
    for (const other of this.transfers.values()) {
      if (
        other !== t &&
        this.destinationKey(other) === key &&
        (other.progress.status === 'queued' || other.progress.status === 'downloading')
      ) {
        throw httpError(
          409,
          'Another download is queued or active for this file.',
          'DESTINATION_BUSY'
        )
      }
    }
  }

  cancel(id: string): void {
    const t = this.transfers.get(id)
    if (!t) return
    if (t.progress.status === 'queued') {
      t.canceled = true
      t.settled = true
      t.progress.status = 'canceled'
      t.progress.waitingReason = undefined
      this.finalize(t)
      this.emitUpdate(id)
      this.pump()
    } else if (t.progress.status === 'downloading') {
      t.canceled = true
      t.canceledAt = Date.now()
      t.progress.canceling = true
      if (t.jobid !== null) void this.client.jobStop(t.jobid).catch(() => undefined)
      this.emitUpdate(id)
    }
  }

  cancelAll(): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- snapshot: cancel() mutates this.order during iteration
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
    // eslint-disable-next-line unicorn/no-useless-spread -- snapshot: remove() mutates this.order during iteration
    for (const id of [...this.order]) {
      const status = this.transfers.get(id)?.progress.status
      if (status === 'completed' || status === 'canceled' || status === 'error') this.remove(id)
    }
  }

  clearAll(): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- snapshot: this.order is mutated during iteration
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
      const nextId = this.order.find((id) => {
        const t = this.transfers.get(id)!
        const key = this.destinationKey(t)
        return (
          t.progress.status === 'queued' &&
          (!key || (!this.activeByKey.has(key) && !this.quarantined.has(key)))
        )
      })
      if (!nextId) break
      const t = this.transfers.get(nextId)!
      const key = this.destinationKey(t)
      this.activeIds.add(nextId)
      if (key) this.activeByKey.set(key, nextId)
      t.progress.waitingReason = undefined
      void this.runJob(nextId).catch((err) => this.failRun(nextId, t, err))
    }
    for (const t of this.transfers.values()) {
      if (t.progress.status !== 'queued') continue
      const key = this.destinationKey(t)
      const reason = key && this.activeByKey.has(key) ? TARGET_WAIT_REASON : undefined
      if (t.progress.waitingReason !== reason) {
        t.progress.waitingReason = reason
        this.emitUpdate(t.progress.id)
      }
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
      if (!this.ownsActive(id, t)) return
      if (!t.canceled && this.validateDestination && t.progress.direction === 'download') {
        const key = await this.validateDestination(t.input)
        if (!this.ownsActive(id, t)) return
        if (key !== this.destinationKey(t)) {
          throw httpError(409, 'The download destination has changed.', 'DESTINATION_CHANGED')
        }
      }
      if (!this.ownsActive(id, t)) return
      if (t.canceled) {
        t.progress.status = 'canceled'
        this.settleTerminal(id, t)
        return
      }
      if (t.progress.direction === 'download') {
        await assertDestination(
          t.input.localPath,
          t.input.destinationSnapshot ?? { kind: 'absent' }
        )
        t.stage = await createDownloadStage(t.input.localPath)
        if (!this.ownsActive(id, t)) {
          await cleanupDownloadStage(t.stage)
          return
        }
        if (t.canceled) {
          await cleanupDownloadStage(t.stage)
          t.progress.status = 'canceled'
          this.settleTerminal(id, t)
          return
        }
      }
      t.submission = 'pending'
      const jobid = await this.client.copyFileAsync({
        srcFs: t.input.srcFs,
        srcRemote: t.input.srcRemote,
        dstFs: t.stage ? dirname(t.stage.path) : t.input.dstFs,
        dstRemote: t.stage ? basename(t.stage.path) : t.input.dstRemote,
        group: t.group,
        config: multiThreadConfig(plan)
      })
      if (!this.ownsActive(id, t)) {
        void this.client.jobStop(jobid).catch(() => undefined)
        return
      }
      t.jobid = jobid
      t.submission = 'known'

      if (t.canceled) {
        void this.client.jobStop(t.jobid).catch(() => undefined)
        this.quarantine(t)
        if (t.stage) t.progress.recoveryPath = t.stage.directory
        t.progress.status = 'canceled'
        t.progress.activeSegments = 0
        this.settleTerminal(id, t)
        await this.client.coreStatsDelete(t.group).catch(() => undefined)
        return
      }
      this.pump()
    } catch (err) {
      await this.failRun(id, t, err)
    }
  }

  private startTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => {
      // eslint-disable-next-line unicorn/no-useless-spread -- snapshot: poll() mutates this.activeIds during iteration
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
    if (!t || !this.ownsActive(id, t)) return
    if (t.publishing) return

    if (
      t.canceled &&
      t.canceledAt !== null &&
      Date.now() - t.canceledAt > CANCEL_SETTLE_TIMEOUT_MS
    ) {
      t.progress.status = 'canceled'
      t.progress.activeSegments = 0
      t.progress.speedBytesPerSec = 0
      if (t.jobid !== null) void this.client.jobStop(t.jobid).catch(() => undefined)
      this.quarantine(t)
      if (t.stage) t.progress.recoveryPath = t.stage.directory
      this.settleTerminal(id, t)
      await this.client.coreStatsDelete(t.group).catch(() => undefined)
      return
    }

    if (t.polling || t.jobid === null) return
    t.polling = true

    try {
      const stats = await this.client.coreStats(t.group)
      if (!this.ownsActive(id, t)) return
      const transferred = stats.bytes ?? t.progress.transferred
      t.progress.transferred = Math.min(transferred, t.progress.size || transferred)
      const inFlight = (stats.transferring?.length ?? 0) > 0
      t.progress.activeSegments = inFlight ? t.progress.segments : 0
      pushSample(t.samples, { time: Date.now(), bytes: t.progress.transferred })
      t.progress.speedBytesPerSec = rollingSpeed(t.samples)

      const job = await this.client.jobStatus(t.jobid)
      if (!this.ownsActive(id, t)) return
      if (job.finished) {
        t.observedFinish = true
        t.publishing = true
        let terminalStatus: 'completed' | 'canceled' | 'error'
        if (t.canceled) {
          terminalStatus = 'canceled'
        } else if (job.success) {
          if (t.stage) {
            if (
              this.validateDestination &&
              (await this.validateDestination(t.input)) !== this.destinationKey(t)
            ) {
              throw httpError(409, 'The download destination has changed.', 'DESTINATION_CHANGED')
            }
            const published = await publishDownload(
              t.stage,
              t.input.localPath,
              t.input.destinationSnapshot ?? { kind: 'absent' },
              () => t.canceled
            )
            terminalStatus = published ? 'completed' : 'canceled'
          } else {
            terminalStatus = 'completed'
          }
          if (terminalStatus === 'completed') {
            t.progress.transferred = t.progress.size || t.progress.transferred
          }
        } else {
          terminalStatus = 'error'
          t.progress.error =
            job.error || (t.progress.direction === 'upload' ? 'Upload failed.' : 'Download failed.')
          t.finishedFailure = t.progress.direction === 'download'
        }
        if (t.stage) {
          t.progress.recoveryPath = t.stage.recoveryPath
          await cleanupDownloadStage(t.stage)
        }
        t.progress.status = terminalStatus
        t.progress.activeSegments = 0
        t.progress.speedBytesPerSec = 0
        this.settleTerminal(id, t)
        await this.client.coreStatsDelete(t.group).catch(() => undefined)
      } else {
        this.emitUpdate(id)
      }
    } catch (error) {
      if (t.observedFinish) await this.failRun(id, t, error)
    } finally {
      t.polling = false
      t.publishing = false
    }
  }

  private settleTerminal(id: string, t: InternalTransfer): void {
    if (!this.ownsActive(id, t)) return
    t.settled = true
    const key = this.destinationKey(t)
    if (key && this.activeByKey.get(key) === id) this.activeByKey.delete(key)
    this.activeIds.delete(id)
    t.progress.canceling = undefined
    t.progress.waitingReason = undefined
    t.progress.retryable =
      t.finishedFailure &&
      !t.canceled &&
      !t.removePending &&
      !t.cleaned &&
      !t.progress.retriedAs &&
      (!key || !this.quarantined.has(key))
    if (!t.progress.retryable) this.finalize(t)
    if (t.progress.recoveryPath) {
      this.log(`Download ${id}: preserved recovery content at ${t.progress.recoveryPath}`)
    }
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
      this.releaseRemote(name)
    }
  }

  private retainRemote(name: string | undefined): void {
    if (name) this.remoteRefs.set(name, (this.remoteRefs.get(name) ?? 0) + 1)
  }

  private releaseRemote(name: string | undefined): void {
    if (!name) return
    const remaining = (this.remoteRefs.get(name) ?? 1) - 1
    if (remaining <= 0) {
      this.remoteRefs.delete(name)
      void this.client.deleteRemote(name).catch(() => undefined)
    } else {
      this.remoteRefs.set(name, remaining)
    }
  }

  private destinationKey(t: InternalTransfer): string | undefined {
    if (t.progress.direction === 'upload') return undefined
    return t.input.destinationKey ?? downloadDestinationKey(t.input.localPath)
  }

  private ownsActive(id: string, t: InternalTransfer): boolean {
    const key = this.destinationKey(t)
    return (
      !t.settled &&
      this.transfers.get(id) === t &&
      this.activeIds.has(id) &&
      (!key || this.activeByKey.get(key) === id)
    )
  }

  private failQuarantined(t: InternalTransfer): void {
    t.settled = true
    t.progress.status = 'error'
    t.progress.error = QUARANTINE_REASON
    t.progress.errorCode = 'DESTINATION_BUSY'
    t.progress.retryable = false
    t.progress.retryUnavailableReason = QUARANTINE_REASON
    t.progress.waitingReason = undefined
    this.finalize(t)
    this.emitUpdate(t.progress.id)
  }

  private quarantine(t: InternalTransfer): void {
    const key = this.destinationKey(t)
    if (!key || t.submission === 'none' || t.observedFinish) return
    this.quarantined.add(key)
    t.progress.retryUnavailableReason = QUARANTINE_REASON
    for (const other of this.transfers.values()) {
      if (other.progress.status === 'queued' && this.destinationKey(other) === key) {
        this.failQuarantined(other)
      } else if (other !== t && other.progress.retryable && this.destinationKey(other) === key) {
        other.progress.retryable = false
        other.progress.retryUnavailableReason = QUARANTINE_REASON
        this.finalize(other)
        this.emitUpdate(other.progress.id)
      }
    }
  }

  private async failRun(id: string, t: InternalTransfer, err: unknown): Promise<void> {
    if (!this.ownsActive(id, t)) return
    this.quarantine(t)
    if (t.stage) {
      if (t.submission === 'none' || t.observedFinish) {
        t.progress.recoveryPath = t.stage.recoveryPath
        try {
          await cleanupDownloadStage(t.stage)
        } catch (error) {
          t.progress.recoveryPath = t.stage.directory
          err = new Error(`${String(err)} Staging cleanup failed: ${String(error)}`)
        }
      } else {
        t.progress.recoveryPath = t.stage.directory
      }
    }
    t.finishedFailure =
      t.progress.direction === 'download' && (t.submission === 'none' || t.observedFinish)
    t.progress.status = t.canceled ? 'canceled' : 'error'
    const message = err instanceof Error ? err.message : String(err)
    t.progress.error = t.progress.retryUnavailableReason
      ? `${message} ${t.progress.retryUnavailableReason}`
      : message
    if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
      t.progress.errorCode = err.code
    }
    t.progress.activeSegments = 0
    t.progress.speedBytesPerSec = 0
    this.settleTerminal(id, t)
  }

  private emitUpdate(id: string): void {
    const t = this.transfers.get(id)
    if (t) this.emit('update', { ...t.progress })
  }

  private emitRemove(id: string): void {
    this.emit('remove', id)
  }
}
