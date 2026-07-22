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

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function resolveWithinRoots(
  roots: DownloadRoot[],
  candidate: string
): Promise<string | null> {
  if (!candidate || candidate.includes('\0')) return null
  for (const root of roots) {
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
  roots: DownloadRoot[],
  requested: string | undefined
): Promise<LocalDirListing> {
  const target = requested && requested.trim() !== '' ? requested : roots[0].path
  const canonical = await resolveWithinRoots(roots, target)
  if (canonical === null) throw new Error('Path is outside the allowed download roots.')

  const entries = await readdir(canonical, { withFileTypes: true })
  const dirs: LocalDirEntry[] = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: join(canonical, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const isRoot = await isConfiguredRoot(roots, canonical)
  const parent = isRoot ? null : resolve(canonical, '..')
  const safeParent = parent ? await resolveWithinRoots(roots, parent) : null

  return { path: canonical, parent: safeParent, dirs }
}

export async function makeDir(
  roots: DownloadRoot[],
  parentPath: string,
  name: string
): Promise<string> {
  const cleanName = name.trim()
  if (!cleanName || /[\\/\0]/.test(cleanName) || cleanName === '.' || cleanName === '..') {
    throw new Error('Invalid folder name.')
  }
  const canonicalParent = await resolveWithinRoots(roots, parentPath)
  if (canonicalParent === null) throw new Error('Path is outside the allowed download roots.')
  const target = join(canonicalParent, cleanName)
  const canonicalTarget = await resolveWithinRoots(roots, target)
  if (canonicalTarget === null) throw new Error('Path is outside the allowed download roots.')
  await mkdir(canonicalTarget, { recursive: true })
  return canonicalTarget
}

async function isConfiguredRoot(roots: DownloadRoot[], canonical: string): Promise<boolean> {
  for (const root of roots) {
    if ((await canonicalize(root.path)) === canonical) return true
  }
  return false
}
