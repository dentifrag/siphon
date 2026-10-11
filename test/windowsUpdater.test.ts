import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Windows installer preflight ordering', () => {
  it('validates configuration before removing a working service and verifies the recorded bind', () => {
    const installer = readFileSync(resolve('windows-service', 'Install-SiphonService.ps1'), 'utf8')
    const preflight = installer.indexOf('$installation = New-SiphonInstallationConfig')
    const removal = installer.indexOf('\nRemove-ExistingService')
    expect(preflight).toBeGreaterThanOrEqual(0)
    expect(removal).toBeGreaterThan(preflight)
    expect(installer).toContain('Invoke-WebRequest $installation.healthUri')
    expect(installer).not.toContain('Invoke-WebRequest "http://localhost:')
  })
})

describe.skipIf(process.platform !== 'win32')(
  'Windows updater core (injected operations only)',
  () => {
    it('rejects invalid preflight safely and preserves IPv6 or interface-specific health identity', () => {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve('test', 'fixtures', 'WindowsInstallerPreflight.Tests.ps1'),
          '-WorkerPath',
          resolve('windows-service', 'Update-SiphonService.ps1')
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true }
      )
      expect(output).toContain('PASS: safe installer preflight')
    }, 35_000)

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
      expect(output).toContain('PASS: 14 safe updater scenarios')
    }, 35_000)
  }
)
