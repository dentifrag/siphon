import { describe, expect, it } from 'vitest'
import { helpText, rcloneAssetName } from '../src/server/rclone/binary'

describe('rcloneAssetName', () => {
  it('maps the current platform to an rclone release archive name', () => {
    expect(rcloneAssetName()).toMatch(/^rclone-current-(windows|osx|linux)-(amd64|arm64|arm-v7)\.zip$/)
  })
})

describe('helpText', () => {
  it('states the reason and lists the three ways to provide rclone', () => {
    const text = helpText('the automatic download timed out')
    expect(text).toContain('the automatic download timed out')
    expect(text).toContain('RCLONE_PATH')
    expect(text).toContain('brew install rclone')
    expect(text).toContain('same folder as Siphon')
    expect(text).not.toContain('undefined')
  })
})
