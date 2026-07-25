import { vi } from 'vitest'
import type { WebApi, AuthStatus } from '../../web/api'
import type { RemoteStat } from '@shared/types'

export function createMockWebApi(overrides: Partial<WebApi> = {}): WebApi {
  const base: WebApi = {
    authStatus: vi.fn(async (): Promise<AuthStatus> => ({
      state: 'open',
      required: false,
      authenticated: true,
      canChangePassword: false
    })),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    setup: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
    serverConfig: vi.fn(async () => ({ downloadDir: '', roots: [] })),

    connect: vi.fn(async () => ({ home: '/' })),
    disconnect: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ connected: false, remoteName: null })),
    list: vi.fn(async () => []),
    stat: vi.fn(async (): Promise<RemoteStat> => ({ size: 0, type: 'file', mtime: 0 })),
    enqueueDownload: vi.fn(async () => []),
    enqueueUpload: vi.fn(async () => []),
    cancelDownload: vi.fn(async () => undefined),
    cancelAllDownloads: vi.fn(async () => undefined),
    clearFinishedDownloads: vi.fn(async () => undefined),
    clearAllDownloads: vi.fn(async () => undefined),
    removeDownload: vi.fn(async () => false),
    listDownloads: vi.fn(async () => []),
    getMaxConcurrentDownloads: vi.fn(async () => 3),
    setMaxConcurrentDownloads: vi.fn(async (max: number) => max),
    defaultDownloadDir: vi.fn(async () => ''),
    listDownloadRoots: vi.fn(async () => []),
    browseLocalDirs: vi.fn(async () => ({ path: '', parent: null, entries: [] })),
    createLocalDir: vi.fn(async () => ''),
    listProfiles: vi.fn(async () => []),
    saveProfile: vi.fn(async () => []),
    resolveProfile: vi.fn(async () => null),
    deleteProfile: vi.fn(async () => []),
    onDownloadUpdate: vi.fn(() => () => {})
  }

  return { ...base, ...overrides }
}

export function installMockWebApi(overrides: Partial<WebApi> = {}): WebApi {
  const api = createMockWebApi(overrides)
  window.api = api
  return api
}
