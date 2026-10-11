import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactElement } from 'react'
import {
  ActionList,
  ActionMenu,
  Button,
  IconButton,
  TextInput,
  VisuallyHidden
} from '@primer/react'
import {
  ArrowUpIcon,
  FileDirectoryFillIcon,
  FileIcon,
  KebabHorizontalIcon,
  SearchIcon
} from '@primer/octicons-react'
import type { RemoteEntry } from '@shared/types'
import { breadcrumbs, parentDir } from '../lib/path'
import { formatBytes, formatMtime } from '../lib/format'
import { sortEntries, type SortKey, type SortState } from '../lib/sort'
import { filterEntries } from '../lib/filter'
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

interface ContextMenuState {
  path: string
  x: number
  y: number
}

const columnDefinitions = {
  name: { label: 'Name', min: 160, max: 2000 },
  size: { label: 'Size', min: 72, max: 200 },
  mtime: { label: 'Modified', min: 96, max: 320 }
}
const columnKeys = ['name', 'size', 'mtime'] as const
type ColumnKey = (typeof columnKeys)[number]

interface ColumnWidths {
  name: number | null
  size: number
  mtime: number
}

interface ColumnDrag {
  column: ColumnKey
  pointerId: number
  startX: number
  startWidth: number
  hasResized: boolean
  previousWidths: ColumnWidths
  target: HTMLButtonElement
}

const defaultColumnWidths: ColumnWidths = { name: null, size: 88, mtime: 176 }
const defaultColumnDrafts = { name: '', size: '88', mtime: '176' }
const emptyColumnErrors: Record<ColumnKey, string | null> = {
  name: null,
  size: null,
  mtime: null
}

