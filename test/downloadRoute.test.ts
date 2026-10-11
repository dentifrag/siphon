import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expandDownload } from '../src/server/routes/downloads'
import type { RcloneClient, RcloneListEntry } from '../src/server/rclone/client'
import type {
  RcloneDownloadManager,
  RcloneEnqueueInput
} from '../src/server/rclone/downloadManager'
import type { TransferProgress } from '../src/shared/types'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: vi.fn()
}))

beforeEach(() => {
  vi.mocked(mkdir).mockReset().mockResolvedValue(undefined)
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
      status: 'queued'
    }
  })
  return { enqueue } as unknown as RcloneDownloadManager
}

function listEntry(path: string, size: number, isDir = false): RcloneListEntry {
  return { Path: path, Name: path, Size: size, ModTime: '', IsDir: isDir }
}

function downloadInput() {
  return {
    item: listEntry('media/movies', -1, true),
    remotePath: '/media/movies',
    dirPath: 'media/movies',
    wrappingName: 'movies',
    targetDir: '/out',
    segments: 4,
    jobRemote: '_dl-test'
  }
}

function makeClient(entries: RcloneListEntry[] = []) {
  return {
    listRecursiveEntries: vi.fn().mockResolvedValue(entries),
    deleteRemote: vi.fn().mockResolvedValue(undefined)
  } as unknown as RcloneClient
}

