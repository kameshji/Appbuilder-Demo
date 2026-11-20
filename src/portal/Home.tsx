import { useState } from 'react'
import { ArrowRight, Database, FileUp, LayoutGrid, LayoutTemplate, Plus } from 'lucide-react'
import { usePlatform, type AppMeta } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { Empty, fmtRelative } from './kit'
import { AppMenu } from './AppMenu'
import { RunChoice } from './UserMode'
import { ImportDialog, NewAppDialog, StartWithDataDialog } from './dialogs'
import { matches, useSearch } from './Shell'
import { PinnedTiles } from './dashboards/PinnedTiles'

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function StartCard({ icon: Icon, title, text, onClick, testId, accent }: { icon: typeof Plus; title: string; text: string; onClick(): void; testId: string; accent: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="group flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left shadow-xs outline-none transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className={`grid size-11 place-items-center rounded-xl ${accent}`}><Icon className="size-5" /></span>
      <div>
        <div className="text-[15px] font-semibold">{title}</div>
        <p className="mt-1 text-sm leading-snug text-muted-foreground">{text}</p>
      </div>
      <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-primary">
        Start <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  )
}

export function AppCard({ app }: { app: AppMeta }) {
  const ratio = Math.max(1, app.width) / Math.max(1, app.height)
  return (
    <div
      data-testid={`app-card-${app.id}`}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs transition-all hover:border-primary/40 hover:shadow-md"
    >
      <button
        type="button"
        onClick={() => go({ page: 'studio', id: app.id })}
        aria-label={`Edit ${app.name}`}
        className="relative grid h-32 place-items-center bg-gradient-to-br from-accent/70 to-muted outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <div className="flex h-[72px] items-start gap-1 rounded-md border border-border bg-background p-1.5 shadow-sm" style={{ aspectRatio: String(ratio) }} aria-hidden>
          <div className="h-full w-1/4 rounded-sm bg-primary/25" />
          <div className="flex h-full flex-1 flex-col gap-1">
            <div className="h-1.5 w-2/3 rounded-sm bg-muted-foreground/30" />
            <div className="h-full rounded-sm bg-muted" />
          </div>
        </div>
      </button>
      <div className="flex items-start gap-1 p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{app.name}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {app.width} x {app.height} · {fmtRelative(app.modifiedOn)}
          </div>
        </div>
        <AppMenu app={app} className="-mr-1 -mt-0.5" />
      </div>
      <div className="flex gap-1.5 border-t border-border px-3 py-2">
        <Button size="xs" onClick={() => go({ page: 'studio', id: app.id })}>Edit</Button>
        <RunChoice app={app} variant="outline" />
      </div>
    </div>
  )
}

export function Home() {
  const apps = usePlatform((s) => s.apps)
  const tables = usePlatform((s) => s.tables)
  const users = usePlatform((s) => s.users)
  const currentUserId = usePlatform((s) => s.currentUserId)
  const q = useSearch()
  const [dlg, setDlg] = useState<'blank' | 'data' | 'import' | null>(null)
  const close = (o: boolean) => { if (!o) setDlg(null) }
  const me = users.find((u) => u.id === currentUserId)
  const recent = [...apps].filter((a) => matches(q, a.name, a.description)).sort((a, b) => b.modifiedOn.localeCompare(a.modifiedOn)).slice(0, 8)

  return (
    <div data-testid="page-home">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{greeting()}{me ? `, ${me.name.split(' ')[0]}` : ''}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {apps.length} {apps.length === 1 ? 'app' : 'apps'} · {tables.length} {tables.length === 1 ? 'table' : 'tables'}. What would you like to build today?
        </p>
      </div>

      <section aria-label="Start building" className="grid grid-cols-3 gap-4">
        <StartCard testId="new-app-button" icon={LayoutTemplate} accent="bg-primary/12 text-primary" title="Blank app" text="Design an app from scratch for desktop, phone or tablet." onClick={() => setDlg('blank')} />
        <StartCard testId="start-with-data-button" icon={Database} accent="bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" title="Start with data" text="Pick or create a table and get a ready-made list and edit form." onClick={() => setDlg('data')} />
        <StartCard testId="import-package-button" icon={FileUp} accent="bg-amber-500/12 text-amber-600 dark:text-amber-400" title="Import package" text="Bring in an app package from a file or pasted YAML." onClick={() => setDlg('import')} />
      </section>

      {!q.trim() && <div className="mt-9"><PinnedTiles /></div>}

      <section aria-label="Recent apps" className="mt-9">
        <div className="mb-3 flex items-center">
          <h2 className="text-sm font-semibold">Recent apps</h2>
          {apps.length > 0 && (
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => go({ page: 'apps' })}>
              All apps <ArrowRight />
            </Button>
          )}
        </div>
        {apps.length === 0 ? (
          <Empty icon={LayoutGrid} title="No apps yet" description="Create your first app above. It is saved in your workspace and can be exported as a package at any time." action={<Button onClick={() => setDlg('blank')}><Plus /> New blank app</Button>} />
        ) : recent.length === 0 ? (
          <Empty icon={LayoutGrid} title="No matching apps" description={`Nothing matches "${q}".`} />
        ) : (
          <div className="grid grid-cols-4 gap-4" data-testid="recent-apps">
            {recent.map((a) => <AppCard key={a.id} app={a} />)}
          </div>
        )}
      </section>

      <NewAppDialog open={dlg === 'blank'} onOpenChange={close} />
      <StartWithDataDialog open={dlg === 'data'} onOpenChange={close} />
      <ImportDialog open={dlg === 'import'} onOpenChange={close} kind="app" onDone={(r) => go({ page: 'studio', id: r.id })} />
    </div>
  )
}
