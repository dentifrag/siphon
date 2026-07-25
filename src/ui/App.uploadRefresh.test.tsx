import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import App from './App'
import type { DownloadEvent, RemoteEntry, TransferProgress } from '@shared/types'

function makeTransfer(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    id: 't1',
    remotePath: '/a.txt',
    localPath: '/local/a.txt',
    direction: 'upload',
    status: 'completed',
    size: 100,
    transferred: 100,
    speedBytesPerSec: 0,
    segments: 1,
    activeSegments: 0,
    uploadRemoteDir: '',
    ...overrides
  }
}

describe('App upload-completion refresh debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('only refreshes for direction upload and status completed', () => {
    let capturedCallback: ((event: DownloadEvent) => void) | undefined
    const api = installMockWebApi({
      onDownloadUpdate: vi.fn((callback) => {
        capturedCallback = callback
        return () => {}
      })
    })
    renderWithProviders(<App canChangePassword={false} />)

    act(() => {
      capturedCallback?.({
        type: 'update',
        transfer: makeTransfer({ direction: 'download', status: 'completed' })
      })
    })
    act(() => {
      capturedCallback?.({
        type: 'update',
        transfer: makeTransfer({ direction: 'upload', status: 'downloading' })
      })
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(api.list).not.toHaveBeenCalled()

    act(() => {
      capturedCallback?.({
        type: 'update',
        transfer: makeTransfer({ direction: 'upload', status: 'completed', uploadRemoteDir: '' })
      })
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(api.list).toHaveBeenCalledWith('/')
  })

  it('normalizes an empty uploadRemoteDir to match cwd "/"', () => {
    let capturedCallback: ((event: DownloadEvent) => void) | undefined
    const api = installMockWebApi({
      onDownloadUpdate: vi.fn((callback) => {
        capturedCallback = callback
        return () => {}
      })
    })
    renderWithProviders(<App canChangePassword={false} />)

    act(() => {
      capturedCallback?.({ type: 'update', transfer: makeTransfer({ uploadRemoteDir: '' }) })
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(api.list).toHaveBeenCalledWith('/')
  })

  it('coalesces multiple qualifying completions into a single 600ms timer', () => {
    let capturedCallback: ((event: DownloadEvent) => void) | undefined
    const api = installMockWebApi({
      onDownloadUpdate: vi.fn((callback) => {
        capturedCallback = callback
        return () => {}
      })
    })
    renderWithProviders(<App canChangePassword={false} />)

    act(() => {
      capturedCallback?.({
        type: 'update',
        transfer: makeTransfer({ id: 't1', uploadRemoteDir: '' })
      })
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    act(() => {
      capturedCallback?.({
        type: 'update',
        transfer: makeTransfer({ id: 't2', uploadRemoteDir: '' })
      })
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(api.list).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(api.list).toHaveBeenCalledTimes(1)
  })

  it('cancels the refresh when the cwd changes before the timer fires', async () => {
    let capturedCallback: ((event: DownloadEvent) => void) | undefined
    const api = installMockWebApi({
      status: vi.fn(async () => ({ connected: true, remoteName: 'x' })),
      list: vi.fn(async (dir: string): Promise<RemoteEntry[]> => {
        if (dir === '/') {
          return [{ path: '/elsewhere', name: 'elsewhere', type: 'directory', size: 0, mtime: 0 }]
        }
        return []
      }),
      onDownloadUpdate: vi.fn((callback) => {
        capturedCallback = callback
        return () => {}
      })
    })
    renderWithProviders(<App canChangePassword={false} />)
    await vi.waitFor(() => expect(screen.getByText('elsewhere')).toBeInTheDocument())

    act(() => {
      capturedCallback?.({ type: 'update', transfer: makeTransfer({ uploadRemoteDir: '' }) })
    })

    const row = screen.getByText('elsewhere')
    fireEvent.doubleClick(row.closest('tr')!)
    await vi.waitFor(() => expect(screen.getByText('This folder is empty.')).toBeInTheDocument())
    vi.mocked(api.list).mockClear()

    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(api.list).not.toHaveBeenCalled()
  })

  it('clears the pending timer on unmount', () => {
    let capturedCallback: ((event: DownloadEvent) => void) | undefined
    const api = installMockWebApi({
      onDownloadUpdate: vi.fn((callback) => {
        capturedCallback = callback
        return () => {}
      })
    })
    const { unmount } = renderWithProviders(<App canChangePassword={false} />)

    act(() => {
      capturedCallback?.({ type: 'update', transfer: makeTransfer({ uploadRemoteDir: '' }) })
    })
    unmount()
    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(api.list).not.toHaveBeenCalled()
  })
})
