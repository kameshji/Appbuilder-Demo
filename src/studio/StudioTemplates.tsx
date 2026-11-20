/**
 * Templates in the Studio (P2-D; docs/guide/maker/templates.md): the Insert pane's "From a template" (UI component
 * templates, inserted as a copy into the current screen) and the screen tabs' "New screen from a template" (added as a
 * new screen of this app). The binding step and the plan screen are the shared UseTemplateDialog; the insert itself is
 * one undo step of the app being edited (src/templates/insert.ts: names already used get a number, nothing that was in
 * the app changes). Opening #studio-<app>?template=<id> (the Templates page) starts the dialog for that template.
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { Boxes, LayoutTemplate, PanelsTopLeft } from 'lucide-react'
import { platform } from '@/platform'
import { useStore } from '@/runtime/store'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { appendScreen, insertIntoScreen, namesOf } from '@/templates/insert'
import { UseTemplateDialog } from '@/templates/UseTemplateDialog'
import { fetchCatalogue } from '@/templates/api'
import type { TemplateInstallResult, TemplateSummary } from '@/templates/format'
import type { AppDef } from '@/contracts'

type Kind = 'component' | 'screen'
interface TemplatesUi { picker: Kind | null; use: string | null; openPicker(k: Kind): void; openUse(id: string): void; close(): void }
export const useStudioTemplates = create<TemplatesUi>((set) => ({
  picker: null, use: null,
  openPicker: (k) => set({ picker: k, use: null }),
  openUse: (id) => set({ use: id, picker: null }),
  close: () => set({ picker: null, use: null }),
}))

/** the tables the install created reach this page with the next metadata refresh (live hub): wait for them, at most 8 s */
async function waitForTables(names: string[]): Promise<void> {
  const end = Date.now() + 8000
  while (Date.now() < end && names.some((n) => !platform.tables.get(n))) await new Promise((r) => setTimeout(r, 150))
}

const newId = (): string => `n${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`

/** the bound template goes into the app being edited, as one undo step */
function applyToApp(r: TemplateInstallResult): string | null {
  const st = useStore.getState()
  if (st.readOnly) return 'The app is read-only here.'
  const before = st.app as AppDef
  let next: AppDef
  let select: string[]
  let screenId: string | null = null
  if (r.screen) {
    const res = appendScreen(before, r.screen, newId, r.dataSources)
    next = res.app
    screenId = res.screenId
    select = [res.screenId]
  } else if (r.controls) {
    const res = insertIntoScreen(before, st.currentScreenId, r.controls, newId, r.dataSources)
    next = res.app
    select = res.ids
  } else return null
  useStore.setState((s) => {
    s.history.past.push(before)
    if (s.history.past.length > 100) s.history.past.shift()
    s.history.future = []
    s.history.lastKey = null
    s.app = next
    if (screenId) s.currentScreenId = screenId
    s.selection = select
  })
  return null
}

function Picker() {
  const kind = useStudioTemplates((s) => s.picker)
  const [items, setItems] = useState<TemplateSummary[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!kind) return
    setItems(null); setError('')
    if (platform.getState().mode !== 'server') { setError('Templates need the server.'); return }
    fetchCatalogue().then((l) => setItems(l.filter((t) => t.kind === kind && t.integrity !== 'damaged')), (e) => setError(String((e as Error).message ?? e)))
  }, [kind])
  return (
    <Dialog open={!!kind} onOpenChange={(o) => !o && useStudioTemplates.getState().close()}>
      <DialogContent data-testid="studio-template-picker">
        <DialogHeader>
          <DialogTitle>{kind === 'screen' ? 'New screen from a template' : 'UI components from a template'}</DialogTitle>
          <DialogDescription>{kind === 'screen' ? 'The screen is added to this app.' : 'A copy is inserted into the current screen.'} You choose the data in the next step; nothing in the app is replaced.</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!items && !error && <div className="grid place-items-center py-6"><Spinner /></div>}
        {items && items.length === 0 && <p className="text-sm text-muted-foreground">The catalogue has no template of this kind.</p>}
        <div className="grid gap-2">
          {(items ?? []).map((t) => (
            <button key={t.id} type="button" className="grid gap-0.5 rounded-md border border-border p-2.5 text-left hover:border-primary/50 hover:bg-accent" data-testid={`studio-template-${t.id}`} onClick={() => useStudioTemplates.getState().openUse(t.id)}>
              <span className="flex items-center gap-2 text-sm font-medium">{kind === 'screen' ? <PanelsTopLeft className="size-4 text-primary" /> : <Boxes className="size-4 text-primary" />}{t.name}</span>
              <span className="text-xs text-muted-foreground">{t.description}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** mounted once by the Studio */
export function StudioTemplates({ appId, initialTemplate }: { appId: string; initialTemplate?: string }) {
  const use = useStudioTemplates((s) => s.use)
  const app = useStore((s) => s.app)
  const screenId = useStore((s) => s.currentScreenId)
  const [note, setNote] = useState('')
  // #studio-<app>?template=<id>: the Templates page sent the maker here
  useEffect(() => {
    if (initialTemplate) {
      useStudioTemplates.getState().openUse(initialTemplate)
      if (/[?&]template=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search + location.hash.replace(/[?&]template=[^&]+/, ''))
    }
    return () => useStudioTemplates.getState().close()
  }, [appId, initialTemplate])
  const screen = app.screens.find((s) => s.id === screenId)
  return (
    <>
      <Picker />
      <UseTemplateDialog
        open={!!use}
        onOpenChange={(o) => !o && useStudioTemplates.getState().close()}
        templateId={use}
        target={{ appId, appName: app.name, ...(screen ? { screenName: screen.name } : {}), takenNames: namesOf(app) }}
        onInstalled={(r) => { void waitForTables(r.dataSources).then(() => setNote(applyToApp(r) ?? '')) }}
      />
      {note && <span className="sr-only" role="status">{note}</span>}
    </>
  )
}

/** the Insert pane's entry */
export function InsertFromTemplate() {
  return (
    <section>
      <Button size="sm" variant="outline" className="h-8 w-full justify-start text-xs" data-testid="insert-from-template" onClick={() => useStudioTemplates.getState().openPicker('component')}>
        <LayoutTemplate className="size-4 text-primary" /> UI components from a template
      </Button>
    </section>
  )
}

/** the screen tabs' entry */
export function ScreenFromTemplateButton() {
  return (
    <button type="button" title="New screen from a template" data-testid="screen-from-template" onClick={() => useStudioTemplates.getState().openPicker('screen')}
      className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground">
      <LayoutTemplate className="size-3.5" />
    </button>
  )
}
