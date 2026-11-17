import { useEffect, useState } from 'react'

/** Same key and behaviour as the Studio. */
const THEME_KEY = 'appbuilder-theme'
function readTheme(): 'light' | 'dark' {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t === 'dark' || t === 'light') return t
  } catch {
    /* ignore */
  }
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}
export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* ignore */
    }
  }
  return { theme, toggle }
}
