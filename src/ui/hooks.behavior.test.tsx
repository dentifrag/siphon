import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installMockWebApi } from './test/mockWebApi'
import { useBrowser } from './hooks/useBrowser'
import { useConnection } from './hooks/useConnection'
import { useTransfers } from './hooks/useTransfers'
import type { ConnectionProfileMeta, ResolvedProfile, SessionStatus } from '@shared/api'
import type { DownloadEvent, RemoteEntry, TransferProgress } from '@shared/types'

function profileMeta(): ConnectionProfileMeta {
  return {
    id: 'p1',
    name: 'Alice',
    host: 'original-host',
    port: 22,
    username: 'alice',
    authMethod: 'password',
    hasSecret: true,
    segments: 4,
    downloadDir: '/profile-dir'
  }
}

function resolvedProfile(): ResolvedProfile {
  return {
    name: 'Alice',
    host: 'original-host',
    port: 22,
    username: 'alice',
    authMethod: 'password',
    segments: 4,
    downloadDir: '/profile-dir'
  }
}

describe('useConnection: selecting a profile then editing the form', () => {
  it('[principal] still connects using the stale saved profile id, discarding the edit', async () => {
    const connect = vi.fn(async () => ({ home: '/', connectionRevision: 'r1' }))
    installMockWebApi({
      listProfiles: vi.fn(async () => [profileMeta()]),
      resolveProfile: vi.fn(async () => resolvedProfile()),
      connect
    })

    const { result } = renderHook(() =>
      useConnection({
        segments: 4,
        downloadDir: '/dl',
        onSegmentsChange: vi.fn(),
        onDownloadDirChange: vi.fn(),
        onConnected: vi.fn(async () => true),
        onDisconnected: vi.fn()
      })
    )

    await act(async () => {
      await result.current.handleSelectProfile('p1')
    })
    expect(result.current.selectedProfileId).toBe('p1')

    // The user edits the host after picking the saved profile. Selecting the
    // profile already blanked the password (the server never exposes saved
    // secrets back to the client), so once the saved id is detached the user
    // must also type a fresh password for the manual connect to make sense.
    act(() => {
      result.current.onFormChange({ host: 'edited-host.example.com', password: 'new-password' })
    })

    await act(async () => {
      await result.current.handleConnect()
    })

    // Principal assertion: the edited host should be connected with the saved
    // profile id detached (undefined), but production still forwards the
    // stale selected profile id, so the server uses Profile A's saved
    // credentials and silently ignores the edit entirely.
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'edited-host.example.com', password: 'new-password' }),
      undefined
    )
  })

  it('[control] selecting a profile and connecting without editing still passes that profile id', async () => {
    const connect = vi.fn(async () => ({ home: '/', connectionRevision: 'r1' }))
    installMockWebApi({
      listProfiles: vi.fn(async () => [profileMeta()]),
      resolveProfile: vi.fn(async () => resolvedProfile()),
      connect
    })

    const { result } = renderHook(() =>
      useConnection({
        segments: 4,
        downloadDir: '/dl',
        onSegmentsChange: vi.fn(),
        onDownloadDirChange: vi.fn(),
        onConnected: vi.fn(async () => true),
        onDisconnected: vi.fn()
      })
    )

    await act(async () => {
      await result.current.handleSelectProfile('p1')
    })
    await act(async () => {
      await result.current.handleConnect()
    })

    expect(connect).toHaveBeenCalledWith(expect.anything(), 'p1')
  })
})

