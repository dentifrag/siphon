import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, FormControl, TextInput } from '@primer/react'
import { ArrowUpIcon, FileDirectoryFillIcon, FileIcon } from '@primer/octicons-react'
import type { DownloadRootMeta, LocalDirListing } from '@shared/api'
import { errorMessage } from '../lib/format'
import { isTextInputFocused } from '../lib/keyboard'

interface FolderPickerProps {
  initialPath: string
  mode?: 'chooseDir' | 'chooseItems'
  onClose: () => void
  onChoose: (paths: string[]) => void
}

export function FolderPicker(props: FolderPickerProps) {
  const { initialPath, mode = 'chooseDir', onClose, onChoose } = props
  const [roots, setRoots] = useState<DownloadRootMeta[]>([])
  const [listing, setListing] = useState<LocalDirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLUListElement | null>(null)

  const rows = useMemo(() => listing?.entries ?? [], [listing])
  const dirs = useMemo(() => rows.filter((entry) => entry.isDir), [rows])
  const navRows = mode === 'chooseItems' ? rows : dirs
  const focusedPath = focusIndex !== null ? navRows[focusIndex]?.path : undefined

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    setChecked(new Set())
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
    window.api
      .listDownloadRoots()
      .then(setRoots)
      .catch(() => undefined)
    load(initialPath || undefined)
  }, [initialPath, load])

  useEffect(() => {
    setFocusIndex(navRows.length > 0 ? 0 : null)
  }, [navRows])

  useEffect(() => {
    const focusRow = (index: number): void => {
      const selector = mode === 'chooseItems' ? 'input[type="checkbox"]' : 'button'
      const targets = listRef.current?.querySelectorAll<HTMLElement>(selector)
      targets?.[index]?.focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (isTextInputFocused()) return
      if (navRows.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.min((focusIndex ?? -1) + 1, navRows.length - 1)
        setFocusIndex(next)
        focusRow(next)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const next = Math.max((focusIndex ?? 1) - 1, 0)
        setFocusIndex(next)
        focusRow(next)
      } else if (mode === 'chooseItems' && e.key === 'Enter') {
        const entry = focusIndex !== null ? navRows[focusIndex] : undefined
        if (entry?.isDir) {
          e.preventDefault()
          load(entry.path)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navRows, focusIndex, mode, load])

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

  const toggleChecked = useCallback((path: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  return (
    <Dialog
      title={mode === 'chooseItems' ? 'Choose files to upload' : 'Choose download folder'}
      width="large"
      onClose={() => onClose()}
      footerButtons={[
        { content: 'Cancel', onClick: () => onClose() },
        mode === 'chooseItems'
          ? {
              content:
                checked.size > 0
                  ? `Upload ${checked.size} item${checked.size === 1 ? '' : 's'}`
                  : 'Upload items',
              buttonType: 'primary',
              disabled: checked.size === 0,
              onClick: () => onChoose([...checked])
            }
          : {
              content: 'Use this folder',
              buttonType: 'primary',
              disabled: !listing,
              onClick: () => {
                if (listing) onChoose([listing.path])
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
        {mode !== 'chooseItems' && (
          <Button size="small" disabled={!listing || loading} onClick={() => setNewFolder('')}>
            New folder
          </Button>
        )}
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
          <ul ref={listRef}>
            {listing?.entries.map((entry) =>
              mode === 'chooseItems' ? (
                <li
                  key={entry.path}
                  className={entry.path === focusedPath ? 'is-focused' : undefined}
                >
                  <label className="folder-picker__item">
                    <input
                      type="checkbox"
                      aria-label={`Select ${entry.name}`}
                      checked={checked.has(entry.path)}
                      onChange={() => toggleChecked(entry.path)}
                    />
                  </label>
                  {entry.isDir ? (
                    <button type="button" onClick={() => load(entry.path)}>
                      <span className="file-icon">
                        <FileDirectoryFillIcon />
                      </span>
                      {entry.name}
                    </button>
                  ) : (
                    <span className="folder-picker__file-name">
                      <span className="file-icon">
                        <FileIcon />
                      </span>
                      {entry.name}
                    </span>
                  )}
                </li>
              ) : entry.isDir ? (
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

      <p className="folder-picker__hint">
        {mode === 'chooseItems'
          ? 'Checked files and folders will upload into the remote folder you are browsing.'
          : 'Files will download into this folder.'}
      </p>
    </Dialog>
  )
}
