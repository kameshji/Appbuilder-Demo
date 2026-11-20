import { useState } from 'react'
import { Database, LayoutGrid, List, Network, Plus, Upload } from 'lucide-react'
import { usePlatform } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { Empty, Panel, PageHeader, Segmented, fmtDate } from './kit'
import { AppMenu } from './AppMenu'
import { DeviceIcon, RunChoice } from './UserMode'
import { AppCard } from './Home'
import { ImportDialog, NewAppDialog } from './dialogs'
import { matches, useSearch } from './Shell'
import { useCaps } from './security'
import { AutoAppDialog } from '@/autoapp/AutoAppDialog'

export function Apps() {
  const apps = usePlatform((s) => s.apps)
  const users = usePlatform((s) => s.users)
  const q = useSearch()
  const [view, setView] = useState<'grid' | 'table'>('table')
  const [dlg, setDlg] = useState<'blank' | 'import' | 'table' | 'model' | null>(null)
  const caps = useCaps()
  const close = (o: boolean) => { if (!o) setDlg(null) }
  const list = apps.filter((a) => matches(q, a.name, a.description)).sort((a, b) => b.modifiedOn.localeCompare(a.modifiedOn))
  const who = (id: string) => users.find((u) => u.id === id)?.name ?? id

  return (
    <div data-testid="page-apps">
      <PageHeader
        icon={LayoutGrid}
        title="Apps"
        subtitle={`${apps.length} ${apps.length === 1 ? 'app' : 'apps'} in this workspace`}
        actions={
          <>
            <Segmented
              label="View"
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: 'table', label: <><List className="size-3.5" /> Table</> },
                { value: 'grid', label: <><LayoutGrid className="size-3.5" /> Grid</> },
              ]}
            />
            <Button variant="outline" size="sm" onClick={() => setDlg('import')} data-testid="import-app-button"><Upload /> Import</Button>
            {caps.isMaker && <Button variant="outline" size="sm" onClick={() => setDlg('table')} data-testid="app-from-table-button"><Database /> From a table</Button>}
            {caps.isMaker && <Button variant="outline" size="sm" onClick={() => setDlg('model')} data-testid="app-from-model-button"><Network /> From the data model</Button>}
            <Button size="sm" onClick={() => setDlg('blank')} data-testid="new-app-button"><Plus /> New app</Button>
          </>
        }
      />
      {apps.length === 0 ? (
        <Empty icon={LayoutGrid} title="No apps yet" description="Create a blank app or import a package." action={<Button onClick={() => setDlg('blank')}><Plus /> New app</Button>} />
      ) : list.length === 0 ? (
        <Empty icon={LayoutGrid} title="No matching apps" description={`Nothing matches "${q}".`} />
      ) : view === 'grid' ? (
        <div className="grid grid-cols-4 gap-4" data-testid="apps-grid">
          {list.map((a) => <AppCard key={a.id} app={a} />)}
        </div>
      ) : (
        <Panel className="overflow-hidden">
          <table className="w-full text-sm" data-testid="apps-table">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Resolution</th>
                <th className="px-4 py-2.5">Modified</th>
                <th className="px-4 py-2.5">Modified by</th>
                <th className="w-44 px-4 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} data-testid={`app-card-${a.id}`} className="group border-b border-border last:border-0 hover:bg-accent/40">
                  <td className="px-4 py-2.5">
                    <button type="button" className="rounded font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => go({ page: 'studio', id: a.id })}>{a.name}</button>
                    {a.description && <div className="truncate text-xs text-muted-foreground">{a.description}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground"><span className="inline-flex items-center gap-1.5"><DeviceIcon app={a} className="size-3.5" /> {a.width} x {a.height}</span></td>
                  <td className="px-4 py-2.5 text-muted-foreground">{fmtDate(a.modifiedOn)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{who(a.modifiedBy)}</td>
                  <td className="px-4 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="xs" variant="outline" onClick={() => go({ page: 'studio', id: a.id })}>Edit</Button>
                      <RunChoice app={a} />
                      <AppMenu app={a} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <NewAppDialog open={dlg === 'blank'} onOpenChange={close} />
      <AutoAppDialog open={dlg === 'table'} onOpenChange={close} />
      <AutoAppDialog open={dlg === 'model'} onOpenChange={close} multi />
      <ImportDialog open={dlg === 'import'} onOpenChange={close} kind="app" onDone={(r) => go({ page: 'studio', id: r.id })} />
    </div>
  )
}
