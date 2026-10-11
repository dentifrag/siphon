import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CANCEL_SETTLE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  RcloneDownloadManager,
  type RcloneEnqueueInput
} from '../src/server/rclone/downloadManager'
import type { RcloneClient } from '../src/server/rclone/client'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function enqueueInput(overrides: Partial<RcloneEnqueueInput> = {}): RcloneEnqueueInput {
  return {
    srcFs: 'dl:',
    srcRemote: 'file.bin',
    dstFs: '/out',
    dstRemote: 'file.bin',
    displayName: '/file.bin',
    localPath: '/out/file.bin',
    size: 100 * 1024 * 1024,
    segments: 4,
    ...overrides
  }
}

describe('RcloneDownloadManager direction', () => {
  it('defaults direction to download and round-trips an explicit upload direction through list()', () => {
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      copyFileAsync: vi.fn().mockReturnValue(new Promise(() => {}))
    } as unknown as RcloneClient
    const manager = new RcloneDownloadManager(client)

    const downloadTransfer = manager.enqueue(enqueueInput())
    expect(downloadTransfer.direction).toBe('download')
    expect(manager.list().find((t) => t.id === downloadTransfer.id)?.direction).toBe('download')

    const uploadTransfer = manager.enqueue(enqueueInput({ direction: 'upload' }))
    expect(uploadTransfer.direction).toBe('upload')
    expect(manager.list().find((t) => t.id === uploadTransfer.id)?.direction).toBe('upload')
  })
})

describe('RcloneDownloadManager cancellation race', () => {
  it('stops and cleans up a job that starts after the user already canceled', async () => {
    const startJob = deferred<number>()
    const jobStop = vi.fn().mockResolvedValue(undefined)
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const jobStatus = vi
      .fn()
      .mockResolvedValue({ finished: false, success: false, error: '', id: 1 })

    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockReturnValue(startJob.promise),
      jobStop,
      jobStatus,
      deleteRemote
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    const enqueued = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-abc' }))

    await Promise.resolve()
    manager.cancel(enqueued.id)

    startJob.resolve(42)
    await new Promise((r) => setTimeout(r, 10))

    const transfer = manager.list().find((t) => t.id === enqueued.id)
    expect(transfer?.status).toBe('canceled')
    expect(jobStop).toHaveBeenCalledWith(42)
    expect(deleteRemote).toHaveBeenCalledWith('_dl-abc')
    expect(jobStatus).not.toHaveBeenCalled()
  })
})

describe('RcloneDownloadManager concurrency', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs up to maxConcurrent jobs at once and backfills as they finish', async () => {
    let nextJobId = 1
    const jobStatuses = new Map<number, { finished: boolean; success: boolean; error: string }>()
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockImplementation(async () => {
        const id = nextJobId++
        jobStatuses.set(id, { finished: false, success: false, error: '' })
        return id
      }),
      jobStatus: vi
        .fn()
        .mockImplementation(async (id: number) => ({ id, ...jobStatuses.get(id)! })),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn().mockResolvedValue(undefined)
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(2)

    const a = manager.enqueue(enqueueInput())
    const b = manager.enqueue(enqueueInput())
    const c = manager.enqueue(enqueueInput())

    await flushMicrotasks()

    const statusOf = (id: string) => manager.list().find((t) => t.id === id)?.status
    expect(statusOf(a.id)).toBe('downloading')
    expect(statusOf(b.id)).toBe('downloading')
    expect(statusOf(c.id)).toBe('queued')
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)

    jobStatuses.set(1, { finished: true, success: true, error: '' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await flushMicrotasks()

    expect(statusOf(a.id)).toBe('completed')
    expect(statusOf(c.id)).toBe('downloading')
    expect(client.copyFileAsync).toHaveBeenCalledTimes(3)
  })

  it('clamps setMaxConcurrent to the 1-8 range', () => {
    const client = {} as unknown as RcloneClient
    const manager = new RcloneDownloadManager(client)
    expect(manager.setMaxConcurrent(0)).toBe(1)
    expect(manager.setMaxConcurrent(99)).toBe(8)
    expect(manager.setMaxConcurrent(5)).toBe(5)
  })
})

