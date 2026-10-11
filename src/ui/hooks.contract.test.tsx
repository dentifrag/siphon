import { join } from 'node:path'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConnectResult,
  DownloadEnqueueInput,
  ResolvedProfile,
  SessionStatus,
  UploadEnqueueInput
} from '@shared/api'
import type { DownloadEvent, RemoteEntry, TransferProgress } from '@shared/types'
import type { WebApi } from '../web/api'
import { useBrowser } from './hooks/useBrowser'
import { useConnection } from './hooks/useConnection'
import { useTransfers } from './hooks/useTransfers'
import { installMockWebApi } from './test/mockWebApi'

function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function transfer(id = 't1'): TransferProgress {
  return {
    id,
    remotePath: '/source/a',
    localPath: join(process.cwd(), 'fixtures', 'a'),
    size: 1,
    transferred: 0,
    speedBytesPerSec: 0,
    activeSegments: 0,
    segments: 1,
    status: 'queued'
  }
}

function files(dir: string): RemoteEntry[] {
  return ['a', 'b', 'c'].map((name) => ({
    name,
    path: `${dir}/${name}`,
    type: 'file',
    size: 1,
    mtime: 0
  }))
}

async function mountBrowser(overrides: Partial<WebApi> = {}) {
  const api = installMockWebApi({
    list: vi.fn(async (dir: string) => files(dir)),
    ...overrides
  })
  const onStatusConnected = vi.fn()
  const hook = renderHook(() =>
    useBrowser({
      downloadDir: join(process.cwd(), 'fixtures', 'out'),
      segments: 4,
      onStatusConnected
    })
  )
  await act(async () => {
    await hook.result.current.attachConnection('/source', 'r1')
  })
  return { ...hook, api }
}

describe('transfer batch ownership', () => {
  it.each(
    (['download', 'upload'] as const).flatMap((direction) =>
      (['404', '400', 'network', '409', 'disconnect', 'reconnect', 'navigation'] as const).map(
        (change) => ({ direction, change })
      )
    )
  )(
    '$direction batch handles $change without changing its prepared identity',
    async ({ direction, change }) => {
      const pending = gate<TransferProgress[]>()
      const started = gate<void>()
      let count = 0
      const enqueue = vi.fn(async (_input: DownloadEnqueueInput | UploadEnqueueInput) => {
        count += 1
        if (count === 1 && ['disconnect', 'reconnect', 'navigation'].includes(change)) {
          started.resolve()
          return pending.promise
        }
        if (count === 2 && ['404', '400', 'network', '409', 'navigation'].includes(change)) {
          throw Object.assign(new Error('Item failed'), {
            status:
              change === 'network' ? undefined : change === 'navigation' ? 404 : Number(change)
          })
        }
        return [transfer(`t${count}`)]
      })
      const { result } = await mountBrowser({
        enqueueDownload: enqueue,
        enqueueUpload: enqueue
      })
      const localPaths = ['a', 'b', 'c'].map((name) => join(process.cwd(), 'fixtures', name))
      act(() => result.current.setSelected(new Set(files('/source').map((entry) => entry.path))))
      let batch!: Promise<void>
      act(() => {
        batch =
          direction === 'download'
            ? result.current.handleDownloadSelected()
            : result.current.handleUploadSelected(localPaths)
      })
      try {
        if (['disconnect', 'reconnect', 'navigation'].includes(change)) {
          await started.promise
          await act(async () => {
            if (change === 'disconnect') result.current.beginConnectionChange()
            if (change === 'reconnect') await result.current.attachConnection('/new', 'r2')
            if (change === 'navigation') await result.current.navigateTo('/elsewhere')
          })
          act(() => result.current.setSelected(new Set(['new-selection'])))
          await act(async () => {
            pending.resolve([transfer()])
            await batch
          })
          expect(result.current.selected).toEqual(new Set(['new-selection']))
          expect(result.current.browseError).toBeNull()
        } else {
          await act(async () => batch)
          expect(result.current.browseError).toBe(
            change === '409'
              ? 'The connection changed. Reconnect before continuing.'
              : 'Item failed'
          )
        }
        const expectedCount =
          change === '409' ? 2 : ['disconnect', 'reconnect'].includes(change) ? 1 : 3
        expect(enqueue).toHaveBeenCalledTimes(expectedCount)
        for (const [input] of enqueue.mock.calls) {
          expect(input.connectionRevision).toBe('r1')
          if ('remoteDir' in input) expect(input.remoteDir).toBe('/source')
        }
        if (expectedCount === 3) {
          expect(enqueue).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining(
              direction === 'download' ? { remotePath: '/source/c' } : { localPath: localPaths[2] }
            )
          )
        }
      } finally {
        await act(async () => {
          pending.resolve([])
          await batch
        })
      }
    }
  )

  it.each(['navigation', 'reconnect'] as const)(
    'prepared upload retains its destination through %s or is invalidated',
    async (change) => {
      const { result, api } = await mountBrowser({
        enqueueUpload: vi.fn(async () => [transfer()])
      })
      const prepared = result.current.prepareUpload()
      await act(async () => {
        if (change === 'navigation') await result.current.navigateTo('/elsewhere')
        else await result.current.attachConnection('/new', 'r2')
        await prepared([join(process.cwd(), 'fixtures', 'a')])
      })
      if (change === 'reconnect') expect(api.enqueueUpload).not.toHaveBeenCalled()
      else {
        expect(api.enqueueUpload).toHaveBeenCalledWith({
          localPath: join(process.cwd(), 'fixtures', 'a'),
          remoteDir: '/source',
          connectionRevision: 'r1'
        })
      }
    }
  )

  it('missing download destination aborts the entire batch', async () => {
    const api = installMockWebApi({ list: vi.fn(async (dir: string) => files(dir)) })
    const onStatusConnected = vi.fn()
    const { result } = renderHook(() =>
      useBrowser({ downloadDir: '', segments: 4, onStatusConnected })
    )
    await act(async () => result.current.attachConnection('/source', 'r1'))
    act(() => result.current.setSelected(new Set(['/source/a', '/source/b'])))
    await act(async () => result.current.handleDownloadSelected())
    expect(api.enqueueDownload).not.toHaveBeenCalled()
    expect(result.current.browseError).toBe('Choose a download folder first.')
  })
})

