import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { arch, platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export class RcloneUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RcloneUnavailableError'
  }
}

const COMMON_UNIX_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
const DOWNLOAD_TIMEOUT_MS = 30_000
const DOWNLOAD_ATTEMPTS = 3

export async function resolveRcloneBinary(dataDir: string, execDir: string): Promise<string> {
  const exe = platform() === 'win32' ? 'rclone.exe' : 'rclone'

  if (process.env.RCLONE_PATH) {
    if (existsSync(process.env.RCLONE_PATH)) return process.env.RCLONE_PATH
    throw new RcloneUnavailableError(
      helpText(`RCLONE_PATH points to "${process.env.RCLONE_PATH}", which does not exist`)
    )
  }

  for (const candidate of [join(execDir, exe), join(execDir, 'rclone', exe)]) {
    if (existsSync(candidate)) return candidate
  }

  const downloaded = join(dataDir, 'bin', exe)
  if (existsSync(downloaded)) return downloaded

  const onPath = findOnPath(exe)
  if (onPath) return onPath

  return downloadRclone(downloaded)
}

function findOnPath(exe: string): string | null {
  const finder = platform() === 'win32' ? 'where' : 'which'
  const result = spawnSync(finder, [exe], { encoding: 'utf8' })
  if (result.status === 0) {
    const first = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    if (first && existsSync(first)) return first
  }
  if (platform() !== 'win32') {
    for (const dir of COMMON_UNIX_DIRS) {
      const candidate = join(dir, exe)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export function rcloneAssetName(): string {
  const os = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'osx' : 'linux'
  const a = arch() === 'arm64' ? 'arm64' : arch() === 'arm' ? 'arm-v7' : 'amd64'
  return `rclone-current-${os}-${a}.zip`
}

export function helpText(reason: string): string {
  return [
    `Siphon needs rclone, but ${reason}.`,
    '',
    'Fix it with any one of these, then start Siphon again:',
    '  1. Install rclone and keep it on your PATH (macOS: brew install rclone).',
    '  2. Put the rclone binary in the same folder as Siphon.',
    '  3. Set the RCLONE_PATH environment variable to a full path to rclone.'
  ].join('\n')
}

function downloadFailureReason(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('timeout'))) {
    return 'the automatic download timed out (no internet, or the download server is unreachable)'
  }
  return `the automatic download failed (${err instanceof Error ? err.message : String(err)})`
}

async function fetchArchive(url: string): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    } catch (err) {
      lastErr = err
      if (attempt < DOWNLOAD_ATTEMPTS) await delay(1500 * attempt)
    }
  }
  throw new RcloneUnavailableError(helpText(downloadFailureReason(lastErr)))
}

async function downloadRclone(destPath: string): Promise<string> {
  const url = `https://downloads.rclone.org/${rcloneAssetName()}`
  mkdirSync(dirname(destPath), { recursive: true })
  const downloadDir = await mkdtemp(join(dirname(destPath), '.rclone-download-'))
  const zipPath = join(downloadDir, 'rclone.zip')
  const extractDir = join(downloadDir, 'extracted')

  try {
    const res = await fetchArchive(url)
    if (!res.ok || !res.body) {
      throw new RcloneUnavailableError(helpText(`the download server returned HTTP ${res.status}`))
    }
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(zipPath)
    )

    mkdirSync(extractDir, { recursive: true })
    unpackRcloneArchive(zipPath, extractDir)

    const exe = platform() === 'win32' ? 'rclone.exe' : 'rclone'
    const extracted = findExtractedBinary(extractDir, exe)
    if (!extracted)
      throw new RcloneUnavailableError(helpText('the downloaded archive had no rclone binary'))

    copyFileSync(extracted, destPath)
    if (platform() !== 'win32') chmodSync(destPath, 0o755)
    return destPath
  } finally {
    try {
      await rm(downloadDir, { recursive: true, force: true })
    } catch (err) {
      console.warn(
        `Failed to remove temporary rclone download directory "${downloadDir}": ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

export function unpackRcloneArchive(zipPath: string, destDir: string): void {
  const windows = platform() === 'win32'
  const quote = (path: string): string => `'${path.replace(/'/g, "''")}'`
  const script =
    `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${quote(zipPath)} ` +
    `-DestinationPath ${quote(destDir)} -Force`
  const command = windows ? 'powershell.exe' : 'unzip'
  const args = windows
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ]
    : ['-o', '-q', zipPath, '-d', destDir]
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    const reason =
      result.error?.message ||
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      `${command} exited with ${result.signal ? `signal ${result.signal}` : `status ${result.status}`}`
    throw new RcloneUnavailableError(helpText(`the download unpacked incorrectly (${reason})`))
  }
}

function findExtractedBinary(dir: string, exe: string): string | null {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      const candidate = join(full, exe)
      if (existsSync(candidate)) return candidate
    } else if (entry === exe) {
      return full
    }
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
