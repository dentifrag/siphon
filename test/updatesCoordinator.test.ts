import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateCapability, UpdateJob } from '../src/shared/api'
import type { TransferProgress } from '../src/shared/types'
import { createUpdateCoordinator } from '../src/server/updates'
import {
  assetName,
  coordinatorFixture,
  currentVersion,
  deferred,
  latestUrl,
  manifestName,
  releaseBase,
  releaseFixture,
  sha256,
  testDirectory
} from './fixtures/updates'

let directory: Awaited<ReturnType<typeof testDirectory>>
beforeEach(async () => {
  directory = await testDirectory()
})
afterEach(async () => {
  vi.useRealTimers()
  await directory.dispose()
})

async function journal(job: UpdateJob) {
  await writeFile(join(directory.dir, 'job.json'), JSON.stringify(job), 'utf8')
}

describe('update coordinator', () => {
  it('offers task recovery only for an accepted request whose verified task is idle', async () => {
    let taskIdle = true
    const schedule = vi.fn(async () => {
      taskIdle = false
    })
    const { updates } = await coordinatorFixture(directory.dir, {
      inspect: async () => ({ capability: { supported: true }, taskIdle }),
      schedule
    })
    expect((await updates.status()).canRetryTask).toBe(false)
    const offer = (await updates.check()).offer!
    const accepted = await updates.install(offer.id)
    expect(await updates.status()).toMatchObject({
      maintenance: true,
      canRetryTask: false
    })
    await expect(updates.retryAcceptedTask()).rejects.toMatchObject({ statusCode: 409 })
    expect(schedule).toHaveBeenCalledOnce()
    taskIdle = true
    expect((await updates.status()).canRetryTask).toBe(true)
    expect(await updates.retryAcceptedTask()).toMatchObject({ id: accepted.id })
    expect(schedule).toHaveBeenCalledTimes(2)
    expect((await updates.status()).canRetryTask).toBe(false)
    await journal({ ...accepted, phase: 'rolled-back', serviceHealth: 'healthy' })
    taskIdle = true
    expect(await updates.status()).toMatchObject({
      maintenance: false,
      canRetryTask: false
    })
  })

  it.each(['unsupported', 'failed'] as const)(
    'does not offer task recovery when idle inspection is %s',
    async (failure) => {
      let failInspection = false
      const { updates, schedule } = await coordinatorFixture(directory.dir, {
        inspect: async () => {
          if (failInspection && failure === 'failed') throw new Error('Inspector unavailable')
          return {
            capability: failInspection
              ? ({
                  supported: false,
                  reason: 'unsafe-install',
                  message: 'Installation cannot be trusted.'
                } satisfies UpdateCapability)
              : { supported: true },
            taskIdle: true
          }
        }
      })
      const offer = (await updates.check()).offer!
      await updates.install(offer.id)
      failInspection = true
      expect(await updates.status()).toMatchObject({
        maintenance: true,
        canRetryTask: false,
        capability: { supported: false }
      })
      await expect(updates.retryAcceptedTask()).rejects.toBeDefined()
      expect(schedule).toHaveBeenCalledOnce()
    }
  )

  it('does not offer recovery from a stale idle inspection while retry scheduling is active', async () => {
    const inspected = deferred<{ capability: UpdateCapability; taskIdle: boolean }>()
    const scheduled = deferred<void>()
    let holdInspection = false
    let holdScheduling = false
    const schedule = vi.fn(async () => {
      if (holdScheduling) await scheduled.promise
    })
    const { updates } = await coordinatorFixture(directory.dir, {
      inspect: async () => {
        if (holdInspection) return inspected.promise
        return { capability: { supported: true }, taskIdle: true }
      },
      schedule
    })
    const offer = (await updates.check()).offer!
    await updates.install(offer.id)
    holdInspection = true
    const staleStatus = updates.status()
    holdInspection = false
    holdScheduling = true
    const retry = updates.retryAcceptedTask()
    inspected.resolve({ capability: { supported: true }, taskIdle: true })
    expect(await staleStatus).toMatchObject({ maintenance: true, canRetryTask: false })
    scheduled.resolve()
    await retry
    expect(schedule).toHaveBeenCalledTimes(2)
    expect((await updates.status()).canRetryTask).toBe(true)
  })

  it('reports release metadata timeouts explicitly without leaving an installable offer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options?.signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const { updates, schedule } = await coordinatorFixture(directory.dir, { fetch })
    vi.useFakeTimers()
    const result = expect(updates.check()).resolves.toMatchObject({
      check: {
        state: 'error',
        error:
          'Release metadata request timed out after 15 seconds. Check connectivity to GitHub and try again.'
      },
      offer: null,
      canInstall: false,
      maintenance: false
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await result
    expect(fetch).toHaveBeenCalledOnce()
    expect(schedule).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['inspection', 'persistence'])(
    'proves a pre-acceptance %s rejection without reserving maintenance',
    async (failure) => {
      let taskIdle = true
      const { updates, schedule } = await coordinatorFixture(directory.dir, {
        inspect: async () => ({ capability: { supported: true }, taskIdle })
      })
      const offer = (await updates.check()).offer!
      if (failure === 'inspection') taskIdle = false
      else await mkdir(join(directory.dir, 'request.json'))
      await expect(updates.install(offer.id)).rejects.toMatchObject({
        statusCode: 503,
        accepted: false
      })
      expect(schedule).not.toHaveBeenCalled()
      expect(await updates.status()).toMatchObject({ maintenance: false, job: null })
      expect(updates.admitTransfer()()).toBeUndefined()
    }
  )

  it('reports persisted scheduling uncertainty as accepted rather than a proven rejection', async () => {
    const { updates } = await coordinatorFixture(directory.dir, {
      schedule: async () => {
        throw new Error('Scheduler response lost')
      }
    })
    const offer = (await updates.check()).offer!
    await expect(updates.install(offer.id)).rejects.toMatchObject({
      statusCode: 503,
      accepted: true
    })
    expect(await updates.status()).toMatchObject({
      maintenance: true,
      canInstall: false,
      job: { offerId: offer.id, phase: 'accepted' }
    })
    expect(() => updates.admitTransfer()).toThrow()
  })

  it('status is local, checks are explicit and bounded, and network failure revokes the offer', async () => {
    const { updates, fetch } = await coordinatorFixture(directory.dir)
    expect(await updates.status()).toMatchObject({
      currentVersion,
      offer: null,
      maintenance: false
    })
    expect(fetch).not.toHaveBeenCalled()
    const checked = await updates.check()
    expect(checked.offer).toMatchObject({ version: '1.10.0', protocolVersion: 1, sizeBytes: 100 })
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      latestUrl,
      `${releaseBase}/${manifestName}`
    ])
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
    }

    fetch.mockRejectedValueOnce(new Error('release unavailable'))
    await updates.check().catch(() => undefined)
    expect(await updates.status()).toMatchObject({
      check: { state: 'error', error: expect.any(String) },
      offer: null,
      canInstall: false
    })
  })

  it('reserves before the first install await, rejects duplicates, and persists the checked release', async () => {
    const scheduled = deferred<void>()
    const schedule = vi.fn<(request: unknown) => Promise<void>>(() => scheduled.promise)
    const { updates, fetch } = await coordinatorFixture(directory.dir, { schedule })
    const offer = (await updates.check()).offer!
    const first = updates.install(offer.id)
    const duplicate = updates.install(offer.id)
    await expect(duplicate).rejects.toMatchObject({ statusCode: 409 })
    expect(() => updates.admitTransfer()).toThrow()
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce())
    const request = JSON.parse(await readFile(join(directory.dir, 'request.json'), 'utf8'))
    expect(request).toMatchObject({
      id: expect.any(String),
      fromVersion: currentVersion,
      toVersion: offer.version,
      releaseTag: '1.10.0',
      protocolVersion: 1,
      assetName,
      assetUrl: `${releaseBase}/${assetName}`,
      sizeBytes: 100,
      sha256
    })
    expect(schedule.mock.calls[0][0]).toEqual(request)
    expect(fetch).toHaveBeenCalledTimes(2)
    scheduled.resolve()
    expect(await first).toMatchObject({ id: request.id, phase: 'accepted' })
    expect((await updates.status()).maintenance).toBe(true)
  })

  it('retains accepted intent across scheduler rejection and restart until authoritative reconciliation', async () => {
    const schedule = vi.fn<(request: unknown) => Promise<void>>(async () => {
      throw new Error('Scheduler response lost; task outcome unknown')
    })
    const { updates, options } = await coordinatorFixture(directory.dir, { schedule })
    const offer = (await updates.check()).offer!
    await updates.install(offer.id).catch(() => undefined)
    const request = JSON.parse(await readFile(join(directory.dir, 'request.json'), 'utf8'))
    expect(request).toMatchObject({ id: expect.any(String), toVersion: offer.version })
    const status = await updates.status()
    expect(status).toMatchObject({
      maintenance: true,
      canInstall: false,
      job: { id: request.id }
    })
    expect(status.job?.error ?? status.blockedReason).toMatch(/schedul|task|unknown|reconcil/i)
    expect(() => updates.admitTransfer()).toThrow()

    const restarted = await createUpdateCoordinator(options)
    const recovered = await restarted.status()
    expect(recovered).toMatchObject({
      maintenance: true,
      canInstall: false,
      job: { id: request.id }
    })
    expect(recovered.job?.error ?? recovered.blockedReason).toMatch(
      /schedul|task|unknown|reconcil/i
    )
    expect(() => restarted.admitTransfer()).toThrow()
    expect(schedule).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(directory.dir, 'request.json'), 'utf8'))).toEqual(request)

    await journal({ ...recovered.job!, phase: 'succeeded', serviceHealth: 'healthy' })
    expect((await restarted.status()).maintenance).toBe(false)
    expect(restarted.admitTransfer()()).toBeUndefined()
  })

  it('rejects a foreign manifest URL before issuing that network request', async () => {
    const { updates, fetch } = await coordinatorFixture(directory.dir)
    const release = releaseFixture()
    release.assets[1].browser_download_url = 'https://evil.example/manifest.json'
    fetch.mockResolvedValueOnce(Response.json(release))
    await updates.check().catch(() => undefined)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await updates.status()).toMatchObject({
      check: { state: 'error' },
      offer: null,
      canInstall: false
    })
  })

  it.each([
    ['download', 'queued'],
    ['download', 'downloading'],
    ['upload', 'queued'],
    ['upload', 'downloading']
  ] as const)('blocks %s %s transfers but permits finished history', async (direction, status) => {
    const { updates, transfers, schedule } = await coordinatorFixture(directory.dir)
    transfers.push({ direction, status } as TransferProgress)
    const offer = (await updates.check()).offer!
    expect((await updates.status()).canInstall).toBe(false)
    await expect(updates.install(offer.id)).rejects.toMatchObject({ statusCode: 409 })
    expect(schedule).not.toHaveBeenCalled()
    transfers[0].status = 'completed'
    expect((await updates.status()).canInstall).toBe(true)
    await expect(updates.install(offer.id)).resolves.toMatchObject({ toVersion: offer.version })
  })

  it('keeps an entire asynchronous enqueue admission busy until its finally release', async () => {
    const { updates, schedule } = await coordinatorFixture(directory.dir)
    const offer = (await updates.check()).offer!
    const release = updates.admitTransfer()
    expect((await updates.status()).canInstall).toBe(false)
    await expect(updates.install(offer.id)).rejects.toMatchObject({ statusCode: 409 })
    expect(schedule).not.toHaveBeenCalled()
    release()
    await expect(updates.install(offer.id)).resolves.toMatchObject({ phase: 'accepted' })
  })

  it('loads maintenance after restart and clears it only for a matching healthy terminal journal', async () => {
    const { updates, options, schedule } = await coordinatorFixture(directory.dir)
    const offer = (await updates.check()).offer!
    const job = await updates.install(offer.id)
    const restarted = await createUpdateCoordinator(options)
    expect((await restarted.status()).maintenance).toBe(true)
    expect(() => restarted.admitTransfer()).toThrow()
    expect(schedule).toHaveBeenCalledOnce()
    await journal({ ...job, id: 'stale-job', phase: 'succeeded', serviceHealth: 'healthy' })
    expect((await restarted.status()).maintenance).toBe(true)
    await journal({ ...job, phase: 'verifying-new', serviceHealth: 'unknown' })
    expect((await restarted.status()).maintenance).toBe(true)
    await journal({
      ...job,
      phase: 'rollback-failed',
      serviceHealth: 'unhealthy',
      error: 'restore failed'
    })
    expect((await restarted.status()).maintenance).toBe(true)
    await journal({ ...job, phase: 'rolled-back', serviceHealth: 'healthy' })
    expect(await restarted.status()).toMatchObject({
      maintenance: false,
      job: { id: job.id, phase: 'rolled-back' }
    })
    expect(restarted.admitTransfer()()).toBeUndefined()
  })

  it('does not silently unlock an accepted job without a worker journal', async () => {
    const { updates } = await coordinatorFixture(directory.dir)
    const offer = (await updates.check()).offer!
    await updates.install(offer.id)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000)
      expect((await updates.status()).maintenance).toBe(true)
      expect(() => updates.admitTransfer()).toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a status read of an older terminal job unlock a newer install reservation', async () => {
    const { updates } = await coordinatorFixture(directory.dir)
    const firstOffer = (await updates.check()).offer!
    const firstJob = await updates.install(firstOffer.id)
    await journal({ ...firstJob, phase: 'rolled-back', serviceHealth: 'healthy' })
    expect((await updates.status()).maintenance).toBe(false)
    const nextOffer = (await updates.check()).offer!
    const oldStatusRead = updates.status()
    const nextInstall = updates.install(nextOffer.id)
    await oldStatusRead
    expect(() => updates.admitTransfer()).toThrow()
    const nextJob = await nextInstall
    expect(nextJob.id).not.toBe(firstJob.id)
    expect((await updates.status()).maintenance).toBe(true)
  })

  it('explains unsupported installations without fetching or scheduling', async () => {
    const { updates, fetch, schedule } = await coordinatorFixture(directory.dir, {
      capability: {
        supported: false,
        reason: 'not-windows-service',
        message: 'Windows service required.'
      }
    })
    expect(await updates.status()).toMatchObject({
      capability: { supported: false, reason: 'not-windows-service' },
      canInstall: false
    })
    await updates.check().catch(() => undefined)
    await expect(updates.install('untrusted-offer')).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
  })
})
