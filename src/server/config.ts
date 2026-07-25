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
  appPasswordHash: string | null
  appUsername: string | null
  loginMaxAttempts: number
  loginLockoutMinutes: number
  sessionTtlHours: number
  trustProxy: boolean
  secureCookies: 'auto' | 'true' | 'false'
}

export interface FileConfig {
  port?: number
  host?: string
  appPassword?: string
  appPasswordHash?: string
  appUsername?: string
  downloadDirs?: string
  dataDir?: string
  loginMaxAttempts?: number
  loginLockoutMinutes?: number
  sessionTtlHours?: number
  trustProxy?: boolean
  secureCookies?: string
}

export function isPackaged(): boolean {
  return typeof (process as { pkg?: unknown }).pkg !== 'undefined'
}

export function userDataDir(app = 'Siphon'): string {
  const home = homedir()
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), app)
  }
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', app)
  }
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), app.toLowerCase())
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
  baseDir: string,
  dataDefault: string = join(baseDir, 'data')
): ServerConfig {
  const port = intOr(env.PORT, file.port, 8080)
  const host = env.HOST || file.host || '0.0.0.0'
  const dataDir = env.DATA_DIR || file.dataDir || dataDefault
  const appPassword = env.APP_PASSWORD || file.appPassword || null
  const appPasswordHash = env.APP_PASSWORD_HASH || file.appPasswordHash || null
  const appUsername =
    env.APP_USERNAME || file.appUsername || (appPassword || appPasswordHash ? 'admin' : null)
  const loginMaxAttempts = intOrAllowZero(env.LOGIN_MAX_ATTEMPTS, file.loginMaxAttempts, 10)
  const loginLockoutMinutes = intOr(env.LOGIN_LOCKOUT_MINUTES, file.loginLockoutMinutes, 15)
  const sessionTtlHours = intOr(env.SESSION_TTL_HOURS, file.sessionTtlHours, 72)
  const trustProxy = boolOr(env.TRUST_PROXY, file.trustProxy, false)
  const secureCookies = normalizeSecureCookies(env.SECURE_COOKIES || file.secureCookies || 'auto')

  const home = homedir()
  const dirsSpec = env.DOWNLOAD_DIRS || file.downloadDirs
  const singleDir = env.DOWNLOAD_DIR
  const confined = Boolean((dirsSpec && dirsSpec.trim()) || (singleDir && singleDir.trim()))

  let roots: DownloadRoot[]
  let defaultDir: string
  if (confined) {
    roots = parseRoots(
      dirsSpec,
      singleDir && singleDir.trim() ? singleDir : join(home, 'Downloads')
    )
    defaultDir = roots[0].path
  } else {
    roots = openRoots(home)
    defaultDir = join(home, 'Downloads')
  }

  return {
    port,
    host,
    roots,
    defaultDir,
    confined,
    dataDir,
    appPassword,
    appPasswordHash,
    appUsername,
    loginMaxAttempts,
    loginLockoutMinutes,
    sessionTtlHours,
    trustProxy,
    secureCookies
  }
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

function intOr(
  envValue: string | undefined,
  fileValue: number | undefined,
  fallback: number
): number {
  const fromEnv = Number.parseInt(envValue ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  if (Number.isInteger(fileValue) && (fileValue as number) > 0) return fileValue as number
  return fallback
}

function intOrAllowZero(
  envValue: string | undefined,
  fileValue: number | undefined,
  fallback: number
): number {
  const fromEnv = Number.parseInt(envValue ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv >= 0) return fromEnv
  if (Number.isInteger(fileValue) && (fileValue as number) >= 0) return fileValue as number
  return fallback
}

function boolOr(
  envValue: string | undefined,
  fileValue: boolean | undefined,
  fallback: boolean
): boolean {
  const normalized = (envValue ?? '').trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  if (typeof fileValue === 'boolean') return fileValue
  return fallback
}

function normalizeSecureCookies(value: string): 'auto' | 'true' | 'false' {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return 'true'
  if (normalized === 'false') return 'false'
  return 'auto'
}

const CONFIG_TEMPLATE = `{
  "//": "Siphon config. Edit values below, then restart the app.",
  "port": 8080,
  "host": "0.0.0.0",

  "//appUsername": "Optional login username override. Leave blank to use first-run setup wizard credentials.",
  "appUsername": "",

  "//appPassword": "Optional plaintext password override. Leave blank to use first-run setup wizard credentials.",
  "appPassword": "",

  "//appPasswordHash": "scrypt hash for login from --hash-password. Takes precedence over appPassword.",
  "appPasswordHash": "",

  "//loginMaxAttempts": "Failed login attempts before lockout. 0 disables lockout.",
  "loginMaxAttempts": 10,

  "//loginLockoutMinutes": "How long a lockout lasts after too many failed attempts.",
  "loginLockoutMinutes": 15,

  "//sessionTtlHours": "Session lifetime in hours before re-login is required.",
  "sessionTtlHours": 72,

  "//trustProxy": "Enable behind a reverse proxy so client IP and HTTPS protocol are detected.",
  "trustProxy": false,

  "//secureCookies": "Cookie security mode: auto, true, or false. Set true when serving over HTTPS.",
  "secureCookies": "auto",

  "//downloadDirs": "Optional. Leave blank to browse your whole computer and save anywhere (downloads default to your Downloads folder). Set it to LIMIT downloads to specific folders. Format: Label=path,Label2=path2. Windows example: Downloads=C:\\\\Users\\\\You\\\\Downloads,Data=D:\\\\",
  "downloadDirs": "",

  "//dataDir": "Optional. Where saved profiles + the rclone config live. Defaults to a per-user app-data folder (macOS: ~/Library/Application Support/Siphon, Linux: ~/.local/share/siphon, Windows: %APPDATA%\\\\Siphon).",
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
    if (typeof parsed.appPassword === 'string' && parsed.appPassword)
      clean.appPassword = parsed.appPassword
    if (typeof parsed.appPasswordHash === 'string' && parsed.appPasswordHash) {
      clean.appPasswordHash = parsed.appPasswordHash
    }
    if (typeof parsed.appUsername === 'string' && parsed.appUsername)
      clean.appUsername = parsed.appUsername
    if (typeof parsed.downloadDirs === 'string' && parsed.downloadDirs)
      clean.downloadDirs = parsed.downloadDirs
    if (typeof parsed.dataDir === 'string' && parsed.dataDir) clean.dataDir = parsed.dataDir
    if (typeof parsed.loginMaxAttempts === 'number')
      clean.loginMaxAttempts = parsed.loginMaxAttempts
    if (typeof parsed.loginLockoutMinutes === 'number')
      clean.loginLockoutMinutes = parsed.loginLockoutMinutes
    if (typeof parsed.sessionTtlHours === 'number') clean.sessionTtlHours = parsed.sessionTtlHours
    if (typeof parsed.trustProxy === 'boolean') clean.trustProxy = parsed.trustProxy
    if (typeof parsed.secureCookies === 'string' && parsed.secureCookies)
      clean.secureCookies = parsed.secureCookies
    return clean
  } catch {
    return {}
  }
}

export function loadConfig(): {
  config: ServerConfig
  configPath: string | null
  created: boolean
} {
  const path = configFilePath()
  const packaged = isPackaged()
  const baseDir = packaged ? dirname(process.execPath) : process.cwd()
  const dataDefault = packaged ? userDataDir() : join(baseDir, 'data')

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

  return {
    config: resolveConfig(file, process.env, baseDir, dataDefault),
    configPath: path,
    created
  }
}
