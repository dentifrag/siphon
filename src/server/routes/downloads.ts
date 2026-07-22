import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DownloadEnqueueInput } from '../../shared/api'
import type { RouteContext } from '../context'
import { httpError } from '../http'
import { resolvePath, type FsScope } from '../localFs'
import { safeBaseName, uiToRemotePath } from '../mapping'

export function registerDownloadRoutes(
  app: FastifyInstance,
  { config, services, session }: RouteContext
): void {
  const { client, manager } = services
  const scope: FsScope = { roots: config.roots, confined: config.confined }

  app.post('/api/download', async (req) => {
    const input = req.body as DownloadEnqueueInput
    const fs = session.remoteFs()
    const srcRemote = uiToRemotePath(input.remotePath)
    const item = await client.stat(fs, srcRemote)
    if (!item) throw httpError(404, 'File not found.')
    if (item.IsDir) throw httpError(400, 'Folder downloads are not supported yet. Select a file.')

    const requested = input.downloadDir?.trim()
    const targetDir = (requested ? await resolvePath(scope, requested) : null) ?? config.defaultDir
    const fileName = safeBaseName(input.remotePath)
    return manager.enqueue({
      srcFs: fs,
      srcRemote,
      dstFs: targetDir,
      dstRemote: fileName,
      displayName: input.remotePath,
      localPath: join(targetDir, fileName),
      size: item.Size < 0 ? 0 : item.Size,
      segments: input.segments
    })
  })

  app.post('/api/download/cancel', async (req) => {
    manager.cancel((req.body as { id: string }).id)
    return { ok: true }
  })

  app.post('/api/downloads/cancel-all', async () => {
    manager.cancelAll()
    return { ok: true }
  })

  app.post('/api/downloads/clear-finished', async () => {
    manager.clearFinished()
    return { ok: true }
  })

  app.get('/api/downloads', async () => manager.list())

  app.get('/api/events', (req, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    raw.write('retry: 3000\n\n')
    const send = (payload: unknown): void => {
      raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    for (const transfer of manager.list()) send(transfer)
    const unsubscribe = manager.onUpdate(send)
    const ping = setInterval(() => raw.write(': ping\n\n'), 25000)
    req.raw.on('close', () => {
      clearInterval(ping)
      unsubscribe()
    })
  })
}
