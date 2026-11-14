import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RemoteStore, sanitizeRemoteName } from '../src/server/rclone/remotes'
import type { RcloneClient } from '../src/server/rclone/client'
import type { SaveProfileInput } from '../src/shared/api'

// Stores secrets as `obscured(...)` the way rclone does, so double obscuring is visible.
function fakeClient() {
  const configs = new Map<string, Record<string, string>>()
  const client = {
    async createRemote(
      name: string,
      type: string,
      parameters: Record<string, string>,
      obscure = true
    ) {
      await Promise.resolve()
      const stored: Record<string, string> = { type }
      for (const [key, value] of Object.entries(parameters)) {
        stored[key] =
          obscure && (key === 'pass' || key === 'key_file_pass') ? `obscured(${value})` : value
      }
      configs.set(name, stored)
    },
    async getRemote(name: string) {
      const config = configs.get(name)
      if (!config) throw new Error('missing')
      return { ...config }
    },
    async deleteRemote(name: string) {
      configs.delete(name)
    },
    async cloneRemote(source: string, target: string) {
      configs.set(target, { ...configs.get(source)! })
    }
  }
  return { client: client as unknown as RcloneClient, configs }
}

const base: SaveProfileInput = {
  name: 'alice@host',
  host: 'host',
  port: 22,
  username: 'alice',
  authMethod: 'password',
  secret: undefined,
  rememberSecret: true,
  segments: 4,
  downloadDir: ''
}

async function makeStore() {
  const dataDir = await mkdtemp(join(tmpdir(), 'siphon-remotes-'))
  const { client, configs } = fakeClient()
  return { store: new RemoteStore(dataDir, client), configs, dataDir }
}

const save = (store: RemoteStore, overrides: Partial<SaveProfileInput> & { password?: string }) =>
  store.save({ ...base, ...overrides })

describe('RemoteStore saved secrets', () => {
  it('honors rememberSecret=false and removes a previously saved password', async () => {
    const { store, configs } = await makeStore()
    await save(store, { password: 'pw' })
    expect(configs.get('alice_host')?.pass).toBe('obscured(pw)')

    const [profile] = await save(store, { password: 'pw', rememberSecret: false })
    expect(configs.get('alice_host')?.pass).toBeUndefined()
    expect(profile.hasSecret).toBe(false)
  })

  it('keeps the stored secret without re-obscuring it when only metadata changes', async () => {
    const { store, configs } = await makeStore()
    await save(store, { password: 'pw' })

    const [profile] = await save(store, { port: 2222, segments: 8 })
    expect(configs.get('alice_host')).toMatchObject({ port: '2222', pass: 'obscured(pw)' })
    expect(profile).toMatchObject({ port: 2222, segments: 8, hasSecret: true })
  })

  it('drops the stored secret when the auth method changes', async () => {
    const { store, configs } = await makeStore()
    await save(store, { password: 'pw' })
    const [profile] = await save(store, { authMethod: 'privateKey', privateKeyPath: 'key' })
    expect(configs.get('alice_host')?.pass).toBeUndefined()
    expect(profile.hasSecret).toBe(false)
  })

  it('reads hasSecret for older records from the persisted remote', async () => {
    const { store, configs, dataDir } = await makeStore()
    const [saved] = await save(store, { password: 'pw' })
    const path = join(dataDir, 'remotes.json')
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    delete legacy.remotes[0].hasSecret
    await writeFile(path, JSON.stringify(legacy))
    expect((await store.list())[0].hasSecret).toBe(true)

    delete legacy.remotes[0].hasSecret
    await writeFile(path, JSON.stringify(legacy))
    delete configs.get('alice_host')!.pass
    expect((await store.list())[0]).toMatchObject({ id: saved.id, hasSecret: false })
  })

  it('does not lose profiles when saves and deletes overlap', async () => {
    const { store } = await makeStore()
    const [first] = await save(store, { name: 'one' })
    await Promise.all([
      save(store, { name: 'two' }),
      save(store, { name: 'three' }),
      store.delete(first.id)
    ])
    expect((await store.list()).map((p) => p.name).sort()).toEqual(['three', 'two'])
  })

  it('rejects without writing when the existing remote cannot be read', async () => {
    const { store, configs, dataDir } = await makeStore()
    await save(store, { password: 'pw' })
    const path = join(dataDir, 'remotes.json')
    const before = await readFile(path, 'utf8')
    const client = (store as unknown as { client: RcloneClient }).client
    const create = vi.spyOn(client, 'createRemote')
    vi.spyOn(client, 'getRemote').mockRejectedValue(new Error('rclone unreachable'))

    await expect(save(store, { port: 2222, rememberSecret: false })).rejects.toThrow(
      'rclone unreachable'
    )
    expect(create).not.toHaveBeenCalled()
    expect(configs.get('alice_host')?.pass).toBe('obscured(pw)')
    expect(await readFile(path, 'utf8')).toBe(before)

    const legacy = JSON.parse(before)
    delete legacy.remotes[0].hasSecret
    await writeFile(path, JSON.stringify(legacy))
    await expect(store.list()).rejects.toThrow('rclone unreachable')
  })

  it('surfaces an unreadable store instead of treating it as empty', async () => {
    const { store, dataDir } = await makeStore()
    await writeFile(join(dataDir, 'remotes.json'), '{ nope')
    await expect(store.list()).rejects.toThrow('Invalid JSON')
    await writeFile(join(dataDir, 'remotes.json'), JSON.stringify({ remotes: [{ id: 1 }] }))
    await expect(save(store, {})).rejects.toThrow('Invalid saved connections schema')
  })
})

describe('RemoteStore.cloneForSession', () => {
  it('copies the saved config, and a typed secret replaces the stored one only in the copy', async () => {
    const { store, configs } = await makeStore()
    const [profile] = await save(store, { password: 'saved' })

    const identity = await store.cloneForSession(profile.id, '_session-1')
    expect(identity).toMatchObject({ host: 'host', profileId: profile.id })
    expect(configs.get('_session-1')?.pass).toBe('obscured(saved)')

    await store.cloneForSession(profile.id, '_session-2', 'typed')
    expect(configs.get('_session-2')?.pass).toBe('obscured(typed)')
    expect(configs.get('alice_host')?.pass).toBe('obscured(saved)')
    expect(await store.cloneForSession('missing', '_session-3')).toBeNull()
  })

  it('lets a profile without a stored secret connect with a typed one', async () => {
    const { store, configs } = await makeStore()
    const [profile] = await save(store, { rememberSecret: false })
    await store.cloneForSession(profile.id, '_session-1', 'typed')
    expect(configs.get('_session-1')?.pass).toBe('obscured(typed)')
    expect(configs.get('alice_host')?.pass).toBeUndefined()
  })
})

describe('sanitizeRemoteName', () => {
  it('reserves the underscore prefix so saved sites never collide with internal remotes', () => {
    expect(sanitizeRemoteName('_session').startsWith('_')).toBe(false)
    expect(sanitizeRemoteName('_dl-thing').startsWith('_')).toBe(false)
    expect(sanitizeRemoteName('___weird').startsWith('_')).toBe(false)
  })

  it('keeps ordinary names usable', () => {
    expect(sanitizeRemoteName('user@host')).toBe('user_host')
    expect(sanitizeRemoteName('nas.local')).toBe('nas.local')
  })

  it('falls back to a default when nothing usable remains', () => {
    expect(sanitizeRemoteName('___')).toBe('remote')
  })
})
