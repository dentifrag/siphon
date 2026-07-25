import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CONCURRENT_STORAGE_KEY,
  loadStoredMaxConcurrent,
  parseStoredConnection
} from '../src/ui/lib/storage'

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadStoredMaxConcurrent', () => {
  it('defaults to 3 when nothing is stored', () => {
    expect(loadStoredMaxConcurrent()).toBe(3)
  })

  it('defaults to 3 when the stored value is not a number', () => {
    localStorage.setItem(MAX_CONCURRENT_STORAGE_KEY, 'not-a-number')
    expect(loadStoredMaxConcurrent()).toBe(3)
  })

  it('clamps values below 1 up to 1', () => {
    localStorage.setItem(MAX_CONCURRENT_STORAGE_KEY, '0')
    expect(loadStoredMaxConcurrent()).toBe(1)
    localStorage.setItem(MAX_CONCURRENT_STORAGE_KEY, '-5')
    expect(loadStoredMaxConcurrent()).toBe(1)
  })

  it('clamps values above 8 down to 8', () => {
    localStorage.setItem(MAX_CONCURRENT_STORAGE_KEY, '20')
    expect(loadStoredMaxConcurrent()).toBe(8)
  })

  it('returns an in-range stored value unchanged', () => {
    localStorage.setItem(MAX_CONCURRENT_STORAGE_KEY, '5')
    expect(loadStoredMaxConcurrent()).toBe(5)
  })
})

describe('parseStoredConnection', () => {
  const valid = {
    host: 'example.com',
    port: '22',
    username: 'alice',
    authMethod: 'password',
    privateKeyPath: '',
    profileId: 'p1'
  }

  it('accepts a fully valid record', () => {
    expect(parseStoredConnection(JSON.stringify(valid))).toEqual(valid)
  })

  it('rejects a non-object payload', () => {
    expect(parseStoredConnection(JSON.stringify('nope'))).toBeNull()
    expect(parseStoredConnection(JSON.stringify(null))).toBeNull()
  })

  it('rejects when host is missing or wrong type', () => {
    const { host: _host, ...rest } = valid
    expect(parseStoredConnection(JSON.stringify(rest))).toBeNull()
    expect(parseStoredConnection(JSON.stringify({ ...valid, host: 1 }))).toBeNull()
  })

  it('rejects when port is missing or wrong type', () => {
    const { port: _port, ...rest } = valid
    expect(parseStoredConnection(JSON.stringify(rest))).toBeNull()
    expect(parseStoredConnection(JSON.stringify({ ...valid, port: 22 }))).toBeNull()
  })

  it('rejects when username is missing or wrong type', () => {
    const { username: _username, ...rest } = valid
    expect(parseStoredConnection(JSON.stringify(rest))).toBeNull()
    expect(parseStoredConnection(JSON.stringify({ ...valid, username: null }))).toBeNull()
  })

  it('rejects when authMethod is missing or an invalid enum value', () => {
    const { authMethod: _authMethod, ...rest } = valid
    expect(parseStoredConnection(JSON.stringify(rest))).toBeNull()
    expect(parseStoredConnection(JSON.stringify({ ...valid, authMethod: 'otp' }))).toBeNull()
  })

  it('rejects when privateKeyPath is missing or wrong type', () => {
    const { privateKeyPath: _privateKeyPath, ...rest } = valid
    expect(parseStoredConnection(JSON.stringify(rest))).toBeNull()
    expect(parseStoredConnection(JSON.stringify({ ...valid, privateKeyPath: 5 }))).toBeNull()
  })

  it('rejects when profileId is missing or wrong type', () => {
    const { profileId: _profileId, ...rest } = valid
    expect(parseStoredConnection(JSON.stringify(rest))).toBeNull()
    expect(parseStoredConnection(JSON.stringify({ ...valid, profileId: 5 }))).toBeNull()
  })
})
