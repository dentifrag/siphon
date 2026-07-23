import { describe, expect, it, vi } from 'vitest'
import { expandUpload } from '../src/server/routes/uploads'
import type { RcloneClient } from '../src/server/rclone/client'
import type { RcloneDownloadManager, RcloneEnqueueInput } from '../src/server/rclone/downloadManager'
import type { TransferProgress } from '../src/shared/types'
import type { FsScope } from '../src/server/localFs'

const listFilesRecursive = vi.fn()

vi.mock('../src/server/localFs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/localFs')>()
  return { ...actual, listFilesRecursive: (...args: unknown[]) => listFilesRecursive(...args) }
})

function makeManager() {
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
  return { enqueue } as unknown as RcloneDownloadManager
}

const scope: FsScope = { roots: [{ name: 'root', path: '/root' }], confined: true }

describe('expandUpload', () => {
  it('enqueues one file transfer for a single file', async () => {
    const client = { deleteRemote: vi.fn() } as unknown as RcloneClient
    const manager = makeManager()

    const result = await expandUpload(client, manager, scope, {
      resolved: '/root/file.bin',
      isDir: false,
      size: 500,
      remoteDir: 'dest',
      segments: 4,
      jobRemote: '_ul-file'
    })

    expect(result).toHaveLength(1)
    expect(manager.enqueue).toHaveBeenCalledWith({
      srcFs: '/root',
      srcRemote: 'file.bin',
      dstFs: '_ul-file:',
      dstRemote: 'dest/file.bin',
      displayName: 'file.bin',
      localPath: '/root/file.bin',
      size: 500,
      segments: 4,
      direction: 'upload',
      cleanupRemote: '_ul-file'
    })
    expect(client.deleteRemote).not.toHaveBeenCalled()
  })

  it('enqueues one file transfer per recursively listed file in a directory, including nested paths', async () => {
    const client = { deleteRemote: vi.fn() } as unknown as RcloneClient
    const manager = makeManager()
    listFilesRecursive.mockResolvedValueOnce([
      { relPath: 'a.mkv', size: 10 },
      { relPath: 'sub/b.mkv', size: 20 }
    ])

    const result = await expandUpload(client, manager, scope, {
      resolved: '/root/movies',
      isDir: true,
      size: 0,
      remoteDir: 'dest',
      segments: 4,
      jobRemote: '_ul-dir'
    })

    expect(listFilesRecursive).toHaveBeenCalledWith(scope, '/root/movies')
    expect(result).toHaveLength(2)
    expect(manager.enqueue).toHaveBeenNthCalledWith(1, {
      srcFs: '/root/movies',
      srcRemote: 'a.mkv',
      dstFs: '_ul-dir:',
      dstRemote: 'dest/movies/a.mkv',
      displayName: 'movies/a.mkv',
      localPath: '/root/movies/a.mkv',
      size: 10,
      segments: 4,
      direction: 'upload',
      cleanupRemote: '_ul-dir'
    })
    expect(manager.enqueue).toHaveBeenNthCalledWith(2, {
      srcFs: '/root/movies',
      srcRemote: 'sub/b.mkv',
      dstFs: '_ul-dir:',
      dstRemote: 'dest/movies/sub/b.mkv',
      displayName: 'movies/sub/b.mkv',
      localPath: '/root/movies/sub/b.mkv',
      size: 20,
      segments: 4,
      direction: 'upload',
      cleanupRemote: '_ul-dir'
    })
    expect(client.deleteRemote).not.toHaveBeenCalled()
  })

  it('cleans up the cloned remote and returns an empty array when the directory has no files', async () => {
    const client = { deleteRemote: vi.fn().mockResolvedValue(undefined) } as unknown as RcloneClient
    const manager = makeManager()
    listFilesRecursive.mockResolvedValueOnce([])

    const result = await expandUpload(client, manager, scope, {
      resolved: '/root/empty',
      isDir: true,
      size: 0,
      remoteDir: 'dest',
      segments: 4,
      jobRemote: '_ul-empty'
    })

    expect(result).toEqual([])
    expect(client.deleteRemote).toHaveBeenCalledWith('_ul-empty')
    expect(manager.enqueue).not.toHaveBeenCalled()
  })

  it('cleans up the cloned remote and rethrows when listing the directory fails', async () => {
    const client = { deleteRemote: vi.fn().mockResolvedValue(undefined) } as unknown as RcloneClient
    const manager = makeManager()
    listFilesRecursive.mockRejectedValueOnce(new Error('boom'))

    await expect(
      expandUpload(client, manager, scope, {
        resolved: '/root/movies',
        isDir: true,
        size: 0,
        remoteDir: 'dest',
        segments: 4,
        jobRemote: '_ul-fail'
      })
    ).rejects.toThrow('boom')

    expect(client.deleteRemote).toHaveBeenCalledWith('_ul-fail')
    expect(manager.enqueue).not.toHaveBeenCalled()
  })

  it('produces a dstRemote with no leading slash when the remote cwd is the root', async () => {
    const client = { deleteRemote: vi.fn() } as unknown as RcloneClient
    const manager = makeManager()

    const result = await expandUpload(client, manager, scope, {
      resolved: '/root/file.bin',
      isDir: false,
      size: 500,
      remoteDir: '',
      segments: 4,
      jobRemote: '_ul-root'
    })

    expect(result).toHaveLength(1)
    const call = (manager.enqueue as unknown as { mock: { calls: RcloneEnqueueInput[][] } }).mock
      .calls[0][0]
    expect(call.dstRemote).toBe('file.bin')
  })
})
