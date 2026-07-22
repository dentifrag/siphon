import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface DownloadRoot {
  name: string
  path: string
}

export interface ServerConfig {
  port: number
  host: string
  roots: DownloadRoot[]
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
  const downloadDirs = env.DOWNLOAD_DIRS || file.downloadDirs
  const fallbackDir = env.DOWNLOAD_DIR || join(baseDir, 'downloads')
  const roots = parseRoots(downloadDirs, fallbackDir)
  const dataDir = env.DATA_DIR || file.dataDir || join(baseDir, 'data')
  const appPassword = env.APP_PASSWORD || file.appPassword || null
  return { port, host, roots, dataDir, appPassword }
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

  "//downloadDirs": "Where downloads may be saved, shown in the folder picker. Format: Label=path,Label2=path2. Windows example: Downloads=C:\\\\Users\\\\You\\\\Downloads,Data=D:\\\\",
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