describe('background upload refresh', () => {
  it('does not supersede a pending explicit navigation and preserves stable callbacks', async () => {
    vi.useFakeTimers()
    const big = gate<RemoteEntry[]>()
    const started = gate<void>()
    let event!: (event: DownloadEvent) => void
    const api = installMockWebApi({
      list: vi.fn(async (dir: string) => {
        if (dir === '/big') {
          started.resolve()
          return big.promise
        }
        return []
      }),
      onDownloadUpdate: vi.fn((callback) => {
        event = callback
        return () => undefined
      })
    })
    const onStatusConnected = vi.fn()
    const { result } = renderHook(() => {
      const browser = useBrowser({ downloadDir: '', segments: 4, onStatusConnected })
      useTransfers({ refreshCurrent: browser.refreshCurrent, getCwd: browser.getCwd })
      return browser
    })
    let navigation: Promise<boolean> | undefined
    try {
      await act(async () => result.current.attachConnection('/', 'r1'))
      const callbacks = [
        result.current.navigateTo,
        result.current.getCwd,
        result.current.refreshCurrent
      ]
      vi.mocked(api.list).mockClear()
      act(() => {
        navigation = result.current.navigateTo('/big')
      })
      await started.promise
      act(() => {
        event({
          type: 'update',
          transfer: {
            ...transfer(),
            direction: 'upload',
            status: 'completed',
            uploadRemoteDir: ''
          }
        })
        vi.advanceTimersByTime(600)
      })
      expect(api.list).toHaveBeenCalledTimes(1)
      expect(api.list).toHaveBeenCalledWith('/big', 'r1')
      await act(async () => {
        big.resolve(files('/big'))
        await navigation
      })
      expect(result.current.cwd).toBe('/big')
      expect(localStorage.getItem('siphon.cwd')).toBe('/big')
      expect([
        result.current.navigateTo,
        result.current.getCwd,
        result.current.refreshCurrent
      ]).toEqual(callbacks)
      expect(api.onDownloadUpdate).toHaveBeenCalledTimes(1)
      await act(async () => result.current.refreshCurrent())
      expect(api.list).toHaveBeenCalledTimes(2)
      act(() => result.current.beginConnectionChange())
      vi.mocked(api.list).mockClear()
      act(() => {
        event({
          type: 'update',
          transfer: {
            ...transfer(),
            direction: 'upload',
            status: 'completed',
            uploadRemoteDir: ''
          }
        })
        vi.advanceTimersByTime(600)
      })
      expect(api.list).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        big.resolve([])
        await navigation
      })
      cleanup()
      vi.useRealTimers()
    }
  })

  it('does not refresh a disconnected browser', async () => {
    const { result, api } = await mountBrowser()
    act(() => result.current.beginConnectionChange())
    vi.mocked(api.list).mockClear()
    await act(async () => result.current.refreshCurrent())
    expect(api.list).not.toHaveBeenCalled()
  })
})

