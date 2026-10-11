import Fastify from 'fastify'
import { join } from 'node:path'
import type { Response as InjectResponse } from 'light-my-request'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerBrowseRoutes } from '../src/server/routes/browse'
import { registerConnectionRoutes } from '../src/server/routes/connection'
import { registerDownloadRoutes } from '../src/server/routes/downloads'
import { registerUploadRoutes } from '../src/server/routes/uploads'
import { ConnectionSession } from '../src/server/session'
import type { RouteContext } from '../src/server/context'
import type { ServerConfig } from '../src/server/config'
import type { Services } from '../src/server/services'
import { RcloneClient, type RcloneListEntry } from '../src/server/rclone/client'
import type {
  RcloneDownloadManager,
  RcloneEnqueueInput
} from '../src/server/rclone/downloadManager'
import type { RemoteStore } from '../src/server/rclone/remotes'
import type { TransferProgress } from '../src/shared/types'

// Real localFs/fs-promises access is mocked out everywhere below: no root
// writes, no real stat/resolve calls ever touch disk.
const resolvePathMock = vi.fn()
const fsStatMock = vi.fn()

vi.mock('../src/server/localFs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/localFs')>()
  return { ...actual, resolvePath: (...args: unknown[]) => resolvePathMock(...args) }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: (...args: unknown[]) => fsStatMock(...args) }
})

beforeEach(() => {
  resolvePathMock.mockReset()
  resolvePathMock.mockImplementation(async (_scope: unknown, candidate: string) => candidate)
  fsStatMock.mockReset()
})

/** A deferred promise the test can resolve/reject on its own schedule, used to
 * force a real await point inside the route handler so a mid-request
 * reconnect (or disconnect) can be driven deterministically, without sleeps. */
function createGate<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeRemotes(nameFor: Record<string, string>): RemoteStore {
  return {
    remoteNameFor: vi.fn(async (id: string) => nameFor[id] ?? null)
  } as unknown as RemoteStore
}

function makeManager(): RcloneDownloadManager {
  let counter = 0
  const enqueue = vi.fn((input: RcloneEnqueueInput): TransferProgress => {
    counter += 1
    return {
      id: `t-${counter}`,
      remotePath: input.displayName,
      localPath: input.localPath,
      size: input.size,
      transferred: 0,
      speedBytesPerSec: 0,
      activeSegments: 0,
      segments: input.segments,
      status: 'queued',
      direction: input.direction
    }
  })
  return {
    enqueue,
    list: vi.fn(() => []),
    onUpdate: vi.fn(() => () => undefined),
    onRemove: vi.fn(() => () => undefined)
  } as unknown as RcloneDownloadManager
}

function makeConfig(): ServerConfig {
  return {
    roots: [],
    defaultDir: '/out',
    confined: false,
    dataDir: '/data'
  } as unknown as ServerConfig
}

function buildApp(
  session: ConnectionSession,
  client: RcloneClient,
  manager: RcloneDownloadManager,
  config: ServerConfig
) {
  const app = Fastify()
  const ctx = {
    config,
    auth: {} as unknown,
    limiter: {} as unknown,
    services: { supervisor: {} as unknown, client, manager, remotes: {} as unknown } as Services,
    session,
    execDir: ''
  } as unknown as RouteContext
  registerConnectionRoutes(app, ctx)
  registerBrowseRoutes(app, ctx)
  registerDownloadRoutes(app, ctx)
  registerUploadRoutes(app, ctx)
  return app
}

