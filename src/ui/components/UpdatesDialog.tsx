import { useEffect, useId, useRef, useState } from 'react'
import { Button, Dialog } from '@primer/react'
import type { UpdateJob, UpdateStatus } from '@shared/api'
import { errorMessage } from '../lib/format'

const markerKey = 'siphon.update-reconnect'
const reconnectBudget = 20 * 60 * 1000
const statusFailureBudget = 3

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

function jobMatches(marker: ReconnectMarker, job: UpdateJob): boolean {
  return (
    job.fromVersion === marker.fromVersion &&
    job.toVersion === marker.toVersion &&
    (marker.jobId ? job.id === marker.jobId : !job.offerId || job.offerId === marker.offerId)
  )
}

function jobSummary(job: UpdateJob): { text: string; failed?: boolean } {
  switch (job.phase) {
    case 'accepted':
      return { text: 'Update accepted. Starting…' }
    case 'downloading':
    case 'verifying-download':
      return { text: `Downloading and verifying ${job.toVersion}. Siphon is still available.` }
    case 'stopping':
    case 'backing-up':
    case 'replacing':
      return { text: `Installing ${job.toVersion}. Siphon is about to restart.` }
    case 'starting':
      return { text: 'Restarting Siphon…' }
    case 'verifying-new':
      return { text: `Checking that ${job.toVersion} is running correctly…` }
    case 'rolling-back':
    case 'verifying-old':
      return { text: 'The update failed. Restoring the previous version…', failed: true }
    case 'succeeded':
      return { text: `Updated to ${job.toVersion}.` }
    case 'failed':
      return { text: 'The update could not be installed.', failed: true }
    case 'rolled-back':
      return {
        text: `The update failed and was rolled back. Siphon is running ${job.fromVersion}.`,
        failed: true
      }
    case 'rollback-failed':
      return {
        text: 'The update failed and recovery failed. An administrator must repair the Siphon service.',
        failed: true
      }
    default:
      return { text: 'The update state is unknown.' }
  }
}

