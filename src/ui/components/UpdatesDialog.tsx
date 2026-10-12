import { useEffect, useRef, useState } from 'react'
import { Button, Dialog } from '@primer/react'
import type { UpdateJob, UpdateStatus } from '@shared/api'
import { errorMessage } from '../lib/format'

const markerKey = 'siphon.update-reconnect'
const reconnectBudget = 20 * 60 * 1000

interface ReconnectMarker {
  offerId: string
  fromVersion: string
  toVersion: string
  submittedAt: number
  jobId?: string
  reloaded?: boolean
}

function readMarker(): ReconnectMarker | null {
  try {
    const value = JSON.parse(localStorage.getItem(markerKey) || 'null')
    if (
      value &&
      typeof value.offerId === 'string' &&
      typeof value.fromVersion === 'string' &&
      typeof value.toVersion === 'string' &&
      typeof value.submittedAt === 'number'
    ) {
      return value
    }
  } catch {}
  return null
}

export function hasUpdateReconnect(): boolean {
  return Boolean(readMarker())
}

function terminal(job: UpdateJob): boolean {
  return ['succeeded', 'rolled-back', 'failed', 'rollback-failed'].includes(job.phase)
}

const phases: Record<UpdateJob['phase'], string> = {
  accepted: 'Accepted: waiting for the independent update task.',
  downloading: 'Downloading the confirmed release. Siphon is still serving.',
  'verifying-download': 'Verifying the downloaded executable.',
  stopping: 'Stopping the Windows service.',
  'backing-up': 'Backing up the installed executable.',
  replacing: 'Installing the verified executable.',
  starting: 'Restarting the Windows service.',
  'verifying-new': 'Verifying the new version and service health.',
  'rolling-back': 'Restoring the previous executable.',
  'verifying-old': 'Verifying the restored version and service health.',
  succeeded: 'Update installed successfully.',
  failed: 'Update could not be installed.',
  'rolled-back': 'Update rolled back. The previous version is running.',
  'rollback-failed': 'Recovery failed. Administrator intervention is required.'
}

