import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirs, makeDir, resolveWithinRoots } from '../src/server/localFs'
import type { DownloadRoot } from '../src/server/config'

let base: string
let roots: DownloadRoot[]

beforeAll(() => {
  // realpath so symlinked temp roots (e.g. macOS /var -> /private/var) match the
  // canonical paths the module returns.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'seg-roots-')))
  mkdirSync(join(base, 'driveA', 'movies'), { recursive: true })
  mkdirSync(join(base, 'driveB'), { recursive: true })
  writeFileSync(join(base, 'driveA', 'file.txt'), 'x')
  roots = [
    { name: 'A', path: join(base, 'driveA') },
    { name: 'B', path: join(base, 'driveB') }
  ]
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('resolveWithinRoots', () => {
  it('accepts a root itself and nested subdirectories', async () => {
    expect(await resolveWithinRoots(roots, join(base, 'driveA'))).toBe(join(base, 'driveA'))
    expect(await resolveWithinRoots(roots, join(base, 'driveA', 'movies'))).toBe(
      join(base, 'driveA', 'movies')
    )
  })

  it('accepts paths inside any configured root', async () => {
    expect(await resolveWithinRoots(roots, join(base, 'driveB'))).toBe(join(base, 'driveB'))
  })

  it('rejects paths outside every root', async () => {
    expect(await resolveWithinRoots(roots, base)).toBeNull()
    expect(await resolveWithinRoots(roots, '/etc')).toBeNull()
  })

  it('rejects traversal escapes', async () => {
    expect(await resolveWithinRoots(roots, join(base, 'driveA', '..', '..', 'etc'))).toBeNull()
    expect(await resolveWithinRoots(roots, join(base, 'driveA', '..', 'driveA-secret'))).toBeNull()
  })

  it('rejects null bytes', async () => {
    expect(await resolveWithinRoots(roots, `${join(base, 'driveA')}\0/x`)).toBeNull()
  })
})

describe('listDirs', () => {
  it('lists only subdirectories and reports parent within the root', async () => {
    const listing = await listDirs(roots, join(base, 'driveA'))
    expect(listing.dirs.map((d) => d.name)).toEqual(['movies'])
    // driveA is a root, so no parent is exposed.
    expect(listing.parent).toBeNull()
  })

  it('exposes a parent only while it stays within a root', async () => {
    const listing = await listDirs(roots, join(base, 'driveA', 'movies'))
    expect(listing.parent).toBe(join(base, 'driveA'))
  })

  it('throws for a path outside the roots', async () => {
    await expect(listDirs(roots, '/etc')).rejects.toThrow()
  })
})

describe('makeDir', () => {
  it('creates a nested folder inside a root', async () => {
    const created = await makeDir(roots, join(base, 'driveB'), 'new')
    expect(created).toBe(join(base, 'driveB', 'new'))
  })

  it('rejects names containing separators', async () => {
    await expect(makeDir(roots, join(base, 'driveB'), '../escape')).rejects.toThrow()
    await expect(makeDir(roots, join(base, 'driveB'), 'a/b')).rejects.toThrow()
  })

  it('rejects creating under a path outside the roots', async () => {
    await expect(makeDir(roots, base, 'x')).rejects.toThrow()
  })
})
