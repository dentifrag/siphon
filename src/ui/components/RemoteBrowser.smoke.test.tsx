import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { BaseStyles, ThemeProvider } from '@primer/react'
import { renderWithProviders } from '../test/renderWithProviders'
import { RemoteBrowser } from './RemoteBrowser'
import type { RemoteEntry } from '@shared/types'

function makeEntries(): RemoteEntry[] {
  return [
    { path: '/docs', name: 'docs', type: 'directory', size: 0, mtime: 0 },
    { path: '/readme.txt', name: 'readme.txt', type: 'file', size: 42, mtime: 0 }
  ]
}

function renderBrowser(overrides: Partial<Parameters<typeof RemoteBrowser>[0]> = {}) {
  const onNavigate = vi.fn()
  const onSelectionChange = vi.fn()
  const props = {
    connected: true,
    cwd: '/',
    entries: makeEntries(),
    loading: false,
    error: null,
    selected: new Set<string>(),
    canDownload: true,
    suspended: false,
    onNavigate,
    onRefresh: vi.fn(),
    onSelectionChange,
    onDownloadSelected: vi.fn(),
    onDownloadEntry: vi.fn(),
    onUpload: vi.fn(),
    ...overrides
  }
  const result = renderWithProviders(<RemoteBrowser {...props} />)
  const rerender = (nextOverrides: Partial<Parameters<typeof RemoteBrowser>[0]>) => {
    result.rerender(
      <ThemeProvider colorMode="auto">
        <BaseStyles>
          <RemoteBrowser {...props} {...nextOverrides} />
        </BaseStyles>
      </ThemeProvider>
    )
  }
  return { onNavigate, onSelectionChange, rerender }
}

describe('RemoteBrowser smoke tests', () => {
  it('renders entry names', () => {
    renderBrowser()

    expect(screen.getByText('docs')).toBeInTheDocument()
    expect(screen.getByText('readme.txt')).toBeInTheDocument()
  })

  it('double-clicking a directory row navigates to its path', () => {
    const { onNavigate } = renderBrowser()

    fireEvent.doubleClick(screen.getByText('docs').closest('tr')!)

    expect(onNavigate).toHaveBeenCalledWith('/docs')
  })

  it('clicking a file row selects it', () => {
    const { onSelectionChange } = renderBrowser()

    fireEvent.click(screen.getByText('readme.txt').closest('tr')!)

    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['/readme.txt']))
  })

  it('filters rows as the query changes and restores them when cleared', () => {
    renderBrowser()
    const input = screen.getByLabelText('Filter this folder')

    fireEvent.change(input, { target: { value: 'read' } })
    expect(screen.queryByText('docs')).not.toBeInTheDocument()
    expect(screen.getByText('readme.txt')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('docs')).toBeInTheDocument()
    expect(screen.getByText('readme.txt')).toBeInTheDocument()
  })

  it('does not navigate the list while the filter input is focused', () => {
    const { onSelectionChange } = renderBrowser()
    const input = screen.getByLabelText('Filter this folder')

    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })

    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('resets the range-selection anchor when filtering changes the rows', () => {
    const entries = [
      ...makeEntries(),
      { path: '/z.txt', name: 'z.txt', type: 'file' as const, size: 10, mtime: 0 }
    ]
    const { onSelectionChange } = renderBrowser({ entries })

    fireEvent.click(screen.getByText('z.txt').closest('tr')!)
    onSelectionChange.mockClear()
    fireEvent.change(screen.getByLabelText('Filter this folder'), { target: { value: '.txt' } })
    fireEvent.click(screen.getByText('readme.txt').closest('tr')!, { shiftKey: true })

    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['/readme.txt']))
  })

  it('clears the filter with Escape', () => {
    renderBrowser()
    const input = screen.getByLabelText('Filter this folder')

    fireEvent.change(input, { target: { value: 'read' } })
    expect(screen.queryByText('docs')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.getByText('docs')).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('distinguishes no filter matches from an empty folder', () => {
    renderBrowser()
    fireEvent.change(screen.getByLabelText('Filter this folder'), {
      target: { value: 'missing' }
    })

    expect(screen.getByText('No files match that filter.')).toBeInTheDocument()
    expect(screen.queryByText('This folder is empty.')).not.toBeInTheDocument()

    cleanup()
    renderBrowser({ entries: [] })
    expect(screen.getByText('This folder is empty.')).toBeInTheDocument()
    expect(screen.queryByText('No files match that filter.')).not.toBeInTheDocument()
  })

  it('keeps hidden selected entries in the Download count', () => {
    renderBrowser({
      selected: new Set(['/docs', '/readme.txt'])
    })

    fireEvent.change(screen.getByLabelText('Filter this folder'), { target: { value: 'read' } })

    expect(screen.getByRole('button', { name: /Download.*2/ })).toBeInTheDocument()
  })

  it('announces filtered result counts after a debounce', () => {
    vi.useFakeTimers()
    try {
      const entries = [
        ...makeEntries(),
        { path: '/z.txt', name: 'z.txt', type: 'file' as const, size: 10, mtime: 0 }
      ]
      renderBrowser({ entries })
      const status = screen.getByRole('status')

      expect(status).toBeEmptyDOMElement()
      fireEvent.change(screen.getByLabelText('Filter this folder'), {
        target: { value: '.txt' }
      })
      expect(status).toBeEmptyDOMElement()

      act(() => vi.advanceTimersByTime(400))
      expect(status).toHaveTextContent('2 of 3 items match.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not announce filter results for an empty folder', () => {
    vi.useFakeTimers()
    try {
      renderBrowser({ entries: [] })
      const status = screen.getByRole('status')

      fireEvent.change(screen.getByLabelText('Filter this folder'), {
        target: { value: 'missing' }
      })
      act(() => vi.advanceTimersByTime(400))

      expect(status).toBeEmptyDOMElement()
      expect(screen.getByText('This folder is empty.')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the filter when the current directory changes', () => {
    const { rerender } = renderBrowser()
    const input = screen.getByLabelText('Filter this folder')
    fireEvent.change(input, { target: { value: 'read' } })

    rerender({ cwd: '/next' })

    expect(input).toHaveValue('')
    expect(screen.getByText('docs')).toBeInTheDocument()
  })

  it('clears the filter when disconnected', () => {
    const { rerender } = renderBrowser()
    const input = screen.getByLabelText('Filter this folder')
    fireEvent.change(input, { target: { value: 'read' } })

    rerender({ connected: false })

    expect(input).toHaveValue('')
  })
})