export function UpdatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [monitor, setMonitor] = useState(hasUpdateReconnect)
  const [retry, setRetry] = useState(0)
  const submitted = useRef(false)
  const wasConfirming = useRef(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const installRef = useRef<HTMLButtonElement>(null)
  const confirmationRef = useRef<HTMLHeadingElement>(null)
  const summaryRef = useRef<HTMLParagraphElement>(null)
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (!open && !monitor) return
    const controller = new AbortController()
    let timer: number | undefined
    const deadline = Date.now() + reconnectBudget

    const poll = async () => {
      if (controller.signal.aborted) return
      let keepPolling = monitor || openRef.current
      try {
        const next = await window.api.getUpdateStatus(controller.signal)
        if (controller.signal.aborted) return
        setStatus(next)
        const marker = readMarker()
        const matching =
          marker &&
          next.job &&
          next.job.fromVersion === marker.fromVersion &&
          next.job.toVersion === marker.toVersion &&
          (marker.jobId
            ? next.job.id === marker.jobId
            : !next.job.offerId || next.job.offerId === marker.offerId)
        if (matching && next.job) {
          if (!marker.jobId) {
            localStorage.setItem(markerKey, JSON.stringify({ ...marker, jobId: next.job.id }))
          }
          if (
            terminal(next.job) &&
            (next.job.phase === 'rollback-failed' || !next.maintenance) &&
            openRef.current
          ) {
            localStorage.removeItem(markerKey)
            submitted.current = false
            keepPolling = false
            setMonitor(false)
            setNotice(null)
          } else {
            keepPolling = true
          }
        } else if (marker) {
          setNotice('Update outcome is unknown. Reconciling the accepted request; do not resubmit.')
        }
        if (!marker && !next.capability.supported) keepPolling = false
        if (next.maintenance) keepPolling = true
      } catch (err) {
        if (controller.signal.aborted) return
        if (monitor) {
          setNotice('Service unavailable. Waiting to reconnect; the update outcome is unknown.')
          if ((err as Error & { status?: number }).status === 401) {
            try {
              const health = await window.api.getVersionHealth(controller.signal)
              const marker = readMarker()
              if (
                !controller.signal.aborted &&
                marker &&
                !marker.reloaded &&
                health.app === 'siphon' &&
                [marker.fromVersion, marker.toVersion].includes(health.version)
              ) {
                localStorage.setItem(markerKey, JSON.stringify({ ...marker, reloaded: true }))
                window.location.reload()
                return
              }
              setNotice('Sign in again to read the authoritative update result.')
            } catch {}
          }
        } else {
          setError(errorMessage(err))
        }
      }
      if (!controller.signal.aborted && keepPolling) {
        if (Date.now() >= deadline) {
          if (readMarker() || monitor) {
            setNotice(
              'Reconnect deadline reached. Update outcome is unknown, not a proven failure. Retry status to reconnect.'
            )
          }
        } else {
          timer = window.setTimeout(() => void poll(), readMarker() || monitor ? 1000 : 5000)
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [open, monitor, retry])

  useEffect(() => {
    if (!open) setConfirming(false)
  }, [open])

  useEffect(() => {
    if (open) {
      if (confirming && submitting) confirmationRef.current?.focus()
      else if (confirming && !wasConfirming.current) cancelRef.current?.focus()
      else if (!confirming && wasConfirming.current) {
        if (submitted.current) summaryRef.current?.focus()
        else installRef.current?.focus()
      }
    }
    wasConfirming.current = confirming
  }, [open, confirming, submitting])

  async function check() {
    if (checking) return
    setChecking(true)
    setError(null)
    try {
      const next = await window.api.checkForUpdates()
      setStatus(next)
      if (next.check.state === 'error') setError(next.check.error || 'Release check failed.')
    } catch (err) {
      setError(errorMessage(err))
      setStatus((previous) => (previous ? { ...previous, offer: null, canInstall: false } : null))
    } finally {
      setChecking(false)
    }
  }

  async function install() {
    if (submitted.current || !status?.offer || !status.canInstall || hasUpdateReconnect()) return
    submitted.current = true
    setSubmitting(true)
    setError(null)
    const marker: ReconnectMarker = {
      offerId: status.offer.id,
      fromVersion: status.currentVersion,
      toVersion: status.offer.version,
      submittedAt: Date.now()
    }
    try {
      localStorage.setItem(markerKey, JSON.stringify(marker))
    } catch {
      submitted.current = false
      setSubmitting(false)
      setError('Browser storage is unavailable. Installation was not submitted.')
      return
    }
    try {
      const job = await window.api.installUpdate({ offerId: marker.offerId })
      localStorage.setItem(markerKey, JSON.stringify({ ...marker, jobId: job.id }))
      setStatus((previous) =>
        previous ? { ...previous, job, maintenance: true, canInstall: false } : previous
      )
    } catch (err) {
      const failure = err as Error & { status?: number; accepted?: boolean }
      const code = failure.status
      if (
        failure.accepted === false ||
        (failure.accepted !== true &&
          (code === 409 || code === 400 || code === 401 || code === 403 || code === 415))
      ) {
        localStorage.removeItem(markerKey)
        submitted.current = false
        setNotice(null)
        setError(errorMessage(err))
      } else {
        setNotice('Connection lost. Reconciling the accepted request without resubmitting.')
      }
    } finally {
      setConfirming(false)
      setSubmitting(false)
      setMonitor(hasUpdateReconnect())
      setRetry((value) => value + 1)
    }
  }

  async function retryTask() {
    if (submitting) return
    setSubmitting(true)
    try {
      await window.api.retryUpdateTask()
      setMonitor(true)
      setRetry((value) => value + 1)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null
  const pending = monitor || status?.maintenance || submitting
  const job = status?.job
  return (
    <Dialog title="Updates" onClose={onClose}>
      <div className="updates-dialog">
        <p ref={summaryRef} tabIndex={-1}>
          Updates replace only Siphon's executable and restart the existing service.
        </p>
        {status ? (
          <>
            <dl className="updates-dialog__versions">
              <dt>Installed version</dt>
              <dd>{status.currentVersion}</dd>
              <dt>Latest checked version</dt>
              <dd>
                {status.offer?.version ||
                  (status.check.state === 'checked' ? 'Current' : 'Not checked')}
              </dd>
            </dl>
            {!status.capability.supported && <p>{status.capability.message}</p>}
            {status.blockedReason && <p>{status.blockedReason}</p>}
            <div className="updates-dialog__actions">
              <Button
                disabled={
                  !status.capability.supported ||
                  status.canCheck === false ||
                  Boolean(pending) ||
                  checking
                }
                onClick={() => void check()}
              >
                {checking ? 'Checking…' : 'Check for updates'}
              </Button>
              {status.offer && !confirming && (
                <Button
                  ref={installRef}
                  variant="primary"
                  disabled={!status.canInstall || Boolean(pending) || checking}
                  onClick={() => setConfirming(true)}
                >
                  Install update
                </Button>
              )}
            </div>
            {confirming && (
              <div className="updates-dialog__confirmation">
                <h3 ref={confirmationRef} tabIndex={-1}>
                  Confirm installation
                </h3>
                <p>
                  Install {status.offer?.version} and restart? Finish all transfers first. The
                  browser may disconnect, and you may need to sign in again.
                </p>
                <div className="updates-dialog__actions">
                  <Button
                    ref={cancelRef}
                    disabled={submitting}
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </Button>
                  <Button variant="primary" disabled={submitting} onClick={() => void install()}>
                    {submitting ? 'Submitting…' : 'Install and restart'}
                  </Button>
                </div>
              </div>
            )}
            {job && (
              <div role="status" className="updates-dialog__progress">
                <p>{phases[job.phase] || 'Update state is unknown.'}</p>
                {job.error && <p className="banner banner--error">{job.error}</p>}
              </div>
            )}
            {status.maintenance && status.canRetryTask === true && (
              <Button disabled={submitting} onClick={() => void retryTask()}>
                Retry accepted task
              </Button>
            )}
          </>
        ) : (
          <p>Reading local update status…</p>
        )}
        {error && (
          <p role="alert" className="banner banner--error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {(notice || error) && (
          <Button
            onClick={() => {
              setError(null)
              setRetry((value) => value + 1)
            }}
          >
            Retry status
          </Button>
        )}
        <p>Closing this dialog does not cancel an accepted update.</p>
      </div>
    </Dialog>
  )
}
