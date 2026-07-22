import type { RemoteEntry } from '@shared/types'

export type SortKey = 'name' | 'size' | 'mtime'
export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: SortKey
  dir: SortDir
}

export function sortEntries(entries: RemoteEntry[], sort: SortState): RemoteEntry[] {
  const factor = sort.dir === 'asc' ? 1 : -1
  const compare = (a: RemoteEntry, b: RemoteEntry): number => {
    const aDir = a.type === 'directory'
    const bDir = b.type === 'directory'
    if (aDir !== bDir) return aDir ? -1 : 1

    let result = 0
    switch (sort.key) {
      case 'size':
        result = a.size - b.size
        break
      case 'mtime':
        result = a.mtime - b.mtime
        break
      default:
        result = 0
    }
    if (result === 0) {
      result = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      return result * (sort.key === 'name' ? factor : 1)
    }
    return result * factor
  }
  return [...entries].sort(compare)
}
