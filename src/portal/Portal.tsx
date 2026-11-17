import type { Route } from '@/router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ToastProvider } from './kit'
import { SearchProvider, Shell } from './Shell'
import { Home } from './Home'
import { Apps } from './Apps'
import { Tables } from './Tables'
import { TableDesigner } from './TableDesigner'
import { Roles } from './Roles'
import { Connections } from './Connections'
import { SolutionDetail, Solutions } from './Solutions'

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'apps': return <Apps />
    case 'tables': return <Tables />
    case 'table': return <TableDesigner tableId={route.id} />
    case 'roles': return <Roles />
    case 'solutions': return <Solutions />
    case 'solution': return <SolutionDetail solutionId={route.id} />
    case 'connections': return <Connections />
    default: return <Home />
  }
}

/** The maker portal: shell + the page for `route`. Expects platform.init() to have completed. */
export function Portal({ route }: { route: Route }) {
  return (
    <TooltipProvider delayDuration={300}>
      <ToastProvider>
        <SearchProvider>
          <Shell route={route}>
            <Page route={route} />
          </Shell>
        </SearchProvider>
      </ToastProvider>
    </TooltipProvider>
  )
}
