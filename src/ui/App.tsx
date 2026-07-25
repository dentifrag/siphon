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

interface AppProps {
  canChangePassword: boolean
}

export default function App({ canChangePassword }: AppProps) {
  const [segments, setSegments] = useState(4)
  const [downloadDir, setDownloadDir] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState<'chooseDir' | 'chooseItems'>('chooseDir')
  const [mobileTab, setMobileTab] = useState<'files' | 'transfers'>('files')

  useEffect(() => {
    window.api
      .defaultDownloadDir()
      .then((dir) => setDownloadDir((current) => current || dir))
      .catch(() => undefined)
  }, [])

  // useBrowser's status-restore effect needs to trigger useConnection's restore, but
  // useConnection needs browser.navigateTo/resetForDisconnect as inputs. Break the cycle
  // with a ref, same technique the pre-refactor App.tsx used for its navigateToRef.
  const restoreConnectionRef = useRef<() => void>(() => {})
  const onStatusConnected = useCallback(() => restoreConnectionRef.current(), [])

  const browser = useBrowser({ downloadDir, segments, onStatusConnected })

  const connection = useConnection({
    segments,
    downloadDir,
    onSegmentsChange: setSegments,
    onDownloadDirChange: setDownloadDir,
    onConnected: browser.navigateTo,
    onDisconnected: browser.resetForDisconnect
  })

  useEffect(() => {
    restoreConnectionRef.current = connection.restoreConnection
  }, [connection.restoreConnection])

  const transfers = useTransfers({ navigateTo: browser.navigateTo, getCwd: browser.getCwd })

  const connected = connection.connState === 'connected'

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
        onDownloadDirChange={setDownloadDir}
        profiles={connection.profiles}
        selectedProfileId={connection.selectedProfileId}
        onSelectProfile={connection.handleSelectProfile}
        onSaveProfile={connection.handleSaveProfile}
        onDeleteProfile={connection.handleDeleteProfile}
        rememberSecret={connection.rememberSecret}
        onRememberSecretChange={connection.onRememberSecretChange}
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
          onClearFinished={transfers.handleClearFinished}
          onClearAll={transfers.handleClearAll}
        />
      </div>

      {pickerOpen && (
        <FolderPicker
          initialPath={downloadDir}
          mode={pickerMode}
          onClose={() => setPickerOpen(false)}
          onChoose={(paths) => {
            if (pickerMode === 'chooseItems') {
              setPickerOpen(false)
              void browser.handleUploadSelected(paths)
              return
            }
            setDownloadDir(paths[0])
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}
