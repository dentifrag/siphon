import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CANCEL_SETTLE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  RcloneDownloadManager,
  type RcloneEnqueueInput
} from '../src/server/rclone/downloadManager'
import type { RcloneClient } from '../src/server/rclone/client'

// Pins the "Retry failed downloads" contract on RcloneDownloadManager: manager.retry(id, validate).

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (err: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
    cleanupRemote: '_dl-x',
    ...overrides
  }
}

function makeManager(maxConcurrent = 3) {
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
    jobStatus: vi.fn().mockImplementation(async (id: number) => ({ id, ...jobStatuses.get(id)! })),
    jobStop: vi.fn().mockResolvedValue(undefined),
    deleteRemote: vi.fn().mockResolvedValue(undefined)
  }
  const manager = new RcloneDownloadManager(client as unknown as RcloneClient)
  manager.setMaxConcurrent(maxConcurrent)
  return { manager, client, jobStatuses }
}

async function settleJob(
  jobStatuses: Map<number, { finished: boolean; success: boolean; error: string }>,
  jobId: number,
  outcome: { success: boolean; error: string }
): Promise<void> {
  jobStatuses.set(jobId, { finished: true, ...outcome })
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  await flushMicrotasks()
}

describe('RcloneDownloadManager.retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enqueues a fresh successor for a finished failed download, preserving the source reference, applying a refreshed size, linking retryOf/retriedAs, and releasing the shared cleanup remote exactly once overall', async () => {
    const { manager, client, jobStatuses } = makeManager(1)
    const origin = manager.enqueue(enqueueInput({ size: 100 }))
    await flushMicrotasks()
    await settleJob(jobStatuses, 1, { success: false, error: 'Connection reset.' })
    expect(manager.list().find((t) => t.id === origin.id)?.status).toBe('error')
    // An eligible (retryable) failure must keep its cloned remote alive, not release it on settle.
    expect(client.deleteRemote).not.toHaveBeenCalled()

    const validate = vi.fn(async (input: RcloneEnqueueInput) => ({ ...input, size: 250 }))
    const successor = await manager.retry(origin.id, validate)

    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({
        srcFs: 'dl:',
        srcRemote: 'file.bin',
        dstFs: '/out',
        dstRemote: 'file.bin',
        localPath: '/out/file.bin',
        direction: 'download',
        segments: 4
      })
    )
    expect(successor.id).not.toBe(origin.id)
    expect(successor.size).toBe(250)
    expect(successor.localPath).toBe('/out/file.bin')
    expect(successor.direction).toBe('download')
    expect(successor.retryOf).toBe(origin.id)

    const originAfter = manager.list().find((t) => t.id === origin.id)!
    expect(originAfter.retriedAs).toBe(successor.id)
    expect(Boolean(originAfter.retryable)).toBe(false)
    expect(originAfter.error).toBe('Connection reset.')
    expect(client.deleteRemote).not.toHaveBeenCalled()

    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
    expect(client.copyFileAsync.mock.calls[1][0]).toMatchObject({
      srcFs: 'dl:',
      srcRemote: 'file.bin',
      dstFs: '/out',
      dstRemote: 'file.bin'
    })

    // The successor inherits the lease without a double-increment; it releases exactly once,
    // only once the successor itself reaches a terminal state.
    await settleJob(jobStatuses, 2, { success: true, error: '' })
    expect(manager.list().find((t) => t.id === successor.id)?.status).toBe('completed')
    expect(client.deleteRemote).toHaveBeenCalledTimes(1)
    expect(client.deleteRemote).toHaveBeenCalledWith('_dl-x')
  })

  it('retains the original requested segment count through retry even though the initial download normalized to fewer effective streams, leaving the origin diagnostics untouched', async () => {
    const { manager, client, jobStatuses } = makeManager(1)
    const origin = manager.enqueue(enqueueInput({ size: 20 * 1024 * 1024, segments: 8 }))
    await flushMicrotasks()

    // 20MiB at 8 requested streams normalizes down to 4 effective streams (5MiB minimum chunk).
    const inFlight = manager.list().find((t) => t.id === origin.id)!
    expect(inFlight.segments).toBe(4)
    const originCall = client.copyFileAsync.mock.calls[0][0]
    expect(originCall.config.MultiThreadStreams).toBe(4)

    await settleJob(jobStatuses, 1, { success: false, error: 'Connection reset.' })
    expect(manager.list().find((t) => t.id === origin.id)?.error).toBe('Connection reset.')

    const validate = vi.fn(async (input: RcloneEnqueueInput) => ({
      ...input,
      size: 100 * 1024 * 1024
    }))
    const successor = await manager.retry(origin.id, validate)

    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ segments: 8 }))
    expect(successor.segments).toBe(8)
    expect(successor.transferred).toBe(0)
    expect(successor.error).toBeUndefined()
    expect(successor.id).not.toBe(origin.id)

    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
    const successorCall = client.copyFileAsync.mock.calls[1][0]
    // 100MiB at 8 requested streams needs all 8 effective streams: the planner uses the
    // original requested segment count, not the origin's normalized effective count.
    expect(successorCall.config.MultiThreadStreams).toBe(8)
    expect(successorCall.group).not.toBe(originCall.group)

    const originAfter = manager.list().find((t) => t.id === origin.id)!
    expect(originAfter.error).toBe('Connection reset.')
    expect(originAfter.segments).toBe(4)
  })

  it.each([{ trigger: 'clearFinished' as const }, { trigger: 'clearAll' as const }])(
    'aborts without enqueuing a successor when the origin is $trigger-removed while validation is pending, releasing the provisionally-held cleanup remote exactly once',
    async ({ trigger }) => {
      const { manager, client, jobStatuses } = makeManager(1)
      const origin = manager.enqueue(enqueueInput())
      await flushMicrotasks()
      await settleJob(jobStatuses, 1, { success: false, error: 'boom' })

      const gate = deferred<RcloneEnqueueInput>()
      const retryPromise = manager.retry(origin.id, () => gate.promise)

      if (trigger === 'clearFinished') manager.clearFinished()
      else manager.clearAll()

      expect(manager.list().find((t) => t.id === origin.id)).toBeUndefined()
      expect(client.deleteRemote).not.toHaveBeenCalled()

      gate.resolve(enqueueInput())
      await expect(retryPromise).rejects.toMatchObject({ statusCode: 404 })
      await flushMicrotasks()
      expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
      expect(client.deleteRemote).toHaveBeenCalledTimes(1)
      expect(client.deleteRemote).toHaveBeenCalledWith('_dl-x')
    }
  )

  it.each([
    { outcome: 'error' as const, direction: 'download' as const, eligible: true },
    { outcome: 'error' as const, direction: 'upload' as const, eligible: false },
    { outcome: 'canceled' as const, direction: 'download' as const, eligible: false },
    { outcome: 'completed' as const, direction: 'download' as const, eligible: false }
  ])(
    'marks a finished $direction that ends in $outcome retryable=$eligible, matching what retry() accepts',
    async ({ outcome, direction, eligible }) => {
      const { manager, jobStatuses } = makeManager(1)
      const target = manager.enqueue(enqueueInput({ direction }))
      await flushMicrotasks()
      if (outcome === 'canceled') manager.cancel(target.id)
      await settleJob(jobStatuses, 1, {
        success: outcome === 'completed',
        error: outcome === 'error' ? 'boom' : ''
      })

      const after = manager.list().find((t) => t.id === target.id)!
      expect(after.status).toBe(outcome)
      expect(Boolean(after.retryable)).toBe(eligible)

      if (eligible) {
        const successor = await manager.retry(target.id, async (input) => input)
        expect(successor.retryOf).toBe(target.id)
      } else {
        await expect(manager.retry(target.id, async (input) => input)).rejects.toThrow()
      }
    }
  )

  it('is not retryable while still queued behind another active transfer, and retry() rejects without starting it early', async () => {
    const { manager, client } = makeManager(1)
    manager.enqueue(enqueueInput({ localPath: '/out/blocker.bin', srcRemote: 'blocker.bin' }))
    const queued = manager.enqueue(
      enqueueInput({ localPath: '/out/queued.bin', srcRemote: 'queued.bin' })
    )
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === queued.id)?.status).toBe('queued')
    expect(Boolean(manager.list().find((t) => t.id === queued.id)?.retryable)).toBe(false)

    await expect(manager.retry(queued.id, async (input) => input)).rejects.toThrow()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
  })

  it('is not retryable while actively downloading', async () => {
    const { manager } = makeManager(1)
    const active = manager.enqueue(enqueueInput())
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === active.id)?.status).toBe('downloading')
    expect(Boolean(manager.list().find((t) => t.id === active.id)?.retryable)).toBe(false)

    await expect(manager.retry(active.id, async (input) => input)).rejects.toThrow()
  })

  it('rejects retry() for an unknown id without enqueuing anything', async () => {
    const { manager, client } = makeManager(1)
    await expect(manager.retry('missing-id', async (input) => input)).rejects.toThrow()
    expect(client.copyFileAsync).not.toHaveBeenCalled()
  })

  it('shares one validation/admission promise across concurrent retry() calls for the same origin, producing exactly one successor', async () => {
    const { manager, client, jobStatuses } = makeManager(1)
    const origin = manager.enqueue(enqueueInput())
    await flushMicrotasks()
    await settleJob(jobStatuses, 1, { success: false, error: 'boom' })

    const gate = deferred<RcloneEnqueueInput>()
    const validate = vi.fn().mockReturnValue(gate.promise)

    const first = manager.retry(origin.id, validate)
    const second = manager.retry(origin.id, validate)
    await flushMicrotasks()
    expect(validate).toHaveBeenCalledTimes(1)

    gate.resolve(enqueueInput())
    const [a, b] = await Promise.all([first, second])
    expect(a.id).toBe(b.id)
    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
  })

  it('is idempotent on repeat retry() calls once a successor exists, returning the same retained successor without revalidating or resubmitting', async () => {
    const { manager, client, jobStatuses } = makeManager(1)
    const origin = manager.enqueue(enqueueInput())
    await flushMicrotasks()
    await settleJob(jobStatuses, 1, { success: false, error: 'boom' })

    const first = await manager.retry(origin.id, async (input) => input)
    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)

    const validate2 = vi.fn(async (input: RcloneEnqueueInput) => input)
    const second = await manager.retry(origin.id, validate2)

    expect(second.id).toBe(first.id)
    expect(validate2).not.toHaveBeenCalled()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
  })

  it('rejects retry() as a conflict once the previously-created successor has since been removed', async () => {
    const { manager, client, jobStatuses } = makeManager(1)
    const origin = manager.enqueue(enqueueInput())
    await flushMicrotasks()
    await settleJob(jobStatuses, 1, { success: false, error: 'boom' })

    const successor = await manager.retry(origin.id, async (input) => input)
    await flushMicrotasks()
    await settleJob(jobStatuses, 2, { success: false, error: 'boom again' })
    expect(manager.remove(successor.id)).toBe(true)

    await expect(manager.retry(origin.id, async (input) => input)).rejects.toThrow()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
  })

  it('aborts without enqueuing a successor when the origin is removed while validation is pending, releasing the provisionally-held cleanup remote exactly once', async () => {
    const { manager, client, jobStatuses } = makeManager(1)
    const origin = manager.enqueue(enqueueInput())
    await flushMicrotasks()
    await settleJob(jobStatuses, 1, { success: false, error: 'boom' })

    const gate = deferred<RcloneEnqueueInput>()
    const retryPromise = manager.retry(origin.id, () => gate.promise)

    expect(manager.remove(origin.id)).toBe(true)
    expect(manager.list().find((t) => t.id === origin.id)).toBeUndefined()
    // The provisional lease taken before awaiting validate() must hold the shared remote alive
    // even though the origin row itself is already gone.
    expect(client.deleteRemote).not.toHaveBeenCalled()

    gate.resolve(enqueueInput())
    await expect(retryPromise).rejects.toThrow()
    await flushMicrotasks()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
    expect(client.deleteRemote).toHaveBeenCalledTimes(1)
    expect(client.deleteRemote).toHaveBeenCalledWith('_dl-x')
  })

  it('preserves the original error and keeps the origin retryable when validate() rejects', async () => {
    const { manager, client, jobStatuses } = makeManager(1)
    const origin = manager.enqueue(enqueueInput())
    await flushMicrotasks()
    await settleJob(jobStatuses, 1, { success: false, error: 'Connection reset.' })

    await expect(
      manager.retry(origin.id, async () => {
        throw new Error('Source file no longer available.')
      })
    ).rejects.toThrow('Source file no longer available.')

    const after = manager.list().find((t) => t.id === origin.id)!
    expect(after.error).toBe('Connection reset.')
    expect(Boolean(after.retryable)).toBe(true)
    expect(after.retriedAs).toBeUndefined()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
  })
})

