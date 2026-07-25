import type { ConnectionForm } from './types'

export const MAX_CONCURRENT_STORAGE_KEY = 'siphon.maxConcurrentDownloads'
export const CONNECTION_STORAGE_KEY = 'siphon.connection'

export type StoredConnection = {
  host: string
  port: string
  username: string
  authMethod: ConnectionForm['authMethod']
  privateKeyPath: string
  profileId: string
}

export function loadStoredMaxConcurrent(): number {
  const stored = Number.parseInt(localStorage.getItem(MAX_CONCURRENT_STORAGE_KEY) ?? '', 10)
  if (!Number.isFinite(stored)) return 3
  return Math.max(1, Math.min(8, stored))
}

export function parseStoredConnection(raw: string): StoredConnection | null {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') return null
  const saved = parsed as Record<string, unknown>
  if (
    typeof saved.host !== 'string' ||
    typeof saved.port !== 'string' ||
    typeof saved.username !== 'string' ||
    (saved.authMethod !== 'password' && saved.authMethod !== 'privateKey') ||
    typeof saved.privateKeyPath !== 'string' ||
    typeof saved.profileId !== 'string'
  ) {
    return null
  }
  return {
    host: saved.host,
    port: saved.port,
    username: saved.username,
    authMethod: saved.authMethod,
    privateKeyPath: saved.privateKeyPath,
    profileId: saved.profileId
  }
}
