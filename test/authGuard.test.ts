import { describe, expect, it, vi } from 'vitest'
import { authGuard } from '../src/server/routes/auth'

interface ReplyCapture {
  statusCode: number | null
  payload: unknown
  headers: Record<string, string>
}

function makeReply(): { reply: any; capture: ReplyCapture } {
  const capture: ReplyCapture = { statusCode: null, payload: null, headers: {} }
  const reply = {
    header(key: string, value: string) {
      capture.headers[key] = value
      return reply
    },
    code(code: number) {
      capture.statusCode = code
      return reply
    },
    send(payload: unknown) {
      capture.payload = payload
      return reply
    }
  }
  return { reply, capture }
}

describe('authGuard', () => {
  it('blocks operational API routes during setup, but allows setup and auth-status', () => {
    const guard = authGuard({ state: 'setup', isValid: vi.fn(() => false) } as any)

    const doneSetup = vi.fn()
    const { reply: setupReply, capture: setupCapture } = makeReply()
    guard({ url: '/api/setup', cookies: {} } as any, setupReply, doneSetup)
    expect(doneSetup).toHaveBeenCalledOnce()
    expect(setupCapture.statusCode).toBeNull()

    const doneAuthStatus = vi.fn()
    const { reply: statusReply, capture: statusCapture } = makeReply()
    guard({ url: '/api/auth-status', cookies: {} } as any, statusReply, doneAuthStatus)
    expect(doneAuthStatus).toHaveBeenCalledOnce()
    expect(statusCapture.statusCode).toBeNull()

    const doneBlocked = vi.fn()
    const { reply: blockedReply, capture: blockedCapture } = makeReply()
    guard({ url: '/api/browse', cookies: {} } as any, blockedReply, doneBlocked)
    expect(doneBlocked).not.toHaveBeenCalled()
    expect(blockedCapture.statusCode).toBe(403)
    expect(blockedCapture.payload).toEqual({ error: 'Setup required' })
  })

  it('allows operational routes in open mode and rejects setup endpoint', () => {
    const guard = authGuard({ state: 'open', isValid: vi.fn(() => false) } as any)

    const doneBrowse = vi.fn()
    const { reply: browseReply, capture: browseCapture } = makeReply()
    guard({ url: '/api/browse', cookies: {} } as any, browseReply, doneBrowse)
    expect(doneBrowse).toHaveBeenCalledOnce()
    expect(browseCapture.statusCode).toBeNull()

    const doneSetup = vi.fn()
    const { reply: setupReply, capture: setupCapture } = makeReply()
    guard({ url: '/api/setup', cookies: {} } as any, setupReply, doneSetup)
    expect(doneSetup).not.toHaveBeenCalled()
    expect(setupCapture.statusCode).toBe(409)
    expect(setupCapture.payload).toEqual({ error: 'Already configured' })
  })

  it('requires a valid session in password mode for protected routes', () => {
    const guard = authGuard({ state: 'password', isValid: vi.fn((sid) => sid === 'valid') } as any)

    const doneUnauthed = vi.fn()
    const { reply: unauthReply, capture: unauthCapture } = makeReply()
    guard({ url: '/api/browse', cookies: {} } as any, unauthReply, doneUnauthed)
    expect(doneUnauthed).not.toHaveBeenCalled()
    expect(unauthCapture.statusCode).toBe(401)
    expect(unauthCapture.payload).toEqual({ error: 'Unauthorized' })

    const doneAuthed = vi.fn()
    const { reply: authedReply, capture: authedCapture } = makeReply()
    guard({ url: '/api/browse', cookies: { siphon_sid: 'valid' } } as any, authedReply, doneAuthed)
    expect(doneAuthed).toHaveBeenCalledOnce()
    expect(authedCapture.statusCode).toBeNull()
  })
})
