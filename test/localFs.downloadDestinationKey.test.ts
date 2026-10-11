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

  it.each([
    { name: 'matching case', composed: 'caf\u00e9.bin', decomposed: 'cafe\u0301.bin' },
    { name: 'mixed case', composed: 'CAF\u00c9.BIN', decomposed: 'cafe\u0301.bin' }
  ])(
    'normalizes composed and decomposed Unicode aliases on darwin with $name',
    ({ composed, decomposed }) => {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
      const composedTarget = resolve(targetDir, composed)
      const decomposedTarget = resolve(targetDir, decomposed)

      expect(composedTarget).not.toBe(decomposedTarget)
      expect(downloadDestinationKey(composedTarget)).toBe(
        composedTarget.normalize('NFC').toLowerCase()
      )
      expect(downloadDestinationKey(decomposedTarget)).toBe(
        decomposedTarget.normalize('NFC').toLowerCase()
      )
      expect(downloadDestinationKey(composedTarget)).toBe(downloadDestinationKey(decomposedTarget))
    }
  )

  it.each(['win32', 'linux'] as const)(
    'preserves distinct Unicode spellings under the existing case policy on %s',
    (platform) => {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform })
      const composedTarget = resolve(targetDir, 'Caf\u00e9.BIN')
      const decomposedTarget = resolve(targetDir, 'Cafe\u0301.BIN')
      const composedKey = downloadDestinationKey(composedTarget)
      const decomposedKey = downloadDestinationKey(decomposedTarget)

      expect(composedKey).toBe(platform === 'win32' ? composedTarget.toLowerCase() : composedTarget)
      expect(decomposedKey).toBe(
        platform === 'win32' ? decomposedTarget.toLowerCase() : decomposedTarget
      )
      expect(composedKey).not.toBe(decomposedKey)
    }
  )
})
