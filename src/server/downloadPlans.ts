import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type {
  DownloadAdmission,
  DownloadCommitInput,
  DownloadPlan,
  DownloadPlanInput
} from '../shared/api'
import type { RouteContext } from './context'
import {
  assertDestination,
  inspectDownloadDirectory,
  snapshotDestination,
  type DestinationSnapshot
} from './downloadPublication'
import { httpError, parseConnectionRevision } from './http'
import { downloadDestinationKey, resolvePath, type FsScope } from './localFs'
import { safeBaseName, uiToRemotePath } from './mapping'
import type { RcloneClient } from './rclone/client'
import type { RcloneDownloadManager, RcloneEnqueueInput } from './rclone/downloadManager'
import { MAX_DOWNLOAD_ENTRIES, planDownload } from './downloadExpansion'
import type { ConnectionSession } from './session'

export const DOWNLOAD_PLAN_TTL_MS = 5 * 60_000
const MAX_PLANS = 128
const MAX_FILES = MAX_DOWNLOAD_ENTRIES

interface PlannedEntry {
  id: string
  input: RcloneEnqueueInput
  snapshot: DestinationSnapshot
}

interface PendingPlan {
  public: DownloadPlan
  entries: PlannedEntry[]
  revision?: string
  retryOf?: string
  releaseLease: (transferred?: boolean) => Promise<void>
  timer: ReturnType<typeof setTimeout>
  admission?: Promise<DownloadAdmission>
  decisions?: string
  canceled: boolean
  admitted: boolean
  directories: { id: string; path: string; root: string; blocked: boolean }[]
}

export class DownloadPlans {
  private readonly plans = new Map<string, PendingPlan>()

  constructor(
    private readonly client: RcloneClient,
    private readonly manager: RcloneDownloadManager,
    private readonly session: ConnectionSession,
    private readonly scope: FsScope,
    private readonly defaultDir: string,
    private readonly updates: RouteContext['updates'],
    private readonly logError: (error: unknown) => void
  ) {}

  async create(input: DownloadPlanInput): Promise<DownloadPlan> {
    this.assertCapacity()
    if (
      !Array.isArray(input?.remotePaths) ||
      !input.remotePaths.length ||
      input.remotePaths.length > MAX_FILES ||
      input.remotePaths.some((path) => typeof path !== 'string' || !path) ||
      typeof input.downloadDir !== 'string' ||
      !Number.isInteger(input.segments) ||
      input.segments < 1 ||
      input.segments > 16
    ) {
      throw httpError(400, 'Invalid download plan.')
    }
    const releaseAdmission = this.updates?.admitTransfer()
    let releaseJob: (() => Promise<void>) | undefined
    try {
      const binding = this.session.bind(parseConnectionRevision(input.connectionRevision))
      const job = await this.session.acquireJobRemote('_dl-', binding.revision)
      releaseJob = job.release
      const targetDir = await resolvePath(this.scope, input.downloadDir.trim() || this.defaultDir)
      if (!targetDir) throw httpError(400, 'That download folder is not accessible.')
      const inputs: RcloneEnqueueInput[] = []
      const directories: { path: string; root: string }[] = []
      let folder = false
      for (const remotePath of input.remotePaths) {
        const srcRemote = uiToRemotePath(remotePath)
        const item = await this.client.stat(job.fs, srcRemote)
        if (!item) throw httpError(404, 'File not found.')
        folder ||= item.IsDir
        const planned = await planDownload(this.client, {
          item,
          remotePath,
          dirPath: srcRemote,
          wrappingName: safeBaseName(remotePath),
          targetDir,
          segments: input.segments,
          jobRemote: job.remoteName
        })
        inputs.push(...planned.inputs)
        for (const path of planned.directories) {
          if (!planned.inputs.some((entry) => entry.localPath.startsWith(`${path}${sep}`))) {
            directories.push({ path, root: planned.directories[0] })
          }
        }
        if (inputs.length > MAX_FILES) throw httpError(400, 'Too many files in one download batch.')
        if (directories.length > MAX_FILES)
          throw httpError(400, 'Too many folders in one download batch.')
      }
      return await this.store(
        inputs,
        folder || input.remotePaths.length > 1,
        async (transferred) => {
          try {
            if (!transferred) await job.release()
          } finally {
            releaseAdmission?.()
          }
        },
        binding.revision,
        undefined,
        directories
      )
    } catch (error) {
      try {
        await releaseJob?.()
      } finally {
        releaseAdmission?.()
      }
      throw error
    }
  }

