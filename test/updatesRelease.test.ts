import { describe, expect, it } from 'vitest'
import { validateUpdateRelease } from '../src/server/updates'
import { assetName, manifestFixture, releaseFixture, sha256 } from './fixtures/updates'

describe('Windows release validation', () => {
  it.each(['1.10.0', 'v1.10.0'])('pins the official stable %s release numerically', (tag) => {
    expect(
      validateUpdateRelease({
        release: releaseFixture(tag),
        manifest: manifestFixture(),
        currentVersion: '1.9.0'
      })
    ).toMatchObject({
      version: '1.10.0',
      releaseTag: tag,
      protocolVersion: 1,
      assetName,
      assetUrl: `https://github.com/dentifrag/siphon/releases/download/${tag}/${assetName}`,
      sizeBytes: 100,
      sha256
    })
  })

  it.each(['1.10.0', '1.11.0'])('does not offer an upgrade from %s to 1.10.0', (installed) => {
    expect(
      validateUpdateRelease({
        release: releaseFixture(),
        manifest: manifestFixture(),
        currentVersion: installed
      })
    ).toBeNull()
  })

  it.each([
    ['prerelease tag', { tag_name: 'v1.10.0-rc.1' }, {}],
    ['non-semver tag', { tag_name: 'latest' }, {}],
    ['prerelease release', { prerelease: true }, {}],
    ['draft release', { draft: true }, {}],
    ['foreign repository', { html_url: 'https://github.com/other/siphon/releases/tag/1.10.0' }, {}],
    ['missing Windows assets', { assets: [] }, {}],
    ['unsupported protocol', {}, { protocolVersion: 2 }],
    ['version mismatch', {}, { version: '1.10.1' }],
    ['wrong executable', {}, { assetName: 'siphon-linux-x64' }],
    ['asset size mismatch', {}, { sizeBytes: 101 }],
    ['invalid digest', {}, { sha256: 'not-a-sha256' }],
    ['missing digest', {}, { sha256: undefined }]
  ])(
    'rejects %s instead of publishing an installable offer',
    (_name, releasePatch, manifestPatch) => {
      expect(() =>
        validateUpdateRelease({
          release: { ...releaseFixture(), ...releasePatch },
          manifest: { ...manifestFixture(), ...manifestPatch },
          currentVersion: '1.0.2'
        })
      ).toThrow()
    }
  )

  it('rejects a redirected/foreign asset identity and duplicate executable names', () => {
    const release = releaseFixture()
    for (const assets of [
      [
        { ...release.assets[0], browser_download_url: 'https://evil.example/siphon-win-x64.exe' },
        release.assets[1]
      ],
      [
        release.assets[0],
        { ...release.assets[1], browser_download_url: 'https://evil.example/manifest.json' }
      ],
      [...release.assets, release.assets[0]]
    ]) {
      expect(() =>
        validateUpdateRelease({
          release: { ...release, assets },
          manifest: manifestFixture(),
          currentVersion: '1.0.2'
        })
      ).toThrow()
    }
  })
})
