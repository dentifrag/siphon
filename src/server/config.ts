import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, platform } from 'node:os'

export interface DownloadRoot {
  name: string
  path: string
}

export interface ServerConfig {
  port: number
  host: string
  roots: DownloadRoot[]
  defaultDir: string
  confined: boolean
  dataDir: string
  appPassword: string | null
}

export interface FileConfig {
  port?: number
  host?: string
  appPassword?: string
  downloadDirs?: string
  dataDir?: string
}

export function isPackaged(): boolean {
  return typeof (process as { pkg?: unknown }).pkg !== 'undefined'
}

export function parseRoots(downloadDirs: string | undefined, fallbackDir: string): DownloadRoot[] {
  const raw = downloadDirs?.trim()
  if (raw) {
    const roots: DownloadRoot[] = []
    for (const part of raw.split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const eq = piece.indexOf('=')
      if (eq > 0) {
        roots.push({ name: piece.slice(0, eq).trim(), path: piece.slice(eq + 1).trim() })
      } else {
        roots.push({ name: basenameLabel(piece), path: piece })
      }
    }
    if (roots.length > 0) return roots
  }
  return [{ name: 'Downloads', path: fallbackDir }]
}

function basenameLabel(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function resolveConfig(
  file: FileConfig,
  env: NodeJS.ProcessEnv,
  baseDir: string
): ServerConfig {
  const port = intOr(env.PORT, file.port, 8080)
  const host = env.HOST || file.host || '0.0.0.0'
  const dataDir = env.DATA_DIR || file.dataDir || join(baseDir, 'data')
  const appPassword = env.APP_PASSWORD || file.appPassword || null

  const home = homedir()
  const dirsSpec = env.DOWNLOAD_DIRS || file.downloadDirs
  const singleDir = env.DOWNLOAD_DIR
  const confined = Boolean((dirsSpec && dirsSpec.trim()) || (singleDir && singleDir.trim()))

  let roots: DownloadRoot[]
  let defaultDir: string
  if (confined) {
    roots = parseRoots(dirsSpec, singleDir && singleDir.trim() ? singleDir : join(home, 'Downloads'))
    defaultDir = roots[0].path
  } else {
    roots = openRoots(home)
    defaultDir = join(home, 'Downloads')
  }

  return { port, host, roots, defaultDir, confined, dataDir, appPassword }
}

function openRoots(home: string): DownloadRoot[] {
  if (platform() === 'win32') {
    const drives: DownloadRoot[] = []
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code)
      const path = `${letter}:\\`
      if (existsSync(path)) drives.push({ name: `${letter}:`, path })
    }
    return [{ name: 'Home', path: home }, ...drives]
  }
  return [
    { name: 'Home', path: home },
    { name: 'File system', path: '/' }
  ]
}

function intOr(envValue: string | undefined, fileValue: number | undefined, fallback: number): number {
  const fromEnv = Number.parseInt(envValue ?? '', 10)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  if (typeof fileValue === 'number' && Number.isFinite(fileValue) && fileValue > 0) return fileValue
  return fallback
}

const CONFIG_TEMPLATE = `{
  "//": "Siphon config. Edit values below, then restart the app.",
  "port": 8080,
  "host": "0.0.0.0",

  "//appPassword": "Password to open the web UI. Strongly recommended.",
  "appPassword": "change-me",

  "//downloadDirs": "Optional. Leave blank to browse your whole computer and save anywhere (downloads default to your Downloads folder). Set it to LIMIT downloads to specific folders. Format: Label=path,Label2=path2. Windows example: Downloads=C:\\\\Users\\\\You\\\\Downloads,Data=D:\\\\",
  "downloadDirs": "",

  "//dataDir": "Optional. Where saved profiles + the rclone config live. Defaults to a 'data' folder next to this file.",
  "dataDir": ""
}
`

export function configFilePath(): string | null {
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH
  if (isPackaged()) return join(dirname(process.execPath), 'config.json')
  return null
}

function readFileConfig(path: string): FileConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const clean: FileConfig = {}
    if (typeof parsed.port === 'number') clean.port = parsed.port
    if (typeof parsed.host === 'string') clean.host = parsed.host
    if (typeof parsed.appPassword === 'string' && parsed.appPassword) clean.appPassword = parsed.appPassword
    if (typeof parsed.downloadDirs === 'string' && parsed.downloadDirs) clean.downloadDirs = parsed.downloadDirs
    if (typeof parsed.dataDir === 'string' && parsed.dataDir) clean.dataDir = parsed.dataDir
    return clean
  } catch {
    return {}
  }
}

export function loadConfig(): { config: ServerConfig; configPath: string | null; created: boolean } {
  const path = configFilePath()
  const baseDir = isPackaged() ? dirname(process.execPath) : process.cwd()

  let file: FileConfig = {}
  let created = false
  if (path) {
    if (existsSync(path)) {
      file = readFileConfig(path)
    } else {
      try {
        writeFileSync(path, CONFIG_TEMPLATE, { flag: 'wx' })
        created = true
      } catch {}
    }
  }

  return { config: resolveConfig(file, process.env, baseDir), configPath: path, created }
}
