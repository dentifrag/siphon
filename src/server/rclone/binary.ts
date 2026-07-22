import { chmodSync, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { arch, platform, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export async function resolveRcloneBinary(dataDir: string, execDir: string): Promise<string> {
  const exe = platform() === 'win32' ? 'rclone.exe' : 'rclone'

  if (process.env.RCLONE_PATH && existsSync(process.env.RCLONE_PATH)) {
    return process.env.RCLONE_PATH
  }

  const bundled = [join(execDir, exe), join(execDir, 'rclone', exe)]
  for (const candidate of bundled) {
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
    const first = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  }
  return null
}

export function rcloneAssetName(): string {
  const os = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'osx' : 'linux'
  const a = arch() === 'arm64' ? 'arm64' : arch() === 'arm' ? 'arm-v7' : 'amd64'
  return `rclone-current-${os}-${a}.zip`
}

async function downloadRclone(destPath: string): Promise<string> {
  const url = `https://downloads.rclone.org/${rcloneAssetName()}`
  const tmpZip = join(tmpdir(), `rclone-${Date.now()}.zip`)
  const tmpDir = join(tmpdir(), `rclone-extract-${Date.now()}`)

  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(
      `Could not download rclone from ${url} (HTTP ${res.status}). ` +
        'Install rclone manually and set RCLONE_PATH.'
    )
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmpZip))

  mkdirSync(tmpDir, { recursive: true })
  const unzip = spawnSync('unzip', ['-o', '-q', tmpZip, '-d', tmpDir], { encoding: 'utf8' })
  if (unzip.status !== 0) {
    throw new Error(
      `Downloaded rclone but could not unzip it (${unzip.stderr || 'unzip failed'}). ` +
        'Install rclone manually and set RCLONE_PATH.'
    )
  }

  const exe = platform() === 'win32' ? 'rclone.exe' : 'rclone'
  const extracted = findExtractedBinary(tmpDir, exe)
  if (!extracted) throw new Error('rclone binary not found in the downloaded archive.')

  mkdirSync(dirname(destPath), { recursive: true })
  const { copyFileSync } = await import('node:fs')
  copyFileSync(extracted, destPath)
  if (platform() !== 'win32') chmodSync(destPath, 0o755)

  await rm(tmpZip, { force: true }).catch(() => undefined)
  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  return destPath
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
