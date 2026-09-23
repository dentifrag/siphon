import { afterEach, describe, expect, it, vi } from 'vitest'
import { RcloneClient } from '../src/server/rclone/client'
import type { RcloneSupervisor } from '../src/server/rclone/supervisor'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RcloneClient.copyDirAsync', () => {
  it('starts an asynchronous sync/copy job without deleting destination-only files', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobid: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const supervisor = {
      getEndpoint: () => ({
        baseUrl: 'http://127.0.0.1:5572',
        authHeader: 'Basic test'
      })
    } as unknown as RcloneSupervisor
    const client = new RcloneClient(supervisor)

    await expect(
      client.copyDirAsync({
        srcFs: '_dl-test:movies',
        dstFs: 'D:\\Downloads\\movies',
        group: 'job-test',
        config: {
          MultiThreadStreams: 4,
          MultiThreadCutoff: '1048576B',
          MultiThreadChunkSize: '5242880B',
          Transfers: 1
        }
      })
    ).resolves.toBe(42)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5572/sync/copy',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Basic test',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          srcFs: '_dl-test:movies',
          dstFs: 'D:\\Downloads\\movies',
          createEmptySrcDirs: true,
          _async: true,
          _group: 'job-test',
          _config: {
            MultiThreadStreams: 4,
            MultiThreadCutoff: '1048576B',
            MultiThreadChunkSize: '5242880B',
            Transfers: 1
          }
        })
      })
    )
  })
})
