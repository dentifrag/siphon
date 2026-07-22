import { describe, expect, it } from 'vitest'
import { sftpParameters } from '../src/server/rclone/remotes'

describe('sftpParameters', () => {
  it('disables the SSH shell/hash probe that stalls SFTP-only servers', () => {
    const params = sftpParameters({
      host: 'nas.local',
      port: 22,
      username: 'me',
      authMethod: 'password',
      password: 'pw'
    })
    expect(params.shell_type).toBe('none')
    expect(params.disable_hashcheck).toBe('true')
  })

  it('maps password auth to pass and omits key fields', () => {
    const params = sftpParameters({
      host: 'h',
      port: 2222,
      username: 'u',
      authMethod: 'password',
      password: 'secret'
    })
    expect(params.pass).toBe('secret')
    expect(params.port).toBe('2222')
    expect(params.key_file).toBeUndefined()
  })

  it('maps private-key auth to key_file and passphrase', () => {
    const params = sftpParameters({
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'privateKey',
      privateKeyPath: '/home/u/.ssh/id_ed25519',
      passphrase: 'ppp'
    })
    expect(params.key_file).toBe('/home/u/.ssh/id_ed25519')
    expect(params.key_file_pass).toBe('ppp')
    expect(params.pass).toBeUndefined()
  })
})
