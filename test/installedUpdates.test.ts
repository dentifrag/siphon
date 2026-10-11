import type { ExecFileOptions } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createInstalledUpdates } from '../src/server/updates'

const boundary = vi.hoisted(() => ({
  runFile: vi.fn<
    (
      file: string,
      args: string[],
      options: ExecFileOptions
    ) => Promise<{
      stdout: string
      stderr: string
    }>
  >(),
  readFile: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = vi.fn(() => {
    throw new Error('Real process execution is forbidden in this adapter test.')
  })
  Object.defineProperty(execFile, promisify.custom, { value: boundary.runFile })
  return { ...actual, execFile }
})

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: boundary.readFile,
  writeFile: vi.fn(() => {
    throw new Error('Persistence mutation is forbidden in this adapter test.')
  }),
  rename: vi.fn(() => {
    throw new Error('Persistence mutation is forbidden in this adapter test.')
  })
}))

describe('installed updater inspection adapter', () => {
  it('loads the protected helper under Restricted policy with a bounded, shell-free PowerShell invocation', async () => {
    const properties = ['platform', 'execPath', 'pkg'] as const
    const descriptors = properties.map((property) =>
      Object.getOwnPropertyDescriptor(process, property)
    )
    const executablePath = resolve('test', 'fixtures', 'installed-service', 'siphon-win-x64.exe')
    const stateDir = join(resolve('test', 'fixtures', 'installed-service'), 'siphon-updater')
    const systemRoot = 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const worker = join(stateDir, 'Update-SiphonService.ps1')
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network access is forbidden in this adapter test.'))
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      Object.defineProperty(process, 'execPath', { configurable: true, value: executablePath })
      Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
      vi.stubEnv('SIPHON_UPDATER_DIR', stateDir)
      vi.stubEnv('SystemRoot', systemRoot)
      boundary.readFile.mockRejectedValue(
        Object.assign(new Error('No pending update'), { code: 'ENOENT' })
      )
      boundary.runFile.mockImplementation(async (file, args, options) => {
        if (file !== powershell || !args.includes('-Inspect')) {
          throw new Error('Only fake installed-helper inspection is permitted.')
        }
        const policy = args.indexOf('-ExecutionPolicy')
        if (policy < 0 || args[policy + 1] !== 'Bypass') {
          throw new Error('Restricted policy refuses to load the inspection script.')
        }
        if (
          options.shell !== false ||
          typeof options.timeout !== 'number' ||
          options.timeout < 1 ||
          options.timeout > 10_000 ||
          typeof options.maxBuffer !== 'number' ||
          options.maxBuffer < 1 ||
          options.maxBuffer > 64 * 1024
        ) {
          throw new Error('Inspection requires a bounded, shell-free invocation.')
        }
        return {
          stdout: JSON.stringify({
            protocolVersion: 1,
            executablePath,
            host: '127.0.0.1',
            port: 8080,
            serviceName: 'Siphon',
            taskName: 'SiphonUpdate',
            serviceRunning: true,
            taskIdle: true
          }),
          stderr: ''
        }
      })

      const updates = await createInstalledUpdates({
        currentVersion: '1.0.2',
        host: '127.0.0.1',
        port: 8080,
        listTransfers: () => []
      })
      expect((await updates.status()).capability).toEqual({ supported: true })
      expect(boundary.runFile).toHaveBeenCalled()
      for (const [file, args, options] of boundary.runFile.mock.calls) {
        expect(file).toBe(powershell)
        expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Inspect']))
        expect(args[args.indexOf('-ExecutionPolicy') + 1]).toBe('Bypass')
        expect(args[args.indexOf('-File') + 1]).toBe(worker)
        expect(options).toMatchObject({ shell: false, windowsHide: true })
        expect(options.timeout).toBeGreaterThan(0)
        expect(options.timeout).toBeLessThanOrEqual(10_000)
        expect(options.maxBuffer).toBeGreaterThan(0)
        expect(options.maxBuffer).toBeLessThanOrEqual(64 * 1024)
      }
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      properties.forEach((property, index) => {
        const descriptor = descriptors[index]
        if (descriptor) Object.defineProperty(process, property, descriptor)
        else Reflect.deleteProperty(process, property)
      })
      vi.unstubAllEnvs()
      fetch.mockRestore()
      boundary.runFile.mockReset()
      boundary.readFile.mockReset()
    }
  })
})
