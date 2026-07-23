import { scryptSync, timingSafeEqual } from 'node:crypto'

export interface ParsedScryptHash {
  n: number
  r: number
  p: number
  salt: Buffer
  expected: Buffer
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_SCRYPT_MEMORY = 32 * 1024 * 1024
const MAX_N = 2 ** 20
const MAX_R = 32
const MAX_P = 16

function decodeBase64(value: string): Buffer | null {
  if (!BASE64_RE.test(value) || value.length % 4 !== 0) return null
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0) return null
  if (decoded.toString('base64') !== value) return null
  return decoded
}

function isPowerOfTwo(value: number): boolean {
  if (!Number.isSafeInteger(value) || value < 1) return false
  let n = value
  while (n > 1) {
    if (n % 2 !== 0) return false
    n /= 2
  }
  return true
}

export function validateScryptParams(n: number, r: number, p: number): boolean {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false
  if (n <= 1 || r <= 0 || p <= 0) return false
  if (!isPowerOfTwo(n)) return false
  if (n > MAX_N || r > MAX_R || p > MAX_P) return false
  if (128 * n * r * p > MAX_SCRYPT_MEMORY) return false
  return true
}

export function parseScryptHash(stored: string): ParsedScryptHash | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) return null

  const n = Number.parseInt(parts[1], 10)
  const r = Number.parseInt(parts[2], 10)
  const p = Number.parseInt(parts[3], 10)
  if (!validateScryptParams(n, r, p)) return null

  const salt = decodeBase64(parts[4])
  const expected = decodeBase64(parts[5])
  if (!salt || !expected) return null

  return { n, r, p, salt, expected }
}

export function isScryptHashFormat(stored: string): boolean {
  return parseScryptHash(stored) !== null
}

export function verifyScryptPassword(plain: string, stored: string): boolean {
  const parsed = parseScryptHash(stored)
  if (!parsed) return false
  try {
    const actual = scryptSync(plain, parsed.salt, parsed.expected.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p
    })
    return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected)
  } catch {
    return false
  }
}
