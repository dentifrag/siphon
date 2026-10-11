import { useCallback, useEffect, useRef, useState } from 'react'
import { SegmentedControl } from '@primer/react'
import { ConnectionPanel } from './components/ConnectionPanel'
import { RemoteBrowser } from './components/RemoteBrowser'
import { TransferQueue } from './components/TransferQueue'
import { FolderPicker } from './components/FolderPicker'
import { PasswordDialog } from './components/PasswordDialog'
import { useConnection } from './hooks/useConnection'
import { useBrowser } from './hooks/useBrowser'
import { useTransfers } from './hooks/useTransfers'
import { DOWNLOAD_DIR_STORAGE_KEY, loadStoredDownloadDir } from './lib/storage'

interface AppProps {
  canChangePassword: boolean
}

export default function App({ canChangePassword }: AppProps) {
  const [segments, setSegments] = useState(4)
  const [downloadDir, setDownloadDir] = useState(loadStoredDownloadDir)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState<'chooseDir' | 'chooseItems'>('chooseDir')
  const [mobileTab, setMobileTab] = useState<'files' | 'transfers'>('files')
  const preparedUploadRef = useRef<((paths: string[]) => Promise<void>) | null>(null)

  useEffect(() => {
    window.api
      .defaultDownloadDir()
      .then((dir) => setDownloadDir((current) => current || dir))
      .catch(() => undefined)
  }, [])

  const restoreConnectionRef = useRef<() => void>(() => {})
  const onStatusConnected = useCallback(() => restoreConnectionRef.current(), [])

  const browser = useBrowser({ downloadDir, segments, onStatusConnected })

  const connection = useConnection({
    segments,
    downloadDir,
    onSegmentsChange: setSegments,
    onDownloadDirChange: setDownloadDir,
    onConnected: browser.attachConnection,
    onConnectionChange: browser.beginConnectionChange,
    onDisconnected: () => {
      preparedUploadRef.current = null
    }
  })

  useEffect(() => {
    restoreConnectionRef.current = connection.restoreConnection
  }, [connection.restoreConnection])

  const transfers = useTransfers({
    refreshCurrent: browser.refreshCurrent,
    getCwd: browser.getCwd
  })

  const connected = connection.connState === 'connected'
  const handleManualDownloadDirChange = useCallback((dir: string) => {
    localStorage.setItem(DOWNLOAD_DIR_STORAGE_KEY, dir)
    setDownloadDir(dir)
  }, [])

  return (
    <div className={connected ? 'app app--connected' : 'app'}>
      <header className="app__bar">
        <h1>Siphon</h1>
        <div className="app__bar-actions">
          <PasswordDialog canChangePassword={canChangePassword} />
        </div>
      </header>

      <ConnectionPanel
        form={connection.form}
        onFormChange={connection.onFormChange}
        connState={connection.connState}
        onConnect={connection.handleConnect}
        onDisconnect={connection.handleDisconnect}
        error={connection.connError}
        segments={segments}
        onSegmentsChange={setSegments}
        downloadDir={downloadDir}
        onBrowseServer={() => {
          setPickerMode('chooseDir')
          setPickerOpen(true)
        }}
        onDownloadDirChange={handleManualDownloadDirChange}
        profiles={connection.profiles}
        selectedProfileId={connection.selectedProfileId}
        onSelectProfile={connection.handleSelectProfile}
        onSaveProfile={connection.handleSaveProfile}
        onDeleteProfile={connection.handleDeleteProfile}
        rememberSecret={connection.rememberSecret}
        onRememberSecretChange={connection.onRememberSecretChange}
        requiresPasswordReentry={connection.requiresPasswordReentry}
      />

      <nav className="mobile-tabs">
        <SegmentedControl
          aria-label="View"
          fullWidth
          onChange={(index) => setMobileTab(index === 0 ? 'files' : 'transfers')}
        >
          <SegmentedControl.Button selected={mobileTab === 'files'}>Files</SegmentedControl.Button>
          <SegmentedControl.Button
            selected={mobileTab === 'transfers'}
            count={transfers.transfers.length || undefined}
          >
            Transfers
          </SegmentedControl.Button>
        </SegmentedControl>
      </nav>

      <div className={`workspace workspace--${mobileTab}`}>
        <RemoteBrowser
          connected={connected}
          cwd={browser.cwd}
          entries={browser.entries}
          loading={browser.browseLoading}
          error={browser.browseError}
          selected={browser.selected}
          canDownload={downloadDir !== ''}
          suspended={pickerOpen}
          onNavigate={browser.navigateTo}
          onRefresh={() => browser.navigateTo(browser.cwd)}
          onSelectionChange={browser.setSelected}
          onDownloadSelected={browser.handleDownloadSelected}
          onDownloadEntry={(entry) => browser.enqueue(entry.path)}
          onUpload={() => {
            preparedUploadRef.current = browser.prepareUpload()
            setPickerMode('chooseItems')
            setPickerOpen(true)
          }}
        />

        <TransferQueue
          transfers={transfers.transfers}
          maxConcurrent={transfers.maxConcurrent}
          onMaxConcurrentChange={transfers.handleMaxConcurrentChange}
          onCancel={transfers.handleCancelDownload}
          onRemove={transfers.handleRemoveDownload}
          onRetry={transfers.handleRetryDownload}
          retryingIds={transfers.retryingIds}
          retryErrors={transfers.retryErrors}
          onClearFinished={transfers.handleClearFinished}
          onClearAll={transfers.handleClearAll}
        />
      </div>

      {pickerOpen && (
        <FolderPicker
          initialPath={downloadDir}
          mode={pickerMode}
          onClose={() => {
            preparedUploadRef.current = null
            setPickerOpen(false)
          }}
          onChoose={(paths) => {
            if (pickerMode === 'chooseItems') {
              setPickerOpen(false)
              const upload = preparedUploadRef.current
              preparedUploadRef.current = null
              if (upload) void upload(paths)
              return
            }
            handleManualDownloadDirChange(paths[0])
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}
