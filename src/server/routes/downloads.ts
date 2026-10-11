import { join, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DownloadEnqueueInput } from '../../shared/api'
import type { TransferProgress } from '../../shared/types'
import type { RouteContext } from '../context'
import { httpError, parseConnectionRevision } from '../http'
import { resolvePath, type FsScope } from '../localFs'
import { safeBaseName, uiToRemotePath } from '../mapping'
import type { RcloneClient, RcloneListEntry } from '../rclone/client'
import type { RcloneDownloadManager } from '../rclone/downloadManager'

export interface ExpandDownloadInput {
  item: RcloneListEntry
  remotePath: string
  dirPath: string
  wrappingName: string
  targetDir: string
  segments: number
  jobRemote: string
}

export async function expandDownload(
  client: RcloneClient,
  manager: RcloneDownloadManager,
  input: ExpandDownloadInput
): Promise<TransferProgress[]> {
  const { item, remotePath, dirPath, wrappingName, targetDir, segments, jobRemote } = input

  if (item.IsDir) {
    const normalizedDirPath = dirPath.split('/').filter(Boolean).join('/')
    let files
    try {
      files = await client.listRecursiveFiles(`${jobRemote}:`, normalizedDirPath)
    } catch (err) {
      await client.deleteRemote(jobRemote).catch(() => undefined)
      throw err
    }

    if (files.length === 0) {
      await client.deleteRemote(jobRemote).catch(() => undefined)
      return []
    }

    const prefix = normalizedDirPath ? `${normalizedDirPath}/` : ''
    if (prefix && files.some((entry) => !entry.Path.startsWith(prefix))) {
      await client.deleteRemote(jobRemote).catch(() => undefined)
      throw new Error('Recursive listing returned a file outside the requested directory.')
    }

    const destinationRoot = join(targetDir, wrappingName)
    const plannedFiles = files.map((entry) => {
      const relativePath = entry.Path.slice(prefix.length)
      const localPath = join(destinationRoot, relativePath)
      return { entry, relativePath, localPath }
    })
    const hasUnsafePath = plannedFiles.some(
      ({ relativePath, localPath }) =>
        !relativePath ||
        relativePath.startsWith('/') ||
        relativePath.split('/').includes('..') ||
        (localPath !== destinationRoot && !localPath.startsWith(`${destinationRoot}${sep}`))
    )
    if (hasUnsafePath) {
      await client.deleteRemote(jobRemote).catch(() => undefined)
      throw new Error('Recursive listing returned an unsafe file path.')
    }

    return plannedFiles.map(({ entry, relativePath, localPath }) => {
      return manager.enqueue({
        srcFs: `${jobRemote}:`,
        srcRemote: entry.Path,
        dstFs: targetDir,
        dstRemote: `${wrappingName}/${relativePath}`,
        displayName: `${wrappingName}/${relativePath}`,
        localPath,
        size: entry.Size < 0 ? 0 : entry.Size,
        segments,
        cleanupRemote: jobRemote
      })
    })
  }

  return [
    manager.enqueue({
      srcFs: `${jobRemote}:`,
      srcRemote: dirPath,
      dstFs: targetDir,
      dstRemote: wrappingName,
      displayName: remotePath,
      localPath: join(targetDir, wrappingName),
      size: item.Size < 0 ? 0 : item.Size,
      segments,
      cleanupRemote: jobRemote
    })
  ]
}

export function registerDownloadRoutes(
  app: FastifyInstance,
  { config, services, session }: RouteContext
): void {
  const { client, manager } = services
  const scope: FsScope = { roots: config.roots, confined: config.confined }

  app.post('/api/download', async (req) => {
    const input = req.body as DownloadEnqueueInput
    const binding = session.bind(parseConnectionRevision(input.connectionRevision))
    const srcRemote = uiToRemotePath(input.remotePath)
    const job = await session.acquireJobRemote('_dl-', binding.revision)
    let item
    let targetDir = config.defaultDir
    let baseName: string
    try {
      item = await client.stat(job.fs, srcRemote)
      if (!item) throw httpError(404, 'File not found.')

      const requested = input.downloadDir?.trim()
      if (requested) {
        const resolved = await resolvePath(scope, requested)
        if (!resolved) throw httpError(400, 'That download folder is not accessible.')
        targetDir = resolved
      }
      baseName = safeBaseName(input.remotePath)
    } catch (error) {
      await job.release()
      throw error
    }

    return expandDownload(client, manager, {
      item,
      remotePath: input.remotePath,
      dirPath: srcRemote,
      wrappingName: baseName,
      targetDir,
      segments: input.segments,
      jobRemote: job.remoteName
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
    const removed = manager.remove((req.body as { id: string }).id)
    return { removed }
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
    send({ type: 'reset', transfers: manager.list() })
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
