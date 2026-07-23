import { mkdtemp, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRoots, resolveConfig, loadConfig, userDataDir, type FileConfig } from '../src/server/config'

describe('userDataDir', () => {
  it('returns a per-user, OS-appropriate app-data path', () => {
    const dir = userDataDir()
    if (platform() === 'darwin') {
      expect(dir).toBe(join(homedir(), 'Library', 'Application Support', 'Siphon'))
    } else if (platform() === 'win32') {
      expect(dir.endsWith(join('Roaming', 'Siphon')) || dir.endsWith('Siphon')).toBe(true)
    } else {
      expect(dir.endsWith(join('.local', 'share', 'siphon')) || dir.endsWith('siphon')).toBe(true)
    }
  })
})

describe('parseRoots', () => {
  it('parses labelled roots', () => {
    const roots = parseRoots('Movies=/mnt/movies,Backup=/mnt/backup', '/fallback')
    expect(roots).toEqual([
      { name: 'Movies', path: '/mnt/movies' },
      { name: 'Backup', path: '/mnt/backup' }
    ])
  })

  it('derives a label from a bare path', () => {
    const roots = parseRoots('/mnt/media', '/fallback')
    expect(roots).toEqual([{ name: 'media', path: '/mnt/media' }])
  })

  it('handles Windows drive labels', () => {
    const roots = parseRoots('C=C:\\, D=D:\\Media', '/fallback')
    expect(roots[0]).toEqual({ name: 'C', path: 'C:\\' })
    expect(roots[1]).toEqual({ name: 'D', path: 'D:\\Media' })
  })

  it('falls back to a single Downloads root when empty', () => {
    expect(parseRoots(undefined, '/fallback')).toEqual([{ name: 'Downloads', path: '/fallback' }])
    expect(parseRoots('', '/fallback')).toEqual([{ name: 'Downloads', path: '/fallback' }])
  })
})

