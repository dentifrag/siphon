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

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function clampConcurrent(value: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(8, n))
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
              min={1}
              max={8}
              value={maxConcurrent}
              onChange={(e) => onMaxConcurrentChange(clampConcurrent(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={transfers.length === 0}
            onClick={onClearAll}
          >
            Clear all
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasFinished}
            onClick={onClearFinished}
          >
            Clear finished
          </button>
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
              const canceling = transfer.canceling === true && transfer.status === 'downloading'
              const eta =
                active && !canceling && transfer.size > 0 && transfer.speedBytesPerSec > 0
                  ? formatEta(transfer.size - transfer.transferred, transfer.speedBytesPerSec)
                  : ''
              return (
                <li key={transfer.id} className="transfer">
                  <div className="transfer__top">
                    <span className="transfer__name" title={transfer.remotePath}>
                      {baseName(transfer.localPath || transfer.remotePath)}
                    </span>
                    <span className={`badge badge--${transfer.status}`}>
                      {STATUS_LABELS[transfer.status]}
                    </span>
                  </div>

                  <div className="progress">
                    <div
                      className={`progress__bar progress__bar--${transfer.status}`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  <div className="transfer__meta">
                    <span>
                      {formatBytes(transfer.transferred)} / {formatBytes(transfer.size)} (
                      {percent}%)
                    </span>
                    {canceling ? (
                      <span>Canceling…</span>
                    ) : (
                      active && (
                        <span>
                          {formatSpeed(transfer.speedBytesPerSec)} · {transfer.activeSegments}/
                          {transfer.segments} segments
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
                          <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => onCancel(transfer.id)}
                          >
                            Cancel
                          </button>
                        )}
                      {transfer.status !== 'downloading' && (
                        <button
                          type="button"
                          className="btn btn--small"
                          onClick={() => onRemove(transfer.id)}
                        >
                          Remove
                        </button>
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
