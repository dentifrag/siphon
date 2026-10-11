import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDevConfig, prepareDevFiles } from '../scripts/dev-config'
import { resolveConfig, type FileConfig } from '../src/server/config'

async function inspectTree(dir: string): Promise<{ files: string[]; emptyDirs: string[] }> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  const emptyDirs: string[] = entries.length === 0 ? [dir] : []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await inspectTree(path)
      files.push(...nested.files)
      emptyDirs.push(...nested.emptyDirs)
    } else {
      files.push(path)
    }
  }
  return { files, emptyDirs }
}

describe('createDevConfig', () => {
  it('is pure and isolates the resolved server from inherited production settings', async () => {
    const fixture = await mkdtemp(join(process.cwd(), '.siphon-dev-test-'))
    try {
      const root = join(fixture, "app's work tree")
      const workspace = join(root, '.siphon-dev')
      const env = {
        HOST: '0.0.0.0',
        PORT: '443',
        DATA_DIR: join(fixture, 'production-data'),
        DOWNLOAD_DIR: fixture,
        DOWNLOAD_DIRS: `Production=${fixture}`,
        CONFIG_PATH: join(fixture, 'production.json'),
        APP_PASSWORD: 'production-password',
        APP_PASSWORD_HASH: 'production-hash',
        APP_USERNAME: 'production-user',
        LOGIN_MAX_ATTEMPTS: '0',
        LOGIN_LOCKOUT_MINUTES: '999',
        SESSION_TTL_HOURS: '999',
        TRUST_PROXY: 'true',
        SECURE_COOKIES: 'true',
        WEB_DIR: join(fixture, 'production-web'),
        RCLONE_CONFIG: join(fixture, 'production-rclone.conf'),
        RCLONE_CACHE_DIR: fixture,
        RCLONE_RC_ADDR: '0.0.0.0:5572',
        RCLONE_RC_PASS: 'production-rc-password',
        RCLONE_FILTER: '- **',
        RCLONE_FUTURE_OVERRIDE: 'production',
        RCLONE_PATH: join(fixture, 'custom rclone.exe'),
        PATH: 'ordinary-path',
        SystemRoot: 'ordinary-system-root',
        LANG: 'en_US.UTF-8'
      }
      const originalEnv = { ...env }
      const config = createDevConfig(root, env)
      expect(config).toMatchObject({
        rootDir: root,
        workspaceDir: workspace,
        apiPort: 8081,
        uiPort: 5174,
        sftpPort: 2022,
        dataDir: join(workspace, 'data'),
        downloadsDir: join(workspace, 'downloads'),
        remoteDir: join(workspace, 'remote'),
        cacheDir: join(workspace, 'cache'),
        configPath: join(workspace, 'config.json'),
        credentialsPath: join(workspace, 'credentials.json')
      })
      expect(config.serverEnv.CONFIG_PATH).toBe(config.configPath)
      expect(config.serverEnv).toMatchObject({
        RCLONE_PATH: env.RCLONE_PATH,
        PATH: env.PATH,
        SystemRoot: env.SystemRoot,
        LANG: env.LANG
      })
      for (const key of Object.keys(env)) {
        if (
          /^(APP_|LOGIN_|SESSION_)/.test(key) ||
          key === 'WEB_DIR' ||
          (key.startsWith('RCLONE_') && key !== 'RCLONE_PATH')
        ) {
          expect(config.serverEnv[key], key).toBeUndefined()
        }
      }
      expect(resolveConfig({}, config.serverEnv, root)).toMatchObject({
        port: 8081,
        host: '127.0.0.1',
        dataDir: config.dataDir,
        confined: true,
        roots: [{ name: expect.any(String), path: config.downloadsDir }],
        defaultDir: config.downloadsDir,
        appPassword: null,
        appPasswordHash: null,
        appUsername: null,
        loginMaxAttempts: 10,
        loginLockoutMinutes: 15,
        sessionTtlHours: 72,
        trustProxy: false,
        secureCookies: 'false'
      })
      expect(env).toEqual(originalEnv)
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('accepts distinct custom ports including both integer boundaries', () => {
    const config = createDevConfig(process.cwd(), {
      DEV_API_PORT: '1',
      DEV_UI_PORT: '65535',
      DEV_SFTP_PORT: '2'
    })
    expect(config).toMatchObject({ apiPort: 1, uiPort: 65535, sftpPort: 2 })
    expect(resolveConfig({}, config.serverEnv, config.rootDir).port).toBe(1)
  })

  it.each(['DEV_API_PORT', 'DEV_UI_PORT', 'DEV_SFTP_PORT'])(
    'rejects invalid %s values rather than partially parsing or falling back',
    (key) => {
      for (const value of ['', ' ', '0', '-1', '65536', '8081.5', '8081x', '1e3', '0x10']) {
        expect(() => createDevConfig(process.cwd(), { [key]: value }), `${key}=${value}`).toThrow(
          new RegExp(key)
        )
      }
    }
  )

  it.each([{ DEV_API_PORT: '5174' }, { DEV_API_PORT: '2022' }, { DEV_UI_PORT: '2022' }])(
    'rejects colliding listener ports: %j',
    (env) => {
      expect(() => createDevConfig(process.cwd(), env)).toThrow(
        /distinct|different|collision|same port/i
      )
    }
  )
})

describe('prepareDevFiles', () => {
  it('seeds useful samples and stable random credentials without replacing user edits', async () => {
    const root = await mkdtemp(join(process.cwd(), ".siphon-dev-test-app's tree-"))
    try {
      const productionConfig = join(root, 'config.json')
      const productionAuth = join(root, 'data', 'auth.json')
      await mkdir(dirname(productionAuth), { recursive: true })
      await writeFile(productionConfig, '{"production":true}\n')
      await writeFile(productionAuth, '{"production":"auth"}\n')
      const config = createDevConfig(root, {})
      await prepareDevFiles(config)

      expect((await stat(config.cacheDir)).isDirectory()).toBe(true)
      expect((await stat(config.dataDir)).isDirectory()).toBe(true)
      const remote = await inspectTree(config.remoteDir)
      const downloads = await inspectTree(config.downloadsDir)
      expect(remote.files.some((path) => dirname(path) !== config.remoteDir)).toBe(true)
      expect(remote.files.some((path) => basename(path).includes(' '))).toBe(true)
      expect(remote.emptyDirs.length).toBeGreaterThan(0)
      expect(downloads.files.length).toBeGreaterThan(0)
      for (const path of [...remote.files, ...downloads.files]) {
        expect((await stat(path)).size).toBeGreaterThan(0)
      }

      const credentialsText = await readFile(config.credentialsPath, 'utf8')
      const credentials = JSON.parse(credentialsText)
      expect(['dev', 'siphon']).toContain(credentials.username)
      expect(credentials.password).toEqual(expect.any(String))
      expect(credentials.password.length).toBeGreaterThanOrEqual(16)
      const other = createDevConfig(join(root, 'another sandbox'), {})
      await prepareDevFiles(other)
      const otherCredentials = JSON.parse(await readFile(other.credentialsPath, 'utf8'))
      expect(otherCredentials.password).not.toBe(credentials.password)

      const fileConfig: FileConfig = JSON.parse(await readFile(config.configPath, 'utf8'))
      const customConfig = `${JSON.stringify({
        ...fileConfig,
        host: '0.0.0.0',
        port: 443,
        dataDir: join(root, 'outside-data'),
        downloadDirs: `Outside=${root}`,
        trustProxy: true,
        secureCookies: 'true',
        loginMaxAttempts: 7
      })}\n`
      await writeFile(config.configPath, customConfig)
      const editedFiles = [
        remote.files[0],
        downloads.files[0],
        join(config.remoteDir, 'custom.txt')
      ]
      for (const path of editedFiles) await writeFile(path, 'user-edited content\n')
      await prepareDevFiles(createDevConfig(root, {}))

      expect(await readFile(config.credentialsPath, 'utf8')).toBe(credentialsText)
      expect(await readFile(config.configPath, 'utf8')).toBe(customConfig)
      for (const path of editedFiles) {
        expect(await readFile(path, 'utf8')).toBe('user-edited content\n')
      }
      const savedConfig = JSON.parse(await readFile(config.configPath, 'utf8')) as FileConfig
      expect(resolveConfig(savedConfig, config.serverEnv, root)).toMatchObject({
        port: 8081,
        host: '127.0.0.1',
        dataDir: config.dataDir,
        confined: true,
        roots: [{ name: expect.any(String), path: config.downloadsDir }],
        defaultDir: config.downloadsDir,
        trustProxy: false,
        secureCookies: 'false',
        loginMaxAttempts: 7
      })
      expect(await readFile(productionConfig, 'utf8')).toBe('{"production":true}\n')
      expect(await readFile(productionAuth, 'utf8')).toBe('{"production":"auth"}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
