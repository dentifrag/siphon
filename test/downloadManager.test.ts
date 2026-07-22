import { describe, expect, it, vi } from 'vitest'
import { RcloneDownloadManager } from '../src/server/rclone/downloadManager'
import type { RcloneClient } from '../src/server/rclone/client'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function enqueueInput(cleanupRemote?: string) {
  return {
    srcFs: 'dl:',
    srcRemote: 'file.bin',
    dstFs: '/out',
    dstRemote: 'file.bin',
    displayName: '/file.bin',
    localPath: '/out/file.bin',
    size: 100 * 1024 * 1024,
    segments: 4,
    cleanupRemote
  }
}

describe('RcloneDownloadManager cancellation race', () => {
  it('stops and cleans up a job that starts after the user already canceled', async () => {
    const startJob = deferred<number>()
    const jobStop = vi.fn().mockResolvedValue(undefined)
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const jobStatus = vi.fn().mockResolvedValue({ finished: false, success: false, error: '', id: 1 })

    const client = {
      coreStatsDelete: vi.fn().mockResolvedValue(undefined),
      coreStats: vi.fn().mockResolvedValue({ bytes: 0, transferring: [] }),
      copyFileAsync: vi.fn().mockReturnValue(startJob.promise),
      jobStop,
      jobStatus,
      deleteRemote
    } as unknown as RcloneClient

    const manager = new RcloneDownloadManager(client)
    const enqueued = manager.enqueue(enqueueInput('_dl-abc'))

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
