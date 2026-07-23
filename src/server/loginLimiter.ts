interface LoginLimiterEntry {
  fails: number
  lockedUntil: number
  last: number
}

export interface LoginLimiterOptions {
  maxAttempts: number
  lockoutMs: number
  maxEntries?: number
  now?: () => number
}

export class LoginLimiter {
  private readonly entries = new Map<string, LoginLimiterEntry>()
  private readonly now: () => number
  private readonly maxEntries: number

  constructor(private readonly options: LoginLimiterOptions) {
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? 5_000
  }

  check(key: string): { locked: boolean; retryAfterMs: number } {
    if (this.options.maxAttempts <= 0) return { locked: false, retryAfterMs: 0 }

    const now = this.now()
    const entry = this.entries.get(key)
    if (!entry) return { locked: false, retryAfterMs: 0 }

    if (entry.lockedUntil > now) {
      return { locked: true, retryAfterMs: entry.lockedUntil - now }
    }

    if (entry.lockedUntil > 0 && entry.lockedUntil <= now) {
      entry.fails = 0
      entry.lockedUntil = 0
      this.entries.set(key, entry)
    }

    return { locked: false, retryAfterMs: 0 }
  }

  recordFailure(key: string): void {
    if (this.options.maxAttempts <= 0) return

    const now = this.now()
    this.prune(now)

    const entry = this.entries.get(key) ?? { fails: 0, lockedUntil: 0, last: now }
    entry.fails += 1
    entry.last = now
    if (entry.fails >= this.options.maxAttempts) {
      entry.lockedUntil = now + this.options.lockoutMs
    }
    this.entries.set(key, entry)
    this.evictOldest()
  }

  recordSuccess(key: string): void {
    if (this.options.maxAttempts <= 0) return
    this.prune(this.now())
    this.entries.delete(key)
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= now && now - entry.last > this.options.lockoutMs) {
        this.entries.delete(key)
      }
    }
  }

  private evictOldest(): void {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | null = null
      let oldestLast = Number.POSITIVE_INFINITY
      for (const [key, entry] of this.entries) {
        if (entry.last < oldestLast) {
          oldestLast = entry.last
          oldestKey = key
        }
      }
      if (!oldestKey) return
      this.entries.delete(oldestKey)
    }
  }
}