  async createRetry(id: string): Promise<DownloadPlan> {
    this.assertCapacity()
    const releaseAdmission = this.updates?.admitTransfer()
    let lease: ReturnType<RcloneDownloadManager['acquireRetryInput']> | undefined
    try {
      lease = this.manager.acquireRetryInput(id)
      const input = { ...lease.input }
      const item = await this.client.stat(input.srcFs, input.srcRemote)
      if (!item) throw httpError(404, 'File not found.')
      if (item.IsDir || !Number.isFinite(item.Size)) throw httpError(400, 'Invalid retry source.')
      input.size = Math.max(0, item.Size)
      const retained = lease
      return await this.store(
        [input],
        false,
        async () => {
          retained.release()
          releaseAdmission?.()
        },
        undefined,
        id
      )
    } catch (error) {
      lease?.release()
      releaseAdmission?.()
      throw error
    }
  }

  private assertCapacity(): void {
    if (this.plans.size >= MAX_PLANS) {
      throw httpError(
        429,
        'Too many pending download plans. Cancel a pending choice or wait for expiry.'
      )
    }
  }

  private async allowed(path: string): Promise<string> {
    const canonical = await resolvePath(this.scope, path)
    if (!canonical || downloadDestinationKey(canonical) !== downloadDestinationKey(resolve(path))) {
      throw httpError(400, 'That download destination is protected, symlinked, or not accessible.')
    }
    return canonical
  }

  private async store(
    inputs: RcloneEnqueueInput[],
    batch: boolean,
    release: (transferred?: boolean) => Promise<void>,
    revision?: string,
    retryOf?: string,
    emptyDirectories: { path: string; root: string }[] = []
  ): Promise<DownloadPlan> {
    this.assertCapacity()
    const entries: PlannedEntry[] = []
    const keys: string[] = []
    for (const input of inputs) {
      const canonical = await this.allowed(input.localPath)
      const key = downloadDestinationKey(canonical)
      if (
        keys.some(
          (other) =>
            key === other || key.startsWith(`${other}${sep}`) || other.startsWith(`${key}${sep}`)
        )
      ) {
        throw httpError(
          409,
          'This batch contains ambiguous destinations. Select non-overlapping sources.',
          'AMBIGUOUS_DESTINATION'
        )
      }
      keys.push(key)
      input.destinationKey = key
      const snapshot = await snapshotDestination(input.localPath)
      entries.push({ id: randomUUID(), input, snapshot })
    }
    const id = randomUUID()
    const directories = []
    for (const directory of emptyDirectories) {
      await this.allowed(directory.path)
      directories.push({
        ...directory,
        id: randomUUID(),
        blocked: !(await inspectDownloadDirectory(directory.path))
      })
    }
    const publicPlan: DownloadPlan = {
      id,
      expiresAt: Date.now() + DOWNLOAD_PLAN_TTL_MS,
      fileCount: entries.length,
      batch,
      conflicts: [
        ...entries
          .filter((entry) => entry.snapshot.kind !== 'absent')
          .map((entry) => ({
            entryId: entry.id,
            remotePath: entry.input.displayName,
            localPath: entry.input.localPath,
            canOverwrite: entry.snapshot.kind === 'file'
          })),
        ...directories
          .filter((directory) => directory.blocked)
          .map((directory) => ({
            entryId: directory.id,
            remotePath: directory.path,
            localPath: directory.path,
            canOverwrite: false
          }))
      ]
    }
    let released = false
    this.assertCapacity()
    const plan: PendingPlan = {
      public: publicPlan,
      entries,
      revision,
      retryOf,
      canceled: false,
      admitted: false,
      directories,
      releaseLease: async (transferred) => {
        if (released) return
        released = true
        await release(transferred)
      },
      timer: setTimeout(() => {
        void this.release(id).catch((error: unknown) => {
          this.logError(error)
        })
      }, DOWNLOAD_PLAN_TTL_MS)
    }
    plan.timer.unref()
    this.plans.set(id, plan)
    return publicPlan
  }

