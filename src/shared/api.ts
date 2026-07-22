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

export interface DownloadEnqueueInput {
  remotePath: string
  downloadDir: string
  segments: number
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

export interface SftpApi {
  connect(config: ConnectionConfig, profileId?: string): Promise<ConnectResult>
  disconnect(): Promise<void>
  list(dir: string): Promise<RemoteEntry[]>
  stat(path: string): Promise<RemoteStat>
  enqueueDownload(input: DownloadEnqueueInput): Promise<TransferProgress>
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
