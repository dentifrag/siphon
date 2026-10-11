import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CANCEL_SETTLE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  RcloneDownloadManager,
  type RcloneEnqueueInput
} from '../src/server/rclone/downloadManager'
import type { RcloneClient } from '../src/server/rclone/client'
import { join } from 'node:path'

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

let destinationIndex = 0

function enqueueInput(overrides: Partial<RcloneEnqueueInput> = {}): RcloneEnqueueInput {
  const destination = overrides.srcRemote ?? `file-${destinationIndex++}.bin`
  return {
    srcFs: 'dl:',
    srcRemote: 'file.bin',
    dstFs: '/out',
    dstRemote: destination,
    displayName: '/file.bin',
    localPath: join('/out', destination),
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

    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
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
  function makeManager(maxConcurrent = 1) {
    let nextJobId = 1
    const jobStatuses = new Map<number, { finished: boolean; success: boolean; error: string }>()
    const client = {
      coreStatsDelete: vi.fn<RcloneClient['coreStatsDelete']>().mockResolvedValue(undefined),
      coreStats: vi
        .fn<RcloneClient['coreStats']>()
        .mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn<RcloneClient['copyFileAsync']>().mockImplementation(async () => {
        const id = nextJobId++
        jobStatuses.set(id, { finished: false, success: false, error: '' })
        return id
      }),
      jobStatus: vi
        .fn<RcloneClient['jobStatus']>()
        .mockImplementation(async (id) => ({ id, ...jobStatuses.get(id)! })),
      jobStop: vi.fn<RcloneClient['jobStop']>().mockResolvedValue(undefined),
      deleteRemote: vi.fn<RcloneClient['deleteRemote']>().mockResolvedValue(undefined)
    }
    const manager = new RcloneDownloadManager(client as unknown as RcloneClient)
    manager.setMaxConcurrent(maxConcurrent)
    return { manager, client, jobStatuses }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs up to maxConcurrent jobs at once and backfills as they finish', async () => {
    const { manager, client, jobStatuses } = makeManager(2)

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

  it.each([{ segments: [8, 8, 8] }, { segments: [2, 8, 6] }])(
    'retains per-item requests $segments when raising the cap',
    async ({ segments }) => {
      const { manager, client } = makeManager()
      const transfers = segments.map((requested, index) =>
        manager.enqueue(enqueueInput({ srcRemote: `file-${index}.bin`, segments: requested }))
      )

      await flushMicrotasks()
      expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
      expect(manager.list().map(({ status }) => status)).toEqual([
        'downloading',
        'queued',
        'queued'
      ])
      expect(manager.list().map((transfer) => transfer.segments)).toEqual(segments)

      manager.setMaxConcurrent(3)
      await flushMicrotasks()

      expect(
        client.copyFileAsync.mock.calls.map(([input]) => ({
          srcRemote: input.srcRemote,
          segments: input.config.MultiThreadStreams
        }))
      ).toEqual(
        segments.map((requested, index) => ({
          srcRemote: `file-${index}.bin`,
          segments: requested
        }))
      )
      expect(manager.list().map(({ id }) => id)).toEqual(transfers.map(({ id }) => id))
      expect(manager.list().every(({ status }) => status === 'downloading')).toBe(true)
      expect(client.jobStop).not.toHaveBeenCalled()
    }
  )

  it('keeps queued options through an unchanged cap and completion backfill', async () => {
    const { manager, client, jobStatuses } = makeManager()
    const active = manager.enqueue(enqueueInput({ segments: 2 }))
    const queued = manager.enqueue(enqueueInput({ srcRemote: 'queued.bin', segments: 6 }))

    await flushMicrotasks()
    expect(manager.setMaxConcurrent(1)).toBe(1)
    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
    expect(manager.list().find(({ id }) => id === queued.id)?.segments).toBe(6)

    jobStatuses.set(1, { finished: true, success: true, error: '' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await flushMicrotasks()

    expect(manager.list().find(({ id }) => id === active.id)?.status).toBe('completed')
    expect(manager.list().find(({ id }) => id === queued.id)?.status).toBe('downloading')
    expect(
      client.copyFileAsync.mock.calls.map(([input]) => input.config.MultiThreadStreams)
    ).toEqual([2, 6])
    expect(client.jobStop).not.toHaveBeenCalled()
  })

  it.each(['start failure', 'terminal failure'])(
    'preserves queued options after %s frees a slot',
    async (failure) => {
      const { manager, client, jobStatuses } = makeManager()
      if (failure === 'start failure') {
        client.copyFileAsync.mockRejectedValueOnce(new Error('copy failed'))
      }
      const failed = manager.enqueue(enqueueInput({ segments: 8 }))
      const queued = manager.enqueue(enqueueInput({ srcRemote: 'queued.bin', segments: 6 }))

      await flushMicrotasks()
      if (failure === 'terminal failure') {
        expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
        jobStatuses.set(1, { finished: true, success: false, error: 'copy failed' })
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushMicrotasks()
      }

      expect(manager.list().find(({ id }) => id === failed.id)).toMatchObject({
        status: 'error',
        error: failure === 'start failure' ? expect.stringContaining('copy failed') : 'copy failed'
      })
      expect(manager.list().find(({ id }) => id === queued.id)?.status).toBe('downloading')
      expect(
        client.copyFileAsync.mock.calls.map(([input]) => ({
          srcRemote: input.srcRemote,
          segments: input.config.MultiThreadStreams
        }))
      ).toEqual([
        { srcRemote: 'file.bin', segments: 8 },
        { srcRemote: 'queued.bin', segments: 6 }
      ])
    }
  )

  it('skips queued cancellations without freeing active slots or replacing options', async () => {
    const { manager, client } = makeManager()
    manager.enqueue(enqueueInput({ segments: 2 }))
    const canceled = manager.enqueue(enqueueInput({ srcRemote: 'canceled.bin', segments: 8 }))
    const queued = manager.enqueue(enqueueInput({ srcRemote: 'queued.bin', segments: 6 }))

    await flushMicrotasks()
    manager.cancel(canceled.id)
    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
    expect(client.jobStop).not.toHaveBeenCalled()
    expect(manager.list().find(({ id }) => id === canceled.id)?.status).toBe('canceled')
    expect(manager.list().find(({ id }) => id === queued.id)?.status).toBe('queued')

    manager.setMaxConcurrent(2)
    await flushMicrotasks()

    expect(
      client.copyFileAsync.mock.calls.map(([input]) => ({
        srcRemote: input.srcRemote,
        segments: input.config.MultiThreadStreams
      }))
    ).toEqual([
      { srcRemote: 'file.bin', segments: 2 },
      { srcRemote: 'queued.bin', segments: 6 }
    ])
    expect(manager.list().find(({ id }) => id === queued.id)?.status).toBe('downloading')
  })

  it.each(['terminal settlement', 'watchdog'])(
    'preserves queued options when active cancellation ends through %s',
    async (settlement) => {
      const { manager, client, jobStatuses } = makeManager()
      const active = manager.enqueue(enqueueInput({ segments: 8 }))
      const queued = manager.enqueue(enqueueInput({ srcRemote: 'queued.bin', segments: 6 }))

      await flushMicrotasks()
      manager.cancel(active.id)
      await flushMicrotasks()
      expect(client.jobStop).toHaveBeenCalledWith(1)
      expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
      expect(manager.list().find(({ id }) => id === queued.id)?.status).toBe('queued')

      if (settlement === 'terminal settlement') {
        jobStatuses.set(1, { finished: true, success: false, error: '' })
      } else {
        await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS)
        await flushMicrotasks()
        expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
        expect(manager.list().find(({ id }) => id === queued.id)?.status).toBe('queued')
      }
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushMicrotasks()

      expect(manager.list().find(({ id }) => id === active.id)?.status).toBe('canceled')
      expect(manager.list().find(({ id }) => id === queued.id)?.status).toBe('downloading')
      expect(
        client.copyFileAsync.mock.calls.map(([input]) => ({
          srcRemote: input.srcRemote,
          segments: input.config.MultiThreadStreams
        }))
      ).toEqual([
        { srcRemote: 'file.bin', segments: 8 },
        { srcRemote: 'queued.bin', segments: 6 }
      ])
    }
  )

  it('preserves upload and download options through shared-cap backfill', async () => {
    const { manager, client, jobStatuses } = makeManager()
    const upload = manager.enqueue(
      enqueueInput({ srcRemote: 'upload.bin', direction: 'upload', segments: 1 })
    )
    const firstDownload = manager.enqueue(
      enqueueInput({ srcRemote: 'first-download.bin', segments: 8 })
    )
    const nextDownload = manager.enqueue(
      enqueueInput({ srcRemote: 'next-download.bin', segments: 6 })
    )

    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
    expect(manager.list().map(({ status }) => status)).toEqual(['downloading', 'queued', 'queued'])

    manager.setMaxConcurrent(2)
    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
    expect(manager.list().find(({ id }) => id === upload.id)).toMatchObject({
      direction: 'upload',
      status: 'downloading',
      segments: 1
    })
    expect(manager.list().find(({ id }) => id === firstDownload.id)?.status).toBe('downloading')
    expect(manager.list().find(({ id }) => id === nextDownload.id)?.status).toBe('queued')
    expect(client.jobStop).not.toHaveBeenCalled()

    jobStatuses.set(1, { finished: true, success: true, error: '' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await flushMicrotasks()

    expect(manager.list().find(({ id }) => id === upload.id)?.status).toBe('completed')
    expect(manager.list().filter(({ status }) => status === 'downloading')).toHaveLength(2)
    expect(manager.list().find(({ id }) => id === nextDownload.id)?.status).toBe('downloading')
    expect(
      client.copyFileAsync.mock.calls.map(([input]) => ({
        srcRemote: input.srcRemote,
        segments: input.config.MultiThreadStreams
      }))
    ).toEqual([
      { srcRemote: 'upload.bin', segments: 1 },
      { srcRemote: 'first-download.bin', segments: 8 },
      { srcRemote: 'next-download.bin', segments: 6 }
    ])
  })

  it('leaves running jobs untouched and delays backfill after lowering the cap', async () => {
    const { manager, client, jobStatuses } = makeManager(3)
    const transfers = [2, 8, 6, 10].map((segments, index) =>
      manager.enqueue(enqueueInput({ srcRemote: `file-${index}.bin`, segments }))
    )

    await flushMicrotasks()
    manager.setMaxConcurrent(1)
    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(3)
    expect(client.jobStop).not.toHaveBeenCalled()
    expect(manager.list().map(({ status }) => status)).toEqual([
      'downloading',
      'downloading',
      'downloading',
      'queued'
    ])
    expect(manager.list().map(({ segments }) => segments)).toEqual([2, 8, 6, 10])

    for (const jobId of [1, 2]) {
      jobStatuses.set(jobId, { finished: true, success: true, error: '' })
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushMicrotasks()
      expect(client.copyFileAsync).toHaveBeenCalledTimes(3)
      expect(manager.list().find(({ id }) => id === transfers[3].id)?.status).toBe('queued')
    }

    jobStatuses.set(3, { finished: true, success: true, error: '' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await flushMicrotasks()

    expect(manager.list().find(({ id }) => id === transfers[3].id)?.status).toBe('downloading')
    expect(
      client.copyFileAsync.mock.calls.map(([input]) => ({
        srcRemote: input.srcRemote,
        segments: input.config.MultiThreadStreams
      }))
    ).toEqual([
      { srcRemote: 'file-0.bin', segments: 2 },
      { srcRemote: 'file-1.bin', segments: 8 },
      { srcRemote: 'file-2.bin', segments: 6 },
      { srcRemote: 'file-3.bin', segments: 10 }
    ])
    expect(client.jobStop).not.toHaveBeenCalled()
  })

  it('configures four segments for a queued 20-MiB request for eight', async () => {
    const { manager, client } = makeManager()
    manager.enqueue(enqueueInput({ segments: 2 }))
    const input = enqueueInput({
      srcRemote: 'small.bin',
      size: 20 * 1024 * 1024,
      segments: 8
    })
    const queued = manager.enqueue(input)

    await flushMicrotasks()
    expect(queued).toMatchObject({ status: 'queued', segments: 8 })
    expect(manager.list().find(({ id }) => id === queued.id)).toMatchObject({
      status: 'queued',
      segments: 8
    })

    manager.setMaxConcurrent(2)
    await flushMicrotasks()

    expect(client.copyFileAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        srcRemote: 'small.bin',
        config: {
          MultiThreadStreams: 4,
          MultiThreadCutoff: '1048576B',
          MultiThreadChunkSize: '5242880B'
        }
      })
    )
    expect(manager.list().find(({ id }) => id === queued.id)).toMatchObject({
      status: 'downloading',
      segments: 4
    })
    expect(input.segments).toBe(8)
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
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
