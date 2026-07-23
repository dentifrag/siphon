import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/server/auth'
import { isScryptHashFormat, parseScryptHash, validateScryptParams } from '../src/server/passwordHash'

describe('passwordHash parsing and validation', () => {
  it('rejects non-power-of-two N values, including large safe integers', () => {
    expect(validateScryptParams(3, 8, 1)).toBe(false)
    expect(validateScryptParams(2 ** 32 + 1, 8, 1)).toBe(false)
  })

  it('rejects param fields with non-decimal characters', () => {
    expect(parseScryptHash('scrypt$16384junk$8$1$QQ==$QQ==')).toBeNull()
    expect(parseScryptHash('scrypt$16384$8.5$1$QQ==$QQ==')).toBeNull()
    expect(parseScryptHash('scrypt$16384$8$1x$QQ==$QQ==')).toBeNull()
  })

  it('accepts generated hashes and verifies password', () => {
    const stored = hashPassword('secret-pass')
    expect(isScryptHashFormat(stored)).toBe(true)
    expect(verifyPassword('secret-pass', stored)).toBe(true)
  })
})
