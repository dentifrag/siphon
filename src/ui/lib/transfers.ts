import type { DownloadEvent, TransferProgress } from '@shared/types'

export function applyDownloadEvent(
  prev: TransferProgress[],
  event: DownloadEvent
): TransferProgress[] {
  if (event.type === 'reset') {
    return event.transfers
  }
  if (event.type === 'remove') {
    return prev.filter((t) => t.id !== event.id)
  }
  const update = event.transfer
  const index = prev.findIndex((t) => t.id === update.id)
  if (index === -1) return [...prev, update]
  const next = prev.slice()
  next[index] = update
  return next
}
