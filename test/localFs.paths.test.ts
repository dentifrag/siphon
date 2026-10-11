import { join, parse, sep } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mocked so canonicalization can be driven deterministically without touching
// the real filesystem or creating any real directories (no root writes).
const existsSyncMock = vi.fn()
const realpathMock = vi.fn()
const mkdirMock = vi.fn()

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: (...args: unknown[]) => existsSyncMock(...args) }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: (...args: unknown[]) => realpathMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args)
  }
})

import { resolvePath, makeDir, type FsScope } from '../src/server/localFs'

// Derived natively (win32 "C:\\", POSIX "/") instead of a hardcoded drive
// literal, so the bug reproduction holds on any platform this runs on.
const ROOT = parse(process.cwd()).root

beforeEach(() => {
  existsSyncMock.mockReset()
  realpathMock.mockReset()
  mkdirMock.mockReset()
  // Only the root itself exists; every deeper path is "new".
  existsSyncMock.mockImplementation((p: string) => p === ROOT)
  realpathMock.mockImplementation(async (p: string) => p)
})

describe('localFs canonicalization directly under the filesystem root', () => {
  it('[principal] preserves every character of a brand-new path one level under the root', async () => {
    const result = await resolvePath({ roots: [], confined: false }, `${ROOT}newfolder`)

    // canonicalize() computes parent.length + 1 to strip the separator between
    // parent and child, but when parent IS the root, the root already ends in
    // the separator, so the "+1" strips one real character too many.
    expect(result).toBe(join(ROOT, 'newfolder'))
  })

  it('[principal] also loses a character when the new root-adjacent path has a trailing separator', async () => {
    const result = await resolvePath({ roots: [], confined: false }, `${ROOT}newfolder${sep}`)

    // Expected form is the normalized canonical path (no trailing separator);
    // today's output both loses a character AND retains the trailing separator.
    expect(result).toBe(join(ROOT, 'newfolder'))
  })

  it('[principal] loses an entire path segment for a brand-new nested path under the root', async () => {
    const result = await resolvePath({ roots: [], confined: false }, join(ROOT, 'a', 'b'))

    expect(result).toBe(join(ROOT, 'a', 'b'))
  })

  it('[principal] miscomputes the mkdir target for a brand-new folder directly under a confined root', async () => {
    mkdirMock.mockResolvedValue(undefined)
    const scope: FsScope = { confined: true, roots: [{ name: 'Root', path: ROOT }] }

    const created = await makeDir(scope, ROOT, 'newfolder')

    const expectedTarget = join(ROOT, 'newfolder')
    expect(created).toBe(expectedTarget)
    expect(mkdirMock).toHaveBeenCalledWith(expectedTarget, { recursive: true })
  })

  it('[control] a redundant separator between the root and a new path segment already canonicalizes correctly', async () => {
    // A doubled separator (root already ends in one, plus an explicit extra)
    // happens to normalize away cleanly in path.resolve's parent computation,
    // so this must keep working once the off-by-one above is fixed.
    const result = await resolvePath({ roots: [], confined: false }, `${ROOT}${sep}newfolder`)

    expect(result).toBe(join(ROOT, 'newfolder'))
  })

  it('[control] preserves every character for a new path nested under an existing non-root ancestor', async () => {
    const ancestor = join(ROOT, 'Users', 'you')
    existsSyncMock.mockImplementation((p: string) => p === ROOT || p === ancestor)

    const result = await resolvePath({ roots: [], confined: false }, join(ancestor, 'newfolder'))

    expect(result).toBe(join(ancestor, 'newfolder'))
  })

  it('[control] a confined root that already exists resolves to itself unchanged', async () => {
    const scope: FsScope = { confined: true, roots: [{ name: 'Root', path: ROOT }] }

    const result = await resolvePath(scope, ROOT)

    expect(result).toBe(ROOT)
  })
})
