import { resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadDestinationKey } from '../src/server/localFs'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
if (!platformDescriptor) throw new Error('Cannot capture process.platform for restoration.')

const targetDir = resolve('fixtures', 'uncreated-download-destinations')
const upperTarget = `${targetDir}${sep}nested${sep}..${sep}Report.BIN`
const lowerTarget = `${targetDir}${sep}nested${sep}..${sep}report.bin`
const normalizedUpperTarget = resolve(upperTarget)
const normalizedLowerTarget = resolve(lowerTarget)

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
})

describe('downloadDestinationKey platform case handling', () => {
  it.each(['darwin', 'win32'] as const)(
    'folds case aliases of uncreated final targets into the same normalized key on %s',
    (platform) => {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform })

      expect(process.platform).toBe(platform)
      expect(normalizedUpperTarget).not.toBe(normalizedLowerTarget)
      const upperKey = downloadDestinationKey(upperTarget)
      const lowerKey = downloadDestinationKey(lowerTarget)

      expect(upperKey).toBe(normalizedUpperTarget.toLowerCase())
      expect(lowerKey).toBe(normalizedLowerTarget.toLowerCase())
      expect(upperKey).toBe(lowerKey)
    }
  )

  it('keeps case-differing uncreated final targets distinct and normalized on linux', () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' })

    expect(process.platform).toBe('linux')
    const upperKey = downloadDestinationKey(upperTarget)
    const lowerKey = downloadDestinationKey(lowerTarget)

    expect(upperKey).toBe(normalizedUpperTarget)
    expect(lowerKey).toBe(normalizedLowerTarget)
    expect(upperKey).not.toBe(lowerKey)
  })
})
