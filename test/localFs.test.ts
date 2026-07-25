import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listDirs,
  listFilesRecursive,
  makeDir,
  resolvePath,
  type FsScope
} from '../src/server/localFs'

let base: string
let confined: FsScope
let open: FsScope

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'siphon-roots-')))
  mkdirSync(join(base, 'driveA', 'movies'), { recursive: true })
  mkdirSync(join(base, 'driveB'), { recursive: true })
  writeFileSync(join(base, 'driveA', 'file.txt'), 'x')
  confined = {
    confined: true,
    roots: [
      { name: 'A', path: join(base, 'driveA') },
      { name: 'B', path: join(base, 'driveB') }
    ]
  }
  open = { confined: false, roots: [{ name: 'Home', path: base }] }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('resolvePath (confined)', () => {
  it('accepts a root and nested subdirectories', async () => {
    expect(await resolvePath(confined, join(base, 'driveA'))).toBe(join(base, 'driveA'))
    expect(await resolvePath(confined, join(base, 'driveA', 'movies'))).toBe(
      join(base, 'driveA', 'movies')
    )
  })

  it('rejects paths outside every root', async () => {
    expect(await resolvePath(confined, base)).toBeNull()
    expect(await resolvePath(confined, '/etc')).toBeNull()
  })

  it('rejects traversal escapes', async () => {
    expect(await resolvePath(confined, join(base, 'driveA', '..', '..', 'etc'))).toBeNull()
  })

  it('rejects null bytes', async () => {
    expect(await resolvePath(confined, `${join(base, 'driveA')}\0/x`)).toBeNull()
  })
})

describe('resolvePath (unconfined)', () => {
  it('accepts any absolute path and canonicalizes it', async () => {
    expect(await resolvePath(open, join(base, 'driveA'))).toBe(join(base, 'driveA'))
    expect(await resolvePath(open, base)).toBe(base)
  })

  it('still rejects relative paths and null bytes', async () => {
    expect(await resolvePath(open, 'relative/path')).toBeNull()
    expect(await resolvePath(open, `${base}\0`)).toBeNull()
  })
})

describe('listDirs', () => {
  it('lists directories and files, directories first, and hides the parent at a configured root', async () => {
    const listing = await listDirs(confined, join(base, 'driveA'), join(base, 'driveA'))
    expect(listing.entries.map((e) => ({ name: e.name, isDir: e.isDir }))).toEqual([
      { name: 'movies', isDir: true },
      { name: 'file.txt', isDir: false }
    ])
    expect(listing.parent).toBeNull()
  })

  it('exposes a parent while it stays within a root', async () => {
    const listing = await listDirs(confined, join(base, 'driveA', 'movies'), join(base, 'driveA'))
    expect(listing.parent).toBe(join(base, 'driveA'))
  })

  it('falls back to the fallback folder when the requested path is outside the roots when confined', async () => {
    const listing = await listDirs(confined, '/etc', join(base, 'driveA'))
    expect(listing.path).toBe(join(base, 'driveA'))
  })

  it('throws when both requested and fallback paths are outside the roots when confined', async () => {
    await expect(listDirs(confined, '/etc', '/etc')).rejects.toThrow()
  })

  it('walks upward past the roots when unconfined', async () => {
    const listing = await listDirs(open, join(base, 'driveA'), base)
    expect(listing.parent).toBe(base)
  })

  it('falls back to an existing ancestor when the target folder is missing', async () => {
    const missing = join(base, 'driveA', 'gone', 'deeper')
    const listing = await listDirs(open, missing, base)
    expect(listing.path).toBe(join(base, 'driveA'))
    expect(existsSync(listing.path)).toBe(true)
  })
})

describe('makeDir', () => {
  it('creates a nested folder inside a root', async () => {
    const created = await makeDir(confined, join(base, 'driveB'), 'new')
    expect(created).toBe(join(base, 'driveB', 'new'))
  })

  it('rejects names containing separators', async () => {
    await expect(makeDir(confined, join(base, 'driveB'), '../escape')).rejects.toThrow()
    await expect(makeDir(confined, join(base, 'driveB'), 'a/b')).rejects.toThrow()
  })

  it('rejects creating under a path outside the roots when confined', async () => {
    await expect(makeDir(confined, base, 'x')).rejects.toThrow()
  })
})

describe('listFilesRecursive', () => {
  it('returns relative paths and sizes for a nested tree, skipping symlinks', async () => {
    const uploadRoot = mkdtempSync(join(tmpdir(), 'siphon-upload-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'siphon-outside-'))
    let symlinksCreated = true
    try {
      mkdirSync(join(uploadRoot, 'sub'), { recursive: true })
      writeFileSync(join(uploadRoot, 'a.txt'), '12345')
      writeFileSync(join(uploadRoot, 'sub', 'b.txt'), '1234567890')
      writeFileSync(join(outsideRoot, 'secret.txt'), 'shh')
      try {
        symlinkSync(join(outsideRoot, 'secret.txt'), join(uploadRoot, 'escape.txt'))
        symlinkSync(outsideRoot, join(uploadRoot, 'escape-dir'))
      } catch {
        // Creating symlinks needs elevated permissions / Developer Mode on Windows.
        symlinksCreated = false
      }

      const files = await listFilesRecursive(uploadRoot)

      expect(files.sort((a, b) => a.relPath.localeCompare(b.relPath))).toEqual([
        { relPath: 'a.txt', size: 5 },
        { relPath: 'sub/b.txt', size: 10 }
      ])
      if (symlinksCreated) {
        expect(files.some((f) => f.relPath.includes('escape'))).toBe(false)
      }
    } finally {
      rmSync(uploadRoot, { recursive: true, force: true })
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })
})
