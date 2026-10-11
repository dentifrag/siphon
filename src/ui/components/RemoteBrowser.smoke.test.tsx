import { beforeAll, describe, expect, it, vi } from 'vitest'
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
  return { onNavigate, onSelectionChange, rerender, unmount: result.unmount }
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

  it('anchors the right-click menu to the pointer, not the row kebab button', () => {
    renderBrowser()
    const row = screen.getByText('readme.txt').closest('tr')!

    fireEvent.contextMenu(row, { clientX: 120, clientY: 240 })

    const anchor = document.querySelector('.cursor-anchor') as HTMLElement
    expect(anchor.style.left).toBe('120px')
    expect(anchor.style.top).toBe('240px')
    expect(screen.getByRole('menuitem', { name: /Download/ })).toBeInTheDocument()
    for (const button of screen.getAllByRole('button', { name: 'Row actions' })) {
      expect(button).toHaveAttribute('aria-expanded', 'false')
    }
  })

  it('moves the right-click menu when another row is right-clicked', () => {
    renderBrowser()

    fireEvent.contextMenu(screen.getByText('readme.txt').closest('tr')!, {
      clientX: 120,
      clientY: 240
    })
    fireEvent.contextMenu(screen.getByText('docs').closest('tr')!, { clientX: 40, clientY: 60 })

    const anchor = document.querySelector('.cursor-anchor') as HTMLElement
    expect(anchor.style.left).toBe('40px')
    expect(anchor.style.top).toBe('60px')
    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument()
  })

  it('right-clicking an unselected row selects it', () => {
    const { onSelectionChange } = renderBrowser()

    fireEvent.contextMenu(screen.getByText('readme.txt').closest('tr')!, {
      clientX: 10,
      clientY: 10
    })

    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['/readme.txt']))
  })

  it('closes the right-click menu with Escape without clearing the selection', () => {
    const { onSelectionChange } = renderBrowser({ selected: new Set(['/readme.txt']) })
    const row = screen.getByText('readme.txt').closest('tr')!

    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onSelectionChange).not.toHaveBeenCalled()
  })
})

// jsdom does not implement pointer capture at all (not even as a no-op), so a
// production drag handler that calls setPointerCapture/releasePointerCapture would
// throw in this environment unless the capability is polyfilled here first.
beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  if (typeof proto.setPointerCapture !== 'function') proto.setPointerCapture = vi.fn()
  if (typeof proto.releasePointerCapture !== 'function') proto.releasePointerCapture = vi.fn()
  if (typeof proto.hasPointerCapture !== 'function') proto.hasPointerCapture = vi.fn(() => false)
})

function openColumnsDisclosure(): void {
  fireEvent.click(screen.getByText('Columns'))
}

function sizeInput(): HTMLInputElement {
  return screen.getByLabelText('Size column width') as HTMLInputElement
}

function modifiedInput(): HTMLInputElement {
  return screen.getByLabelText('Modified column width') as HTMLInputElement
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText('Name column width') as HTMLInputElement
}