describe('useBrowser: concurrent navigation', () => {
  it('[principal] a slower, earlier-initiated navigation overwrites a faster, later one on resolve', async () => {
    let resolveInit: (entries: RemoteEntry[]) => void = () => undefined
    let resolveA: (entries: RemoteEntry[]) => void = () => undefined
    let resolveB: (entries: RemoteEntry[]) => void = () => undefined
    const list = vi.fn((dir: string) => {
      if (dir === '/') return new Promise<RemoteEntry[]>((res) => (resolveInit = res))
      if (dir === '/a') return new Promise<RemoteEntry[]>((res) => (resolveA = res))
      if (dir === '/b') return new Promise<RemoteEntry[]>((res) => (resolveB = res))
      return Promise.resolve([])
    })
    installMockWebApi({
      // Connected with a revision, the way a real post-connect session looks,
      // not the disconnected status that would skip the mount-restore
      // navigation entirely and mask it from this race. The revision is an
      // additive field the shared SessionStatus type doesn't declare yet.
      status: vi.fn(async (): Promise<SessionStatus> => ({
        connected: true,
        remoteName: 'remoteA',
        connectionRevision: 'r1'
      })),
      list
    })

    const onStatusConnected = vi.fn()
    const { result } = renderHook(() =>
      useBrowser({ downloadDir: '/dl', segments: 4, onStatusConnected })
    )

    // Let the mount-triggered restore navigation (to the default cwd '/')
    // settle first, so the manual two-call race below is isolated from it.
    await waitFor(() => expect(list).toHaveBeenCalledWith('/', 'r1'))
    act(() => {
      resolveInit([])
    })
    await waitFor(() => expect(result.current.browseLoading).toBe(false))
    expect(result.current.cwd).toBe('/')

    let pA!: Promise<boolean>
    let pB!: Promise<boolean>
    act(() => {
      pA = result.current.navigateTo('/a')
    })
    act(() => {
      pB = result.current.navigateTo('/b')
    })

    await waitFor(() => expect(list).toHaveBeenCalledTimes(3))

    // The later-initiated navigation (/b) is the one the user actually wants
    // reflected, so it resolves first...
    await act(async () => {
      resolveB([{ path: '/b/x', name: 'x', type: 'file', size: 1, mtime: 0 }])
      await pB
    })
    expect(result.current.cwd).toBe('/b')

    // ...but the earlier, now-stale navigation (/a) resolves afterward.
    await act(async () => {
      resolveA([{ path: '/a/y', name: 'y', type: 'file', size: 1, mtime: 0 }])
      await pA
    })

    // Principal assertion: cwd/entries/storage should still reflect /b (the
    // last-initiated navigation), but production lets the last-RESOLVED
    // response win and reverts to the stale /a listing.
    expect(result.current.cwd).toBe('/b')
    expect(localStorage.getItem('siphon.cwd')).toBe('/b')
  })

  it('[control] a single ordinary navigation updates cwd, entries, and storage', async () => {
    installMockWebApi({
      status: vi.fn(async () => ({
        connected: false,
        remoteName: null,
        connectionRevision: null
      })),
      list: vi.fn(async (): Promise<RemoteEntry[]> => [
        { path: '/dir/x', name: 'x', type: 'file', size: 1, mtime: 0 }
      ])
    })

    const onStatusConnected = vi.fn()
    const { result } = renderHook(() =>
      useBrowser({ downloadDir: '/dl', segments: 4, onStatusConnected })
    )

    await act(async () => {
      await result.current.attachConnection('/', 'r1')
      await result.current.navigateTo('/dir')
    })

    expect(result.current.cwd).toBe('/dir')
    expect(result.current.entries).toHaveLength(1)
    expect(localStorage.getItem('siphon.cwd')).toBe('/dir')
  })
})

describe('useTransfers: initial fetch vs. SSE race', () => {
  it('[principal] the slower initial listDownloads() fetch can overwrite a fresher SSE reset', async () => {
    let resolveList: (transfers: TransferProgress[]) => void = () => undefined
    const listPromise = new Promise<TransferProgress[]>((res) => (resolveList = res))
    let sseCallback: ((ev: DownloadEvent) => void) | null = null
    installMockWebApi({
      listDownloads: vi.fn(() => listPromise),
      onDownloadUpdate: vi.fn((cb: (ev: DownloadEvent) => void) => {
        sseCallback = cb
        return () => undefined
      })
    })

    const { result } = renderHook(() =>
      useTransfers({ refreshCurrent: vi.fn(async () => true), getCwd: () => '/' })
    )

    await waitFor(() => expect(sseCallback).not.toBeNull())

    // The SSE channel delivers its authoritative initial reset first.
    act(() => {
      sseCallback?.({
        type: 'reset',
        transfers: [
          {
            id: 't1',
            remotePath: 'a',
            localPath: 'a',
            size: 1,
            transferred: 1,
            speedBytesPerSec: 0,
            activeSegments: 0,
            segments: 1,
            status: 'completed'
          }
        ]
      })
    })
    expect(result.current.transfers).toHaveLength(1)

    // The slower mount-time listDownloads() fetch (started before the SSE
    // reset arrived) resolves afterward with stale/empty data.
    await act(async () => {
      resolveList([])
    })

    // Principal assertion: the SSE reset already delivered the authoritative
    // state, so the late listDownloads() response should not clobber it.
    expect(result.current.transfers).toHaveLength(1)
  })

  it('[control] a normal SSE update after the initial reset is applied', async () => {
    let sseCallback: ((ev: DownloadEvent) => void) | null = null
    installMockWebApi({
      listDownloads: vi.fn(async () => []),
      onDownloadUpdate: vi.fn((cb: (ev: DownloadEvent) => void) => {
        sseCallback = cb
        return () => undefined
      })
    })

    const { result } = renderHook(() =>
      useTransfers({ refreshCurrent: vi.fn(async () => true), getCwd: () => '/' })
    )

    await waitFor(() => expect(sseCallback).not.toBeNull())

    act(() => {
      sseCallback?.({ type: 'reset', transfers: [] })
    })
    act(() => {
      sseCallback?.({
        type: 'update',
        transfer: {
          id: 't2',
          remotePath: 'b',
          localPath: 'b',
          size: 1,
          transferred: 0,
          speedBytesPerSec: 0,
          activeSegments: 0,
          segments: 1,
          status: 'queued'
        }
      })
    })

    expect(result.current.transfers).toHaveLength(1)
    expect(result.current.transfers[0].id).toBe('t2')
  })
})