describe('RcloneDownloadManager remove and clearAll', () => {
  it('remove() finalizes a queued transfer (cleans up its cloned remote) before deleting it', () => {
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockReturnValue(new Promise(() => {})),
      jobStatus: vi.fn(),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)
    manager.enqueue(enqueueInput({ cleanupRemote: '_dl-active' }))
    const queued = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-queued' }))

    expect(manager.list().find((t) => t.id === queued.id)?.status).toBe('queued')
    manager.remove(queued.id)

    expect(manager.list().find((t) => t.id === queued.id)).toBeUndefined()
    expect(deleteRemote).toHaveBeenCalledWith('_dl-queued')
  })

  it('remove() returns false for a downloading transfer and true for a queued one', () => {
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockReturnValue(new Promise(() => {})),
      jobStatus: vi.fn(),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn().mockResolvedValue(undefined)
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)
    const active = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-active' }))
    const queued = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-queued' }))

    expect(manager.list().find((t) => t.id === active.id)?.status).toBe('downloading')
    expect(manager.remove(active.id)).toBe(false)
    expect(manager.list().find((t) => t.id === active.id)?.status).toBe('downloading')

    const onRemove = vi.fn()
    manager.onRemove(onRemove)
    expect(manager.remove(queued.id)).toBe(true)
    expect(onRemove).toHaveBeenCalledWith(queued.id)
    expect(manager.list().find((t) => t.id === queued.id)).toBeUndefined()
  })

  it('clearAll removes queued items immediately and sweeps active ones once they settle', async () => {
    vi.useFakeTimers()
    try {
      let nextJobId = 1
      const jobStatuses = new Map<number, { finished: boolean; success: boolean; error: string }>()
      const jobStop = vi.fn().mockResolvedValue(undefined)
      const deleteRemote = vi.fn().mockResolvedValue(undefined)
      const client = {
        coreStatsDelete: vi.fn().mockResolvedValue(undefined),
        coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
        copyFileAsync: vi.fn().mockImplementation(async () => {
          const id = nextJobId++
          jobStatuses.set(id, { finished: false, success: false, error: '' })
          return id
        }),
        jobStatus: vi
          .fn()
          .mockImplementation(async (id: number) => ({ id, ...jobStatuses.get(id)! })),
        jobStop,
        deleteRemote
      } as unknown as RcloneClient

      const manager = new RcloneDownloadManager(client)
      manager.setMaxConcurrent(1)
      const active = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-active' }))
      const queued = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-queued' }))

      await flushMicrotasks()
      expect(manager.list().find((t) => t.id === active.id)?.status).toBe('downloading')

      manager.clearAll()

      expect(manager.list().find((t) => t.id === queued.id)).toBeUndefined()
      expect(jobStop).toHaveBeenCalledWith(1)
      expect(manager.list().find((t) => t.id === active.id)?.status).toBe('downloading')

      jobStatuses.set(1, { finished: true, success: false, error: '' })
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushMicrotasks()

      expect(manager.list().find((t) => t.id === active.id)).toBeUndefined()
      expect(deleteRemote).toHaveBeenCalledWith('_dl-active')
      expect(deleteRemote).toHaveBeenCalledWith('_dl-queued')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RcloneDownloadManager removal signal', () => {
  it('remove() on a queued item emits a remove event with that id', () => {
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockReturnValue(new Promise(() => {})),
      jobStatus: vi.fn(),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn().mockResolvedValue(undefined)
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)
    manager.enqueue(enqueueInput({ cleanupRemote: '_dl-active' }))
    const queued = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-queued' }))

    const onRemove = vi.fn()
    manager.onRemove(onRemove)
    manager.remove(queued.id)

    expect(onRemove).toHaveBeenCalledWith(queued.id)
    expect(manager.list().find((t) => t.id === queued.id)).toBeUndefined()
  })

  it('emits a remove event once a clearAll-marked active transfer actually settles', async () => {
    vi.useFakeTimers()
    try {
      let nextJobId = 1
      const jobStatuses = new Map<number, { finished: boolean; success: boolean; error: string }>()
      const client = {
        coreStatsDelete: vi.fn().mockResolvedValue(undefined),
        coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
        copyFileAsync: vi.fn().mockImplementation(async () => {
          const id = nextJobId++
          jobStatuses.set(id, { finished: false, success: false, error: '' })
          return id
        }),
        jobStatus: vi
          .fn()
          .mockImplementation(async (id: number) => ({ id, ...jobStatuses.get(id)! })),
        jobStop: vi.fn().mockResolvedValue(undefined),
        deleteRemote: vi.fn().mockResolvedValue(undefined)
      } as unknown as RcloneClient

      const manager = new RcloneDownloadManager(client)
      manager.setMaxConcurrent(1)
      const active = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-active' }))

      const onRemove = vi.fn()
      manager.onRemove(onRemove)

      await flushMicrotasks()
      expect(manager.list().find((t) => t.id === active.id)?.status).toBe('downloading')

      manager.clearAll()
      expect(onRemove).not.toHaveBeenCalled()
      expect(manager.list().find((t) => t.id === active.id)?.status).toBe('downloading')

      jobStatuses.set(1, { finished: true, success: false, error: '' })
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushMicrotasks()

      expect(onRemove).toHaveBeenCalledWith(active.id)
      expect(manager.list().find((t) => t.id === active.id)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RcloneDownloadManager shared-remote refcounting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('only deletes a cloned remote once every sibling sharing it has settled, and remove() on an already-settled sibling does not double-decrement', async () => {
    let nextJobId = 1
    const jobStatuses = new Map<number, { finished: boolean; success: boolean; error: string }>()
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockImplementation(async () => {
        const id = nextJobId++
        jobStatuses.set(id, { finished: false, success: false, error: '' })
        return id
      }),
      jobStatus: vi
        .fn()
        .mockImplementation(async (id: number) => ({ id, ...jobStatuses.get(id)! })),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(2)
    const a = manager.enqueue(enqueueInput({ cleanupRemote: 'X' }))
    const b = manager.enqueue(enqueueInput({ cleanupRemote: 'X' }))

    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === a.id)?.status).toBe('downloading')
    expect(manager.list().find((t) => t.id === b.id)?.status).toBe('downloading')

    jobStatuses.set(1, { finished: true, success: true, error: '' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await flushMicrotasks()

    expect(manager.list().find((t) => t.id === a.id)?.status).toBe('completed')
    expect(deleteRemote).not.toHaveBeenCalled()

    manager.remove(a.id)
    expect(deleteRemote).not.toHaveBeenCalled()
    expect(manager.list().find((t) => t.id === a.id)).toBeUndefined()

    jobStatuses.set(2, { finished: true, success: true, error: '' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await flushMicrotasks()

    expect(manager.list().find((t) => t.id === b.id)?.status).toBe('completed')
    expect(deleteRemote).toHaveBeenCalledTimes(1)
    expect(deleteRemote).toHaveBeenCalledWith('X')
  })
})

describe('RcloneDownloadManager cancel watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets canceling true immediately when cancel() is called on a downloading transfer', () => {
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockReturnValue(new Promise(() => {})),
      jobStatus: vi.fn(),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn().mockResolvedValue(undefined)
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    const enqueued = manager.enqueue(enqueueInput())

    expect(manager.list().find((t) => t.id === enqueued.id)?.status).toBe('downloading')
    manager.cancel(enqueued.id)

    const transfer = manager.list().find((t) => t.id === enqueued.id)
    expect(transfer?.status).toBe('downloading')
    expect(transfer?.canceling).toBe(true)
  })

  it('force-settles a stuck cancellation after CANCEL_SETTLE_TIMEOUT_MS and frees its slot', async () => {
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockResolvedValue(1),
      jobStatus: vi.fn().mockResolvedValue({ finished: false, success: false, error: '', id: 1 }),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)
    const stuck = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-stuck' }))
    const queued = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-queued' }))

    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === stuck.id)?.status).toBe('downloading')
    expect(manager.list().find((t) => t.id === queued.id)?.status).toBe('queued')

    manager.cancel(stuck.id)
    expect(manager.list().find((t) => t.id === stuck.id)?.canceling).toBe(true)

    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS + POLL_INTERVAL_MS)
    await flushMicrotasks()

    expect(manager.list().find((t) => t.id === stuck.id)?.status).toBe('canceled')
    expect(deleteRemote).toHaveBeenCalledWith('_dl-stuck')
    expect(manager.list().find((t) => t.id === queued.id)?.status).toBe('downloading')
  })

  it('does not let a poll that was already in flight when the watchdog fired overwrite the forced cancellation', async () => {
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const jobStatusDeferred = deferred<{
      finished: boolean
      success: boolean
      error: string
      id: number
    }>()
    const jobStatus = vi.fn().mockReturnValueOnce(jobStatusDeferred.promise)
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockResolvedValue(1),
      jobStatus,
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    const enqueued = manager.enqueue(enqueueInput({ cleanupRemote: '_dl-race' }))

    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === enqueued.id)?.status).toBe('downloading')

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await flushMicrotasks()
    expect(jobStatus).toHaveBeenCalledTimes(1)

    manager.cancel(enqueued.id)
    expect(manager.list().find((t) => t.id === enqueued.id)?.canceling).toBe(true)

    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS + POLL_INTERVAL_MS)
    await flushMicrotasks()

    expect(manager.list().find((t) => t.id === enqueued.id)?.status).toBe('canceled')
    expect(deleteRemote).toHaveBeenCalledTimes(1)

    jobStatusDeferred.resolve({ finished: true, success: true, error: '', id: 1 })
    await flushMicrotasks()

    expect(manager.list().find((t) => t.id === enqueued.id)?.status).toBe('canceled')
    expect(deleteRemote).toHaveBeenCalledTimes(1)
  })
})