describe('RemoteBrowser column width controls', () => {
  it('exposes a Columns disclosure with labeled width controls, documented bounds and defaults', () => {
    renderBrowser()
    openColumnsDisclosure()

    expect(nameInput()).toHaveAttribute('min', '160')
    expect(nameInput()).toHaveAttribute('max', '2000')

    expect(sizeInput()).toHaveAttribute('min', '72')
    expect(sizeInput()).toHaveAttribute('max', '200')
    expect(sizeInput()).toHaveValue(88)

    expect(modifiedInput()).toHaveAttribute('min', '96')
    expect(modifiedInput()).toHaveAttribute('max', '320')
    expect(modifiedInput()).toHaveValue(176)

    expect(screen.getByRole('checkbox', { name: 'Wrap filenames' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset column widths' })).toBeInTheDocument()
    expect(screen.getByLabelText('Resize Name column')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize Size column')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize Modified column')).toBeInTheDocument()
  })

  it('increments the Size column width from its header handle with arrow keys, Shift and Home/End', () => {
    renderBrowser()
    openColumnsDisclosure()
    const handle = screen.getByLabelText('Resize Size column')
    act(() => handle.focus())

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(sizeInput()).toHaveValue(96)

    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(sizeInput()).toHaveValue(128)

    fireEvent.keyDown(handle, { key: 'End' })
    expect(sizeInput()).toHaveValue(200)

    fireEvent.keyDown(handle, { key: 'Home' })
    expect(sizeInput()).toHaveValue(72)

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(sizeInput()).toHaveValue(72)
  })

  it('clamps a pointer drag on the Size handle to its documented bounds', () => {
    renderBrowser()
    openColumnsDisclosure()
    const handle = screen.getByLabelText('Resize Size column')

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 100 + 1000, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 100 + 1000, pointerId: 1 })
    expect(sizeInput()).toHaveValue(200)

    cleanup()
    renderBrowser()
    openColumnsDisclosure()
    const handle2 = screen.getByLabelText('Resize Size column')
    fireEvent.pointerDown(handle2, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle2, { clientX: 100 - 1000, pointerId: 1 })
    fireEvent.pointerUp(handle2, { clientX: 100 - 1000, pointerId: 1 })
    expect(sizeInput()).toHaveValue(72)
  })

  it('rolls back an in-progress Size drag to its pre-drag value on pointercancel', () => {
    renderBrowser()
    openColumnsDisclosure()
    const handle = screen.getByLabelText('Resize Size column')

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    fireEvent.pointerCancel(handle, { pointerId: 1 })

    expect(sizeInput()).toHaveValue(88)
  })

  it('reports an out-of-range Size or Modified edit explicitly and keeps the value within bounds', () => {
    renderBrowser()
    openColumnsDisclosure()

    fireEvent.change(sizeInput(), { target: { value: '500' } })
    fireEvent.blur(sizeInput())
    expect(Number(sizeInput().value)).not.toBe(500)
    expect(Number(sizeInput().value)).toBeLessThanOrEqual(200)
    expect(Number(sizeInput().value)).toBeGreaterThanOrEqual(72)
    expect(screen.getByRole('alert')).toBeInTheDocument()

    cleanup()
    renderBrowser()
    openColumnsDisclosure()
    fireEvent.change(modifiedInput(), { target: { value: '50' } })
    fireEvent.blur(modifiedInput())
    expect(Number(modifiedInput().value)).not.toBe(50)
    expect(Number(modifiedInput().value)).toBeLessThanOrEqual(320)
    expect(Number(modifiedInput().value)).toBeGreaterThanOrEqual(96)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('applies a valid Size edit with no error reported', () => {
    renderBrowser()
    openColumnsDisclosure()

    fireEvent.change(sizeInput(), { target: { value: '150' } })
    fireEvent.blur(sizeInput())

    expect(sizeInput()).toHaveValue(150)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('pins the Name column width within its bounds and reports an out-of-range edit', () => {
    renderBrowser()
    openColumnsDisclosure()

    fireEvent.change(nameInput(), { target: { value: '500' } })
    fireEvent.blur(nameInput())
    expect(nameInput()).toHaveValue(500)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    cleanup()
    renderBrowser()
    openColumnsDisclosure()
    const initialName = nameInput().value
    fireEvent.change(nameInput(), { target: { value: '50' } })
    fireEvent.blur(nameInput())

    expect(nameInput().value).not.toBe('50')
    const reverted = nameInput().value === initialName
    const clamped =
      nameInput().value !== '' &&
      Number(nameInput().value) >= 160 &&
      Number(nameInput().value) <= 2000
    expect(reverted || clamped).toBe(true)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('resets Name, Size and Modified widths to their starting tracks', () => {
    renderBrowser()
    openColumnsDisclosure()
    const initialName = nameInput().value

    fireEvent.change(sizeInput(), { target: { value: '150' } })
    fireEvent.blur(sizeInput())
    fireEvent.change(modifiedInput(), { target: { value: '200' } })
    fireEvent.blur(modifiedInput())
    fireEvent.change(nameInput(), { target: { value: '500' } })
    fireEvent.blur(nameInput())

    fireEvent.click(screen.getByRole('button', { name: 'Reset column widths' }))

    expect(sizeInput()).toHaveValue(88)
    expect(modifiedInput()).toHaveValue(176)
    expect(nameInput().value).toBe(initialName)
  })

  it('adjusts the Size column independently of Name and Modified', () => {
    renderBrowser()
    openColumnsDisclosure()
    const initialName = nameInput().value
    const initialModified = modifiedInput().value

    const handle = screen.getByLabelText('Resize Size column')
    act(() => handle.focus())
    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    expect(sizeInput()).toHaveValue(96)
    expect(modifiedInput().value).toBe(initialModified)
    expect(nameInput().value).toBe(initialName)
  })

  it('keeps column widths for the same mounted browser across navigation and reconnects, without using storage', () => {
    const { rerender } = renderBrowser()
    openColumnsDisclosure()

    fireEvent.change(sizeInput(), { target: { value: '150' } })
    fireEvent.blur(sizeInput())
    expect(sizeInput()).toHaveValue(150)

    rerender({ cwd: '/next' })
    expect(sizeInput()).toHaveValue(150)

    rerender({ connected: false })
    rerender({ connected: true })
    expect(sizeInput()).toHaveValue(150)

    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('keeps the full file name in the DOM regardless of the Wrap filenames setting', () => {
    const longName = 'a-very-long-filename-without-any-spaces-that-would-otherwise-overflow.txt'
    const entries = [
      ...makeEntries(),
      { path: `/${longName}`, name: longName, type: 'file' as const, size: 1, mtime: 0 }
    ]
    renderBrowser({ entries })
    openColumnsDisclosure()

    expect(screen.getByText(longName)).toBeInTheDocument()

    const wrapToggle = screen.getByRole('checkbox', { name: 'Wrap filenames' })
    fireEvent.click(wrapToggle)
    expect(screen.getByText(longName)).toBeInTheDocument()

    fireEvent.click(wrapToggle)
    expect(screen.getByText(longName)).toBeInTheDocument()
  })

  it('does not change sort order when the Size resize handle is clicked', () => {
    const entries = [
      ...makeEntries(),
      { path: '/z.txt', name: 'z.txt', type: 'file' as const, size: 10, mtime: 0 }
    ]
    renderBrowser({ entries })
    openColumnsDisclosure()

    const rowsBefore = Array.from(document.querySelectorAll('tbody tr')).map((tr) => tr.textContent)

    fireEvent.click(screen.getByLabelText('Resize Size column'))

    const rowsAfter = Array.from(document.querySelectorAll('tbody tr')).map((tr) => tr.textContent)
    expect(rowsAfter).toEqual(rowsBefore)
  })

  it('does not trigger global row shortcuts while the Size resize handle has focus', () => {
    const onDownloadSelected = vi.fn()
    const { onNavigate, onSelectionChange } = renderBrowser({
      selected: new Set(['/readme.txt']),
      onDownloadSelected
    })
    openColumnsDisclosure()
    const handle = screen.getByLabelText('Resize Size column')
    act(() => handle.focus())

    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    fireEvent.keyDown(handle, { key: 'Enter' })
    fireEvent.keyDown(handle, { key: ' ' })
    fireEvent.keyDown(handle, { key: 'Backspace' })

    expect(onNavigate).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(onDownloadSelected).not.toHaveBeenCalled()
  })

  it('does not trigger global row shortcuts while the Reset column widths button has focus', () => {
    const onDownloadSelected = vi.fn()
    const { onNavigate, onSelectionChange } = renderBrowser({
      selected: new Set(['/readme.txt']),
      onDownloadSelected
    })
    openColumnsDisclosure()
    const button = screen.getByRole('button', { name: 'Reset column widths' })
    act(() => button.focus())

    fireEvent.keyDown(button, { key: 'ArrowDown' })
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: ' ' })
    fireEvent.keyDown(button, { key: 'Backspace' })

    expect(onNavigate).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(onDownloadSelected).not.toHaveBeenCalled()
  })

  it('rolls back a drag with Escape without clearing row selection', () => {
    const { onSelectionChange } = renderBrowser({ selected: new Set(['/readme.txt']) })
    openColumnsDisclosure()
    const handle = screen.getByLabelText('Resize Size column')

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    expect(sizeInput()).toHaveValue(138)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(sizeInput()).toHaveValue(88)
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('restores a blank numeric edit on blur and reports the invalid value', () => {
    renderBrowser()
    openColumnsDisclosure()
    fireEvent.change(sizeInput(), { target: { value: '150' } })
    fireEvent.blur(sizeInput())

    fireEvent.change(sizeInput(), { target: { value: '' } })
    fireEvent.blur(sizeInput())

    expect(sizeInput()).toHaveValue(150)
    expect(sizeInput()).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(/Size/)
    expect(screen.getByRole('alert')).toHaveTextContent(/restored 150 pixels/)

    fireEvent.click(screen.getByRole('button', { name: 'Reset column widths' }))
    expect(sizeInput()).toHaveValue(88)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('returns a pinned Name width to auto-fill without changing other widths', () => {
    renderBrowser()
    openColumnsDisclosure()
    fireEvent.change(sizeInput(), { target: { value: '150' } })
    fireEvent.blur(sizeInput())
    fireEvent.change(nameInput(), { target: { value: '500' } })
    fireEvent.blur(nameInput())

    const autoFill = screen.getByRole('checkbox', { name: 'Auto-fill Name column' })
    expect(autoFill).not.toBeChecked()
    fireEvent.click(autoFill)

    expect(autoFill).toBeChecked()
    expect(nameInput().value).toBe('')
    expect(sizeInput()).toHaveValue(150)
  })

  it('uses explicit Name keyboard bounds even when auto-fill has no measurable layout', () => {
    renderBrowser()
    openColumnsDisclosure()
    const handle = screen.getByLabelText('Resize Name column')

    fireEvent.keyDown(handle, { key: 'End' })
    expect(nameInput()).toHaveValue(2000)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(nameInput()).toHaveValue(160)
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(nameInput()).toHaveValue(192)
  })

  it('measures the auto-fill Name width before its first keyboard adjustment', () => {
    renderBrowser()
    openColumnsDisclosure()
    const header = screen.getByRole('columnheader', { name: 'Name' })
    const geometry = vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 30,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 30,
      toJSON: () => ({})
    })
    try {
      fireEvent.keyDown(screen.getByLabelText('Resize Name column'), { key: 'ArrowRight' })
      expect(nameInput()).toHaveValue(408)
    } finally {
      geometry.mockRestore()
    }
  })

  it('does not invent a Name starting width when auto-fill has no measurable layout', () => {
    renderBrowser()
    openColumnsDisclosure()

    fireEvent.keyDown(screen.getByLabelText('Resize Name column'), { key: 'ArrowRight' })

    expect(nameInput().value).toBe('')
    expect(screen.getByRole('alert')).toHaveTextContent(/Name/)
  })

  it('rolls back a drag when its table is removed for loading', () => {
    const { rerender } = renderBrowser()
    openColumnsDisclosure()
    const handle = screen.getByLabelText('Resize Size column')

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    expect(sizeInput()).toHaveValue(138)

    rerender({ loading: true })
    expect(sizeInput()).toHaveValue(88)
    rerender({ loading: false })
    expect(sizeInput()).toHaveValue(88)
  })

  it('releases pointer capture on unmount', () => {
    const { unmount } = renderBrowser()
    const handle = screen.getByLabelText('Resize Size column')
    const captured = vi.spyOn(handle, 'hasPointerCapture').mockReturnValue(true)
    const release = vi.spyOn(handle, 'releasePointerCapture')
    try {
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
      unmount()
      expect(release).toHaveBeenCalledWith(1)
    } finally {
      captured.mockRestore()
      release.mockRestore()
    }
  })

  it('restores auto-fill Name after cancelling a drag that started from its measured width', () => {
    renderBrowser()
    openColumnsDisclosure()
    const header = screen.getByRole('columnheader', { name: 'Name' })
    const geometry = vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 30,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 30,
      toJSON: () => ({})
    })
    try {
      const handle = screen.getByLabelText('Resize Name column')
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
      expect(nameInput()).toHaveValue(450)

      fireEvent.pointerCancel(handle, { pointerId: 1 })
      expect(nameInput().value).toBe('')
      expect(screen.getByRole('checkbox', { name: 'Auto-fill Name column' })).toBeChecked()
    } finally {
      geometry.mockRestore()
    }
  })

  it('rolls back on lost capture and ignores events from a different pointer', () => {
    renderBrowser()
    openColumnsDisclosure()
    const handle = screen.getByLabelText('Resize Size column')

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerDown(handle, { clientX: 120, pointerId: 2 })
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 2 })
    fireEvent.pointerUp(handle, { clientX: 150, pointerId: 2 })
    expect(sizeInput()).toHaveValue(88)

    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    expect(sizeInput()).toHaveValue(138)
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    expect(sizeInput()).toHaveValue(88)
  })

  it('exposes the current Modified width and applies its keyboard bounds', () => {
    renderBrowser()
    openColumnsDisclosure()
    const handle = screen.getByLabelText('Resize Modified column')

    expect(handle).toHaveAccessibleDescription(/Current width: 176 pixels/)
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(modifiedInput()).toHaveValue(144)
    expect(handle).toHaveAccessibleDescription(/Current width: 144 pixels/)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(modifiedInput()).toHaveValue(96)
    fireEvent.keyDown(handle, { key: 'End' })
    expect(modifiedInput()).toHaveValue(320)
  })

  it('keeps the table width contract auto-filled or explicitly summed without redistributing Name', () => {
    renderBrowser()
    openColumnsDisclosure()
    const table = screen.getByRole('table')

    expect(table.querySelectorAll('colgroup col')).toHaveLength(4)
    expect(table.style.getPropertyValue('--browser-table-width')).toBe('100%')
    expect(table.style.getPropertyValue('--browser-table-min-width')).toBe('480px')

    fireEvent.change(sizeInput(), { target: { value: '150' } })
    fireEvent.blur(sizeInput())
    expect(table.style.getPropertyValue('--browser-table-width')).toBe('100%')
    expect(table.style.getPropertyValue('--browser-table-min-width')).toBe('542px')

    fireEvent.change(nameInput(), { target: { value: '500' } })
    fireEvent.blur(nameInput())
    expect(table.style.getPropertyValue('--browser-table-width')).toBe('882px')

    fireEvent.keyDown(screen.getByLabelText('Resize Size column'), { key: 'ArrowRight' })
    expect(nameInput()).toHaveValue(500)
    expect(table.style.getPropertyValue('--browser-name-width')).toBe('500px')
    expect(table.style.getPropertyValue('--browser-table-width')).toBe('890px')
  })

  it('defaults to filename wrapping on coarse pointers and keeps the checkbox consistent with overrides', () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn((query: string): MediaQueryList => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }))
    try {
      renderBrowser()
      openColumnsDisclosure()
      const wrapToggle = screen.getByRole('checkbox', { name: 'Wrap filenames' })

      expect(wrapToggle).toBeChecked()
      expect(screen.getByRole('table')).toHaveClass('file-table--wrap')

      fireEvent.click(wrapToggle)
      expect(wrapToggle).not.toBeChecked()
      expect(screen.getByRole('table')).not.toHaveClass('file-table--wrap')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('keeps measured Name auto-filled on clicks, double-clicks and unchanged pointer moves', () => {
    renderBrowser()
    openColumnsDisclosure()
    const table = screen.getByRole('table')
    const header = screen.getByRole('columnheader', { name: 'Name' })
    const geometry = vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
      width: 400.4,
      height: 30,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400.4,
      bottom: 30,
      toJSON: () => ({})
    })
    try {
      const handle = screen.getByLabelText('Resize Name column')
      for (let i = 0; i < 2; i++) {
        fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
        if (i === 1) {
          fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 })
          fireEvent.pointerMove(handle, { clientX: 100.2, pointerId: 1 })
        }
        fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 })
        fireEvent.click(handle)
      }
      fireEvent.doubleClick(handle)

      expect(nameInput().value).toBe('')
      expect(screen.getByRole('checkbox', { name: 'Auto-fill Name column' })).toBeChecked()
      expect(table.style.getPropertyValue('--browser-table-width')).toBe('100%')
      expect(table.style.getPropertyValue('--browser-name-width')).toBe('auto')
      expect(header).toHaveAttribute('aria-sort', 'ascending')

      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
      fireEvent.pointerUp(handle, { clientX: 150, pointerId: 1 })

      expect(nameInput()).toHaveValue(450)
      expect(screen.getByRole('checkbox', { name: 'Auto-fill Name column' })).not.toBeChecked()
      expect(table.style.getPropertyValue('--browser-table-width')).toBe('770px')
    } finally {
      geometry.mockRestore()
    }
  })

  it('keeps normal numeric typing as an uncommitted draft without announcing intermediate values', () => {
    renderBrowser()
    openColumnsDisclosure()
    const input = sizeInput()
    const table = screen.getByRole('table')

    for (const value of ['1', '15', '150']) {
      fireEvent.change(input, { target: { value } })
      expect(input.value).toBe(value)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(input).not.toHaveAttribute('aria-invalid', 'true')
      expect(table.style.getPropertyValue('--browser-size-width')).toBe('88px')
    }

    fireEvent.blur(input)
    expect(input).toHaveValue(150)
    expect(table.style.getPropertyValue('--browser-size-width')).toBe('150px')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('commits a valid numeric draft with Enter without triggering row shortcuts', () => {
    const onDownloadSelected = vi.fn()
    const { onNavigate, onSelectionChange } = renderBrowser({
      selected: new Set(['/readme.txt']),
      onDownloadSelected
    })
    fireEvent.click(screen.getByText('readme.txt').closest('tr')!)
    onSelectionChange.mockClear()
    openColumnsDisclosure()
    const input = sizeInput()
    act(() => input.focus())
    fireEvent.change(input, { target: { value: '150' } })

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue(150)
    expect(screen.getByRole('table').style.getPropertyValue('--browser-size-width')).toBe('150px')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(onDownloadSelected).not.toHaveBeenCalled()
  })

  it('rejects an invalid numeric draft with Enter, restores the valid width and clears feedback on correction', () => {
    renderBrowser()
    openColumnsDisclosure()
    const input = modifiedInput()
    fireEvent.change(input, { target: { value: '50' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue(176)
    expect(input).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(/Modified.*restored 176 pixels/)
    fireEvent.blur(input)
    expect(screen.getByRole('alert')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '200' } })
    fireEvent.blur(input)
    expect(input).toHaveValue(200)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
