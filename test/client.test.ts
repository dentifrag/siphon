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
  return new RcloneClient({
    getEndpoint: () => ({
      baseUrl: 'http://127.0.0.1:5572',
      authHeader: 'Basic test'
    })
  } as unknown as RcloneSupervisor)
}

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
