import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
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
  renderWithProviders(<RemoteBrowser {...props} />)
  return { onNavigate, onSelectionChange }
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
})
