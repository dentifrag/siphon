import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildServiceEnv } = require('../windows-service/buildEnv.js') as {
  buildServiceEnv: (cfg: Record<string, unknown>, root: string) => { name: string; value: string }[]
}

function toMap(env: { name: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(env.map((e) => [e.name, e.value]))
}

describe('buildServiceEnv', () => {
  it('maps the full config to service env vars', () => {
    const cfg = {
      port: 9000,
      host: '127.0.0.1',
      dataDir: 'C:\\ProgramData\\seg',
      downloadDirs: 'Movies=D:\\Movies,Backup=E:\\',
      appPassword: 'secret'
    }
    const map = toMap(buildServiceEnv(cfg, 'C:\\app'))
    expect(map.PORT).toBe('9000')
    expect(map.HOST).toBe('127.0.0.1')
    expect(map.DATA_DIR).toBe('C:\\ProgramData\\seg')
    expect(map.DOWNLOAD_DIRS).toBe('Movies=D:\\Movies,Backup=E:\\')
    expect(map.APP_PASSWORD).toBe('secret')
    expect(map.NODE_ENV).toBe('production')
  })

  it('applies defaults and omits blank optional secrets', () => {
    const map = toMap(buildServiceEnv({}, '/app'))
    expect(map.PORT).toBe('8080')
    expect(map.HOST).toBe('0.0.0.0')
    expect(map.DATA_DIR).toBe(join('/app', 'data'))
    expect('APP_PASSWORD' in map).toBe(false)
    expect('DOWNLOAD_DIRS' in map).toBe(false)
  })

  it('does not add a password when provided as an empty string', () => {
    const map = toMap(buildServiceEnv({ appPassword: '' }, '/app'))
    expect('APP_PASSWORD' in map).toBe(false)
  })

  it('produces a valid mapping for the shipped example config', () => {
    const example = JSON.parse(
      readFileSync(join(__dirname, '..', 'windows-service', 'service.config.example.json'), 'utf8')
    )
    const map = toMap(buildServiceEnv(example, 'C:\\app'))
    expect(map.PORT).toBe('8080')
    expect(map.DOWNLOAD_DIRS).toContain('Downloads=')
    expect(map.APP_PASSWORD).toBe('change-me')
  })
})
