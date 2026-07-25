import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import App from './App'
import type { ConnectionProfileMeta, ResolvedProfile } from '@shared/api'

function makeProfile(overrides: Partial<ConnectionProfileMeta> = {}): ConnectionProfileMeta {
  return {
    id: 'p1',
    name: 'alice@host',
    host: 'host',
    port: 22,
    username: 'alice',
    authMethod: 'password',
    hasSecret: false,
    segments: 4,
    downloadDir: '',
    ...overrides
  }
}

describe('App profile behaviors', () => {
  it('reselects by name after saving, picking the first match when names collide', async () => {
    const duplicateName = 'alice@host'
    const api = installMockWebApi({
      saveProfile: vi.fn(async () => [
        makeProfile({ id: 'first', name: duplicateName }),
        makeProfile({ id: 'second', name: duplicateName })
      ])
    })
    renderWithProviders(<App canChangePassword={false} />)

    fireEvent.change(screen.getByPlaceholderText('sftp.example.com'), {
      target: { value: 'host' }
    })
    fireEvent.change(screen.getByPlaceholderText('user'), { target: { value: 'alice' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled())

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.saveProfile).toHaveBeenCalled())
    const select = screen.getByLabelText('Saved sites') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('first'))
  })

  it('select with an empty id sets the id and returns without resolving a profile', async () => {
    const api = installMockWebApi({
      listProfiles: vi.fn(async () => [makeProfile()])
    })
    renderWithProviders(<App canChangePassword={false} />)

    const select = await screen.findByLabelText('Saved sites')
    fireEvent.change(select, { target: { value: 'p1' } })
    await waitFor(() => expect(api.resolveProfile).toHaveBeenCalledTimes(1))

    fireEvent.change(select, { target: { value: '' } })

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    expect(api.resolveProfile).toHaveBeenCalledTimes(1)
    expect((select as HTMLSelectElement).value).toBe('')
  })

  it('sets downloadDir only when the resolved profile has a truthy downloadDir', async () => {
    installMockWebApi({
      listProfiles: vi.fn(async () => [makeProfile()]),
      resolveProfile: vi.fn(async (): Promise<ResolvedProfile> => ({
        name: 'alice@host',
        host: 'host',
        port: 22,
        username: 'alice',
        authMethod: 'password',
        segments: 4,
        downloadDir: ''
      })),
      defaultDownloadDir: vi.fn(async () => '/existing-default')
    })
    renderWithProviders(<App canChangePassword={false} />)
    await waitFor(() =>
      expect(screen.getByLabelText('Download folder')).toHaveValue('/existing-default')
    )

    const select = await screen.findByLabelText('Saved sites')
    fireEvent.change(select, { target: { value: 'p1' } })

    await waitFor(() => expect(screen.getByPlaceholderText('sftp.example.com')).toHaveValue('host'))
    expect(screen.getByLabelText('Download folder')).toHaveValue('/existing-default')
  })

  it('delete clears the selected profile id', async () => {
    const api = installMockWebApi({
      listProfiles: vi.fn(async () => [makeProfile()]),
      deleteProfile: vi.fn(async () => [])
    })
    renderWithProviders(<App canChangePassword={false} />)

    const select = await screen.findByLabelText('Saved sites')
    fireEvent.change(select, { target: { value: 'p1' } })
    await waitFor(() => expect(api.resolveProfile).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.deleteProfile).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe(''))
  })
})