function contractFixture(overrides: Partial<RcloneClient> = {}) {
  const configs = new Map<string, Record<string, string>>([
    ['remoteA', { type: 'sftp', host: 'A' }],
    ['remoteB', { type: 'sftp', host: 'B' }]
  ])
  const client: RcloneClient = {
    checkConnection: vi.fn(async () => undefined),
    list: vi.fn(async () => [
      { Path: 'file.bin', Name: 'file.bin', Size: 42, ModTime: '', IsDir: false }
    ]),
    stat: vi.fn(async () => ({
      Path: 'file.bin',
      Name: 'file.bin',
      Size: 42,
      ModTime: '',
      IsDir: false
    })),
    createRemote: vi.fn(async (name: string, type: string, parameters: Record<string, string>) => {
      configs.set(name, { type, ...parameters })
    }),
    getRemote: vi.fn(async (name: string) => {
      const config = configs.get(name)
      if (!config) throw new Error('Remote missing.')
      return { ...config }
    }),
    deleteRemote: vi.fn(async (name: string) => {
      configs.delete(name)
    }),
    cloneRemote: vi.fn(async (source: string, target: string) => {
      await RcloneClient.prototype.cloneRemote.call(client, source, target)
    }),
    ...overrides
  } as unknown as RcloneClient
  const session = new ConnectionSession({
    client,
    remotes: makeRemotes({ A: 'remoteA', B: 'remoteB' })
  } as unknown as Services)
  const manager = makeManager()
  const config = {
    ...makeConfig(),
    defaultDir: join(process.cwd(), 'fixtures', 'out'),
    dataDir: join(process.cwd(), 'fixtures', 'data')
  }
  const app = buildApp(session, client, manager, config)
  const localPath = join(process.cwd(), 'fixtures', 'file.bin')
  fsStatMock.mockResolvedValue({ isDirectory: () => false, size: 42 })
  return { app, client, session, manager, configs, config, localPath }
}

function contractRequest(route: 'list' | 'stat' | 'upload', localPath: string, revision?: unknown) {
  if (route === 'upload') {
    return {
      method: 'POST' as const,
      url: '/api/upload',
      payload: { localPath, remoteDir: '/dest', connectionRevision: revision }
    }
  }
  return {
    method: 'GET' as const,
    url: `/api/${route}?path=${route === 'list' ? '%2F' : '%2Ffile.bin'}${revision === undefined ? '' : `&connectionRevision=${encodeURIComponent(String(revision))}`}`
  }
}

