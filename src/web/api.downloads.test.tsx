import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebApi } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('download API transport', () => {
  it.each([
    'CONNECTION_CHANGED',
    'DESTINATION_COLLISION',
    'DESTINATION_BUSY',
    'DESTINATION_CHANGED',
    'DOWNLOAD_PLAN_EXPIRED'
  ])('preserves the machine-readable %s code on HTTP 409', async (code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'Visible failure', code }), { status: 409 })
      )
    )
    await expect(
      createWebApi().commitDownload({ planId: 'plan', decisions: {} })
    ).rejects.toMatchObject({ message: 'Visible failure', status: 409, code })
  })

  it('uses separate plan, commit, release and original-transfer retry-plan endpoints', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const api = createWebApi()
    const input = {
      remotePaths: ['/a', '/b'],
      downloadDir: 'D:\\Downloads',
      segments: 4,
      connectionRevision: 'revision'
    }
    await api.planDownload(input)
    await api.commitDownload({ planId: 'plan', decisions: { entry: 'overwrite' } })
    await api.releaseDownloadPlan('plan')
    await api.planDownloadRetry('failed transfer')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/download/plan',
      '/api/download/commit',
      '/api/download/plan/plan/release',
      '/api/download/failed%20transfer/retry-plan'
    ])
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/download/plan',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(input)
      })
    )
  })
})
