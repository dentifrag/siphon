import { useCallback, useEffect, useRef, useState } from 'react'
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
  onConnected: (home: string, connectionRevision: string) => Promise<boolean>
  onConnectionChange?: () => void
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
  requiresPasswordReentry: boolean
  onRememberSecretChange: (value: boolean) => void
  handleConnect: () => Promise<void>
  handleDisconnect: () => Promise<void>
  handleSelectProfile: (id: string) => Promise<void>
  handleSaveProfile: () => Promise<void>
  handleDeleteProfile: () => Promise<void>
  restoreConnection: () => void
}

export function useConnection({
  segments,
  downloadDir,
  onSegmentsChange,
  onDownloadDirChange,
  onConnected,
  onConnectionChange,
  onDisconnected
}: UseConnectionOptions): UseConnectionResult {
  const [form, setForm] = useState<ConnectionForm>(defaultConnectionForm)
  const [connState, setConnState] = useState<ConnState>('disconnected')
  const [connError, setConnError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<ConnectionProfileMeta[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [rememberSecret, setRememberSecret] = useState(true)
  const [formFromProfile, setFormFromProfile] = useState(false)
  const selectedProfileRef = useRef('')
  const profileRequestRef = useRef(0)
  const lifecycleRef = useRef(0)
  const formRef = useRef(form)
  formRef.current = form

  const selectProfile = useCallback((id: string) => {
    selectedProfileRef.current = id
    setSelectedProfileId(id)
  }, [])

  const requiresPasswordReentry =
    formFromProfile && !selectedProfileId && form.authMethod === 'password' && !form.password

  useEffect(() => {
    return () => {
      profileRequestRef.current += 1
      lifecycleRef.current += 1
    }
  }, [])

  useEffect(() => {
    window.api
      .listProfiles()
      .then(setProfiles)
      .catch(() => undefined)
  }, [])

  const onFormChange = useCallback(
    (patch: Partial<ConnectionForm>) => {
      if (Object.keys(patch).length === 0) return
      profileRequestRef.current += 1
      if (selectedProfileRef.current) setFormFromProfile(true)
      selectProfile('')
      const next = { ...formRef.current, ...patch }
      formRef.current = next
      setForm(next)
      setConnError(null)
    },
    [selectProfile]
  )

  const restoreConnection = useCallback(() => {
    profileRequestRef.current += 1
    setConnState('connected')
    try {
      const raw = localStorage.getItem(CONNECTION_STORAGE_KEY)
      if (raw) {
        const saved = parseStoredConnection(raw)
        if (saved) {
          const next = {
            ...formRef.current,
            host: saved.host,
            port: saved.port,
            username: saved.username,
            authMethod: saved.authMethod,
            privateKeyPath: saved.privateKeyPath,
            password: '',
            passphrase: ''
          }
          formRef.current = next
          setForm(next)
          setFormFromProfile(Boolean(saved.profileId))
          selectProfile(saved.profileId)
        }
      }
    } catch {
      // ignore malformed stored connection
    }
  }, [selectProfile])

  const handleConnect = useCallback(async () => {
    profileRequestRef.current += 1
    if (requiresPasswordReentry) {
      setConnError('Re-enter the password to use this saved site as a manual connection.')
      return
    }
    const lifecycle = ++lifecycleRef.current
    onConnectionChange?.()
    setConnState('connecting')
    setConnError(null)
    let storagePayload: StoredConnection | null = null
    try {
      const result = await window.api.connect(
        toConnectionConfig(form),
        selectedProfileId || undefined
      )
      if (lifecycleRef.current !== lifecycle) return
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
      await onConnected(result.home || '/', result.connectionRevision)
    } catch (error) {
      if (lifecycleRef.current !== lifecycle) return
      setConnState('disconnected')
      setConnError(errorMessage(error))
      return
    }
    if (!storagePayload || lifecycleRef.current !== lifecycle) return
    try {
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(storagePayload))
    } catch {}
  }, [form, onConnected, onConnectionChange, profiles, selectedProfileId, requiresPasswordReentry])

  const handleDisconnect = useCallback(async () => {
    profileRequestRef.current += 1
    const lifecycle = ++lifecycleRef.current
    onConnectionChange?.()
    setConnState('disconnected')
    setConnError(null)
    onDisconnected()
    try {
      await window.api.disconnect()
    } catch (error) {
      if (lifecycleRef.current === lifecycle) setConnError(errorMessage(error))
    }
    if (lifecycleRef.current !== lifecycle) return
    try {
      localStorage.removeItem(CONNECTION_STORAGE_KEY)
    } catch {}
  }, [onConnectionChange, onDisconnected])

  const handleSelectProfile = useCallback(
    async (id: string) => {
      const request = ++profileRequestRef.current
      selectProfile(id)
      if (!id) return
      try {
        const resolved = await window.api.resolveProfile(id)
        if (profileRequestRef.current !== request) return
        if (!resolved) {
          setConnError('Saved connection not found.')
          return
        }
        const next = {
          host: resolved.host,
          port: String(resolved.port),
          username: resolved.username,
          authMethod: resolved.authMethod,
          password: '',
          privateKeyPath: resolved.privateKeyPath ?? '',
          passphrase: ''
        }
        formRef.current = next
        setForm(next)
        setFormFromProfile(true)
        onSegmentsChange(resolved.segments)
        if (resolved.downloadDir) onDownloadDirChange(resolved.downloadDir)
        setConnError(null)
      } catch (error) {
        if (profileRequestRef.current === request) setConnError(errorMessage(error))
      }
    },
    [onSegmentsChange, onDownloadDirChange, selectProfile]
  )

  const handleSaveProfile = useCallback(async () => {
    const request = ++profileRequestRef.current
    if (requiresPasswordReentry) {
      setConnError('Re-enter the password to use this saved site as a manual connection.')
      return
    }
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
    try {
      const updated = await window.api.saveProfile(input)
      if (profileRequestRef.current !== request) return
      setProfiles(updated)
      const saved = updated.find((profile) => profile.name === input.name)
      if (saved) {
        selectProfile(saved.id)
        setFormFromProfile(true)
      }
    } catch (error) {
      if (profileRequestRef.current === request) setConnError(errorMessage(error))
    }
  }, [form, rememberSecret, segments, downloadDir, requiresPasswordReentry, selectProfile])

  const handleDeleteProfile = useCallback(async () => {
    if (!selectedProfileId) return
    const request = ++profileRequestRef.current
    try {
      const updated = await window.api.deleteProfile(selectedProfileId)
      if (profileRequestRef.current !== request) return
      setProfiles(updated)
      selectProfile('')
    } catch (error) {
      if (profileRequestRef.current === request) setConnError(errorMessage(error))
    }
  }, [selectedProfileId, selectProfile])

  return {
    form,
    onFormChange,
    connState,
    connError,
    profiles,
    selectedProfileId,
    rememberSecret,
    requiresPasswordReentry,
    onRememberSecretChange: setRememberSecret,
    handleConnect,
    handleDisconnect,
    handleSelectProfile,
    handleSaveProfile,
    handleDeleteProfile,
    restoreConnection
  }
}
