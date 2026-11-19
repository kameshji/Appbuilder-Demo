/**
 * "New flow": a gallery of working templates (src/flows/templates/*.json, validated by a test against the server
 * validator) and blank flows by trigger. Picking a template asks for its parameters (tables, columns of the right type,
 * values) and creates the flow (turned off) with them; the designer opens on it.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePlatform } from '@/platform'
import { errMsg } from '@/portal/kit'
import { DEFAULT_SETTINGS } from '@/platform/flows'
import { flowsApi, type FlowCatalog, type FlowError } from '../api'
import { fittingColumns, guessParams, instantiate, missingParams, type FlowTemplate } from './templateKit'
import { TRIGGER_ICON, FALLBACK_ICON } from './palette'
import { inputCls, Labeled } from './fields'

const loaded = import.meta.glob<FlowTemplate>('../templates/*.json', { eager: true, import: 'default' })
export const TEMPLATES: FlowTemplate[] = Object.values(loaded).sort((a, b) => a.title.localeCompare(b.title))

const BLANK: { type: string; title: string; blurb: string; trigger: Record<string, unknown> }[] = [
  { type: 'table', title: 'When a row changes', blurb: 'Added, changed or deleted rows of a table.', trigger: { type: 'table', table: '', on: ['create'] } },
  { type: 'schedule', title: 'On a schedule', blurb: 'Every day, every hour, weekdays at 8 ...', trigger: { type: 'schedule', cron: '0 8 * * 1-5', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } },
  { type: 'manual', title: 'From a button or by hand', blurb: 'RunFlow in an app, or Run now.', trigger: { type: 'manual', inputs: [], from: 'any' } },
  { type: 'webhook', title: 'When a web request arrives', blurb: 'Another system posts to the flow.', trigger: { type: 'webhook' } },
]

export interface GalleryIntent { table?: string; templateId?: string }

export function NewFlowGallery({ open, onClose, onCreated, intent }: { open: boolean; onClose(): void; onCreated(flowId: string): void; intent?: GalleryIntent }) {
  const tables = usePlatform((s) => s.tables)
  const connections = usePlatform((s) => s.connections)
  const [catalog, setCatalog] = useState<FlowCatalog | null>(null)
  const [picked, setPicked] = useState<FlowTemplate | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => { if (open) flowsApi.catalog().then(setCatalog).catch(() => setCatalog(null)) }, [open])
  useEffect(() => {
    if (!open) return
    setErr(null)
    setQ('')
    const t = intent?.templateId ? TEMPLATES.find((x) => x.id === intent.templateId) ?? null : null
    choose(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, intent?.templateId])
  const choose = (t: FlowTemplate | null) => {
    setPicked(t)
    setErr(null)
    if (t) {
      const v = guessParams(t, tables, intent?.table && t.params.some((p) => p.name === 'table') ? { table: intent.table } : {})
      setValues(v)
      setName(String(instantiate(t, v).name ?? t.title))
    }
  }
  const create = async (body: Record<string, unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      const r = await flowsApi.create({ ...body, enabled: false } as never)
      onCreated(r.flow.id)
    } catch (e) {
      const fe = e as FlowError
      setErr(fe.problems?.length ? `${errMsg(e)}` : errMsg(e))
    } finally { setBusy(false) }
  }
  const blank = (b: typeof BLANK[number]) => {
    const trigger = { ...b.trigger, ...(b.type === 'table' ? { table: intent?.table ?? (tables.find((t) => !t.system) ?? tables[0])?.name ?? '' } : {}) }
    return create({ name: `New flow ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, runAs: 'owner', trigger, steps: [], variables: [], settings: DEFAULT_SETTINGS, connections: {} })
  }
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return TEMPLATES.filter((t) => !s || `${t.title} ${t.description} ${t.category}`.toLowerCase().includes(s))
  }, [q])
  const missing = picked ? missingParams(picked, values) : []
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-4xl" data-testid="new-flow-gallery">
        <DialogHeader>
          <DialogTitle>{picked ? picked.title : 'New flow'}</DialogTitle>
          <DialogDescription>{picked ? picked.description : 'Start from a working template, or from a blank flow with the trigger you need. New flows start turned off.'}</DialogDescription>
        </DialogHeader>
        {!picked ? (
          <div className="grid max-h-[65vh] gap-4 overflow-auto">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Blank flow</h3>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {BLANK.map((b) => {
                  const I = TRIGGER_ICON[b.type] ?? FALLBACK_ICON
                  return <button key={b.type} type="button" disabled={busy} className="flex flex-col items-start gap-1 rounded-lg border border-border p-3 text-left hover:border-primary hover:bg-accent/40" onClick={() => blank(b)} data-testid={`blank-${b.type}`}><I className="size-5 text-primary" /><span className="text-sm font-medium">{b.title}</span><span className="text-[11px] text-muted-foreground">{b.blurb}</span></button>
                })}
              </div>
            </section>
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Templates</h3>
                <input className="ml-auto h-7 w-56 rounded border border-border bg-background px-2 text-xs" placeholder="Search templates" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search templates" />
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {shown.map((t) => {
                  const needsApprovals = t.needs?.includes('approvals') && catalog?.approvals === false
                  return (
                    <button key={t.id} type="button" className="flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:border-primary hover:bg-accent/40" onClick={() => choose(t)} data-testid={`template-${t.id}`}>
                      <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1 text-sm font-medium">{t.title}<span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{t.category}</span>{needsApprovals && <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300" title="Approvals are not available on this server yet: runs stop at the approval step until they are.">needs approvals</span>}</span>
                        <span className="text-[11px] text-muted-foreground">{t.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
            {err && <p className="text-sm text-destructive">{err}</p>}
          </div>
        ) : (
          <div className="grid max-h-[65vh] gap-3 overflow-auto">
            {!tables.length && <p className="text-sm text-amber-700">This environment has no tables yet: create one first.</p>}
            <Labeled label="Flow name" required><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} data-testid="template-name" /></Labeled>
            <div className="grid gap-3 md:grid-cols-2">
              {picked.params.map((p) => {
                const set = (v: string) => {
                  const next = { ...values, [p.name]: v }
                  // a new table: guess its columns again
                  if (p.type === 'table') for (const c of picked.params.filter((x) => x.type === 'column' && (x.of ?? 'table') === p.name)) next[c.name] = guessParams({ ...picked, params: [{ ...p }, c] }, tables, { [p.name]: v })[c.name]
                  setValues(next)
                }
                return (
                  <Labeled key={p.name} label={p.label} required>
                    {p.type === 'table' ? (
                      <select className={inputCls} value={values[p.name] ?? ''} onChange={(e) => set(e.target.value)} data-testid={`param-${p.name}`}><option value="">Choose a table</option>{tables.map((t) => <option key={t.id} value={t.name}>{t.displayName}</option>)}</select>
                    ) : p.type === 'column' ? (
                      <select className={inputCls} value={values[p.name] ?? ''} onChange={(e) => set(e.target.value)} data-testid={`param-${p.name}`}>
                        <option value="">Choose a column</option>
                        {fittingColumns(p, tables.find((t) => t.name === values[p.of ?? 'table'])).map((c) => <option key={c.name} value={c.name}>{c.displayName}</option>)}
                      </select>
                    ) : p.type === 'connection' ? (
                      <select className={inputCls} value={values[p.name] ?? ''} onChange={(e) => set(e.target.value)} data-testid={`param-${p.name}`}><option value="">Choose a connection</option>{connections.filter((c) => c.connector === p.connector).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                    ) : (
                      <input className={inputCls} type={p.type === 'number' ? 'number' : 'text'} value={values[p.name] ?? ''} onChange={(e) => set(e.target.value)} data-testid={`param-${p.name}`} />
                    )}
                  </Labeled>
                )
              })}
            </div>
            {missing.length > 0 && <p className="text-xs text-muted-foreground">Still to fill in: {missing.join(', ')}.</p>}
            {err && <p className="text-sm text-destructive" data-testid="template-error">{err}</p>}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => choose(null)}><ArrowLeft className="size-4" />All templates</Button>
              <Button className="ml-auto" disabled={busy || missing.length > 0 || !name.trim()} data-testid="template-create" onClick={() => { const def = instantiate(picked, values); void create({ ...def, name: name.trim() }) }}>Create the flow</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** the empty state of the Flows page: what a flow is, in three steps, and where to start */
