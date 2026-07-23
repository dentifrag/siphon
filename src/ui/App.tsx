import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dialog, FormControl, SegmentedControl, TextInput } from '@primer/react'
import type { RemoteEntry, TransferProgress } from '@shared/types'
import type { ConnectionProfileMeta, SaveProfileInput } from '@shared/api'
import { ConnectionPanel } from './components/ConnectionPanel'
import { RemoteBrowser } from './components/RemoteBrowser'
import { TransferQueue } from './components/TransferQueue'
import { FolderPicker } from './components/FolderPicker'
import { defaultConnectionForm, toConnectionConfig, type ConnectionForm } from './lib/types'
import { errorMessage } from './lib/format'

type ConnState = 'disconnected' | 'connecting' | 'connected'
type StoredConnection = {
  host: string
  port: string
  username: string
  authMethod: ConnectionForm['authMethod']
  privateKeyPath: string
  profileId: string
}

const MAX_CONCURRENT_STORAGE_KEY = 'siphon.maxConcurrentDownloads'
const CONNECTION_STORAGE_KEY = 'siphon.connection'

function loadStoredMaxConcurrent(): number {
  const stored = Number.parseInt(localStorage.getItem(MAX_CONCURRENT_STORAGE_KEY) ?? '', 10)
  if (!Number.isFinite(stored)) return 3
  return Math.max(1, Math.min(8, stored))
}

function parseStoredConnection(raw: string): StoredConnection | null {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') return null
  const saved = parsed as Record<string, unknown>
  if (
    typeof saved.host !== 'string' ||
    typeof saved.port !== 'string' ||
    typeof saved.username !== 'string' ||
    (saved.authMethod !== 'password' && saved.authMethod !== 'privateKey') ||
    typeof saved.privateKeyPath !== 'string' ||
    typeof saved.profileId !== 'string'
  ) {
    return null
  }
  return {
    host: saved.host,
    port: saved.port,
    username: saved.username,
    authMethod: saved.authMethod,
    privateKeyPath: saved.privateKeyPath,
    profileId: saved.profileId
  }
}

interface AppProps {
  canChangePassword: boolean
}

