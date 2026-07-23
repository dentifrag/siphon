import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Dialog, FormControl, TextInput } from '@primer/react'
import { ArrowUpIcon, FileDirectoryFillIcon, FileIcon } from '@primer/octicons-react'
import type { DownloadRootMeta, LocalDirListing } from '@shared/api'
import { errorMessage } from '../lib/format'
import { isTextInputFocused } from '../lib/keyboard'

interface FolderPickerProps {
  initialPath: string
  onClose: () => void
  onChoose: (path: string) => void
}

export function FolderPicker(props: FolderPickerProps) {
  const { initialPath, onClose, onChoose } = props
  const [roots, setRoots] = useState<DownloadRootMeta[]>([])
  const [listing, setListing] = useState<LocalDirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)

  const dirs = useMemo(() => listing?.entries.filter((entry) => entry.isDir) ?? [], [listing])
  const focusedPath = focusIndex !== null ? dirs[focusIndex]?.path : undefined

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.browseLocalDirs(path)
      setListing(result)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    window.api.listDownloadRoots().then(setRoots).catch(() => undefined)
    load(initialPath || undefined)
  }, [initialPath, load])

  useEffect(() => {
    setFocusIndex(dirs.length > 0 ? 0 : null)
  }, [dirs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTextInputFocused()) return
      if (dirs.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIndex((i) => Math.min((i ?? -1) + 1, dirs.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIndex((i) => Math.max((i ?? 1) - 1, 0))
      } else if (e.key === 'Enter') {
        const dir = focusIndex !== null ? dirs[focusIndex] : undefined
        if (dir) load(dir.path)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirs, focusIndex, load])

  const createFolder = useCallback(async () => {
    if (!listing || !newFolder || !newFolder.trim()) {
      setNewFolder(null)
      return
    }
    try {
      const created = await window.api.createLocalDir(listing.path, newFolder.trim())
      setNewFolder(null)
      await load(created)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [listing, newFolder, load])

  return (
    <Dialog
      title="Choose download folder"
      width="large"
      onClose={() => onClose()}
      footerButtons={[
        { content: 'Cancel', onClick: () => onClose() },
        {
          content: 'Use this folder',
          buttonType: 'primary',
          disabled: !listing,
          onClick: () => {
            if (listing) onChoose(listing.path)
          }
        }
      ]}
    >
      {roots.length > 1 && (
        <div className="folder-picker__roots">
          {roots.map((root) => (
            <Button
              key={root.path}
              size="small"
              variant="invisible"
              onClick={() => load(root.path)}
            >
              {root.name}
            </Button>
          ))}
        </div>
      )}

      <div className="folder-picker__bar">
        <Button
          size="small"
          leadingVisual={ArrowUpIcon}
          disabled={!listing || listing.parent === null || loading}
          onClick={() => listing?.parent && load(listing.parent)}
        >
          Up
        </Button>
        <span className="folder-picker__path" title={listing?.path ?? ''}>
          {listing?.path ?? '…'}
        </span>
        <Button
          size="small"
          disabled={!listing || loading}
          onClick={() => setNewFolder('')}
        >
          New folder
        </Button>
      </div>

      {newFolder !== null && (
        <div className="folder-picker__newfolder">
          <FormControl className="form-field--grow">
            <FormControl.Label visuallyHidden>Folder name</FormControl.Label>
            <TextInput
              block
              autoFocus
              value={newFolder}
              placeholder="Folder name"
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createFolder()
                if (e.key === 'Escape') setNewFolder(null)
              }}
            />
          </FormControl>
          <Button size="small" variant="primary" onClick={createFolder}>
            Create
          </Button>
          <Button size="small" onClick={() => setNewFolder(null)}>
            Cancel
          </Button>
        </div>
      )}

      <div className="folder-picker__list">
        {error ? (
          <p className="banner banner--error">{error}</p>
        ) : loading ? (
          <p className="empty">Loading…</p>
        ) : listing && listing.entries.length === 0 ? (
          <p className="empty">This folder is empty.</p>
        ) : (
          <ul>
            {listing?.entries.map((entry) =>
              entry.isDir ? (
                <li
                  key={entry.path}
                  className={entry.path === focusedPath ? 'is-focused' : undefined}
                >
                  <button type="button" onClick={() => load(entry.path)}>
                    <span className="file-icon">
                      <FileDirectoryFillIcon />
                    </span>
                    {entry.name}
                  </button>
                </li>
              ) : (
                <li key={entry.path} className="is-disabled">
                  <span className="file-icon">
                    <FileIcon />
                  </span>
                  {entry.name}
                </li>
              )
            )}
          </ul>
        )}
      </div>

      <p className="folder-picker__hint">Files will download into this folder.</p>
    </Dialog>
  )
}
