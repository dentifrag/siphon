import React from 'react'
import ReactDOM from 'react-dom/client'
import { BaseStyles, ThemeProvider } from '@primer/react'
import '@primer/primitives/dist/css/functional/themes/light.css'
import '@primer/primitives/dist/css/functional/themes/dark.css'
import '../ui/index.css'
import './web.css'
import Root from './Root'
import { createWebApi } from './api'

const api = createWebApi()
window.api = api

const el = document.getElementById('root')
if (el) {
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <ThemeProvider colorMode="auto">
        <BaseStyles>
          <Root />
        </BaseStyles>
      </ThemeProvider>
    </React.StrictMode>
  )
}
