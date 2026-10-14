import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DownloadEnqueueInput } from '../../shared/api'
import type { TransferProgress } from '../../shared/types'
import type { RouteContext } from '../context'
import { httpError, parseConnectionRevision } from '../http'
import {
  downloadDestinationKey,
  resolvePath,
  validateDownloadDestination,
  type FsScope
} from '../localFs'
import { safeBaseName, uiToRemotePath } from '../mapping'
import type { RcloneClient } from '../rclone/client'
import type { RcloneDownloadManager, RcloneEnqueueInput } from '../rclone/downloadManager'
import { snapshotDestination } from '../downloadPublication'
import { DownloadPlans } from '../downloadPlans'
import type { DownloadCommitInput, DownloadPlanInput } from '../../shared/api'
import { planDownload, type ExpandDownloadInput } from '../downloadExpansion'

async function enqueuePlannedDownloads(
  manager: RcloneDownloadManager,
  planned: RcloneEnqueueInput[],
  scope: FsScope | undefined,
  directories: string[] = []
): Promise<TransferProgress[]> {
  async function allowed(path: string): Promise<string> {
    const canonical = scope ? await resolvePath(scope, path) : path
    if (!canonical || downloadDestinationKey(canonical) !== downloadDestinationKey(resolve(path))) {
      throw httpError(400, 'That download destination is protected, symlinked, or not accessible.')
    }
    return canonical
  }

  if (scope) {
    for (const input of planned) {
      const canonical = await allowed(input.localPath)
      input.destinationKey = downloadDestinationKey(canonical)
    }
  }
  const canonicalDirectories: string[] = []
  for (const directory of directories) {
    const canonical = await allowed(directory)
    canonicalDirectories.push(canonical)
  }
  for (const input of planned) {
    const snapshot = await snapshotDestination(input.localPath)
    if (snapshot.kind !== 'absent') {
      throw httpError(
        409,
        'The destination already exists. Review the download collision.',
        'DESTINATION_COLLISION'
      )
    }
    input.destinationSnapshot = snapshot
  }
  for (const directory of canonicalDirectories) await mkdir(directory, { recursive: true })
  return manager.enqueueBatch(planned)
}

export async function expandDownload(
  client: RcloneClient,
  manager: RcloneDownloadManager,
  input: ExpandDownloadInput
): Promise<TransferProgress[]> {
  try {
    const planned = await planDownload(client, input)
    if (!planned.inputs.length) {
      await client.deleteRemote(input.jobRemote)
      return []
    }
    return await enqueuePlannedDownloads(manager, planned.inputs, input.scope, planned.directories)
  } catch (error) {
    await client.deleteRemote(input.jobRemote).catch(() => undefined)
    throw error
  }
}

export function registerDownloadRoutes(
  app: FastifyInstance,
  { config, services, session, updates }: RouteContext
): void {
  const { client, manager } = services
  const scope: FsScope = {
    roots: config.roots,
    confined: config.confined,
    excludedPaths: updates?.protectedPaths
  }
  const plans = new DownloadPlans(
    client,
    manager,
    session,
    scope,
    config.defaultDir,
    updates,
    (error) => app.log.error(error, 'Download plan cleanup failed.')
  )
  app.addHook('onClose', () => plans.close())
  app.post('/api/download/plan', async (req) => plans.create(req.body as DownloadPlanInput))
  app.post<{ Params: { id: string } }>('/api/download/:id/retry-plan', async (req) =>
    plans.createRetry(req.params.id)
  )
  app.post('/api/download/commit', async (req) => plans.commit(req.body as DownloadCommitInput))
  app.post<{ Params: { id: string } }>('/api/download/plan/:id/release', async (req) => {
    await plans.release(req.params.id)
    return { ok: true }
  })

  app.post('/api/download', async (req) => {
    const release = updates?.admitTransfer()
    try {
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

        const requested = input.downloadDir?.trim() || config.defaultDir
        const resolved = await resolvePath(scope, requested)
        if (!resolved) throw httpError(400, 'That download folder is not accessible.')
        targetDir = resolved
        baseName = safeBaseName(input.remotePath)
      } catch (error) {
        await job.release()
        throw error
      }

      return await expandDownload(client, manager, {
        item,
        remotePath: input.remotePath,
        dirPath: srcRemote,
        wrappingName: baseName,
        targetDir,
        segments: input.segments,
        jobRemote: job.remoteName,
        scope
      })
    } finally {
      release?.()
    }
  })

  app.post<{ Params: { id: string } }>('/api/download/:id/retry', async (req) => {
    const release = updates?.admitTransfer()
    try {
      return await manager.retry(req.params.id, async (input) => {
        const destinationKey = await validateDownloadDestination(scope, input, resolvePath)
        const destinationSnapshot = await snapshotDestination(input.localPath)
        if (destinationSnapshot.kind !== 'absent') {
          throw httpError(
            409,
            'The destination already exists. Review the retry collision.',
            'DESTINATION_COLLISION'
          )
        }
        const item = await client.stat(input.srcFs, input.srcRemote)
        if (!item) throw httpError(404, 'File not found.')
        if (item.IsDir || !Number.isFinite(item.Size)) {
          throw httpError(400, 'The retry source is not a valid file.')
        }
        return { ...input, size: Math.max(0, item.Size), destinationKey, destinationSnapshot }
      })
    } finally {
      release?.()
    }
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