function Details({
  lines,
  open
}: {
  lines: Array<string | undefined | false | null>
  open?: boolean
}) {
  const unique = [...new Set(lines.filter((line): line is string => Boolean(line)))]
  if (!unique.length) return null
  return (
    <details className="updates-dialog__details" open={open}>
      <summary>Details</summary>
      {unique.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </details>
  )
}

type ActionError = { summary: string; detail: string }

export function UpdatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [connection, setConnection] = useState<'offline' | 'signin' | null>(null)
  const [stalled, setStalled] = useState(false)
  const [settled, setSettled] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [monitor, setMonitor] = useState(hasUpdateReconnect)
  const [retry, setRetry] = useState(0)
  const submitted = useRef(false)
  const checkingRef = useRef(false)
  const autoChecked = useRef(false)
  // Bumped when a check or install starts and ends so older status reads cannot overwrite newer state.
  const epoch = useRef(0)
  const statusRef = useRef<HTMLDivElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(open)
  openRef.current = open
  const checkRef = useRef(check)
  checkRef.current = check
  const blockerId = useId()

  useEffect(() => {
    if (!open) autoChecked.current = false
  }, [open])

  useEffect(() => {
    if (open && actionError) alertRef.current?.focus()
  }, [open, actionError])

  useEffect(() => {
    if (!open && !monitor) return
    const controller = new AbortController()
    let timer: number | undefined
    let failures = 0
    const deadline = Date.now() + reconnectBudget

    const poll = async () => {
      if (controller.signal.aborted) return
      let keepPolling = monitor || openRef.current
      const launchedAt = epoch.current
      try {
        const next = await window.api.getUpdateStatus(controller.signal)
        if (controller.signal.aborted) return
        failures = 0
        setStalled(false)
        setConnection(null)
        setStatusError(null)
        if (launchedAt === epoch.current && !checkingRef.current) {
          setStatus(next)
          const marker = readMarker()
          const matching = Boolean(marker && next.job && jobMatches(marker, next.job))
          if (marker && matching && next.job) {
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
              setSettled(next.job.id)
            } else {
              keepPolling = true
            }
          }
          if (!marker && !next.capability.supported) keepPolling = false
          if (next.maintenance) keepPolling = true
          if (openRef.current && !autoChecked.current) {
            autoChecked.current = true
            if (
              next.capability.supported &&
              next.canCheck !== false &&
              !next.maintenance &&
              !marker &&
              !submitted.current &&
              next.check.state === 'idle' &&
              !next.offer
            ) {
              void checkRef.current(true)
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return
        failures += 1
        if (monitor || readMarker()) {
          setConnection('offline')
          if ((err as Error & { status?: number }).status === 401) {
            setConnection('signin')
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
            } catch {}
          }
        } else {
          setStatusError(errorMessage(err))
          if (failures >= statusFailureBudget) {
            setStalled(true)
            keepPolling = false
          }
        }
      }
      if (!controller.signal.aborted && keepPolling) {
        const tracking = monitor || Boolean(readMarker())
        if (Date.now() >= deadline) {
          if (tracking) setStalled(true)
        } else {
          timer = window.setTimeout(() => void poll(), tracking ? 1000 : 5000)
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [open, monitor, retry])

  async function check(auto = false) {
    if (checkingRef.current) return
    checkingRef.current = true
    epoch.current += 1
    setChecking(true)
    setCheckError(null)
    setSettled(null)
    setActionError(null)
    try {
      setStatus(await window.api.checkForUpdates())
    } catch (err) {
      let reconciled: UpdateStatus | null = null
      // A 409 can mean another tab is already checking, so the authoritative status may explain it.
      if ((err as Error & { status?: number }).status === 409) {
        try {
          reconciled = await window.api.getUpdateStatus()
          setStatus(reconciled)
        } catch {}
      }
      if (reconciled) {
        const unexplained =
          reconciled.capability.supported &&
          !reconciled.maintenance &&
          reconciled.check.state === 'idle'
        if (unexplained && !auto) {
          setCheckError('Another update check is running. Try again in a moment.')
        }
      } else {
        setCheckError(errorMessage(err))
        setStatus((previous) => (previous ? { ...previous, offer: null, canInstall: false } : null))
      }
    } finally {
      epoch.current += 1
      checkingRef.current = false
      setChecking(false)
    }
  }

  async function install() {
    if (submitted.current || !status?.offer || !status.canInstall || hasUpdateReconnect()) return
    submitted.current = true
    epoch.current += 1
    setSubmitting(true)
    setActionError(null)
    statusRef.current?.focus()
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
      setActionError({
        summary: 'The update did not start.',
        detail: 'Browser storage is unavailable. Installation was not submitted.'
      })
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
        setActionError({
          summary: 'The update did not start. Nothing was changed. You can try again.',
          detail: errorMessage(err)
        })
      }
    } finally {
      epoch.current += 1
      setSubmitting(false)
      setMonitor(hasUpdateReconnect())
      setRetry((value) => value + 1)
    }
  }

  async function retryTask() {
    if (submitting) return
    setSubmitting(true)
    setActionError(null)
    try {
      await window.api.retryUpdateTask()
      setMonitor(true)
      setRetry((value) => value + 1)
    } catch (err) {
      setActionError({ summary: 'Could not resume the update.', detail: errorMessage(err) })
    } finally {
      setSubmitting(false)
    }
  }

  function reconnect() {
    setStalled(false)
    setConnection(null)
    setStatusError(null)
    setRetry((value) => value + 1)
  }

  if (!open) return null

  const marker = readMarker()
  const tracking = monitor || Boolean(marker)
  const job = status?.job ?? null
  const trackedJob = job && (marker ? jobMatches(marker, job) : true) ? job : null
  const maintenance = Boolean(status?.maintenance)
  const pending = tracking || maintenance || submitting
  const supported = Boolean(status?.capability.supported)
  const offer = status?.offer ?? null
  const shownCheckError =
    checkError ??
    (status?.check.state === 'error' ? status.check.error || 'Release check failed.' : null)
  // A current check or offer outranks an older terminal job, except a result this dialog just settled.
  const hasCurrentCheck =
    checking || Boolean(shownCheckError) || Boolean(offer) || status?.check.state !== 'idle'
  const shownJob = tracking
    ? trackedJob
    : job &&
        (!terminal(job) ||
          maintenance ||
          job.phase === 'rollback-failed' ||
          settled === job.id ||
          (job.phase !== 'succeeded' && !hasCurrentCheck))
      ? job
      : null
  const canResume = maintenance && status?.canRetryTask === true && !(job && terminal(job))

  type Stage = {
    text: string
    failed?: boolean
    details?: Array<string | undefined | null | false>
  }
  let stage: Stage
  if (!status) {
    stage = stalled
      ? { text: "Can't read the update status.", failed: true, details: [statusError] }
      : { text: 'Reading update status…' }
  } else if (stalled) {
    stage = tracking
      ? {
          text: "Can't reach Siphon. The update result is unknown, not a failure.",
          failed: true,
          details: [status.job?.error]
        }
      : { text: "Can't read the update status.", failed: true, details: [statusError] }
  } else if (connection === 'signin') {
    stage = { text: 'Sign in again to see the update result.' }
  } else if (connection === 'offline' && tracking) {
    stage = { text: 'Siphon is restarting or unreachable. Reconnecting to check the result…' }
  } else if (submitting) {
    stage = { text: 'Sending the update request…' }
  } else if (shownJob) {
    const summary = canResume
      ? { text: 'The accepted update is not running. Resume it to continue this same update.' }
      : jobSummary(shownJob)
    stage = {
      ...summary,
      details: [shownJob.error, maintenance && status.blockedReason]
    }
  } else if (tracking) {
    stage = { text: 'Update requested. Waiting for Siphon to report the result…' }
  } else if (maintenance) {
    stage = {
      text: 'An update is in progress. Waiting for it to finish…',
      details: [status.blockedReason]
    }
  } else if (!supported) {
    stage = { text: status.capability.supported ? '' : status.capability.message }
  } else if (checking) {
    stage = { text: 'Checking for updates…' }
  } else if (shownCheckError) {
    stage = { text: "Couldn't check for updates.", failed: true, details: [shownCheckError] }
  } else if (offer) {
    stage = { text: `Version ${offer.version} is available.` }
  } else if (status.check.state === 'checked') {
    stage = { text: 'Siphon is up to date.' }
  } else {
    stage = { text: 'Not checked for updates yet.' }
  }

  const canCheck = supported && status?.canCheck !== false
  let action: {
    label: string
    onClick: () => void
    disabled?: boolean
    primary?: boolean
    blocked?: boolean
  } | null = null
  if (stalled) {
    action = { label: 'Reconnect', onClick: reconnect }
  } else if (pending) {
    if (canResume) {
      action = { label: 'Resume update', onClick: () => void retryTask(), disabled: submitting }
    }
  } else if (status && supported) {
    if (checking) {
      action = { label: 'Checking…', onClick: () => {}, disabled: true }
    } else if (offer && !shownCheckError) {
      action = {
        label: 'Update and restart',
        onClick: () => void install(),
        disabled: !status.canInstall,
        primary: true,
        blocked: !status.canInstall
      }
    } else if (canCheck) {
      const again = shownCheckError || status.check.state === 'checked'
      action = { label: again ? 'Check again' : 'Check for updates', onClick: () => void check() }
    }
  }
  const showImpact = Boolean(action?.primary)

  return (
    <Dialog title="Updates" onClose={onClose}>
      <div className="updates-dialog">
        {status && (
          <dl className="updates-dialog__versions">
            <dt>Installed version</dt>
            <dd>{status.currentVersion}</dd>
          </dl>
        )}
        <div ref={statusRef} tabIndex={-1} role="status" className="updates-dialog__progress">
          {stage.text && (
            <p className={stage.failed ? 'banner banner--error' : undefined}>{stage.text}</p>
          )}
          {stage.details && (
            <Details lines={stage.details} open={shownJob?.phase === 'rollback-failed'} />
          )}
        </div>
        {actionError && (
          <div ref={alertRef} tabIndex={-1} role="alert" className="updates-dialog__progress">
            <p className="banner banner--error">{actionError.summary}</p>
            <Details lines={[actionError.detail]} />
          </div>
        )}
        {showImpact && (
          <p>
            Siphon will restart and this browser will disconnect. You may need to sign in again.
            Your settings and saved data are kept.
          </p>
        )}
        {showImpact && status?.blockedReason && !status.canInstall && (
          <p id={blockerId}>{status.blockedReason}</p>
        )}
        {action && (
          <div className="updates-dialog__actions">
            <Button
              variant={action.primary ? 'primary' : 'default'}
              disabled={action.disabled}
              aria-describedby={action.blocked && status?.blockedReason ? blockerId : undefined}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          </div>
        )}
        {pending && !stalled && <p>Closing this dialog does not cancel an accepted update.</p>}
      </div>
    </Dialog>
  )
}
