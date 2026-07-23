import { useCallback, useEffect, useState } from 'react'
import type { RemoteEntry, TransferProgress } from '@shared/types'
import type { ConnectionProfileMeta, SaveProfileInput } from '@shared/api'
import { ConnectionPanel } from './components/ConnectionPanel'
import { RemoteBrowser } from './components/RemoteBrowser'
import { TransferQueue } from './components/TransferQueue'
import { FolderPicker } from './components/FolderPicker'
import { defaultConnectionForm, toConnectionConfig, type ConnectionForm } from './lib/types'
import { errorMessage } from './lib/format'

type ConnState = 'disconnected' | 'connecting' | 'connected'

const MAX_CONCURRENT_STORAGE_KEY = 'siphon.maxConcurrentDownloads'

function loadStoredMaxConcurrent(): number {
  const stored = Number.parseInt(localStorage.getItem(MAX_CONCURRENT_STORAGE_KEY) ?? '', 10)
  if (!Number.isFinite(stored)) return 3
  return Math.max(1, Math.min(8, stored))
}

export default function App() {
  const [form, setForm] = useState<ConnectionForm>(defaultConnectionForm)
  const [segments, setSegments] = useState(4)
  const [downloadDir, setDownloadDir] = useState('')

  const [connState, setConnState] = useState<ConnState>('disconnected')
  const [connError, setConnError] = useState<string | null>(null)

  const [cwd, setCwd] = useState('/')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [transfers, setTransfers] = useState<TransferProgress[]>([])
  const [maxConcurrent, setMaxConcurrent] = useState<number>(loadStoredMaxConcurrent)

  const [profiles, setProfiles] = useState<ConnectionProfileMeta[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [rememberSecret, setRememberSecret] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    window.api
      .defaultDownloadDir()
      .then((dir) => setDownloadDir((current) => current || dir))
      .catch(() => undefined)
    window.api.listDownloads().then(setTransfers).catch(() => undefined)
    window.api.listProfiles().then(setProfiles).catch(() => undefined)

    return window.api.onDownloadUpdate((ev) => {
      if (ev.type === 'reset') {
        setTransfers(ev.transfers)
        return
      }
      if (ev.type === 'remove') {
        setTransfers((prev) => prev.filter((t) => t.id !== ev.id))
        return
      }
      const update = ev.transfer
      setTransfers((prev) => {
        const index = prev.findIndex((t) => t.id === update.id)
        if (index === -1) return [...prev, update]
        const next = prev.slice()
        next[index] = update
        return next
      })
    })
  }, [])

  useEffect(() => {
    window.api.setMaxConcurrentDownloads(maxConcurrent).catch(() => undefined)
  }, [maxConcurrent])

  const navigateTo = useCallback(async (dir: string) => {
    setBrowseLoading(true)
    setBrowseError(null)
    setSelected(new Set())
    try {
      const list = await window.api.list(dir)
      setCwd(dir)
      setEntries(list)
    } catch (error) {
      setBrowseError(errorMessage(error))
    } finally {
      setBrowseLoading(false)
    }
  }, [])

  const handleConnect = useCallback(async () => {
    setConnState('connecting')
    setConnError(null)
    try {
      const result = await window.api.connect(
        toConnectionConfig(form),
        selectedProfileId || undefined
      )
      setConnState('connected')
      await navigateTo(result.home || '/')
    } catch (error) {
      setConnState('disconnected')
      setConnError(errorMessage(error))
    }
  }, [form, navigateTo, selectedProfileId])

  const handleDisconnect = useCallback(async () => {
    try {
      await window.api.disconnect()
    } finally {
      setConnState('disconnected')
      setEntries([])
      setCwd('/')
      setSelected(new Set())
      setBrowseError(null)
    }
  }, [])

  const handleSelectProfile = useCallback(async (id: string) => {
    setSelectedProfileId(id)
    if (!id) return
    const resolved = await window.api.resolveProfile(id)
    if (!resolved) return
    setForm({
      host: resolved.host,
      port: String(resolved.port),
      username: resolved.username,
      authMethod: resolved.authMethod,
      password: '',
      privateKeyPath: resolved.privateKeyPath ?? '',
      passphrase: ''
    })
    setSegments(resolved.segments)
    if (resolved.downloadDir) setDownloadDir(resolved.downloadDir)
    setConnError(null)
  }, [])

  const handleSaveProfile = useCallback(async () => {
    const secret = form.authMethod === 'password' ? form.password : form.passphrase
    const input: SaveProfileInput = {
      name: `${form.username.trim()}@${form.host.trim()}`,
      host: form.host.trim(),
      port: Number.parseInt(form.port, 10) || 22,
      username: form.username.trim(),
      authMethod: form.authMethod,
      privateKeyPath: form.authMethod === 'privateKey' ? form.privateKeyPath.trim() : undefined,
      secret: secret || undefined,
      rememberSecret,
      segments,
      downloadDir
    }
    const updated = await window.api.saveProfile(input)
    setProfiles(updated)
    const saved = updated.find((profile) => profile.name === input.name)
    if (saved) setSelectedProfileId(saved.id)
  }, [form, rememberSecret, segments, downloadDir])

  const handleDeleteProfile = useCallback(async () => {
    if (!selectedProfileId) return
    const updated = await window.api.deleteProfile(selectedProfileId)
    setProfiles(updated)
    setSelectedProfileId('')
  }, [selectedProfileId])

  const enqueue = useCallback(
    async (remotePath: string) => {
      if (!downloadDir) {
        setBrowseError('Choose a download folder first.')
        return
      }
      try {
        await window.api.enqueueDownload({ remotePath, downloadDir, segments })
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

  const handleClearFinished = useCallback(async () => {
    await window.api.clearFinishedDownloads()
  }, [])

  const handleClearAll = useCallback(async () => {
    await window.api.clearAllDownloads()
  }, [])

  const handleRemoveDownload = useCallback(async (id: string) => {
    const removed = await window.api.removeDownload(id)
    if (removed) setTransfers((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const handleMaxConcurrentChange = useCallback((max: number) => {
    localStorage.setItem(MAX_CONCURRENT_STORAGE_KEY, String(max))
    setMaxConcurrent(max)
  }, [])

  const connected = connState === 'connected'

  return (
    <div className="app">
      <header className="app__bar">
        <h1>Siphon</h1>
        <span className="app__tag">a web UI for rclone</span>
      </header>

      <ConnectionPanel
        form={form}
        onFormChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        connState={connState}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        error={connError}
        segments={segments}
        onSegmentsChange={setSegments}
        downloadDir={downloadDir}
        onBrowseServer={() => setPickerOpen(true)}
        onDownloadDirChange={setDownloadDir}
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        onSelectProfile={handleSelectProfile}
        onSaveProfile={handleSaveProfile}
        onDeleteProfile={handleDeleteProfile}
        rememberSecret={rememberSecret}
        onRememberSecretChange={setRememberSecret}
      />

      <div className="workspace">
        <RemoteBrowser
          connected={connected}
          cwd={cwd}
          entries={entries}
          loading={browseLoading}
          error={browseError}
          selected={selected}
          canDownload={downloadDir !== ''}
          suspended={pickerOpen}
          onNavigate={navigateTo}
          onRefresh={() => navigateTo(cwd)}
          onSelectionChange={setSelected}
          onDownloadSelected={handleDownloadSelected}
          onDownloadEntry={(entry) => enqueue(entry.path)}
        />

        <TransferQueue
          transfers={transfers}
          maxConcurrent={maxConcurrent}
          onMaxConcurrentChange={handleMaxConcurrentChange}
          onCancel={(id) => window.api.cancelDownload(id)}
          onRemove={handleRemoveDownload}
          onClearFinished={handleClearFinished}
          onClearAll={handleClearAll}
        />
      </div>

      {pickerOpen && (
        <FolderPicker
          initialPath={downloadDir}
          onClose={() => setPickerOpen(false)}
          onChoose={(path) => {
            setDownloadDir(path)
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}
