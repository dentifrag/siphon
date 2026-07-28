import type { RemoteEntry } from '@shared/types'

export function filterEntries(entries: RemoteEntry[], query: string): RemoteEntry[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (normalizedQuery === '') return entries
  return entries.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery))
}