export default function App({ canChangePassword }: AppProps) {
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
  const [pickerMode, setPickerMode] = useState<'chooseDir' | 'chooseItems'>('chooseDir')
  const [mobileTab, setMobileTab] = useState<'files' | 'transfers'>('files')
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)

  const cwdRef = useRef(cwd)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const navigateToRef = useRef<(dir: string) => Promise<boolean>>(async () => false)

  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [])

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

      if (update.direction === 'upload' && update.status === 'completed') {
        const uploadDir = update.uploadRemoteDir
        // Server-normalized uploadRemoteDir (uiToRemotePath) strips leading slashes; match that here.
        const cwdNorm = cwdRef.current.replace(/^\/+/, '')
        if (uploadDir !== undefined && uploadDir === cwdNorm) {
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
          refreshTimerRef.current = setTimeout(() => {
            refreshTimerRef.current = null
            if (cwdRef.current.replace(/^\/+/, '') === uploadDir) navigateToRef.current(cwdRef.current)
          }, 600)
        }
      }
    })
  }, [])

  useEffect(() => {
    window.api.setMaxConcurrentDownloads(maxConcurrent).catch(() => undefined)
  }, [maxConcurrent])

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
    navigateToRef.current = navigateTo
  }, [navigateTo])

  useEffect(() => {
    window.api
      .status()
      .then(async (status) => {
        if (!status.connected) return
        setConnState('connected')
        try {
          const raw = localStorage.getItem(CONNECTION_STORAGE_KEY)
          if (raw) {
            const saved = parseStoredConnection(raw)
            if (saved) {
              setForm((prev) => ({
                ...prev,
                host: saved.host,
                port: saved.port,
                username: saved.username,
                authMethod: saved.authMethod,
                privateKeyPath: saved.privateKeyPath
              }))
              setSelectedProfileId(saved.profileId)
            }
          }
        } catch {
          // ignore malformed stored connection
        }
        const storedCwd = localStorage.getItem('siphon.cwd') || '/'
        const ok = await navigateTo(storedCwd)
        if (!ok) await navigateTo('/')
      })
      .catch(() => undefined)
  }, [navigateTo])

  const handleConnect = useCallback(async () => {
    setConnState('connecting')
    setConnError(null)
    let storagePayload: StoredConnection | null = null
    try {
      const result = await window.api.connect(
        toConnectionConfig(form),
        selectedProfileId || undefined
      )
      setConnState('connected')
      const selectedProfile = selectedProfileId
        ? profiles.find((profile) => profile.id === selectedProfileId)
        : null
      storagePayload = selectedProfile
        ? {
            host: selectedProfile.host,
            port: String(selectedProfile.port),
            username: selectedProfile.username,
            authMethod: selectedProfile.authMethod,
            privateKeyPath: selectedProfile.privateKeyPath ?? '',
            profileId: selectedProfile.id
          }
        : {
            host: form.host,
            port: form.port,
            username: form.username,
            authMethod: form.authMethod,
            privateKeyPath: form.privateKeyPath,
            profileId: ''
          }
      await navigateTo(result.home || '/')
    } catch (error) {
      setConnState('disconnected')
      setConnError(errorMessage(error))
      return
    }
    if (!storagePayload) return
    try {
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(storagePayload))
    } catch {}
  }, [form, navigateTo, profiles, selectedProfileId])

  const handleDisconnect = useCallback(async () => {
    try {
      await window.api.disconnect()
    } finally {
      localStorage.removeItem(CONNECTION_STORAGE_KEY)
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
      setPickerOpen(false)
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

  const closePasswordDialog = useCallback(() => {
    setPasswordDialogOpen(false)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmNewPassword('')
    setPasswordError(null)
    setPasswordSubmitting(false)
  }, [])

  const submitPasswordChange = useCallback(async () => {
    if (newPassword.length < 8 || newPassword.length > 256) {
      setPasswordError('New password must be 8 to 256 characters.')
      return
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('New passwords do not match.')
      return
    }
    setPasswordSubmitting(true)
    setPasswordError(null)
    try {
      await window.api.changePassword(currentPassword, newPassword)
      closePasswordDialog()
      setPasswordNotice('Password updated.')
      window.setTimeout(() => setPasswordNotice(null), 3_000)
    } catch (error) {
      setPasswordError(errorMessage(error))
      setPasswordSubmitting(false)
    }
  }, [closePasswordDialog, confirmNewPassword, currentPassword, newPassword])

  return (
    <div className={connected ? 'app app--connected' : 'app'}>
      <header className="app__bar">
        <h1>Siphon</h1>
        <div className="app__bar-actions">
          {passwordNotice && <span className="app__notice">{passwordNotice}</span>}
          {canChangePassword && (
            <Button size="small" variant="default" onClick={() => setPasswordDialogOpen(true)}>
              Change password
            </Button>
          )}
        </div>
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
        onBrowseServer={() => {
          setPickerMode('chooseDir')
          setPickerOpen(true)
        }}
        onDownloadDirChange={setDownloadDir}
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        onSelectProfile={handleSelectProfile}
        onSaveProfile={handleSaveProfile}
        onDeleteProfile={handleDeleteProfile}
        rememberSecret={rememberSecret}
        onRememberSecretChange={setRememberSecret}
      />

      <nav className="mobile-tabs">
        <SegmentedControl
          aria-label="View"
          fullWidth
          onChange={(index) => setMobileTab(index === 0 ? 'files' : 'transfers')}
        >
          <SegmentedControl.Button selected={mobileTab === 'files'}>Files</SegmentedControl.Button>
          <SegmentedControl.Button
            selected={mobileTab === 'transfers'}
            count={transfers.length || undefined}
          >
            Transfers
          </SegmentedControl.Button>
        </SegmentedControl>
      </nav>

      <div className={`workspace workspace--${mobileTab}`}>
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
          onUpload={() => {
            setPickerMode('chooseItems')
            setPickerOpen(true)
          }}
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
          mode={pickerMode}
          onClose={() => setPickerOpen(false)}
          onChoose={(paths) => {
            if (pickerMode === 'chooseItems') {
              void handleUploadSelected(paths)
              return
            }
            setDownloadDir(paths[0])
            setPickerOpen(false)
          }}
        />
      )}

      {passwordDialogOpen && (
        <Dialog
          title="Change password"
          onClose={closePasswordDialog}
          footerButtons={[
            { content: 'Cancel', disabled: passwordSubmitting, onClick: closePasswordDialog },
            {
              content: passwordSubmitting ? 'Saving…' : 'Update password',
              buttonType: 'primary',
              disabled: passwordSubmitting,
              onClick: () => void submitPasswordChange()
            }
          ]}
        >
          <div className="password-dialog">
            <FormControl>
              <FormControl.Label>Current password</FormControl.Label>
              <TextInput
                block
                type="password"
                aria-label="Current password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormControl.Label>New password</FormControl.Label>
              <TextInput
                block
                type="password"
                aria-label="New password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormControl.Label>Confirm new password</FormControl.Label>
              <TextInput
                block
                type="password"
                aria-label="Confirm new password"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
              />
            </FormControl>
            {passwordError && <p className="banner banner--error">{passwordError}</p>}
          </div>
        </Dialog>
      )}
    </div>
  )
}