describe('public connection revision contract', () => {
  it.each(['list', 'stat', 'upload'] as const)(
    '%s rejects stale revisions without remote or local work, and accepts a current revision',
    async (route) => {
      const { app, client, session, localPath } = contractFixture()
      try {
        const old = await session.connect({ profileId: 'A' })
        const current = await session.connect({ profileId: 'B' })
        const stale = await app.inject(contractRequest(route, localPath, old))
        expect(stale.statusCode).toBe(409)
        expect(client.list).not.toHaveBeenCalled()
        expect(client.stat).not.toHaveBeenCalled()
        expect(client.cloneRemote).not.toHaveBeenCalled()
        expect(resolvePathMock).not.toHaveBeenCalled()
        const normal = await app.inject(contractRequest(route, localPath, current))
        expect(normal.statusCode).toBe(200)
        if (route === 'list')
          expect(normal.json()).toEqual([expect.objectContaining({ path: '/file.bin' })])
        if (route === 'stat') expect(normal.json()).toEqual({ size: 42, type: 'file', mtime: 0 })
        if (route === 'upload') expect(normal.json()).toHaveLength(1)
        const legacy = await app.inject(contractRequest(route, localPath))
        expect(legacy.statusCode).toBe(200)
      } finally {
        await app.close()
      }
    }
  )

  it.each(
    (['list', 'stat', 'upload'] as const).flatMap((route) =>
      (['legacy', 'stale'] as const).map((revision) => ({ route, revision }))
    )
  )('disconnected $route returns the correct $revision error', async ({ route, revision }) => {
    const { app, client, localPath } = contractFixture()
    try {
      const response = await app.inject(
        contractRequest(route, localPath, revision === 'legacy' ? undefined : 'old')
      )
      expect(response.statusCode).toBe(revision === 'legacy' ? 400 : 409)
      expect(client.list).not.toHaveBeenCalled()
      expect(client.stat).not.toHaveBeenCalled()
      expect(client.cloneRemote).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it.each(
    (['list', 'stat'] as const).flatMap((route) =>
      ['', '%20', 'r1&connectionRevision=r2'].map((selector) => ({ route, selector }))
    )
  )('$route rejects malformed query selector "$selector"', async ({ route, selector }) => {
    const { app, client, session } = contractFixture()
    try {
      await session.connect({ profileId: 'A' })
      const response = await app.inject({
        method: 'GET',
        url: `/api/${route}?path=%2Ffile.bin&connectionRevision=${selector}`
      })
      expect(response.statusCode).toBe(400)
      expect(client.list).not.toHaveBeenCalled()
      expect(client.stat).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it.each(
    (['upload', 'download'] as const).flatMap((route) =>
      [null, '', ' ', 42, [], { revision: 'r1' }].map((revision) => ({ route, revision }))
    )
  )(
    '$route rejects malformed JSON revision $revision without cloning',
    async ({ route, revision }) => {
      const { app, client, session, localPath } = contractFixture()
      try {
        await session.connect({ profileId: 'A' })
        const response = await app.inject({
          method: 'POST',
          url: `/api/${route}`,
          payload: {
            localPath,
            remoteDir: '/dest',
            remotePath: '/file.bin',
            segments: 1,
            connectionRevision: revision
          }
        })
        expect(response.statusCode).toBe(400)
        expect(client.cloneRemote).not.toHaveBeenCalled()
        expect(resolvePathMock).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    }
  )

  it.each(
    (['list', 'stat'] as const).flatMap((route) =>
      (['success', 'error', 'unchanged-error'] as const).map((outcome) => ({ route, outcome }))
    )
  )(
    '$route preserves ownership of a deferred $outcome without blocking reconnect',
    async ({ route, outcome }) => {
      const listPending = createGate<RcloneListEntry[]>()
      const statPending = createGate<RcloneListEntry | null>()
      const started = createGate<void>()
      const item = { Path: 'file.bin', Name: 'file.bin', Size: 42, ModTime: '', IsDir: false }
      const { app, session } = contractFixture({
        list: vi.fn(async () => {
          started.resolve()
          return listPending.promise
        }),
        stat: vi.fn(async () => {
          started.resolve()
          return statPending.promise
        })
      })
      let request: Promise<InjectResponse> | undefined
      try {
        const revision = await session.connect({ profileId: 'A' })
        request = app.inject(contractRequest(route, '', revision))
        await started.promise
        if (outcome !== 'unchanged-error') {
          const connected = await app.inject({
            method: 'POST',
            url: '/api/connect',
            payload: { profileId: 'B' }
          })
          expect(connected.statusCode).toBe(200)
        }
        if (outcome !== 'success') {
          if (route === 'list') listPending.reject(new Error('Remote read failed'))
          else statPending.reject(new Error('Remote read failed'))
        } else {
          listPending.resolve([item])
          statPending.resolve(item)
        }
        const response = await request
        expect(response.statusCode).toBe(outcome === 'unchanged-error' ? 500 : 409)
        if (outcome === 'unchanged-error')
          expect(response.json().message).toBe('Remote read failed')
        expect(session.status().remoteName).toBe(
          outcome === 'unchanged-error' ? 'remoteA' : 'remoteB'
        )
      } finally {
        listPending.resolve([item])
        statPending.resolve(item)
        await request
        await app.close()
      }
    }
  )
})

describe('immutable clone acquisition and lifecycle recovery', () => {
  it.each(['create', 'check'] as const)(
    'cleans unpublished manual configuration after a failed %s and recovers',
    async (failure) => {
      const { app, client, session } = contractFixture()
      try {
        if (failure === 'create')
          vi.mocked(client.createRemote).mockRejectedValueOnce(new Error('Creation failed'))
        else vi.mocked(client.checkConnection).mockRejectedValueOnce(new Error('Connection failed'))
        const failed = await app.inject({
          method: 'POST',
          url: '/api/connect',
          payload: { config: { host: 'A', port: 22, username: 'user', authMethod: 'privateKey' } }
        })
        expect(failed.statusCode).toBe(400)
        expect(client.deleteRemote).toHaveBeenCalledExactlyOnceWith('_session')
        expect(session.status()).toEqual({
          connected: false,
          remoteName: null,
          connectionRevision: null
        })
        const next = await app.inject({
          method: 'POST',
          url: '/api/connect',
          payload: { profileId: 'B' }
        })
        expect(next.statusCode).toBe(200)
      } finally {
        await app.close()
      }
    }
  )

  it.each(['saved', 'manual'] as const)(
    'holds %s A configuration until deferred clone acquisition finishes before connecting B',
    async (connection) => {
      const { app, client, session, configs } = contractFixture()
      const manual = (host: string) => ({
        config: {
          host,
          port: 22,
          username: 'user',
          authMethod: 'privateKey' as const,
          privateKeyPath: 'key'
        }
      })
      const pending = createGate<void>()
      const started = createGate<void>()
      let job: Promise<Awaited<ReturnType<ConnectionSession['acquireJobRemote']>>> | undefined
      let reconnect: Promise<string> | undefined
      try {
        const revision = await session.connect(
          connection === 'saved' ? { profileId: 'A' } : manual('A')
        )
        vi.mocked(client.getRemote).mockImplementationOnce(async (name) => {
          started.resolve()
          await pending.promise
          const config = configs.get(name)
          if (!config) throw new Error('Remote missing.')
          return { ...config }
        })
        job = session.acquireJobRemote('_dl-', revision)
        await started.promise
        const healthChecks = vi.mocked(client.checkConnection).mock.calls.length
        const creations = vi.mocked(client.createRemote).mock.calls.length
        reconnect = session.connect(connection === 'saved' ? { profileId: 'B' } : manual('B'))
        reconnect.catch(() => undefined)
        await app.inject({ method: 'GET', url: '/api/status' })
        expect(client.checkConnection).toHaveBeenCalledTimes(healthChecks)
        expect(client.createRemote).toHaveBeenCalledTimes(creations)
        pending.resolve()
        const acquired = await job
        await reconnect
        expect(configs.get(acquired.remoteName)?.host).toBe('A')
        expect(acquired.revision).toBe(revision)
        expect(session.status().connectionRevision).not.toBe(revision)
        if (connection === 'manual') expect(configs.get('_session')?.host).toBe('B')
        await acquired.release()
      } finally {
        pending.resolve()
        await Promise.allSettled([job, reconnect])
        await app.close()
      }
    }
  )

  it('cleans a partially created clone on failure and recovers for a later connection', async () => {
    const { app, client, session, localPath } = contractFixture()
    try {
      const revision = await session.connect({ profileId: 'A' })
      vi.mocked(client.createRemote).mockRejectedValueOnce(new Error('Clone creation failed'))
      const failed = await app.inject(contractRequest('upload', localPath, revision))
      expect(failed.statusCode).toBe(500)
      expect(failed.json().message).toBe('Clone creation failed')
      const target = vi.mocked(client.cloneRemote).mock.calls[0][1]
      expect(client.deleteRemote).toHaveBeenCalledExactlyOnceWith(target)
      const next = await app.inject({
        method: 'POST',
        url: '/api/connect',
        payload: { profileId: 'B' }
      })
      expect(next.statusCode).toBe(200)
      expect(session.status().remoteName).toBe('remoteB')
    } finally {
      await app.close()
    }
  })

  it('surfaces failed lifecycle deletion, clears publication before awaiting it, and recovers the queue', async () => {
    const { app, client, session } = contractFixture()
    const pending = createGate<void>()
    const started = createGate<void>()
    let request: Promise<InjectResponse> | undefined
    try {
      await session.connect({
        config: { host: 'A', port: 22, username: 'user', authMethod: 'privateKey' }
      })
      vi.mocked(client.deleteRemote).mockImplementationOnce(async () => {
        started.resolve()
        return pending.promise
      })
      request = app.inject({ method: 'POST', url: '/api/disconnect' })
      await started.promise
      expect(session.status()).toEqual({
        connected: false,
        remoteName: null,
        connectionRevision: null
      })
      pending.reject(new Error('Deletion failed'))
      const response = await request
      expect(response.statusCode).toBe(500)
      expect(response.json().message).toBe('Deletion failed')
      const next = await app.inject({
        method: 'POST',
        url: '/api/connect',
        payload: { profileId: 'B' }
      })
      expect(next.statusCode).toBe(200)
    } finally {
      pending.resolve()
      await request
      await app.close()
    }
  })

  it.each(['missing', 'destination', 'normal'] as const)(
    'download %s releases only failed pre-handoff clones',
    async (outcome) => {
      const { app, client, session, manager, config } = contractFixture()
      try {
        const revision = await session.connect({ profileId: 'A' })
        if (outcome === 'missing') vi.mocked(client.stat).mockResolvedValueOnce(null)
        if (outcome === 'destination') resolvePathMock.mockResolvedValueOnce(null)
        const response = await app.inject({
          method: 'POST',
          url: '/api/download',
          payload: {
            remotePath: '/file.bin',
            downloadDir: config.defaultDir,
            segments: 1,
            connectionRevision: revision
          }
        })
        const target = vi.mocked(client.cloneRemote).mock.calls[0][1]
        expect(client.stat).toHaveBeenCalledWith(`${target}:`, 'file.bin')
        expect(response.statusCode).toBe(
          outcome === 'missing' ? 404 : outcome === 'destination' ? 400 : 200
        )
        if (outcome === 'normal') {
          expect(client.deleteRemote).not.toHaveBeenCalled()
          expect(manager.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ srcFs: `${target}:`, cleanupRemote: target })
          )
        } else {
          expect(client.deleteRemote).toHaveBeenCalledExactlyOnceWith(target)
          expect(manager.enqueue).not.toHaveBeenCalled()
          if (outcome === 'missing') expect(resolvePathMock).not.toHaveBeenCalled()
        }
      } finally {
        await app.close()
      }
    }
  )
})
describe('ConnectionSession concurrency', () => {
  it('[principal] connect() calls are serialized: a later one must not start until the earlier one has settled', async () => {
    const remotes = makeRemotes({ A: 'remoteA', B: 'remoteB' })
    const aGate = createGate<void>()
    const bGate = createGate<void>()
    const aStarted = createGate<void>()
    const bStarted = createGate<void>()
    const callOrder: string[] = []
    const checkConnection = vi.fn((fs: string) => {
      callOrder.push(fs)
      if (fs === 'remoteA:') {
        aStarted.resolve()
        return aGate.promise
      }
      if (fs === 'remoteB:') {
        bStarted.resolve()
        return bGate.promise
      }
      throw new Error(`unexpected fs ${fs}`)
    })
    const client = { checkConnection, deleteRemote: vi.fn() } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)

    const pA = session.connect({ profileId: 'A' })
    // Attach a handler immediately so Node never flags this rejection as
    // unhandled, regardless of when the real assertion below observes it.
    pA.catch(() => undefined)
    const pB = session.connect({ profileId: 'B' })
    pB.catch(() => undefined)

    try {
      await aStarted.promise
      expect(callOrder).toEqual(['remoteA:'])

      aGate.reject(new Error('A health check failed'))
      await expect(pA).rejects.toThrow()

      await bStarted.promise
      expect(callOrder).toEqual(['remoteA:', 'remoteB:'])

      bGate.resolve()
      await pB

      expect(session.status().connected).toBe(true)
      expect(session.status().remoteName).toBe('remoteB')
    } finally {
      aGate.resolve()
      bGate.resolve()
      await Promise.allSettled([pA, pB])
    }
  })

  it('[control] a single failed ephemeral (config-based) connect still cleans up its own remote', async () => {
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const client = {
      createRemote: vi.fn().mockResolvedValue(undefined),
      checkConnection: vi.fn().mockRejectedValue(new Error('refused')),
      deleteRemote
    } as unknown as RcloneClient
    const session = new ConnectionSession({
      client,
      remotes: makeRemotes({})
    } as unknown as Services)

    await expect(
      session.connect({
        config: {
          host: 'h',
          port: 22,
          username: 'u',
          authMethod: 'password',
          password: 'p'
        } as never
      })
    ).rejects.toThrow()

    expect(deleteRemote).toHaveBeenCalledWith('_session')
    expect(session.status().connected).toBe(false)
    expect(session.status().remoteName).toBeNull()
  })

  it('[control] a sequential failed connect does not block a later successful connect', async () => {
    const remotes = makeRemotes({ A: 'remoteA' })
    const client = {
      checkConnection: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)

    await session.connect({ profileId: 'A' })
    expect(session.status().remoteName).toBe('remoteA')

    await expect(session.connect({ profileId: 'missing' })).rejects.toThrow(
      'Saved connection not found.'
    )

    await session.connect({ profileId: 'A' })
    expect(session.status().remoteName).toBe('remoteA')
  })
})

describe('download route identity binding', () => {
  it('[principal] stats and transfers from an immutable clone of the connection live at request start, not a later reconnect target', async () => {
    const remotes = makeRemotes({ A: 'remoteA', B: 'remoteB' })
    const cloneRemote = vi.fn().mockResolvedValue(undefined)
    const statGate = createGate<RcloneListEntry | null>()
    const stat = vi.fn((_fs: string, _remote: string) => statGate.promise)
    const client = {
      checkConnection: vi.fn().mockResolvedValue(undefined),
      stat,
      cloneRemote,
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)
    await session.connect({ profileId: 'A' })

    const manager = makeManager()
    const app = buildApp(session, client, manager, makeConfig())
    try {
      const requestPromise = app.inject({
        method: 'POST',
        url: '/api/download',
        payload: { remotePath: '/movies/a.mkv', segments: 1 }
      })

      await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(1))
      const statFsArg = stat.mock.calls[0][0]

      // Mid-request reconnect to an unrelated connection B while the file is
      // still being validated.
      await session.connect({ profileId: 'B' })
      statGate.resolve({ Path: 'movies/a.mkv', Name: 'a.mkv', Size: 10, ModTime: '', IsDir: false })

      const response = await requestPromise
      expect(response.statusCode).toBe(200)

      // Principal assertion 1: the file must be validated against an
      // immutable per-job clone acquired up front, not the live session fs
      // directly. Today it is stat-checked directly against "remoteA:".
      expect(statFsArg).toMatch(/^_dl-[^:]+:$/)
      // Principal assertion 2: the clone must be taken from A (live at
      // request start, captured before any await), even though B became
      // live later. Today the clone only happens *after* stat resolves and
      // reads the (by then reconnected) live session, cloning B instead.
      expect(cloneRemote).toHaveBeenCalledWith('remoteA', expect.stringMatching(/^_dl-/))
      // Principal assertion 3: the manager must pull the transfer from
      // exactly the clone fs that validated the file.
      expect(manager.enqueue).toHaveBeenCalledWith(expect.objectContaining({ srcFs: statFsArg }))
    } finally {
      await app.close()
    }
  })

  it('[control] without a mid-request reconnect, the download still clones connection A and enqueues from a stable clone', async () => {
    const remotes = makeRemotes({ A: 'remoteA' })
    const stat = vi.fn().mockResolvedValue({
      Path: 'movies/a.mkv',
      Name: 'a.mkv',
      Size: 10,
      ModTime: '',
      IsDir: false
    })
    const cloneRemote = vi.fn().mockResolvedValue(undefined)
    const client = {
      checkConnection: vi.fn().mockResolvedValue(undefined),
      stat,
      cloneRemote,
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)
    await session.connect({ profileId: 'A' })

    const manager = makeManager()
    const app = buildApp(session, client, manager, makeConfig())
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/download',
        payload: { remotePath: '/movies/a.mkv', segments: 1 }
      })

      // This outcome holds both before and after the clone-first reordering,
      // since there is no reconnect to go wrong here.
      expect(response.statusCode).toBe(200)
      expect(cloneRemote).toHaveBeenCalledWith('remoteA', expect.stringMatching(/^_dl-/))
      expect(manager.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ srcFs: expect.stringMatching(/^_dl-/) })
      )
    } finally {
      await app.close()
    }
  })

  it('[supplemental] a mid-request disconnect safely completes using the already-acquired clone, instead of failing with 400', async () => {
    const remotes = makeRemotes({ A: 'remoteA' })
    const statGate = createGate<RcloneListEntry | null>()
    const stat = vi.fn(() => statGate.promise)
    const cloneRemote = vi.fn().mockResolvedValue(undefined)
    const client = {
      checkConnection: vi.fn().mockResolvedValue(undefined),
      stat,
      cloneRemote,
      deleteRemote: vi.fn().mockResolvedValue(undefined)
    } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)
    await session.connect({ profileId: 'A' })

    const manager = makeManager()
    const app = buildApp(session, client, manager, makeConfig())
    try {
      const requestPromise = app.inject({
        method: 'POST',
        url: '/api/download',
        payload: { remotePath: '/movies/a.mkv', segments: 1 }
      })

      await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(1))
      // Disconnect while the clone's own stat is still pending. Since the
      // approved design acquires the immutable clone *before* this stat ever
      // runs, the already-bound clone is independent of the live session and
      // the request should complete rather than fail.
      await session.disconnect()
      statGate.resolve({ Path: 'movies/a.mkv', Name: 'a.mkv', Size: 10, ModTime: '', IsDir: false })

      const response = await requestPromise
      // Supplemental: today, without clone-first, session.remoteName() is
      // re-read at clone time and throws once disconnected, so this is
      // actually 400 — this assertion targets the pending clone-first design,
      // not proof of the original P1 bug.
      expect(response.statusCode).toBe(200)
      expect(cloneRemote).toHaveBeenCalledWith('remoteA', expect.stringMatching(/^_dl-/))
    } finally {
      await app.close()
    }
  })
})

