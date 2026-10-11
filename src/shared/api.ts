import type {
  AuthMethod,
  ConnectionConfig,
  DownloadEvent,
  RemoteEntry,
  RemoteStat,
  TransferProgress
} from './types'

export interface ConnectResult {
  home: string
}

export interface SessionStatus {
  connected: boolean
  remoteName: string | null
}

export interface DownloadEnqueueInput {
  remotePath: string
  downloadDir: string
  segments: number
}

export interface UploadEnqueueInput {
  localPath: string
  remoteDir: string
}

export interface ConnectionProfileMeta {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath?: string
  hasSecret: boolean
  segments: number
  downloadDir: string
}

export interface SaveProfileInput {
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath?: string
  secret?: string
  rememberSecret: boolean
  segments: number
  downloadDir: string
}

export interface ResolvedProfile {
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath?: string
  segments: number
  downloadDir: string
}

export interface DownloadRootMeta {
  name: string
  path: string
}

export interface LocalEntry {
  name: string
  path: string
  isDir: boolean
}

export interface LocalDirListing {
  path: string
  parent: string | null
  entries: LocalEntry[]
}

export type UpdateCapability =
  | { supported: true }
  | {
      supported: false
      reason: 'not-windows-service' | 'setup-required' | 'incompatible-helper' | 'unsafe-install'
      message: string
    }

export interface UpdateOffer {
  id: string
  version: string
  sizeBytes: number
  protocolVersion: 1
}

export type UpdatePhase =
  | 'accepted'
  | 'downloading'
  | 'verifying-download'
  | 'stopping'
  | 'backing-up'
  | 'replacing'
  | 'starting'
  | 'verifying-new'
  | 'rolling-back'
  | 'verifying-old'
  | 'succeeded'
  | 'failed'
  | 'rolled-back'
  | 'rollback-failed'

export interface UpdateJob {
  id: string
  offerId?: string
  fromVersion: string
  toVersion: string
  phase: UpdatePhase
  startedAt: string
  updatedAt: string
  serviceHealth: 'healthy' | 'unhealthy' | 'unknown'
  error?: string
}

export interface UpdateStatus {
  currentVersion: string
  capability: UpdateCapability
  check: { state: 'idle' | 'checked' | 'error'; error?: string }
  offer: UpdateOffer | null
  job: UpdateJob | null
  maintenance: boolean
  canInstall: boolean
  canCheck?: boolean
  blockedReason?: string
}

export interface VersionHealth {
  app: 'siphon'
  version: string
}

export interface SftpApi {
  connect(config: ConnectionConfig, profileId?: string): Promise<ConnectResult>
  disconnect(): Promise<void>
  status(): Promise<SessionStatus>
  list(dir: string): Promise<RemoteEntry[]>
  stat(path: string): Promise<RemoteStat>
  enqueueDownload(input: DownloadEnqueueInput): Promise<TransferProgress[]>
  enqueueUpload(input: UploadEnqueueInput): Promise<TransferProgress[]>
  cancelDownload(id: string): Promise<void>
  cancelAllDownloads(): Promise<void>
  clearFinishedDownloads(): Promise<void>
  clearAllDownloads(): Promise<void>
  removeDownload(id: string): Promise<boolean>
  listDownloads(): Promise<TransferProgress[]>
  getMaxConcurrentDownloads(): Promise<number>
  setMaxConcurrentDownloads(max: number): Promise<number>
  defaultDownloadDir(): Promise<string>
  listDownloadRoots(): Promise<DownloadRootMeta[]>
  browseLocalDirs(path?: string): Promise<LocalDirListing>
  createLocalDir(parentPath: string, name: string): Promise<string>
  listProfiles(): Promise<ConnectionProfileMeta[]>
  saveProfile(input: SaveProfileInput): Promise<ConnectionProfileMeta[]>
  resolveProfile(id: string): Promise<ResolvedProfile | null>
  deleteProfile(id: string): Promise<ConnectionProfileMeta[]>
  onDownloadUpdate(callback: (event: DownloadEvent) => void): () => void
}
