import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './phone/phone.css'
import { startPhone } from './phone/start'
import { initialTheme } from '@/runtime/ui'
import App from './App'

document.documentElement.classList.toggle('dark', initialTheme() === 'dark')
// P2-A: device classes, viewport and keyboard handling, touch areas, the service worker (src/phone/start.ts)
startPhone()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