describe('upload route identity binding', () => {
  it('[principal] rejects the upload when the connection changed during local validation, instead of silently cloning the new remote', async () => {
    const remotes = makeRemotes({ A: 'remoteA', B: 'remoteB' })
    const cloneRemote = vi.fn().mockResolvedValue(undefined)
    const client = {
      checkConnection: vi.fn().mockResolvedValue(undefined),
      cloneRemote,
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)
    await session.connect({ profileId: 'A' })

    const statGate = createGate<{ isDirectory: () => boolean; size: number }>()
    fsStatMock.mockImplementation(() => statGate.promise)

    const manager = makeManager()
    const app = buildApp(session, client, manager, makeConfig())
    try {
      const requestPromise = app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: { localPath: '/root/file.bin', remoteDir: 'dest' }
      })

      await vi.waitFor(() => expect(fsStatMock).toHaveBeenCalledTimes(1))

      // Reconnect to an unrelated connection B while the local file is still
      // being validated — the identity should already be bound to A by now.
      await session.connect({ profileId: 'B' })
      statGate.resolve({ isDirectory: () => false, size: 42 })

      const response = await requestPromise
      // Principal assertion: the approved design binds the remote identity
      // before local validation and only *acquires* (clones) it afterward by
      // that captured identity; if it no longer matches the live connection,
      // the request must be rejected (409) rather than silently cloning
      // whatever is live now (B). Today this returns 200 and clones B.
      expect(response.statusCode).toBe(409)
      expect(cloneRemote).not.toHaveBeenCalledWith('remoteB', expect.anything())
      expect(cloneRemote).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('[control] without a mid-request reconnect, the upload clones the connection live when it started', async () => {
    const remotes = makeRemotes({ A: 'remoteA' })
    const cloneRemote = vi.fn().mockResolvedValue(undefined)
    const client = {
      checkConnection: vi.fn().mockResolvedValue(undefined),
      cloneRemote,
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)
    await session.connect({ profileId: 'A' })
    fsStatMock.mockResolvedValue({ isDirectory: () => false, size: 42 })

    const manager = makeManager()
    const app = buildApp(session, client, manager, makeConfig())
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload: { localPath: '/root/file.bin', remoteDir: 'dest' }
      })

      expect(response.statusCode).toBe(200)
      expect(cloneRemote).toHaveBeenCalledWith('remoteA', expect.stringMatching(/^_ul-/))
    } finally {
      await app.close()
    }
  })
})

