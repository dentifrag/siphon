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
  refreshCurrent: () => Promise<boolean>
  getCwd: () => string
  beginConnectionChange: () => void
  attachConnection: (home: string, connectionRevision: string) => Promise<boolean>
  resetForDisconnect: () => void
  enqueue: (remotePath: string) => Promise<void>
  handleDownloadSelected: () => Promise<void>
  handleUploadSelected: (localPaths: string[]) => Promise<void>
  prepareUpload: () => (localPaths: string[]) => Promise<void>
}

interface BrowserView {
  cwd: string
  revision: string
  lifetime: number
  navigation: number
}

type NavigationResult = 'success' | 'failed' | 'conflict' | 'superseded' | 'disconnected'
type BatchResult = 'continue' | 'abort'

const CONNECTION_CONFLICT = 'The connection changed. Reconnect before continuing.'

function isConnectionConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (('status' in error && error.status === 409) ||
      ('statusCode' in error && error.statusCode === 409))
  )
}

export function useBrowser({
  downloadDir,
  segments,
  onStatusConnected
}: UseBrowserOptions): UseBrowserResult {
  const [listing, setListing] = useState<{
    view: BrowserView | null
    entries: RemoteEntry[]
  }>({ view: null, entries: [] })
  const cwd = listing.view?.cwd ?? '/'
  const { entries } = listing
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const revisionRef = useRef<string | null>(null)
  const lifetimeRef = useRef(0)
  const navigationRef = useRef(0)
  const pendingNavigationRef = useRef<number | null>(null)
  const viewRef = useRef<BrowserView | null>(null)
  const optionsRef = useRef({ downloadDir, segments, onStatusConnected })
  optionsRef.current = { downloadDir, segments, onStatusConnected }

  const getCwd = useCallback(() => viewRef.current?.cwd ?? '/', [])

  const beginConnectionChange = useCallback(() => {
    revisionRef.current = null
    lifetimeRef.current += 1
    navigationRef.current += 1
    pendingNavigationRef.current = null
    viewRef.current = null
    setListing({ view: null, entries: [] })
    setSelected(new Set())
    setBrowseLoading(false)
    setBrowseError(null)
  }, [])

  const navigate = useCallback(async (dir: string): Promise<NavigationResult> => {
    const revision = revisionRef.current
    if (!revision) return 'disconnected'
    const lifetime = lifetimeRef.current
    const navigation = ++navigationRef.current
    pendingNavigationRef.current = navigation
    const ownsRequest = (): boolean =>
      revisionRef.current === revision &&
      lifetimeRef.current === lifetime &&
      navigationRef.current === navigation
    setBrowseLoading(true)
    setBrowseError(null)
    setSelected(new Set())
    try {
      const list = await window.api.list(dir, revision)
      if (!ownsRequest()) return 'superseded'
      const view = { cwd: dir, revision, lifetime, navigation }
      viewRef.current = view
      setListing({ view, entries: list })
      localStorage.setItem('siphon.cwd', dir)
      return 'success'
    } catch (error) {
      if (!ownsRequest()) return 'superseded'
      const conflict = isConnectionConflict(error)
      setBrowseError(conflict ? CONNECTION_CONFLICT : errorMessage(error))
      return conflict ? 'conflict' : 'failed'
    } finally {
      if (ownsRequest()) {
        pendingNavigationRef.current = null
        setBrowseLoading(false)
      }
    }
  }, [])

  const navigateTo = useCallback(
    async (dir: string): Promise<boolean> => (await navigate(dir)) === 'success',
    [navigate]
  )

  const refreshCurrent = useCallback(async (): Promise<boolean> => {
    const view = viewRef.current
    if (
      !view ||
      pendingNavigationRef.current !== null ||
      revisionRef.current !== view.revision ||
      lifetimeRef.current !== view.lifetime
    ) {
      return false
    }
    return navigateTo(view.cwd)
  }, [navigateTo])

  const attachConnection = useCallback(
    async (home: string, connectionRevision: string): Promise<boolean> => {
      beginConnectionChange()
      revisionRef.current = connectionRevision
      return navigateTo(home)
    },
    [beginConnectionChange, navigateTo]
  )

  useEffect(() => {
    const lifetime = lifetimeRef.current
    window.api
      .status()
      .then(async (status) => {
        if (lifetimeRef.current !== lifetime) return
        if (!status.connected || !status.connectionRevision) return
        revisionRef.current = status.connectionRevision
        optionsRef.current.onStatusConnected()
        const storedCwd = localStorage.getItem('siphon.cwd') || '/'
        const restoreNavigation = navigationRef.current + 1
        const result = await navigate(storedCwd)
        if (
          result === 'failed' &&
          lifetimeRef.current === lifetime &&
          navigationRef.current === restoreNavigation
        ) {
          await navigate('/')
        }
      })
      .catch((error: unknown) => {
        if (lifetimeRef.current === lifetime) setBrowseError(errorMessage(error))
      })
    return () => {
      lifetimeRef.current += 1
      navigationRef.current += 1
      pendingNavigationRef.current = null
      revisionRef.current = null
      viewRef.current = null
    }
  }, [navigate])

  const ownsConnection = useCallback(
    (view: BrowserView): boolean =>
      revisionRef.current === view.revision && lifetimeRef.current === view.lifetime,
    []
  )

  const reportTransferError = useCallback(
    (view: BrowserView, error: unknown) => {
      if (!ownsConnection(view)) return
      if (isConnectionConflict(error)) {
        setBrowseError(CONNECTION_CONFLICT)
      } else if (viewRef.current === view && navigationRef.current === view.navigation) {
        setBrowseError(errorMessage(error))
      }
    },
    [ownsConnection]
  )

  const download = useCallback(
    async (
      view: BrowserView,
      remotePath: string,
      destination: string,
      segmentCount: number
    ): Promise<BatchResult> => {
      if (!ownsConnection(view)) return 'abort'
      if (!destination) {
        if (viewRef.current === view && navigationRef.current === view.navigation) {
          setBrowseError('Choose a download folder first.')
        }
        return 'abort'
      }
      try {
        const enqueued = await window.api.enqueueDownload({
          remotePath,
          downloadDir: destination,
          segments: segmentCount,
          connectionRevision: view.revision
        })
        if (!ownsConnection(view)) return 'abort'
        if (
          enqueued.length === 0 &&
          viewRef.current === view &&
          navigationRef.current === view.navigation
        ) {
          setBrowseError('That folder has no files to download.')
        }
        return 'continue'
      } catch (error) {
        reportTransferError(view, error)
        return isConnectionConflict(error) || !ownsConnection(view) ? 'abort' : 'continue'
      }
    },
    [ownsConnection, reportTransferError]
  )

  const enqueue = useCallback(
    async (remotePath: string) => {
      const view = listing.view
      if (!view) return
      const settings = optionsRef.current
      await download(view, remotePath, settings.downloadDir, settings.segments)
    },
    [download, listing.view]
  )

  const handleDownloadSelected = useCallback(async () => {
    const view = listing.view
    if (!view) return
    const settings = optionsRef.current
    const targets = entries.filter((entry) => selected.has(entry.path))
    for (const entry of targets) {
      if ((await download(view, entry.path, settings.downloadDir, settings.segments)) === 'abort')
        break
    }
    if (
      ownsConnection(view) &&
      viewRef.current === view &&
      navigationRef.current === view.navigation
    ) {
      setSelected(new Set())
    }
  }, [entries, selected, download, ownsConnection, listing.view])

  const prepareUpload = useCallback(() => {
    const view = listing.view
    return async (localPaths: string[]): Promise<void> => {
      if (!view) return
      for (const localPath of localPaths) {
        if (!ownsConnection(view)) break
        try {
          const enqueued = await window.api.enqueueUpload({
            localPath,
            remoteDir: view.cwd,
            connectionRevision: view.revision
          })
          if (!ownsConnection(view)) break
          if (
            enqueued.length === 0 &&
            viewRef.current === view &&
            navigationRef.current === view.navigation
          ) {
            setBrowseError('That folder has no files to upload.')
          }
        } catch (error) {
          reportTransferError(view, error)
          if (isConnectionConflict(error) || !ownsConnection(view)) break
        }
      }
    }
  }, [ownsConnection, reportTransferError, listing.view])

  const handleUploadSelected = useCallback(
    (localPaths: string[]) => prepareUpload()(localPaths),
    [prepareUpload]
  )

  return {
    cwd,
    entries,
    browseLoading,
    browseError,
    selected,
    setSelected,
    navigateTo,
    refreshCurrent,
    getCwd,
    beginConnectionChange,
    attachConnection,
    resetForDisconnect: beginConnectionChange,
    enqueue,
    handleDownloadSelected,
    handleUploadSelected,
    prepareUpload
  }
}
