import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface DevConfig {
  rootDir: string
  workspaceDir: string
  apiPort: number
  uiPort: number
  sftpPort: number
  dataDir: string
  downloadsDir: string
  remoteDir: string
  cacheDir: string
  configPath: string
  credentialsPath: string
  rcloneConfigPath: string
  authorizedKeysPath: string
  serverEnv: NodeJS.ProcessEnv
}

export interface DevCredentials {
  username: 'dev' | 'siphon'
  password: string
}

function devPort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key]
  if (value === undefined) return fallback
  const port = Number(value)
  if (!/^[0-9]+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key} must be an integer from 1 to 65535; received ${JSON.stringify(value)}`)
  }
  return port
}

export function createDevConfig(root: string, env: NodeJS.ProcessEnv): DevConfig {
  const rootDir = resolve(root)
  const workspaceDir = join(rootDir, '.siphon-dev')
  const apiPort = devPort(env, 'DEV_API_PORT', 8081)
  const uiPort = devPort(env, 'DEV_UI_PORT', 5174)
  const sftpPort = devPort(env, 'DEV_SFTP_PORT', 2022)
  if (new Set([apiPort, uiPort, sftpPort]).size !== 3) {
    throw new Error('DEV_API_PORT, DEV_UI_PORT, and DEV_SFTP_PORT must use distinct ports')
  }

  const dataDir = join(workspaceDir, 'data')
  const downloadsDir = join(workspaceDir, 'downloads')
  const configPath = join(workspaceDir, 'config.json')
  const serverEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const normalized = key.toUpperCase()
    if (
      /^(APP_|AUTH_|LOGIN_|SESSION_)/.test(normalized) ||
      normalized === 'WEB_DIR' ||
      (normalized.startsWith('RCLONE_') && normalized !== 'RCLONE_PATH') ||
      [
        'HOST',
        'PORT',
        'DATA_DIR',
        'DOWNLOAD_DIR',
        'DOWNLOAD_DIRS',
        'CONFIG_PATH',
        'TRUST_PROXY',
        'SECURE_COOKIES'
      ].includes(normalized)
    ) {
      continue
    }
    serverEnv[normalized === 'RCLONE_PATH' ? normalized : key] = value
  }
  Object.assign(serverEnv, {
    HOST: '127.0.0.1',
    PORT: String(apiPort),
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: downloadsDir,
    DOWNLOAD_DIRS: ' ',
    CONFIG_PATH: configPath,
    TRUST_PROXY: 'false',
    SECURE_COOKIES: 'false'
  })

  return {
    rootDir,
    workspaceDir,
    apiPort,
    uiPort,
    sftpPort,
    dataDir,
    downloadsDir,
    remoteDir: join(workspaceDir, 'remote'),
    cacheDir: join(workspaceDir, 'cache'),
    configPath,
    credentialsPath: join(workspaceDir, 'credentials.json'),
    rcloneConfigPath: join(workspaceDir, 'rclone.conf'),
    authorizedKeysPath: join(workspaceDir, 'authorized_keys'),
    serverEnv
  }
}

async function createFile(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, content, { flag: 'wx', mode })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function readCredentials(path: string): Promise<DevCredentials> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      typeof value !== 'object' ||
      value === null ||
      !('username' in value) ||
      !('password' in value) ||
      (value.username !== 'dev' && value.username !== 'siphon') ||
      typeof value.password !== 'string' ||
      value.password.length < 16 ||
      value.password.length > 256 ||
      /[\0\r\n]/.test(value.password)
    ) {
      throw new Error('expected a dev or siphon username and a password of 16 to 256 characters')
    }
    return { username: value.username, password: value.password }
  } catch (error) {
    throw new Error(
      `Cannot read local SFTP credentials at ${path}: ${error instanceof Error ? error.message : String(error)}. Repair this file, or stop the dev instance and delete it to generate new credentials.`
    )
  }
}

export async function prepareDevFiles(config: DevConfig): Promise<DevCredentials> {
  await mkdir(config.workspaceDir, { recursive: true })
  await createFile(
    config.credentialsPath,
    `${JSON.stringify({ username: 'dev', password: randomBytes(32).toString('base64url') }, null, 2)}\n`,
    0o600
  )
  const credentials = await readCredentials(config.credentialsPath)
  await chmod(config.credentialsPath, 0o600)
  await Promise.all(
    [config.dataDir, config.downloadsDir, config.remoteDir, config.cacheDir].map((dir) =>
      mkdir(dir, { recursive: true })
    )
  )
  await createFile(
    config.configPath,
    `${JSON.stringify(
      {
        port: config.apiPort,
        host: '127.0.0.1',
        dataDir: config.dataDir,
        trustProxy: false,
        secureCookies: 'false'
      },
      null,
      2
    )}\n`
  )
  await createFile(config.rcloneConfigPath, '')
  await createFile(config.authorizedKeysPath, '')
  await createFile(
    join(config.remoteDir, 'Welcome.txt'),
    'This is your local SFTP remote. Browse, download, and upload without a live server.\n'
  )
  await createFile(
    join(config.remoteDir, 'Sample folder', 'File with spaces.txt'),
    'Siphon development sample: nested files and filenames with spaces.\n'
  )
  await createFile(
    join(config.remoteDir, 'Sample folder', 'Nested', 'notes.txt'),
    'Download the Sample folder to try a nested folder transfer.\n'
  )
  await mkdir(join(config.remoteDir, 'Sample folder', 'Empty folder'), { recursive: true })
  await createFile(
    join(config.downloadsDir, 'Upload sample.txt'),
    'Upload this local file into a folder on the development SFTP remote.\n'
  )
  return credentials
}