describe('startup connection and restore ownership', () => {
  it.each(['connect', 'disconnect'] as const)(
    'ignores a late startup status after local %s begins',
    async (operation) => {
      const status = gate<SessionStatus>()
      const connect = gate<ConnectResult>()
      const disconnect = gate<void>()
      const api = installMockWebApi({
        status: vi.fn(() => status.promise),
        connect: vi.fn(() => connect.promise),
        disconnect: vi.fn(() => disconnect.promise)
      })
      const onStatusConnected = vi.fn()
      const onSegmentsChange = vi.fn()
      const onDownloadDirChange = vi.fn()
      const onDisconnected = vi.fn()
      const { result } = renderHook(() => {
        const browser = useBrowser({ downloadDir: '', segments: 4, onStatusConnected })
        const connection = useConnection({
          downloadDir: '',
          segments: 4,
          onSegmentsChange,
          onDownloadDirChange,
          onDisconnected,
          onConnected: browser.attachConnection,
          onConnectionChange: browser.beginConnectionChange
        })
        return { browser, connection }
      })
      act(() => result.current.connection.onFormChange({ host: 'new', username: 'user' }))
      let pending!: Promise<void>
      act(() => {
        pending =
          operation === 'connect'
            ? result.current.connection.handleConnect()
            : result.current.connection.handleDisconnect()
      })
      try {
        await act(async () =>
          status.resolve({ connected: true, remoteName: 'old', connectionRevision: 'r-old' })
        )
        expect(onStatusConnected).not.toHaveBeenCalled()
        expect(api.list).not.toHaveBeenCalled()
        expect(result.current.browser.entries).toEqual([])
        await act(async () => {
          connect.resolve({ home: '/new', connectionRevision: 'r-new' })
          disconnect.resolve()
          await pending
        })
        if (operation === 'connect') expect(api.list).toHaveBeenCalledWith('/new', 'r-new')
        else expect(api.list).not.toHaveBeenCalled()
      } finally {
        await act(async () => {
          status.resolve({ connected: false, remoteName: null, connectionRevision: null })
          connect.resolve({ home: '/new', connectionRevision: 'r-new' })
          disconnect.resolve()
          await pending
        })
      }
    }
  )

  it.each(['superseded', 'failure', '409'] as const)(
    'startup restore handles %s without an invalid fallback',
    async (outcome) => {
      localStorage.setItem('siphon.cwd', '/stored')
      const stored = gate<RemoteEntry[]>()
      const started = gate<void>()
      const api = installMockWebApi({
        status: vi.fn(async () => ({
          connected: true,
          remoteName: 'A',
          connectionRevision: 'r1'
        })),
        list: vi.fn(async (dir: string) => {
          if (dir === '/stored') {
            started.resolve()
            return stored.promise
          }
          return files(dir)
        })
      })
      const onStatusConnected = vi.fn()
      const { result } = renderHook(() =>
        useBrowser({ downloadDir: '', segments: 4, onStatusConnected })
      )
      try {
        await started.promise
        if (outcome === 'superseded') {
          await act(async () => result.current.navigateTo('/newer'))
        }
        await act(async () => {
          stored.reject(
            Object.assign(new Error('Missing folder'), { status: outcome === '409' ? 409 : 404 })
          )
        })
        if (outcome === 'failure') {
          expect(api.list).toHaveBeenCalledWith('/', 'r1')
          expect(result.current.cwd).toBe('/')
        } else {
          expect(api.list).not.toHaveBeenCalledWith('/', 'r1')
          expect(result.current.cwd).toBe(outcome === 'superseded' ? '/newer' : '/')
        }
        expect(result.current.browseLoading).toBe(false)
      } finally {
        await act(async () => stored.resolve([]))
      }
    }
  )
})

function resolvedProfile(): ResolvedProfile {
  return {
    name: 'user@host',
    host: 'host',
    port: 22,
    username: 'user',
    authMethod: 'password',
    segments: 4,
    downloadDir: ''
  }
}

