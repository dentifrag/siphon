import { mkdir, readdir, realpath } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { DownloadRoot } from './config'

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
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function resolvePath(scope: FsScope, candidate: string): Promise<string | null> {
  if (!candidate || candidate.includes('\0')) return null
  if (!scope.confined) {
    if (!isAbsolute(candidate)) return null
    return canonicalize(candidate)
  }
  for (const root of scope.roots) {
    const base = isAbsolute(candidate) ? candidate : resolve(root.path, candidate)
    const canonicalBase = await canonicalize(base)
    const canonicalRoot = await canonicalize(root.path)
    if (isInside(canonicalRoot, canonicalBase)) return canonicalBase
  }
  return null
}

async function canonicalize(path: string): Promise<string> {
  let existing = path
  const tail: string[] = []
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..')
    if (parent === existing) break
    tail.unshift(existing.slice(parent.length + 1))
    existing = parent
  }
  try {
    const real = await realpath(existing)
    return tail.length ? join(real, ...tail) : real
  } catch {
    return path
  }
}

export async function listDirs(
  scope: FsScope,
  requested: string | undefined,
  fallbackDir: string
): Promise<LocalDirListing> {
  const target = requested && requested.trim() !== '' ? requested : fallbackDir
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

  const entries: LocalEntry[] = dirents
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink() || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: join(canonical, entry.name),
      isDir: entry.isDirectory() || entry.isSymbolicLink()
    }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))

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
  if (!cleanName || /[\\/\0]/.test(cleanName) || cleanName === '.' || cleanName === '..') {
    throw new Error('Invalid folder name.')
  }
  const canonicalParent = await resolvePath(scope, parentPath)
  if (canonicalParent === null) throw new Error('That folder is not accessible.')
  const target = join(canonicalParent, cleanName)
  const canonicalTarget = await resolvePath(scope, target)
  if (canonicalTarget === null) throw new Error('That folder is not accessible.')
  await mkdir(canonicalTarget, { recursive: true })
  return canonicalTarget
}

async function isConfiguredRoot(roots: DownloadRoot[], canonical: string): Promise<boolean> {
  for (const root of roots) {
    if ((await canonicalize(root.path)) === canonical) return true
  }
  return false
}