function clampColumnWidth(column: ColumnKey, width: number): number {
  const { min, max } = columnDefinitions[column]
  return Math.min(max, Math.max(min, Math.round(width)))
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

  // Hidden selections still count because downloads operate on the full directory listing.
  const selectedCount = useMemo(
    () => entries.filter((entry) => selected.has(entry.path)).length,
    [entries, selected]
  )
  const isCoarse = useCoarsePointer()

  const anchorRef = useRef<number | null>(null)
  const cursorAnchorRef = useRef<HTMLDivElement>(null)
  const contextMenuLabelId = useId()
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })
  const [filter, setFilter] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [columnWidths, setColumnWidths] = useState(defaultColumnWidths)
  const [columnDrafts, setColumnDrafts] = useState(defaultColumnDrafts)
  const [columnErrors, setColumnErrors] = useState(emptyColumnErrors)
  const [wrapFilenames, setWrapFilenames] = useState<boolean | null>(null)
  const filenamesWrapped = wrapFilenames ?? isCoarse
  const tableRef = useRef<HTMLTableElement>(null)
  const columnDragRef = useRef<ColumnDrag | null>(null)
  const editedColumnDraftsRef = useRef(new Set<ColumnKey>())
  const columnDescriptionId = useId()
  const columnErrorId = useId()
  const [prevCwd, setPrevCwd] = useState(cwd)
  const [prevConnected, setPrevConnected] = useState(connected)
  // Adjusting state during render (React's documented alternative to an Effect) so a stale filter
  // never paints against a new listing. navigateTo commits cwd and entries together, and a passive
  // effect would run after paint, flashing the new folder through the old query.
  if (prevCwd !== cwd || prevConnected !== connected) {
    setPrevCwd(cwd)
    setPrevConnected(connected)
    if (prevCwd !== cwd || !connected) setFilter('')
  }

  const visibleEntries = useMemo(() => filterEntries(entries, filter), [entries, filter])
  const sortedEntries = useMemo(() => sortEntries(visibleEntries, sort), [visibleEntries, sort])
  const hasTable = connected && !loading && !error && sortedEntries.length > 0

  const commitColumnWidth = useCallback((column: ColumnKey, width: number) => {
    const next = clampColumnWidth(column, width)
    editedColumnDraftsRef.current.delete(column)
    setColumnWidths((previous) => ({ ...previous, [column]: next }))
    setColumnDrafts((previous) => ({ ...previous, [column]: String(next) }))
    setColumnErrors((previous) => ({ ...previous, [column]: null }))
  }, [])

  const finishColumnDrag = useCallback((rollback: boolean) => {
    const drag = columnDragRef.current
    if (!drag) return
    columnDragRef.current = null
    if (rollback && drag.hasResized) {
      setColumnWidths((previous) =>
        drag.column === 'name'
          ? { ...previous, name: drag.previousWidths.name }
          : { ...previous, [drag.column]: drag.previousWidths[drag.column] }
      )
      setColumnDrafts((previous) => ({
        ...previous,
        [drag.column]: String(drag.previousWidths[drag.column] ?? '')
      }))
    }
    if (drag.target.hasPointerCapture(drag.pointerId)) {
      drag.target.releasePointerCapture(drag.pointerId)
    }
  }, [])

  useEffect(() => {
    if (!hasTable) finishColumnDrag(true)
    return () => finishColumnDrag(true)
  }, [hasTable, finishColumnDrag])

  useEffect(() => {
    const onResizeKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !columnDragRef.current) return
      event.preventDefault()
      event.stopPropagation()
      finishColumnDrag(true)
    }
    window.addEventListener('keydown', onResizeKey, true)
    return () => window.removeEventListener('keydown', onResizeKey, true)
  }, [finishColumnDrag])

  const currentColumnWidth = (column: ColumnKey): number | null => {
    const width = columnWidths[column]
    if (width !== null) return width
    const measured = tableRef.current?.querySelector('th.col-name')?.getBoundingClientRect().width
    if (measured !== undefined && Number.isFinite(measured) && measured > 0) return measured
    setColumnErrors((previous) => ({
      ...previous,
      name: 'Name column width is unavailable. Enter a numeric width when auto-fill cannot be measured.'
    }))
    return null
  }

  const applyColumnDraft = (column: ColumnKey): void => {
    if (!editedColumnDraftsRef.current.delete(column)) return
    const value = columnDrafts[column]
    const width = Number(value)
    const { label, min, max } = columnDefinitions[column]
    if (
      value.trim() === '' ||
      !Number.isFinite(width) ||
      !Number.isInteger(width) ||
      width < min ||
      width > max
    ) {
      const previousWidth = columnWidths[column]
      setColumnDrafts((previous) => ({
        ...previous,
        [column]: String(previousWidth ?? '')
      }))
      setColumnErrors((previous) => ({
        ...previous,
        [column]: `Invalid ${label} column width was not applied; restored ${
          previousWidth === null ? 'auto-fill' : `${previousWidth} pixels`
        }. Enter a whole-pixel width between ${min} and ${max}.`
      }))
      return
    }
    commitColumnWidth(column, width)
  }

  const updateColumnDrag = (clientX: number): void => {
    const drag = columnDragRef.current
    if (!drag) return
    const delta = clientX - drag.startX
    if (!drag.hasResized && Math.abs(delta) < 1) return
    drag.hasResized = true
    commitColumnWidth(drag.column, drag.startWidth + delta)
  }

  const metadataWidth = columnWidths.size + columnWidths.mtime + 56
  const tableStyle: CSSProperties &
    Record<
      | '--browser-name-width'
      | '--browser-size-width'
      | '--browser-mtime-width'
      | '--browser-table-width'
      | '--browser-table-min-width',
      string
    > = {
    '--browser-name-width': columnWidths.name === null ? 'auto' : `${columnWidths.name}px`,
    '--browser-size-width': `${columnWidths.size}px`,
    '--browser-mtime-width': `${columnWidths.mtime}px`,
    '--browser-table-width':
      columnWidths.name === null ? '100%' : `${columnWidths.name + metadataWidth}px`,
    '--browser-table-min-width': `${(columnWidths.name ?? columnDefinitions.name.min) + metadataWidth}px`
  }

  const renderColumnHandle = (column: ColumnKey): ReactElement => (
    <>
      <button
        type="button"
        className="column-resize-handle"
        data-browser-keys="ignore"
        aria-label={`Resize ${columnDefinitions[column].label} column`}
        aria-describedby={`${columnDescriptionId}-${column}`}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation()
          if (event.button !== 0 || columnDragRef.current) return
          event.preventDefault()
          event.currentTarget.focus()
          const width = currentColumnWidth(column)
          if (width === null) return
          event.currentTarget.setPointerCapture(event.pointerId)
          columnDragRef.current = {
            column,
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: width,
            hasResized: false,
            previousWidths: columnWidths,
            target: event.currentTarget
          }
        }}
        onPointerMove={(event) => {
          const drag = columnDragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          updateColumnDrag(event.clientX)
        }}
        onPointerUp={(event) => {
          const drag = columnDragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          updateColumnDrag(event.clientX)
          finishColumnDrag(false)
        }}
        onPointerCancel={(event) => {
          if (columnDragRef.current?.pointerId === event.pointerId) finishColumnDrag(true)
        }}
        onLostPointerCapture={(event) => {
          if (columnDragRef.current?.pointerId === event.pointerId) finishColumnDrag(true)
        }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          finishColumnDrag(true)
          const { min, max } = columnDefinitions[column]
          if (event.key === 'Home' || event.key === 'End') {
            commitColumnWidth(column, event.key === 'Home' ? min : max)
            return
          }
          const width = currentColumnWidth(column)
          if (width === null) return
          const step = event.shiftKey ? 32 : 8
          commitColumnWidth(column, width + (event.key === 'ArrowRight' ? step : -step))
        }}
      />
      <VisuallyHidden id={`${columnDescriptionId}-${column}`}>
        {columnWidths[column] === null
          ? 'Auto-fill remaining table space.'
          : `Current width: ${columnWidths[column]} pixels.`}{' '}
        {`Manual width: ${columnDefinitions[column].min} to ${columnDefinitions[column].max} pixels. Use Left or Right to adjust by 8 pixels, Shift for 32 pixels, Home for minimum, and End for maximum.`}
      </VisuallyHidden>
    </>
  )

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
    setOpenMenuPath(null)
    setContextMenu(null)
  }, [entries, filter])

  useEffect(() => {
    if (!connected || loading || error || entries.length === 0 || filter.trim() === '') {
      setAnnouncement('')
      return
    }
    const id = setTimeout(() => {
      setAnnouncement(
        sortedEntries.length === 0
          ? 'No files match that filter.'
          : `${sortedEntries.length} of ${entries.length} items match.`
      )
    }, 400)
    return () => clearTimeout(id)
  }, [connected, loading, error, filter, sortedEntries.length, entries.length])

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
      setOpenMenuPath(null)
      setContextMenu({ path: entry.path, x: event.clientX, y: event.clientY })
    },
    [onSelectionChange, selected]
  )

  useEffect(() => {
    if (!connected || suspended) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      if (
        (e.target instanceof Element && e.target.closest('[data-browser-keys="ignore"]')) ||
        document.activeElement?.closest('[data-browser-keys="ignore"]')
      ) {
        return
      }
      if (loading) return
      if (openMenuPath !== null || contextMenu !== null) return
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
    contextMenu,
    sortedEntries,
    selected,
    cwd,
    onNavigate,
    onSelectionChange,
    onDownloadSelected
  ])

  const contextEntry = useMemo(
    () =>
      contextMenu ? sortedEntries.find((entry) => entry.path === contextMenu.path) : undefined,
    [contextMenu, sortedEntries]
  )

  const renderMenuItems = (entry: RemoteEntry): ReactElement => (
    <ActionList>
      {entry.type === 'directory' && (
        <ActionList.Item onSelect={() => onNavigate(entry.path)}>Open</ActionList.Item>
      )}
      <ActionList.Item disabled={!canDownload} onSelect={() => onDownloadSelected()}>
        Download{selectedCount > 1 ? ` (${selectedCount})` : ''}
      </ActionList.Item>
    </ActionList>
  )

  return (
    <section className="panel browser">
      <VisuallyHidden role="status">{announcement}</VisuallyHidden>
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
        <TextInput
          className="browser__filter"
          aria-label="Filter this folder"
          placeholder="Filter this folder"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setFilter('')
          }}
          disabled={!connected}
          type="text"
          leadingVisual={SearchIcon}
        />
        <details className="browser__columns" data-browser-keys="ignore">
          <summary>Columns</summary>
          <div className="browser__column-controls">
            {columnKeys.map((column) => (
              <label key={column} className="browser__column-width">
                {columnDefinitions[column].label}
                <input
                  type="number"
                  aria-label={`${columnDefinitions[column].label} column width`}
                  min={columnDefinitions[column].min}
                  max={columnDefinitions[column].max}
                  step={1}
                  value={columnDrafts[column]}
                  placeholder={column === 'name' ? 'Auto' : undefined}
                  aria-describedby={columnErrors[column] ? columnErrorId : undefined}
                  onChange={(event) => {
                    finishColumnDrag(true)
                    editedColumnDraftsRef.current.add(column)
                    const value = event.target.value
                    setColumnDrafts((previous) => ({
                      ...previous,
                      [column]: value
                    }))
                  }}
                  onBlur={() => applyColumnDraft(column)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    event.stopPropagation()
                    applyColumnDraft(column)
                  }}
                />
              </label>
            ))}
            <label className="browser__column-option">
              <input
                type="checkbox"
                checked={columnWidths.name === null}
                onChange={(event) => {
                  finishColumnDrag(true)
                  if (event.target.checked) {
                    editedColumnDraftsRef.current.delete('name')
                    setColumnWidths((previous) => ({ ...previous, name: null }))
                    setColumnDrafts((previous) => ({ ...previous, name: '' }))
                    setColumnErrors((previous) => ({ ...previous, name: null }))
                  } else {
                    const width = currentColumnWidth('name')
                    if (width !== null) commitColumnWidth('name', width)
                  }
                }}
              />
              Auto-fill Name column
            </label>
            <label className="browser__column-option">
              <input
                type="checkbox"
                checked={filenamesWrapped}
                onChange={(event) => setWrapFilenames(event.target.checked)}
              />
              Wrap filenames
            </label>
            <button
              type="button"
              onClick={() => {
                finishColumnDrag(true)
                editedColumnDraftsRef.current.clear()
                setColumnWidths(defaultColumnWidths)
                setColumnDrafts(defaultColumnDrafts)
                setColumnErrors(emptyColumnErrors)
              }}
            >
              Reset column widths
            </button>
            {Object.values(columnErrors).some(Boolean) && (
              <p id={columnErrorId} role="alert" className="browser__column-error">
                {Object.values(columnErrors).filter(Boolean).join(' ')}
              </p>
            )}
          </div>
        </details>
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
        ) : sortedEntries.length === 0 ? (
          <p className="empty">No files match that filter.</p>
        ) : (
          <table
            ref={tableRef}
            className={`file-table${filenamesWrapped ? ' file-table--wrap' : ''}`}
            style={tableStyle}
          >
            <colgroup>
              <col className="col-name" />
              <col className="col-size" />
              <col className="col-mtime" />
              <col className="col-actions" />
            </colgroup>
            <thead>
              <tr>
                {columnKeys.map((column) => (
                  <th
                    key={column}
                    className={`col-${column} col-sortable`}
                    aria-label={columnDefinitions[column].label}
                    aria-sort={
                      sort.key === column
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                    onClick={() => toggleSort(column)}
                  >
                    {columnDefinitions[column].label}
                    {sortIndicator(column)}
                    {renderColumnHandle(column)}
                  </th>
                ))}
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
                        <span className="file-name__text">{entry.name}</span>
                      </span>
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
                          {renderMenuItems(entry)}
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

      <div
        ref={cursorAnchorRef}
        className="cursor-anchor"
        style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
        aria-hidden="true"
      />
      {contextEntry && contextMenu && (
        <>
          <VisuallyHidden id={contextMenuLabelId}>
            {`Actions for ${contextEntry.name}`}
          </VisuallyHidden>
          <ActionMenu
            key={`${contextMenu.path}:${contextMenu.x}:${contextMenu.y}`}
            anchorRef={cursorAnchorRef}
            open
            onOpenChange={(open) => {
              if (!open) setContextMenu(null)
            }}
          >
            <ActionMenu.Overlay
              align="start"
              displayInViewport
              aria-labelledby={contextMenuLabelId}
            >
              {renderMenuItems(contextEntry)}
            </ActionMenu.Overlay>
          </ActionMenu>
        </>
      )}
    </section>
  )
}
