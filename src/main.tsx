import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initialTheme } from '@/runtime/ui'
import App from './App'

document.documentElement.classList.toggle('dark', initialTheme() === 'dark')
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
