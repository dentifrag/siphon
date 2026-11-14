import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebApi } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('download API transport', () => {
  it('notifies session expiry once but preserves ordinary password rejection errors', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' }, { status: 401 })
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' }, { status: 401 })
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'Current password is incorrect' }, { status: 401 })
      )
    vi.stubGlobal('fetch', fetch)
    const api = createWebApi()
    const expired = vi.fn()
    api.onSessionExpired(expired)
    await expect(api.disconnect()).rejects.toMatchObject({ status: 401 })
    await expect(api.disconnect()).rejects.toMatchObject({ status: 401 })
    await expect(api.changePassword('incorrect', 'new-password')).rejects.toThrow(
      'Current password is incorrect'
    )
    expect(expired).toHaveBeenCalledOnce()
  })

  it('ignores an old unauthorized response after a new successful sign-in', async () => {
    let finish!: (response: Response) => void
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' }, { status: 401 })
      )
    vi.stubGlobal('fetch', fetch)
    const api = createWebApi()
    const expired = vi.fn()
    api.onSessionExpired(expired)
    const oldRequest = api.disconnect()
    await api.login('admin', 'synthetic-password')
    finish(Response.json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' }, { status: 401 }))
    await expect(oldRequest).rejects.toMatchObject({ status: 401 })
    expect(expired).not.toHaveBeenCalled()
    await expect(api.disconnect()).rejects.toMatchObject({ status: 401 })
    expect(expired).toHaveBeenCalledOnce()
  })

  it('checks authentication when the transfer stream closes instead of silently retrying an expired session', async () => {
    const source = {
      onerror: null as (() => void) | null,
      onmessage: null,
      close: vi.fn(),
      readyState: 2
    }
    vi.stubGlobal(
      'EventSource',
      class {
        static CLOSED = 2
        constructor() {
          return source
        }
      }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          state: 'password',
          authenticated: false
        })
      )
    )
    const api = createWebApi()
    const expired = vi.fn()
    api.onSessionExpired(expired)
    const close = api.onDownloadUpdate(vi.fn())
    source.onerror?.()
    await vi.waitFor(() => expect(expired).toHaveBeenCalledOnce())
    expect(source.close).toHaveBeenCalledOnce()
    close()
  })

  it('waits before reopening a closed transfer stream while the session is still valid', async () => {
    vi.useFakeTimers()
    const created = vi.fn()
    vi.stubGlobal(
      'EventSource',
      class {
        static CLOSED = 2
        onerror: (() => void) | null = null
        onmessage = null
        readyState = 2
        close = vi.fn()
        constructor() {
          created()
          queueMicrotask(() => this.onerror?.())
        }
      }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ state: 'password', authenticated: true }))
    )
    const close = createWebApi().onDownloadUpdate(vi.fn())
    await vi.advanceTimersByTimeAsync(1000)
    expect(created).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(created).toHaveBeenCalledTimes(2)
    close()
    vi.useRealTimers()
  })

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
