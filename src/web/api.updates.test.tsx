import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebApi } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('update WebApi network boundary', () => {
  it('sends bounded same-origin JSON requests with no caller-controlled install fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}))
    vi.stubGlobal('fetch', fetch)
    const api = createWebApi()
    await api.getUpdateStatus()
    await api.checkForUpdates()
    await api.installUpdate({ offerId: 'opaque-offer' })
    await api.getVersionHealth()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/updates/status',
      '/api/updates/check',
      '/api/updates/install',
      '/api/health'
    ])
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({ credentials: 'same-origin', signal: expect.any(AbortSignal) })
    }
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    expect(fetch.mock.calls[2][1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"offerId":"opaque-offer"}'
    })
  })

  it('surfaces a rejected install and never retries a mutation automatically', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: 'Transfers are active' }, { status: 409 })
    )
    vi.stubGlobal('fetch', fetch)
    await expect(createWebApi().installUpdate({ offerId: 'offer' })).rejects.toMatchObject({
      message: 'Transfers are active',
      status: 409
    })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
