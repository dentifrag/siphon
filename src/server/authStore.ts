import { existsSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isScryptHashFormat } from './passwordHash'

export type AuthStoreState = { mode: 'password'; username: string; passwordHash: string } | { mode: 'open' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateState(input: unknown): AuthStoreState {
  if (!isRecord(input)) throw new Error('auth.json must contain an object')
  if (input.mode === 'open') {
    if (Object.keys(input).length !== 1) throw new Error('auth.json open mode has unexpected fields')
    return { mode: 'open' }
  }

  if (input.mode === 'password') {
    if (Object.keys(input).length !== 3) throw new Error('auth.json password mode has unexpected fields')
    if (typeof input.username !== 'string' || input.username.trim().length === 0) {
      throw new Error('auth.json password mode requires a non-empty username')
    }
    if (typeof input.passwordHash !== 'string' || !isScryptHashFormat(input.passwordHash)) {
      throw new Error('auth.json password mode requires a valid scrypt hash')
    }
    return { mode: 'password', username: input.username, passwordHash: input.passwordHash }
  }

  throw new Error('auth.json mode must be "password" or "open"')
}

export class AuthStore {
  constructor(private readonly dataDir: string) {}

  path(): string {
    return join(this.dataDir, 'auth.json')
  }

  async read(): Promise<AuthStoreState | null> {
    const path = this.path()
    if (!existsSync(path)) return null

    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      throw new Error(`Failed reading auth store at ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Invalid JSON in auth store at ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      return validateState(parsed)
    } catch (error) {
      throw new Error(`Invalid auth store schema at ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async write(state: AuthStoreState): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const path = this.path()
    const tmpPath = `${path}.${randomBytes(12).toString('hex')}.tmp`
    const payload = `${JSON.stringify(state, null, 2)}\n`

    const handle = await open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(payload, 'utf8')
    } finally {
      await handle.close()
    }

    try {
      await rename(tmpPath, path)
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined)
      throw error
    }

    await chmod(path, 0o600).catch(() => undefined)
  }
}
