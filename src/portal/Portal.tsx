import { setChatLive } from '@/chat/live'
import { NotificationCenter } from './Notifications'
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
import { MentionsPage, TasksPage } from './TasksPage'
import { ApprovalsPage } from '@/approvals/ApprovalsPage'
import { ReportsPage } from './Reports'
import { AdminConsole } from './Admin'
import { DataModel } from './model/DataModel'
import { FlowsPage } from '@/flows/FlowsPage'
import { SettingsPage } from './Settings'
import { usePrefs } from '@/platform/preferences'
import { referenceOf, rememberErrorReference } from '@/platform/errorMessages'
import { useChatDock } from '@/chat/dock'
import { MyApps, useTabSync } from './UserMode'
import { moduleByKey, type ShellMode } from './modules'
import { useCaps } from './security'
import { readMode, useUserKey, useWorkspace, useWorkspaceKey, writeMode } from './workspace'

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
    case 'admin': return <AdminConsole section={'id' in route ? route.id : undefined} />
    case 'datamodel': return <DataModel />
    case 'flows': return <FlowsPage />
    case 'flow': return <FlowsPage flowId={route.id} />
    case 'reports': return <ReportsPage />
    default: return <Home />
  }
}

/** Every rolled-back server write is shown as a toast, wherever it happened. */
function DataErrorToasts() {
  const { toast } = useToast()
  useEffect(
    () => platform.onDataError((e) => {
      const what = e.op === 'create' ? 'add' : e.op === 'update' ? 'save' : 'delete'
      const msg = `Could not ${what} in ${e.table}: ${errMsg(e.error)}`
      rememberErrorReference(msg, referenceOf(e.error))
      toast(msg, 'error')
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
  if (route.page === 'settings') return current
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
  const wsKey = useWorkspaceKey()
  // the user's preferences first: the start mode below depends on them (first render; later user changes in an effect)
  useState(() => usePrefs.getState().load(user))
  useEffect(() => usePrefs.getState().load(user), [user])
  const startMode = (): ShellMode => {
    const pref = usePrefs.getState().startMode
    return pref === 'last' ? (readMode(user) ?? 'dev') : pref
  }
  const [mode, setMode] = useState<ShellMode>(() => (canDev ? startMode() : 'user'))
  const chatSide = usePrefs((s) => s.chatSide)
  const chatChecked = useRef(false)
  useEffect(() => {
    // Settings > Chat > "Reopen chat at start" off: the dock starts closed
    if (chatChecked.current || !user) return
    chatChecked.current = true
    if (!usePrefs.getState().chatRestore && useChatDock.getState().open) useChatDock.getState().hide()
  }, [user])
  const lastRoute = useRef<Record<ShellMode, Route | null>>({ dev: null, user: null })
  const first = useRef(true)

  useEffect(() => {
    if (canDev) setMode(startMode())
  }, [user, canDev])
  // app tabs belong to the environment: another environment's tabs are closed (unmounted) and its own come back
  useEffect(() => {
    useWorkspace.getState().load(wsKey)
  }, [wsKey])

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
    if (route.page !== 'settings') lastRoute.current[routed] = route
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routed, route, user, canDev])

  // built-in User mode pages of the core data model (P0-N): #u-tasks, #u-mentions (not app tabs)
  const builtin = routed === 'user' && route.page === 'u' && 'id' in route && (route.id === 'tasks' || route.id === 'mentions' || route.id === 'reports' || route.id === 'approvals') ? route.id : null
  const activeTab = routed === 'user' && route.page === 'u' && 'id' in route && !builtin ? route.id : null
  useTabSync(activeTab)

  const switchMode = (m: ShellMode) => {
    if (m === routed) return
    const back = lastRoute.current[m]
    go(back ?? (m === 'user' ? { page: 'u' } : { page: 'home' }))
  }

  const studio = route.page === 'studio' ? route.id : null
  const settings = route.page === 'settings'
  let page = null
  if (studio || settings) page = null
  else if (route.page === 'soon') page = <ComingSoon moduleKey={route.id} mode={routed} />
  else if (builtin === 'tasks') page = <TasksPage />
  else if (builtin === 'mentions') page = <MentionsPage />
  else if (builtin === 'reports') page = <ReportsPage />
  else if (builtin === 'approvals') page = <ApprovalsPage />
  else if (routed === 'user') page = <MyApps />
  else page = <DevPage route={route} />

  return (
    <div className="flex h-full overflow-hidden" data-testid="app-frame" data-chat-side={chatSide}>
      {chatSide === 'left' && <ChatDock side="left" />}
      <div className="relative h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        {studio && <Studio key={studio} appId={studio} />}
        {settings && <SettingsPage section={'id' in route ? route.id : undefined} mode={routed} />}
        <Shell route={route} mode={routed} canSwitch={canDev} onModeChange={switchMode} activeTab={activeTab} hidden={!!studio || settings}>
          {page}
        </Shell>
      </div>
      {chatSide === 'right' && <ChatDock side="right" />}
    </div>
  )
}

/** The maker portal and the end-user shell: auth gate + shell + the page for `route`. Expects platform.init() to have completed. */
export function Portal({ route }: { route: Route }) {
  useEffect(() => startChatDockSync(), [])
  // the chat boundary gets the realtime connection (chat itself is P3)
  useEffect(() => {
    setChatLive(platform.live)
    return () => setChatLive(null)
  }, [])
  return (
    <TooltipProvider delayDuration={300}>
      <AuthGate>
        <ToastProvider>
          <DataErrorToasts />
          <NotificationCenter />
          <SearchProvider>
            <Frame route={route} />
          </SearchProvider>
        </ToastProvider>
      </AuthGate>
    </TooltipProvider>
  )
}
