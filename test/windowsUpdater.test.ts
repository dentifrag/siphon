import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.platform !== 'win32')(
  'Windows updater core (injected operations only)',
  () => {
    it('verifies checksum, version health, rollback, recovery, and lock invariants safely', () => {
      const corePath = resolve('windows-service', 'SiphonUpdater.Core.ps1')
      expect(existsSync(corePath), 'The side-effect-free updater core must be implemented').toBe(
        true
      )
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve('test', 'fixtures', 'WindowsUpdater.Tests.ps1'),
          '-CorePath',
          corePath
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true }
      )
      expect(output).toContain('PASS: 8 safe updater scenarios')
    }, 35_000)
  }
)
