import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { AuthMethod } from '../../shared/types'
import type {
  ConnectionIdentity,
  ConnectionProfileMeta,
  ResolvedProfile,
  SaveProfileInput
} from '../../shared/api'
import type { RcloneClient } from './client'

interface RemoteMeta {
  id: string
  name: string
  remoteName: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath?: string
  hasSecret?: boolean
  segments: number
  downloadDir: string
}

export function sftpParameters(input: {
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  password?: string
  privateKeyPath?: string
  passphrase?: string
}): Record<string, string> {
  const params: Record<string, string> = {
    host: input.host,
    port: String(input.port || 22),
    user: input.username,
    shell_type: 'none',
    disable_hashcheck: 'true'
  }
  if (input.authMethod === 'password' && input.password) params.pass = input.password
  if (input.authMethod === 'privateKey' && input.privateKeyPath) {
    params.key_file = input.privateKeyPath
    if (input.passphrase) params.key_file_pass = input.passphrase
  }
  return params
}

export function sanitizeRemoteName(base: string): string {
  const cleaned = base.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[-._]+/, '')
  return cleaned || 'remote'
}

export const SESSION_REMOTE_PREFIX = '_session-'

const SECRET_KEYS = ['pass', 'key_file_pass'] as const

function secretKeyFor(authMethod: AuthMethod): (typeof SECRET_KEYS)[number] {
  return authMethod === 'password' ? 'pass' : 'key_file_pass'
}

function isRemoteMeta(value: unknown): value is RemoteMeta {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.remoteName === 'string' &&
    typeof r.host === 'string' &&
    typeof r.port === 'number' &&
    typeof r.username === 'string' &&
    (r.authMethod === 'password' || r.authMethod === 'privateKey') &&
    (r.privateKeyPath === undefined || typeof r.privateKeyPath === 'string') &&
    (r.hasSecret === undefined || typeof r.hasSecret === 'boolean') &&
    typeof r.segments === 'number' &&
    typeof r.downloadDir === 'string'
  )
}

