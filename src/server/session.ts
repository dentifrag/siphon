import { randomUUID } from 'node:crypto'
import type { SessionStatus } from '../shared/api'
import type { ConnectionConfig } from '../shared/types'
import { httpError } from './http'
import type { Services } from './services'
import { sftpParameters } from './rclone/remotes'

const SESSION_REMOTE = '_session'

export interface ConnectionBinding {
  readonly remoteName: string
  readonly revision: string
  readonly fs: string
}

export class ConnectionSession {
  private current: ConnectionBinding | null = null
  private ephemeral = false
  private ownership: Promise<void> = Promise.resolve()

  constructor(private readonly services: Services) {}

  get connected(): boolean {
    return this.current !== null
  }

  status(): SessionStatus {
    return {
      connected: this.connected,
      remoteName: this.current?.remoteName ?? null,
      connectionRevision: this.current?.revision ?? null
    }
  }

  bind(expectedRevision?: string): ConnectionBinding {
    if (expectedRevision !== undefined && this.current?.revision !== expectedRevision) {
      throw httpError(409, 'The connection changed. Reconnect before continuing.')
    }
    if (!this.current) throw httpError(400, 'Not connected to a server.')
    return this.current
  }

  assertCurrent(binding: ConnectionBinding): void {
    this.bind(binding.revision)
  }

  connect(input: { config?: ConnectionConfig; profileId?: string }): Promise<string> {
    return this.withOwnership(async () => {
      const { client, remotes } = this.services
      await this.teardown()
      let remoteName: string
      let ephemeral = false

      if (input.profileId) {
        const savedName = await remotes.remoteNameFor(input.profileId)
        if (!savedName) throw httpError(400, 'Saved connection not found.')
        remoteName = savedName
      } else if (input.config) {
        remoteName = SESSION_REMOTE
        ephemeral = true
      } else {
        throw httpError(400, 'A connection or saved site is required.')
      }

      try {
        if (ephemeral && input.config) {
          await client.createRemote(remoteName, 'sftp', sftpParameters(input.config))
        }
        await client.checkConnection(`${remoteName}:`)
      } catch (err) {
        if (ephemeral) await client.deleteRemote(remoteName)
        throw httpError(400, err instanceof Error ? err.message : 'Could not connect.')
      }

      const revision = randomUUID()
      this.current = Object.freeze({ remoteName, revision, fs: `${remoteName}:` })
      this.ephemeral = ephemeral
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
    const ephemeral = this.ephemeral
    this.ephemeral = false
    this.current = null
    if (ephemeral && previous) {
      await this.services.client.deleteRemote(previous.remoteName)
    }
  }
}
