import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { UpdateJob, UpdateStatus } from '@shared/api'
import { renderWithProviders } from './test/renderWithProviders'
import { installMockWebApi } from './test/mockWebApi'
import App from './App'
import Root from '../web/Root'

const markerKey = 'siphon.update-reconnect'
const offer = { id: 'offer-1', version: '1.10.0', sizeBytes: 100, protocolVersion: 1 as const }
const checked: UpdateStatus = {
  currentVersion: '1.0.2',
  capability: { supported: true },
  check: { state: 'checked' },
  offer,
  job: null,
  maintenance: false,
  canInstall: true
}
const job: UpdateJob = {
  id: 'job-1',
  fromVersion: '1.0.2',
  toVersion: '1.10.0',
  phase: 'verifying-new',
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  serviceHealth: 'unknown'
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^updates$/i }))
  const dialog = await screen.findByRole('dialog', { name: /updates/i })
  await within(dialog).findByText(/1\.0\.2/)
  return dialog
}

async function confirmInstall(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^install update$/i }))
  await user.click(
    await screen.findByRole('button', { name: /confirm.*install|install.*restart/i })
  )
}

describe('in-app Updates', () => {
  it('clears proven pre-acceptance rejection and permits another explicit confirmation', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => checked),
      installUpdate: vi.fn(async () => {
        throw Object.assign(new Error('Could not persist or accept this update.'), {
          status: 503,
          accepted: false
        })
      })
    })
    renderWithProviders(<App canChangePassword={false} />)
    await open(user)
    await confirmInstall(user)
    expect(await screen.findByText('Could not persist or accept this update.')).toBeInTheDocument()
    await waitFor(() => expect(localStorage.getItem(markerKey)).toBeNull())
    expect(screen.getByRole('button', { name: /^install update$/i })).toBeEnabled()
    expect(api.installUpdate).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: /^install update$/i }))
    expect(screen.getByRole('button', { name: /^cancel$/i })).toHaveFocus()
    expect(api.installUpdate).toHaveBeenCalledOnce()
  })

  it.each([true, undefined])(
    'retains a 503 with acceptance %s despite idle status and does not resubmit',
    async (accepted) => {
      const user = userEvent.setup()
      const api = installMockWebApi({
        getUpdateStatus: vi.fn(async () => checked),
        installUpdate: vi.fn(async () => {
          throw Object.assign(new Error('Scheduler response lost'), { status: 503, accepted })
        })
      })
      renderWithProviders(<App canChangePassword={false} />)
      await open(user)
      await confirmInstall(user)
      await waitFor(() => expect(api.getUpdateStatus).toHaveBeenCalledTimes(2))
      expect(localStorage.getItem(markerKey)).not.toBeNull()
      expect(screen.getByRole('button', { name: /^install update$/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /check for updates/i })).toBeDisabled()
      expect(api.installUpdate).toHaveBeenCalledOnce()
    }
  )

  it('moves keyboard focus into confirmation and returns it on cancel and accepted submission', async () => {
    const user = userEvent.setup()
    let finish!: (result: UpdateJob) => void
    const installing = new Promise<UpdateJob>((resolve) => {
      finish = resolve
    })
    let status = checked
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => status),
      installUpdate: vi.fn(() => installing)
    })
    renderWithProviders(<App canChangePassword={false} />)
    await open(user)
    const installButton = screen.getByRole('button', { name: /^install update$/i })
    installButton.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: /^cancel$/i })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: /^install update$/i })).toHaveFocus()
    expect(api.installUpdate).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: /^cancel$/i })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: /install and restart/i })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('heading', { name: /confirm installation/i })).toHaveFocus()
    status = {
      ...checked,
      job: { ...job, phase: 'accepted' },
      maintenance: true,
      canInstall: false
    }
    finish(status.job!)
    await waitFor(() =>
      expect(screen.getByText(/Updates replace only Siphon's executable/)).toHaveFocus()
    )
    expect(api.installUpdate).toHaveBeenCalledOnce()
  })

  it('shows installed/latest versions without an automatic check and explains unsupported installs', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi()
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(within(dialog).getByText(/installed Windows service/i)).toBeInTheDocument()
    expect(api.checkForUpdates).not.toHaveBeenCalled()
    expect(api.installUpdate).not.toHaveBeenCalled()
    const check = within(dialog).queryByRole('button', { name: /check.*updates/i })
    if (check) expect(check).toBeDisabled()
  })

  it('requires confirmation, stores reconnect intent before POST, and submits only the checked offer once', async () => {
    const user = userEvent.setup()
    let finish!: (result: UpdateJob) => void
    const installing = new Promise<UpdateJob>((resolve) => {
      finish = resolve
    })
    const installUpdate = vi.fn(() => {
      expect(JSON.parse(localStorage.getItem(markerKey)!)).toMatchObject({
        offerId: offer.id,
        fromVersion: '1.0.2',
        toVersion: offer.version
      })
      return installing
    })
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => checked),
      checkForUpdates: vi.fn(async () => checked),
      installUpdate
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(within(dialog).getByText(/1\.10\.0/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /^install update$/i }))
    expect(installUpdate).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(installUpdate).not.toHaveBeenCalled()
    await confirmInstall(user)
    expect(installUpdate).toHaveBeenCalledExactlyOnceWith({ offerId: offer.id })
    expect(api.checkForUpdates).not.toHaveBeenCalled()
    const confirm = screen.queryByRole('button', { name: /confirm.*install|install.*restart/i })
    if (confirm) expect(confirm).toBeDisabled()
    finish({ ...job, phase: 'accepted' })
    await waitFor(() => expect(localStorage.getItem(markerKey)).toContain(job.id))
  })

  it('checks explicitly and shows network errors rather than claiming an available update', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => ({ ...checked, offer: null, canInstall: false })),
      checkForUpdates: vi.fn(async () => {
        throw new Error('Release server unavailable')
      })
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    await user.click(within(dialog).getByRole('button', { name: /check.*updates/i }))
    expect(await screen.findByText(/Release server unavailable/i)).toBeInTheDocument()
    expect(api.checkForUpdates).toHaveBeenCalledOnce()
    expect(api.installUpdate).not.toHaveBeenCalled()
  })

  it('shows transfer contention and keeps installation unavailable', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => ({
        ...checked,
        canInstall: false,
        blockedReason: 'Transfers are active'
      }))
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(within(dialog).getByText(/Transfers are active/i)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /^install update$/i })).toBeDisabled()
    expect(api.installUpdate).not.toHaveBeenCalled()
  })

  it('reconciles a lost install response and recovers its job on remount without resubmitting', async () => {
    const user = userEvent.setup()
    let status = checked
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => status),
      installUpdate: vi.fn(async () => {
        status = { ...checked, job, maintenance: true, canInstall: false }
        throw new Error('Connection lost')
      })
    })
    const rendered = renderWithProviders(<App canChangePassword={false} />)
    await open(user)
    await confirmInstall(user)
    await waitFor(
      () => expect(vi.mocked(api.getUpdateStatus).mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 3000 }
    )
    expect(api.installUpdate).toHaveBeenCalledOnce()
    expect(localStorage.getItem(markerKey)).not.toBeNull()
    rendered.unmount()
    const reads = vi.mocked(api.getUpdateStatus).mock.calls.length
    renderWithProviders(<App canChangePassword={false} />)
    await screen.findByRole('dialog', { name: /updates/i })
    await waitFor(
      () => expect(vi.mocked(api.getUpdateStatus).mock.calls.length).toBeGreaterThan(reads),
      { timeout: 3000 }
    )
    expect(
      within(screen.getByRole('dialog', { name: /updates/i })).getByText(/verif/i)
    ).toBeInTheDocument()
    expect(api.installUpdate).toHaveBeenCalledOnce()
    const install = screen.queryByRole('button', { name: /^install update$/i })
    if (install) expect(install).toBeDisabled()
    expect(localStorage.getItem(markerKey)).not.toBeNull()
  })

  it('retains recovery intent through login and displays an authoritative rollback error', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      markerKey,
      JSON.stringify({
        offerId: offer.id,
        jobId: job.id,
        fromVersion: job.fromVersion,
        toVersion: job.toVersion,
        submittedAt: Date.now()
      })
    )
    let authenticated = false
    const api = installMockWebApi({
      authStatus: vi.fn(async () => ({
        state: 'login' as const,
        required: true,
        authenticated,
        canChangePassword: true
      })),
      login: vi.fn(async () => {
        authenticated = true
      }),
      getUpdateStatus: vi.fn(async () => ({
        ...checked,
        maintenance: false,
        canInstall: false,
        job: {
          ...job,
          phase: 'rolled-back' as const,
          serviceHealth: 'healthy' as const,
          error: 'New version failed health verification'
        }
      }))
    })
    renderWithProviders(<Root />)
    await user.type(await screen.findByLabelText('Password'), 'test-password')
    expect(localStorage.getItem(markerKey)).not.toBeNull()
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
    expect(await screen.findByText(/New version failed health verification/i)).toBeInTheDocument()
    expect(api.installUpdate).not.toHaveBeenCalled()
  })

  it('suspends background keyboard downloads while the Updates modal is open and resumes after close', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => checked),
      status: vi.fn(async () => ({
        connected: true,
        remoteName: 'test',
        connectionRevision: 'updates-test-revision'
      })),
      defaultDownloadDir: vi.fn(async () => 'D:\\Downloads'),
      list: vi.fn(async () => [
        { path: '/file.bin', name: 'file.bin', type: 'file' as const, size: 1, mtime: 0 }
      ])
    })
    renderWithProviders(<App canChangePassword={false} />)
    await user.click(await screen.findByText('file.bin'))
    await open(user)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(api.enqueueDownload).not.toHaveBeenCalled()
    await user.click(
      within(screen.getByRole('dialog', { name: /updates/i })).getByRole('button', {
        name: /^close/i
      })
    )
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(api.enqueueDownload).toHaveBeenCalledOnce())
  })
})
