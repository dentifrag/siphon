import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

const jsdomWindow = (globalThis as unknown as { jsdom?: { window: Window } }).jsdom?.window
if (jsdomWindow) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: jsdomWindow.localStorage,
    configurable: true,
    writable: true
  })
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: jsdomWindow.sessionStorage,
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
})

window.matchMedia ??= vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn()
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

Element.prototype.scrollIntoView ??= vi.fn()

window.confirm = vi.fn(() => true)

if (!Array.isArray(document.adoptedStyleSheets)) {
  Object.defineProperty(document, 'adoptedStyleSheets', {
    value: [],
    configurable: true,
    writable: true
  })
}
