import { useEffect } from 'react'
import { useUi } from '@/runtime/ui'

/**
 * Light / dark theme of the product UI. One source of truth for the shell, the Studio and the chat window: the UI
 * store (src/runtime/ui.ts, localStorage 'appbuilder-theme'), so a toggle in the Studio is seen by the shell that stays
 * mounted behind it.
 */
export function useTheme() {
  const theme = useUi((s) => s.theme)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])
  const toggle = () => useUi.getState().toggleTheme()
  return { theme, toggle }
}
