import { randomBytes, timingSafeEqual } from 'node:crypto'

export class AuthService {
  private readonly sessions = new Set<string>()

  constructor(private readonly password: string | null) {}

  get enabled(): boolean {
    return this.password !== null && this.password.length > 0
  }

  login(password: string): string | null {
    if (!this.enabled || this.password === null) return null
    if (!safeEqual(password, this.password)) return null
    const sid = randomBytes(32).toString('base64url')
    this.sessions.add(sid)
    return sid
  }

  isValid(sid: string | undefined): boolean {
    if (!this.enabled) return true
    return Boolean(sid) && this.sessions.has(sid as string)
  }

  logout(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid)
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
