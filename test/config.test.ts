import { describe, expect, it } from 'vitest'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { parseRoots, resolveConfig, userDataDir, type FileConfig } from '../src/server/config'

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

  it('uses file values when env is absent', () => {
    const file: FileConfig = {
      port: 9000,
      host: '127.0.0.1',
      appPassword: 'filepw',
      downloadDirs: 'A=/a,B=/b',
      dataDir: '/custom/data'
    }
    const cfg = resolveConfig(file, {}, base)
    expect(cfg.port).toBe(9000)
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.appPassword).toBe('filepw')
    expect(cfg.dataDir).toBe('/custom/data')
    expect(cfg.confined).toBe(true)
    expect(cfg.roots.map((r) => r.name)).toEqual(['A', 'B'])
    expect(cfg.defaultDir).toBe('/a')
  })

  it('lets environment variables override the file', () => {
    const file: FileConfig = { port: 9000, appPassword: 'filepw', downloadDirs: 'A=/a' }
    const env = {
      PORT: '7777',
      APP_PASSWORD: 'envpw',
      DOWNLOAD_DIRS: 'X=/x,Y=/y'
    } as NodeJS.ProcessEnv
    const cfg = resolveConfig(file, env, base)
    expect(cfg.port).toBe(7777)
    expect(cfg.appPassword).toBe('envpw')
    expect(cfg.confined).toBe(true)
    expect(cfg.roots.map((r) => r.name)).toEqual(['X', 'Y'])
  })

  it('is unconfined by default, defaulting downloads to the home Downloads folder', () => {
    const cfg = resolveConfig({}, {}, base)
    expect(cfg.port).toBe(8080)
    expect(cfg.host).toBe('0.0.0.0')
    expect(cfg.appPassword).toBeNull()
    expect(cfg.dataDir).toBe('/app/data')
    expect(cfg.confined).toBe(false)
    expect(cfg.defaultDir).toBe(join(homedir(), 'Downloads'))
    expect(cfg.roots[0]).toEqual({ name: 'Home', path: homedir() })
    expect(cfg.roots.length).toBeGreaterThanOrEqual(1)
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
