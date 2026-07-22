export type AuthMethod = 'password' | 'privateKey'

export interface ConnectionConfig {
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export type RemoteEntryType = 'file' | 'directory' | 'symlink' | 'other'

export interface RemoteEntry {
  name: string
  path: string
  type: RemoteEntryType
  size: number
  mtime: number
}

export interface RemoteStat {
  size: number
  type: RemoteEntryType
  mtime: number
}

export type TransferStatus = 'queued' | 'downloading' | 'completed' | 'error' | 'canceled'

export type TransferKind = 'file' | 'directory'

export interface TransferProgress {
  id: string
  kind: TransferKind
  remotePath: string
  localPath: string
  size: number
  transferred: number
  speedBytesPerSec: number
  activeSegments: number
  segments: number
  status: TransferStatus
  error?: string
}

export type DownloadEvent = { type: 'update'; transfer: TransferProgress } | { type: 'remove'; id: string }
