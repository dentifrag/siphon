import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { platform } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  helpText,
  rcloneAssetName,
  RcloneUnavailableError,
  unpackRcloneArchive
} from '../src/server/rclone/binary'

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: vi.fn(() => process.platform)
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: vi.fn()
}))

describe('rcloneAssetName', () => {
  it('maps the current platform to an rclone release archive name', () => {
    expect(rcloneAssetName()).toMatch(
      /^rclone-current-(windows|osx|linux)-(amd64|arm64|arm-v7)\.zip$/
    )
  })
})

describe('helpText', () => {
  it('states the reason and lists the three ways to provide rclone', () => {
    const text = helpText('the automatic download timed out')
    expect(text).toContain('the automatic download timed out')
    expect(text).toContain('RCLONE_PATH')
    expect(text).toContain('brew install rclone')
    expect(text).toContain('same folder as Siphon')
    expect(text).not.toContain('undefined')
  })
})

describe('unpackRcloneArchive', () => {
  const zip = "C:\\work tree\\dev's [archive].zip"
  const dest = "C:\\work tree\\dev's extraction"
  const success: SpawnSyncReturns<string> = {
    pid: 1,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null
  }

  beforeEach(() => {
    vi.mocked(spawnSync).mockReset().mockReturnValue(success)
    vi.mocked(platform).mockReturnValue('win32')
  })

  afterEach(() => {
    vi.mocked(platform).mockReturnValue(process.platform)
  })

  it('uses PowerShell with literal, safely quoted Windows paths', () => {
    unpackRcloneArchive(zip, dest)
    expect(spawnSync).toHaveBeenCalledTimes(1)
    const [command, args] = vi.mocked(spawnSync).mock.calls[0]
    expect(command).toMatch(/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i)
    const encodedIndex = args!.findIndex((arg) => /^-encodedcommand$/i.test(arg))
    const script =
      encodedIndex >= 0
        ? Buffer.from(args![encodedIndex + 1], 'base64').toString('utf16le')
        : args!.join(' ')
    expect(script).toMatch(/Expand-Archive\b/i)
    expect(script).toMatch(/-LiteralPath\b/i)
    expect(script).toContain(`'${zip.replace(/'/g, "''")}'`)
    expect(script).toContain(`'${dest.replace(/'/g, "''")}'`)
  })

  it.each(['linux', 'darwin'] as const)('keeps unzip on %s with separate path arguments', (os) => {
    vi.mocked(platform).mockReturnValue(os)
    unpackRcloneArchive(zip, dest)
    expect(spawnSync).toHaveBeenCalledTimes(1)
    const [command, args] = vi.mocked(spawnSync).mock.calls[0]
    expect(command).toBe('unzip')
    expect(args).toContain(zip)
    expect(args![args!.indexOf('-d') + 1]).toBe(dest)
  })

  it.each(['win32', 'linux'] as const)(
    'reports missing extractors and nonzero exits as RcloneUnavailableError on %s',
    (os) => {
      vi.mocked(platform).mockReturnValue(os)
      for (const result of [
        {
          ...success,
          status: null,
          error: Object.assign(new Error('extractor executable not found (ENOENT)'), {
            code: 'ENOENT'
          })
        },
        { ...success, status: 1, stderr: 'archive is corrupt' }
      ]) {
        vi.mocked(spawnSync).mockReturnValue(result)
        let failure: unknown
        try {
          unpackRcloneArchive(zip, dest)
        } catch (error) {
          failure = error
        }
        expect(failure).toBeInstanceOf(RcloneUnavailableError)
        expect(failure).toHaveProperty(
          'message',
          expect.stringContaining(result.error?.message ?? result.stderr)
        )
      }
    }
  )
})
