import { dirname, join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDownloadRoutes } from '../src/server/routes/downloads'
import {
  POLL_INTERVAL_MS,
  RcloneDownloadManager,
  type RcloneEnqueueInput
} from '../src/server/rclone/downloadManager'
import { validateDownloadDestination } from '../src/server/localFs'
import type { RcloneClient } from '../src/server/rclone/client'
import type { RouteContext } from '../src/server/context'
import type { ServerConfig } from '../src/server/config'
import type { Services } from '../src/server/services'
import type { TransferProgress } from '../src/shared/types'

// Pins the real HTTP contract for POST /api/download/:id/retry.
// Route-registration + injection mirrors test/transferIdentity.test.ts's buildApp() pattern.

const resolvePathMock = vi.fn()

vi.mock('../src/server/downloadPublication', () => ({
  assertDestination: vi.fn(async () => undefined),
  snapshotDestination: vi.fn(async () => ({ kind: 'absent' })),
  createDownloadStage: vi.fn(async (path: string) => ({ directory: dirname(path), path })),
  publishDownload: vi.fn(async () => true),
  cleanupDownloadStage: vi.fn(async () => undefined)
}))

vi.mock('../src/server/localFs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/localFs')>()
  return { ...actual, resolvePath: (...args: unknown[]) => resolvePathMock(...args) }
})

beforeEach(() => {
  vi.useFakeTimers()
  resolvePathMock.mockReset()
  resolvePathMock.mockImplementation(async (_scope: unknown, candidate: string) => candidate)
})

afterEach(() => {
  vi.useRealTimers()
})

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function enqueueInput(overrides: Partial<RcloneEnqueueInput> = {}): RcloneEnqueueInput {
  return {
    srcFs: '_dl-abc:',
    srcRemote: 'file.bin',
    dstFs: '/out',
    dstRemote: 'file.bin',
    displayName: '/file.bin',
    localPath: '/out/file.bin',
    size: 100,
    segments: 4,
    cleanupRemote: '_dl-abc',
    ...overrides
  }
}

function makeClient(overrides: Partial<RcloneClient> = {}) {
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
    deleteRemote: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({
      Path: 'file.bin',
      Name: 'file.bin',
      Size: 250,
      ModTime: '',
      IsDir: false
    }),
    ...overrides
  }
  return { client: client as unknown as RcloneClient, jobStatuses }
}

function buildApp(client: RcloneClient, manager: RcloneDownloadManager, session?: unknown) {
  const app = Fastify()
  const config = {
    roots: [],
    defaultDir: '/out',
    confined: false,
    dataDir: '/data'
  } as unknown as ServerConfig
  const ctx = {
    config,
    auth: {} as unknown,
    limiter: {} as unknown,
    services: { supervisor: {} as unknown, client, manager, remotes: {} as unknown } as Services,
    session: (session ?? {}) as unknown,
    execDir: ''
  } as unknown as RouteContext
  registerDownloadRoutes(app, ctx)
  return app
}

// Minimal stand-in for ConnectionSession.bind/acquireJobRemote, per the real route's needs --
// not the full session class, just the two methods /api/download actually calls.
function makeStubSession(revision = 'rev-1') {
  let counter = 0
  return {
    bind: vi.fn(() => ({ remoteName: 'conn', revision, fs: 'conn:' })),
    acquireJobRemote: vi.fn(async (prefix: string) => {
      counter += 1
      const remoteName = `${prefix}job${counter}`
      return {
        remoteName,
        revision,
        fs: `${remoteName}:`,
        release: vi.fn().mockResolvedValue(undefined)
      }
    })
  }
}

async function failOrigin(
  manager: RcloneDownloadManager,
  jobStatuses: Map<number, { finished: boolean; success: boolean; error: string }>,
  overrides: Partial<RcloneEnqueueInput> = {}
): Promise<TransferProgress> {
  const origin = manager.enqueue(enqueueInput(overrides))
  await flushMicrotasks()
  jobStatuses.set(1, { finished: true, success: false, error: 'Connection reset.' })
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  await flushMicrotasks()
  return origin
}

