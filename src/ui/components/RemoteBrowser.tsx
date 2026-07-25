import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { ActionList, ActionMenu, Button, IconButton } from '@primer/react'
import {
  ArrowUpIcon,
  FileDirectoryFillIcon,
  FileIcon,
  KebabHorizontalIcon
} from '@primer/octicons-react'
import type { RemoteEntry } from '@shared/types'
import { breadcrumbs, parentDir } from '../lib/path'
import { formatBytes, formatMtime } from '../lib/format'
import { sortEntries, type SortKey, type SortState } from '../lib/sort'
import { isTextInputFocused } from '../lib/keyboard'
import { useCoarsePointer } from '../lib/useCoarsePointer'

interface RemoteBrowserProps {
  connected: boolean
  cwd: string
  entries: RemoteEntry[]
  loading: boolean
  error: string | null
  selected: Set<string>
  canDownload: boolean
  suspended: boolean
  onNavigate: (dir: string) => void
  onRefresh: () => void
  onSelectionChange: (next: Set<string>) => void
  onDownloadSelected: () => void
  onDownloadEntry: (entry: RemoteEntry) => void
  onUpload: () => void
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
    suspended,
    onNavigate,
    onRefresh,
    onSelectionChange,
    onDownloadSelected,
    onDownloadEntry,
    onUpload
  } = props

  const selectedCount = entries.filter((entry) => selected.has(entry.path)).length
  const isCoarse = useCoarsePointer()

  const anchorRef = useRef<number | null>(null)
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })

  const sortedEntries = useMemo(() => sortEntries(entries, sort), [entries, sort])

  const toggleSort = useCallback((key: SortKey) => {
    anchorRef.current = null
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    )
  }, [])

  const sortIndicator = (key: SortKey): string =>
    sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''

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
      const range = sortedEntries.slice(lo, hi + 1).map((entry) => entry.path)
      onSelectionChange(new Set(range))
    },
    [sortedEntries, onSelectionChange]
  )

  const handleRowClick = useCallback(
    (event: MouseEvent, entry: RemoteEntry, index: number) => {
      if (isCoarse) {
        if (entry.type === 'directory') {
          onNavigate(entry.path)
          return
        }
        const next = new Set(selected)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        onSelectionChange(next)
        anchorRef.current = index
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
    [isCoarse, onNavigate, onSelectionChange, selectRange, selected]
  )

  const handleContextMenu = useCallback(
    (event: MouseEvent, entry: RemoteEntry, index: number) => {
      event.preventDefault()
      if (!selected.has(entry.path)) {
        onSelectionChange(new Set([entry.path]))
        anchorRef.current = index
      }
      setOpenMenuPath(entry.path)
    },
    [onSelectionChange, selected]
  )

  useEffect(() => {
    if (!connected || suspended) return
    const onKey = (e: KeyboardEvent): void => {
      if (loading) return
      if (openMenuPath !== null) return
      if (isTextInputFocused()) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (sortedEntries.length === 0) return
        e.preventDefault()
        const current = anchorRef.current
        const next =
          current === null
            ? 0
            : e.key === 'ArrowDown'
              ? Math.min(current + 1, sortedEntries.length - 1)
              : Math.max(current - 1, 0)
        anchorRef.current = next
        onSelectionChange(new Set([sortedEntries[next].path]))
      } else if (e.key === 'Enter') {
        const current = anchorRef.current
        const entry = current !== null ? sortedEntries[current] : undefined
        if (!entry) return
        e.preventDefault()
        if (entry.type === 'directory') onNavigate(entry.path)
        else onDownloadSelected()
      } else if (e.key === 'Backspace') {
        if (cwd === '/') return
        e.preventDefault()
        onNavigate(parentDir(cwd))
      } else if (e.key === ' ') {
        const current = anchorRef.current
        const entry = current !== null ? sortedEntries[current] : undefined
        if (!entry) return
        e.preventDefault()
        const next = new Set(selected)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        onSelectionChange(next)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        onSelectionChange(new Set(sortedEntries.map((entry) => entry.path)))
      } else if (e.key === 'Escape') {
        onSelectionChange(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    connected,
    suspended,
    loading,
    openMenuPath,
    sortedEntries,
    selected,
    cwd,
    onNavigate,
    onSelectionChange,
    onDownloadSelected
  ])

  return (
    <section className="panel browser">
      <div className="browser__toolbar">
        <IconButton
          icon={ArrowUpIcon}
          aria-label="Up one level"
          disabled={!connected || cwd === '/'}
          onClick={() => onNavigate(parentDir(cwd))}
        />
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
          <Button variant="default" disabled={!connected || loading} onClick={onRefresh}>
            Refresh
          </Button>
          <Button variant="default" disabled={!connected || loading} onClick={onUpload}>
            Upload
          </Button>
          <Button
            variant="primary"
            count={selectedCount || undefined}
            disabled={selectedCount === 0 || !canDownload}
            title={canDownload ? '' : 'Choose a download folder first'}
            onClick={onDownloadSelected}
          >
            Download
          </Button>
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
                <th className="col-actions" aria-hidden="true"></th>
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
                    onDoubleClick={() => (isDir ? onNavigate(entry.path) : onDownloadEntry(entry))}
                    onContextMenu={(e) => handleContextMenu(e, entry, index)}
                  >
                    <td className="col-name">
                      <span className={`file-name${isDir ? ' file-name--dir' : ''}`}>
                        <span className="file-icon">
                          {isDir ? (
                            <FileDirectoryFillIcon />
                          ) : entry.type === 'symlink' ? (
                            '🔗'
                          ) : (
                            <FileIcon />
                          )}
                        </span>
                        {entry.name}
                      </span>
                      <span className="file-meta">{formatMtime(entry.mtime)}</span>
                    </td>
                    <td className="col-size">{isDir ? '' : formatBytes(entry.size)}</td>
                    <td className="col-mtime">{formatMtime(entry.mtime)}</td>
                    <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                      <ActionMenu
                        open={openMenuPath === entry.path}
                        onOpenChange={(open) => {
                          if (open && !selected.has(entry.path)) {
                            onSelectionChange(new Set([entry.path]))
                            anchorRef.current = index
                          }
                          setOpenMenuPath(open ? entry.path : null)
                        }}
                      >
                        <ActionMenu.Anchor>
                          <IconButton
                            icon={KebabHorizontalIcon}
                            aria-label="Row actions"
                            variant="invisible"
                            size="small"
                          />
                        </ActionMenu.Anchor>
                        <ActionMenu.Overlay align="end">
                          <ActionList>
                            {isDir && (
                              <ActionList.Item onSelect={() => onNavigate(entry.path)}>
                                Open
                              </ActionList.Item>
                            )}
                            <ActionList.Item
                              disabled={!canDownload}
                              onSelect={() => onDownloadSelected()}
                            >
                              Download{selectedCount > 1 ? ` (${selectedCount})` : ''}
                            </ActionList.Item>
                          </ActionList>
                        </ActionMenu.Overlay>
                      </ActionMenu>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