describe('expandDownload', () => {
  it('creates the folder tree before queuing each file with its own size and stream limit', async () => {
    const client = makeClient([
      listEntry('media/movies/a.mkv', 10),
      listEntry('media/movies/sub', -1, true),
      listEntry('media/movies/sub/b.mkv', 20),
      listEntry('media/movies/empty', -1, true)
    ])
    const manager = makeManager()

    const result = await expandDownload(client, manager, downloadInput())

    expect(client.listRecursiveEntries).toHaveBeenCalledWith('_dl-test:', 'media/movies')
    expect(mkdir).toHaveBeenCalledWith(join('/out', 'movies'), { recursive: true })
    expect(mkdir).toHaveBeenCalledWith(join('/out', 'movies', 'sub'), { recursive: true })
    expect(mkdir).toHaveBeenCalledWith(join('/out', 'movies', 'empty'), { recursive: true })
    const lastMkdirCall = vi.mocked(mkdir).mock.invocationCallOrder.at(-1)!
    expect(lastMkdirCall).toBeLessThan(vi.mocked(manager.enqueue).mock.invocationCallOrder[0]!)
    expect(result).toHaveLength(2)
    expect(manager.enqueue).toHaveBeenNthCalledWith(1, {
      srcFs: '_dl-test:',
      srcRemote: 'media/movies/a.mkv',
      dstFs: join('/out', 'movies'),
      dstRemote: 'a.mkv',
      displayName: 'movies/a.mkv',
      localPath: join('/out', 'movies', 'a.mkv'),
      size: 10,
      segments: 4,
      cleanupRemote: '_dl-test'
    })
    expect(manager.enqueue).toHaveBeenNthCalledWith(2, {
      srcFs: '_dl-test:',
      srcRemote: 'media/movies/sub/b.mkv',
      dstFs: join('/out', 'movies'),
      dstRemote: 'sub/b.mkv',
      displayName: 'movies/sub/b.mkv',
      localPath: join('/out', 'movies', 'sub', 'b.mkv'),
      size: 20,
      segments: 4,
      cleanupRemote: '_dl-test'
    })
    expect(client.deleteRemote).not.toHaveBeenCalled()
  })

  it('waits for destination creation to finish before starting any transfers', async () => {
    let finishMkdir!: () => void
    vi.mocked(mkdir).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishMkdir = () => resolve(undefined)
        })
    )
    const client = makeClient([listEntry('media/movies/a.mkv', 10)])
    const manager = makeManager()

    const result = expandDownload(client, manager, downloadInput())
    await vi.waitFor(() => expect(mkdir).toHaveBeenCalled())
    expect(manager.enqueue).not.toHaveBeenCalled()
    finishMkdir()

    expect(await result).toHaveLength(1)
  })

  it('cleans up the cloned remote and queues nothing if a folder cannot be created', async () => {
    const error = new Error('Permission denied')
    vi.mocked(mkdir).mockRejectedValueOnce(error)
    const client = makeClient([listEntry('media/movies/a.mkv', 10)])
    const manager = makeManager()

    await expect(expandDownload(client, manager, downloadInput())).rejects.toBe(error)
    expect(client.deleteRemote).toHaveBeenCalledWith('_dl-test')
    expect(manager.enqueue).not.toHaveBeenCalled()
  })

  it.each([
    ['media//movies', '/media//movies'],
    ['media/movies/', '/media/movies/'],
    ['/media/movies', '/media/movies']
  ])('normalizes %s before recursively listing a directory', async (dirPath, remotePath) => {
    const client = makeClient([listEntry('media/movies/a.mkv', 10)])
    const manager = makeManager()

    const result = await expandDownload(client, manager, {
      ...downloadInput(),
      dirPath,
      remotePath
    })

    expect(client.listRecursiveEntries).toHaveBeenCalledWith('_dl-test:', 'media/movies')
    expect(result).toHaveLength(1)
    expect(manager.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        srcFs: '_dl-test:',
        srcRemote: 'media/movies/a.mkv',
        dstFs: join('/out', 'movies'),
        dstRemote: 'a.mkv',
        localPath: join('/out', 'movies', 'a.mkv')
      })
    )
  })

  it.each([{ entries: [] }, { entries: [listEntry('media/movies/empty', -1, true)] }])(
    'cleans up and returns an empty array when the directory has no files ($entries)',
    async ({ entries }) => {
      const client = makeClient(entries)
      const manager = makeManager()

      expect(await expandDownload(client, manager, downloadInput())).toEqual([])
      expect(client.deleteRemote).toHaveBeenCalledWith('_dl-test')
      expect(manager.enqueue).not.toHaveBeenCalled()
      expect(mkdir).not.toHaveBeenCalled()
    }
  )

  it('cleans up the cloned remote and rethrows when listing the directory fails', async () => {
    const client = makeClient()
    vi.mocked(client.listRecursiveEntries).mockRejectedValue(new Error('boom'))
    const manager = makeManager()

    await expect(expandDownload(client, manager, downloadInput())).rejects.toThrow('boom')
    expect(client.deleteRemote).toHaveBeenCalledWith('_dl-test')
    expect(manager.enqueue).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('rejects recursive entries outside the selected directory before creating folders', async () => {
    const client = makeClient([listEntry('other/file.bin', 10)])
    const manager = makeManager()

    await expect(expandDownload(client, manager, downloadInput())).rejects.toThrow(
      'Recursive listing returned a file outside the requested directory.'
    )
    expect(client.deleteRemote).toHaveBeenCalledWith('_dl-test')
    expect(manager.enqueue).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it.each([
    listEntry('media/movies/../../../../etc/passwd', 10),
    listEntry('media/movies/../../escape', -1, true)
  ])('validates the entire tree before creating folders (%j)', async (unsafeEntry) => {
    const client = makeClient([listEntry('media/movies/a.mkv', 10), unsafeEntry])
    const manager = makeManager()

    await expect(expandDownload(client, manager, downloadInput())).rejects.toThrow(
      'Recursive listing returned an unsafe file path.'
    )
    expect(client.deleteRemote).toHaveBeenCalledWith('_dl-test')
    expect(manager.enqueue).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it.each(['../escape.bin', '/etc/passwd'])(
    'rejects unsafe entries when listing the remote root (%s)',
    async (unsafePath) => {
      const client = makeClient([listEntry(unsafePath, 10)])
      const manager = makeManager()

      await expect(
        expandDownload(client, manager, {
          ...downloadInput(),
          item: listEntry('', -1, true),
          remotePath: '/',
          dirPath: '',
          wrappingName: 'root'
        })
      ).rejects.toThrow('Recursive listing returned an unsafe file path.')
      expect(client.deleteRemote).toHaveBeenCalledWith('_dl-test')
      expect(manager.enqueue).not.toHaveBeenCalled()
      expect(mkdir).not.toHaveBeenCalled()
    }
  )

  it('accepts dots inside a filename', async () => {
    const client = makeClient([listEntry('media/movies/..bashrc', 10)])
    const manager = makeManager()

    expect(await expandDownload(client, manager, downloadInput())).toHaveLength(1)
    expect(manager.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        srcRemote: 'media/movies/..bashrc',
        dstRemote: '..bashrc',
        localPath: join('/out', 'movies', '..bashrc')
      })
    )
  })

  it('enqueues an individual file without listing or creating folders', async () => {
    const client = makeClient()
    const manager = makeManager()

    const result = await expandDownload(client, manager, {
      ...downloadInput(),
      item: listEntry('downloads/file.bin', 500),
      remotePath: '/downloads/file.bin',
      dirPath: 'downloads/file.bin',
      wrappingName: 'file.bin'
    })

    expect(result).toHaveLength(1)
    expect(manager.enqueue).toHaveBeenCalledWith({
      srcFs: '_dl-test:',
      srcRemote: 'downloads/file.bin',
      dstFs: '/out',
      dstRemote: 'file.bin',
      displayName: '/downloads/file.bin',
      localPath: join('/out', 'file.bin'),
      size: 500,
      segments: 4,
      cleanupRemote: '_dl-test'
    })
    expect(client.listRecursiveEntries).not.toHaveBeenCalled()
    expect(client.deleteRemote).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })
})
