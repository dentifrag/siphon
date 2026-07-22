import type { TransferProgress, TransferStatus } from '@shared/types'
import { formatBytes, formatPercent, formatSpeed } from '../lib/format'

interface TransferQueueProps {
  transfers: TransferProgress[]
  onCancel: (id: string) => void
  onClearFinished: () => void
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

export function TransferQueue(props: TransferQueueProps) {
  const { transfers, onCancel, onClearFinished } = props
  const hasFinished = transfers.some(
    (t) => t.status === 'completed' || t.status === 'error' || t.status === 'canceled'
  )

  return (
    <section className="panel queue">
      <div className="queue__header">
        <h2>Transfers{transfers.length > 0 ? ` (${transfers.length})` : ''}</h2>
        <button
          type="button"
          className="btn"
          disabled={!hasFinished}
          onClick={onClearFinished}
        >
          Clear finished
        </button>
      </div>

      <div className="queue__body">
        {transfers.length === 0 ? (
          <p className="empty">No transfers yet.</p>
        ) : (
          <ul className="transfer-list">
            {transfers.map((transfer) => {
              const percent = formatPercent(transfer.transferred, transfer.size)
              const active = transfer.status === 'downloading'
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
                    {active && (
                      <span>
                        {formatSpeed(transfer.speedBytesPerSec)} · {transfer.activeSegments}/
                        {transfer.segments} segments
                      </span>
                    )}
                    {transfer.status === 'error' && transfer.error && (
                      <span className="transfer__error">{transfer.error}</span>
                    )}
                    <span className="transfer__actions">
                      {(transfer.status === 'downloading' || transfer.status === 'queued') && (
                        <button
                          type="button"
                          className="btn btn--small"
                          onClick={() => onCancel(transfer.id)}
                        >
                          Cancel
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
