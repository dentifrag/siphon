import { describe, expect, it } from 'vitest'
import { LoginLimiter } from '../src/server/loginLimiter'

describe('LoginLimiter', () => {
  it('locks after max attempts and unlocks after lockout', () => {
    let now = 1_000
    const limiter = new LoginLimiter({
      maxAttempts: 3,
      lockoutMs: 15_000,
      now: () => now
    })

    limiter.recordFailure('1.2.3.4')
    limiter.recordFailure('1.2.3.4')
    expect(limiter.check('1.2.3.4').locked).toBe(false)

    limiter.recordFailure('1.2.3.4')
    const locked = limiter.check('1.2.3.4')
    expect(locked.locked).toBe(true)
    expect(locked.retryAfterMs).toBeGreaterThan(0)

    now += 14_999
    expect(limiter.check('1.2.3.4').locked).toBe(true)
    now += 1
    expect(limiter.check('1.2.3.4')).toEqual({ locked: false, retryAfterMs: 0 })
  })

  it('clears failures on success', () => {
    const limiter = new LoginLimiter({
      maxAttempts: 2,
      lockoutMs: 10_000
    })
    limiter.recordFailure('1.2.3.4')
    limiter.recordSuccess('1.2.3.4')
    expect(limiter.check('1.2.3.4')).toEqual({ locked: false, retryAfterMs: 0 })
  })

  it('can be disabled with maxAttempts set to zero', () => {
    const limiter = new LoginLimiter({
      maxAttempts: 0,
      lockoutMs: 10_000
    })
    for (let i = 0; i < 20; i++) limiter.recordFailure('1.2.3.4')
    expect(limiter.check('1.2.3.4')).toEqual({ locked: false, retryAfterMs: 0 })
  })

  it('bounds tracked entries by maxEntries', () => {
    let now = 1_000
    const limiter = new LoginLimiter({
      maxAttempts: 3,
      lockoutMs: 10_000,
      maxEntries: 3,
      now: () => now
    })

    limiter.recordFailure('a')
    now += 1
    limiter.recordFailure('b')
    now += 1
    limiter.recordFailure('c')
    now += 1
    limiter.recordFailure('d')

    expect(limiter.check('a')).toEqual({ locked: false, retryAfterMs: 0 })
    expect(limiter.check('b')).toEqual({ locked: false, retryAfterMs: 0 })
    expect(limiter.check('c')).toEqual({ locked: false, retryAfterMs: 0 })
    expect(limiter.check('d')).toEqual({ locked: false, retryAfterMs: 0 })
    limiter.recordFailure('a')
    limiter.recordFailure('a')
    expect(limiter.check('a').locked).toBe(false)
  })
})
