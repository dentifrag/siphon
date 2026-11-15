import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, screen } from '@testing-library/react'
import { renderWithProviders } from '../ui/test/renderWithProviders'
import { installMockWebApi } from '../ui/test/mockWebApi'
import Root from './Root'
import type { AuthStatus } from './api'

describe('Root auth states', () => {
  it('returns to sign-in when a protected request reports an expired session', async () => {
    let expire!: () => void
    const subscription = vi.fn((listener: () => void) => {
      expire = listener
      return () => {}
    })
    installMockWebApi({ onSessionExpired: subscription })
    renderWithProviders(<Root />)
    await screen.findByRole('button', { name: 'Updates' })
    expect(subscription).toHaveBeenCalledOnce()
    act(() => expire())
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Updates' })).not.toBeInTheDocument()
  })

  it('does not render operational controls when startup authentication cannot be checked', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      authStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error('Service unavailable'))
        .mockResolvedValue({
          state: 'open',
          authenticated: true,
          canChangePassword: false
        })
    })
    renderWithProviders(<Root />)
    expect(await screen.findByText('Service unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Updates' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Updates' })).toBeInTheDocument()
    expect(api.authStatus).toHaveBeenCalledTimes(2)
  })

  it('shows the setup form when authStatus resolves state "setup"', async () => {
    installMockWebApi({
      authStatus: vi.fn(async (): Promise<AuthStatus> => ({
        state: 'setup',
        required: true,
        authenticated: false,
        canChangePassword: false
      }))
    })
    renderWithProviders(<Root />)

    expect(await screen.findByText('Siphon setup')).toBeInTheDocument()
  })

  it('shows the login form when authStatus resolves state "login" and not authenticated', async () => {
    installMockWebApi({
      authStatus: vi.fn(async (): Promise<AuthStatus> => ({
        state: 'login',
        required: true,
        authenticated: false,
        canChangePassword: false
      }))
    })
    renderWithProviders(<Root />)

    expect(
      await screen.findByText('Enter your username and password to continue.')
    ).toBeInTheDocument()
  })

  it('renders the App when authStatus resolves state "open"', async () => {
    installMockWebApi({
      authStatus: vi.fn(async (): Promise<AuthStatus> => ({
        state: 'open',
        required: false,
        authenticated: true,
        canChangePassword: false
      }))
    })
    renderWithProviders(<Root />)

    expect(await screen.findByText('Siphon')).toBeInTheDocument()
    expect(screen.queryByText('Siphon setup')).not.toBeInTheDocument()
  })

  it('confirms and calls setup({mode: "open"}) when choosing open mode', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      authStatus: vi.fn(async (): Promise<AuthStatus> => ({
        state: 'setup',
        required: true,
        authenticated: false,
        canChangePassword: false
      }))
    })
    vi.mocked(window.confirm).mockReturnValueOnce(true)
    renderWithProviders(<Root />)
    await screen.findByText('Siphon setup')

    await user.click(screen.getByRole('button', { name: 'Run without a password' }))

    expect(window.confirm).toHaveBeenCalledWith(
      'Run without a password? Anyone who can reach this app can use it.'
    )
    expect(api.setup).toHaveBeenCalledWith({ mode: 'open' })
  })

  it('does not call setup when the open-mode confirm is declined', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      authStatus: vi.fn(async (): Promise<AuthStatus> => ({
        state: 'setup',
        required: true,
        authenticated: false,
        canChangePassword: false
      }))
    })
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    renderWithProviders(<Root />)
    await screen.findByText('Siphon setup')

    await user.click(screen.getByRole('button', { name: 'Run without a password' }))

    expect(api.setup).not.toHaveBeenCalled()
  })

  it('shows an error message when login submission rejects', async () => {
    const user = userEvent.setup()
    installMockWebApi({
      authStatus: vi.fn(async (): Promise<AuthStatus> => ({
        state: 'login',
        required: true,
        authenticated: false,
        canChangePassword: false
      })),
      login: vi.fn(async () => {
        throw new Error('Invalid credentials')
      })
    })
    renderWithProviders(<Root />)
    await screen.findByText('Enter your username and password to continue.')

    await user.type(screen.getByLabelText('Password'), 'wrongpass')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled()
  })
})
