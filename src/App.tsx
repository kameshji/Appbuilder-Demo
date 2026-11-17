import { useEffect, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { platform } from '@/platform'
import { Portal } from '@/portal'
import { useRoute } from '@/router'
import { linkPlatform } from '@/runtime/store'
import { errorMessage } from '@/runtime/data'
import { RunApp } from '@/runtime/RunApp'
import { Studio } from '@/studio/Studio'

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
  if (route.page === 'studio') return <Studio key={route.id} appId={route.id} />
  if (route.page === 'run') return <RunApp key={route.id} appId={route.id} />
  return <Portal route={route} />
}
