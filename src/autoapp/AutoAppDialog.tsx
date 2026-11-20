import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Info, Monitor, Smartphone, Wand2 } from 'lucide-react'
import { usePlatform, type TableDef } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Segmented, useToast } from '@/portal/kit'
import { useCaps } from '@/portal/security'
import { cn } from '@/lib/utils'
import { createAutoApp, readableFor } from './create'
import { generateApp, type AutoDevice, type AutoIssue } from './generate'

const LEVEL: Record<AutoIssue['level'], { label: string; cls: string }> = {
  blocked: { label: 'Not used', cls: 'border-destructive/40 text-destructive' },
  skipped: { label: 'Left out', cls: 'border-amber-500/50 text-amber-700 dark:text-amber-300' },
  limited: { label: 'Limited', cls: 'border-amber-500/50 text-amber-700 dark:text-amber-300' },
  note: { label: 'Note', cls: 'text-muted-foreground' },
}

/** child tables and lookup targets of a table (the data model around it), user tables only */
function neighbours(t: TableDef, all: TableDef[]): string[] {
  const out = new Set<string>()
  for (const c of t.columns) if (!c.system && c.type === 'lookup' && c.lookupTable) out.add(c.lookupTable)
  for (const o of all) if (o.columns.some((c) => !c.system && c.type === 'lookup' && c.lookupTable === t.name)) out.add(o.name)
  out.delete(t.name)
  return [...out].filter((n) => all.some((x) => x.name === n && !x.system))
}

/**
 * "Create app from table" (one table) and "From the data model" (several, with navigation between them): name, device,
 * tables, a preview of what will be generated and everything that cannot be handled; then the app is created through
 * the normal app-creation path and opened in the Studio.
 */
