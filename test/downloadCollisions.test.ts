import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadAdmission, DownloadPlan } from '../src/shared/api'
import type { RouteContext } from '../src/server/context'
import type { ServerConfig } from '../src/server/config'
import { DOWNLOAD_PLAN_TTL_MS } from '../src/server/downloadPlans'
import { downloadDestinationKey, validateDownloadDestination } from '../src/server/localFs'
import { registerDownloadRoutes } from '../src/server/routes/downloads'
import { ConnectionSession } from '../src/server/session'
import type { Services } from '../src/server/services'
import type { RcloneClient, RcloneJobStatus, RcloneListEntry } from '../src/server/rclone/client'
import {
  RcloneDownloadManager,
  type RcloneEnqueueInput
} from '../src/server/rclone/downloadManager'

type Source = Record<string, string | null>
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []

async function fixture(source: Source = { 'a.bin': 'fresh source' }, paused = false) {
  const root = await mkdtemp(join(process.cwd(), '.collision-route-test-'))
  const output = join(root, 'downloads')
  await mkdir(output)
  const remotes = new Map<string, string>()
  const sources: Record<string, Source> = { first: source, second: { 'a.bin': 'wrong connection' } }
  const jobs = new Map<number, RcloneJobStatus>()
  let nextJob = 0
  const entry = (path: string, value: string | null): RcloneListEntry => ({
    Path: path,
    Name: posix.basename(path),
    Size: value === null ? -1 : Buffer.byteLength(value),
    ModTime: '2026-01-01T00:00:00Z',
    IsDir: value === null
  })
  const sourceFor = (fs: string) => sources[remotes.get(fs.replace(/:$/, ''))!]
  const client = {
    createRemote: vi.fn(async (name: string, _type: string, parameters: Record<string, string>) => {
      remotes.set(name, parameters.host)
    }),
    cloneRemote: vi.fn(async (from: string, to: string) => {
      remotes.set(to, remotes.get(from)!)
    }),
    deleteRemote: vi.fn(async (name: string) => {
      remotes.delete(name)
    }),
    checkConnection: vi.fn(async () => undefined),
    stat: vi.fn(async (fs: string, path: string) => {
      const contents = sourceFor(fs)
      if (Object.hasOwn(contents, path)) return entry(path, contents[path])
      return Object.keys(contents).some((key) => key.startsWith(`${path}/`))
        ? entry(path, null)
        : null
    }),
    listRecursiveEntries: vi.fn(async (fs: string, path: string) =>
      Object.entries(sourceFor(fs))
        .filter(([key]) => key.startsWith(path ? `${path}/` : ''))
        .map(([key, value]) => entry(key, value))
    ),
    coreStatsDelete: vi.fn(async () => undefined),
    coreStats: vi.fn(async () => ({ bytes: 0, transferring: [] })),
    copyFileAsync: vi.fn<RcloneClient['copyFileAsync']>(async (input) => {
      const content = sourceFor(input.srcFs)[input.srcRemote]
      if (typeof content !== 'string') throw new Error('Missing source.')
      await writeFile(join(input.dstFs, input.dstRemote), content)
      const id = ++nextJob
      jobs.set(id, { id, finished: !paused, success: true, error: '' })
      return id
    }),
    jobStatus: vi.fn(async (id: number) => jobs.get(id)!),
    jobStop: vi.fn(async () => undefined)
  }
  const scope = { roots: [{ name: 'Downloads', path: output }], confined: true }
  const validator = vi.fn((input: RcloneEnqueueInput) => validateDownloadDestination(scope, input))
  const manager = new RcloneDownloadManager(client as unknown as RcloneClient, validator, vi.fn())
  const services = { client, manager, remotes: {} } as unknown as Services
  const session = new ConnectionSession(services)
  await session.connect({
    config: { host: 'first', port: 22, username: 'test', authMethod: 'password' }
  })
  const releaseAdmission = vi.fn()
  const updates = {
    protectedPaths: [join(root, 'protected')],
    admitTransfer: vi.fn(() => releaseAdmission)
  }
  const app = Fastify()
  registerDownloadRoutes(app, {
    config: { ...scope, defaultDir: output } as ServerConfig,
    services,
    session,
    updates
  } as unknown as RouteContext)
  const revision = () => session.status().connectionRevision!
  const plan = async (paths = ['/a.bin'], downloadDir = output) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/download/plan',
      payload: { remotePaths: paths, downloadDir, segments: 4, connectionRevision: revision() }
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json<DownloadPlan>()
  }
  const commitResponse = (plan: DownloadPlan, decisions = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/download/commit',
      payload: { planId: plan.id, decisions }
    })
  const commit = async (plan: DownloadPlan, decisions = {}) => {
    const response = await commitResponse(plan, decisions)
    expect(response.statusCode, response.body).toBe(200)
    return response.json<DownloadAdmission>()
  }
  const finish = async (status: 'completed' | 'error' | 'canceled' = 'completed', count = 1) => {
    await vi.waitFor(
      () => expect(manager.list().filter((item) => item.status === status)).toHaveLength(count),
      { timeout: 4000 }
    )
  }
  const result = {
    root,
    output,
    app,
    client,
    manager,
    validator,
    session,
    sources,
    jobs,
    plan,
    commit,
    commitResponse,
    finish,
    updates,
    releaseAdmission
  }
  fixtures.push(result)
  return result
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    for (const job of f.jobs.values()) job.finished = true
    f.manager.cancelAll()
    await vi.waitFor(
      () => expect(f.manager.list().some((t) => t.status === 'downloading')).toBe(false),
      { timeout: 5000 }
    )
    await f.app.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

