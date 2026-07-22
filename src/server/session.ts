import type { ConnectionConfig } from '../shared/types'
import { httpError } from './http'
import type { Services } from './services'
import { sftpParameters } from './rclone/remotes'

const SESSION_REMOTE = '_session'

export class ConnectionSession {
  private current: string | null = null
  private ephemeral = false

  constructor(private readonly services: Services) {}

  get connected(): boolean {
    return this.current !== null
  }

  remoteFs(): string {
    if (!this.current) throw httpError(400, 'Not connected to a server.')
    return `${this.current}:`
  }

  async connect(input: { config?: ConnectionConfig; profileId?: string }): Promise<void> {
    const { client, remotes, manager } = this.services
    manager.cancelAll()
    await this.teardown()

    if (input.profileId) {
      const remoteName = await remotes.remoteNameFor(input.profileId)
      if (!remoteName) throw httpError(400, 'Saved connection not found.')
      this.current = remoteName
      this.ephemeral = false
    } else if (input.config) {
      const cfg = input.config
      await client.createRemote(
        SESSION_REMOTE,
        'sftp',
        sftpParameters({
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          authMethod: cfg.authMethod,
          password: cfg.password,
          privateKeyPath: cfg.privateKeyPath,
          passphrase: cfg.passphrase
        })
      )
      this.current = SESSION_REMOTE
      this.ephemeral = true
    } else {
      throw httpError(400, 'A connection or saved site is required.')
    }

    try {
      await client.list(this.remoteFs(), '')
    } catch (err) {
      await this.teardown()
      throw httpError(400, err instanceof Error ? err.message : 'Could not connect.')
    }
  }

  async disconnect(): Promise<void> {
    this.services.manager.cancelAll()
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    if (this.ephemeral && this.current) {
      await this.services.client.deleteRemote(this.current).catch(() => undefined)
    }
    this.ephemeral = false
    this.current = null
  }
}
