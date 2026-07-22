import type { SftpApi } from '@shared/api'

declare global {
  interface Window {
    api: SftpApi
  }
}

export {}