describe('download collision admission and execution', () => {
  it('plans without side effects, admits idempotently, stages privately and completes only after publication', async () => {
    const f = await fixture()
    const plan = await f.plan()
    expect(plan).toMatchObject({ fileCount: 1, batch: false, conflicts: [] })
    expect(f.manager.list()).toEqual([])
    expect(await readdir(f.output)).toEqual([])
    expect(f.releaseAdmission).not.toHaveBeenCalled()
    const admitted = await f.commit(plan)
    const replay = await f.commit(plan)
    expect(replay).toEqual(admitted)
    expect(Object.keys(admitted).sort()).toEqual(['empty', 'skipped', 'transfers'])
    expect(admitted).toMatchObject({ empty: false, skipped: [] })
    await f.finish()
    expect(f.client.copyFileAsync).toHaveBeenCalledOnce()
    const copy = f.client.copyFileAsync.mock.calls[0][0]
    expect(copy.dstFs).not.toBe(f.output)
    expect(copy.dstRemote).toBe('payload')
    expect(f.manager.list()[0]).toMatchObject({ status: 'completed', transferred: 12 })
    expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('fresh source')
    expect(await readdir(f.output)).toEqual(['a.bin'])
    expect(f.releaseAdmission).toHaveBeenCalledOnce()
  })

  it('merges a folder container without touching unrelated content and preserves empty subfolders', async () => {
    const f = await fixture({
      folder: null,
      'folder/a': 'a',
      'folder/sub/b': 'b',
      'folder/empty': null
    })
    await mkdir(join(f.output, 'folder'))
    await writeFile(join(f.output, 'folder', 'unrelated'), 'keep')
    const plan = await f.plan(['/folder'])
    expect(plan).toMatchObject({ fileCount: 2, batch: true, conflicts: [] })
    const admission = await f.commit(plan)
    expect(admission.transfers).toHaveLength(2)
    await f.finish('completed', 2)
    expect(await readFile(join(f.output, 'folder', 'unrelated'), 'utf8')).toBe('keep')
    expect(await readFile(join(f.output, 'folder', 'sub', 'b'), 'utf8')).toBe('b')
    expect((await lstat(join(f.output, 'folder', 'empty'))).isDirectory()).toBe(true)
    expect(f.client.deleteRemote).toHaveBeenCalledOnce()
  })

  it('requires explicit overwrite and preserves recovery content for an approved existing file', async () => {
    const f = await fixture({ 'a.bin': 'new bytes' })
    await writeFile(join(f.output, 'a.bin'), 'old bytes')
    const plan = await f.plan()
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ localPath: join(f.output, 'a.bin'), canOverwrite: true })
    ])
    const missingChoice = await f.commitResponse(plan)
    expect(missingChoice.statusCode).toBe(409)
    expect(missingChoice.json().code).toBe('DESTINATION_COLLISION')
    await f.commit(plan, { [plan.conflicts[0].entryId]: 'overwrite' })
    await f.finish()
    expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('new bytes')
    const transfer = f.manager.list()[0]
    expect(transfer.recoveryPath).toBeTruthy()
    expect(await readFile(transfer.recoveryPath!, 'utf8')).toBe('old bytes')
  })

  it('canceling a mixed file/folder batch creates no directories or earlier transfers', async () => {
    const f = await fixture({ 'newfolder/new': 'new', 'a.bin': 'fresh' })
    await writeFile(join(f.output, 'a.bin'), 'keep')
    const plan = await f.plan(['/newfolder', '/a.bin'])
    await f.app.inject({ method: 'POST', url: `/api/download/plan/${plan.id}/release` })
    expect(f.manager.list()).toEqual([])
    await expect(lstat(join(f.output, 'newfolder'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('keep')
    expect(f.releaseAdmission).toHaveBeenCalledOnce()
    const late = await f.commitResponse(plan, { [plan.conflicts[0].entryId]: 'overwrite' })
    expect(late.json().code).toBe('DOWNLOAD_PLAN_EXPIRED')
  })

  it('reports skipped files explicitly, including all-skipped batches, without treating them as empty folders', async () => {
    const f = await fixture({ 'folder/a': 'new', 'folder/b': 'new' })
    await mkdir(join(f.output, 'folder'))
    await writeFile(join(f.output, 'folder', 'a'), 'keep a')
    await writeFile(join(f.output, 'folder', 'b'), 'keep b')
    const plan = await f.plan(['/folder'])
    const admission = await f.commit(
      plan,
      Object.fromEntries(plan.conflicts.map((c) => [c.entryId, 'skip']))
    )
    expect(admission).toEqual({ transfers: [], skipped: ['folder/a', 'folder/b'], empty: false })
    expect(f.client.copyFileAsync).not.toHaveBeenCalled()
    expect(f.client.deleteRemote).toHaveBeenCalledOnce()
    expect(await readFile(join(f.output, 'folder', 'a'), 'utf8')).toBe('keep a')
  })

  it('skips one folder child and copies only nonconflicting children', async () => {
    const f = await fixture({ 'folder/a': 'new a', 'folder/b': 'new b' })
    await mkdir(join(f.output, 'folder'))
    await writeFile(join(f.output, 'folder', 'a'), 'keep a')
    const plan = await f.plan(['/folder'])
    const admission = await f.commit(plan, { [plan.conflicts[0].entryId]: 'skip' })
    expect(admission).toMatchObject({ skipped: ['folder/a'], empty: false })
    expect(admission.transfers).toHaveLength(1)
    await f.finish()
    expect(await readFile(join(f.output, 'folder', 'a'), 'utf8')).toBe('keep a')
    expect(await readFile(join(f.output, 'folder', 'b'), 'utf8')).toBe('new b')
  })

  it.each(['directory', 'blocking-parent'] as const)(
    'never converts a %s collision into a file',
    async (kind) => {
      const f = await fixture(kind === 'directory' ? { 'a.bin': 'new' } : { 'folder/sub/a': 'new' })
      const path = join(f.output, kind === 'directory' ? 'a.bin' : 'folder')
      if (kind === 'directory') await mkdir(path)
      else await writeFile(path, 'keep')
      const plan = await f.plan(kind === 'directory' ? ['/a.bin'] : ['/folder'])
      expect(plan.conflicts[0].canOverwrite).toBe(false)
      const response = await f.commitResponse(plan, { [plan.conflicts[0].entryId]: 'overwrite' })
      expect(response.statusCode).toBe(400)
      expect(f.client.copyFileAsync).not.toHaveBeenCalled()
      if (kind === 'directory') expect((await lstat(path)).isDirectory()).toBe(true)
      else {
        const skipped = await f.commit(plan, { [plan.conflicts[0].entryId]: 'skip' })
        expect(skipped.skipped).toEqual(['folder/sub/a'])
        expect(await readFile(path, 'utf8')).toBe('keep')
      }
    }
  )

  it.each(
    [
      ['/left/a', '/right/a'],
      ['/folder', '/folder']
    ].map((paths) => ({ paths }))
  )('rejects ambiguous batch destinations ($paths)', async ({ paths }) => {
    const f = await fixture({ 'left/a': 'left', 'right/a': 'right', 'folder/a': 'folder' })
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/download/plan',
      payload: { remotePaths: paths, downloadDir: f.output, segments: 4 }
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('AMBIGUOUS_DESTINATION')
    expect(f.manager.list()).toEqual([])
    expect(await readdir(f.output)).toEqual([])
    expect(f.client.deleteRemote).toHaveBeenCalledOnce()
  })

  it('rechecks every target before admission; a late target leaves even earlier folder items unqueued', async () => {
    const f = await fixture({ 'folder/new': 'new', 'a.bin': 'new' })
    const plan = await f.plan(['/folder', '/a.bin'])
    await writeFile(join(f.output, 'a.bin'), 'late file')
    const response = await f.commitResponse(plan)
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('DESTINATION_CHANGED')
    expect(f.manager.list()).toEqual([])
    await expect(lstat(join(f.output, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('late file')
  })

  it('does not inherit overwrite permission after the approved file changes', async () => {
    const f = await fixture()
    await writeFile(join(f.output, 'a.bin'), 'before')
    const plan = await f.plan()
    await writeFile(join(f.output, 'a.bin'), 'after approval')
    const response = await f.commitResponse(plan, { [plan.conflicts[0].entryId]: 'overwrite' })
    expect(response.json().code).toBe('DESTINATION_CHANGED')
    expect(f.client.copyFileAsync).not.toHaveBeenCalled()
    expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('after approval')
  })

  it.each([false, true])(
    'preserves a target created/changed during transfer (overwrite=%s) and never reports Completed',
    async (overwrite) => {
      const f = await fixture(undefined, true)
      if (overwrite) await writeFile(join(f.output, 'a.bin'), 'approved old')
      const plan = await f.plan()
      await f.commit(plan, overwrite ? { [plan.conflicts[0].entryId]: 'overwrite' } : {})
      await vi.waitFor(() => expect(f.jobs.size).toBe(1))
      await writeFile(join(f.output, 'a.bin'), 'late content')
      f.jobs.get(1)!.finished = true
      await f.finish('error')
      expect(f.manager.list()[0]).toMatchObject({
        errorCode: 'DESTINATION_CHANGED',
        retryable: true
      })
      expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('late content')
      expect(await readdir(f.output)).toEqual(['a.bin'])
    }
  )

  it('serializes final destinations through publication and rejects a stale queued approval', async () => {
    const f = await fixture(undefined, true)
    f.manager.setMaxConcurrent(2)
    const first = await f.plan()
    const second = await f.plan()
    await f.commit(first)
    await f.commit(second)
    await vi.waitFor(() => expect(f.jobs.size).toBe(1))
    expect(f.manager.list()[1]).toMatchObject({
      status: 'queued',
      waitingReason: expect.stringContaining('another download')
    })
    f.jobs.get(1)!.finished = true
    await f.finish()
    await f.finish('error')
    expect(f.client.copyFileAsync).toHaveBeenCalledOnce()
    expect(f.manager.list()[1].errorCode).toBe('DESTINATION_CHANGED')
    expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('fresh source')
  })

  it('removes failed or confirmed-canceled staging without touching the destination', async () => {
    const f = await fixture(undefined, true)
    await writeFile(join(f.output, 'a.bin'), 'keep')
    const plan = await f.plan()
    const admission = await f.commit(plan, { [plan.conflicts[0].entryId]: 'overwrite' })
    await vi.waitFor(() => expect(f.jobs.size).toBe(1))
    f.manager.clearAll()
    f.jobs.get(1)!.finished = true
    await vi.waitFor(() => expect(f.manager.list()).toEqual([]))
    expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('keep')
    expect(await readdir(f.output)).toEqual(['a.bin'])
    expect(f.manager.remove(admission.transfers[0].id)).toBe(false)
  })

  it('quarantines uncertain writers, retains staging and keeps protection after row removal', async () => {
    const f = await fixture(undefined, true)
    const admission = await f.commit(await f.plan())
    await vi.waitFor(() => expect(f.jobs.size).toBe(1))
    f.manager.cancel(admission.transfers[0].id)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000)
    await f.finish('canceled')
    const canceled = f.manager.list()[0]
    expect(canceled.recoveryPath).toBeTruthy()
    expect(await readFile(join(canceled.recoveryPath!, 'payload'), 'utf8')).toBe('fresh source')
    f.manager.remove(canceled.id)
    const next = await f.commit(await f.plan())
    expect(next.transfers[0]).toMatchObject({ status: 'error', retryable: false })
    expect(f.client.copyFileAsync).toHaveBeenCalledOnce()
  })

  it('expires plans and releases source/update leases without jobs or folders', async () => {
    const f = await fixture()
    await f.app.ready()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const plan = await f.plan()
    await vi.advanceTimersByTimeAsync(DOWNLOAD_PLAN_TTL_MS)
    expect(f.releaseAdmission).toHaveBeenCalledOnce()
    expect(f.client.deleteRemote).toHaveBeenCalledOnce()
    const response = await f.commitResponse(plan)
    expect(response.json().code).toBe('DOWNLOAD_PLAN_EXPIRED')
    expect(f.manager.list()).toEqual([])
  })

  it('rejects replay with different decisions rather than creating a second successor', async () => {
    const f = await fixture({ 'folder/a': 'new' })
    await mkdir(join(f.output, 'folder'))
    await writeFile(join(f.output, 'folder', 'a'), 'keep')
    const plan = await f.plan(['/folder'])
    await f.commit(plan, { [plan.conflicts[0].entryId]: 'skip' })
    const response = await f.commitResponse(plan, { [plan.conflicts[0].entryId]: 'overwrite' })
    expect(response.json().code).toBe('DOWNLOAD_PLAN_USED')
    expect(f.manager.list()).toEqual([])
  })

  it('uses a distinct connection-changed code for a stale source plan', async () => {
    const f = await fixture()
    const plan = await f.plan()
    await f.session.disconnect()
    const response = await f.commitResponse(plan)
    expect(response.json().code).toBe('CONNECTION_CHANGED')
    expect(f.client.copyFileAsync).not.toHaveBeenCalled()
  })

  it('retries against the original source binding with fresh collision decisions and one idempotent successor', async () => {
    const f = await fixture(undefined, true)
    const original = await f.commit(await f.plan())
    await vi.waitFor(() => expect(f.jobs.size).toBe(1))
    Object.assign(f.jobs.get(1)!, { finished: true, success: false, error: 'Connection reset.' })
    await f.finish('error')
    await f.session.connect({
      config: { host: 'second', port: 22, username: 'test', authMethod: 'password' }
    })
    await writeFile(join(f.output, 'a.bin'), 'existing')
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/download/${original.transfers[0].id}/retry-plan`
    })
    expect(response.statusCode, response.body).toBe(200)
    const plan = response.json<DownloadPlan>()
    expect(plan.conflicts).toHaveLength(1)
    const successor = await f.commit(plan, { [plan.conflicts[0].entryId]: 'overwrite' })
    expect(await f.commit(plan, { [plan.conflicts[0].entryId]: 'overwrite' })).toEqual(successor)
    await vi.waitFor(() => expect(f.jobs.size).toBe(2))
    f.jobs.get(2)!.finished = true
    await f.finish()
    expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('fresh source')
    expect(f.manager.list()[0].retriedAs).toBe(successor.transfers[0].id)
    expect(successor.transfers[0].retryOf).toBe(original.transfers[0].id)
  })

  it('keeps legacy direct requests no-overwrite and identifies collisions without disconnect semantics', async () => {
    const f = await fixture()
    await writeFile(join(f.output, 'a.bin'), 'keep')
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/download',
      payload: { remotePath: '/a.bin', downloadDir: f.output, segments: 4 }
    })
    expect(response.json().code).toBe('DESTINATION_COLLISION')
    expect(f.manager.list()).toEqual([])
    expect(await readFile(join(f.output, 'a.bin'), 'utf8')).toBe('keep')
  })

  it('distinguishes an actually empty folder from an all-skipped admission', async () => {
    const f = await fixture({ folder: null, 'folder/empty': null })
    const admission = await f.commit(await f.plan(['/folder']))
    expect(admission).toEqual({ transfers: [], skipped: [], empty: true })
    expect(await readdir(f.output)).toEqual([])
    expect(f.client.deleteRemote).toHaveBeenCalledOnce()
  })

  it('retains a retry preview lease if the failed origin is removed, but refuses its admission', async () => {
    const f = await fixture(undefined, true)
    const original = await f.commit(await f.plan())
    await vi.waitFor(() => expect(f.jobs.size).toBe(1))
    Object.assign(f.jobs.get(1)!, { finished: true, success: false, error: 'Connection reset.' })
    await f.finish('error')
    const remote = f.client.copyFileAsync.mock.calls[0][0].srcFs.replace(/:$/, '')
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/download/${original.transfers[0].id}/retry-plan`
    })
    expect(response.statusCode).toBe(200)
    f.manager.remove(original.transfers[0].id)
    expect(f.client.deleteRemote).not.toHaveBeenCalledWith(remote)
    const rejected = await f.commitResponse(response.json<DownloadPlan>())
    expect(rejected.statusCode).toBe(404)
    expect(f.client.deleteRemote).toHaveBeenCalledWith(remote)
    expect(f.client.copyFileAsync).toHaveBeenCalledOnce()
  })

  it('recreates a removed retry parent only after safe admission', async () => {
    const f = await fixture({ 'folder/a': 'retry source' }, true)
    const admission = await f.commit(await f.plan(['/folder']))
    await vi.waitFor(() => expect(f.jobs.size).toBe(1))
    Object.assign(f.jobs.get(1)!, { finished: true, success: false, error: 'Connection reset.' })
    await f.finish('error')
    await rm(join(f.output, 'folder'), { recursive: true })
    const preview = await f.app.inject({
      method: 'POST',
      url: `/api/download/${admission.transfers[0].id}/retry-plan`
    })
    expect(preview.statusCode).toBe(200)
    await expect(lstat(join(f.output, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' })
    await f.commit(preview.json<DownloadPlan>())
    await vi.waitFor(() => expect(f.jobs.size).toBe(2))
    f.jobs.get(2)!.finished = true
    await f.finish()
    expect(await readFile(join(f.output, 'folder', 'a'), 'utf8')).toBe('retry source')
  })

  it('does not clean staging when copy submission fails with an uncertain backend outcome', async () => {
    const f = await fixture()
    f.client.copyFileAsync.mockImplementationOnce(async (input) => {
      await writeFile(join(input.dstFs, input.dstRemote), 'partial content')
      throw new Error('Lost submission response.')
    })
    const admission = await f.commit(await f.plan())
    await f.finish('error')
    const transfer = f.manager.list()[0]
    expect(transfer).toMatchObject({
      retryable: false,
      error: expect.stringContaining('may still be writing')
    })
    expect(f.manager.hasUncertainWriters()).toBe(true)
    expect(await readFile(join(transfer.recoveryPath!, 'payload'), 'utf8')).toBe('partial content')
    f.manager.remove(admission.transfers[0].id)
    expect(f.manager.hasUncertainWriters()).toBe(true)
    await f.commit(await f.plan())
    expect(f.client.copyFileAsync).toHaveBeenCalledOnce()
  })

  it('holds the final reservation and active status throughout asynchronous publication validation', async () => {
    const f = await fixture(undefined, true)
    const admission = await f.commit(await f.plan())
    await vi.waitFor(() => expect(f.jobs.size).toBe(1))
    let unblock!: () => void
    let checking = false
    const validate = f.validator.getMockImplementation()!
    f.validator.mockImplementationOnce(async (input) => {
      checking = true
      await new Promise<void>((resolve) => {
        unblock = resolve
      })
      return validate(input)
    })
    f.jobs.get(1)!.finished = true
    await vi.waitFor(() => expect(checking).toBe(true))
    expect(f.manager.remove(admission.transfers[0].id)).toBe(false)
    await f.commit(await f.plan())
    expect(f.manager.list()[1]).toMatchObject({
      status: 'queued',
      waitingReason: expect.any(String)
    })
    unblock()
    await f.finish()
    await f.finish('error')
    expect(f.client.copyFileAsync).toHaveBeenCalledOnce()
  })

  it('protects excluded paths even when they are inside an otherwise permitted download root', async () => {
    const f = await fixture()
    const protectedDir = join(f.output, 'protected')
    f.updates.protectedPaths.push(protectedDir)
    await mkdir(protectedDir)
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/download/plan',
      payload: { remotePaths: ['/a.bin'], downloadDir: protectedDir, segments: 4 }
    })
    expect(response.statusCode).toBe(400)
    expect(await readdir(protectedDir)).toEqual([])
    expect(f.manager.list()).toEqual([])
  })

  it.runIf(process.platform === 'win32')(
    'rejects case-insensitive intra-batch aliases on Windows',
    async () => {
      const f = await fixture({ 'left/A.bin': 'left', 'right/a.bin': 'right' })
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/download/plan',
        payload: {
          remotePaths: ['/left/A.bin', '/right/a.bin'],
          downloadDir: f.output,
          segments: 4
        }
      })
      expect(response.json().code).toBe('AMBIGUOUS_DESTINATION')
      expect(await readdir(f.output)).toEqual([])
      expect(f.manager.list()).toEqual([])
    }
  )

  it.runIf(process.platform === 'win32').each(['nul', 'file.', 'file:stream'])(
    'rejects the unsafe Windows filename %s before admission',
    async (name) => {
      const f = await fixture({ [name]: 'source' })
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/download/plan',
        payload: { remotePaths: [`/${name}`], downloadDir: f.output, segments: 4 }
      })
      expect(response.statusCode).toBe(400)
      expect(await readdir(f.output)).toEqual([])
      expect(f.manager.list()).toEqual([])
    }
  )

  it('bounds expanded folder plans without creating target directories or transfers', async () => {
    const f = await fixture({ 'folder/a': 'source' })
    f.client.listRecursiveEntries.mockResolvedValueOnce(
      Array.from({ length: 10_001 }, (_, index) => ({
        Path: `folder/${index}`,
        Name: String(index),
        Size: 1,
        ModTime: '',
        IsDir: false
      }))
    )
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/download/plan',
      payload: { remotePaths: ['/folder'], downloadDir: f.output, segments: 4 }
    })
    expect(response.statusCode).toBe(400)
    expect(await readdir(f.output)).toEqual([])
    expect(f.manager.list()).toEqual([])
    expect(f.client.deleteRemote).toHaveBeenCalledOnce()
  })

  it.each(['response limit', 'timeout'])(
    'releases planning leases without any writes when recursive listing fails its %s',
    async (reason) => {
      const f = await fixture({ 'folder/a': 'source' })
      const error =
        reason === 'response limit'
          ? Object.assign(
              new Error('The recursive folder listing exceeds the 32 MiB response limit.'),
              {
                statusCode: 400,
                code: 'DOWNLOAD_LIST_TOO_LARGE'
              }
            )
          : new Error('rclone operations/list timed out after 35s')
      f.client.listRecursiveEntries.mockRejectedValueOnce(error)
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/download/plan',
        payload: { remotePaths: ['/folder'], downloadDir: f.output, segments: 4 }
      })
      expect(response.statusCode).toBe(reason === 'response limit' ? 400 : 500)
      expect(response.json().message).toBe(error.message)
      expect(await readdir(f.output)).toEqual([])
      expect(f.manager.list()).toEqual([])
      expect(f.client.deleteRemote).toHaveBeenCalledOnce()
      expect(f.releaseAdmission).toHaveBeenCalledOnce()
    }
  )

  it('protects confined and excluded paths and rejects symlinked folder children', async () => {
    const f = await fixture({ 'folder/a': 'new' })
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await symlink(
      outside,
      join(f.output, 'folder'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    for (const downloadDir of [outside, f.updates.protectedPaths[0], f.output]) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/download/plan',
        payload: { remotePaths: ['/folder'], downloadDir, segments: 4 }
      })
      expect(response.statusCode).toBe(400)
    }
    expect(f.manager.list()).toEqual([])
    expect(await readdir(outside)).toEqual([])
  })

  it('resolves an allowed destination alias once and reserves the canonical final identity', async () => {
    const f = await fixture()
    const alias = join(f.root, 'alias')
    await symlink(f.output, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const plan = await f.plan(['/a.bin'], alias)
    const admitted = await f.commit(plan)
    expect(downloadDestinationKey(admitted.transfers[0].localPath)).toBe(
      downloadDestinationKey(join(f.output, 'a.bin'))
    )
    await f.finish()
  })
})
