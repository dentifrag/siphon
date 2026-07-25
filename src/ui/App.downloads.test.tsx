import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, screen } from '@testing-library/react'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import App from './App'
import type { DownloadEvent, RemoteEntry, TransferProgress } from '@shared/types'

function makeTransfer(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    id: 't1',
    remotePath: '/a.txt',
    localPath: '/local/a.txt',
    direction: 'download',
    status: 'downloading',
    size: 100,
    transferred: 50,
    speedBytesPerSec: 10,
    segments: 1,
    activeSegments: 1,
    ...overrides
  }
}

describe('App download behaviors', () => {
  it('shows an error and does not enqueue when no download dir is chosen', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      status: vi.fn(async () => ({ connected: true, remoteName: 'x' })),
      defaultDownloadDir: vi.fn(async () => ''),
      list: vi.fn(async (): Promise<RemoteEntry[]> => [
        { path: '/a.txt', name: 'a.txt', type: 'file', size: 10, mtime: 0 }
      ])
    })
    renderWithProviders(<App canChangePassword={false} />)

    const row = await screen.findByText('a.txt')
    await user.dblClick(row.closest('tr')!)

    expect(await screen.findByText('Choose a download folder first.')).toBeInTheDocument()
    expect(api.enqueueDownload).not.toHaveBeenCalled()
  })

  it('enqueues the download and clears selection when a dir is chosen', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      status: vi.fn(async () => ({ connected: true, remoteName: 'x' })),
      defaultDownloadDir: vi.fn(async () => '/downloads'),
      list: vi.fn(async (): Promise<RemoteEntry[]> => [
        { path: '/a.txt', name: 'a.txt', type: 'file', size: 10, mtime: 0 }
      ]),
      enqueueDownload: vi.fn(async () => [makeTransfer()])
    })
    renderWithProviders(<App canChangePassword={false} />)

    const row = await screen.findByText('a.txt')
    await user.click(row.closest('tr')!)
    await user.click(screen.getByRole('button', { name: /Download/ }))

    expect(api.enqueueDownload).toHaveBeenCalledWith({
      remotePath: '/a.txt',
      downloadDir: '/downloads',
      segments: 4
    })
    expect(screen.getByRole('button', { name: /Download/ })).toBeDisabled()
  })

  it('shows a message when the enqueue result is empty', async () => {
    const user = userEvent.setup()
    installMockWebApi({
      status: vi.fn(async () => ({ connected: true, remoteName: 'x' })),
      defaultDownloadDir: vi.fn(async () => '/downloads'),
      list: vi.fn(async (): Promise<RemoteEntry[]> => [
        { path: '/a.txt', name: 'a.txt', type: 'file', size: 10, mtime: 0 }
      ]),
      enqueueDownload: vi.fn(async () => [])
    })
    renderWithProviders(<App canChangePassword={false} />)

    const row = await screen.findByText('a.txt')
    await user.click(row.closest('tr')!)
    await user.click(screen.getByRole('button', { name: /Download/ }))

    expect(await screen.findByText('That folder has no files to download.')).toBeInTheDocument()
  })

  it('applies reset, remove, and update events from onDownloadUpdate', async () => {
    let capturedCallback: ((event: DownloadEvent) => void) | undefined
    installMockWebApi({
      onDownloadUpdate: vi.fn((callback) => {
        capturedCallback = callback
        return () => {}
      })
    })
    renderWithProviders(<App canChangePassword={false} />)

    await screen.findByText('No transfers yet.')

    act(() => {
      capturedCallback?.({ type: 'reset', transfers: [makeTransfer({ id: 't1' })] })
    })
    expect(await screen.findByText('a.txt')).toBeInTheDocument()

    act(() => {
      capturedCallback?.({
        type: 'update',
        transfer: makeTransfer({ id: 't2', remotePath: '/b.txt', localPath: '/local/b.txt' })
      })
    })
    expect(await screen.findByText('b.txt')).toBeInTheDocument()
    expect(screen.getByText('a.txt')).toBeInTheDocument()

    act(() => {
      capturedCallback?.({ type: 'remove', id: 't1' })
    })
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
    expect(screen.getByText('b.txt')).toBeInTheDocument()
  })
})