export function FlowsWalkthrough({ onNew }: { onNew(): void }) {
  const steps = [
    ['1. Pick a trigger', 'When a row is added or changed, on a schedule, from a button in an app, or when another system calls.'],
    ['2. Add steps', 'Click + between steps: conditions, loops, data changes, approvals, notifications, emails, web calls. Every field takes a value or a formula, with the data of earlier steps one click away.'],
    ['3. Test, then publish and turn on', 'Test runs with a sample (changes are simulated) and shows each step\'s result on the canvas. Publish makes your draft the running version.'],
  ]
  return (
    <div className="rounded-xl border border-dashed border-border p-6" data-testid="flows-walkthrough">
      <h2 className="text-base font-semibold">Automate work with flows</h2>
      <p className="mb-4 text-sm text-muted-foreground">A flow does work for you when something happens. It runs on the server, and every run is recorded.</p>
      <ol className="mb-4 grid gap-3 md:grid-cols-3">{steps.map(([t, d]) => <li key={t} className="rounded-lg bg-muted/50 p-3"><div className="text-sm font-medium">{t}</div><div className="text-xs text-muted-foreground">{d}</div></li>)}</ol>
      <Button onClick={onNew} data-testid="walkthrough-new"><Sparkles className="size-4" />Start from a template</Button>
    </div>
  )
}