describe('RcloneDownloadManager destination-key serialization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serializes two downloads sharing the same destination, giving the blocked one an explicit waitingReason until the first vacates the key, without blocking an unrelated destination', async () => {
    const { manager, client, jobStatuses } = makeManager(4)
    const first = manager.enqueue(
      enqueueInput({ localPath: '/out/same.bin', srcRemote: 'same-a.bin' })
    )
    const second = manager.enqueue(
      enqueueInput({ localPath: '/out/same.bin', srcRemote: 'same-b.bin' })
    )
    const unrelated = manager.enqueue(
      enqueueInput({ localPath: '/out/other.bin', srcRemote: 'other.bin' })
    )

    await flushMicrotasks()

    expect(manager.list().find((t) => t.id === first.id)?.status).toBe('downloading')
    expect(manager.list().find((t) => t.id === unrelated.id)?.status).toBe('downloading')
    const blocked = manager.list().find((t) => t.id === second.id)!
    expect(blocked.status).toBe('queued')
    expect(typeof blocked.waitingReason).toBe('string')
    expect((blocked.waitingReason ?? '').length).toBeGreaterThan(0)
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)

    await settleJob(jobStatuses, 1, { success: true, error: '' })

    const started = manager.list().find((t) => t.id === second.id)!
    expect(started.status).toBe('downloading')
    expect(started.waitingReason).toBeUndefined()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(3)
  })

  it("clears a same-key waiter's stale waiting-for-file reason once its key frees, even though it stays queued behind a full concurrency cap because an earlier unrelated waiter claims the freed slot first", async () => {
    const { manager, client, jobStatuses } = makeManager(2)
    const owner = manager.enqueue(
      enqueueInput({ localPath: '/out/cap-key.bin', srcRemote: 'owner.bin' })
    )
    const occupant = manager.enqueue(
      enqueueInput({ localPath: '/out/cap-occupant.bin', srcRemote: 'occupant.bin' })
    )
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === owner.id)?.status).toBe('downloading')
    expect(manager.list().find((t) => t.id === occupant.id)?.status).toBe('downloading')

    const earlierWaiter = manager.enqueue(
      enqueueInput({ localPath: '/out/cap-earlier.bin', srcRemote: 'earlier.bin' })
    )
    const sameKeyWaiter = manager.enqueue(
      enqueueInput({ localPath: '/out/cap-key.bin', srcRemote: 'waiter.bin' })
    )
    await flushMicrotasks()

    const earlierBefore = manager.list().find((t) => t.id === earlierWaiter.id)!
    const sameKeyBefore = manager.list().find((t) => t.id === sameKeyWaiter.id)!
    expect(earlierBefore.status).toBe('queued')
    expect(earlierBefore.waitingReason).toBeUndefined()
    expect(sameKeyBefore.status).toBe('queued')
    expect(sameKeyBefore.waitingReason).toMatch(/waiting/i)

    await settleJob(jobStatuses, 1, { success: true, error: '' })

    // The earlier-queued unrelated waiter claims the single freed slot (FIFO), so the
    // same-key waiter stays queued -- but now purely for cap, since its key is free again.
    const earlierAfter = manager.list().find((t) => t.id === earlierWaiter.id)!
    const sameKeyAfter = manager.list().find((t) => t.id === sameKeyWaiter.id)!
    expect(earlierAfter.status).toBe('downloading')
    expect(sameKeyAfter.status).toBe('queued')
    expect(sameKeyAfter.waitingReason).toBeUndefined()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(3)
  })

  it('does not gate an upload by destination key, letting it share the same concurrency pool and start independently alongside an active download to the same local path', async () => {
    const { manager, client } = makeManager(2)
    const download = manager.enqueue(
      enqueueInput({ localPath: '/out/shared.bin', srcRemote: 'down.bin' })
    )
    const upload = manager.enqueue(
      enqueueInput({ localPath: '/out/shared.bin', srcRemote: 'up.bin', direction: 'upload' })
    )
    await flushMicrotasks()

    expect(manager.list().find((t) => t.id === download.id)?.status).toBe('downloading')
    const uploadAfter = manager.list().find((t) => t.id === upload.id)!
    expect(uploadAfter.status).toBe('downloading')
    expect(uploadAfter.waitingReason).toBeUndefined()
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
  })
})

