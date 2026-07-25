import { describe, expect, it, vi } from 'vitest'
import {
  AuthAlreadyConfiguredError,
  AuthCurrentPasswordMismatchError,
  AuthPasswordChangeNotAllowedError,
  AuthService,
  hashPassword,
  verifyPassword
} from '../src/server/auth'
import type { AuthStoreState } from '../src/server/authStore'

function makeStore() {
  const writes: AuthStoreState[] = []
  return {
    writes,
    write: vi.fn(async (state: AuthStoreState) => {
      writes.push(state)
    })
  }
}

describe('AuthService', () => {
  it('transitions from setup to password mode and issues a session', async () => {
    const store = makeStore()
    const auth = new AuthService({
      startup: { mode: 'setup' },
      store,
      sessionTtlMs: 5_000
    })
    const sid = await auth.completeSetup({ username: 'admin', password: 'secret-pass' })
    expect(sid).toBeTruthy()
    expect(auth.state).toBe('password')
    expect(auth.canChangePassword).toBe(true)
    expect(auth.isValid(sid ?? undefined)).toBe(true)
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0].mode).toBe('password')
  })

  it('transitions from setup to open mode without issuing a session', async () => {
    const store = makeStore()
    const auth = new AuthService({
      startup: { mode: 'setup' },
      store,
      sessionTtlMs: 5_000
    })
    const sid = await auth.completeSetup({ mode: 'open' })
    expect(sid).toBeNull()
    expect(auth.state).toBe('open')
    expect(auth.canChangePassword).toBe(false)
    expect(store.writes).toEqual([{ mode: 'open' }])
  })

  it('rejects completeSetup when already configured', async () => {
    const store = makeStore()
    const auth = new AuthService({
      startup: {
        mode: 'password',
        username: 'admin',
        passwordHash: hashPassword('secret-pass'),
        canChangePassword: true
      },
      store,
      sessionTtlMs: 5_000
    })
    await expect(
      auth.completeSetup({ username: 'admin', password: 'secret-pass' })
    ).rejects.toBeInstanceOf(AuthAlreadyConfiguredError)
    expect(store.writes).toHaveLength(0)
  })

  it('changes password, revokes old sessions, and issues a new session', async () => {
    let now = 1_000
    const store = makeStore()
    const auth = new AuthService({
      startup: {
        mode: 'password',
        username: 'admin',
        passwordHash: hashPassword('old-password'),
        canChangePassword: true
      },
      store,
      sessionTtlMs: 10_000,
      now: () => now
    })
    const oldSid = await auth.login('admin', 'old-password')
    expect(oldSid).toBeTruthy()
    const newSid = await auth.changePassword('old-password', 'new-password')
    expect(newSid).toBeTruthy()
    expect(auth.isValid(oldSid ?? undefined)).toBe(false)
    expect(auth.isValid(newSid)).toBe(true)
    expect(await auth.login('admin', 'old-password')).toBeNull()
    expect(await auth.login('admin', 'new-password')).toBeTruthy()
    now += 11_000
    expect(auth.isValid(newSid)).toBe(false)
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0].mode).toBe('password')
  })

  it('rejects changePassword when password changes are disabled', async () => {
    const store = makeStore()
    const auth = new AuthService({
      startup: {
        mode: 'password',
        username: 'admin',
        passwordHash: hashPassword('env-password'),
        canChangePassword: false
      },
      store,
      sessionTtlMs: 5_000
    })
    await expect(auth.changePassword('env-password', 'new-password')).rejects.toBeInstanceOf(
      AuthPasswordChangeNotAllowedError
    )
    expect(store.writes).toHaveLength(0)
  })

  it('rejects changePassword when current password is wrong', async () => {
    const store = makeStore()
    const auth = new AuthService({
      startup: {
        mode: 'password',
        username: 'admin',
        passwordHash: hashPassword('env-password'),
        canChangePassword: true
      },
      store,
      sessionTtlMs: 5_000
    })
    await expect(auth.changePassword('wrong', 'new-password')).rejects.toBeInstanceOf(
      AuthCurrentPasswordMismatchError
    )
    expect(store.writes).toHaveLength(0)
  })

  it('allows only one concurrent completeSetup to succeed', async () => {
    let resolveFirstWrite: (() => void) | null = null
    const firstWriteGate = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve
    })
    let writeCount = 0
    const store = {
      write: vi.fn(async (_state: AuthStoreState) => {
        writeCount += 1
        if (writeCount === 1) await firstWriteGate
      })
    }
    const auth = new AuthService({
      startup: { mode: 'setup' },
      store,
      sessionTtlMs: 5_000
    })

    const first = auth.completeSetup({ username: 'admin', password: 'first-password' })
    await Promise.resolve()
    const second = auth.completeSetup({ username: 'admin', password: 'second-password' })
    resolveFirstWrite?.()

    const [firstResult, secondResult] = await Promise.allSettled([first, second])
    const fulfilled = [firstResult, secondResult].filter((result) => result.status === 'fulfilled')
    const rejected = [firstResult, secondResult].filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(writeCount).toBe(1)
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
