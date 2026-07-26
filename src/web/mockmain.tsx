import React from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, BaseStyles } from '@primer/react'
import App from '../ui/App'
import '@primer/primitives/dist/css/functional/themes/light.css'
import '@primer/primitives/dist/css/functional/themes/dark.css'
import '../ui/index.css'
import './web.css'

const entries = [
  { path: '/Documents', name: 'Documents', type: 'directory', size: 0, mtime: Date.now() - 86400000 },
  {
    path: '/a-very-long-file-name-that-overflows-the-viewport-width-on-mobile.mkv',
    name: 'a-very-long-file-name-that-overflows-the-viewport-width-on-mobile.mkv',
    type: 'file',
    size: 123456789,
    mtime: Date.now() - 3600000
  },
  { path: '/readme.txt', name: 'readme.txt', type: 'file', size: 42, mtime: Date.now() }
]

// @ts-expect-error test mock
window.api = {
  authStatus: async () => ({ state: 'open', required: false, authenticated: true, canChangePassword: false }),
  status: async () => ({ connected: true, cwd: '/' }),
  list: async () => entries,
  defaultDownloadDir: async () => '/downloads',
  serverConfig: async () => ({ downloadDir: '/downloads', roots: [] }),
  listProfiles: async () => [],
  getMaxConcurrentDownloads: async () => 2,
  listDownloads: async () => [],
  setMaxConcurrentDownloads: async (n: number) => n,
  cancelDownload: async () => {},
  cancelAllDownloads: async () => {},
  clearFinishedDownloads: async () => {},
  clearAllDownloads: async () => {},
  removeDownload: async () => true,
  onDownloadUpdate: () => () => {},
  enqueueDownload: async () => []
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider colorMode="light">
      <BaseStyles>
        <App canChangePassword={false} />
      </BaseStyles>
    </ThemeProvider>
  </React.StrictMode>
)