describe('connectionRevision design (supplemental — not proof of the original bugs; the field does not exist yet)', () => {
  it('[supplemental] rejects a stale connectionRevision on /api/download with 409 instead of cloning', async () => {
    const remotes = makeRemotes({ A: 'remoteA', B: 'remoteB' })
    const stat = vi.fn().mockResolvedValue({
      Path: 'movies/a.mkv',
      Name: 'a.mkv',
      Size: 10,
      ModTime: '',
      IsDir: false
    })
    const cloneRemote = vi.fn().mockResolvedValue(undefined)
    const client = {
      checkConnection: vi.fn().mockResolvedValue(undefined),
      stat,
      cloneRemote,
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)
    await session.connect({ profileId: 'A' })
    await session.connect({ profileId: 'B' })

    const manager = makeManager()
    const app = buildApp(session, client, manager, makeConfig())
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/download',
        payload: {
          remotePath: '/movies/a.mkv',
          segments: 1,
          // The request was prepared while A was connected; B is now live.
          connectionRevision: 'revision-captured-for-A'
        }
      })

      expect(response.statusCode).toBe(409)
      expect(cloneRemote).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('[supplemental] /api/connect and /api/status expose a non-empty connectionRevision', async () => {
    const remotes = makeRemotes({ A: 'remoteA' })
    const client = {
      checkConnection: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)
    const manager = makeManager()
    const app = buildApp(session, client, manager, makeConfig())
    try {
      const connectResponse = await app.inject({
        method: 'POST',
        url: '/api/connect',
        payload: { profileId: 'A' }
      })
      const connectBody = connectResponse.json() as { connectionRevision?: string }
      expect(typeof connectBody.connectionRevision).toBe('string')
      expect(connectBody.connectionRevision).toBeTruthy()

      const statusResponse = await app.inject({ method: 'GET', url: '/api/status' })
      const statusBody = statusResponse.json() as { connectionRevision?: string | null }
      expect(statusBody.connectionRevision).toBe(connectBody.connectionRevision)
    } finally {
      await app.close()
    }
  })

  it('[supplemental] overlapping /api/connect requests each capture their own distinct revision', async () => {
    const remotes = makeRemotes({ A: 'remoteA', B: 'remoteB' })
    const client = {
      checkConnection: vi.fn().mockResolvedValue(undefined),
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const session = new ConnectionSession({ client, remotes } as unknown as Services)
    const manager = makeManager()
    const app = buildApp(session, client, manager, makeConfig())
    try {
      const [responseA, responseB] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/connect', payload: { profileId: 'A' } }),
        app.inject({ method: 'POST', url: '/api/connect', payload: { profileId: 'B' } })
      ])
      const bodyA = responseA.json() as { connectionRevision?: string }
      const bodyB = responseB.json() as { connectionRevision?: string }

      expect(typeof bodyA.connectionRevision).toBe('string')
      expect(typeof bodyB.connectionRevision).toBe('string')
      expect(bodyA.connectionRevision).not.toBe(bodyB.connectionRevision)
    } finally {
      await app.close()
    }
  })
})
