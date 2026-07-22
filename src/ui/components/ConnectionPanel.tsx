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

  return (
    <section className="panel connection">
      <div className="connection__row connection__saved">
        <label className="field field--grow">
          <span>Saved sites</span>
          <select
            value={selectedProfileId}
            disabled={disabled || profiles.length === 0}
            onChange={(e) => onSelectProfile(e.target.value)}
          >
            <option value="">
              {profiles.length === 0 ? 'No saved sites yet' : 'New connection…'}
            </option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.hasSecret ? ' 🔒' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="saved-actions">
          <label className="remember">
            <input
              type="checkbox"
              checked={rememberSecret}
              disabled={connecting}
              onChange={(e) => onRememberSecretChange(e.target.checked)}
            />
            Remember password
          </label>
          <button type="button" className="btn" disabled={!canSave} onClick={onSaveProfile}>
            Save
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={!selectedProfileId || connecting}
            onClick={onDeleteProfile}
          >
            Delete
          </button>
        </div>
      </div>

      <div className="connection__row">
        <label className="field field--grow">
          <span>Host</span>
          <input
            value={form.host}
            disabled={disabled}
            placeholder="sftp.example.com"
            onChange={(e) => onFormChange({ host: e.target.value })}
          />
        </label>
        <label className="field field--port">
          <span>Port</span>
          <input
            value={form.port}
            disabled={disabled}
            inputMode="numeric"
            onChange={(e) => onFormChange({ port: e.target.value })}
          />
        </label>
        <label className="field field--grow">
          <span>Username</span>
          <input
            value={form.username}
            disabled={disabled}
            placeholder="user"
            onChange={(e) => onFormChange({ username: e.target.value })}
          />
        </label>
      </div>

      <div className="connection__row">
        <label className="field">
          <span>Auth</span>
          <select
            value={form.authMethod}
            disabled={disabled}
            onChange={(e) => onFormChange({ authMethod: e.target.value as AuthMethod })}
          >
            {(Object.keys(AUTH_LABELS) as AuthMethod[]).map((method) => (
              <option key={method} value={method}>
                {AUTH_LABELS[method]}
              </option>
            ))}
          </select>
        </label>

        {form.authMethod === 'password' && (
          <label className="field field--grow">
            <span>Password</span>
            <input
              type="password"
              value={form.password}
              disabled={disabled}
              onChange={(e) => onFormChange({ password: e.target.value })}
            />
          </label>
        )}

        {form.authMethod === 'privateKey' && (
          <>
            <label className="field field--grow">
              <span>Private key path</span>
              <input
                value={form.privateKeyPath}
                disabled={disabled}
                placeholder="~/.ssh/id_ed25519"
                onChange={(e) => onFormChange({ privateKeyPath: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Passphrase</span>
              <input
                type="password"
                value={form.passphrase}
                disabled={disabled}
                onChange={(e) => onFormChange({ passphrase: e.target.value })}
              />
            </label>
          </>
        )}
      </div>

      <div className="connection__row connection__row--settings">
        <label className="field field--segments">
          <span>Segments</span>
          <input
            type="number"
            min={1}
            max={16}
            value={segments}
            onChange={(e) => onSegmentsChange(clampSegments(e.target.value))}
          />
        </label>
        <label className="field field--grow">
          <span>Download folder</span>
          <div className="dir-picker">
            <input
              value={downloadDir}
              placeholder="Server download folder (or subfolder)"
              onChange={(e) => onDownloadDirChange(e.target.value)}
            />
            <button type="button" className="btn" onClick={onBrowseServer}>
              Choose…
            </button>
          </div>
        </label>
        <div className="connection__actions">
          {connected ? (
            <button type="button" className="btn btn--danger" onClick={onDisconnect}>
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canConnect}
              onClick={onConnect}
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      {error && <p className="banner banner--error">{error}</p>}
    </section>
  )
}

function clampSegments(value: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(16, n))
}
