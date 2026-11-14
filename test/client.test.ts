import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RECURSIVE_LIST_BYTES,
  MAX_RECURSIVE_LIST_ENTRIES,
  RECURSIVE_LIST_TIMEOUT_MS,
  RcloneClient
} from '../src/server/rclone/client'
import type { RcloneSupervisor } from '../src/server/rclone/supervisor'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function client() {
  const endpoint = {
    baseUrl: 'http://127.0.0.1:5572',
    authHeader: 'Basic test'
  }
  return new RcloneClient({
    getEndpoint: () => endpoint,
    isEndpointCurrent: (candidate: unknown) => candidate === endpoint
  } as unknown as RcloneSupervisor)
}

const copyInput = {
  srcFs: 'source:',
  srcRemote: 'file.bin',
  dstFs: '/out',
  dstRemote: 'file.bin',
  group: 'job-test',
  config: { MultiThreadStreams: 1, MultiThreadCutoff: '1B', MultiThreadChunkSize: '5242880B' }
}

describe('rclone job ownership', () => {
  it('rejects status and cancellation after the owning daemon ends without contacting its replacement', async () => {
    let endpoint = { baseUrl: 'http://127.0.0.1:5572', authHeader: 'Basic test' }
    const rc = new RcloneClient({
      getEndpoint: () => endpoint,
      isEndpointCurrent: (candidate: unknown) => candidate === endpoint
    } as unknown as RcloneSupervisor)
    const fetch = vi.fn(async () => Response.json({ jobid: 1, executeId: 'old-daemon' }))
    vi.stubGlobal('fetch', fetch)
    const job = await rc.copyFileAsync(copyInput)
    endpoint = { baseUrl: 'http://127.0.0.1:5573', authHeader: 'Basic test' }
    await expect(rc.jobStatus(job)).rejects.toThrow(/rclone.*(stopped|restarted)/i)
    await expect(rc.jobStop(job)).rejects.toThrow(/rclone.*(stopped|restarted)/i)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not accept an unrelated successful job from another rclone execution', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ jobid: 1, executeId: 'old-daemon' }))
        .mockResolvedValueOnce(
          Response.json({ id: 1, executeId: 'new-daemon', finished: true, success: true })
        )
    )
    const rc = client()
    const job = await rc.copyFileAsync(copyInput)
    await expect(rc.jobStatus(job)).rejects.toThrow(/rclone.*(stopped|restarted)/i)
  })

  it('supports older rclone without execution IDs and explicitly rejects an expired job', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ jobid: 1 }))
        .mockResolvedValueOnce(Response.json({ id: 1, finished: false, success: false, error: '' }))
        .mockResolvedValueOnce(Response.json({ error: 'job not found' }, { status: 500 }))
    )
    const rc = client()
    const job = await rc.copyFileAsync(copyInput)
    expect(await rc.jobStatus(job)).toMatchObject({ id: 1, finished: false })
    await expect(rc.jobStatus(job)).rejects.toMatchObject({ code: 'RCLONE_JOB_LOST' })
  })
})

describe('RcloneClient.listRecursiveEntries', () => {
  it('lists both files and directories so the destination tree can be created first', async () => {
    const entries = [
      { Path: 'movies/a.mkv', Size: 10, IsDir: false },
      { Path: 'movies/empty', Size: -1, IsDir: true }
    ]
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ list: entries }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(client().listRecursiveEntries('_dl-test:', 'movies')).resolves.toEqual(entries)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5572/operations/list',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Basic test',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fs: '_dl-test:',
          remote: 'movies',
          opt: { recurse: true, noModTime: true },
          _config: { ConnectTimeout: '15s', Timeout: '30s' }
        })
      })
    )
  })

  it.each([MAX_RECURSIVE_LIST_ENTRIES, MAX_RECURSIVE_LIST_ENTRIES + 1])(
    'enforces the exact entry limit for a response with %i entries',
    async (count) => {
      const entries = Array.from({ length: count }, (_, index) => ({
        Path: `movies/${index}`,
        IsDir: false
      }))
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ list: entries })))
      )
      const result = client().listRecursiveEntries('_dl-test:', 'movies')
      if (count === MAX_RECURSIVE_LIST_ENTRIES) {
        await expect(result).resolves.toEqual(entries)
      } else {
        await expect(result).rejects.toMatchObject({
          statusCode: 400,
          code: 'DOWNLOAD_LIST_TOO_LARGE'
        })
      }
    }
  )

  it('aborts an oversized chunked response before buffering or requesting any more bytes', async () => {
    let signal!: AbortSignal
    let pulls = 0
    const chunkSize = 4 * 1024 * 1024
    const maxChunks = MAX_RECURSIVE_LIST_BYTES / chunkSize
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        signal = init.signal!
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls++
                controller.enqueue(new Uint8Array(pulls <= maxChunks ? chunkSize : 1))
              }
            },
            { highWaterMark: 0 }
          )
        )
      })
    )

    await expect(client().listRecursiveEntries('_dl-test:', 'movies')).rejects.toMatchObject({
      statusCode: 400,
      code: 'DOWNLOAD_LIST_TOO_LARGE'
    })
    expect(pulls).toBe(maxChunks + 1)
    expect(signal.aborted).toBe(true)
  })

  it('accepts exactly the byte limit and decodes Unicode across response chunk boundaries', async () => {
    const entries = [{ Path: 'movies/caf\u00e9', IsDir: false }]
    const encoded = Buffer.from(JSON.stringify({ list: entries }))
    const chunks = [
      ...Array.from(encoded, (byte) => new Uint8Array([byte])),
      Buffer.alloc(MAX_RECURSIVE_LIST_BYTES - encoded.byteLength, ' ')
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk)
                controller.close()
              }
            })
          )
      )
    )
    await expect(client().listRecursiveEntries('_dl-test:', 'movies')).resolves.toEqual(entries)
  })

  it.each(['headers', 'body'] as const)('aborts a listing stalled during %s', async (phase) => {
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    let signal!: AbortSignal
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init: RequestInit) => {
        signal = init.signal!
        if (phase === 'headers') {
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Buffer.from('{"list":['))
                signal.addEventListener('abort', () => controller.error(signal.reason), {
                  once: true
                })
              }
            })
          )
        )
      })
    )

    const result = client().listRecursiveEntries('_dl-test:', 'movies')
    const assertion = expect(result).rejects.toThrow('rclone operations/list timed out after 35s')
    await Promise.resolve()
    timeout.abort(new DOMException('Timed out', 'TimeoutError'))
    await assertion
    expect(signal.aborted).toBe(true)
    expect(timeoutSpy).toHaveBeenCalledWith(RECURSIVE_LIST_TIMEOUT_MS)
  })

  it('preserves remote errors from a bounded error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'Permission denied' }), { status: 403 })
      )
    )
    await expect(client().listRecursiveEntries('_dl-test:', 'movies')).rejects.toThrow(
      'Permission denied'
    )
  })
})
