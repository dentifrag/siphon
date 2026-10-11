import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { expandDownload } from '../src/server/routes/downloads'
import type { RcloneClient, RcloneListEntry } from '../src/server/rclone/client'
import type {
  RcloneDownloadManager,
  RcloneEnqueueInput
} from '../src/server/rclone/downloadManager'
import type { TransferProgress } from '../src/shared/types'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: vi.fn().mockResolvedValue(undefined)
}))

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
  return {
    enqueue,
    enqueueBatch: (inputs: RcloneEnqueueInput[]) => inputs.map((input) => enqueue(input))
  } as unknown as RcloneDownloadManager
}

function listEntry(path: string, isDir = false): RcloneListEntry {
  return {
    Path: path,
    Name: path,
    Size: isDir ? -1 : 100 * 1024 * 1024,
    ModTime: '',
    IsDir: isDir
  }
}

describe('download expansion segment requests', () => {
  it('forwards eight requested segments when expanding a single file', async () => {
    const client = {
      listRecursiveEntries: vi.fn(),
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const manager = makeManager()
    const targetDir = join('downloads', 'target')

    const result = await expandDownload(client, manager, {
      item: listEntry('media/file.bin'),
      remotePath: '/media/file.bin',
      dirPath: 'media/file.bin',
      wrappingName: 'file.bin',
      targetDir,
      segments: 8,
      jobRemote: '_dl-file'
    })

    expect(manager.enqueue).toHaveBeenCalledTimes(1)
    expect(manager.enqueue).toHaveBeenCalledWith({
      srcFs: '_dl-file:',
      srcRemote: 'media/file.bin',
      dstFs: targetDir,
      dstRemote: 'file.bin',
      displayName: '/media/file.bin',
      localPath: join(targetDir, 'file.bin'),
      size: 100 * 1024 * 1024,
      segments: 8,
      cleanupRemote: '_dl-file'
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ status: 'queued', segments: 8 })
    expect(client.listRecursiveEntries).not.toHaveBeenCalled()
    expect(client.deleteRemote).not.toHaveBeenCalled()
  })

  it('forwards eight requested segments to every recursively expanded directory file', async () => {
    const client = {
      listRecursiveEntries: vi
        .fn()
        .mockResolvedValue([listEntry('media/folder/a.bin'), listEntry('media/folder/sub/b.bin')]),
      deleteRemote: vi.fn()
    } as unknown as RcloneClient
    const manager = makeManager()
    const targetDir = join('downloads', 'target')

    const result = await expandDownload(client, manager, {
      item: listEntry('media/folder', true),
      remotePath: '/media/folder',
      dirPath: 'media/folder',
      wrappingName: 'folder',
      targetDir,
      segments: 8,
      jobRemote: '_dl-folder'
    })

    expect(client.listRecursiveEntries).toHaveBeenCalledTimes(1)
    expect(client.listRecursiveEntries).toHaveBeenCalledWith('_dl-folder:', 'media/folder')
    expect(manager.enqueue).toHaveBeenCalledTimes(2)
    for (const [index, relativePath] of ['a.bin', 'sub/b.bin'].entries()) {
      expect(manager.enqueue).toHaveBeenNthCalledWith(index + 1, {
        srcFs: '_dl-folder:',
        srcRemote: `media/folder/${relativePath}`,
        dstFs: join(targetDir, 'folder'),
        dstRemote: relativePath,
        displayName: `folder/${relativePath}`,
        localPath: join(targetDir, 'folder', relativePath),
        size: 100 * 1024 * 1024,
        segments: 8,
        cleanupRemote: '_dl-folder'
      })
    }
    expect(result.map(({ segments }) => segments)).toEqual([8, 8])
    expect(client.deleteRemote).not.toHaveBeenCalled()
  })
})
