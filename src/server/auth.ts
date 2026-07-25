import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { AuthStoreState } from './authStore'
import { verifyScryptPassword } from './passwordHash'

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
  return verifyScryptPassword(plain, stored)
}

export type AuthState = 'setup' | 'open' | 'password'

export interface AuthStoreWriter {
  write(state: AuthStoreState): Promise<void>
}

export type AuthStartup =
  | { mode: 'setup' }
  | { mode: 'open' }
  | { mode: 'password'; username: string; passwordHash: string; canChangePassword: boolean }

export interface AuthSetupPasswordInput {
  username: string
  password: string
}

export interface AuthSetupOpenInput {
  mode: 'open'
}

export type AuthSetupInput = AuthSetupPasswordInput | AuthSetupOpenInput

export interface AuthServiceOptions {
  startup: AuthStartup
  store: AuthStoreWriter
  sessionTtlMs: number
  now?: () => number
}

export class AuthAlreadyConfiguredError extends Error {
  constructor() {
    super('Already configured')
  }
}

export class AuthNotPasswordModeError extends Error {
  constructor() {
    super('Not in password mode')
  }
}

export class AuthPasswordChangeNotAllowedError extends Error {
  constructor() {
    super('Password changes are not allowed')
  }
}

export class AuthCurrentPasswordMismatchError extends Error {
  constructor() {
    super('Current password is incorrect')
  }
}

export class AuthService {
  private readonly sessions = new Map<string, number>()
  private readonly now: () => number
  private stateValue: AuthState
  private usernameValue: string | null
  private passwordHashValue: string | null
  private canChangePasswordValue: boolean
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? Date.now
    if (options.startup.mode === 'setup') {
      this.stateValue = 'setup'
      this.usernameValue = null
      this.passwordHashValue = null
      this.canChangePasswordValue = false
      return
    }
    if (options.startup.mode === 'open') {
      this.stateValue = 'open'
      this.usernameValue = null
      this.passwordHashValue = null
      this.canChangePasswordValue = false
      return
    }
    this.stateValue = 'password'
    this.usernameValue = options.startup.username
    this.passwordHashValue = options.startup.passwordHash
    this.canChangePasswordValue = options.startup.canChangePassword
  }

  get state(): AuthState {
    return this.stateValue
  }

  get canChangePassword(): boolean {
    return this.stateValue === 'password' && this.canChangePasswordValue
  }

  get enabled(): boolean {
    return this.stateValue === 'password'
  }

  async login(username: string, password: string): Promise<string | null> {
    return this.withMutationLock(async () => {
      if (this.stateValue !== 'password' || !this.usernameValue || !this.passwordHashValue)
        return null
      const userOk = safeEqualStr(username, this.usernameValue)
      const passOk = verifyPassword(password, this.passwordHashValue)
      if (!(userOk && passOk)) return null
      return this.createSession()
    })
  }

  isValid(sid: string | undefined): boolean {
    if (this.stateValue !== 'password') return true
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

  async completeSetup(input: AuthSetupInput): Promise<string | null> {
    return this.withMutationLock(async () => {
      if (this.stateValue !== 'setup') {
        throw new AuthAlreadyConfiguredError()
      }
      if (isSetupOpenInput(input)) {
        await this.options.store.write({ mode: 'open' })
        this.stateValue = 'open'
        this.usernameValue = null
        this.passwordHashValue = null
        this.canChangePasswordValue = false
        this.sessions.clear()
        return null
      }

      const passwordHash = hashPassword(input.password)
      await this.options.store.write({
        mode: 'password',
        username: input.username,
        passwordHash
      })
      this.stateValue = 'password'
      this.usernameValue = input.username
      this.passwordHashValue = passwordHash
      this.canChangePasswordValue = true
      return this.createSession()
    })
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<string> {
    return this.withMutationLock(async () => {
      if (this.stateValue !== 'password' || !this.usernameValue || !this.passwordHashValue) {
        throw new AuthNotPasswordModeError()
      }
      if (!this.canChangePasswordValue) {
        throw new AuthPasswordChangeNotAllowedError()
      }
      if (!verifyPassword(currentPassword, this.passwordHashValue)) {
        throw new AuthCurrentPasswordMismatchError()
      }
      const nextHash = hashPassword(newPassword)
      await this.options.store.write({
        mode: 'password',
        username: this.usernameValue,
        passwordHash: nextHash
      })
      this.passwordHashValue = nextHash
      this.sessions.clear()
      return this.createSession()
    })
  }

  private createSession(): string {
    this.pruneExpired(this.now())
    const sid = randomBytes(32).toString('base64url')
    this.sessions.set(sid, this.now() + this.options.sessionTtlMs)
    return sid
  }

  private async withMutationLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(task, task)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private pruneExpired(now: number): void {
    for (const [sid, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(sid)
    }
  }
}

function isSetupOpenInput(input: AuthSetupInput): input is AuthSetupOpenInput {
  return (input as { mode?: string }).mode === 'open'
}
