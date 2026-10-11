import Fastify, { type FastifyInstance } from 'fastify'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerRoutes } from '../src/server/app'
import { AuthService, hashPassword } from '../src/server/auth'
import { resolveConfig } from '../src/server/config'
import type { RouteContext } from '../src/server/context'
import { LoginLimiter } from '../src/server/loginLimiter'
import type { RcloneListEntry } from '../src/server/rclone/client'
import type { RcloneEnqueueInput } from '../src/server/rclone/downloadManager'
import type { TransferProgress } from '../src/shared/types'
import { coordinatorFixture, currentVersion, deferred, testDirectory } from './fixtures/updates'

const passwordHash = hashPassword('test-password')
const origin = { host: 'localhost:8080', origin: 'http://localhost:8080' }
let directory: Awaited<ReturnType<typeof testDirectory>>
const apps: FastifyInstance[] = []

beforeEach(async () => {
  directory = await testDirectory()
})
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await directory.dispose()
})

async function server(mode: 'password' | 'open' | 'setup' = 'password') {
  const stateDir = join(directory.dir, 'updater')
  await mkdir(stateDir)
  const fixture = await coordinatorFixture(stateDir)
  const auth = new AuthService({
    startup:
      mode === 'password'
        ? { mode, username: 'admin', passwordHash, canChangePassword: true }
        : { mode },
    store: { write: async () => undefined },
    sessionTtlMs: 60_000
  })
  const sid = mode === 'password' ? await auth.login('admin', 'test-password') : null
  const config = resolveConfig({}, {}, directory.dir)
  config.defaultDir = directory.dir
  config.dataDir = join(directory.dir, 'data')
  config.roots = [{ name: 'test', path: directory.dir }]
  config.confined = true
  const client = {
    stat: vi.fn<(fs: string, path: string) => Promise<RcloneListEntry | null>>(async () => ({
      Path: 'file.bin',
      Name: 'file.bin',
      Size: 1,
      IsDir: false,
      ModTime: ''
    })),
    cloneRemote: vi.fn<(source: string, destination: string) => Promise<void>>(
      async () => undefined
    ),
    deleteRemote: vi.fn(async () => undefined),
    listRecursiveEntries: vi.fn<(fs: string, path: string) => Promise<RcloneListEntry[]>>(
      async () => []
    )
  }
  const enqueue = vi.fn((input: RcloneEnqueueInput): TransferProgress => ({
    id: 'transfer',
    remotePath: input.displayName,
    localPath: input.localPath,
    size: input.size,
    transferred: 0,
    speedBytesPerSec: 0,
    activeSegments: 0,
    segments: input.segments,
    status: 'queued',
    direction: input.direction
  }))
  const ctx = {
    config,
    auth,
    limiter: new LoginLimiter({ maxAttempts: 5, lockoutMs: 1000 }),
    services: { client, manager: { list: () => fixture.transfers, enqueue } },
    session: { remoteFs: () => 'test:', remoteName: () => 'test' },
    execDir: directory.dir,
    updates: fixture.updates
  } as unknown as RouteContext
  const app = Fastify()
  apps.push(app)
  await registerRoutes(app, ctx)
  await app.ready()
  const headers = { ...origin, cookie: sid ? `siphon_sid=${sid}` : '' }
  return { app, headers, client, enqueue, stateDir, ...fixture }
}