export class RemoteStore {
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly dataDir: string,
    private readonly client: RcloneClient
  ) {}

  private filePath(): string {
    return join(this.dataDir, 'remotes.json')
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async readAll(): Promise<RemoteMeta[]> {
    const path = this.filePath()
    if (!existsSync(path)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      throw new Error(
        `Invalid JSON in saved connections at ${path}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const remotes = (parsed as { remotes?: unknown } | null)?.remotes
    if (!Array.isArray(remotes) || !remotes.every(isRemoteMeta)) {
      throw new Error(`Invalid saved connections schema at ${path}.`)
    }
    return remotes
  }

  private async writeAll(remotes: RemoteMeta[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const path = this.filePath()
    const tmp = `${path}.${randomBytes(12).toString('hex')}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(JSON.stringify({ remotes }, null, 2), 'utf8')
      } finally {
        await handle.close()
      }
      await rename(tmp, path)
    } catch (error) {
      await unlink(tmp).catch(() => undefined)
      throw error
    }
  }

  // Records written before hasSecret existed take it from the persisted rclone config.
  private async withKnownSecrets(remotes: RemoteMeta[]): Promise<RemoteMeta[]> {
    if (remotes.every((r) => r.hasSecret !== undefined)) return remotes
    let changed = false
    const next = await Promise.all(
      remotes.map(async (r) => {
        if (r.hasSecret !== undefined) return r
        const config = await this.client.getRemote(r.remoteName)
        changed = true
        return { ...r, hasSecret: Boolean(config[secretKeyFor(r.authMethod)]) }
      })
    )
    if (changed) await this.writeAll(next)
    return next
  }

  private toMeta(r: RemoteMeta): ConnectionProfileMeta {
    return {
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      username: r.username,
      authMethod: r.authMethod,
      privateKeyPath: r.privateKeyPath,
      hasSecret: r.hasSecret ?? false,
      segments: r.segments,
      downloadDir: r.downloadDir
    }
  }

  list(): Promise<ConnectionProfileMeta[]> {
    return this.exclusive(async () =>
      (await this.withKnownSecrets(await this.readAll())).map((r) => this.toMeta(r))
    )
  }

  resolve(id: string): Promise<ResolvedProfile | null> {
    return this.exclusive(async () => {
      const r = (await this.readAll()).find((x) => x.id === id)
      if (!r) return null
      return {
        name: r.name,
        host: r.host,
        port: r.port,
        username: r.username,
        authMethod: r.authMethod,
        privateKeyPath: r.privateKeyPath,
        segments: r.segments,
        downloadDir: r.downloadDir
      }
    })
  }

  /**
   * Copies a saved site into an independent remote owned by one session. A
   * typed secret replaces the stored one for that remote only. Returns null
   * when the saved site no longer exists.
   */
  cloneForSession(id: string, target: string, secret?: string): Promise<ConnectionIdentity | null> {
    return this.exclusive(async () => {
      const r = (await this.readAll()).find((x) => x.id === id)
      if (!r) return null
      if (secret) {
        const { type, ...parameters } = await this.client.getRemote(r.remoteName)
        for (const key of SECRET_KEYS) delete parameters[key]
        parameters[secretKeyFor(r.authMethod)] = secret
        await this.client.createRemote(target, type ?? 'sftp', parameters)
      } else {
        await this.client.cloneRemote(r.remoteName, target)
      }
      // Legacy records can hold edited metadata over an unchanged rclone config, so the copied config is authoritative.
      const config = await this.client.getRemote(target)
      const port = Number(config.port)
      return {
        host: config.host || r.host,
        port: Number.isInteger(port) && port > 0 ? port : r.port,
        username: config.user || r.username,
        authMethod: r.authMethod,
        privateKeyPath:
          r.authMethod === 'privateKey' ? config.key_file || r.privateKeyPath : undefined,
        profileId: r.id
      }
    })
  }

  save(
    input: SaveProfileInput & { password?: string; passphrase?: string }
  ): Promise<ConnectionProfileMeta[]> {
    return this.exclusive(async () => {
      const remotes = await this.withKnownSecrets(await this.readAll())
      const name = input.name.trim() || `${input.username}@${input.host}`
      const existing = remotes.find((r) => r.name === name)
      const remoteName = existing
        ? existing.remoteName
        : uniqueName(sanitizeRemoteName(name), remotes)

      const typed = input.authMethod === 'password' ? input.password : input.passphrase
      const params = sftpParameters({
        host: input.host,
        port: input.port,
        username: input.username,
        authMethod: input.authMethod,
        privateKeyPath: input.privateKeyPath
      })
      // A failed read must reject: treating it as "no secret" would silently drop a saved one.
      const previous = existing ? await this.client.getRemote(existing.remoteName) : null

      let obscure = true
      let hasSecret = false
      if (input.rememberSecret && typed) {
        params[secretKeyFor(input.authMethod)] = typed
        hasSecret = true
      } else if (input.rememberSecret && existing && previous) {
        const sameSecret =
          existing.authMethod === input.authMethod &&
          (input.authMethod === 'password' || existing.privateKeyPath === input.privateKeyPath)
        const stored = sameSecret ? previous[secretKeyFor(input.authMethod)] : undefined
        if (stored) {
          params[secretKeyFor(input.authMethod)] = stored
          obscure = false
          hasSecret = true
        }
      }
      await this.client.createRemote(remoteName, 'sftp', params, obscure)

      const record: RemoteMeta = {
        id: existing?.id ?? randomUUID(),
        name,
        remoteName,
        host: input.host,
        port: input.port,
        username: input.username,
        authMethod: input.authMethod,
        privateKeyPath: input.privateKeyPath,
        hasSecret,
        segments: input.segments,
        downloadDir: input.downloadDir
      }
      const next = existing
        ? remotes.map((r) => (r.id === existing.id ? record : r))
        : [...remotes, record]
      try {
        await this.writeAll(next)
      } catch (error) {
        try {
          if (previous && Object.keys(previous).length > 0) {
            const { type, ...parameters } = previous
            await this.client.createRemote(remoteName, type ?? 'sftp', parameters, false)
          } else {
            await this.client.deleteRemote(remoteName)
          }
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Saving the connection failed, and restoring the previous rclone config also failed.'
          )
        }
        throw error
      }
      return next.map((r) => this.toMeta(r))
    })
  }

  delete(id: string): Promise<ConnectionProfileMeta[]> {
    return this.exclusive(async () => {
      const remotes = await this.readAll()
      const target = remotes.find((r) => r.id === id)
      if (target) await this.client.deleteRemote(target.remoteName)
      const next = remotes.filter((r) => r.id !== id)
      await this.writeAll(next)
      return next.map((r) => this.toMeta(r))
    })
  }
}

function uniqueName(base: string, remotes: RemoteMeta[]): string {
  const taken = new Set(remotes.map((r) => r.remoteName))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}