export function AutoAppDialog({ open, onOpenChange, tables: initial = [], multi = false }: { open: boolean; onOpenChange(o: boolean): void; tables?: string[]; multi?: boolean }) {
  const all = usePlatform((s) => s.tables)
  const session = usePlatform((s) => s.session)
  const mode = usePlatform((s) => s.mode)
  const caps = useCaps()
  const { fail, toast } = useToast()
  const readable = useMemo(() => readableFor(session, mode), [session, mode])
  const choices = useMemo(() => all.filter((t) => !t.system && readable(t)).sort((a, b) => a.displayName.localeCompare(b.displayName)), [all, readable])
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [device, setDevice] = useState<AutoDevice>('desktop')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    const start = initial.filter((n) => all.some((t) => t.name === n))
    setPicked(start.length ? start : multi ? [] : choices[0] ? [choices[0].name] : [])
    setNamed(false)
    setName('')
    setDevice('desktop')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const { plan } = useMemo(() => generateApp(all, { name: named ? name : '', device, tables: picked, readable, newId: () => 'preview' }), [all, name, named, device, picked, readable])
  const autoName = picked.length > 1 ? `${all.find((t) => t.name === picked[0])?.displayName ?? 'Data'} and more` : plan.name
  const shownName = named ? name : autoName
  const toggle = (n: string, on: boolean) => setPicked((p) => (on ? (p.includes(n) ? p : [...p, n]) : p.filter((x) => x !== n)))
  const addRelated = () => {
    const next = [...picked]
    for (const n of picked) {
      const t = all.find((x) => x.name === n)
      if (t) for (const m of neighbours(t, all)) if (!next.includes(m) && choices.some((c) => c.name === m)) next.push(m)
    }
    setPicked(next)
  }

  const create = async () => {
    setBusy(true)
    try {
      const { meta } = await createAutoApp({ name: shownName.trim(), device, tables: picked })
      toast(`Created "${meta.name}"`, 'success')
      onOpenChange(false)
      go({ page: 'studio', id: meta.id })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const ok = caps.isMaker && plan.tables.length > 0 && !!shownName.trim()
  const issues = plan.issues
  const size = `${plan.width} x ${plan.height}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="auto-app-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wand2 className="size-4" />{multi ? 'Create app from the data model' : 'Create app from a table'}</DialogTitle>
          <DialogDescription>
            {multi
              ? 'Pick the tables. Each gets a list screen and a detail screen with an edit form; a home screen links them, and related records open each other.'
              : 'A ready-made app: a list with search and sort, a detail screen with an edit form, Delete with confirmation, related records and the timeline.'}{' '}
            The result is an ordinary app: change anything in the Studio.
          </DialogDescription>
        </DialogHeader>
        {!caps.isMaker ? (
          <p className="text-sm text-muted-foreground" data-testid="auto-app-no-maker">Only makers can create apps. Ask an administrator for the Maker role.</p>
        ) : (
          <div className="grid max-h-[65vh] gap-4 overflow-y-auto pr-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div className="grid content-start gap-4">
              <Field label="App name" htmlFor="auto-app-name">
                <Input id="auto-app-name" value={shownName} onChange={(e) => { setNamed(true); setName(e.target.value) }} data-testid="auto-app-name" />
              </Field>
              <Field label="Device" hint={device === 'phone' ? 'Phone 360 x 800: one column, cards, the related lists on their own screen. Follows the width of larger phones.' : 'Desktop 1920 x 1080: list and form use the whole window; related lists beside the form.'}>
                <Segmented label="Device" value={device} onChange={setDevice} options={[
                  { value: 'desktop', label: <span data-testid="auto-app-device-desktop" className="inline-flex items-center gap-1"><Monitor className="size-3.5" /> Desktop</span> },
                  { value: 'phone', label: <span data-testid="auto-app-device-phone" className="inline-flex items-center gap-1"><Smartphone className="size-3.5" /> Phone</span> },
                ]} />
              </Field>
              <Field label={multi ? 'Tables' : 'Table'} hint={choices.length === 0 ? 'There are no tables you can use. Create a table first.' : multi ? 'The first one ticked comes first on the home screen.' : undefined}>
                {multi ? (
                  <div className="grid max-h-56 gap-0.5 overflow-y-auto rounded-md border border-border p-1" data-testid="auto-app-tables">
                    {choices.map((t) => (
                      <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50">
                        <Checkbox checked={picked.includes(t.name)} onCheckedChange={(v) => toggle(t.name, v === true)} data-testid={`auto-app-table-${t.name}`} />
                        <span className="min-w-0 flex-1 truncate">{t.displayName}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{t.name}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <select
                    value={picked[0] ?? ''}
                    onChange={(e) => setPicked(e.target.value ? [e.target.value] : [])}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                    data-testid="auto-app-table"
                  >
                    {choices.map((t) => <option key={t.id} value={t.name}>{t.displayName}</option>)}
                  </select>
                )}
                {multi && picked.length > 0 && (
                  <Button type="button" variant="ghost" size="xs" className="justify-self-start" onClick={addRelated} data-testid="auto-app-add-related">Add related tables</Button>
                )}
              </Field>
            </div>
            <div className="grid content-start gap-3" data-testid="auto-app-preview">
              <div className="text-xs font-medium text-muted-foreground">What will be created ({size})</div>
              {plan.screens.length === 0 ? (
                <p className="text-sm text-muted-foreground">Choose {multi ? 'one or more tables' : 'a table'}.</p>
              ) : (
                <ol className="grid gap-1.5 text-sm">
                  {plan.screens.map((s, i) => (
                    <li key={i} className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5" data-testid="auto-app-screen">
                      <span className="font-medium">{s.name}</span>
                      <span className="text-muted-foreground"> - {s.what}</span>
                    </li>
                  ))}
                </ol>
              )}
              {plan.tables.map((p) => (
                <div key={p.table.name} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{p.table.displayName}</span>: fields {p.formFields.map((c) => c.displayName || c.name).join(', ') || 'none'}.
                  {' '}List: {p.listColumns.map((c) => c.displayName || c.name).join(', ') || 'no columns'}.
                </div>
              ))}
              {issues.length > 0 && (
                <div className="grid gap-1.5" data-testid="auto-app-issues">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><AlertTriangle className="size-3.5" /> What it cannot do, or does only partly ({issues.length})</div>
                  <ul className="grid gap-1 text-xs">
                    {issues.map((i, k) => (
                      <li key={k} className="flex items-start gap-2" data-testid={`auto-app-issue-${i.level}`}>
                        <Badge variant="outline" className={cn('shrink-0 font-normal', LEVEL[i.level].cls)}>{LEVEL[i.level].label}</Badge>
                        <span><span className="font-medium">{i.table}{i.column ? ` / ${i.column}` : ''}</span>: {i.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />Who can use the app and its data is decided by security roles, as for any app.</p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={busy || !ok} onClick={() => void create()} data-testid="auto-app-create">{busy ? 'Creating...' : 'Create and open'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
