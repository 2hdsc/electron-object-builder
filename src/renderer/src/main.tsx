import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from './providers/ThemeProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import { App } from './App'
import './i18n' // Initialize i18next before rendering
import './styles/global.css'
import { installWebApi } from './platform/web-api'

// Web build: no Electron preload, provide window.api backed by the File API
if (import.meta.env.VITE_PLATFORM === 'web' && !window.api) {
  installWebApi()
}

// ---------------------------------------------------------------------------
// Global error handlers (renderer process)
// ---------------------------------------------------------------------------

window.addEventListener('error', (event) => {
  const message = event.error?.message || event.message || 'Unknown error'
  const stack = event.error?.stack
  if (window.api?.log) {
    window.api.log.write('error', `Uncaught error: ${message}${stack ? '\n' + stack : ''}`)
  }
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  if (window.api?.log) {
    window.api.log.write('error', `Unhandled rejection: ${message}${stack ? '\n' + stack : ''}`)
  }
})

// ---------------------------------------------------------------------------
// React root
// ---------------------------------------------------------------------------

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
)
