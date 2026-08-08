import { describe, expect, it, vi } from 'vitest'
import { expandDownload } from '../src/server/routes/downloads'
import type { RcloneClient, RcloneListEntry } from '../src/server/rclone/client'
import type {
  RcloneDownloadManager,
  RcloneEnqueueInput
} from '../src/server/rclone/downloadManager'
import type { TransferProgress } from '../src/shared/types'

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
      status: 'queued'
    }
  })
  return { enqueue } as unknown as RcloneDownloadManager
}

function listEntry(path: string, size: number, isDir = false): RcloneListEntry {
  return { Path: path, Name: path, Size: size, ModTime: '', IsDir: isDir }
}

describe('expandDownload', () => {
  it('enqueues one file transfer per recursively listed entry, including nested paths', async () => {
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const listRecursiveFiles = vi
      .fn()
      .mockResolvedValue([
        listEntry('media/movies/a.mkv', 10),
        listEntry('media/movies/sub/b.mkv', 20)
      ])
    const client = { listRecursiveFiles, deleteRemote } as unknown as RcloneClient
    const manager = makeManager()

    const result = await expandDownload(client, manager, {
      item: listEntry('media/movies', -1, true),
      remotePath: '/media/movies',
      dirPath: 'media/movies',
      wrappingName: 'movies',
      targetDir: '/out',
      segments: 4,
      jobRemote: '_dl-abc'
    })

    expect(listRecursiveFiles).toHaveBeenCalledWith('_dl-abc:', 'media/movies')
    expect(result).toHaveLength(2)
    expect(manager.enqueue).toHaveBeenNthCalledWith(1, {
      srcFs: '_dl-abc:',
      srcRemote: 'media/movies/a.mkv',
      dstFs: '/out',
      dstRemote: 'movies/a.mkv',
      displayName: 'movies/a.mkv',
      localPath: '/out/movies/a.mkv',
      size: 10,
      segments: 4,
      cleanupRemote: '_dl-abc'
    })
    expect(manager.enqueue).toHaveBeenNthCalledWith(2, {
      srcFs: '_dl-abc:',
      srcRemote: 'media/movies/sub/b.mkv',
      dstFs: '/out',
      dstRemote: 'movies/sub/b.mkv',
      displayName: 'movies/sub/b.mkv',
      localPath: '/out/movies/sub/b.mkv',
      size: 20,
      segments: 4,
      cleanupRemote: '_dl-abc'
    })
    expect(deleteRemote).not.toHaveBeenCalled()
  })

  it('cleans up the cloned remote and returns an empty array when the directory has no files', async () => {
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const listRecursiveFiles = vi.fn().mockResolvedValue([])
    const client = { listRecursiveFiles, deleteRemote } as unknown as RcloneClient
    const manager = makeManager()

    const result = await expandDownload(client, manager, {
      item: listEntry('empty', -1, true),
      remotePath: '/empty',
      dirPath: 'empty',
      wrappingName: 'empty',
      targetDir: '/out',
      segments: 4,
      jobRemote: '_dl-empty'
    })

    expect(result).toEqual([])
    expect(deleteRemote).toHaveBeenCalledWith('_dl-empty')
    expect(manager.enqueue).not.toHaveBeenCalled()
  })

  it('cleans up the cloned remote and rethrows when listing the directory fails', async () => {
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const listRecursiveFiles = vi.fn().mockRejectedValue(new Error('boom'))
    const client = { listRecursiveFiles, deleteRemote } as unknown as RcloneClient
    const manager = makeManager()

    await expect(
      expandDownload(client, manager, {
        item: listEntry('movies', -1, true),
        remotePath: '/movies',
        dirPath: 'movies',
        wrappingName: 'movies',
        targetDir: '/out',
        segments: 4,
        jobRemote: '_dl-fail'
      })
    ).rejects.toThrow('boom')

    expect(deleteRemote).toHaveBeenCalledWith('_dl-fail')
    expect(manager.enqueue).not.toHaveBeenCalled()
  })

  it('rejects recursive entries outside the selected directory', async () => {
    const deleteRemote = vi.fn().mockResolvedValue(undefined)
    const listRecursiveFiles = vi.fn().mockResolvedValue([listEntry('other/file.bin', 10)])
    const client = { listRecursiveFiles, deleteRemote } as unknown as RcloneClient
    const manager = makeManager()

    await expect(
      expandDownload(client, manager, {
        item: listEntry('movies', -1, true),
        remotePath: '/movies',
        dirPath: 'movies',
        wrappingName: 'movies',
        targetDir: '/out',
        segments: 4,
        jobRemote: '_dl-invalid'
      })
    ).rejects.toThrow('Recursive listing returned a file outside the requested directory.')

    expect(deleteRemote).toHaveBeenCalledWith('_dl-invalid')
    expect(manager.enqueue).not.toHaveBeenCalled()
  })

  it('enqueues a single file transfer and returns an array of length 1 for a non-directory item', async () => {
    const client = {
      listRecursiveFiles: vi.fn(),
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const manager = makeManager()

    const result = await expandDownload(client, manager, {
      item: listEntry('downloads/file.bin', 500),
      remotePath: '/downloads/file.bin',
      dirPath: 'downloads/file.bin',
      wrappingName: 'file.bin',
      targetDir: '/out',
      segments: 4,
      jobRemote: '_dl-file'
    })

    expect(result).toHaveLength(1)
    expect(manager.enqueue).toHaveBeenCalledWith({
      srcFs: '_dl-file:',
      srcRemote: 'downloads/file.bin',
      dstFs: '/out',
      dstRemote: 'file.bin',
      displayName: '/downloads/file.bin',
      localPath: '/out/file.bin',
      size: 500,
      segments: 4,
      cleanupRemote: '_dl-file'
    })
    expect(client.listRecursiveFiles).not.toHaveBeenCalled()
    expect(client.deleteRemote).not.toHaveBeenCalled()
  })
})
