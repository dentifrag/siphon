import { mkdir, readdir, realpath, lstat } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DownloadRoot } from './config'
import { httpError } from './http'
import type { RcloneEnqueueInput } from './rclone/downloadManager'

export interface LocalEntry {
  name: string
  path: string
  isDir: boolean
}

export interface LocalDirListing {
  path: string
  parent: string | null
  entries: LocalEntry[]
}

export interface FsScope {
  roots: DownloadRoot[]
  confined: boolean
  excludedPaths?: string[]
}

export function downloadDestinationKey(path: string): string {
  const normalized = resolve(path)
  if (process.platform === 'darwin') return normalized.normalize('NFC').toLowerCase()
  return process.platform === 'win32'
    ? normalized
        .split(/[\\/]/)
        .map((part) => part.replace(/[ .]+$/, ''))
        .join(sep)
        .toLowerCase()
    : normalized
}

export async function validateDownloadDestination(
  scope: FsScope,
  input: RcloneEnqueueInput,
  resolver: typeof resolvePath = resolvePath
): Promise<string> {
  const canonical = await resolver(scope, join(input.dstFs, input.dstRemote))
  if (!canonical) throw httpError(400, 'That download destination is not accessible.')
  const key = downloadDestinationKey(canonical)
  if (key !== (input.destinationKey ?? downloadDestinationKey(input.localPath))) {
    throw httpError(
      409,
      'The download destination has changed. Remove this transfer and download it again.',
      'DESTINATION_CHANGED'
    )
  }
  return key
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function excludedPath(scope: FsScope, candidate: string): Promise<boolean> {
  if (!scope.excludedPaths?.length) return false
  const canonicalCandidate = await canonicalize(candidate)
  for (const excluded of scope.excludedPaths ?? []) {
    if (
      isInside(resolve(excluded), resolve(candidate)) ||
      isInside(await canonicalize(excluded), canonicalCandidate)
    ) {
      return true
    }
  }
  return false
}

export async function resolvePath(scope: FsScope, candidate: string): Promise<string | null> {
  if (!candidate || candidate.includes('\0')) return null
  if (await excludedPath(scope, resolve(candidate))) return null
  if (!scope.confined) {
    if (!isAbsolute(candidate)) return null
    return canonicalize(candidate)
  }
  for (const root of scope.roots) {
    const base = isAbsolute(candidate) ? candidate : resolve(root.path, candidate)
    const canonicalBase = await canonicalize(base)
    if (await excludedPath(scope, base)) continue
    const canonicalRoot = await canonicalize(root.path)
    if (isInside(canonicalRoot, canonicalBase)) return canonicalBase
  }
  return null
}

async function canonicalize(path: string): Promise<string> {
  const normalized = resolve(path)
  let existing = normalized
  const tail: string[] = []
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..')
    if (parent === existing) break
    tail.unshift(basename(existing))
    existing = parent
  }
  try {
    const real = await realpath(existing)
    return tail.length ? join(real, ...tail) : real
  } catch {
    return normalized
  }
}

export async function listDirs(
  scope: FsScope,
  requested: string | undefined,
  fallbackDir: string
): Promise<LocalDirListing> {
  const target = requested && requested.trim() !== '' ? requested : fallbackDir
  if (await excludedPath(scope, resolve(target))) {
    throw httpError(400, 'That folder is protected and not accessible.')
  }
  let canonical = await resolvePath(scope, target)
  if (canonical === null && target !== fallbackDir) {
    canonical = await resolvePath(scope, fallbackDir)
  }
  if (canonical === null) throw new Error('That folder is not accessible.')

  let dirents: Dirent[]
  try {
    dirents = await readdir(canonical, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      canonical = await firstExistingAncestor(scope, canonical)
      dirents = await readdir(canonical, { withFileTypes: true }).catch((): Dirent[] => [])
    } else if (code === 'EACCES' || code === 'EPERM') {
      return { path: canonical, parent: await parentOf(scope, canonical), entries: [] }
    } else {
      throw err
    }
  }

  const candidates: LocalEntry[] = dirents
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink() || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: join(canonical, entry.name),
      isDir: entry.isDirectory() || entry.isSymbolicLink()
    }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  const entries: LocalEntry[] = []
  for (const entry of candidates) {
    if (!(await excludedPath(scope, entry.path))) entries.push(entry)
  }

  return { path: canonical, parent: await parentOf(scope, canonical), entries }
}

async function firstExistingAncestor(scope: FsScope, start: string): Promise<string> {
  let dir = start
  for (;;) {
    const parent = resolve(dir, '..')
    if (parent === dir) break
    const resolved = await resolvePath(scope, parent)
    if (resolved && existsSync(resolved)) return resolved
    dir = parent
  }
  const home = scope.roots[0]?.path
  return home && existsSync(home) ? home : '/'
}

async function parentOf(scope: FsScope, canonical: string): Promise<string | null> {
  const parent = resolve(canonical, '..')
  if (parent === canonical) return null
  if (scope.confined) {
    if (await isConfiguredRoot(scope.roots, canonical)) return null
    return resolvePath(scope, parent)
  }
  return parent
}

export async function makeDir(scope: FsScope, parentPath: string, name: string): Promise<string> {
  const cleanName = name.trim()
  // eslint-disable-next-line no-control-regex -- intentional: reject NUL and path separators in folder names
  if (!cleanName || /[\\/\0]/.test(cleanName) || cleanName === '.' || cleanName === '..') {
    throw new Error('Invalid folder name.')
  }
  const canonicalParent = await resolvePath(scope, parentPath)
  if (canonicalParent === null) throw httpError(400, 'That folder is not accessible.')
  const target = join(canonicalParent, cleanName)
  const canonicalTarget = await resolvePath(scope, target)
  if (canonicalTarget === null) throw httpError(400, 'That folder is not accessible.')
  await mkdir(canonicalTarget, { recursive: true })
  return canonicalTarget
}

// Caller must pass an already-resolved, confined directory; this walker only skips symlinks
// and does not itself enforce scope.
export async function listFilesRecursive(
  dir: string,
  scope?: FsScope
): Promise<{ relPath: string; size: number }[]> {
  const results: { relPath: string; size: number }[] = []

  async function walk(current: string, relPrefix: string): Promise<void> {
    const dirents = await readdir(current, { withFileTypes: true })
    for (const entry of dirents) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      const entryPath = join(current, entry.name)
      if (scope && !(await resolvePath(scope, entryPath))) continue
      const st = await lstat(entryPath)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        await walk(entryPath, relPath)
      } else if (st.isFile()) {
        results.push({ relPath, size: st.size })
      }
    }
  }

  await walk(dir, '')
  return results
}

async function isConfiguredRoot(roots: DownloadRoot[], canonical: string): Promise<boolean> {
  for (const root of roots) {
    if ((await canonicalize(root.path)) === canonical) return true
  }
  return false
}
