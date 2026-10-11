import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import { MAX_CONCURRENT_STORAGE_KEY } from './lib/storage'
import App from './App'
import type { DownloadEnqueueInput } from '@shared/api'
import type { DownloadEvent, RemoteEntry, TransferProgress } from '@shared/types'

describe('App queued download segment requests', () => {
  it('keeps concurrency independent of saved and future segment requests', async () => {
    const user = userEvent.setup()
    localStorage.setItem(MAX_CONCURRENT_STORAGE_KEY, '1')
    let onDownloadUpdate: ((event: DownloadEvent) => void) | undefined
    const returnedTransfers: TransferProgress[] = []
    const api = installMockWebApi({
      status: vi.fn(async () => ({
        connected: true,
        remoteName: 'x',
        connectionRevision: 'r1'
      })),
      defaultDownloadDir: vi.fn(async () => '/downloads'),
      list: vi.fn(async (): Promise<RemoteEntry[]> =>
        ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin'].map((name) => ({
          path: `/${name}`,
          name,
          type: 'file',
          size: 100 * 1024 * 1024,
          mtime: 0
        }))
      ),
      enqueueDownload: vi.fn(async (input: DownloadEnqueueInput) => {
        const transfer: TransferProgress = {
          id: `t-${returnedTransfers.length + 1}`,
          remotePath: input.remotePath,
          localPath: `${input.downloadDir}${input.remotePath}`,
          direction: 'download',
          status: 'queued',
          size: 100 * 1024 * 1024,
          transferred: 0,
          speedBytesPerSec: 0,
          segments: input.segments,
          activeSegments: 0
        }
        returnedTransfers.push(transfer)
        return [transfer]
      }),
      onDownloadUpdate: vi.fn((callback) => {
        onDownloadUpdate = callback
        return () => {}
      })
    })
    renderWithProviders(<App canChangePassword={false} />)

    await screen.findByText('a.bin')
    await waitFor(() => expect(api.setMaxConcurrentDownloads).toHaveBeenCalledWith(1))
    await waitFor(() => expect(screen.getByLabelText('Download folder')).toHaveValue('/downloads'))
    const segmentsInput = screen.getByLabelText('Segments')
    await user.clear(segmentsInput)
    await user.type(segmentsInput, '8')

    const browser = screen.getByRole('table')
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      await user.dblClick(within(browser).getByText(name).closest('tr')!)
    }
    expect(vi.mocked(api.enqueueDownload).mock.calls).toEqual(
      ['a.bin', 'b.bin', 'c.bin'].map((name) => [
        {
          remotePath: `/${name}`,
          downloadDir: '/downloads',
          segments: 8,
          connectionRevision: 'r1'
        }
      ])
    )

    act(() => {
      onDownloadUpdate?.({ type: 'reset', transfers: [...returnedTransfers] })
    })
    const queue = (await screen.findByRole('heading', { name: 'Transfers (3)' })).closest(
      'section'
    )!
    const originalRows = within(queue).getAllByRole('listitem')
    expect(originalRows).toHaveLength(3)
    expect(within(queue).getAllByText('Download queued')).toHaveLength(3)

    const concurrentInput = screen.getByLabelText('Concurrent')
    await user.clear(concurrentInput)
    await user.type(concurrentInput, '3')
    await waitFor(() => expect(api.setMaxConcurrentDownloads).toHaveBeenCalledWith(3))

    expect(vi.mocked(api.setMaxConcurrentDownloads).mock.calls).toEqual([[1], [3]])
    expect(api.enqueueDownload).toHaveBeenCalledTimes(3)
    expect(segmentsInput).toHaveValue(8)
    for (const row of originalRows) {
      expect(row).toBeInTheDocument()
      expect(row).toHaveTextContent('Download queued')
    }

    await user.dblClick(within(browser).getByText('d.bin').closest('tr')!)
    expect(api.enqueueDownload).toHaveBeenNthCalledWith(4, {
      remotePath: '/d.bin',
      downloadDir: '/downloads',
      segments: 8,
      connectionRevision: 'r1'
    })

    await user.clear(segmentsInput)
    await user.type(segmentsInput, '2')
    await user.dblClick(within(browser).getByText('e.bin').closest('tr')!)

    expect(vi.mocked(api.enqueueDownload).mock.calls).toEqual(
      ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin'].map((name, index) => [
        {
          remotePath: `/${name}`,
          downloadDir: '/downloads',
          segments: index === 4 ? 2 : 8,
          connectionRevision: 'r1'
        }
      ])
    )
    expect(returnedTransfers.map(({ segments }) => segments)).toEqual([8, 8, 8, 8, 2])
    expect(vi.mocked(api.setMaxConcurrentDownloads).mock.calls).toEqual([[1], [3]])
    expect(concurrentInput).toHaveValue(3)
    for (const row of originalRows) {
      expect(row).toBeInTheDocument()
      expect(row).toHaveTextContent('Download queued')
    }
  })
})
