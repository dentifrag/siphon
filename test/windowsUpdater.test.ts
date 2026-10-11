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
    const healthVerification = installer.slice(installer.indexOf('# --- Verify it actually serves'))
    expect(healthVerification).toContain('Get-SiphonVersionHealth $installation')
    expect(healthVerification).toContain('Test-SiphonVersion $health.version')
    expect(healthVerification).toContain('$health.serviceRunning')
    expect(installer).not.toContain('Invoke-WebRequest $installation.healthUri')
    expect(installer).not.toContain('Invoke-WebRequest "http://localhost:')
  })

  it.each([
    ['Install-SiphonService.ps1', '\nRemove-ExistingService'],
    ['Uninstall-SiphonService.ps1', 'Stop-Service $ServiceName']
  ])(
    'checks existing service-path trust before privileged lifecycle actions in %s',
    (name, mutation) => {
      const source = readFileSync(resolve('windows-service', name), 'utf8')
      const preflight = source.search(/^\s*Assert-SiphonServicePaths\b/m)
      const serviceMutation = source.indexOf(mutation)
      expect(
        preflight,
        'Both lifecycle entrypoints must call the shared full-ACL preflight'
      ).toBeGreaterThanOrEqual(0)
      expect(serviceMutation).toBeGreaterThan(preflight)
      if (name === 'Install-SiphonService.ps1') {
        expect(source.indexOf('Set-SiphonProtection (Split-Path -Parent $exe)')).toBeGreaterThan(
          preflight
        )
      } else {
        expect(source.indexOf('Get-FileHash -LiteralPath $winsw')).toBeGreaterThan(preflight)
        expect(source.indexOf('& $winsw uninstall')).toBeGreaterThan(preflight)
      }
    }
  )
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
          resolve('windows-service', 'Update-SiphonService.ps1'),
          '-Scenario',
          'bind'
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true }
      )
      expect(output).toContain('PASS: safe installer preflight')
    }, 35_000)

    it('rejects unsafe existing service-path ACLs without sanitizing them or invoking lifecycle operations', () => {
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
          resolve('windows-service', 'Update-SiphonService.ps1'),
          '-Scenario',
          'acl'
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true }
      )
      expect(output).toContain('PASS: safe service-path ACL preflight')
    }, 35_000)

    it.each(['identity', 'http'])(
      'verifies connected responder ownership and bounded HTTP safely (%s)',
      (scenario) => {
        const output = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            resolve('test', 'fixtures', 'WindowsHealth.Tests.ps1'),
            '-WorkerPath',
            resolve('windows-service', 'Update-SiphonService.ps1'),
            '-Scenario',
            scenario
          ],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true }
        )
        expect(output).toContain(`PASS: safe connected health ${scenario}`)
      },
      35_000
    )

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
      expect(output).toContain('PASS: 17 safe updater scenarios')
    }, 35_000)
  }
)
