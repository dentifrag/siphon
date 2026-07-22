import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import type { RemoteEntry } from '@shared/types'
import { breadcrumbs, parentDir } from '../lib/path'
import { formatBytes, formatMtime } from '../lib/format'
import { sortEntries, type SortKey, type SortState } from '../lib/sort'

interface RemoteBrowserProps {
  connected: boolean
  cwd: string
  entries: RemoteEntry[]
  loading: boolean
  error: string | null
  selected: Set<string>
  canDownload: boolean
  onNavigate: (dir: string) => void
  onRefresh: () => void
  onSelectionChange: (next: Set<string>) => void
  onDownloadSelected: () => void
  onDownloadEntry: (entry: RemoteEntry) => void
}

interface ContextMenuState {
  x: number
  y: number
  entry: RemoteEntry
}

export function RemoteBrowser(props: RemoteBrowserProps) {
  const {
    connected,
    cwd,
    entries,
    loading,
    error,
    selected,
    canDownload,
    onNavigate,
    onRefresh,
    onSelectionChange,
    onDownloadSelected,
    onDownloadEntry
  } = props

  const files = entries.filter((entry) => entry.type !== 'directory')
  const selectedFileCount = files.filter((entry) => selected.has(entry.path)).length

  const anchorRef = useRef<number | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })

  const sortedEntries = useMemo(() => sortEntries(entries, sort), [entries, sort])

  const toggleSort = useCallback((key: SortKey) => {
    anchorRef.current = null
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' }
    )
  }, [])

  const sortIndicator = (key: SortKey): string =>
    sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''

  const closeMenu = useCallback(() => setMenu(null), [])

  useEffect(() => {
    if (!menu) return
    const onDocClick = (): void => closeMenu()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', onDocClick)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', closeMenu)
    return () => {
      window.removeEventListener('click', onDocClick)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', closeMenu)
    }
  }, [menu, closeMenu])

  useEffect(() => {
    anchorRef.current = null
  }, [entries])

  const selectRange = useCallback(
    (toIndex: number) => {
      const from = anchorRef.current
      if (from === null) {
        const entry = sortedEntries[toIndex]
        if (entry) onSelectionChange(new Set([entry.path]))
        anchorRef.current = toIndex
        return
      }
      const [lo, hi] = from <= toIndex ? [from, toIndex] : [toIndex, from]
      const range = sortedEntries
        .slice(lo, hi + 1)
        .filter((entry) => entry.type !== 'directory')
        .map((entry) => entry.path)
      onSelectionChange(new Set(range))
    },
    [sortedEntries, onSelectionChange]
  )

  const handleRowClick = useCallback(
    (event: MouseEvent, entry: RemoteEntry, index: number) => {
      if (entry.type === 'directory') {
        onNavigate(entry.path)
        return
      }
      if (event.shiftKey) {
        selectRange(index)
        return
      }
      if (event.metaKey || event.ctrlKey) {
        const next = new Set(selected)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        onSelectionChange(next)
        anchorRef.current = index
        return
      }
      onSelectionChange(new Set([entry.path]))
      anchorRef.current = index
    },
    [onNavigate, onSelectionChange, selectRange, selected]
  )

  const handleContextMenu = useCallback(
    (event: MouseEvent, entry: RemoteEntry, index: number) => {
      event.preventDefault()
      if (entry.type !== 'directory' && !selected.has(entry.path)) {
        onSelectionChange(new Set([entry.path]))
        anchorRef.current = index
      }
      setMenu({ x: event.clientX, y: event.clientY, entry })
    },
    [onSelectionChange, selected]
  )

  return (
    <section className="panel browser">
      <div className="browser__toolbar">
        <button
          type="button"
          className="btn btn--icon"
          title="Up one level"
          disabled={!connected || cwd === '/'}
          onClick={() => onNavigate(parentDir(cwd))}
        >
          ↑
        </button>
        <nav className="breadcrumbs">
          {breadcrumbs(cwd).map((crumb, index) => (
            <span key={crumb.path} className="breadcrumbs__item">
              {index > 0 && <span className="breadcrumbs__sep">/</span>}
              <button
                type="button"
                className="breadcrumbs__link"
                disabled={!connected}
                onClick={() => onNavigate(crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="browser__toolbar-actions">
          <button
            type="button"
            className="btn"
            disabled={!connected || loading}
            onClick={onRefresh}
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={selectedFileCount === 0 || !canDownload}
            title={canDownload ? '' : 'Choose a download folder first'}
            onClick={onDownloadSelected}
          >
            Download{selectedFileCount > 0 ? ` (${selectedFileCount})` : ''}
          </button>
        </div>
      </div>

      <div className="browser__body">
        {!connected ? (
          <p className="empty">Connect to a server to browse files.</p>
        ) : error ? (
          <p className="banner banner--error">{error}</p>
        ) : loading ? (
          <p className="empty">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="empty">This folder is empty.</p>
        ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th className="col-name col-sortable" onClick={() => toggleSort('name')}>
                  Name{sortIndicator('name')}
                </th>
                <th className="col-size col-sortable" onClick={() => toggleSort('size')}>
                  Size{sortIndicator('size')}
                </th>
                <th className="col-mtime col-sortable" onClick={() => toggleSort('mtime')}>
                  Modified{sortIndicator('mtime')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((entry, index) => {
                const isDir = entry.type === 'directory'
                const isSelected = selected.has(entry.path)
                return (
                  <tr
                    key={entry.path}
                    className={isSelected ? 'is-selected' : undefined}
                    onClick={(e) => handleRowClick(e, entry, index)}
                    onDoubleClick={() =>
                      isDir ? onNavigate(entry.path) : onDownloadEntry(entry)
                    }
                    onContextMenu={(e) => handleContextMenu(e, entry, index)}
                  >
                    <td className="col-name">
                      <span className={`file-name${isDir ? ' file-name--dir' : ''}`}>
                        <span className="file-icon">
                          {isDir ? '📁' : entry.type === 'symlink' ? '🔗' : '📄'}
                        </span>
                        {entry.name}
                      </span>
                    </td>
                    <td className="col-size">{isDir ? '' : formatBytes(entry.size)}</td>
                    <td className="col-mtime">{formatMtime(entry.mtime)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {menu && (
        <ul
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.entry.type === 'directory' ? (
            <li>
              <button
                type="button"
                onClick={() => {
                  onNavigate(menu.entry.path)
                  closeMenu()
                }}
              >
                Open
              </button>
            </li>
          ) : (
            <li>
              <button
                type="button"
                disabled={!canDownload}
                title={canDownload ? '' : 'Choose a download folder first'}
                onClick={() => {
                  onDownloadSelected()
                  closeMenu()
                }}
              >
                Download{selectedFileCount > 1 ? ` (${selectedFileCount})` : ''}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}
