import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './phone/phone.css'
import { startPhone } from './phone/start'
import { initialTheme } from '@/runtime/ui'
import App from './App'
import { logRenderError } from '@/components/ErrorBoundary'

document.documentElement.classList.toggle('dark', initialTheme() === 'dark')
// P2-A: device classes, viewport and keyboard handling, touch areas, the service worker (src/phone/start.ts)
startPhone()
// P3-D: every render error is logged with its component stack. The server has no client-error endpoint, so nothing is
// reported anywhere else (and none was added): the console is the record. The boundaries (components/ErrorBoundary.tsx)
// keep one failed part from blanking the page.
createRoot(document.getElementById('root')!, {
  onCaughtError: (error, info) => logRenderError('caught', error, info.componentStack),
  onUncaughtError: (error, info) => logRenderError('uncaught', error, info.componentStack),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
