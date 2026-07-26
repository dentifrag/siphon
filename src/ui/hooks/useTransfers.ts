import { useCallback, useEffect, useRef, useState } from 'react'
import type { TransferProgress } from '@shared/types'
import { MAX_CONCURRENT_STORAGE_KEY, loadStoredMaxConcurrent } from '../lib/storage'
import { applyDownloadEvent } from '../lib/transfers'

interface UseTransfersOptions {
  navigateTo: (dir: string) => Promise<boolean>
  getCwd: () => string
}

interface UseTransfersResult {
  transfers: TransferProgress[]
  maxConcurrent: number
  handleMaxConcurrentChange: (max: number) => void
  handleCancelDownload: (id: string) => void
  handleRemoveDownload: (id: string) => Promise<void>
  handleClearFinished: () => Promise<void>
  handleClearAll: () => Promise<void>
}

export function useTransfers({ navigateTo, getCwd }: UseTransfersOptions): UseTransfersResult {
  const [transfers, setTransfers] = useState<TransferProgress[]>([])
  const [maxConcurrent, setMaxConcurrent] = useState<number>(loadStoredMaxConcurrent)

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [])

  useEffect(() => {
    window.api
      .listDownloads()
      .then(setTransfers)
      .catch(() => undefined)

    return window.api.onDownloadUpdate((ev) => {
      setTransfers((prev) => applyDownloadEvent(prev, ev))
      if (ev.type !== 'update') return
      const update = ev.transfer
      if (update.direction === 'upload' && update.status === 'completed') {
        const uploadDir = update.uploadRemoteDir
        const cwdNorm = getCwd().replace(/^\/+/, '')
        if (uploadDir !== undefined && uploadDir === cwdNorm) {
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
          refreshTimerRef.current = setTimeout(() => {
            refreshTimerRef.current = null
            if (getCwd().replace(/^\/+/, '') === uploadDir) navigateTo(getCwd())
          }, 600)
        }
      }
    })
  }, [navigateTo, getCwd])

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

  const handleRemoveDownload = useCallback(async (id: string) => {
    try {
      const removed = await window.api.removeDownload(id)
      if (removed) setTransfers((prev) => prev.filter((t) => t.id !== id))
    } catch {
      // ignore: leave the transfer list as-is if the removal request fails
    }
  }, [])

  const handleClearFinished = useCallback(async () => {
    await window.api.clearFinishedDownloads().catch(() => undefined)
  }, [])

  const handleClearAll = useCallback(async () => {
    await window.api.clearAllDownloads().catch(() => undefined)
  }, [])

  return {
    transfers,
    maxConcurrent,
    handleMaxConcurrentChange,
    handleCancelDownload,
    handleRemoveDownload,
    handleClearFinished,
    handleClearAll
  }
}
