import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  helpText,
  rcloneAssetName,
  RcloneUnavailableError,
  resolveRcloneBinary,
  unpackRcloneArchive
} from '../src/server/rclone/binary'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

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

describe('resolveRcloneBinary download cleanup', () => {
  const archiveBytes = Buffer.from('downloaded archive bytes')
  const binaryBytes = Buffer.from('extracted rclone binary bytes')
  const cleanupError = Object.assign(new Error('EBUSY: download archive is locked'), {
    code: 'EBUSY'
  })
  const success: SpawnSyncReturns<string> = {
    pid: 1,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null
  }
  const fetchMock = vi.fn<typeof fetch>()
  let actualFs: typeof import('node:fs/promises')
  let root: string
  let dataDir: string
  let execDir: string
  let downloadDir: string
  let cleanupFailure: Error | undefined
  let extractionFailure: string | undefined
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    root = await actualFs.mkdtemp(join(process.cwd(), '.siphon-binary-test-'))
    dataDir = join(root, 'data')
    execDir = join(root, 'exec')
    downloadDir = ''
    cleanupFailure = undefined
    extractionFailure = undefined
    vi.stubEnv('RCLONE_PATH', undefined)
    vi.mocked(platform).mockReturnValue('win32')
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockReset().mockResolvedValue(new Response(archiveBytes))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(rm)
      .mockReset()
      .mockImplementation(async (path, options) => {
        const scopedPath = String(path)
        if (
          dirname(scopedPath) === join(dataDir, 'bin') &&
          basename(scopedPath).startsWith('.rclone-download-')
        ) {
          downloadDir = scopedPath
          if (cleanupFailure) throw cleanupFailure
        }
        await actualFs.rm(path, options)
      })
    vi.mocked(spawnSync)
      .mockReset()
      .mockImplementation((command) => {
        if (command === 'where') return { ...success, status: 1 }
        const [downloadEntry] = readdirSync(join(dataDir, 'bin'))
        const extractedFrom = join(dataDir, 'bin', downloadEntry)
        expect(readFileSync(join(extractedFrom, 'rclone.zip'))).toEqual(archiveBytes)
        if (extractionFailure) return { ...success, status: 1, stderr: extractionFailure }
        writeFileSync(join(extractedFrom, 'extracted', 'rclone.exe'), binaryBytes)
        return success
      })
  })

  afterEach(async () => {
    try {
      await actualFs.rm(root, { recursive: true, force: true })
    } finally {
      warn.mockRestore()
      vi.mocked(rm).mockReset().mockImplementation(actualFs.rm)
      vi.mocked(spawnSync).mockReset()
      vi.mocked(platform).mockReturnValue(process.platform)
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  function expectCleanupWarning(): void {
    expect(downloadDir).toMatch(/\.rclone-download-/)
    expect(rm).toHaveBeenCalledWith(downloadDir, { recursive: true, force: true })
    expect(warn).toHaveBeenCalledTimes(1)
    const warningText = warn.mock.calls
      .flat()
      .map((part) => (part instanceof Error ? part.message : String(part)))
      .join(' ')
    expect(warningText).toContain(downloadDir)
    expect(warningText).toContain(cleanupError.message)
  }

  it('returns the installed binary and warns when download cleanup fails', async () => {
    cleanupFailure = cleanupError
    const installed = join(dataDir, 'bin', 'rclone.exe')
    await expect(resolveRcloneBinary(dataDir, execDir)).resolves.toBe(installed)
    expect(readFileSync(installed)).toEqual(binaryBytes)
    expectCleanupWarning()
  })

  it.each(['extraction', 'HTTP'] as const)(
    'preserves the primary %s error and warns when download cleanup also fails',
    async (failure) => {
      cleanupFailure = cleanupError
      const reason =
        failure === 'extraction'
          ? 'the download unpacked incorrectly (archive is corrupt)'
          : 'the download server returned HTTP 503'
      if (failure === 'extraction') extractionFailure = 'archive is corrupt'
      else fetchMock.mockResolvedValue(new Response(archiveBytes, { status: 503 }))
      const result = resolveRcloneBinary(dataDir, execDir)
      await expect(result).rejects.toBeInstanceOf(RcloneUnavailableError)
      await expect(result).rejects.toHaveProperty('message', helpText(reason))
      expectCleanupWarning()
    }
  )

  it('removes the download directory without warning when cleanup succeeds', async () => {
    const installed = join(dataDir, 'bin', 'rclone.exe')
    await expect(resolveRcloneBinary(dataDir, execDir)).resolves.toBe(installed)
    expect(readFileSync(installed)).toEqual(binaryBytes)
    expect(downloadDir).toMatch(/\.rclone-download-/)
    expect(rm).toHaveBeenCalledWith(downloadDir, { recursive: true, force: true })
    expect(existsSync(downloadDir)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })
})
