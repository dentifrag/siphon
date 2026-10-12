import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebApi } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('update WebApi network boundary', () => {
  it('allows an update check to cover both helper inspections and release metadata requests', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, options) =>
        new Promise<Response>((resolve, reject) => {
          const signal = options?.signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          window.setTimeout(() => resolve(Response.json({})), 50_000)
        })
    )
    vi.stubGlobal('fetch', fetch)
    const result = expect(createWebApi().checkForUpdates()).resolves.toEqual({})
    await vi.advanceTimersByTimeAsync(50_000)
    await result
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['status', 20_000],
    ['check', 60_000]
  ] as const)('reports a %s timeout explicitly without retrying', async (operation, timeout) => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options?.signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    vi.stubGlobal('fetch', fetch)
    const api = createWebApi()
    const request = operation === 'status' ? api.getUpdateStatus() : api.checkForUpdates()
    const result = expect(request).rejects.toThrow(`timed out after ${timeout / 1000} seconds`)
    await vi.advanceTimersByTimeAsync(timeout)
    await result
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves caller cancellation rather than reporting it as a timeout', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options?.signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const reason = new Error('Dialog closed')
    const result = expect(createWebApi().getUpdateStatus(controller.signal)).rejects.toBe(reason)
    controller.abort(reason)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])(
    'preserves explicit install acceptance %s without retrying',
    async (accepted) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ error: 'Update acceptance response', accepted }, { status: 503 })
      )
      vi.stubGlobal('fetch', fetch)
      await expect(createWebApi().installUpdate({ offerId: 'offer' })).rejects.toMatchObject({
        message: 'Update acceptance response',
        status: 503,
        accepted
      })
      expect(fetch).toHaveBeenCalledOnce()
    }
  )

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