describe('RcloneDownloadManager destination quarantine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('quarantines a destination after a watchdog force-settles a cancel while its copy submission was still uncertain, rejecting new submissions to that key even after clearAll', async () => {
    const copyGate = deferred<number>()
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockReturnValue(copyGate.promise),
      jobStatus: vi.fn(),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn().mockResolvedValue(undefined)
    } as unknown as RcloneClient
    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)

    const stuck = manager.enqueue(enqueueInput({ localPath: '/out/risky.bin' }))
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === stuck.id)?.status).toBe('downloading')

    manager.cancel(stuck.id)
    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS + POLL_INTERVAL_MS)
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === stuck.id)?.status).toBe('canceled')

    const after = manager.enqueue(
      enqueueInput({ localPath: '/out/risky.bin', srcRemote: 'retry.bin' })
    )
    await flushMicrotasks()
    const afterStatus = manager.list().find((t) => t.id === after.id)!
    expect(afterStatus.status).toBe('error')
    expect(Boolean(afterStatus.retryable)).toBe(false)
    expect(afterStatus.error).toMatch(/rclone/i)
    expect(afterStatus.error).toMatch(/restart/i)
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)

    manager.clearAll()
    const stillQuarantined = manager.enqueue(
      enqueueInput({ localPath: '/out/risky.bin', srcRemote: 'retry-2.bin' })
    )
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === stillQuarantined.id)?.status).toBe('error')
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)

    copyGate.resolve(1)
  })

  it('does not quarantine the destination when a cap-queued (never submitted) download is canceled', async () => {
    const { manager, client } = makeManager(1)
    manager.enqueue(enqueueInput({ localPath: '/out/blocker.bin', srcRemote: 'blocker.bin' }))
    const queued = manager.enqueue(
      enqueueInput({ localPath: '/out/safe.bin', srcRemote: 'safe-a.bin' })
    )
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === queued.id)?.status).toBe('queued')

    manager.cancel(queued.id)
    expect(manager.list().find((t) => t.id === queued.id)?.status).toBe('canceled')
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)

    manager.setMaxConcurrent(2)
    const reused = manager.enqueue(
      enqueueInput({ localPath: '/out/safe.bin', srcRemote: 'safe-b.bin' })
    )
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === reused.id)?.status).toBe('downloading')
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
  })
})

