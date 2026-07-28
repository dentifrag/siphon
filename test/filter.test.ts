import { describe, expect, it } from 'vitest'
import { filterEntries } from '../src/ui/lib/filter'
import type { RemoteEntry } from '../src/shared/types'

const entries: RemoteEntry[] = [
  { path: '/Documents', name: 'Documents', type: 'directory', size: 0, mtime: 0 },
  { path: '/notes/README.txt', name: 'README.txt', type: 'file', size: 42, mtime: 0 },
  { path: '/archive/report.pdf', name: 'report.pdf', type: 'file', size: 100, mtime: 0 }
]

describe('filterEntries', () => {
  it('matches entry names case-insensitively', () => {
    expect(filterEntries(entries, 'readME')).toEqual([entries[1]])
  })

  it('trims leading and trailing whitespace', () => {
    expect(filterEntries(entries, '  PORT.PD  ')).toEqual([entries[2]])
  })

  it.each(['', '   '])('returns the input unchanged for an empty query (%j)', (query) => {
    expect(filterEntries(entries, query)).toBe(entries)
  })

  it('returns an empty array when no names match', () => {
    expect(filterEntries(entries, 'missing')).toEqual([])
  })

  it('matches on name rather than path', () => {
    expect(filterEntries(entries, 'archive')).toEqual([])
  })
})
