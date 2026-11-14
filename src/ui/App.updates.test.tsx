import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
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
const unchecked: UpdateStatus = {
  ...checked,
  check: { state: 'idle' },
  offer: null,
  canInstall: false
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
const marker = {
  offerId: offer.id,
  jobId: job.id,
  fromVersion: job.fromVersion,
  toVersion: job.toVersion,
  submittedAt: Date.now()
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^updates$/i }))
  const dialog = await screen.findByRole('dialog', { name: /updates/i })
  await within(dialog).findByText(/installed version/i)
  return dialog
}

const updateButton = () => screen.getByRole('button', { name: /^update and restart$/i })

function actionNames(dialog: HTMLElement) {
  return within(dialog)
    .queryAllByRole('button')
    .map((button) => button.textContent || '')
    .filter(Boolean)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('in-app Updates', () => {
  it.each([false, undefined])(
    'does not show task recovery during an update without authoritative permission (%s)',
    async (canRetryTask) => {
      const user = userEvent.setup()
      installMockWebApi({
        getUpdateStatus: vi.fn(async () => ({
          ...checked,
          job,
          maintenance: true,
          canInstall: false,
          canRetryTask
        }))
      })
      renderWithProviders(<App canChangePassword={false} />)
      const dialog = await open(user)
      expect(within(dialog).getByText(/Checking that 1\.10\.0 is running/i)).toBeInTheDocument()
      expect(actionNames(dialog)).toEqual([])
      expect(within(dialog).getByText(/does not cancel an accepted update/i)).toBeInTheDocument()
    }
  )

  it('offers a single Resume update action only when the accepted task is verified idle', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async (): Promise<UpdateStatus> => ({
        ...checked,
        job: { ...job, phase: 'accepted' },
        maintenance: true,
        canInstall: false,
        canRetryTask: true,
        blockedReason: 'The accepted task is idle without matching worker progress.'
      })),
      retryUpdateTask: vi.fn(async () => job)
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(actionNames(dialog)).toEqual(['Resume update'])
    expect(within(dialog).getByText(/idle without matching worker progress/i)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /^resume update$/i }))
    expect(api.retryUpdateTask).toHaveBeenCalledOnce()
    expect(api.installUpdate).not.toHaveBeenCalled()
    expect(api.checkForUpdates).not.toHaveBeenCalled()
  })

  it('offers Resume update for a failed job when the server authorizes a retry', async () => {
    const user = userEvent.setup()
    installMockWebApi({
      getUpdateStatus: vi.fn(async (): Promise<UpdateStatus> => ({
        ...checked,
        job: { ...job, phase: 'failed', error: 'Health check failed' },
        maintenance: true,
        canInstall: false,
        canRetryTask: true
      }))
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(actionNames(dialog)).toEqual(['Resume update'])
  })

  it('clears a proven pre-acceptance rejection, keeps focus on the error, and needs another explicit click', async () => {
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
    await user.click(updateButton())
    expect(await screen.findByText('Could not persist or accept this update.')).toBeInTheDocument()
    expect(screen.getByText(/did not start/i)).toBeInTheDocument()
    await waitFor(() => expect(localStorage.getItem(markerKey)).toBeNull())
    expect(updateButton()).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveFocus()
    expect(api.installUpdate).toHaveBeenCalledOnce()
    await user.click(updateButton())
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledTimes(2))
  })

  it.each([true, undefined])(
    'retains a 503 with acceptance %s despite idle status, reports it as unknown, and does not resubmit',
    async (accepted) => {
      const user = userEvent.setup()
      const api = installMockWebApi({
        getUpdateStatus: vi.fn(async () => checked),
        installUpdate: vi.fn(async () => {
          throw Object.assign(new Error('Scheduler response lost'), { status: 503, accepted })
        })
      })
      renderWithProviders(<App canChangePassword={false} />)
      const dialog = await open(user)
      await user.click(updateButton())
      await waitFor(() => expect(api.getUpdateStatus).toHaveBeenCalledTimes(2))
      expect(localStorage.getItem(markerKey)).not.toBeNull()
      expect(actionNames(dialog)).toEqual([])
      expect(
        within(dialog).getByText(/waiting for siphon to report the result/i)
      ).toBeInTheDocument()
      expect(within(dialog).queryByText(/did not start|failed/i)).not.toBeInTheDocument()
      expect(api.installUpdate).toHaveBeenCalledOnce()
      expect(api.checkForUpdates).not.toHaveBeenCalled()
    }
  )

  it('submits directly from the keyboard with impact shown upfront and moves focus to the status', async () => {
    const user = userEvent.setup()
    let finish!: (result: UpdateJob) => void
    const installing = new Promise<UpdateJob>((resolve) => {
      finish = resolve
    })
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => checked),
      installUpdate: vi.fn(() => installing)
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(actionNames(dialog)).toEqual(['Update and restart'])
    expect(within(dialog).getByText(/restart.*sign in again.*saved data are kept/i)).toBeVisible()
    updateButton().focus()
    await user.keyboard('{Enter}')
    expect(api.installUpdate).toHaveBeenCalledOnce()
    expect(within(dialog).getByRole('status')).toHaveFocus()
    expect(actionNames(dialog)).toEqual([])
    await user.keyboard('{Enter}')
    finish({ ...job, phase: 'accepted' })
    await waitFor(() => expect(localStorage.getItem(markerKey)).toContain(job.id))
    expect(api.installUpdate).toHaveBeenCalledOnce()
  })

  it('does not check or offer anything for unsupported installs', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi()
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(within(dialog).getByText(/installed Windows service/i)).toBeInTheDocument()
    expect(actionNames(dialog)).toEqual([])
    expect(api.checkForUpdates).not.toHaveBeenCalled()
    expect(api.installUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['maintenance', { ...unchecked, maintenance: true, job }, null],
    ['checks unavailable', { ...unchecked, canCheck: false }, null],
    ['an already checked result', { ...unchecked, check: { state: 'checked' as const } }, null],
    ['a reconnect marker', unchecked, marker]
  ])('does not automatically check with %s', async (_name, status, stored) => {
    const user = userEvent.setup()
    if (stored) localStorage.setItem(markerKey, JSON.stringify(stored))
    const api = installMockWebApi({ getUpdateStatus: vi.fn(async () => status) })
    renderWithProviders(<App canChangePassword={false} />)
    if (stored) await screen.findByRole('dialog', { name: /updates/i })
    else await open(user)
    await waitFor(() => expect(api.getUpdateStatus).toHaveBeenCalled())
    expect(api.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks once on open, pins the checked offer, stores intent before POST, and does not recheck on reopen', async () => {
    const user = userEvent.setup()
    let status = unchecked
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
      getUpdateStatus: vi.fn(async () => status),
      checkForUpdates: vi.fn(async () => {
        status = checked
        return checked
      }),
      installUpdate
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(await within(dialog).findByText(/1\.10\.0 is available/)).toBeInTheDocument()
    expect(api.checkForUpdates).toHaveBeenCalledOnce()
    await user.click(within(dialog).getByRole('button', { name: /^close/i }))
    await open(user)
    expect(await screen.findByText(/1\.10\.0 is available/)).toBeInTheDocument()
    expect(api.checkForUpdates).toHaveBeenCalledOnce()
    await user.click(updateButton())
    expect(installUpdate).toHaveBeenCalledExactlyOnceWith({ offerId: offer.id })
    expect(api.checkForUpdates).toHaveBeenCalledOnce()
    finish({ ...job, phase: 'accepted' })
    await waitFor(() => expect(localStorage.getItem(markerKey)).toContain(job.id))
  })

  it('ignores a status read launched before a check finished so it cannot overwrite the new offer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    let finishCheck!: (result: UpdateStatus) => void
    let finishPoll!: (result: UpdateStatus) => void
    const reads = vi
      .fn<() => Promise<UpdateStatus>>()
      .mockResolvedValueOnce(unchecked)
      .mockImplementationOnce(() => new Promise((resolve) => (finishPoll = resolve)))
      .mockResolvedValue(checked)
    const api = installMockWebApi({
      getUpdateStatus: reads,
      checkForUpdates: vi.fn(() => new Promise<UpdateStatus>((resolve) => (finishCheck = resolve)))
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    await waitFor(() => expect(api.checkForUpdates).toHaveBeenCalledOnce())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(reads).toHaveBeenCalledTimes(2)
    await act(async () => finishCheck(checked))
    expect(await within(dialog).findByText(/1\.10\.0 is available/)).toBeInTheDocument()
    await act(async () => finishPoll(unchecked))
    expect(within(dialog).getByText(/1\.10\.0 is available/)).toBeInTheDocument()
    expect(updateButton()).toBeEnabled()
  })

  it('reconciles a concurrent check conflict from status instead of showing a hard error', async () => {
    const user = userEvent.setup()
    const reads = vi
      .fn<() => Promise<UpdateStatus>>()
      .mockResolvedValueOnce(unchecked)
      .mockResolvedValue(checked)
    installMockWebApi({
      getUpdateStatus: reads,
      checkForUpdates: vi.fn(async () => {
        throw Object.assign(new Error('An update operation is already active.'), { status: 409 })
      })
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(await within(dialog).findByText(/1\.10\.0 is available/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/already active/i)).not.toBeInTheDocument()
  })

  it('shows a failed check with details and a single Check again action, never an available update', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => unchecked),
      checkForUpdates: vi.fn(async () => {
        throw new Error('Release server unavailable')
      })
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(await within(dialog).findByText(/couldn't check for updates/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/Release server unavailable/i)).toBeInTheDocument()
    expect(actionNames(dialog)).toEqual(['Check again'])
    await user.click(within(dialog).getByRole('button', { name: /^check again$/i }))
    await waitFor(() => expect(api.checkForUpdates).toHaveBeenCalledTimes(2))
    expect(api.installUpdate).not.toHaveBeenCalled()
  })

  it('shows the new version, not an older failed job, after an explicit new check', async () => {
    const user = userEvent.setup()
    const failedJob = { ...job, phase: 'failed' as const, error: 'Old install failed' }
    let status: UpdateStatus = { ...checked, offer: null, canInstall: false, job: failedJob }
    installMockWebApi({
      getUpdateStatus: vi.fn(async () => status),
      checkForUpdates: vi.fn(async () => {
        status = { ...checked, job: failedJob }
        return status
      })
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    await user.click(within(dialog).getByRole('button', { name: /^check again$/i }))
    expect(await within(dialog).findByText(/1\.10\.0 is available/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/could not be installed/i)).not.toBeInTheDocument()
    expect(actionNames(dialog)).toEqual(['Update and restart'])
  })

  it('offers only Check again when already up to date', async () => {
    const user = userEvent.setup()
    installMockWebApi({
      getUpdateStatus: vi.fn(async () => ({ ...checked, offer: null, canInstall: false }))
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(within(dialog).getByText(/up to date/i)).toBeInTheDocument()
    expect(actionNames(dialog)).toEqual(['Check again'])
  })

  it('shows the transfer blocker and keeps the update action disabled', async () => {
    const user = userEvent.setup()
    const api = installMockWebApi({
      getUpdateStatus: vi.fn(async () => ({
        ...checked,
        canInstall: false,
        blockedReason: 'Transfers are active. Finish or cancel queued and running transfers.'
      }))
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await open(user)
    expect(within(dialog).getByText(/Finish or cancel queued and running transfers/i)).toBeVisible()
    expect(updateButton()).toBeDisabled()
    expect(actionNames(dialog)).toEqual(['Update and restart'])
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
    await user.click(updateButton())
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
    const dialog = screen.getByRole('dialog', { name: /updates/i })
    expect(
      await within(dialog).findByText(/Checking that 1\.10\.0 is running/i)
    ).toBeInTheDocument()
    expect(api.installUpdate).toHaveBeenCalledOnce()
    expect(actionNames(dialog)).toEqual([])
    expect(localStorage.getItem(markerKey)).not.toBeNull()
  })

  it('offers Reconnect after status reads keep failing and then recovers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    let healthy = false
    installMockWebApi({
      getUpdateStatus: vi.fn(async () => {
        if (!healthy) throw new Error('Network down')
        return checked
      })
    })
    renderWithProviders(<App canChangePassword={false} />)
    await user.click(screen.getByRole('button', { name: /^updates$/i }))
    const dialog = await screen.findByRole('dialog', { name: /updates/i })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(await within(dialog).findByText(/can't read the update status/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/Network down/)).toBeInTheDocument()
    expect(actionNames(dialog)).toEqual(['Reconnect'])
    healthy = true
    await user.click(within(dialog).getByRole('button', { name: /^reconnect$/i }))
    expect(await within(dialog).findByText(/1\.10\.0 is available/)).toBeInTheDocument()
  })

  it('keeps recovery intent through login and shows an authoritative rollback with its details', async () => {
    const user = userEvent.setup()
    localStorage.setItem(markerKey, JSON.stringify(marker))
    let authenticated = false
    const api = installMockWebApi({
      onSessionExpired: vi.fn(() => () => {}),
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
    expect(await screen.findByText(/rolled back. Siphon is running 1\.0\.2/i)).toBeInTheDocument()
    const raw = screen.getByText('New version failed health verification')
    expect(raw.closest('details')).not.toBeNull()
    expect(within(raw.closest('details')!).getByText('Details')).toBeInTheDocument()
    await waitFor(() => expect(localStorage.getItem(markerKey)).toBeNull())
    expect(api.installUpdate).not.toHaveBeenCalled()
  })

  it('requires an administrator after failed rollback and clears the marker without offering actions', async () => {
    localStorage.setItem(markerKey, JSON.stringify(marker))
    installMockWebApi({
      getUpdateStatus: vi.fn(async () => ({
        ...checked,
        maintenance: true,
        canInstall: false,
        canRetryTask: false,
        job: { ...job, phase: 'rollback-failed' as const, error: 'Old executable missing' }
      }))
    })
    renderWithProviders(<App canChangePassword={false} />)
    const dialog = await screen.findByRole('dialog', { name: /updates/i })
    expect(await within(dialog).findByText(/administrator must repair/i)).toBeInTheDocument()
    const raw = within(dialog).getByText('Old executable missing')
    expect(raw).toBeVisible()
    expect(raw.closest('details')).toHaveAttribute('open')
    expect(within(dialog).getByText('Details')).toBeInTheDocument()
    await waitFor(() => expect(localStorage.getItem(markerKey)).toBeNull())
    expect(actionNames(dialog)).toEqual([])
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
    expect(api.planDownload).not.toHaveBeenCalled()
    await user.click(
      within(screen.getByRole('dialog', { name: /updates/i })).getByRole('button', {
        name: /^close/i
      })
    )
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(api.planDownload).toHaveBeenCalledOnce())
  })
})
