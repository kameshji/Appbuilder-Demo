import { useEffect, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { platform } from '@/platform'
import { AuthGate, Portal } from '@/portal'
import { useRoute } from '@/router'
import { linkPlatform } from '@/runtime/store'
import { errorMessage } from '@/runtime/data'
import { RunApp } from '@/runtime/RunApp'
import { ChatWindow } from '@/chat/ChatWindow'

export default function App() {
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'error'; error?: string }>({ phase: 'loading' })
  const route = useRoute()

  useEffect(() => {
    let alive = true
    platform
      .init()
      .then(() => {
        linkPlatform()
        if (alive) setState({ phase: 'ready' })
      })
      .catch((e: unknown) => alive && setState({ phase: 'error', error: errorMessage(e) }))
    return () => {
      alive = false
    }
  }, [])

  if (state.phase === 'loading') {
    return (
      <div className="grid h-full place-items-center bg-background text-muted-foreground" data-testid="app-loading">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading workspace…
        </div>
      </div>
    )
  }
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
  if (route.page === 'run') return <AuthGate><RunApp key={route.id} appId={route.id} /></AuthGate>
  if (route.page === 'chat') return <AuthGate><ChatWindow /></AuthGate>
  return <AuthGate><Portal route={route} /></AuthGate>
}
