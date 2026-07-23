import { describe, expect, it } from 'vitest'
import { AuthService, hashPassword, verifyPassword } from '../src/server/auth'

describe('AuthService', () => {
  it('is passwordless when no secret is configured', () => {
    const auth = new AuthService({
      username: null,
      password: null,
      passwordHash: null,
      sessionTtlMs: 1_000
    })
    expect(auth.enabled).toBe(false)
    expect(auth.isValid(undefined)).toBe(true)
    expect(auth.login('admin', 'anything')).toBeNull()
  })

  it('authenticates with plaintext password and username', () => {
    let now = 1_000
    const auth = new AuthService({
      username: 'owner',
      password: 'secret',
      passwordHash: null,
      sessionTtlMs: 1_000,
      now: () => now
    })

    expect(auth.login('owner', 'secret')).toBeTruthy()
    expect(auth.login('owner', 'wrong')).toBeNull()
    expect(auth.login('other', 'secret')).toBeNull()
    expect(auth.login('nobody', 'bad')).toBeNull()

    const sid = auth.login('owner', 'secret')
    expect(sid).toBeTruthy()
    expect(auth.isValid(sid ?? undefined)).toBe(true)

    now += 1_100
    expect(auth.isValid(sid ?? undefined)).toBe(false)
  })

  it('removes sessions on logout', () => {
    const auth = new AuthService({
      username: 'owner',
      password: 'secret',
      passwordHash: null,
      sessionTtlMs: 60_000
    })
    const sid = auth.login('owner', 'secret')
    expect(sid).toBeTruthy()
    auth.logout(sid ?? undefined)
    expect(auth.isValid(sid ?? undefined)).toBe(false)
  })

  it('uses scrypt password hash when configured', () => {
    const stored = hashPassword('secret')
    const auth = new AuthService({
      username: 'owner',
      password: null,
      passwordHash: stored,
      sessionTtlMs: 1_000
    })
    expect(auth.login('owner', 'secret')).toBeTruthy()
    expect(auth.login('owner', 'wrong')).toBeNull()
  })

  it("defaults username to admin when auth is enabled and username isn't set", () => {
    const auth = new AuthService({
      username: null,
      password: 'secret',
      passwordHash: null,
      sessionTtlMs: 1_000
    })
    expect(auth.login('admin', 'secret')).toBeTruthy()
    expect(auth.login('owner', 'secret')).toBeNull()
  })
})

describe('verifyPassword', () => {
  it('round-trips a generated hash', () => {
    const stored = hashPassword('secret')
    expect(verifyPassword('secret', stored)).toBe(true)
  })

  it('rejects a tampered hash payload', () => {
    const stored = hashPassword('secret')
    const parts = stored.split('$')
    parts[5] = Buffer.from('tampered').toString('base64')
    expect(verifyPassword('secret', parts.join('$'))).toBe(false)
  })
})