describe('resolveConfig', () => {
  const base = '/app'

  it('keeps expected defaults including auth hardening defaults', () => {
    const cfg = resolveConfig({}, {}, base)
    expect(cfg.port).toBe(8080)
    expect(cfg.host).toBe('0.0.0.0')
    expect(cfg.appPassword).toBeNull()
    expect(cfg.appPasswordHash).toBeNull()
    expect(cfg.appUsername).toBeNull()
    expect(cfg.loginMaxAttempts).toBe(10)
    expect(cfg.loginLockoutMinutes).toBe(15)
    expect(cfg.sessionTtlHours).toBe(72)
    expect(cfg.trustProxy).toBe(false)
    expect(cfg.secureCookies).toBe('auto')
    expect(cfg.dataDir).toBe('/app/data')
    expect(cfg.confined).toBe(false)
    expect(cfg.defaultDir).toBe(join(homedir(), 'Downloads'))
    expect(cfg.roots[0]).toEqual({ name: 'Home', path: homedir() })
  })

  it('defaults username to admin when auth is configured', () => {
    const passwordCfg = resolveConfig({ appPassword: 'pw' }, {}, base)
    expect(passwordCfg.appUsername).toBe('admin')
    const hashCfg = resolveConfig({ appPasswordHash: 'scrypt$16384$8$1$QQ==$QQ==' }, {}, base)
    expect(hashCfg.appUsername).toBe('admin')
  })

  it('lets file and env override new auth settings', () => {
    const file: FileConfig = {
      appUsername: 'file-user',
      appPasswordHash: 'scrypt$16384$8$1$QQ==$QQ==',
      loginMaxAttempts: 7,
      loginLockoutMinutes: 33,
      sessionTtlHours: 12,
      trustProxy: true,
      secureCookies: 'false'
    }
    const env = {
      APP_USERNAME: 'env-user',
      APP_PASSWORD_HASH: 'scrypt$16384$8$1$Qg==$Qg==',
      LOGIN_MAX_ATTEMPTS: '4',
      LOGIN_LOCKOUT_MINUTES: '9',
      SESSION_TTL_HOURS: '5',
      TRUST_PROXY: 'yes',
      SECURE_COOKIES: 'true'
    } as NodeJS.ProcessEnv
    const cfg = resolveConfig(file, env, base)
    expect(cfg.appUsername).toBe('env-user')
    expect(cfg.appPasswordHash).toBe('scrypt$16384$8$1$Qg==$Qg==')
    expect(cfg.loginMaxAttempts).toBe(4)
    expect(cfg.loginLockoutMinutes).toBe(9)
    expect(cfg.sessionTtlHours).toBe(5)
    expect(cfg.trustProxy).toBe(true)
    expect(cfg.secureCookies).toBe('true')
  })

  it('passes through zero login max attempts', () => {
    expect(resolveConfig({}, { LOGIN_MAX_ATTEMPTS: '0' } as NodeJS.ProcessEnv, base).loginMaxAttempts).toBe(
      0
    )
    expect(resolveConfig({ loginMaxAttempts: 0 }, {}, base).loginMaxAttempts).toBe(0)
  })

  it('normalizes secureCookies values', () => {
    expect(resolveConfig({}, { SECURE_COOKIES: 'auto' } as NodeJS.ProcessEnv, base).secureCookies).toBe('auto')
    expect(resolveConfig({}, { SECURE_COOKIES: 'true' } as NodeJS.ProcessEnv, base).secureCookies).toBe('true')
    expect(resolveConfig({}, { SECURE_COOKIES: 'false' } as NodeJS.ProcessEnv, base).secureCookies).toBe(
      'false'
    )
    expect(resolveConfig({}, { SECURE_COOKIES: 'weird' } as NodeJS.ProcessEnv, base).secureCookies).toBe('auto')
  })

  it('parses trustProxy booleans', () => {
    expect(resolveConfig({}, { TRUST_PROXY: '1' } as NodeJS.ProcessEnv, base).trustProxy).toBe(true)
    expect(resolveConfig({}, { TRUST_PROXY: 'no' } as NodeJS.ProcessEnv, base).trustProxy).toBe(false)
    expect(resolveConfig({ trustProxy: true }, { TRUST_PROXY: 'wat' } as NodeJS.ProcessEnv, base).trustProxy).toBe(
      true
    )
  })

  it('uses the provided data default, but lets env and file override it', () => {
    expect(resolveConfig({}, {}, base, '/user/appdata').dataDir).toBe('/user/appdata')
    expect(resolveConfig({ dataDir: '/from/file' }, {}, base, '/user/appdata').dataDir).toBe('/from/file')
    expect(
      resolveConfig({}, { DATA_DIR: '/from/env' } as NodeJS.ProcessEnv, base, '/user/appdata').dataDir
    ).toBe('/from/env')
  })

  it('ignores a non-numeric or non-positive port from either source', () => {
    expect(resolveConfig({}, { PORT: 'abc' } as NodeJS.ProcessEnv, base).port).toBe(8080)
    expect(resolveConfig({ port: 0 }, {}, base).port).toBe(8080)
    expect(resolveConfig({ port: -5 }, {}, base).port).toBe(8080)
  })

  it('treats DOWNLOAD_DIR as a single confined root', () => {
    const env = { DOWNLOAD_DIR: '/single' } as NodeJS.ProcessEnv
    const cfg = resolveConfig({}, env, base)
    expect(cfg.confined).toBe(true)
    expect(cfg.roots).toEqual([{ name: 'Downloads', path: '/single' }])
    expect(cfg.defaultDir).toBe('/single')
  })
})

describe('loadConfig', () => {
  it('creates a template with blank credential overrides', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'siphon-config-test-'))
    const configPath = join(tempDir, 'config.json')
    const previous = {
      CONFIG_PATH: process.env.CONFIG_PATH,
      APP_PASSWORD: process.env.APP_PASSWORD,
      APP_PASSWORD_HASH: process.env.APP_PASSWORD_HASH,
      APP_USERNAME: process.env.APP_USERNAME
    }
    process.env.CONFIG_PATH = configPath
    delete process.env.APP_PASSWORD
    delete process.env.APP_PASSWORD_HASH
    delete process.env.APP_USERNAME
    try {
      const { config, created } = loadConfig()
      expect(created).toBe(true)
      expect(config.appPassword).toBeNull()
      expect(config.appPasswordHash).toBeNull()
      expect(config.appUsername).toBeNull()

      const template = await readFile(configPath, 'utf8')
      expect(template).toContain('"appUsername": ""')
      expect(template).toContain('"appPassword": ""')
      expect(template.includes('"appPassword": "change-me"')).toBe(false)
    } finally {
      if (previous.CONFIG_PATH === undefined) delete process.env.CONFIG_PATH
      else process.env.CONFIG_PATH = previous.CONFIG_PATH
      if (previous.APP_PASSWORD === undefined) delete process.env.APP_PASSWORD
      else process.env.APP_PASSWORD = previous.APP_PASSWORD
      if (previous.APP_PASSWORD_HASH === undefined) delete process.env.APP_PASSWORD_HASH
      else process.env.APP_PASSWORD_HASH = previous.APP_PASSWORD_HASH
      if (previous.APP_USERNAME === undefined) delete process.env.APP_USERNAME
      else process.env.APP_USERNAME = previous.APP_USERNAME
    }
  })
})
