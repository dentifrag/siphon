import { posix } from 'node:path'
import type { RemoteEntry, RemoteEntryType } from '../shared/types'
import type { RcloneListEntry } from './rclone/client'

export function uiToRemotePath(uiPath: string): string {
  return (uiPath || '/').replace(/^\/+/, '')
}

export function remoteType(entry: Pick<RcloneListEntry, 'IsDir'>): RemoteEntryType {
  return entry.IsDir ? 'directory' : 'file'
}

export function toRemoteEntry(uiDir: string, entry: RcloneListEntry): RemoteEntry {
  const base = uiDir === '/' ? '' : uiDir.replace(/\/+$/, '')
  return {
    name: entry.Name,
    path: `${base}/${entry.Name}`,
    type: remoteType(entry),
    size: entry.Size < 0 ? 0 : entry.Size,
    mtime: entry.ModTime ? Date.parse(entry.ModTime) || 0 : 0
  }
}

export function safeBaseName(remotePath: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip NUL and path separators from derived filenames
  const name = posix.basename(remotePath).replace(/[\\/\0]/g, '_')
  return name || 'download'
}
