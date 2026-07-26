import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteEntry } from '@shared/types'
import { errorMessage } from '../lib/format'

interface UseBrowserOptions {
  downloadDir: string
  segments: number
  onStatusConnected: () => void
}

interface UseBrowserResult {
  cwd: string
  entries: RemoteEntry[]
  browseLoading: boolean
  browseError: string | null
  selected: Set<string>
  setSelected: (next: Set<string>) => void
  navigateTo: (dir: string) => Promise<boolean>
  getCwd: () => string
  resetForDisconnect: () => void
  enqueue: (remotePath: string) => Promise<void>
  handleDownloadSelected: () => Promise<void>
  handleUploadSelected: (localPaths: string[]) => Promise<void>
}

export function useBrowser({
  downloadDir,
  segments,
  onStatusConnected
}: UseBrowserOptions): UseBrowserResult {
  const [cwd, setCwd] = useState('/')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const cwdRef = useRef(cwd)
  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])

  const getCwd = useCallback(() => cwdRef.current, [])

  const navigateTo = useCallback(async (dir: string): Promise<boolean> => {
    setBrowseLoading(true)
    setBrowseError(null)
    setSelected(new Set())
    try {
      const list = await window.api.list(dir)
      setCwd(dir)
      setEntries(list)
      localStorage.setItem('siphon.cwd', dir)
      return true
    } catch (error) {
      setBrowseError(errorMessage(error))
      return false
    } finally {
      setBrowseLoading(false)
    }
  }, [])

  useEffect(() => {
    window.api
      .status()
      .then(async (status) => {
        if (!status.connected) return
        onStatusConnected()
        const storedCwd = localStorage.getItem('siphon.cwd') || '/'
        const ok = await navigateTo(storedCwd)
        if (!ok) await navigateTo('/')
      })
      .catch(() => undefined)
  }, [navigateTo, onStatusConnected])

  const resetForDisconnect = useCallback(() => {
    setEntries([])
    setCwd('/')
    setSelected(new Set())
    setBrowseError(null)
  }, [])

  const enqueue = useCallback(
    async (remotePath: string) => {
      if (!downloadDir) {
        setBrowseError('Choose a download folder first.')
        return
      }
      try {
        const enqueued = await window.api.enqueueDownload({ remotePath, downloadDir, segments })
        if (enqueued.length === 0) {
          setBrowseError('That folder has no files to download.')
        }
      } catch (error) {
        setBrowseError(errorMessage(error))
      }
    },
    [downloadDir, segments]
  )

  const handleDownloadSelected = useCallback(async () => {
    const targets = entries.filter((entry) => selected.has(entry.path))
    for (const entry of targets) {
      await enqueue(entry.path)
    }
    setSelected(new Set())
  }, [entries, selected, enqueue])

  const handleUploadSelected = useCallback(
    async (localPaths: string[]) => {
      const destDir = cwd
      for (const localPath of localPaths) {
        try {
          const enqueued = await window.api.enqueueUpload({
            localPath,
            remoteDir: destDir
          })
          if (enqueued.length === 0) {
            setBrowseError('That folder has no files to upload.')
          }
        } catch (error) {
          setBrowseError(errorMessage(error))
        }
      }
    },
    [cwd]
  )

  return {
    cwd,
    entries,
    browseLoading,
    browseError,
    selected,
    setSelected,
    navigateTo,
    getCwd,
    resetForDisconnect,
    enqueue,
    handleDownloadSelected,
    handleUploadSelected
  }
}
