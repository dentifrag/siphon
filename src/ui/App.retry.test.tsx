import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, screen, within } from '@testing-library/react'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import App from './App'
import type { DownloadEvent, TransferProgress } from '@shared/types'

// Pins the UI contract for "Retry failed downloads": window.api.retryDownload(id) and the
// TransferProgress.retryable/retryOf/retriedAs fields.

type RetryableTransferProgress = TransferProgress & {
  retryable?: boolean
  retryOf?: string
  retriedAs?: string
}

function makeTransfer(
  overrides: Partial<RetryableTransferProgress> = {}
): RetryableTransferProgress {
  return {
    id: 't1',
    remotePath: '/a.txt',
    localPath: '/local/a.txt',
    direction: 'download',
    status: 'error',
    error: 'Connection reset.',
    size: 100,
    transferred: 40,
    speedBytesPerSec: 0,
    segments: 1,
    activeSegments: 0,
    retryable: true,
    ...overrides
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function renderWithTransfer(
  transfer: RetryableTransferProgress,
  overrides: Record<string, unknown> = {}
) {
  let capturedCallback: ((event: DownloadEvent) => void) | undefined
  const api = installMockWebApi({
    onDownloadUpdate: vi.fn((callback: (event: DownloadEvent) => void) => {
      capturedCallback = callback
      return () => {}
    }),
    ...overrides
  })
  renderWithProviders(<App canChangePassword={false} />)
  await screen.findByText('No transfers yet.')

  const emit = (event: DownloadEvent): void => {
    act(() => {
      capturedCallback?.(event)
    })
  }
  emit({ type: 'reset', transfers: [transfer] })

  const row = (await screen.findByText('a.txt')).closest('li') as HTMLElement
  return { api, row, emit }
}

describe('App download retry', () => {
  it.each([
    { label: 'a retryable failed download', overrides: {}, visible: true },
    {
      label: 'a consumed failed download (already retried)',
      overrides: { retryable: false, retriedAs: 't2' },
      visible: false
    },
    { label: 'a failed upload', overrides: { direction: 'upload' as const }, visible: false },
    {
      label: 'a canceled download',
      overrides: { status: 'canceled' as const, retryable: undefined, error: undefined },
      visible: false
    },
    {
      label: 'a completed download',
      overrides: {
        status: 'completed' as const,
        retryable: undefined,
        error: undefined,
        transferred: 100
      },
      visible: false
    },
    {
      label: 'a queued download',
      overrides: { status: 'queued' as const, retryable: undefined, error: undefined },
      visible: false
    },
    {
      label: 'a downloading (in-progress) download',
      overrides: { status: 'downloading' as const, retryable: undefined, error: undefined },
      visible: false
    }
  ])(
    'shows a Retry button only for an eligible failed download ($label -> $visible)',
    async ({ overrides, visible }) => {
      const { row } = await renderWithTransfer(makeTransfer(overrides))
      const retryButton = within(row).queryByRole('button', { name: /retry/i })
      if (visible) expect(retryButton).toBeInTheDocument()
      else expect(retryButton).not.toBeInTheDocument()
    }
  )

  it('calls api.retryDownload with the transfer id and disables Retry while the request is in flight', async () => {
    const user = userEvent.setup()
    const gate = deferred<TransferProgress>()
    const retryDownload = vi.fn(() => gate.promise)
    const { row } = await renderWithTransfer(makeTransfer(), { retryDownload })

    const retryButton = within(row).getByRole('button', { name: /retry/i })
    await user.click(retryButton)

    expect(retryDownload).toHaveBeenCalledWith('t1')
    expect(within(row).getByRole('button', { name: /retry/i })).toBeDisabled()

    gate.resolve(makeTransfer({ id: 't2', retryOf: 't1', status: 'queued', retryable: undefined }))
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('shows a visible request error separate from the original failure, keeping the original diagnostics intact', async () => {
    const user = userEvent.setup()
    const retryDownload = vi.fn().mockRejectedValue(new Error('Destination busy.'))
    const { row } = await renderWithTransfer(makeTransfer(), { retryDownload })

    const retryButton = within(row).getByRole('button', { name: /retry/i })
    await user.click(retryButton)

    expect(await within(row).findByText('Destination busy.')).toBeInTheDocument()
    expect(within(row).getByText('Connection reset.')).toBeInTheDocument()
  })

  it('hides Retry as soon as an SSE update reports the origin was consumed, without waiting on the pending HTTP response', async () => {
    const user = userEvent.setup()
    const gate = deferred<TransferProgress>()
    const retryDownload = vi.fn(() => gate.promise)
    const { row, emit } = await renderWithTransfer(makeTransfer(), { retryDownload })

    await user.click(within(row).getByRole('button', { name: /retry/i }))

    emit({
      type: 'update',
      transfer: makeTransfer({ retryable: false, retriedAs: 't2' })
    })

    expect(within(row).queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('does not duplicate or overwrite a successor row when the HTTP retry response arrives after the SSE already reported it', async () => {
    const gate = deferred<TransferProgress>()
    const retryDownload = vi.fn(() => gate.promise)
    const { row, emit } = await renderWithTransfer(makeTransfer(), { retryDownload })
    // The transfer list's own <ul>: scoping here excludes Primer's unrelated SegmentedControl
    // tabs, which render their own <li> items with role="listitem" in the same document.
    const transferList = row.parentElement as HTMLElement

    await userEvent.setup().click(within(row).getByRole('button', { name: /retry/i }))

    emit({
      type: 'update',
      transfer: makeTransfer({
        id: 't2',
        retryOf: 't1',
        status: 'downloading',
        transferred: 77,
        retryable: undefined,
        error: undefined
      })
    })

    expect(within(transferList).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByLabelText('a.txt 77%')).toBeInTheDocument()

    gate.resolve(
      makeTransfer({
        id: 't2',
        retryOf: 't1',
        status: 'downloading',
        transferred: 0,
        retryable: undefined,
        error: undefined
      })
    )
    await act(async () => {
      await Promise.resolve()
    })

    expect(within(transferList).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByLabelText('a.txt 77%')).toBeInTheDocument()
    expect(screen.queryByLabelText('a.txt 0%')).not.toBeInTheDocument()
  })

  it.each([
    {
      name: 'the origin row is removed via an SSE remove event',
      trigger: (emit: (event: DownloadEvent) => void) => emit({ type: 'remove', id: 't1' }),
      assertFinal: () => {
        expect(screen.getByText('No transfers yet.')).toBeInTheDocument()
      }
    },
    {
      name: 'a reset SSE event arrives without the origin',
      trigger: (emit: (event: DownloadEvent) => void) => emit({ type: 'reset', transfers: [] }),
      assertFinal: () => {
        expect(screen.getByText('No transfers yet.')).toBeInTheDocument()
      }
    },
    {
      name: 'the successor was already delivered via SSE and then removed',
      trigger: (emit: (event: DownloadEvent) => void) => {
        emit({
          type: 'update',
          transfer: makeTransfer({
            id: 't2',
            retryOf: 't1',
            status: 'downloading',
            transferred: 33,
            retryable: undefined,
            error: undefined
          })
        })
        emit({ type: 'remove', id: 't2' })
      },
      assertFinal: () => {
        // The origin itself was never removed, so it must still be visible, unaffected.
        expect(screen.getByLabelText('a.txt 40%')).toBeInTheDocument()
      }
    }
  ])(
    'does not resurrect the retry successor from a late HTTP response once $name',
    async ({ trigger, assertFinal }) => {
      const gate = deferred<TransferProgress>()
      const retryDownload = vi.fn(() => gate.promise)
      const { row, emit } = await renderWithTransfer(makeTransfer(), { retryDownload })

      await userEvent.setup().click(within(row).getByRole('button', { name: /retry/i }))

      trigger(emit)

      gate.resolve(
        makeTransfer({
          id: 't2',
          retryOf: 't1',
          status: 'downloading',
          transferred: 33,
          retryable: undefined,
          error: undefined
        })
      )
      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.queryByLabelText('a.txt 33%')).not.toBeInTheDocument()
      assertFinal()
    }
  )
})
