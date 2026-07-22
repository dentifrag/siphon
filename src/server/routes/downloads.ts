import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
    const srcRemote = uiToRemotePath(input.remotePath)
    const item = await client.stat(session.remoteFs(), srcRemote)
    if (!item) throw httpError(404, 'File not found.')

    const requested = input.downloadDir?.trim()
    let targetDir = config.defaultDir
    if (requested) {
      const resolved = await resolvePath(scope, requested)
      if (!resolved) throw httpError(400, 'That download folder is not accessible.')
      targetDir = resolved
    }
    const baseName = safeBaseName(input.remotePath)

    const jobRemote = `_dl-${randomUUID()}`
    await client.cloneRemote(session.remoteName(), jobRemote)

    if (item.IsDir) {
      const localPath = join(targetDir, baseName)
      return manager.enqueue({
        kind: 'directory',
        srcFs: srcRemote ? `${jobRemote}:${srcRemote}` : `${jobRemote}:`,
        srcRemote: '',
        dstFs: localPath,
        dstRemote: '',
        displayName: input.remotePath,
        localPath,
        size: 0,
        segments: input.segments,
        cleanupRemote: jobRemote
      })
    }

    return manager.enqueue({
      kind: 'file',
      srcFs: `${jobRemote}:`,
      srcRemote,
      dstFs: targetDir,
      dstRemote: baseName,
      displayName: input.remotePath,
      localPath: join(targetDir, baseName),
      size: item.Size < 0 ? 0 : item.Size,
      segments: input.segments,
      cleanupRemote: jobRemote
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

  app.post('/api/downloads/clear-all', async () => {
    manager.clearAll()
    return { ok: true }
  })

  app.post('/api/downloads/remove', async (req) => {
    manager.remove((req.body as { id: string }).id)
    return { ok: true }
  })

  app.get('/api/downloads/concurrency', async () => ({ max: manager.getMaxConcurrent() }))

  app.post('/api/downloads/concurrency', async (req) => {
    const { max } = req.body as { max: number }
    return { max: manager.setMaxConcurrent(max) }
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
    for (const transfer of manager.list()) send({ type: 'update', transfer })
    const offUpdate = manager.onUpdate((transfer) => send({ type: 'update', transfer }))
    const offRemove = manager.onRemove((id) => send({ type: 'remove', id }))
    const ping = setInterval(() => raw.write(': ping\n\n'), 25000)
    req.raw.on('close', () => {
      clearInterval(ping)
      offUpdate()
      offRemove()
    })
  })
}
