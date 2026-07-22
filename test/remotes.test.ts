import { describe, expect, it } from 'vitest'
import { sanitizeRemoteName } from '../src/server/rclone/remotes'

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
