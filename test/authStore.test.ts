import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AuthStore } from '../src/server/authStore'
import { hashPassword } from '../src/server/auth'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'siphon-auth-store-'))
}

describe('AuthStore', () => {
  it('returns null when auth.json does not exist', async () => {
    const dir = await makeTempDir()
    const store = new AuthStore(dir)
    await expect(store.read()).resolves.toBeNull()
  })

  it('round-trips password mode', async () => {
    const dir = await makeTempDir()
    const store = new AuthStore(dir)
    const state = {
      mode: 'password' as const,
      username: 'admin',
      passwordHash: hashPassword('secret-password')
    }
    await store.write(state)
    await expect(store.read()).resolves.toEqual(state)
  })

  it('round-trips open mode', async () => {
    const dir = await makeTempDir()
    const store = new AuthStore(dir)
    await store.write({ mode: 'open' })
    await expect(store.read()).resolves.toEqual({ mode: 'open' })
  })

  it('throws on malformed JSON', async () => {
    const dir = await makeTempDir()
    const store = new AuthStore(dir)
    await writeFile(join(dir, 'auth.json'), '{bad json')
    await expect(store.read()).rejects.toThrow('Invalid JSON')
  })

  it('throws on unknown mode', async () => {
    const dir = await makeTempDir()
    const store = new AuthStore(dir)
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ mode: 'broken' }))
    await expect(store.read()).rejects.toThrow('mode must be "password" or "open"')
  })

  it('throws on missing username in password mode', async () => {
    const dir = await makeTempDir()
    const store = new AuthStore(dir)
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ mode: 'password', username: '', passwordHash: hashPassword('pw') })
    )
    await expect(store.read()).rejects.toThrow('non-empty username')
  })

  it('throws on bad password hash format', async () => {
    const dir = await makeTempDir()
    const store = new AuthStore(dir)
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ mode: 'password', username: 'admin', passwordHash: 'not-a-hash' })
    )
    await expect(store.read()).rejects.toThrow('valid scrypt hash')
  })

  it('writes auth.json with 0600 permissions on unix-like systems', async () => {
    const dir = await makeTempDir()
    const store = new AuthStore(dir)
    await store.write({ mode: 'open' })
    const filePath = join(dir, 'auth.json')
    const fileContents = await readFile(filePath, 'utf8')
    expect(fileContents.includes('"mode": "open"')).toBe(true)
    if (process.platform !== 'win32') {
      const mode = (await stat(filePath)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })
})
