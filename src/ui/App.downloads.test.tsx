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
  it.each([
    {
      name: 'ordinary file',
      transfer: { size: 100, transferred: 100 },
      bytes: '100 B / 100 B'
    },
    {
      name: 'directory child',
      transfer: {
        remotePath: 'movies/sub/a.txt',
        localPath: 'C:\\downloads\\movies\\sub\\a.txt',
        size: 100,
        transferred: 100
      },
      bytes: '100 B / 100 B'
    },
    {
      name: 'empty file',
      transfer: { size: 0, transferred: 0 },
      bytes: '0 B / 0 B'
    },
    {
      name: 'directory child without reported bytes',
      transfer: {
        remotePath: 'movies/sub/a.txt',
        localPath: 'C:\\downloads\\movies\\sub\\a.txt',
        size: 0,
        transferred: 0
      },
      bytes: '0 B / 0 B'
    },
    {
      name: 'unknown-size file with reported bytes',
      transfer: { size: 0, transferred: 50 },
      bytes: '50 B / 0 B'
    },
    {
      name: 'file with incomplete byte statistics',
      transfer: { size: 100, transferred: 50 },
      bytes: '50 B / 100 B'
    },
    {
      name: 'empty upload',
      transfer: { direction: 'upload' as const, size: 0, transferred: 0 },
      bytes: '0 B / 0 B'
    }
  ])(
    'shows a full green completed bar for $name without changing bytes',
    async ({ transfer, bytes }) => {
      installMockWebApi({
        onDownloadUpdate: vi.fn((callback: (event: DownloadEvent) => void) => {
          callback({
            type: 'reset',
            transfers: [makeTransfer({ ...transfer, status: 'completed' })]
          })
          return () => {}
        })
      })
      renderWithProviders(<App canChangePassword={false} />)

      const bar = await screen.findByRole('progressbar')
      expect(bar.style.getPropertyValue('--progress-width')).toBe('100%')
      expect(bar.style.getPropertyValue('--progress-bg')).toBe('var(--bgColor-success-emphasis)')
      expect(bar).toHaveAccessibleName('a.txt 100%')
      expect(bar).toHaveAttribute('aria-valuenow', '100')
      expect(
        screen.getByText(
          transfer.direction === 'upload' ? 'Upload completed' : 'Download completed'
        )
      ).toBeInTheDocument()
      expect(screen.getByText(`${bytes} (100%)`)).toBeInTheDocument()
    }
  )

  it.each([
    { status: 'queued', size: 100, transferred: 0, percent: 0, bg: 'accent' },
    { status: 'downloading', size: 100, transferred: 50, percent: 50, bg: 'accent' },
    { status: 'downloading', size: 0, transferred: 0, percent: 0, bg: 'accent' },
    { status: 'downloading', size: 0, transferred: 50, percent: 100, bg: 'accent' },
    { status: 'error', size: 100, transferred: 50, percent: 50, bg: 'danger' },
    { status: 'error', size: 0, transferred: 0, percent: 0, bg: 'danger' },
    { status: 'canceled', size: 100, transferred: 50, percent: 50, bg: 'neutral' },
    { status: 'canceled', size: 0, transferred: 0, percent: 0, bg: 'neutral' },
    {
      status: 'downloading',
      canceling: true,
      size: 100,
      transferred: 50,
      percent: 50,
      bg: 'accent'
    }
  ] as const)(
    'preserves byte-based progress and color for $status ($transferred/$size, canceling=$canceling)',
    async ({ percent, bg, ...input }) => {
      installMockWebApi({
        onDownloadUpdate: vi.fn((callback: (event: DownloadEvent) => void) => {
          callback({ type: 'reset', transfers: [makeTransfer(input)] })
          return () => {}
        })
      })
      renderWithProviders(<App canChangePassword={false} />)

      const bar = await screen.findByRole('progressbar')
      expect(bar.style.getPropertyValue('--progress-width')).toBe(`${percent}%`)
      expect(bar.style.getPropertyValue('--progress-bg')).toBe(`var(--bgColor-${bg}-emphasis)`)
      expect(bar).toHaveAccessibleName(`a.txt ${percent}%`)
      expect(bar).toHaveAttribute('aria-valuenow', String(percent))
      expect(
        screen.getByText(`${input.transferred} B / ${input.size} B (${percent}%)`)
      ).toBeInTheDocument()
      if ('canceling' in input) {
        expect(screen.getByText('Canceling…')).toBeInTheDocument()
      }
    }
  )

  it('fills the bar when a directory child completes without byte statistics', async () => {
    let capturedCallback: ((event: DownloadEvent) => void) | undefined
    installMockWebApi({
      onDownloadUpdate: vi.fn((callback) => {
        capturedCallback = callback
        return () => {}
      })
    })
    renderWithProviders(<App canChangePassword={false} />)
    await screen.findByText('No transfers yet.')

    const transfer = makeTransfer({
      remotePath: 'movies/sub/a.txt',
      localPath: 'C:\\downloads\\movies\\sub\\a.txt',
      size: 0,
      transferred: 0
    })
    act(() => {
      capturedCallback?.({ type: 'update', transfer })
    })
    const bar = screen.getByRole('progressbar')
    expect(bar.style.getPropertyValue('--progress-width')).toBe('0%')
    expect(screen.getByText('Downloading')).toBeInTheDocument()

    act(() => {
      capturedCallback?.({
        type: 'update',
        transfer: { ...transfer, status: 'completed', speedBytesPerSec: 0, activeSegments: 0 }
      })
    })

    expect(bar.style.getPropertyValue('--progress-width')).toBe('100%')
    expect(bar.style.getPropertyValue('--progress-bg')).toBe('var(--bgColor-success-emphasis)')
    expect(bar).toHaveAccessibleName('a.txt 100%')
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByText('Download completed')).toBeInTheDocument()
    expect(screen.getByText('0 B / 0 B (100%)')).toBeInTheDocument()
  })

  it.each([0, 4])(
    'shows the configured stream limit instead of an active count of %i',
    async (activeSegments) => {
      installMockWebApi({
        onDownloadUpdate: vi.fn((callback: (event: DownloadEvent) => void) => {
          callback({
            type: 'reset',
            transfers: [
              makeTransfer({
                remotePath: '/movies',
                localPath: '/local/movies',
                size: 4096,
                segments: 4,
                activeSegments
              })
            ]
          })
          return () => {}
        })
      })
      renderWithProviders(<App canChangePassword={false} />)

      expect(await screen.findByText(/up to 4 segments/)).toBeInTheDocument()
      expect(screen.queryByText(/\d+\/4 segments/)).not.toBeInTheDocument()
    }
  )

  it('does not show a download stream limit for uploads', async () => {
    installMockWebApi({
      onDownloadUpdate: vi.fn((callback: (event: DownloadEvent) => void) => {
        callback({ type: 'reset', transfers: [makeTransfer({ direction: 'upload' })] })
        return () => {}
      })
    })
    renderWithProviders(<App canChangePassword={false} />)

    expect(await screen.findByText('Uploading')).toBeInTheDocument()
    expect(screen.queryByText(/segments/)).not.toBeInTheDocument()
  })

  it('shows an error and does not enqueue when no download dir is chosen', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      status: vi.fn(async () => ({
        connected: true,
        remoteName: 'x',
        connectionRevision: 'r1'
      })),
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
      status: vi.fn(async () => ({
        connected: true,
        remoteName: 'x',
        connectionRevision: 'r1'
      })),
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
      segments: 4,
      connectionRevision: 'r1'
    })
    expect(screen.getByRole('button', { name: /Download/ })).toBeDisabled()
  })

  it('shows a message when the enqueue result is empty', async () => {
    const user = userEvent.setup()
    installMockWebApi({
      status: vi.fn(async () => ({
        connected: true,
        remoteName: 'x',
        connectionRevision: 'r1'
      })),
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
