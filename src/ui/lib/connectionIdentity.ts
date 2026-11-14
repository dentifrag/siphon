import type { ConnectionIdentity } from '@shared/api'
import { CONNECTION_STORAGE_KEY, parseStoredConnection, type StoredConnection } from './storage'

const SECRET_FIELDS = new Set(['password', 'passphrase'])

export function isSecretOnlyPatch(patch: object): boolean {
  const keys = Object.keys(patch)
  return keys.length > 0 && keys.every((key) => SECRET_FIELDS.has(key))
}

export function readStoredConnection(): StoredConnection | null {
  try {
    const raw = localStorage.getItem(CONNECTION_STORAGE_KEY)
    return raw ? parseStoredConnection(raw) : null
  } catch {
    return null
  }
}

export function storeConnection(identity: ConnectionIdentity): void {
  const payload: StoredConnection = {
    host: identity.host,
    port: String(identity.port),
    username: identity.username,
    authMethod: identity.authMethod,
    privateKeyPath: identity.privateKeyPath ?? '',
    profileId: identity.profileId ?? ''
  }
  try {
    localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(payload))
  } catch {}
}

export function clearStoredConnection(): void {
  try {
    localStorage.removeItem(CONNECTION_STORAGE_KEY)
  } catch {}
}

// A remembered folder only applies to the same server, user, and credentials.
export function isSameServer(stored: StoredConnection | null, identity: ConnectionIdentity) {
  return (
    stored !== null &&
    stored.host === identity.host &&
    stored.port === String(identity.port) &&
    stored.username === identity.username &&
    stored.authMethod === identity.authMethod &&
    stored.privateKeyPath === (identity.privateKeyPath ?? '')
  )
}
