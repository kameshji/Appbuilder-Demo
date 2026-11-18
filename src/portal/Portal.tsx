import { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { go, routeToHash, type Route } from '@/router'
import { platform } from '@/platform'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ChatDock } from '@/chat/ChatDock'
import { startChatDockSync } from '@/chat/dock'
import { Studio } from '@/studio/Studio'
import { AuthGate } from './Auth'
import { Empty, ToastProvider, errMsg, useToast } from './kit'
import { DEV_PAGES, SearchProvider, Shell, pageAllowed, type PortalRoute } from './Shell'
import { Home } from './Home'
import { Apps } from './Apps'
import { Tables } from './Tables'
import { TableDesigner } from './TableDesigner'
import { Roles } from './Roles'
import { Connections } from './Connections'
import { DataFiles } from './DataFiles'
import { SolutionDetail, Solutions } from './Solutions'
import { ComingSoon } from './ComingSoon'
import { MyApps, useTabSync } from './UserMode'
import { moduleByKey, type ShellMode } from './modules'
import { useCaps } from './security'
import { readMode, useUserKey, useWorkspace, writeMode } from './workspace'

function DevPage({ route }: { route: PortalRoute }) {
  const caps = useCaps()
  if (!pageAllowed(route.page, caps)) {
    return <Empty icon={ShieldAlert} title="Not available for your role" description="Ask an administrator for the Maker or Administrator role if you need this page." />
  }
  switch (route.page) {
    case 'apps': return <Apps />
    case 'tables': return <Tables />
    case 'table': return <TableDesigner tableId={route.id} />
    case 'roles': return <Roles />
    case 'solutions': return <Solutions />
    case 'solution': return <SolutionDetail solutionId={route.id} />
    case 'connections': return <Connections />
    case 'datafiles': return <DataFiles />
    default: return <Home />
  }
}

/** Every rolled-back server write is shown as a toast, wherever it happened. */
function DataErrorToasts() {
  const { toast } = useToast()
  useEffect(
    () => platform.onDataError((e) => {
      const what = e.op === 'create' ? 'add' : e.op === 'update' ? 'save' : 'delete'
      toast(`Could not ${what} in ${e.table}: ${errMsg(e.error)}`, 'error')
    }),
    [toast],
  )
  return null
}

const replaceRoute = (r: Route) => {
  try {
    location.replace(location.pathname + location.search + routeToHash(r))
  } catch {
    go(r)
  }
}

/**
 * Which mode a route shows: User mode routes (#u, #u-<id>) and Dev pages decide it; a coming-soon page stays in the
 * current mode when the module is listed there, otherwise it shows in the mode that lists it.
 */
export function modeOfRoute(route: Route, current: ShellMode): ShellMode {
  if (route.page === 'u') return 'user'
  if (route.page === 'soon') {
    const m = moduleByKey(route.id)
    return !m || m.modes.includes(current) ? current : m.modes[0]
  }
  return 'dev'
}

/**
 * The application shell around every page except the standalone player (#run-<id>) and the chat pop-out (#chat):
 * Dev mode (maker portal and Studio) and User mode (launcher and app tabs), with the chat dock on the right.
 */
function Frame({ route }: { route: Route }) {
  const caps = useCaps()
  const canDev = caps.isAdmin || caps.isMaker
  const user = useUserKey()
  const [mode, setMode] = useState<ShellMode>(() => (canDev ? (readMode(user) ?? 'dev') : 'user'))
  const lastRoute = useRef<Record<ShellMode, Route | null>>({ dev: null, user: null })
  const first = useRef(true)

  useEffect(() => {
    useWorkspace.getState().load(user)
    if (canDev) setMode(readMode(user) ?? 'dev')
  }, [user, canDev])

  // redirects: end users only have User mode; a maker opening the bare address returns to the last mode
  const bare = first.current && (location.hash === '' || location.hash === '#')
  const routed: ShellMode = !canDev ? 'user' : bare ? mode : modeOfRoute(route, mode)
  useEffect(() => {
    first.current = false
    if (!canDev && (DEV_PAGES.has(route.page) || (route.page === 'soon' && !moduleByKey(route.id)?.modes.includes('user')))) {
      replaceRoute({ page: 'u' })
      return
    }
    if (bare && routed === 'user') replaceRoute(lastRoute.current.user ?? { page: 'u' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, canDev])

  useEffect(() => {
    if (routed !== mode) setMode(routed)
    if (canDev && user) writeMode(user, routed)
    lastRoute.current[routed] = route
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routed, route, user, canDev])

  const activeTab = routed === 'user' && route.page === 'u' && 'id' in route ? route.id : null
  useTabSync(activeTab)

  const switchMode = (m: ShellMode) => {
    if (m === routed) return
    const back = lastRoute.current[m]
    go(back ?? (m === 'user' ? { page: 'u' } : { page: 'home' }))
  }

  const studio = route.page === 'studio' ? route.id : null
  let page = null
  if (studio) page = null
  else if (route.page === 'soon') page = <ComingSoon moduleKey={route.id} mode={routed} />
  else if (routed === 'user') page = <MyApps />
  else page = <DevPage route={route} />

  return (
    <div className="flex h-full overflow-hidden" data-testid="app-frame">
      <div className="relative h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        {studio && <Studio key={studio} appId={studio} />}
        <Shell route={route} mode={routed} canSwitch={canDev} onModeChange={switchMode} activeTab={activeTab} hidden={!!studio}>
          {page}
        </Shell>
      </div>
      <ChatDock />
    </div>
  )
}

/** The maker portal and the end-user shell: auth gate + shell + the page for `route`. Expects platform.init() to have completed. */
export function Portal({ route }: { route: Route }) {
  useEffect(() => startChatDockSync(), [])
  return (
    <TooltipProvider delayDuration={300}>
      <AuthGate>
        <ToastProvider>
          <DataErrorToasts />
          <SearchProvider>
            <Frame route={route} />
          </SearchProvider>
        </ToastProvider>
      </AuthGate>
    </TooltipProvider>
  )
}
