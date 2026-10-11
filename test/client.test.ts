import { afterEach, describe, expect, it, vi } from 'vitest'
import { RcloneClient } from '../src/server/rclone/client'
import type { RcloneSupervisor } from '../src/server/rclone/supervisor'

afterEach(() => {
  vi.unstubAllGlobals()
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
    const supervisor = {
      getEndpoint: () => ({
        baseUrl: 'http://127.0.0.1:5572',
        authHeader: 'Basic test'
      })
    } as unknown as RcloneSupervisor
    const client = new RcloneClient(supervisor)

    await expect(client.listRecursiveEntries('_dl-test:', 'movies')).resolves.toEqual(entries)

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
          opt: { recurse: true, noModTime: true }
        })
      })
    )
  })
})
