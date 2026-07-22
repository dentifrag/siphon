import { mkdir, readdir, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { DownloadRoot } from './config'

export interface LocalDirEntry {
  name: string
  path: string
}

export interface LocalDirListing {
  path: string
  parent: string | null
  dirs: LocalDirEntry[]
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
  const canonical = await resolvePath(scope, target)
  if (canonical === null) throw new Error('That folder is not accessible.')

  const entries = await readdir(canonical, { withFileTypes: true })
  const dirs: LocalDirEntry[] = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: join(canonical, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { path: canonical, parent: await parentOf(scope, canonical), dirs }
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
