import { randomUUID } from 'node:crypto'
import type { ConnectionIdentity, SessionStatus } from '../shared/api'
import type { ConnectionConfig } from '../shared/types'
import { httpError } from './http'
import type { Services } from './services'
import { SESSION_REMOTE_PREFIX, sftpParameters } from './rclone/remotes'

export interface ConnectionBinding {
  readonly remoteName: string
  readonly revision: string
  readonly fs: string
}

interface ActiveConnection extends ConnectionBinding {
  readonly identity: ConnectionIdentity
}

export class ConnectionSession {
  private current: ActiveConnection | null = null
  private ownership: Promise<void> = Promise.resolve()

  constructor(private readonly services: Services) {}

  get connected(): boolean {
    return this.current !== null
  }

  status(): SessionStatus {
    return {
      connected: this.connected,
      remoteName: this.current?.remoteName ?? null,
      connectionRevision: this.current?.revision ?? null,
      connection: this.current?.identity ?? null
    }
  }

  bind(expectedRevision?: string): ConnectionBinding {
    if (expectedRevision !== undefined && this.current?.revision !== expectedRevision) {
      throw httpError(
        409,
        'The connection changed. Reconnect before continuing.',
        'CONNECTION_CHANGED'
      )
    }
    if (!this.current) throw httpError(400, 'Not connected to a server.')
    return this.current
  }

  assertCurrent(binding: ConnectionBinding): void {
    this.bind(binding.revision)
  }

  connect(input: {
    config?: ConnectionConfig
    profileId?: string
    secret?: string
  }): Promise<string> {
    return this.withOwnership(async () => {
      const { client, remotes } = this.services
      await this.teardown()
      if (!input.profileId && !input.config) {
        throw httpError(400, 'A connection or saved site is required.')
      }
      // Every session owns a private remote, so saving or deleting a saved site never changes it.
      const remoteName = `${SESSION_REMOTE_PREFIX}${randomUUID()}`
      let identity: ConnectionIdentity

      try {
        if (input.profileId) {
          const cloned = await remotes.cloneForSession(input.profileId, remoteName, input.secret)
          if (!cloned) throw httpError(400, 'Saved connection not found.')
          identity = cloned
        } else if (input.config) {
          const { config } = input
          await client.createRemote(remoteName, 'sftp', sftpParameters(config))
          identity = {
            host: config.host,
            port: config.port,
            username: config.username,
            authMethod: config.authMethod,
            privateKeyPath: config.authMethod === 'privateKey' ? config.privateKeyPath : undefined
          }
        } else {
          throw httpError(400, 'A connection or saved site is required.')
        }
        await client.checkConnection(`${remoteName}:`)
      } catch (err) {
        try {
          await client.deleteRemote(remoteName)
        } catch {}
        if (err instanceof Error && 'statusCode' in err) throw err
        throw httpError(400, err instanceof Error ? err.message : 'Could not connect.')
      }

      const revision = randomUUID()
      this.current = Object.freeze({ remoteName, revision, fs: `${remoteName}:`, identity })
      return revision
    })
  }

  disconnect(): Promise<void> {
    return this.withOwnership(() => this.teardown())
  }

  acquireJobRemote(
    prefix: '_dl-' | '_ul-',
    expectedRevision: string
  ): Promise<ConnectionBinding & { release: () => Promise<void> }> {
    return this.withOwnership(async () => {
      const binding = this.bind(expectedRevision)
      const remoteName = `${prefix}${randomUUID()}`
      const { client } = this.services
      try {
        await client.cloneRemote(binding.remoteName, remoteName)
      } catch (error) {
        await client.deleteRemote(remoteName)
        throw error
      }
      return {
        remoteName,
        revision: binding.revision,
        fs: `${remoteName}:`,
        release: () => client.deleteRemote(remoteName)
      }
    })
  }

  private withOwnership<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.ownership.then(operation)
    this.ownership = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async teardown(): Promise<void> {
    const previous = this.current
    this.current = null
    if (previous) await this.services.client.deleteRemote(previous.remoteName)
  }
}
