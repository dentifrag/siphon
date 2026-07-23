import type {
  ConnectionConfig,
  DownloadEvent,
  RemoteEntry,
  RemoteStat,
  TransferProgress
} from '@shared/types'
import type {
  ConnectResult,
  ConnectionProfileMeta,
  DownloadEnqueueInput,
  DownloadRootMeta,
  LocalDirListing,
  ResolvedProfile,
  SaveProfileInput,
  SessionStatus,
  SftpApi,
  UploadEnqueueInput
} from '@shared/api'

async function request<T>(
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await fetch(path, {
    method: options?.method ?? 'GET',
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin'
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const data = (await response.json()) as { message?: string; error?: string }
      message = data.message || data.error || message
    } catch {
      message = `Request failed (${response.status})`
    }
    const error = new Error(message) as Error & { status: number }
    error.status = response.status
    throw error
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export interface AuthStatus {
  state: 'setup' | 'login' | 'open'
  required: boolean
  authenticated: boolean
  canChangePassword: boolean
}

export interface ServerConfig {
  downloadDir: string
  roots: DownloadRootMeta[]
}

export interface WebApi extends SftpApi {
  authStatus(): Promise<AuthStatus>
  login(username: string, password: string): Promise<void>
  logout(): Promise<void>
  setup(input: { username: string; password: string } | { mode: 'open' }): Promise<void>
  changePassword(currentPassword: string, newPassword: string): Promise<void>
  serverConfig(): Promise<ServerConfig>
}

export function createWebApi(): WebApi {
  return {
    authStatus: async () => {
      const result = await request<{
        state: 'setup' | 'open' | 'password'
        required?: boolean
        authenticated: boolean
        canChangePassword: boolean
      }>('/api/auth-status')
      return {
        state: result.state === 'password' ? 'login' : result.state,
        required: result.required ?? result.state === 'password',
        authenticated: result.authenticated,
        canChangePassword: result.canChangePassword
      }
    },
    login: async (username: string, password: string) => {
      await request('/api/login', { method: 'POST', body: { username, password } })
    },
    logout: async () => {
      await request('/api/logout', { method: 'POST' })
    },
    setup: async (input) => {
      await request('/api/setup', { method: 'POST', body: input })
    },
    changePassword: async (currentPassword: string, newPassword: string) => {
      await request('/api/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword }
      })
    },
    serverConfig: () => request<ServerConfig>('/api/config'),

    connect: (config: ConnectionConfig, profileId?: string) =>
      request<ConnectResult>('/api/connect', {
        method: 'POST',
        body: profileId ? { profileId } : { config }
      }),
    disconnect: async () => {
      await request('/api/disconnect', { method: 'POST' })
    },
    status: () => request<SessionStatus>('/api/status'),
    list: (dir: string) => request<RemoteEntry[]>(`/api/list?path=${encodeURIComponent(dir)}`),
    stat: (path: string) => request<RemoteStat>(`/api/stat?path=${encodeURIComponent(path)}`),
    enqueueDownload: (input: DownloadEnqueueInput) =>
      request<TransferProgress[]>('/api/download', { method: 'POST', body: input }),
    enqueueUpload: (input: UploadEnqueueInput) =>
      request<TransferProgress[]>('/api/upload', { method: 'POST', body: input }),
    cancelDownload: async (id: string) => {
      await request('/api/download/cancel', { method: 'POST', body: { id } })
    },
    cancelAllDownloads: async () => {
      await request('/api/downloads/cancel-all', { method: 'POST' })
    },
    clearFinishedDownloads: async () => {
      await request('/api/downloads/clear-finished', { method: 'POST' })
    },
    clearAllDownloads: async () => {
      await request('/api/downloads/clear-all', { method: 'POST' })
    },
    removeDownload: (id: string) =>
      request<{ removed: boolean }>('/api/downloads/remove', { method: 'POST', body: { id } }).then(
        (r) => r.removed
      ),
    listDownloads: () => request<TransferProgress[]>('/api/downloads'),
    getMaxConcurrentDownloads: () =>
      request<{ max: number }>('/api/downloads/concurrency').then((r) => r.max),
    setMaxConcurrentDownloads: (max: number) =>
      request<{ max: number }>('/api/downloads/concurrency', { method: 'POST', body: { max } }).then(
        (r) => r.max
      ),
    defaultDownloadDir: async () => {
      const config = await request<ServerConfig>('/api/config')
      return config.downloadDir
    },
    listDownloadRoots: () => request<DownloadRootMeta[]>('/api/fs/roots'),
    browseLocalDirs: (path?: string) =>
      request<LocalDirListing>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    createLocalDir: async (parentPath: string, name: string) => {
      const result = await request<{ path: string }>('/api/fs/mkdir', {
        method: 'POST',
        body: { path: parentPath, name }
      })
      return result.path
    },
    listProfiles: () => request<ConnectionProfileMeta[]>('/api/profiles'),
    saveProfile: (input: SaveProfileInput) =>
      request<ConnectionProfileMeta[]>('/api/profiles', { method: 'POST', body: input }),
    resolveProfile: (id: string) =>
      request<ResolvedProfile | null>('/api/profiles/resolve', {
        method: 'POST',
        body: { id }
      }),
    deleteProfile: (id: string) =>
      request<ConnectionProfileMeta[]>('/api/profiles/delete', {
        method: 'POST',
        body: { id }
      }),
    onDownloadUpdate: (callback: (event: DownloadEvent) => void) => {
      const source = new EventSource('/api/events', { withCredentials: true })
      source.onmessage = (event) => {
        try {
          callback(JSON.parse(event.data) as DownloadEvent)
        } catch {}
      }
      return () => source.close()
    }
  }
}
