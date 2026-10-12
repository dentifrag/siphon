import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertDestination,
  cleanupDownloadStage,
  createDownloadStage,
  publishDownload,
  snapshotDestination,
  type DownloadStage
} from '../src/server/downloadPublication'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, link: vi.fn(fs.link), rename: vi.fn(fs.rename), open: vi.fn(fs.open) }
})

let root: string
let target: string
let stage: DownloadStage

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), '.collision-publication-test-'))
  target = join(root, 'file.bin')
  stage = await createDownloadStage(target)
  await writeFile(stage.path, 'new bytes')
})

afterEach(async () => {
  vi.mocked(link).mockClear()
  vi.mocked(rename).mockClear()
  vi.mocked(open).mockClear()
  await rm(root, { recursive: true, force: true })
})

describe('exclusive download publication', () => {
  it('publishes a new target and cleans staging only after publication', async () => {
    expect(await publishDownload(stage, target, { kind: 'absent' }, () => false)).toBe(true)
    await cleanupDownloadStage(stage)
    expect(await readFile(target, 'utf8')).toBe('new bytes')
    await expect(lstat(stage.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails rather than overwriting a file created immediately before the exclusive link', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      await writeFile(target, 'late external file')
      await actual.link(source, destination)
    })
    await expect(
      publishDownload(stage, target, { kind: 'absent' }, () => false)
    ).rejects.toMatchObject({ code: 'DESTINATION_CHANGED', statusCode: 409 })
    expect(await readFile(target, 'utf8')).toBe('late external file')
    await cleanupDownloadStage(stage)
  })

  it('copies approved same-size/mtime different bytes and retains the previous file', async () => {
    await writeFile(target, 'old bytes')
    const timestamp = new Date('2026-01-01T00:00:00Z')
    await utimes(target, timestamp, timestamp)
    await utimes(stage.path, timestamp, timestamp)
    const approved = await snapshotDestination(target)
    expect(await publishDownload(stage, target, approved, () => false)).toBe(true)
    await cleanupDownloadStage(stage)
    expect(await readFile(target, 'utf8')).toBe('new bytes')
    expect(await readFile(stage.recoveryPath!, 'utf8')).toBe('old bytes')
    await expect(lstat(stage.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects changed overwrite approval before displacement', async () => {
    await writeFile(target, 'old bytes')
    const approved = await snapshotDestination(target)
    await writeFile(target, 'different')
    await expect(publishDownload(stage, target, approved, () => false)).rejects.toMatchObject({
      code: 'DESTINATION_CHANGED'
    })
    expect(rename).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe('different')
  })

  it('preserves and restores a target changed between verification and displacement', async () => {
    await writeFile(target, 'old bytes')
    const approved = await snapshotDestination(target)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await writeFile(target, 'racing change')
      await actual.rename(source, destination)
    })
    await expect(publishDownload(stage, target, approved, () => false)).rejects.toMatchObject({
      code: 'DESTINATION_CHANGED'
    })
    expect(await readFile(target, 'utf8')).toBe('racing change')
    expect(await readFile(stage.recoveryPath!, 'utf8')).toBe('racing change')
  })

  it('does not overwrite a new target appearing after displacement; both originals survive', async () => {
    await writeFile(target, 'old bytes')
    const approved = await snapshotDestination(target)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(link).mockImplementationOnce(actual.link)
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      await writeFile(target, 'late new target')
      await actual.link(source, destination)
    })
    await expect(publishDownload(stage, target, approved, () => false)).rejects.toMatchObject({
      code: 'DESTINATION_CHANGED'
    })
    await cleanupDownloadStage(stage)
    expect(await readFile(target, 'utf8')).toBe('late new target')
    expect(await readFile(stage.recoveryPath!, 'utf8')).toBe('old bytes')
  })

  it('retains writes through an old open handle even after a successful overwrite', async () => {
    await writeFile(target, 'old bytes')
    const approved = await snapshotDestination(target)
    const external = await open(target, 'r+')
    try {
      expect(await publishDownload(stage, target, approved, () => false)).toBe(true)
      await cleanupDownloadStage(stage)
      await external.write('late data', 0, 'utf8')
      expect(await readFile(target, 'utf8')).toBe('new bytes')
      expect(await readFile(stage.recoveryPath!, 'utf8')).toBe('late data')
    } finally {
      await external.close()
    }
  })

  it('restores the displaced file when canceled during displacement', async () => {
    await writeFile(target, 'old bytes')
    const approved = await snapshotDestination(target)
    let canceled = false
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await actual.rename(source, destination)
      canceled = true
    })
    expect(await publishDownload(stage, target, approved, () => canceled)).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('old bytes')
    await cleanupDownloadStage(stage)
    expect(await readFile(stage.recoveryPath!, 'utf8')).toBe('old bytes')
  })

  it('does not touch a destination when canceled before publication', async () => {
    expect(await publishDownload(stage, target, { kind: 'absent' }, () => true)).toBe(false)
    expect(link).not.toHaveBeenCalled()
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails safely on filesystems without exclusive hard links, with no rename fallback', async () => {
    vi.mocked(link).mockRejectedValueOnce(
      Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' })
    )
    await expect(
      publishDownload(stage, target, { kind: 'absent' }, () => false)
    ).rejects.toMatchObject({ code: 'PUBLICATION_UNSUPPORTED', statusCode: 409 })
    expect(rename).not.toHaveBeenCalled()
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves recovery content when the filesystem cannot restore a displaced target', async () => {
    await writeFile(target, 'old bytes')
    const approved = await snapshotDestination(target)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(link).mockImplementationOnce(actual.link)
    vi.mocked(link).mockRejectedValueOnce(
      Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' })
    )
    vi.mocked(link).mockRejectedValueOnce(
      Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' })
    )
    await expect(publishDownload(stage, target, approved, () => false)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED'
    })
    await cleanupDownloadStage(stage)
    expect(await readFile(stage.recoveryPath!, 'utf8')).toBe('old bytes')
  })

  it('does not displace an approved target when the hard-link capability probe fails', async () => {
    await writeFile(target, 'old bytes')
    const approved = await snapshotDestination(target)
    vi.mocked(link).mockRejectedValueOnce(
      Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' })
    )
    await expect(publishDownload(stage, target, approved, () => false)).rejects.toMatchObject({
      code: 'PUBLICATION_UNSUPPORTED'
    })
    expect(rename).not.toHaveBeenCalled()
    expect(stage.recoveryPath).toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('old bytes')
  })

  it('attempts non-destructive restoration if verification of the displaced file throws', async () => {
    await writeFile(target, 'old bytes')
    const approved = await snapshotDestination(target)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(actual.open)
    vi.mocked(open).mockImplementationOnce(actual.open)
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error('Read denied'), { code: 'EACCES' })
    )
    await expect(publishDownload(stage, target, approved, () => false)).rejects.toMatchObject({
      code: 'PUBLICATION_UNSUPPORTED'
    })
    expect(await readFile(target, 'utf8')).toBe('old bytes')
    expect(await readFile(stage.recoveryPath!, 'utf8')).toBe('old bytes')
  })

  it('rejects file-vs-directory conflicts without converting the destination type', async () => {
    await mkdir(target)
    const snapshot = await snapshotDestination(target)
    expect(snapshot.kind).toBe('blocked')
    await expect(assertDestination(target, snapshot)).rejects.toMatchObject({
      code: 'DESTINATION_CHANGED'
    })
    expect((await lstat(target)).isDirectory()).toBe(true)
    expect(rename).not.toHaveBeenCalled()
  })
})