describe('update HTTP boundary', () => {
  it.each([false, true])(
    'returns authoritative install acceptance %s on a 503',
    async (accepted) => {
      const { app, headers, updates, schedule, stateDir } = await server()
      const offer = (await updates.check()).offer!
      if (accepted) schedule.mockRejectedValueOnce(new Error('Scheduler response lost'))
      else await mkdir(join(stateDir, 'request.json'))
      const response = await app.inject({
        method: 'POST',
        url: '/api/updates/install',
        headers,
        payload: { offerId: offer.id }
      })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ accepted, error: expect.any(String) })
      expect((await updates.status()).maintenance).toBe(accepted)
      if (accepted) expect(schedule).toHaveBeenCalledOnce()
      else expect(schedule).not.toHaveBeenCalled()
    }
  )

  it.each(['setup', 'password', 'open'] as const)(
    'exposes only exact GET version health publicly in %s mode',
    async (mode) => {
      const { app, fetch } = await server(mode)
      const health = await app.inject({ method: 'GET', url: '/api/health' })
      expect(health.statusCode).toBe(200)
      expect(health.json()).toEqual({ app: 'siphon', version: currentVersion })
      expect(health.headers['cache-control']).toBe('no-store')
      if (mode !== 'open') {
        const code = mode === 'setup' ? 403 : 401
        for (const request of [
          { method: 'HEAD' as const, url: '/api/health' },
          { method: 'GET' as const, url: '/api/health/private' },
          { method: 'GET' as const, url: '/api/config' }
        ]) {
          expect((await app.inject(request)).statusCode).toBe(code)
        }
      }
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['setup', 403],
    ['open', 403],
    ['password', 401]
  ] as const)(
    'rejects unauthenticated machine management in %s mode with no effects',
    async (mode, code) => {
      const { app, fetch, schedule, stateDir } = await server(mode)
      for (const [url, payload] of [
        ['/api/updates/check', {}],
        ['/api/updates/install', { offerId: 'offer' }]
      ] as const) {
        const response = await app.inject({ method: 'POST', url, headers: origin, payload })
        expect(response.statusCode).toBe(code)
      }
      expect(fetch).not.toHaveBeenCalled()
      expect(schedule).not.toHaveBeenCalled()
      expect(await readdir(stateDir)).toEqual([])
      if (mode === 'open') {
        const status = await app.inject({
          method: 'GET',
          url: '/api/updates/status',
          headers: origin
        })
        expect(status.statusCode).toBe(200)
        expect(status.json().canInstall).toBe(false)
        expect(status.json().blockedReason ?? status.json().capability.message).toMatch(
          /password|authenticat/i
        )
      }
    }
  )

  it('status reads are local and a valid authenticated install accepts only the checked offer', async () => {
    const { app, headers, fetch, schedule } = await server()
    const local = await app.inject({ method: 'GET', url: '/api/updates/status', headers })
    expect(local.statusCode).toBe(200)
    expect(local.json()).toMatchObject({ currentVersion, offer: null })
    expect(fetch).not.toHaveBeenCalled()
    const check = await app.inject({
      method: 'POST',
      url: '/api/updates/check',
      headers,
      payload: {}
    })
    expect(check.statusCode).toBe(200)
    const offer = check.json().offer
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/updates/install',
      headers,
      payload: { offerId: 'not-checked' }
    })
    expect(rejected.statusCode).toBe(409)
    expect(schedule).not.toHaveBeenCalled()
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/updates/install',
      headers,
      payload: { offerId: offer.id }
    })
    expect(accepted.statusCode).toBe(202)
    expect(accepted.json()).toMatchObject({ toVersion: offer.version, phase: 'accepted' })
    expect(schedule).toHaveBeenCalledOnce()
  })

  it.each([
    ['foreign origin', { origin: 'https://evil.example' }, {}, 403],
    ['foreign scheme', { origin: 'https://localhost:8080' }, {}, 403],
    ['opaque origin', { origin: 'null' }, {}, 403],
    ['non-JSON', { 'content-type': 'text/plain' }, '{}', 415],
    ['non-object check', {}, [], 400],
    ['caller URL', {}, { url: 'https://evil.example/installer.exe' }, 400]
  ])('rejects %s before check effects', async (_name, extraHeaders, payload, code) => {
    const { app, headers, fetch, schedule, stateDir } = await server()
    const response = await app.inject({
      method: 'POST',
      url: '/api/updates/check',
      headers: { ...headers, ...extraHeaders },
      payload
    })
    expect(response.statusCode).toBe(code)
    expect(fetch).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
    expect(await readdir(stateDir)).toEqual([])
  })

  it.each([{}, { offerId: '' }, { offerId: 1 }, { offerId: 'offer', task: 'evil' }])(
    'rejects malformed install input %j without scheduling',
    async (payload) => {
      const { app, headers, schedule, stateDir } = await server()
      const response = await app.inject({
        method: 'POST',
        url: '/api/updates/install',
        headers,
        payload
      })
      expect(response.statusCode).toBe(400)
      expect(schedule).not.toHaveBeenCalled()
      expect(await readdir(stateDir)).toEqual([])
    }
  )

  it('applies origin and JSON checks to install even with a valid offer and session', async () => {
    const { app, headers, updates, schedule, stateDir } = await server()
    const offer = (await updates.check()).offer!
    for (const [extraHeaders, payload, code] of [
      [{ origin: 'https://evil.example' }, { offerId: offer.id }, 403],
      [{ 'content-type': 'text/plain' }, JSON.stringify({ offerId: offer.id }), 415]
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/updates/install',
        headers: { ...headers, ...extraHeaders },
        payload
      })
      expect(response.statusCode).toBe(code)
    }
    expect(schedule).not.toHaveBeenCalled()
    expect(await readdir(stateDir)).toEqual([])
    expect((await updates.status()).maintenance).toBe(false)
  })
})

