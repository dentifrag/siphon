import { describe, expect, it } from 'vitest'
import { formatEta } from '../src/ui/lib/format'

describe('formatEta', () => {
  it('returns empty when speed is zero or negative', () => {
    expect(formatEta(1000, 0)).toBe('')
    expect(formatEta(1000, -5)).toBe('')
  })

  it('returns empty when there are no remaining bytes', () => {
    expect(formatEta(0, 1000)).toBe('')
    expect(formatEta(-10, 1000)).toBe('')
  })

  it('formats sub-minute durations as seconds', () => {
    expect(formatEta(45 * 1024, 1024)).toBe('45s')
  })

  it('formats sub-hour durations as minutes and seconds', () => {
    expect(formatEta((3 * 60 + 20) * 1024, 1024)).toBe('3m 20s')
  })

  it('formats hour-plus durations as hours and minutes', () => {
    expect(formatEta((3600 + 4 * 60) * 1024, 1024)).toBe('1h 4m')
  })
})
