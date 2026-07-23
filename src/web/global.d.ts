import type { WebApi } from './api'

declare global {
  interface Window {
    api: WebApi
  }
}

export {}