function mountConnection(overrides: Partial<WebApi> = {}) {
  const api = installMockWebApi({
    resolveProfile: vi.fn(async () => resolvedProfile()),
    ...overrides
  })
  const options = {
    downloadDir: '',
    segments: 4,
    onSegmentsChange: vi.fn(),
    onDownloadDirChange: vi.fn(),
    onConnected: vi.fn(async () => true),
    onDisconnected: vi.fn()
  }
  return { ...renderHook(() => useConnection(options)), api }
}

describe('saved credential origin', () => {
  it.each(['edit', 'deselect', 'delete'] as const)(
    '%s of a saved password form requires re-entry for Connect and Save',
    async (detach) => {
      const { result, api } = mountConnection()
      await act(async () => result.current.handleSelectProfile('p1'))
      await act(async () => {
        if (detach === 'edit') result.current.onFormChange({ host: 'edited' })
        if (detach === 'deselect') await result.current.handleSelectProfile('')
        if (detach === 'delete') await result.current.handleDeleteProfile()
      })
      expect(result.current.selectedProfileId).toBe('')
      expect(result.current.requiresPasswordReentry).toBe(true)
      await act(async () => {
        await result.current.handleConnect()
        await result.current.handleSaveProfile()
      })
      expect(api.connect).not.toHaveBeenCalled()
      expect(api.saveProfile).not.toHaveBeenCalled()
      expect(result.current.connError).toBe(
        'Re-enter the password to use this saved site as a manual connection.'
      )
      act(() => result.current.onFormChange({ password: 'replacement' }))
      await act(async () => result.current.handleConnect())
      expect(api.connect).toHaveBeenCalledWith(
        expect.objectContaining({ password: 'replacement' }),
        undefined
      )
      act(() => result.current.onFormChange({ password: '' }))
      expect(result.current.requiresPasswordReentry).toBe(true)
    }
  )

  it('keeps an unchanged saved profile selected without requiring the saved password in the form', async () => {
    const { result, api } = mountConnection()
    await act(async () => result.current.handleSelectProfile('p1'))
    expect(result.current.form.password).toBe('')
    expect(result.current.requiresPasswordReentry).toBe(false)
    await act(async () => result.current.handleConnect())
    expect(api.connect).toHaveBeenCalledWith(expect.anything(), 'p1')
  })

  it('ignores a late profile resolution after a user edit', async () => {
    const resolved = gate<ResolvedProfile | null>()
    const { result } = mountConnection({ resolveProfile: vi.fn(() => resolved.promise) })
    let pending!: Promise<void>
    act(() => {
      pending = result.current.handleSelectProfile('p1')
    })
    try {
      act(() =>
        result.current.onFormChange({ host: 'edited', username: 'typed', password: 'replacement' })
      )
      await act(async () => {
        resolved.resolve(resolvedProfile())
        await pending
      })
      expect(result.current.selectedProfileId).toBe('')
      expect(result.current.form).toEqual(
        expect.objectContaining({ host: 'edited', username: 'typed', password: 'replacement' })
      )
    } finally {
      await act(async () => {
        resolved.resolve(null)
        await pending
      })
    }
  })
})

