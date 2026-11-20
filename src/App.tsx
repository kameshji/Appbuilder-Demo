import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { platform } from '@/platform'
import { AuthGate, Portal } from '@/portal'
import { useRoute } from '@/router'
import { linkPlatform } from '@/runtime/store'
import { errorMessage } from '@/runtime/data'
import { RunApp } from '@/runtime/RunApp'
import { ChatWindow } from '@/chat/ChatWindow'
import { chatOpensInShell, shellRouteForChat } from '@/chat/deeplink'
import { startPreferenceEffects } from '@/portal/theme'
import { ConnectionBar } from '@/phone/ConnectionBar'
import { OfflineStart, offlineAtStart, rememberServerMode } from '@/phone/OfflineStart'
import { KioskPage } from '@/portal/dashboards/KioskPage'
import { ErrorBoundary } from '@/components/ErrorBoundary'

export default function App() {
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'error' | 'offline'; error?: string }>({ phase: 'loading' })
  const route = useRoute()
  // P2-C: the kiosk / TV page (#u-kiosk?t=<view token>) runs without the platform: no session, no shell, no sign-in
  const kiosk = route.page === 'u' && 'id' in route && route.id === 'kiosk'
  const started = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => startPreferenceEffects(), [])

  useEffect(() => {
    if (kiosk || started.current) return
    // once per page (StrictMode runs effects twice; the kiosk page may later navigate into the app)
    started.current = true
    // P2-A: a browser that used the server before must not fall back to demo mode just because it is offline now
    offlineAtStart()
      .then((off) => {
        if (off) {
          if (mounted.current) setState({ phase: 'offline' })
          return new Promise<never>(() => {})
        }
        return platform.init()
      })
      .then(() => {
        rememberServerMode(platform.getState().mode)
        linkPlatform()
        if (mounted.current) setState({ phase: 'ready' })
      })
      .catch((e: unknown) => mounted.current && setState({ phase: 'error', error: errorMessage(e) }))
  }, [kiosk])

  if (kiosk) return <ErrorBoundary scope="kiosk"><KioskPage /></ErrorBoundary>

  if (state.phase === 'loading') {
    return (
      <div className="grid h-full place-items-center bg-background text-muted-foreground" data-testid="app-loading">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading workspace…
        </div>
      </div>
    )
  }
  if (state.phase === 'offline') return <OfflineStart />
  if (state.phase === 'error') {
    return (
      <div className="grid h-full place-items-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-2 text-center">
          <TriangleAlert className="size-6 text-destructive" />
          <p className="text-sm font-medium">The workspace could not be loaded</p>
          <p className="text-xs text-muted-foreground">{state.error}</p>
        </div>
      </div>
    )
  }
  // server mode needs a session for every page (the debug run window shares the cookie); demo mode passes through.
  // The standalone player and the chat pop-out are windows of their own; everything else (Dev mode, User mode with
  // its app tabs, the Studio) lives in the shell, so app tabs stay mounted while you build.
  // P2-A: the connection strip is in the page flow under everything (it never covers an app's buttons)
  if (route.page === 'run') return <AuthGate><WithStrip><ErrorBoundary scope="run-app" resetKeys={[route.id]}><RunApp key={route.id} appId={route.id} /></ErrorBoundary></WithStrip></AuthGate>
  // P3-B: a chat link (#chat?c=..) in a main window at desktop width keeps the shell; the dock opens it (src/chat/deeplink.ts)
  if (route.page === 'chat' && !chatOpensInShell()) return <AuthGate><ChatWindow /></AuthGate>
  return <AuthGate><WithStrip><ErrorBoundary scope="portal"><Portal route={route.page === 'chat' ? shellRouteForChat() : route} /></ErrorBoundary></WithStrip></AuthGate>
}

function WithStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">{children}</div>
      <ConnectionBar />
    </div>
  )
}
