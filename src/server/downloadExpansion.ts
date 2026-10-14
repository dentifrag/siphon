import { dirname, join, sep } from 'node:path'
import type { FsScope } from './localFs'
import {
  MAX_RECURSIVE_LIST_ENTRIES,
  type RcloneClient,
  type RcloneListEntry
} from './rclone/client'
import type { RcloneEnqueueInput } from './rclone/downloadManager'
import { httpError } from './http'

export const MAX_DOWNLOAD_ENTRIES = MAX_RECURSIVE_LIST_ENTRIES

export interface ExpandDownloadInput {
  item: RcloneListEntry
  remotePath: string
  dirPath: string
  wrappingName: string
  targetDir: string
  segments: number
  jobRemote: string
  scope?: FsScope
}

function unsafeName(name: string): boolean {
  // eslint-disable-next-line no-control-regex -- local filenames must not contain control characters
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) return true
  return (
    process.platform === 'win32' &&
    // eslint-disable-next-line no-control-regex -- Windows forbids control characters in filenames
    (/[<>:"|?*\u0000-\u001f]/.test(name) ||
      /[ .]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
  )
}

export async function planDownload(
  client: RcloneClient,
  input: ExpandDownloadInput
): Promise<{ inputs: RcloneEnqueueInput[]; directories: string[] }> {
  const { item, remotePath, dirPath, wrappingName, targetDir, segments, jobRemote } = input
  if (unsafeName(wrappingName))
    throw httpError(400, 'The source name is not a safe local filename.')
  if (!item.IsDir) {
    return {
      inputs: [
        {
          srcFs: `${jobRemote}:`,
          srcRemote: dirPath,
          dstFs: targetDir,
          dstRemote: wrappingName,
          displayName: remotePath,
          localPath: join(targetDir, wrappingName),
          size: item.Size < 0 ? 0 : item.Size,
          segments,
          cleanupRemote: jobRemote
        }
      ],
      directories: []
    }
  }

  const normalizedDirPath = dirPath.split('/').filter(Boolean).join('/')
  const entries = await client.listRecursiveEntries(`${jobRemote}:`, normalizedDirPath)
  if (entries.length > MAX_DOWNLOAD_ENTRIES) {
    throw httpError(400, 'Too many entries in one download folder.')
  }
  if (!entries.some((entry) => !entry.IsDir)) return { inputs: [], directories: [] }
  const prefix = normalizedDirPath ? `${normalizedDirPath}/` : ''
  if (prefix && entries.some((entry) => !entry.Path.startsWith(prefix))) {
    throw httpError(400, 'Recursive listing returned a file outside the requested directory.')
  }
  const destinationRoot = join(targetDir, wrappingName)
  const plannedEntries = entries.map((entry) => {
    const relativePath = entry.Path.slice(prefix.length)
    return { entry, relativePath, localPath: join(destinationRoot, relativePath) }
  })
  if (
    plannedEntries.some(
      ({ relativePath, localPath }) =>
        !relativePath ||
        relativePath.split('/').some(unsafeName) ||
        !localPath.startsWith(`${destinationRoot}${sep}`)
    )
  ) {
    throw httpError(400, 'Recursive listing returned an unsafe file path.')
  }
  const directories = new Set([
    destinationRoot,
    ...plannedEntries.map(({ entry, localPath }) => (entry.IsDir ? localPath : dirname(localPath)))
  ])
  const inputs = plannedEntries
    .filter(({ entry }) => !entry.IsDir)
    .map(({ entry, relativePath, localPath }): RcloneEnqueueInput => ({
      srcFs: `${jobRemote}:`,
      srcRemote: entry.Path,
      dstFs: destinationRoot,
      dstRemote: relativePath,
      displayName: `${wrappingName}/${relativePath}`,
      localPath,
      size: entry.Size < 0 ? 0 : entry.Size,
      segments,
      cleanupRemote: jobRemote
    }))
  return { inputs, directories: [...directories] }
}
