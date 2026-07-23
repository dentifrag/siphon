import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const DEFAULT_N = 16_384
const DEFAULT_R = 8
const DEFAULT_P = 1
const DEFAULT_KEY_LEN = 32
const DEFAULT_SALT_LEN = 16

export function hashToken(input: string): Buffer {
  return createHash('sha256').update(input).digest()
}

export function safeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(hashToken(a), hashToken(b))
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(DEFAULT_SALT_LEN)
  const hash = scryptSync(plain, salt, DEFAULT_KEY_LEN, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P
  })
  return `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false

    const n = Number.parseInt(parts[1], 10)
    const r = Number.parseInt(parts[2], 10)
    const p = Number.parseInt(parts[3], 10)
    if (!Number.isInteger(n) || n <= 1) return false
    if (!Number.isInteger(r) || r <= 0) return false
    if (!Number.isInteger(p) || p <= 0) return false

    const salt = Buffer.from(parts[4], 'base64')
    const expected = Buffer.from(parts[5], 'base64')
    if (salt.length === 0 || expected.length === 0) return false

    const actual = scryptSync(plain, salt, expected.length, { N: n, r, p })
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export interface AuthServiceOptions {
  username: string | null
  password: string | null
  passwordHash: string | null
  sessionTtlMs: number
  now?: () => number
}

export class AuthService {
  private readonly sessions = new Map<string, number>()
  private readonly now: () => number

  constructor(
    private readonly options: AuthServiceOptions
  ) {
    this.now = options.now ?? Date.now
  }

  get enabled(): boolean {
    return Boolean(this.options.password) || Boolean(this.options.passwordHash)
  }

  login(username: string, password: string): string | null {
    if (!this.enabled) return null

    const expectedUser = this.options.username ?? 'admin'
    const expectedPassword = this.options.password ?? ''

    const userOk = safeEqualStr(username, expectedUser)
    const passOk = this.options.passwordHash
      ? verifyPassword(password, this.options.passwordHash)
      : safeEqualStr(password, expectedPassword)

    if (!(userOk && passOk)) return null

    this.pruneExpired(this.now())
    const sid = randomBytes(32).toString('base64url')
    this.sessions.set(sid, this.now() + this.options.sessionTtlMs)
    return sid
  }

  isValid(sid: string | undefined): boolean {
    if (!this.enabled) return true
    if (!sid) return false

    const now = this.now()
    this.pruneExpired(now)
    const expiresAt = this.sessions.get(sid)
    if (!expiresAt) return false
    if (expiresAt <= now) {
      this.sessions.delete(sid)
      return false
    }
    return true
  }

  logout(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid)
  }

  private pruneExpired(now: number): void {
    for (const [sid, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(sid)
    }
  }
}