describe('SSE queue initialization', () => {
  it('uses reset/update/remove and reconnect reset as the sole authoritative source', async () => {
    let event!: (event: DownloadEvent) => void
    const api = installMockWebApi({
      onDownloadUpdate: vi.fn((callback) => {
        event = callback
        return () => undefined
      })
    })
    const options = { refreshCurrent: vi.fn(async () => false), getCwd: () => '/' }
    const { result, rerender } = renderHook(() => useTransfers(options))
    await waitFor(() => expect(api.onDownloadUpdate).toHaveBeenCalledTimes(1))
    act(() => {
      event({ type: 'reset', transfers: [transfer('old')] })
      event({ type: 'update', transfer: transfer('new') })
      event({ type: 'remove', id: 'old' })
    })
    expect(result.current.transfers.map((item) => item.id)).toEqual(['new'])
    act(() => event({ type: 'reset', transfers: [transfer('reconnected')] }))
    rerender()
    expect(result.current.transfers.map((item) => item.id)).toEqual(['reconnected'])
    expect(api.listDownloads).not.toHaveBeenCalled()
    expect(api.onDownloadUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('retry removal tombstone lifetime', () => {
  it('does not retain SSE or confirmed HTTP removal IDs when no retry request is pending', async () => {
    const marker = 'retry-idle-tombstone-marker'
    let event!: (event: DownloadEvent) => void
    const originalAdd = Set.prototype.add
    const addSpy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      return originalAdd.call(this, value)
    })
    const api = installMockWebApi({
      removeDownload: vi.fn(async () => true),
      onDownloadUpdate: vi.fn((callback) => {
        event = callback
        return () => undefined
      })
    })
    const options = { refreshCurrent: vi.fn(async () => false), getCwd: () => '/' }
    const { result, unmount } = renderHook(() => useTransfers(options))
    try {
      act(() => event({ type: 'remove', id: marker }))
      expect(result.current.retryingIds.size).toBe(0)
      expect(addSpy.mock.calls.filter(([value]) => value === marker)).toHaveLength(0)
      await act(async () => result.current.handleRemoveDownload(marker))
      expect(api.removeDownload).toHaveBeenCalledWith(marker)
      expect(addSpy.mock.calls.filter(([value]) => value === marker)).toHaveLength(0)
    } finally {
      addSpy.mockRestore()
      unmount()
    }
  })

  it('retains the actual removed-ID set until the last concurrent retry settles and retains nothing for idle removals', async () => {
    const first = gate<TransferProgress>()
    const second = gate<TransferProgress>()
    const marker = 'retry-tombstone-lifetime-marker'
    const successorId = 'retry-tombstone-removed-successor'
    let event!: (event: DownloadEvent) => void
    const observedTombstones: Set<unknown>[] = []
    const originalAdd = Set.prototype.add
    const addSpy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      if (value === marker) observedTombstones.push(this)
      return originalAdd.call(this, value)
    })
    const api = installMockWebApi({
      retryDownload: vi.fn((id) => {
        if (id === 'first') return first.promise
        if (id === 'second') return second.promise
        throw new Error(`Unexpected retry origin: ${id}`)
      }),
      removeDownload: vi.fn(async () => true),
      onDownloadUpdate: vi.fn((callback) => {
        event = callback
        return () => undefined
      })
    })
    const options = { refreshCurrent: vi.fn(async () => false), getCwd: () => '/' }
    const { result, unmount } = renderHook(() => useTransfers(options))
    const failed = (id: string): TransferProgress => ({
      ...transfer(id),
      direction: 'download',
      status: 'error',
      retryable: true,
      error: 'Connection reset.'
    })
    let firstRequest: Promise<void> | undefined
    let secondRequest: Promise<void> | undefined
    try {
      act(() => {
        event({ type: 'reset', transfers: [failed('first'), failed('second')] })
        firstRequest = result.current.handleRetryDownload('first')
        secondRequest = result.current.handleRetryDownload('second')
      })
      expect(result.current.retryingIds).toEqual(new Set(['first', 'second']))
      act(() => {
        event({ type: 'remove', id: marker })
        event({ type: 'update', transfer: { ...transfer(successorId), retryOf: 'second' } })
        event({ type: 'remove', id: successorId })
      })
      expect(observedTombstones).toHaveLength(1)
      const tombstones = observedTombstones[0]
      if (!tombstones) throw new Error('The removal tombstone set was not observed.')
      expect(tombstones.size).toBe(2)
      expect(tombstones.has(marker)).toBe(true)
      expect(tombstones.has(successorId)).toBe(true)

      await act(async () => {
        first.resolve({ ...transfer('first-successor'), retryOf: 'first' })
        await firstRequest
      })

      expect(result.current.retryingIds).toEqual(new Set(['second']))
      expect(tombstones.size).toBe(2)
      expect(tombstones.has(marker)).toBe(true)
      expect(tombstones.has(successorId)).toBe(true)

      await act(async () => {
        second.resolve({ ...transfer(successorId), retryOf: 'second' })
        await secondRequest
      })

      expect(result.current.transfers.some((item) => item.id === successorId)).toBe(false)
      expect(result.current.transfers.some((item) => item.id === 'first-successor')).toBe(true)
      expect(result.current.retryingIds.size).toBe(0)
      expect(tombstones.size).toBe(0)
      expect(tombstones.has(marker)).toBe(false)
      expect(tombstones.has(successorId)).toBe(false)
      act(() => event({ type: 'remove', id: marker }))
      await act(async () => result.current.handleRemoveDownload(marker))
      expect(api.removeDownload).toHaveBeenCalledWith(marker)
      expect(tombstones.size).toBe(0)
      expect(addSpy.mock.calls.filter(([value]) => value === marker)).toHaveLength(1)
    } finally {
      try {
        await act(async () => {
          first.resolve(transfer('first-successor'))
          second.resolve(transfer(successorId))
          await Promise.all([firstRequest, secondRequest])
        })
      } finally {
        addSpy.mockRestore()
        unmount()
      }
    }
  })
})
