import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, fireEvent } from '@testing-library/react'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import App from './App'

function fillConnectForm(user: ReturnType<typeof userEvent.setup>) {
  return async () => {
    await user.type(screen.getByPlaceholderText('sftp.example.com'), 'example.com')
    await user.type(screen.getByPlaceholderText('user'), 'alice')
  }
}

describe('App connection flow', () => {
  it('manual connect passes undefined as the profile id', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi()
    renderWithProviders(<App canChangePassword={false} />)
    await fillConnectForm(user)()

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'example.com' }),
      undefined
    )
  })

  it('on success stores the connection and navigates to result.home', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      connect: vi.fn(async () => ({ home: '/uploads' })),
      list: vi.fn(async () => [])
    })
    renderWithProviders(<App canChangePassword={false} />)
    await fillConnectForm(user)()

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(api.list).toHaveBeenCalledWith('/uploads')
    const stored = localStorage.getItem('siphon.connection')
    expect(stored && JSON.parse(stored)).toEqual(
      expect.objectContaining({ host: 'example.com', username: 'alice', profileId: '' })
    )
  })

  it('stores form data with profileId "" when selectedProfileId does not match a known profile', async () => {
    const user = userEvent.setup()
    installMockWebApi({
      listProfiles: vi.fn(async () => [])
    })
    renderWithProviders(<App canChangePassword={false} />)
    await fillConnectForm(user)()

    const select = await screen.findByLabelText('Saved sites')
    fireEvent.change(select, { target: { value: 'unknown-profile-id' } })

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    const stored = localStorage.getItem('siphon.connection')
    expect(stored && JSON.parse(stored)).toEqual(
      expect.objectContaining({ host: 'example.com', username: 'alice', profileId: '' })
    )
  })

  it('shows an error, sets disconnected state, and writes no localStorage on failure', async () => {
    const user = userEvent.setup()
    installMockWebApi({
      connect: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    renderWithProviders(<App canChangePassword={false} />)
    await fillConnectForm(user)()

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(localStorage.getItem('siphon.connection')).toBeNull()
  })

  it('disconnect removes siphon.connection but keeps siphon.cwd, and resets state even if disconnect rejects', async () => {
    const user = userEvent.setup()
    installMockWebApi({
      connect: vi.fn(async () => ({ home: '/' })),
      disconnect: vi.fn(async () => {
        throw new Error('disconnect failed')
      })
    })
    const swallowExpectedRejection = () => {}
    process.on('unhandledRejection', swallowExpectedRejection)
    renderWithProviders(<App canChangePassword={false} />)
    await fillConnectForm(user)()
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('button', { name: 'Disconnect' })
    localStorage.setItem('siphon.cwd', '/keep-me')

    await user.click(screen.getByRole('button', { name: 'Disconnect' }))

    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(localStorage.getItem('siphon.connection')).toBeNull()
    expect(localStorage.getItem('siphon.cwd')).toBe('/keep-me')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    process.off('unhandledRejection', swallowExpectedRejection)
  })
})