  async commit(input: DownloadCommitInput): Promise<DownloadAdmission> {
    if (
      !input ||
      typeof input.planId !== 'string' ||
      !input.decisions ||
      typeof input.decisions !== 'object' ||
      Array.isArray(input.decisions)
    ) {
      throw httpError(400, 'Invalid download decisions.')
    }
    const plan = this.plans.get(input.planId)
    if (!plan || plan.canceled || Date.now() >= plan.public.expiresAt) {
      throw httpError(
        409,
        'The download plan expired or was canceled. Review the download again.',
        'DOWNLOAD_PLAN_EXPIRED'
      )
    }
    const decisions = JSON.stringify(
      Object.entries(input.decisions).sort(([a], [b]) => a.localeCompare(b))
    )
    if (plan.admission) {
      if (decisions !== plan.decisions)
        throw httpError(
          409,
          'This plan was already submitted with different decisions.',
          'DOWNLOAD_PLAN_USED'
        )
      return plan.admission
    }
    const conflicts = new Map(plan.public.conflicts.map((conflict) => [conflict.entryId, conflict]))
    for (const [id, decision] of Object.entries(input.decisions)) {
      const conflict = conflicts.get(id)
      if (
        !conflict ||
        (decision !== 'overwrite' && decision !== 'skip') ||
        (decision === 'overwrite' && !conflict.canOverwrite) ||
        (decision === 'skip' && !plan.public.batch)
      ) {
        throw httpError(400, 'Invalid collision decision.')
      }
    }
    if ([...conflicts.keys()].some((id) => !Object.hasOwn(input.decisions, id))) {
      throw httpError(
        409,
        'Every collision needs an explicit decision before admission.',
        'DESTINATION_COLLISION'
      )
    }
    plan.decisions = decisions
    plan.admission = this.admit(plan, { ...input.decisions })
    return plan.admission
  }

  private async admit(
    plan: PendingPlan,
    decisions: DownloadCommitInput['decisions']
  ): Promise<DownloadAdmission> {
    let transferred = false
    try {
      if (plan.revision) this.session.bind(plan.revision)
      const selected = plan.entries.filter((entry) => decisions[entry.id] !== 'skip')
      const skipped = [
        ...plan.entries
          .filter((entry) => decisions[entry.id] === 'skip')
          .map((entry) => entry.input.displayName),
        ...plan.directories
          .filter((directory) => decisions[directory.id] === 'skip')
          .map((directory) => directory.path)
      ]
      for (const entry of selected) {
        await this.allowed(entry.input.localPath)
        await assertDestination(entry.input.localPath, entry.snapshot)
      }
      this.assertLive(plan)
      if (plan.revision) this.session.bind(plan.revision)
      let transfers
      if (plan.retryOf && selected.length) {
        const entry = selected[0]
        transfers = [
          await this.manager.retry(plan.retryOf, async () => {
            this.assertLive(plan)
            await this.allowed(entry.input.localPath)
            await assertDestination(entry.input.localPath, entry.snapshot)
            const item = await this.client.stat(entry.input.srcFs, entry.input.srcRemote)
            if (!item) throw httpError(404, 'File not found.')
            if (item.IsDir || !Number.isFinite(item.Size))
              throw httpError(400, 'Invalid retry source.')
            this.assertLive(plan)
            plan.admitted = true
            return {
              ...entry.input,
              size: Math.max(0, item.Size),
              destinationSnapshot: entry.snapshot
            }
          })
        ]
      } else {
        // No directory creation is allowed until every choice and destination has passed.
        const directories = new Set(selected.map((entry) => dirname(entry.input.localPath)))
        for (const directory of plan.directories) {
          if (
            decisions[directory.id] !== 'skip' &&
            selected.some((entry) => entry.input.localPath.startsWith(`${directory.root}${sep}`))
          ) {
            if (!(await inspectDownloadDirectory(directory.path))) {
              throw httpError(
                409,
                'A destination folder changed. Existing content was preserved.',
                'DESTINATION_CHANGED'
              )
            }
            directories.add(directory.path)
          }
        }
        for (const directory of directories) await this.allowed(directory)
        this.assertLive(plan)
        plan.admitted = true
        for (const directory of directories) {
          await this.allowed(directory)
          await mkdir(directory, { recursive: true })
        }
        transfers = this.manager.enqueueBatch(
          selected.map((entry) => ({
            ...entry.input,
            destinationSnapshot: entry.snapshot
          }))
        )
      }
      // The manager now owns the cloned source; do not delete it with the preview lease.
      transferred = selected.length > 0 && !plan.retryOf
      return { transfers, skipped, empty: plan.entries.length === 0 }
    } finally {
      await plan.releaseLease(transferred)
    }
  }

  private assertLive(plan: PendingPlan): void {
    if (plan.canceled || Date.now() >= plan.public.expiresAt) {
      throw httpError(409, 'The download plan expired or was canceled.', 'DOWNLOAD_PLAN_EXPIRED')
    }
  }

  async release(id: string): Promise<void> {
    const plan = this.plans.get(id)
    if (!plan) return
    if (!plan.admitted) plan.canceled = true
    clearTimeout(plan.timer)
    this.plans.delete(id)
    if (plan.admission) {
      await plan.admission.catch(() => undefined)
    }
    await plan.releaseLease()
  }

  async close(): Promise<void> {
    await Promise.all([...this.plans.keys()].map((id) => this.release(id)))
  }
}
