import { useCallback, useEffect, useState } from 'react'
import type { ConnectionProfileMeta, SaveProfileInput } from '@shared/api'
import { defaultConnectionForm, toConnectionConfig, type ConnectionForm } from '../lib/types'
import { errorMessage } from '../lib/format'
import {
  CONNECTION_STORAGE_KEY,
  parseStoredConnection,
  type StoredConnection
} from '../lib/storage'

type ConnState = 'disconnected' | 'connecting' | 'connected'

interface UseConnectionOptions {
  segments: number
  downloadDir: string
  onSegmentsChange: (segments: number) => void
  onDownloadDirChange: (dir: string) => void
  /** Called after a successful connect, with the server-reported home dir. Does not own navigation. */
  onConnected: (home: string) => Promise<boolean>
  /** Called after disconnect (success or failure) so the browser can reset its own state. */
  onDisconnected: () => void
}

interface UseConnectionResult {
  form: ConnectionForm
  onFormChange: (patch: Partial<ConnectionForm>) => void
  connState: ConnState
  connError: string | null
  profiles: ConnectionProfileMeta[]
  selectedProfileId: string
  rememberSecret: boolean
  onRememberSecretChange: (value: boolean) => void
  handleConnect: () => Promise<void>
  handleDisconnect: () => Promise<void>
  handleSelectProfile: (id: string) => Promise<void>
  handleSaveProfile: () => Promise<void>
  handleDeleteProfile: () => Promise<void>
  /** Restores connState + the persisted form/profile selection from localStorage. */
  restoreConnection: () => void
}

export function useConnection({
  segments,
  downloadDir,
  onSegmentsChange,
  onDownloadDirChange,
  onConnected,
  onDisconnected
}: UseConnectionOptions): UseConnectionResult {
  const [form, setForm] = useState<ConnectionForm>(defaultConnectionForm)
  const [connState, setConnState] = useState<ConnState>('disconnected')
  const [connError, setConnError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<ConnectionProfileMeta[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [rememberSecret, setRememberSecret] = useState(true)

  useEffect(() => {
    window.api
      .listProfiles()
      .then(setProfiles)
      .catch(() => undefined)
  }, [])

  const onFormChange = useCallback((patch: Partial<ConnectionForm>) => {
    setForm((prev) => ({ ...prev, ...patch }))
  }, [])

  const restoreConnection = useCallback(() => {
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
  }, [])

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
      await onConnected(result.home || '/')
    } catch (error) {
      setConnState('disconnected')
      setConnError(errorMessage(error))
      return
    }
    if (!storagePayload) return
    try {
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(storagePayload))
    } catch {}
  }, [form, onConnected, profiles, selectedProfileId])

  const handleDisconnect = useCallback(async () => {
    try {
      await window.api.disconnect()
    } catch {
      // ignore: we still reset local state below regardless of server-side outcome
    }
    try {
      localStorage.removeItem(CONNECTION_STORAGE_KEY)
    } catch {}
    setConnState('disconnected')
    onDisconnected()
  }, [onDisconnected])

  const handleSelectProfile = useCallback(
    async (id: string) => {
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
      onSegmentsChange(resolved.segments)
      if (resolved.downloadDir) onDownloadDirChange(resolved.downloadDir)
      setConnError(null)
    },
    [onSegmentsChange, onDownloadDirChange]
  )

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

  return {
    form,
    onFormChange,
    connState,
    connError,
    profiles,
    selectedProfileId,
    rememberSecret,
    onRememberSecretChange: setRememberSecret,
    handleConnect,
    handleDisconnect,
    handleSelectProfile,
    handleSaveProfile,
    handleDeleteProfile,
    restoreConnection
  }
}
