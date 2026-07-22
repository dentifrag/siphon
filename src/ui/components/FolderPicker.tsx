import { useCallback, useEffect, useState } from 'react'
import type { DownloadRootMeta, LocalDirListing } from '@shared/api'
import { errorMessage } from '../lib/format'

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
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal folder-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Choose download folder</h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {roots.length > 1 && (
          <div className="folder-picker__roots">
            {roots.map((root) => (
              <button
                key={root.path}
                type="button"
                className="chip"
                onClick={() => load(root.path)}
              >
                {root.name}
              </button>
            ))}
          </div>
        )}

        <div className="folder-picker__bar">
          <button
            type="button"
            className="btn btn--small"
            disabled={!listing || listing.parent === null || loading}
            onClick={() => listing?.parent && load(listing.parent)}
          >
            ↑ Up
          </button>
          <span className="folder-picker__path" title={listing?.path ?? ''}>
            {listing?.path ?? '…'}
          </span>
          <button
            type="button"
            className="btn btn--small"
            disabled={!listing || loading}
            onClick={() => setNewFolder('')}
          >
            New folder
          </button>
        </div>

        {newFolder !== null && (
          <div className="folder-picker__newfolder">
            <input
              autoFocus
              value={newFolder}
              placeholder="Folder name"
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createFolder()
                if (e.key === 'Escape') setNewFolder(null)
              }}
            />
            <button type="button" className="btn btn--small btn--primary" onClick={createFolder}>
              Create
            </button>
            <button type="button" className="btn btn--small" onClick={() => setNewFolder(null)}>
              Cancel
            </button>
          </div>
        )}

        <div className="folder-picker__list">
          {error ? (
            <p className="banner banner--error">{error}</p>
          ) : loading ? (
            <p className="empty">Loading…</p>
          ) : listing && listing.dirs.length === 0 ? (
            <p className="empty">No subfolders here.</p>
          ) : (
            <ul>
              {listing?.dirs.map((dir) => (
                <li key={dir.path}>
                  <button type="button" onClick={() => load(dir.path)}>
                    <span className="file-icon">📁</span>
                    {dir.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="modal__footer">
          <span className="folder-picker__hint">
            Files will download into this folder.
          </span>
          <div className="modal__footer-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!listing}
              onClick={() => listing && onChoose(listing.path)}
            >
              Use this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
