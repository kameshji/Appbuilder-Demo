import { useEffect } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { Route } from '@/router'
import { platform } from '@/platform'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthGate } from './Auth'
import { Empty, ToastProvider, errMsg, useToast } from './kit'
import { SearchProvider, Shell, pageAllowed, type PortalRoute } from './Shell'
import { Home } from './Home'
import { Apps } from './Apps'
import { Tables } from './Tables'
import { TableDesigner } from './TableDesigner'
import { Roles } from './Roles'
import { Connections } from './Connections'
import { DataFiles } from './DataFiles'
import { SolutionDetail, Solutions } from './Solutions'
import { useCaps } from './security'

function Page({ route }: { route: PortalRoute }) {
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

/** The maker portal: auth gate + shell + the page for `route`. Expects platform.init() to have completed. */
export function Portal({ route }: { route: Route }) {
  const effective: PortalRoute = route
  return (
    <TooltipProvider delayDuration={300}>
      <AuthGate>
        <ToastProvider>
          <DataErrorToasts />
          <SearchProvider>
            <Shell route={effective}>
              <Page route={effective} />
            </Shell>
          </SearchProvider>
        </ToastProvider>
      </AuthGate>
    </TooltipProvider>
  )
}
