import { useEffect, useState } from 'react'
import { Button, Label, ProgressBar } from '@primer/react'
import { ArrowDownIcon, ArrowUpIcon } from '@primer/octicons-react'
import type { TransferProgress, TransferStatus } from '@shared/types'
import { formatBytes, formatEta, formatPercent, formatSpeed } from '../lib/format'

interface TransferQueueProps {
  transfers: TransferProgress[]
  maxConcurrent: number
  onMaxConcurrentChange: (max: number) => void
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onClearFinished: () => void
  onClearAll: () => void
}

const STATUS_LABELS: Record<TransferStatus, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  completed: 'Completed',
  error: 'Error',
  canceled: 'Canceled'
}

function statusLabel(transfer: TransferProgress): string {
  const isUpload = transfer.direction === 'upload'
  if (transfer.status === 'downloading') {
    return isUpload ? 'Uploading' : 'Downloading'
  }
  return `${isUpload ? 'Upload' : 'Download'} ${STATUS_LABELS[transfer.status].toLowerCase()}`
}

const STATUS_VARIANTS: Record<TransferStatus, 'accent' | 'success' | 'danger' | 'secondary'> = {
  queued: 'secondary',
  downloading: 'accent',
  completed: 'success',
  error: 'danger',
  canceled: 'secondary'
}

const STATUS_PROGRESS_BG: Record<TransferStatus, string> = {
  queued: 'accent.emphasis',
  downloading: 'accent.emphasis',
  completed: 'success.emphasis',
  error: 'danger.emphasis',
  canceled: 'neutral.emphasis'
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function TransferQueue(props: TransferQueueProps) {
  const {
    transfers,
    maxConcurrent,
    onMaxConcurrentChange,
    onCancel,
    onRemove,
    onClearFinished,
    onClearAll
  } = props

  const [concurrentText, setConcurrentText] = useState(String(maxConcurrent))
  useEffect(() => {
    setConcurrentText(String(maxConcurrent))
  }, [maxConcurrent])

  const handleConcurrentChange = (raw: string): void => {
    const next = raw.replace(/[^0-9]/g, '')
    setConcurrentText(next)
    const n = Number.parseInt(next, 10)
    if (Number.isFinite(n) && n >= 1 && n <= 8) onMaxConcurrentChange(n)
  }

  const handleConcurrentBlur = (): void => {
    const n = Number.parseInt(concurrentText, 10)
    const clamped = Number.isFinite(n) ? Math.max(1, Math.min(8, n)) : maxConcurrent
    setConcurrentText(String(clamped))
    if (clamped !== maxConcurrent) onMaxConcurrentChange(clamped)
  }

  const hasFinished = transfers.some(
    (t) => t.status === 'completed' || t.status === 'error' || t.status === 'canceled'
  )

  return (
    <section className="panel queue">
      <div className="queue__header">
        <h2>Transfers{transfers.length > 0 ? ` (${transfers.length})` : ''}</h2>
        <div className="queue__header-actions">
          <label className="field field--concurrent">
            <span>Concurrent</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={8}
              value={concurrentText}
              onChange={(e) => handleConcurrentChange(e.target.value)}
              onBlur={handleConcurrentBlur}
            />
          </label>
          <Button variant="default" disabled={transfers.length === 0} onClick={onClearAll}>
            Clear all
          </Button>
          <Button variant="default" disabled={!hasFinished} onClick={onClearFinished}>
            Clear finished
          </Button>
        </div>
      </div>

      <div className="queue__body">
        {transfers.length === 0 ? (
          <p className="empty">No transfers yet.</p>
        ) : (
          <ul className="transfer-list">
            {transfers.map((transfer) => {
              const percent = formatPercent(transfer.transferred, transfer.size)
              const active = transfer.status === 'downloading'
              const isUpload = transfer.direction === 'upload'
              const canceling = transfer.canceling === true && transfer.status === 'downloading'
              const eta =
                active && !canceling && transfer.size > 0 && transfer.speedBytesPerSec > 0
                  ? formatEta(transfer.size - transfer.transferred, transfer.speedBytesPerSec)
                  : ''
              return (
                <li key={transfer.id} className="transfer">
                  <div className="transfer__top">
                    <span className="transfer__name" title={transfer.remotePath}>
                      {isUpload ? (
                        <ArrowUpIcon aria-label="Upload" />
                      ) : (
                        <ArrowDownIcon aria-label="Download" />
                      )}
                      {baseName(transfer.localPath || transfer.remotePath)}
                    </span>
                    <Label variant={STATUS_VARIANTS[transfer.status]}>
                      {statusLabel(transfer)}
                    </Label>
                  </div>

                  <ProgressBar
                    progress={percent}
                    bg={STATUS_PROGRESS_BG[transfer.status]}
                    aria-label={`${baseName(
                      transfer.localPath || transfer.remotePath
                    )} ${percent}%`}
                    aria-valuenow={percent}
                  />

                  <div className="transfer__meta">
                    <span>
                      {formatBytes(transfer.transferred)} / {formatBytes(transfer.size)} ({percent}
                      %)
                    </span>
                    {canceling ? (
                      <span>Canceling…</span>
                    ) : (
                      active && (
                        <span>
                          {formatSpeed(transfer.speedBytesPerSec)}
                          {!isUpload
                            ? ` · ${transfer.activeSegments}/${transfer.segments} segments`
                            : ''}
                          {eta ? ` · ~${eta} left` : ''}
                        </span>
                      )
                    )}
                    {transfer.status === 'error' && transfer.error && (
                      <span className="transfer__error">{transfer.error}</span>
                    )}
                    <span className="transfer__actions">
                      {(transfer.status === 'downloading' || transfer.status === 'queued') &&
                        !canceling && (
                          <Button size="small" onClick={() => onCancel(transfer.id)}>
                            Cancel
                          </Button>
                        )}
                      {transfer.status !== 'downloading' && (
                        <Button size="small" onClick={() => onRemove(transfer.id)}>
                          Remove
                        </Button>
                      )}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
