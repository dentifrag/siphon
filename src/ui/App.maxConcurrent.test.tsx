import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import { MAX_CONCURRENT_STORAGE_KEY } from './lib/storage'
import App from './App'

describe('App max-concurrent-downloads behavior', () => {
  it('calls setMaxConcurrentDownloads on mount with the stored value', async () => {
    localStorage.setItem(MAX_CONCURRENT_STORAGE_KEY, '6')
    const api = installMockWebApi()
    renderWithProviders(<App canChangePassword={false} />)

    await waitFor(() => expect(api.setMaxConcurrentDownloads).toHaveBeenCalledWith(6))
  })

  it('writes localStorage before applying the state change', async () => {
    const api = installMockWebApi()
    renderWithProviders(<App canChangePassword={false} />)
    await waitFor(() => expect(api.setMaxConcurrentDownloads).toHaveBeenCalledWith(3))
    vi.mocked(api.setMaxConcurrentDownloads).mockClear()

    const input = screen.getByLabelText('Concurrent')
    fireEvent.change(input, { target: { value: '7' } })

    expect(localStorage.getItem(MAX_CONCURRENT_STORAGE_KEY)).toBe('7')
    await waitFor(() => expect(api.setMaxConcurrentDownloads).toHaveBeenCalledWith(7))
  })

  it('lets you clear the field without snapping back to 1 (mobile)', async () => {
    const api = installMockWebApi()
    renderWithProviders(<App canChangePassword={false} />)
    await waitFor(() => expect(api.setMaxConcurrentDownloads).toHaveBeenCalledWith(3))
    vi.mocked(api.setMaxConcurrentDownloads).mockClear()

    const input = screen.getByLabelText('Concurrent') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })

    expect(input.value).toBe('')
    expect(api.setMaxConcurrentDownloads).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '5' } })
    expect(input.value).toBe('5')
    await waitFor(() => expect(api.setMaxConcurrentDownloads).toHaveBeenCalledWith(5))
  })

  it('restores the last valid value on blur when left empty', async () => {
    const api = installMockWebApi()
    renderWithProviders(<App canChangePassword={false} />)
    await waitFor(() => expect(api.setMaxConcurrentDownloads).toHaveBeenCalledWith(3))

    const input = screen.getByLabelText('Concurrent') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(input.value).toBe('3')
  })
})
