import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import App from './App'

async function openPasswordDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Change password' }))
}

describe('App password change dialog', () => {
  it('checks length before mismatch', async () => {
    const user = userEvent.setup()
    installMockWebApi()
    renderWithProviders(<App canChangePassword={true} />)
    await openPasswordDialog(user)

    await user.type(screen.getByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('Confirm new password'), 'different')
    await user.click(screen.getByRole('button', { name: 'Update password' }))

    expect(await screen.findByText('New password must be 8 to 256 characters.')).toBeInTheDocument()
  })

  it('shows a mismatch error when the length is valid but confirmation differs', async () => {
    const user = userEvent.setup()
    installMockWebApi()
    renderWithProviders(<App canChangePassword={true} />)
    await openPasswordDialog(user)

    await user.type(screen.getByLabelText('New password'), 'longenough')
    await user.type(screen.getByLabelText('Confirm new password'), 'differentbutlong')
    await user.click(screen.getByRole('button', { name: 'Update password' }))

    expect(await screen.findByText('New passwords do not match.')).toBeInTheDocument()
  })

  it('closes the dialog and shows a notice that auto-clears after 3s on success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup()
    installMockWebApi()
    renderWithProviders(<App canChangePassword={true} />)
    await openPasswordDialog(user)

    await user.type(screen.getByLabelText('Current password'), 'oldpassword')
    await user.type(screen.getByLabelText('New password'), 'newlongpassword')
    await user.type(screen.getByLabelText('Confirm new password'), 'newlongpassword')
    await user.click(screen.getByRole('button', { name: 'Update password' }))

    await waitFor(() => expect(screen.queryByLabelText('New password')).not.toBeInTheDocument())
    expect(await screen.findByText('Password updated.')).toBeInTheDocument()

    vi.advanceTimersByTime(3_000)
    await waitFor(() => expect(screen.queryByText('Password updated.')).not.toBeInTheDocument())
    vi.useRealTimers()
  })

  it('resets submitting and shows an error when changePassword rejects', async () => {
    const user = userEvent.setup()
    installMockWebApi({
      changePassword: vi.fn(async () => {
        throw new Error('wrong current password')
      })
    })
    renderWithProviders(<App canChangePassword={true} />)
    await openPasswordDialog(user)

    await user.type(screen.getByLabelText('Current password'), 'oldpassword')
    await user.type(screen.getByLabelText('New password'), 'newlongpassword')
    await user.type(screen.getByLabelText('Confirm new password'), 'newlongpassword')
    await user.click(screen.getByRole('button', { name: 'Update password' }))

    expect(await screen.findByText('wrong current password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update password' })).not.toBeDisabled()
  })
})
