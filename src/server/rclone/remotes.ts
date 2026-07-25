import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AuthMethod } from '../../shared/types'
import type { ConnectionProfileMeta, ResolvedProfile, SaveProfileInput } from '../../shared/api'
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

export class RemoteStore {
  constructor(
    private readonly dataDir: string,
    private readonly client: RcloneClient
  ) {}

  private filePath(): string {
    return join(this.dataDir, 'remotes.json')
  }

  private async readAll(): Promise<RemoteMeta[]> {
    const path = this.filePath()
    if (!existsSync(path)) return []
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { remotes?: RemoteMeta[] }
      return Array.isArray(parsed.remotes) ? parsed.remotes : []
    } catch {
      return []
    }
  }

  private async writeAll(remotes: RemoteMeta[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const path = this.filePath()
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify({ remotes }, null, 2), { mode: 0o600 })
    await rename(tmp, path)
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
      hasSecret: true,
      segments: r.segments,
      downloadDir: r.downloadDir
    }
  }

  async list(): Promise<ConnectionProfileMeta[]> {
    return (await this.readAll()).map((r) => this.toMeta(r))
  }

  async resolve(id: string): Promise<ResolvedProfile | null> {
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
  }

  async remoteNameFor(id: string): Promise<string | null> {
    const r = (await this.readAll()).find((x) => x.id === id)
    return r ? r.remoteName : null
  }

  async save(
    input: SaveProfileInput & { password?: string; passphrase?: string }
  ): Promise<ConnectionProfileMeta[]> {
    const remotes = await this.readAll()
    const name = input.name.trim() || `${input.username}@${input.host}`
    const existing = remotes.find((r) => r.name === name)
    const remoteName = existing
      ? existing.remoteName
      : uniqueName(sanitizeRemoteName(name), remotes)

    const params = sftpParameters({
      host: input.host,
      port: input.port,
      username: input.username,
      authMethod: input.authMethod,
      password: input.password,
      privateKeyPath: input.privateKeyPath,
      passphrase: input.passphrase
    })
    const hasNewSecret =
      (input.authMethod === 'password' && Boolean(input.password)) ||
      input.authMethod === 'privateKey'
    if (!existing || hasNewSecret) {
      await this.client.createRemote(remoteName, 'sftp', params)
    }

    const record: RemoteMeta = {
      id: existing?.id ?? randomUUID(),
      name,
      remoteName,
      host: input.host,
      port: input.port,
      username: input.username,
      authMethod: input.authMethod,
      privateKeyPath: input.privateKeyPath,
      segments: input.segments,
      downloadDir: input.downloadDir
    }
    const next = existing
      ? remotes.map((r) => (r.id === existing.id ? record : r))
      : [...remotes, record]
    await this.writeAll(next)
    return next.map((r) => this.toMeta(r))
  }

  async delete(id: string): Promise<ConnectionProfileMeta[]> {
    const remotes = await this.readAll()
    const target = remotes.find((r) => r.id === id)
    if (target) await this.client.deleteRemote(target.remoteName).catch(() => undefined)
    const next = remotes.filter((r) => r.id !== id)
    await this.writeAll(next)
    return next.map((r) => this.toMeta(r))
  }
}

function uniqueName(base: string, remotes: RemoteMeta[]): string {
  const taken = new Set(remotes.map((r) => r.remoteName))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}
