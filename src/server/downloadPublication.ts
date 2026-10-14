import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, mkdir, mkdtemp, link, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { httpError } from './http'

export type DestinationSnapshot =
  | { kind: 'absent' }
  | { kind: 'blocked'; path: string }
  | { kind: 'file'; identity: string; digest: string }

export interface DownloadStage {
  directory: string
  path: string
  recoveryPath?: string
}

export async function inspectDownloadDirectory(path: string): Promise<boolean> {
  return (await snapshotContainer(path)) === null
}

function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

export async function snapshotDestination(path: string): Promise<DestinationSnapshot> {
  let stat
  try {
    stat = await lstat(path, { bigint: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    const parent = dirname(path)
    if (parent !== path) {
      const ancestor = await snapshotContainer(parent)
      if (ancestor) return { kind: 'blocked', path: ancestor }
    }
    return { kind: 'absent' }
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: 'blocked', path }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || identity(before) !== identity(stat)) throw destinationChanged()
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await handle.stat({ bigint: true })
    if (identity(before) !== identity(after)) throw destinationChanged()
    return { kind: 'file', identity: identity(after), digest: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function snapshotContainer(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return path
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  const parent = dirname(path)
  return parent === path ? null : snapshotContainer(parent)
}

export function sameDestination(a: DestinationSnapshot, b: DestinationSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function destinationChanged(): Error {
  return httpError(
    409,
    'The download destination changed. Existing content was preserved; download again to review the collision.',
    'DESTINATION_CHANGED'
  )
}

export async function assertDestination(
  path: string,
  approved: DestinationSnapshot
): Promise<void> {
  if (approved.kind === 'blocked' || !sameDestination(approved, await snapshotDestination(path))) {
    throw destinationChanged()
  }
}

export async function createDownloadStage(path: string): Promise<DownloadStage> {
  await mkdir(dirname(path), { recursive: true })
  const directory = await mkdtemp(join(dirname(path), '.siphon-download-'))
  return { directory, path: join(directory, 'payload') }
}

export async function publishDownload(
  stage: DownloadStage,
  path: string,
  approved: DestinationSnapshot,
  canceled: () => boolean
): Promise<boolean> {
  const payload = await lstat(stage.path)
  if (!payload.isFile() || payload.isSymbolicLink()) {
    throw httpError(
      500,
      'The finished download did not produce a regular staged file.',
      'DOWNLOAD_STAGE_INVALID'
    )
  }
  await assertDestination(path, approved)
  if (canceled()) return false
  if (approved.kind === 'file') {
    const probe = join(stage.directory, 'publication-check')
    try {
      await link(stage.path, probe)
      await rm(probe)
    } catch (error) {
      throw unsupportedPublication(error)
    }
    await assertDestination(path, approved)
    if (canceled()) return false
  }
  try {
    if (approved.kind === 'file') {
      // Retain the displaced object even after success: an external writer may still
      // hold an open handle, so deleting a "verified" backup would lose later writes.
      const recovery = join(stage.directory, 'previous')
      await rename(path, recovery)
      stage.recoveryPath = recovery
      const moved = await snapshotDestination(recovery)
      const matches =
        moved.kind === 'file' &&
        approved.digest === moved.digest &&
        approved.identity.split(':').slice(0, 4).join(':') ===
          moved.identity.split(':').slice(0, 4).join(':')
      if (!matches) throw destinationChanged()
    }
    if (canceled()) {
      if (stage.recoveryPath) await restoreDisplaced(stage, path)
      return false
    }
    await link(stage.path, path)
    // Publication is the commit point; a later cancellation cannot safely unlink this name.
    return true
  } catch (error) {
    if (stage.recoveryPath) await restoreDisplaced(stage, path)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOENT') throw destinationChanged()
    if (error instanceof Error && 'statusCode' in error) throw error
    throw unsupportedPublication(error)
  }
}

function unsupportedPublication(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code
  return httpError(
    409,
    `This filesystem could not publish the download without replacing another file (${code ?? 'unknown error'}). Existing content was preserved.`,
    'PUBLICATION_UNSUPPORTED'
  )
}

async function restoreDisplaced(stage: DownloadStage, path: string): Promise<void> {
  if (!stage.recoveryPath) return
  try {
    await link(stage.recoveryPath, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw httpError(
        409,
        `The displaced destination is preserved at ${stage.recoveryPath}; automatic restoration was not possible.`,
        'RECOVERY_REQUIRED'
      )
    }
  }
}

export async function cleanupDownloadStage(stage: DownloadStage): Promise<void> {
  if (!stage.recoveryPath) {
    await rm(stage.directory, { recursive: true, force: true })
    return
  }
  await rm(stage.path, { force: true })
  // Recovery content is deliberately not recursively removed.
  await rmdir(stage.directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
  })
}
