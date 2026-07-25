import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import App from './App'
import type { ConnectionProfileMeta, ResolvedProfile } from '@shared/api'
import type { RemoteEntry } from '@shared/types'

describe('App browse behavior', () => {
  it('defaultDownloadDir does not clobber a profile-provided download dir', async () => {
    let resolveDefaultDir: (dir: string) => void = () => {}
    const defaultDirPromise = new Promise<string>((resolvePromise) => {
      resolveDefaultDir = resolvePromise
    })
    installMockWebApi({
      defaultDownloadDir: vi.fn(() => defaultDirPromise),
      listProfiles: vi.fn(async (): Promise<ConnectionProfileMeta[]> => [
        {
          id: 'p1',
          name: 'Alice',
          host: 'h',
          port: 22,
          username: 'a',
          authMethod: 'password',
          hasSecret: false,
          segments: 4,
          downloadDir: '/profile-dir'
        }
      ]),
      resolveProfile: vi.fn(async (): Promise<ResolvedProfile> => ({
        name: 'Alice',
        host: 'h',
        port: 22,
        username: 'a',
        authMethod: 'password',
        segments: 4,
        downloadDir: '/profile-dir'
      }))
    })
    renderWithProviders(<App canChangePassword={false} />)

    const select = await screen.findByLabelText('Saved sites')
    fireEvent.change(select, { target: { value: 'p1' } })

    await waitFor(() => {
      expect(screen.getByLabelText('Download folder')).toHaveValue('/profile-dir')
    })

    resolveDefaultDir('/default-dir')
    await waitFor(() => {
      expect(screen.getByLabelText('Download folder')).toHaveValue('/profile-dir')
    })
  })

  it('navigateTo persists siphon.cwd only on success, and does not on failure', async () => {
    installMockWebApi({
      status: vi.fn(async () => ({ connected: true, remoteName: 'x' })),
      list: vi.fn(async (dir: string): Promise<RemoteEntry[]> => {
        if (dir === '/') {
          return [{ path: '/sub', name: 'sub', type: 'directory', size: 0, mtime: 0 }]
        }
        if (dir === '/sub') {
          return [{ path: '/sub/bad', name: 'bad', type: 'directory', size: 0, mtime: 0 }]
        }
        throw new Error('denied')
      })
    })
    renderWithProviders(<App canChangePassword={false} />)

    const subRow = await screen.findByText('sub')
    fireEvent.doubleClick(subRow.closest('tr')!)

    await screen.findByText('bad')
    expect(localStorage.getItem('siphon.cwd')).toBe('/sub')

    const badRow = await screen.findByText('bad')
    fireEvent.doubleClick(badRow.closest('tr')!)

    await screen.findByText('denied')
    expect(localStorage.getItem('siphon.cwd')).toBe('/sub')
  })

  it('status restore falls back to navigateTo("/") when the stored cwd fails', async () => {
    localStorage.setItem('siphon.cwd', '/missing')
    installMockWebApi({
      status: vi.fn(async () => ({ connected: true, remoteName: 'x' })),
      list: vi.fn(async (dir: string) => {
        if (dir === '/missing') throw new Error('gone')
        return []
      })
    })
    renderWithProviders(<App canChangePassword={false} />)

    await screen.findByText('This folder is empty.')
    expect(localStorage.getItem('siphon.cwd')).toBe('/')
  })
})