describe('POST /api/download/:id/retry', () => {
  it('revalidates the current source size via client.stat and returns a fresh successor transfer linked to the origin', async () => {
    const { client, jobStatuses } = makeClient()
    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)
    const app = buildApp(client, manager)
    try {
      const origin = await failOrigin(manager, jobStatuses, { size: 100 })

      const response = await app.inject({
        method: 'POST',
        url: `/api/download/${origin.id}/retry`
      })

      expect(response.statusCode).toBe(200)
      const body = response.json() as TransferProgress & { retryOf?: string }
      expect(body.id).not.toBe(origin.id)
      expect(body.retryOf).toBe(origin.id)
      expect(body.size).toBe(250)
      expect(vi.mocked(client.stat)).toHaveBeenCalledWith('_dl-abc:', 'file.bin')
    } finally {
      await app.close()
    }
  })

  it('returns 404 for an unknown transfer id', async () => {
    const { client } = makeClient()
    const manager = new RcloneDownloadManager(client)
    const app = buildApp(client, manager)
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/download/does-not-exist/retry'
      })
      expect(response.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('returns 404 and leaves the origin retryable when the source file is no longer present', async () => {
    const { client, jobStatuses } = makeClient({ stat: vi.fn().mockResolvedValue(null) })
    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)
    const app = buildApp(client, manager)
    try {
      const origin = await failOrigin(manager, jobStatuses)

      const response = await app.inject({
        method: 'POST',
        url: `/api/download/${origin.id}/retry`
      })
      expect(response.statusCode).toBe(404)

      const after = manager.list().find((t) => t.id === origin.id)!
      expect(Boolean(after.retryable)).toBe(true)
      expect(after.error).toBe('Connection reset.')
    } finally {
      await app.close()
    }
  })

  const ineligibleCases: Array<{
    name: string
    build: (
      manager: RcloneDownloadManager,
      jobStatuses: Map<number, { finished: boolean; success: boolean; error: string }>
    ) => Promise<string>
  }> = [
    {
      name: 'still queued',
      build: async (manager) => {
        manager.setMaxConcurrent(1)
        manager.enqueue(enqueueInput({ localPath: '/out/blocker.bin', srcRemote: 'blocker.bin' }))
        const queued = manager.enqueue(
          enqueueInput({ localPath: '/out/queued.bin', srcRemote: 'queued.bin' })
        )
        await flushMicrotasks()
        return queued.id
      }
    },
    {
      name: 'actively downloading',
      build: async (manager) => {
        const active = manager.enqueue(enqueueInput())
        await flushMicrotasks()
        return active.id
      }
    },
    {
      name: 'completed',
      build: async (manager, jobStatuses) => {
        manager.setMaxConcurrent(1)
        const t = manager.enqueue(enqueueInput())
        await flushMicrotasks()
        jobStatuses.set(1, { finished: true, success: true, error: '' })
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushMicrotasks()
        return t.id
      }
    },
    {
      name: 'canceled',
      build: async (manager, jobStatuses) => {
        manager.setMaxConcurrent(1)
        const t = manager.enqueue(enqueueInput())
        await flushMicrotasks()
        manager.cancel(t.id)
        jobStatuses.set(1, { finished: true, success: false, error: '' })
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushMicrotasks()
        return t.id
      }
    },
    {
      name: 'a failed upload',
      build: async (manager, jobStatuses) => {
        manager.setMaxConcurrent(1)
        const t = manager.enqueue(enqueueInput({ direction: 'upload' }))
        await flushMicrotasks()
        jobStatuses.set(1, { finished: true, success: false, error: 'Upload failed.' })
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushMicrotasks()
        return t.id
      }
    }
  ]

  it.each(ineligibleCases)('returns 409 for a transfer that is $name', async ({ build }) => {
    const { client, jobStatuses } = makeClient()
    const manager = new RcloneDownloadManager(client)
    const app = buildApp(client, manager)
    try {
      const id = await build(manager, jobStatuses)
      const response = await app.inject({ method: 'POST', url: `/api/download/${id}/retry` })
      expect(response.statusCode).toBe(409)
      expect(vi.mocked(client.stat)).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('does not start a successor when the destination path cannot be resolved', async () => {
    const { client, jobStatuses } = makeClient()
    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)
    const app = buildApp(client, manager)
    try {
      const origin = await failOrigin(manager, jobStatuses)
      resolvePathMock.mockResolvedValueOnce(null)

      const response = await app.inject({
        method: 'POST',
        url: `/api/download/${origin.id}/retry`
      })
      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      expect(manager.list().filter((t) => t.retryOf === origin.id)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  it('returns the same retained successor on a repeat retry request, without revalidating or resubmitting', async () => {
    const { client, jobStatuses } = makeClient()
    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)
    const app = buildApp(client, manager)
    try {
      const origin = await failOrigin(manager, jobStatuses)

      const first = await app.inject({
        method: 'POST',
        url: `/api/download/${origin.id}/retry`
      })
      expect(first.statusCode).toBe(200)
      const firstBody = first.json() as TransferProgress & { retryOf?: string }
      expect(vi.mocked(client.stat)).toHaveBeenCalledTimes(1)

      const second = await app.inject({
        method: 'POST',
        url: `/api/download/${origin.id}/retry`
      })
      expect(second.statusCode).toBe(200)
      const secondBody = second.json() as TransferProgress & { retryOf?: string }
      expect(secondBody.id).toBe(firstBody.id)
      // No revalidation and no second submission on the idempotent repeat.
      expect(vi.mocked(client.stat)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(client.copyFileAsync)).toHaveBeenCalledTimes(2)
      expect(manager.list().filter((t) => t.retryOf === origin.id)).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('returns 409 when retried again after the previously-created successor has since been removed', async () => {
    const { client, jobStatuses } = makeClient()
    const manager = new RcloneDownloadManager(client)
    manager.setMaxConcurrent(1)
    const app = buildApp(client, manager)
    try {
      const origin = await failOrigin(manager, jobStatuses)

      const first = await app.inject({
        method: 'POST',
        url: `/api/download/${origin.id}/retry`
      })
      expect(first.statusCode).toBe(200)
      const successorId = (first.json() as { id: string }).id

      jobStatuses.set(2, { finished: true, success: false, error: 'boom again' })
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushMicrotasks()
      expect(manager.remove(successorId)).toBe(true)

      const second = await app.inject({
        method: 'POST',
        url: `/api/download/${origin.id}/retry`
      })
      expect(second.statusCode).toBe(409)
    } finally {
      await app.close()
    }
  })
})

describe('POST /api/download canonical destination identity', () => {
  // This flow has no retry-watchdog timers to drive; real timers avoid any interaction
  // between fake timers and Fastify's own inject() internals.
  beforeEach(() => {
    vi.useRealTimers()
  })

  // Settles the one active transfer (and synchronously drops any still-queued one) so the
  // manager's real setInterval ticker stops before the test ends, instead of leaking a live
  // timer into later tests.
  async function settleAndStopTicker(
    manager: RcloneDownloadManager,
    jobStatuses: Map<number, { finished: boolean; success: boolean; error: string }>
  ): Promise<void> {
    jobStatuses.set(1, { finished: true, success: false, error: '' })
    manager.cancelAll()
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS + 100))
  }

  it('revalidates the canonical sink via the real validateDownloadDestination callback at dispatch time, not only during initial enqueue, when the default directory and an explicit alias collide', async () => {
    const { client, jobStatuses } = makeClient()
    // Only resolvePath is mocked at the boundary; validateDownloadDestination itself is the
    // real production function, and it is wired into the manager's constructor exactly like
    // src/server/services.ts does, so runJob()'s mid-flight revalidation genuinely executes.
    const validateDestination = vi.fn((input: RcloneEnqueueInput) =>
      validateDownloadDestination({ roots: [], confined: false }, input, resolvePathMock)
    )
    const manager = new RcloneDownloadManager(client, validateDestination)
    manager.setMaxConcurrent(2)
    const session = makeStubSession()
    const app = buildApp(client, manager, session)
    try {
      resolvePathMock.mockImplementation(async (_scope: unknown, candidate: string) => {
        if (candidate === '/out' || candidate === '/out/alias') return '/canonical/out'
        return candidate
      })

      // Omits downloadDir entirely so the route genuinely falls through to config.defaultDir
      // ('/out'), rather than re-asserting an explicit '/out' that never exercises the default.
      const first = await app.inject({
        method: 'POST',
        url: '/api/download',
        payload: { remotePath: '/file.bin', segments: 4 }
      })
      expect(first.statusCode).toBe(200)

      const second = await app.inject({
        method: 'POST',
        url: '/api/download',
        payload: { remotePath: '/file.bin', downloadDir: '/out/alias', segments: 4 }
      })
      expect(second.statusCode).toBe(200)

      await flushMicrotasks()
      const all = manager.list()
      expect(all.filter((t) => t.status === 'downloading')).toHaveLength(1)
      const queued = all.filter((t) => t.status === 'queued')
      expect(queued).toHaveLength(1)
      expect(typeof queued[0].waitingReason).toBe('string')
      expect(client.copyFileAsync).toHaveBeenCalledTimes(1)

      // Canonicalization genuinely ran for the SINK path of both the default and the aliased
      // request (not just the route's own directory-level resolution).
      const sinkCandidate = join('/canonical/out', 'file.bin')
      expect(resolvePathMock.mock.calls.some(([, candidate]) => candidate === sinkCandidate)).toBe(
        true
      )
      expect(resolvePathMock).toHaveBeenCalledWith(expect.anything(), '/out')
      expect(resolvePathMock).toHaveBeenCalledWith(expect.anything(), '/out/alias')

      // Proves dispatch-time revalidation actually ran: validateDestination is only invoked
      // from inside runJob() once a transfer starts, so this is distinct from -- and could not
      // be satisfied by -- the initial /api/download route handler's own resolvePath calls.
      expect(validateDestination).toHaveBeenCalledTimes(1)

      await settleAndStopTicker(manager, jobStatuses)
    } finally {
      await app.close()
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'treats two case-differing but otherwise identical resolved paths as the same destination on Windows, via the real validateDownloadDestination callback',
    async () => {
      const { client, jobStatuses } = makeClient()
      const validateDestination = vi.fn((input: RcloneEnqueueInput) =>
        validateDownloadDestination({ roots: [], confined: false }, input, resolvePathMock)
      )
      const manager = new RcloneDownloadManager(client, validateDestination)
      manager.setMaxConcurrent(2)
      const session = makeStubSession()
      const app = buildApp(client, manager, session)
      try {
        resolvePathMock.mockImplementation(async (_scope: unknown, candidate: string) => {
          if (candidate === '/out') return 'C:\\data\\Out'
          if (candidate === '/OUT') return 'C:\\DATA\\OUT'
          return candidate
        })

        const first = await app.inject({
          method: 'POST',
          url: '/api/download',
          payload: { remotePath: '/file.bin', downloadDir: '/out', segments: 4 }
        })
        expect(first.statusCode).toBe(200)

        const second = await app.inject({
          method: 'POST',
          url: '/api/download',
          payload: { remotePath: '/file.bin', downloadDir: '/OUT', segments: 4 }
        })
        expect(second.statusCode).toBe(200)

        await flushMicrotasks()
        const all = manager.list()
        expect(all.filter((t) => t.status === 'downloading')).toHaveLength(1)
        expect(all.filter((t) => t.status === 'queued')).toHaveLength(1)
        expect(client.copyFileAsync).toHaveBeenCalledTimes(1)
        expect(validateDestination).toHaveBeenCalledTimes(1)

        await settleAndStopTicker(manager, jobStatuses)
      } finally {
        await app.close()
      }
    }
  )
})
