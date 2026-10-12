import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DownloadPlan } from '@shared/api'
import type { DownloadEvent, TransferProgress } from '@shared/types'
import App from './App'
import { installMockWebApi } from './test/mockWebApi'
import { renderWithProviders } from './test/renderWithProviders'

function plan(overrides: Partial<DownloadPlan> = {}): DownloadPlan {
  return {
    id: 'plan-1',
    expiresAt: Date.now() + 300_000,
    fileCount: 1,
    batch: false,
    conflicts: [
      {
        entryId: 'entry-a',
        remotePath: '/a.bin',
        localPath: 'D:\\Downloads\\a.bin',
        canOverwrite: true
      }
    ],
    ...overrides
  }
}

async function mount(downloadPlan = plan()) {
  const api = installMockWebApi({
    status: vi.fn(async () => ({
      connected: true,
      remoteName: 'remote',
      connectionRevision: 'r1'
    })),
    defaultDownloadDir: vi.fn(async () => 'D:\\Downloads'),
    list: vi.fn(async () =>
      ['a.bin', 'b.bin'].map((name) => ({
        name,
        path: `/${name}`,
        type: 'file' as const,
        size: 1,
        mtime: 0
      }))
    ),
    planDownload: vi.fn(async () => downloadPlan),
    commitDownload: vi.fn(async () => ({ transfers: [], skipped: [], empty: false }))
  })
  const rendered = renderWithProviders(<App canChangePassword={false} />)
  const user = userEvent.setup()
  const table = await screen.findByRole('table')
  await waitFor(() => expect(screen.getByLabelText('Download folder')).toHaveValue('D:\\Downloads'))
  return { api, user, table, ...rendered }
}

