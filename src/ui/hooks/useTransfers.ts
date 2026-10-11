import { useCallback, useEffect, useRef, useState } from 'react'
import type { TransferProgress } from '@shared/types'
import { MAX_CONCURRENT_STORAGE_KEY, loadStoredMaxConcurrent } from '../lib/storage'
import { applyDownloadEvent } from '../lib/transfers'

interface UseTransfersOptions {
  refreshCurrent: () => Promise<boolean>
  getCwd: () => string
}

interface UseTransfersResult {
  transfers: TransferProgress[]
  maxConcurrent: number
  retryingIds: ReadonlySet<string>
  retryErrors: Readonly<Record<string, string>>
  handleRetryDownload: (id: string) => Promise<void>
  handleMaxConcurrentChange: (max: number) => void
  handleCancelDownload: (id: string) => void
  handleRemoveDownload: (id: string) => Promise<void>
  handleClearFinished: () => Promise<void>
  handleClearAll: () => Promise<void>
}

function isRetryEligible(transfer: TransferProgress): boolean {
  return (
    transfer.direction !== 'upload' &&
    transfer.status === 'error' &&
    transfer.retryable === true &&
    !transfer.retriedAs
  )
}

export function useTransfers({ refreshCurrent, getCwd }: UseTransfersOptions): UseTransfersResult {
  const [transfers, setTransfers] = useState<TransferProgress[]>([])
  const [maxConcurrent, setMaxConcurrent] = useState<number>(loadStoredMaxConcurrent)
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<string>>(new Set())
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({})
  const retryingRef = useRef(new Set<string>())
  const transfersRef = useRef<TransferProgress[]>([])
  const removedIdsRef = useRef(new Set<string>())
  const resetRevisionRef = useRef(0)
  const mountedRef = useRef(true)

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearRetryError = useCallback((id: string) => {
    setRetryErrors((prev) => {
      if (!Object.hasOwn(prev, id)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [])

  useEffect(() => {
    return window.api.onDownloadUpdate((ev) => {
      if (ev.type === 'reset') {
        resetRevisionRef.current += 1
        removedIdsRef.current.clear()
        setRetryErrors({})
      } else if (ev.type === 'remove') {
        if (retryingRef.current.size > 0) removedIdsRef.current.add(ev.id)
        clearRetryError(ev.id)
      } else if (!isRetryEligible(ev.transfer)) {
        clearRetryError(ev.transfer.id)
      }
      transfersRef.current = applyDownloadEvent(transfersRef.current, ev)
      setTransfers(transfersRef.current)
      if (ev.type !== 'update') return
      const update = ev.transfer
      if (update.direction === 'upload' && update.status === 'completed') {
        const uploadDir = update.uploadRemoteDir
        const cwdNorm = getCwd().replace(/^\/+/, '')
        if (uploadDir !== undefined && uploadDir === cwdNorm) {
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
          refreshTimerRef.current = setTimeout(() => {
            refreshTimerRef.current = null
            if (getCwd().replace(/^\/+/, '') === uploadDir) void refreshCurrent()
          }, 600)
        }
      }
    })
  }, [refreshCurrent, getCwd, clearRetryError])

  useEffect(() => {
    window.api.setMaxConcurrentDownloads(maxConcurrent).catch(() => undefined)
  }, [maxConcurrent])

  const handleMaxConcurrentChange = useCallback((max: number) => {
    localStorage.setItem(MAX_CONCURRENT_STORAGE_KEY, String(max))
    setMaxConcurrent(max)
  }, [])

  const handleCancelDownload = useCallback((id: string) => {
    window.api.cancelDownload(id).catch(() => undefined)
  }, [])

  const handleRetryDownload = useCallback(
    async (id: string) => {
      if (retryingRef.current.has(id)) return
      retryingRef.current.add(id)
      setRetryingIds(new Set(retryingRef.current))
      clearRetryError(id)
      const revision = resetRevisionRef.current
      try {
        const successor = await window.api.retryDownload(id)
        if (
          mountedRef.current &&
          resetRevisionRef.current === revision &&
          !removedIdsRef.current.has(successor.id) &&
          transfersRef.current.some((t) => t.id === id) &&
          !transfersRef.current.some((t) => t.id === successor.id)
        ) {
          transfersRef.current = [...transfersRef.current, successor]
          setTransfers(transfersRef.current)
        }
      } catch (err) {
        if (
          mountedRef.current &&
          resetRevisionRef.current === revision &&
          !removedIdsRef.current.has(id) &&
          transfersRef.current.some((t) => t.id === id && isRetryEligible(t))
        ) {
          const message = err instanceof Error ? err.message : String(err)
          setRetryErrors((prev) => ({ ...prev, [id]: message }))
        }
      } finally {
        retryingRef.current.delete(id)
        if (retryingRef.current.size === 0) removedIdsRef.current.clear()
        if (mountedRef.current) setRetryingIds(new Set(retryingRef.current))
      }
    },
    [clearRetryError]
  )

  const handleRemoveDownload = useCallback(
    async (id: string) => {
      try {
        const removed = await window.api.removeDownload(id)
        if (removed) {
          if (retryingRef.current.size > 0) removedIdsRef.current.add(id)
          clearRetryError(id)
          transfersRef.current = transfersRef.current.filter((t) => t.id !== id)
          setTransfers(transfersRef.current)
        }
      } catch {
        // ignore: leave the transfer list as-is if the removal request fails
      }
    },
    [clearRetryError]
  )

  const handleClearFinished = useCallback(async () => {
    await window.api.clearFinishedDownloads().catch(() => undefined)
  }, [])

  const handleClearAll = useCallback(async () => {
    await window.api.clearAllDownloads().catch(() => undefined)
  }, [])

  return {
    transfers,
    maxConcurrent,
    retryingIds,
    retryErrors,
    handleRetryDownload,
    handleMaxConcurrentChange,
    handleCancelDownload,
    handleRemoveDownload,
    handleClearFinished,
    handleClearAll
  }
}
