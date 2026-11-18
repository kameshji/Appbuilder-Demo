import { useEffect } from 'react'
import { useUi } from '@/runtime/ui'
import { prefersDarkScheme, resolveTheme, usePrefs } from '@/platform/preferences'

/**
 * Light / dark theme of the product UI. The choice (light, dark or follow the system) is a user preference
 * (src/platform/preferences.ts); the effective value is one field of the UI store (`useUi().theme`, src/runtime/ui.ts)
 * shared by the shell, the Studio and the chat window, so a toggle anywhere is seen everywhere.
 */
export function useTheme() {
  const theme = useUi((s) => s.theme)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])
  /** quick toggle (top bar, Studio, sign-in screen): an explicit light or dark choice */
  const toggle = () => usePrefs.getState().set({ theme: useUi.getState().theme === 'dark' ? 'light' : 'dark' })
  return { theme, toggle }
}

let started = false
/**
 * Apply the theme and motion preferences and follow the operating system (colour scheme, reduced motion). Call once
 * per window (src/App.tsx). Returns a disposer.
 */
export function startPreferenceEffects(): () => void {
  if (started) return () => {}
  started = true
  const apply = () => {
    const p = usePrefs.getState()
    const theme = resolveTheme(p.theme, prefersDarkScheme())
    if (useUi.getState().theme !== theme) useUi.setState({ theme })
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.classList.toggle('reduce-motion', p.reduceMotion === 'reduce' || p.systemReducedMotion)
  }
  apply()
  const unsub = usePrefs.subscribe((s, prev) => {
    if (s.theme !== prev.theme || s.reduceMotion !== prev.reduceMotion || s.systemReducedMotion !== prev.systemReducedMotion) apply()
  })
  const cleanups: (() => void)[] = []
  try {
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onDark = () => apply()
    const onMotion = () => usePrefs.setState({ systemReducedMotion: motion.matches })
    dark.addEventListener('change', onDark)
    motion.addEventListener('change', onMotion)
    cleanups.push(() => dark.removeEventListener('change', onDark), () => motion.removeEventListener('change', onMotion))
  } catch {
    /* no matchMedia */
  }
  // another window of this browser changed the theme (the global key): follow it
  const onStorage = (e: StorageEvent) => {
    if (e.key === 'appbuilder-theme' && (e.newValue === 'light' || e.newValue === 'dark' || e.newValue === 'system')) usePrefs.setState({ theme: e.newValue })
  }
  window.addEventListener('storage', onStorage)
  cleanups.push(() => window.removeEventListener('storage', onStorage))
  return () => {
    started = false
    unsub()
    for (const c of cleanups) c()
  }
}
