import { basename, isAbsolute, join, posix, relative } from 'node:path'
import { stat as fsStat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { UploadEnqueueInput } from '../../shared/api'
import type { TransferProgress } from '../../shared/types'
import type { RouteContext } from '../context'
import { httpError } from '../http'
import { listFilesRecursive, resolvePath, type FsScope } from '../localFs'
import { safeBaseName, uiToRemotePath } from '../mapping'
import type { RcloneClient } from '../rclone/client'
import type { RcloneDownloadManager } from '../rclone/downloadManager'

export interface ExpandUploadInput {
  resolved: string
  isDir: boolean
  size: number
  remoteDir: string
  segments: number
  jobRemote: string
}

export async function expandUpload(
  client: RcloneClient,
  manager: RcloneDownloadManager,
  scope: FsScope,
  input: ExpandUploadInput
): Promise<TransferProgress[]> {
  const { resolved, isDir, size, remoteDir, segments, jobRemote } = input

  if (isDir) {
    const dirBaseName = safeBaseName(basename(resolved))
    let files
    try {
      files = await listFilesRecursive(scope, resolved)
    } catch (err) {
      await client.deleteRemote(jobRemote).catch(() => undefined)
      throw err
    }

    if (files.length === 0) {
      await client.deleteRemote(jobRemote).catch(() => undefined)
      return []
    }

    return files.map((file) => {
      const displayName = `${dirBaseName}/${file.relPath}`
      return manager.enqueue({
        srcFs: resolved,
        srcRemote: file.relPath,
        dstFs: `${jobRemote}:`,
        dstRemote: posix.join(remoteDir, dirBaseName, file.relPath),
        displayName,
        localPath: join(resolved, file.relPath),
        size: file.size,
        segments,
        direction: 'upload',
        cleanupRemote: jobRemote
      })
    })
  }

  const remoteBaseName = safeBaseName(basename(resolved))
  const parentDir = join(resolved, '..')
  const localBaseName = basename(resolved)

  return [
    manager.enqueue({
      srcFs: parentDir,
      srcRemote: localBaseName,
      dstFs: `${jobRemote}:`,
      dstRemote: posix.join(remoteDir, remoteBaseName),
      displayName: remoteBaseName,
      localPath: resolved,
      size,
      segments,
      direction: 'upload',
      cleanupRemote: jobRemote
    })
  ]
}

export function registerUploadRoutes(
  app: FastifyInstance,
  { config, services, session }: RouteContext
): void {
  const { client, manager } = services
  const scope: FsScope = { roots: config.roots, confined: config.confined }

  app.post('/api/upload', async (req) => {
    const input = req.body as UploadEnqueueInput
    session.remoteFs()

    const resolved = await resolvePath(scope, input.localPath)
    if (!resolved) throw httpError(400, 'That file or folder is not accessible.')

    const canonicalDataDir = await resolvePath(
      { roots: [{ name: 'data', path: config.dataDir }], confined: false },
      config.dataDir
    )
    if (canonicalDataDir && isInsideDataDir(canonicalDataDir, resolved)) {
      throw httpError(400, 'That file or folder is not accessible.')
    }

    let stats
    try {
      stats = await fsStat(resolved)
    } catch {
      throw httpError(404, 'File not found.')
    }

    const remoteDir = uiToRemotePath(input.remoteDir)
    const jobRemote = `_ul-${randomUUID()}`
    await client.cloneRemote(session.remoteName(), jobRemote)

    return expandUpload(client, manager, scope, {
      resolved,
      isDir: stats.isDirectory(),
      size: stats.isDirectory() ? 0 : stats.size,
      remoteDir,
      segments: input.segments,
      jobRemote
    })
  })
}

function isInsideDataDir(dataDir: string, target: string): boolean {
  const rel = relative(dataDir, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