describe('transfer/update mutual exclusion through real routes', () => {
  it.each(['download', 'upload'] as const)(
    'retains %s admission through awaited expansion and releases it on failure',
    async (direction) => {
      const { app, headers, updates, client, schedule, enqueue } = await server()
      const offer = (await updates.check()).offer!
      const gate = deferred<never>()
      void gate.promise.catch(() => undefined)
      if (direction === 'download') {
        client.stat.mockResolvedValueOnce({
          Path: 'folder',
          Name: 'folder',
          Size: -1,
          IsDir: true,
          ModTime: ''
        })
        client.listRecursiveEntries.mockImplementationOnce(() => gate.promise)
      } else {
        await writeFile(join(directory.dir, 'file.bin'), 'x')
        client.cloneRemote.mockImplementationOnce(() => gate.promise)
      }
      const pending = app.inject({
        method: 'POST',
        url: `/api/${direction}`,
        headers,
        payload:
          direction === 'download'
            ? { remotePath: '/folder', downloadDir: directory.dir, segments: 1 }
            : { localPath: join(directory.dir, 'file.bin'), remoteDir: '/' }
      })
      const responsePromise = pending.then((result) => result)
      try {
        await vi.waitFor(() => {
          expect(
            direction === 'download' ? client.listRecursiveEntries : client.cloneRemote
          ).toHaveBeenCalled()
        })
        const blocked = await app.inject({
          method: 'POST',
          url: '/api/updates/install',
          headers,
          payload: { offerId: offer.id }
        })
        expect(blocked.statusCode).toBe(409)
        expect(schedule).not.toHaveBeenCalled()
      } finally {
        gate.reject(new Error('expansion failed'))
        await responsePromise
      }
      expect((await responsePromise).statusCode).toBe(500)
      expect(enqueue).not.toHaveBeenCalled()
      expect((await updates.status()).canInstall).toBe(true)
    }
  )

  it('rejects uploads and downloads before touching rclone during accepted maintenance', async () => {
    const { app, headers, updates, client, enqueue } = await server()
    const offer = (await updates.check()).offer!
    await updates.install(offer.id)
    for (const direction of ['download', 'upload']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/${direction}`,
        headers,
        payload:
          direction === 'download'
            ? { remotePath: '/file.bin', downloadDir: directory.dir, segments: 1 }
            : { localPath: join(directory.dir, 'file.bin'), remoteDir: '/' }
      })
      expect(response.statusCode).toBe(409)
    }
    expect(client.stat).not.toHaveBeenCalled()
    expect(client.cloneRemote).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('excludes the updater subtree from folder APIs, uploads, and nested download plans', async () => {
    const { app, headers, stateDir, client, enqueue } = await server()
    const protectedFile = join(stateDir, 'protected.json')
    await writeFile(protectedFile, 'immutable')
    const listing = await app.inject({
      method: 'GET',
      url: `/api/fs/list?path=${encodeURIComponent(directory.dir)}`,
      headers
    })
    expect(listing.statusCode).toBe(200)
    expect(listing.json().entries.map((entry: { path: string }) => entry.path)).not.toContain(
      stateDir
    )
    client.stat.mockResolvedValueOnce({
      Path: 'updater',
      Name: 'updater',
      Size: -1,
      IsDir: true,
      ModTime: ''
    })
    client.listRecursiveEntries.mockResolvedValueOnce([
      {
        Path: 'updater/replacement.json',
        Name: 'replacement.json',
        Size: 1,
        IsDir: false,
        ModTime: ''
      }
    ])
    for (const [url, payload] of [
      ['/api/fs/mkdir', { path: stateDir, name: 'injected' }],
      ['/api/upload', { localPath: protectedFile, remoteDir: '/' }],
      ['/api/download', { remotePath: '/updater', downloadDir: directory.dir, segments: 1 }]
    ] as const) {
      const response = await app.inject({ method: 'POST', url, headers, payload })
      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      expect(response.statusCode).toBeLessThan(500)
    }
    expect(enqueue).not.toHaveBeenCalled()
    expect(await readdir(stateDir)).toEqual(['protected.json'])
  })
})
