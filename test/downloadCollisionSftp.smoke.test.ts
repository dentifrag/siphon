import { spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { DownloadAdmission, DownloadPlan } from '../src/shared/api'
import type { RouteContext } from '../src/server/context'
import type { ServerConfig } from '../src/server/config'
import { validateDownloadDestination } from '../src/server/localFs'
import { RcloneClient } from '../src/server/rclone/client'
import { RcloneDownloadManager } from '../src/server/rclone/downloadManager'
import type { RcloneSupervisor } from '../src/server/rclone/supervisor'
import { registerDownloadRoutes } from '../src/server/routes/downloads'
import { ConnectionSession } from '../src/server/session'
import type { Services } from '../src/server/services'

async function port(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback port.')
  const selected = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return selected
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

describe.skipIf(process.env.SIPHON_RCLONE_SMOKE !== '1')(
  'isolated real rclone SFTP collision smoke',
  () => {
    it('copies fresh bytes for matching metadata, preserves overwrite recovery and rejects a target created after submission', async () => {
      const root = await mkdtemp(join(process.cwd(), '.collision-sftp-smoke-'))
      const source = join(root, 'source')
      const output = join(root, 'output')
      const children: ChildProcess[] = []
      const app = Fastify()
      let logs = ''
      let manager: RcloneDownloadManager | undefined
      try {
        await mkdir(source)
        await mkdir(output)
        const configPath = join(root, 'rclone.conf')
        const keyPath = join(root, 'host-key.pem')
        await writeFile(configPath, '')
        const key = generateKeyPairSync('ed25519', {
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' }
        })
        await writeFile(keyPath, key.privateKey, { mode: 0o600 })
        const password = randomUUID()
        const sftpPort = await port()
        let rcPort = await port()
        while (rcPort === sftpPort) rcPort = await port()
        const common = [
          '--config',
          configPath,
          '--cache-dir',
          join(root, 'cache'),
          '--log-level',
          'ERROR'
        ]
        const start = (args: string[]) => {
          const child = spawn(process.env.SIPHON_RCLONE_BIN ?? 'rclone', args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          })
          children.push(child)
          child.stdout?.on('data', (chunk) => {
            logs += String(chunk)
          })
          child.stderr?.on('data', (chunk) => {
            logs += String(chunk)
          })
          child.on('error', (error) => {
            logs += error.message
          })
          return child
        }
        const sftp = start([
          'serve',
          'sftp',
          source,
          '--addr',
          `127.0.0.1:${sftpPort}`,
          '--key',
          keyPath,
          '--user',
          'smoke',
          '--pass',
          password,
          '--read-only',
          '--dir-cache-time',
          '0s',
          ...common
        ])
        start([
          'rcd',
          '--rc-addr',
          `127.0.0.1:${rcPort}`,
          '--rc-user',
          'smoke',
          '--rc-pass',
          password,
          ...common
        ])
        const client = new RcloneClient({
          getEndpoint: () => ({
            baseUrl: `http://127.0.0.1:${rcPort}`,
            authHeader: `Basic ${Buffer.from(`smoke:${password}`).toString('base64')}`
          })
        } as RcloneSupervisor)
        await vi.waitFor(
          async () => {
            try {
              await client.noop()
            } catch (error) {
              throw new Error(`${String(error)}\n${logs}`)
            }
          },
          { timeout: 15_000 }
        )
        await vi.waitFor(
          async () => {
            if (sftp.exitCode !== null) throw new Error(`SFTP smoke server exited: ${logs}`)
            await new Promise<void>((resolve, reject) => {
              const socket = createConnection({ host: '127.0.0.1', port: sftpPort })
              socket.once('connect', () => {
                socket.destroy()
                resolve()
              })
              socket.once('error', (error) => {
                socket.destroy()
                reject(new Error(`${error.message}\n${logs}`))
              })
            })
          },
          { timeout: 15_000 }
        )
        const scope = { roots: [{ name: 'Smoke', path: output }], confined: true }
        manager = new RcloneDownloadManager(
          client,
          (input) => validateDownloadDestination(scope, input),
          () => {}
        )
        const services = { client, manager } as Services
        const session = new ConnectionSession(services)
        await vi.waitFor(
          async () => {
            try {
              return await session.connect({
                config: {
                  host: '127.0.0.1',
                  port: sftpPort,
                  username: 'smoke',
                  authMethod: 'password',
                  password
                }
              })
            } catch (error) {
              throw new Error(`${String(error)}\n${logs}`)
            }
          },
          { timeout: 15_000 }
        )
        registerDownloadRoutes(app, {
          config: { ...scope, defaultDir: output } as ServerConfig,
          services,
          session
        } as RouteContext)
        const submit = async (remotePath: string, overwrite = false) => {
          const preview = await app.inject({
            method: 'POST',
            url: '/api/download/plan',
            payload: {
              remotePaths: [remotePath],
              downloadDir: output,
              segments: 4,
              connectionRevision: session.status().connectionRevision
            }
          })
          expect(preview.statusCode, `${preview.body}\n${logs}`).toBe(200)
          const plan = preview.json<DownloadPlan>()
          expect(plan.conflicts).toHaveLength(overwrite ? 1 : 0)
          const response = await app.inject({
            method: 'POST',
            url: '/api/download/commit',
            payload: {
              planId: plan.id,
              decisions: overwrite ? { [plan.conflicts[0].entryId]: 'overwrite' } : {}
            }
          })
          expect(response.statusCode, response.body).toBe(200)
          return response.json<DownloadAdmission>().transfers[0].id
        }
        const finish = async (id: string, status: 'completed' | 'error') => {
          await vi.waitFor(
            () =>
              expect(manager!.list().find((transfer) => transfer.id === id)?.status, logs).toBe(
                status
              ),
            { timeout: 20_000 }
          )
          return manager!.list().find((transfer) => transfer.id === id)!
        }

        const timestamp = new Date('2026-01-01T00:00:00Z')
        await writeFile(join(source, 'overwrite.bin'), 'new payload!')
        await writeFile(join(output, 'overwrite.bin'), 'old payload!')
        await utimes(join(source, 'overwrite.bin'), timestamp, timestamp)
        await utimes(join(output, 'overwrite.bin'), timestamp, timestamp)
        const overwrite = await finish(await submit('/overwrite.bin', true), 'completed')
        expect(await readFile(join(output, 'overwrite.bin'), 'utf8')).toBe('new payload!')
        expect(await readFile(overwrite.recoveryPath!, 'utf8')).toBe('old payload!')
        expect(overwrite.transferred).toBe(overwrite.size)

        await writeFile(join(source, 'new.bin'), 'new file')
        await finish(await submit('/new.bin'), 'completed')
        expect(await readFile(join(output, 'new.bin'), 'utf8')).toBe('new file')
        await writeFile(join(source, 'empty.bin'), '')
        const empty = await finish(await submit('/empty.bin'), 'completed')
        expect(empty).toMatchObject({ size: 0, transferred: 0 })

        await writeFile(join(source, 'late.bin'), Buffer.alloc(8 * 1024 * 1024, 0x5a))
        const copy = client.copyFileAsync.bind(client)
        vi.spyOn(client, 'copyFileAsync').mockImplementationOnce(async (input) => {
          const id = await copy(input)
          await writeFile(join(output, 'late.bin'), 'late external content')
          return id
        })
        const late = await finish(await submit('/late.bin'), 'error')
        expect(late.errorCode).toBe('DESTINATION_CHANGED')
        expect(await readFile(join(output, 'late.bin'), 'utf8')).toBe('late external content')
      } finally {
        manager?.clearAll()
        try {
          await app.close()
        } finally {
          // Stop the exact owned backends before removing any fixture staging.
          await Promise.all(children.map(stop))
          if (manager) {
            await vi.waitFor(
              () => expect(manager!.list().some((t) => t.status === 'downloading')).toBe(false),
              { timeout: 6000 }
            )
          }
          await rm(root, { recursive: true, force: true })
          vi.restoreAllMocks()
        }
      }
    }, 90_000)
  }
)
