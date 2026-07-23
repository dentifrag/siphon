import { useState } from 'react'
import { Button, Checkbox, FormControl, Select, TextInput } from '@primer/react'
import { ChevronDownIcon, ChevronUpIcon } from '@primer/octicons-react'
import type { AuthMethod } from '@shared/types'
import type { ConnectionProfileMeta } from '@shared/api'
import type { ConnectionForm } from '../lib/types'

type ConnState = 'disconnected' | 'connecting' | 'connected'

interface ConnectionPanelProps {
  form: ConnectionForm
  onFormChange: (patch: Partial<ConnectionForm>) => void
  connState: ConnState
  onConnect: () => void
  onDisconnect: () => void
  error: string | null
  segments: number
  onSegmentsChange: (segments: number) => void
  downloadDir: string
  onBrowseServer: () => void
  onDownloadDirChange: (value: string) => void
  profiles: ConnectionProfileMeta[]
  selectedProfileId: string
  onSelectProfile: (id: string) => void
  onSaveProfile: () => void
  onDeleteProfile: () => void
  rememberSecret: boolean
  onRememberSecretChange: (value: boolean) => void
}

const AUTH_LABELS: Record<AuthMethod, string> = {
  password: 'Password',
  privateKey: 'Private key'
}

export function ConnectionPanel(props: ConnectionPanelProps) {
  const {
    form,
    onFormChange,
    connState,
    onConnect,
    onDisconnect,
    error,
    segments,
    onSegmentsChange,
    downloadDir,
    onBrowseServer,
    onDownloadDirChange,
    profiles,
    selectedProfileId,
    onSelectProfile,
    onSaveProfile,
    onDeleteProfile,
    rememberSecret,
    onRememberSecretChange
  } = props

  const connected = connState === 'connected'
  const connecting = connState === 'connecting'
  const disabled = connected || connecting
  const canConnect = form.host.trim() !== '' && form.username.trim() !== '' && !connecting
  const canSave = form.host.trim() !== '' && form.username.trim() !== '' && !connecting
  const [detailsOpen, setDetailsOpen] = useState(false)

  const sectionClass = ['panel', 'connection', connected ? 'connection--connected' : '']
    .filter(Boolean)
    .join(' ')

  const credentials = (
    <div className="connection__credentials" id="connection-details" hidden={connected && !detailsOpen}>
      <div className="connection__row connection__saved">
        <FormControl className="form-field form-field--grow" disabled={disabled || profiles.length === 0}>
          <FormControl.Label className="form-field__label">Saved sites</FormControl.Label>
          <Select
            block
            value={selectedProfileId}
            onChange={(e) => onSelectProfile(e.target.value)}
          >
            <Select.Option value="">
              {profiles.length === 0 ? 'No saved sites yet' : 'New connection…'}
            </Select.Option>
            {profiles.map((profile) => (
              <Select.Option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.hasSecret ? ' 🔒' : ''}
              </Select.Option>
            ))}
          </Select>
        </FormControl>
        <div className="saved-actions">
          <FormControl className="remember" disabled={connecting}>
            <Checkbox
              checked={rememberSecret}
              onChange={(e) => onRememberSecretChange(e.target.checked)}
            />
            <FormControl.Label className="remember-label">Remember password</FormControl.Label>
          </FormControl>
          <Button variant="default" disabled={!canSave} onClick={onSaveProfile}>
            Save
          </Button>
          <Button
            variant="danger"
            disabled={!selectedProfileId || connecting}
            onClick={onDeleteProfile}
          >
            Delete
          </Button>
        </div>
      </div>

      <div className="connection__row">
        <FormControl className="form-field form-field--grow" disabled={disabled}>
          <FormControl.Label className="form-field__label">Host</FormControl.Label>
          <TextInput
            block
            value={form.host}
            placeholder="sftp.example.com"
            onChange={(e) => onFormChange({ host: e.target.value })}
          />
        </FormControl>
        <FormControl className="form-field form-field--port" disabled={disabled}>
          <FormControl.Label className="form-field__label">Port</FormControl.Label>
          <TextInput
            block
            value={form.port}
            inputMode="numeric"
            onChange={(e) => onFormChange({ port: e.target.value })}
          />
        </FormControl>
        <FormControl className="form-field form-field--grow" disabled={disabled}>
          <FormControl.Label className="form-field__label">Username</FormControl.Label>
          <TextInput
            block
            value={form.username}
            placeholder="user"
            onChange={(e) => onFormChange({ username: e.target.value })}
          />
        </FormControl>
      </div>

      <div className="connection__row">
        <FormControl className="form-field" disabled={disabled}>
          <FormControl.Label className="form-field__label">Auth</FormControl.Label>
          <Select
            block
            value={form.authMethod}
            onChange={(e) => onFormChange({ authMethod: e.target.value as AuthMethod })}
          >
            {(Object.keys(AUTH_LABELS) as AuthMethod[]).map((method) => (
              <Select.Option key={method} value={method}>
                {AUTH_LABELS[method]}
              </Select.Option>
            ))}
          </Select>
        </FormControl>

        {form.authMethod === 'password' && (
          <FormControl className="form-field form-field--grow" disabled={disabled}>
            <FormControl.Label className="form-field__label">Password</FormControl.Label>
            <TextInput
              block
              type="password"
              value={form.password}
              onChange={(e) => onFormChange({ password: e.target.value })}
            />
          </FormControl>
        )}

        {form.authMethod === 'privateKey' && (
          <>
            <FormControl className="form-field form-field--grow" disabled={disabled}>
              <FormControl.Label className="form-field__label">Private key path</FormControl.Label>
              <TextInput
                block
                value={form.privateKeyPath}
                placeholder="~/.ssh/id_ed25519"
                onChange={(e) => onFormChange({ privateKeyPath: e.target.value })}
              />
            </FormControl>
            <FormControl className="form-field" disabled={disabled}>
              <FormControl.Label className="form-field__label">Passphrase</FormControl.Label>
              <TextInput
                block
                type="password"
                value={form.passphrase}
                onChange={(e) => onFormChange({ passphrase: e.target.value })}
              />
            </FormControl>
          </>
        )}
      </div>
    </div>
  )

  const sessionSettings = (
    <>
      <FormControl className="form-field form-field--segments">
        <FormControl.Label className="form-field__label">Segments</FormControl.Label>
        <TextInput
          block
          type="number"
          min={1}
          max={16}
          value={segments}
          onChange={(e) => onSegmentsChange(clampSegments(e.target.value))}
        />
      </FormControl>
      <div className="form-field form-field--grow">
        <label className="form-field__label" htmlFor="download-dir">
          Download folder
        </label>
        <div className="dir-picker">
          <TextInput
            id="download-dir"
            className="dir-picker__input"
            block
            value={downloadDir}
            placeholder="Server download folder (or subfolder)"
            onChange={(e) => onDownloadDirChange(e.target.value)}
          />
          <Button variant="default" onClick={onBrowseServer}>
            Choose…
          </Button>
        </div>
      </div>
    </>
  )

  return (
    <section className={sectionClass}>
      {connected ? (
        <>
          <div className="connection__row connection__bar">
            <Button
              variant="invisible"
              className="connection__toggle"
              aria-expanded={detailsOpen}
              aria-controls="connection-details"
              trailingVisual={detailsOpen ? ChevronUpIcon : ChevronDownIcon}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              <span className="connection__bar-id">{form.host.trim() || 'Connected'}</span>
            </Button>
            {sessionSettings}
            <div className="connection__actions">
              <Button variant="danger" onClick={onDisconnect}>
                Disconnect
              </Button>
            </div>
          </div>
          {credentials}
        </>
      ) : (
        <>
          {credentials}
          <div className="connection__row connection__row--settings connection__settings">
            {sessionSettings}
            <div className="connection__actions">
              <Button
                variant="primary"
                disabled={!canConnect}
                onClick={onConnect}
              >
                {connecting ? 'Connecting…' : 'Connect'}
              </Button>
            </div>
          </div>
        </>
      )}

      {error && <p className="banner banner--error">{error}</p>}
    </section>
  )
}

function clampSegments(value: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(16, n))
}
