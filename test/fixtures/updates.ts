import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { vi } from 'vitest'
import type { TransferProgress } from '../../src/shared/types'
import { createUpdateCoordinator } from '../../src/server/updates'

export const currentVersion = '1.0.2'
export const sha256 = 'a'.repeat(64)
export const releaseBase = 'https://github.com/dentifrag/siphon/releases/download/1.10.0'
export const latestUrl = 'https://api.github.com/repos/dentifrag/siphon/releases/latest'
export const assetName = 'siphon-win-x64.exe'
export const manifestName = 'siphon-win-x64.update.json'

export function releaseFixture(tag = '1.10.0') {
  const base = `https://github.com/dentifrag/siphon/releases/download/${tag}`
  return {
    id: 42,
    tag_name: tag,
    html_url: `https://github.com/dentifrag/siphon/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: [
      { id: 43, name: assetName, size: 100, browser_download_url: `${base}/${assetName}` },
      { id: 44, name: manifestName, size: 256, browser_download_url: `${base}/${manifestName}` }
    ]
  }
}

export function manifestFixture(version = '1.10.0') {
  return { protocolVersion: 1, version, assetName, sizeBytes: 100, sha256 }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export async function testDirectory() {
  const root = resolve('test', 'fixtures', '.update-runtime')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'case-'))
  return {
    dir,
    async dispose() {
      await rm(dir, { recursive: true, force: true })
      await rmdir(root).catch(() => undefined)
    }
  }
}

export function releaseNetwork() {
  return vi.fn<typeof fetch>(async (url) => {
    if (String(url) === latestUrl) return Response.json(releaseFixture())
    if (String(url) === `${releaseBase}/${manifestName}`) {
      return Response.json(manifestFixture())
    }
    throw new Error(`Unexpected update network request: ${String(url)}`)
  })
}

export async function coordinatorFixture(
  stateDir: string,
  overrides: Partial<Parameters<typeof createUpdateCoordinator>[0]> = {}
) {
  const fetch = releaseNetwork()
  const schedule = vi.fn<(request: unknown) => Promise<void>>(async () => undefined)
  const transfers: TransferProgress[] = []
  const options = {
    currentVersion,
    stateDir,
    capability: { supported: true as const },
    listTransfers: () => transfers,
    fetch,
    schedule,
    ...overrides
  }
  const updates = await createUpdateCoordinator(options)
  return { updates, fetch, schedule, transfers, options }
}
