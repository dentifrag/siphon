import type { AuthMethod, ConnectionConfig } from '@shared/types'

export interface ConnectionForm {
  host: string
  port: string
  username: string
  authMethod: AuthMethod
  password: string
  privateKeyPath: string
  passphrase: string
}

export const defaultConnectionForm: ConnectionForm = {
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: ''
}

export function toConnectionConfig(form: ConnectionForm): ConnectionConfig {
  const port = Number.parseInt(form.port, 10)
  return {
    host: form.host.trim(),
    port: Number.isFinite(port) && port > 0 ? port : 22,
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.authMethod === 'password' ? form.password : undefined,
    privateKeyPath:
      form.authMethod === 'privateKey' ? form.privateKeyPath.trim() : undefined,
    passphrase:
      form.authMethod === 'privateKey' && form.passphrase ? form.passphrase : undefined
  }
}