describe('RcloneDownloadManager uncertain-submission races', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    {
      name: 'cancel is followed by the coreStatsDelete reset finally resolving',
      settle: 'manual' as const
    },
    {
      name: 'the watchdog force-settles while the reset is still pending',
      settle: 'watchdog' as const
    }
  ])(
    'never submits a copy when canceled while the pre-submit coreStatsDelete reset is pending ($name), leaving the destination reusable',
    async ({ settle }) => {
      const resetGate = deferred<void>()
      const client = {
        coreStatsDelete: vi.fn().mockReturnValue(resetGate.promise),
        coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
        copyFileAsync: vi.fn().mockResolvedValue(1),
        jobStatus: vi.fn(),
        jobStop: vi.fn().mockResolvedValue(undefined),
        deleteRemote: vi.fn().mockResolvedValue(undefined)
      } as unknown as RcloneClient
      const manager = new RcloneDownloadManager(client)
      manager.setMaxConcurrent(1)

      const t = manager.enqueue(enqueueInput({ localPath: '/out/reset-race.bin' }))
      await flushMicrotasks()
      expect(client.coreStatsDelete).toHaveBeenCalledTimes(1)

      manager.cancel(t.id)

      if (settle === 'watchdog') {
        await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS + POLL_INTERVAL_MS)
        await flushMicrotasks()
      }
      resetGate.resolve()
      await flushMicrotasks()

      expect(manager.list().find((x) => x.id === t.id)?.status).toBe('canceled')
      expect(client.copyFileAsync).not.toHaveBeenCalled()

      const reused = manager.enqueue(
        enqueueInput({ localPath: '/out/reset-race.bin', srcRemote: 'reused.bin' })
      )
      await flushMicrotasks()
      expect(manager.list().find((x) => x.id === reused.id)?.status).toBe('downloading')
      expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
    }
  )

  it('quarantines the destination and fails a queued same-key sibling before any further pump when cancel arrives while the copy submission is still pending and it later resolves with a known job id, leaving an unrelated destination unaffected (distinct from the watchdog-timeout path)', async () => {
    const copyGate = deferred<number>()
    let callCount = 0
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockImplementation(() => {
        callCount += 1
        return callCount === 1 ? copyGate.promise : Promise.resolve(callCount + 100)
      }),
      jobStatus: vi.fn(),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn().mockResolvedValue(undefined)
    } as unknown as RcloneClient
    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(2)

    const stuck = manager.enqueue(
      enqueueInput({ localPath: '/out/known-race.bin', srcRemote: 'a.bin' })
    )
    const sibling = manager.enqueue(
      enqueueInput({ localPath: '/out/known-race.bin', srcRemote: 'b.bin' })
    )
    const unrelated = manager.enqueue(
      enqueueInput({ localPath: '/out/other-known.bin', srcRemote: 'c.bin' })
    )
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === stuck.id)?.status).toBe('downloading')
    expect(manager.list().find((t) => t.id === sibling.id)?.status).toBe('queued')
    expect(manager.list().find((t) => t.id === unrelated.id)?.status).toBe('downloading')

    // No watchdog timer advance here: cancel arrives while submission is uncertain, and the
    // copy promise settles with a known job id before any CANCEL_SETTLE_TIMEOUT_MS elapses.
    manager.cancel(stuck.id)
    copyGate.resolve(77)
    await flushMicrotasks()

    expect(manager.list().find((t) => t.id === stuck.id)?.status).toBe('canceled')
    expect(client.jobStop).toHaveBeenCalledTimes(1)
    expect(client.jobStop).toHaveBeenCalledWith(77)

    const siblingAfter = manager.list().find((t) => t.id === sibling.id)!
    expect(siblingAfter.status).toBe('error')
    expect(Boolean(siblingAfter.retryable)).toBe(false)
    expect(siblingAfter.error).toMatch(/rclone/i)
    // Only the two originally-submitted copies (stuck, unrelated) ever ran; the quarantined
    // sibling never got a chance to submit its own copy to the same target.
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)

    expect(manager.list().find((t) => t.id === unrelated.id)?.status).toBe('downloading')
  })

  it.each([{ outcome: 'resolve' as const }, { outcome: 'reject' as const }])(
    'a late copy $outcome arriving after a watchdog has already force-settled a cancel does not re-settle or restart the same-key queued task, which is already failed as a nonretryable quarantine error',
    async ({ outcome }) => {
      const copyGate = deferred<number>()
      let callCount = 0
      const client = {
        coreStatsDelete: vi.fn().mockResolvedValue(undefined),
        coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
        copyFileAsync: vi.fn().mockImplementation(() => {
          callCount += 1
          return callCount === 1 ? copyGate.promise : Promise.resolve(99)
        }),
        jobStatus: vi.fn(),
        jobStop: vi.fn().mockResolvedValue(undefined),
        deleteRemote: vi.fn().mockResolvedValue(undefined)
      } as unknown as RcloneClient
      const manager = new RcloneDownloadManager(client)
      manager.setMaxConcurrent(2)

      const stuck = manager.enqueue(
        enqueueInput({ localPath: '/out/race.bin', srcRemote: 'a.bin' })
      )
      const blocked = manager.enqueue(
        enqueueInput({ localPath: '/out/race.bin', srcRemote: 'b.bin' })
      )
      await flushMicrotasks()
      expect(manager.list().find((t) => t.id === stuck.id)?.status).toBe('downloading')
      expect(manager.list().find((t) => t.id === blocked.id)?.status).toBe('queued')

      manager.cancel(stuck.id)
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS + POLL_INTERVAL_MS)
      await flushMicrotasks()

      expect(manager.list().find((t) => t.id === stuck.id)?.status).toBe('canceled')
      // Quarantine must be in place, and any already-queued same-key task explicitly failed,
      // before the stale submission is even allowed to settle.
      const blockedAfterWatchdog = manager.list().find((t) => t.id === blocked.id)!
      expect(blockedAfterWatchdog.status).toBe('error')
      expect(Boolean(blockedAfterWatchdog.retryable)).toBe(false)
      expect(blockedAfterWatchdog.error).toMatch(/rclone/i)
      expect(client.copyFileAsync).toHaveBeenCalledTimes(1)

      const onUpdate = vi.fn()
      manager.onUpdate(onUpdate)

      if (outcome === 'resolve') copyGate.resolve(55)
      else copyGate.reject(new Error('late network failure'))
      await flushMicrotasks()

      expect(manager.list().find((t) => t.id === stuck.id)?.status).toBe('canceled')
      expect(manager.list().find((t) => t.id === blocked.id)?.status).toBe('error')
      expect(onUpdate).not.toHaveBeenCalled()
      expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
    }
  )

  it('quarantines the destination when the initial copy submission itself rejects, surviving remove/clearAll while an unrelated destination still runs', async () => {
    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockImplementation(async () => 1),
      jobStatus: vi.fn().mockResolvedValue({ finished: false, success: false, error: '', id: 1 }),
      jobStop: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn().mockResolvedValue(undefined)
    } as unknown as RcloneClient
    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(2)

    const failed = manager.enqueue(enqueueInput({ localPath: '/out/submit-fail.bin' }))
    await flushMicrotasks()

    const after = manager.list().find((t) => t.id === failed.id)!
    expect(after.status).toBe('error')
    expect(Boolean(after.retryable)).toBe(false)
    expect(after.error).toMatch(/rclone/i)

    manager.remove(failed.id)
    manager.clearAll()

    const retried = manager.enqueue(
      enqueueInput({ localPath: '/out/submit-fail.bin', srcRemote: 'again.bin' })
    )
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === retried.id)?.status).toBe('error')
    expect(client.copyFileAsync).toHaveBeenCalledTimes(1)

    const unrelated = manager.enqueue(
      enqueueInput({ localPath: '/out/other-ok.bin', srcRemote: 'ok.bin' })
    )
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === unrelated.id)?.status).toBe('downloading')
    expect(client.copyFileAsync).toHaveBeenCalledTimes(2)
  })

  it('rejects the retry commit when a competing download claims the same destination key while validation was pending', async () => {
    const { manager, jobStatuses } = makeManager(2)
    const origin = manager.enqueue(enqueueInput({ localPath: '/out/race-commit.bin' }))
    await flushMicrotasks()
    await settleJob(jobStatuses, 1, { success: false, error: 'boom' })

    const gate = deferred<RcloneEnqueueInput>()
    const retryPromise = manager.retry(origin.id, () => gate.promise)

    const intruder = manager.enqueue(
      enqueueInput({ localPath: '/out/race-commit.bin', srcRemote: 'intruder.bin' })
    )
    await flushMicrotasks()
    expect(manager.list().find((t) => t.id === intruder.id)?.status).toBe('downloading')

    gate.resolve(enqueueInput({ localPath: '/out/race-commit.bin' }))
    await expect(retryPromise).rejects.toThrow()
    await flushMicrotasks()

    expect(manager.list().filter((t) => t.retryOf === origin.id)).toHaveLength(0)
    expect(manager.list().find((t) => t.id === intruder.id)?.status).toBe('downloading')
  })
})