describe('download collision decisions', () => {
  it('offers Overwrite/Cancel, defaults to preserving existing content, and commits only after the explicit choice', async () => {
    const { api, user, table } = await mount()
    await user.dblClick(within(table).getByText('a.bin').closest('tr')!)
    const dialog = await screen.findByRole('dialog', { name: 'Download destination exists' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(within(dialog).getByText('D:\\Downloads\\a.bin', { exact: false })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Skip this file' })).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/keep both|resume|overwrite all/i)).not.toBeInTheDocument()
    expect(api.commitDownload).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(api.planDownload).toHaveBeenCalledOnce()
    await user.click(within(dialog).getByRole('button', { name: 'Overwrite' }))
    await waitFor(() =>
      expect(api.commitDownload).toHaveBeenCalledWith({
        planId: 'plan-1',
        decisions: { 'entry-a': 'overwrite' }
      })
    )
    expect(api.releaseDownloadPlan).toHaveBeenCalledWith('plan-1')
  })

  it.each(['cancel', 'escape'] as const)('cancels without admission through %s', async (action) => {
    const { api, user, table } = await mount()
    await user.dblClick(within(table).getByText('a.bin').closest('tr')!)
    const dialog = await screen.findByRole('dialog', { name: 'Download destination exists' })
    if (action === 'cancel')
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    else await user.keyboard('{Escape}')
    await waitFor(() => expect(api.releaseDownloadPlan).toHaveBeenCalledWith('plan-1'))
    expect(api.commitDownload).not.toHaveBeenCalled()
    expect(screen.getByText('No transfers yet.')).toBeInTheDocument()
  })

  it('plans the whole selection once and queues nothing if a later collision cancels the batch', async () => {
    const batch = plan({
      batch: true,
      fileCount: 2,
      conflicts: [
        ...plan().conflicts,
        {
          entryId: 'entry-b',
          remotePath: '/b.bin',
          localPath: 'D:\\Downloads\\b.bin',
          canOverwrite: true
        }
      ]
    })
    const { api, user, table } = await mount(batch)
    await user.click(within(table).getByText('a.bin').closest('tr')!)
    await user.keyboard('{Control>}')
    await user.click(within(table).getByText('b.bin').closest('tr')!)
    await user.keyboard('{/Control}')
    await user.click(screen.getByRole('button', { name: /Download/ }))
    let dialog = await screen.findByRole('dialog', { name: 'Download destination exists' })
    expect(api.planDownload).toHaveBeenCalledWith({
      remotePaths: ['/a.bin', '/b.bin'],
      downloadDir: 'D:\\Downloads',
      segments: 4,
      connectionRevision: 'r1'
    })
    expect(within(dialog).getByText(/Collision 1 of 2/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Overwrite' }))
    dialog = await screen.findByRole('dialog', { name: 'Download destination exists' })
    expect(within(dialog).getByText(/Collision 2 of 2/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel batch' })).toHaveFocus()
    expect(api.commitDownload).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel batch' }))
    await waitFor(() => expect(api.releaseDownloadPlan).toHaveBeenCalledOnce())
    expect(api.commitDownload).not.toHaveBeenCalled()
    expect(api.enqueueDownload).not.toHaveBeenCalled()
  })

  it('reports all-skipped outcomes explicitly rather than empty folders or completed files', async () => {
    const { api, user, table } = await mount(plan({ batch: true }))
    vi.mocked(api.commitDownload).mockResolvedValue({
      transfers: [],
      skipped: ['/a.bin'],
      empty: false
    })
    await user.dblClick(within(table).getByText('a.bin').closest('tr')!)
    const dialog = await screen.findByRole('dialog', { name: 'Download destination exists' })
    await user.click(within(dialog).getByRole('button', { name: 'Skip this file' }))
    expect(
      await screen.findByText('Skipped 1 file. Existing content was preserved.')
    ).toBeInTheDocument()
    expect(api.commitDownload).toHaveBeenCalledWith({
      planId: 'plan-1',
      decisions: { 'entry-a': 'skip' }
    })
    expect(screen.queryByText('That folder has no files to download.')).not.toBeInTheDocument()
    expect(screen.queryByText('Download completed')).not.toBeInTheDocument()
  })

  it('does not offer destructive overwrite for a file/directory type conflict', async () => {
    const { api, user, table } = await mount(
      plan({
        batch: true,
        conflicts: [{ ...plan().conflicts[0], canOverwrite: false }]
      })
    )
    await user.dblClick(within(table).getByText('a.bin').closest('tr')!)
    const dialog = await screen.findByRole('dialog', { name: 'Download destination exists' })
    expect(within(dialog).queryByRole('button', { name: 'Overwrite' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel batch' }))
    expect(api.commitDownload).not.toHaveBeenCalled()
  })

  it.each([
    'DESTINATION_COLLISION',
    'DESTINATION_BUSY',
    'DESTINATION_CHANGED',
    'DOWNLOAD_PLAN_EXPIRED'
  ])('does not classify %s as a connection conflict', async (code) => {
    const { api, user, table } = await mount(plan({ conflicts: [] }))
    vi.mocked(api.commitDownload).mockRejectedValue(
      Object.assign(new Error('Download decision failed'), { status: 409, code })
    )
    await user.dblClick(within(table).getByText('a.bin').closest('tr')!)
    expect(await screen.findByText('Download decision failed')).toBeInTheDocument()
    expect(
      screen.queryByText('The connection changed. Reconnect before continuing.')
    ).not.toBeInTheDocument()
    expect(api.disconnect).not.toHaveBeenCalled()
  })

  it('classifies only the explicit connection-changed code as a connection conflict', async () => {
    const { api, user, table } = await mount(plan({ conflicts: [] }))
    vi.mocked(api.commitDownload).mockRejectedValue(
      Object.assign(new Error('Stale source'), { status: 409, code: 'CONNECTION_CHANGED' })
    )
    await user.dblClick(within(table).getByText('a.bin').closest('tr')!)
    expect(
      await screen.findByText('The connection changed. Reconnect before continuing.')
    ).toBeInTheDocument()
  })

  it('releases a pending choice on unmount rather than admitting its prepared source', async () => {
    const { api, user, table, unmount } = await mount()
    await user.dblClick(within(table).getByText('a.bin').closest('tr')!)
    await screen.findByRole('dialog', { name: 'Download destination exists' })
    unmount()
    await waitFor(() => expect(api.releaseDownloadPlan).toHaveBeenCalledWith('plan-1'))
    expect(api.commitDownload).not.toHaveBeenCalled()
  })

  it('routes failed-download retry through the same collision dialog and displays the recovery path', async () => {
    const transfer: TransferProgress = {
      id: 'failed',
      remotePath: '/original/a.bin',
      localPath: 'D:\\Downloads\\a.bin',
      status: 'error',
      error: 'Connection reset.',
      retryable: true,
      size: 1,
      transferred: 0,
      speedBytesPerSec: 0,
      activeSegments: 0,
      segments: 4
    }
    let event!: (event: DownloadEvent) => void
    const api = installMockWebApi({
      onDownloadUpdate: vi.fn((callback) => {
        event = callback
        return () => {}
      }),
      planDownloadRetry: vi.fn(async () => plan()),
      commitDownload: vi.fn(async () => ({
        transfers: [
          {
            ...transfer,
            id: 'successor',
            retryOf: 'failed',
            status: 'queued' as const,
            retryable: undefined
          }
        ],
        skipped: [],
        empty: false
      }))
    })
    renderWithProviders(<App canChangePassword={false} />)
    act(() => event({ type: 'reset', transfers: [transfer] }))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    const dialog = await screen.findByRole('dialog', { name: 'Download destination exists' })
    expect(api.planDownloadRetry).toHaveBeenCalledWith('failed')
    expect(api.retryDownload).not.toHaveBeenCalled()
    expect(api.planDownload).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Overwrite' }))
    await waitFor(() => expect(api.commitDownload).toHaveBeenCalledOnce())
    act(() =>
      event({
        type: 'update',
        transfer: {
          ...transfer,
          id: 'successor',
          status: 'completed',
          transferred: 1,
          retryOf: 'failed',
          recoveryPath: 'D:\\Downloads\\.siphon-download-example\\previous'
        }
      })
    )
    expect(
      screen.getByText(
        'Preserved recovery content: D:\\Downloads\\.siphon-download-example\\previous'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Download completed')).toBeInTheDocument()
    expect(
      screen.getAllByRole('progressbar').some((bar) => bar.getAttribute('aria-valuenow') === '100')
    ).toBe(true)
  })
})
