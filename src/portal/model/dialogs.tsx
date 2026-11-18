/**
 * Designer dialogs: new table, relationship (after dragging one table onto another), patterns, import (spreadsheet,
 * database connection, DBML), export (PNG, SVG, DBML, solution package) and Review changes (the plan, then apply).
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Boxes, CircleAlert, Database, FileSpreadsheet, FileText, GitBranch, Info, LayoutGrid, Table2, TriangleAlert, Eye, Sparkles } from 'lucide-react'
import { usePlatform } from '@/platform'
import type { ColumnDef } from '@/platform'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DeleteBehaviour, Model, ModelPlan, ModelPlanItem } from '@/model/types'
import { DELETE_BEHAVIOURS, DELETE_BEHAVIOUR_LABEL, isSystemTable } from '@/model/types'
import { tableById, userColumns } from '@/model/ops'
import type { RelationshipInput } from '@/model/ops'
import { PATTERNS, PATTERN_GROUPS, type Pattern } from '@/model/patterns'
import { inferSheets, type Inference, type InferredRelationship } from '@/model/infer'
import { Field, errMsg } from '../kit'
import { modelBackend, readSheets } from './modelApi'

/* ------------------------------------------------------------------ new table */

export function NewTableDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange(o: boolean): void; onCreate(displayName: string, columns: Partial<ColumnDef>[]): void }) {
  const [name, setName] = useState('')
  const [cols, setCols] = useState('Name')
  useEffect(() => { if (open) { setName(''); setCols('Name') } }, [open])
  const submit = () => {
    if (!name.trim()) return
    onCreate(name.trim(), cols.split(',').map((c) => c.trim()).filter(Boolean).map((c, i) => ({ displayName: c, type: 'text', ...(i === 0 ? { required: true } : {}) })))
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="model-new-table">
        <DialogHeader>
          <DialogTitle>New table</DialogTitle>
          <DialogDescription>Added to your draft. Nothing changes in the environment until you review and apply.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <Field label="Display name" htmlFor="nt-name"><Input id="nt-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer" data-testid="nt-name" /></Field>
          <Field label="Columns" hint="Text columns, separated by commas. Change types afterwards on the diagram."><Input value={cols} onChange={(e) => setCols(e.target.value)} data-testid="nt-columns" /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim()} data-testid="nt-create">Add to draft</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ relationship */

type Card = RelationshipInput['cardinality']
const CARD_LABEL: Record<Card, { label: string; hint: string }> = {
  oneToMany: { label: 'One-to-many', hint: 'Each row of the "many" table points at one row of the "one" table (a lookup column on the many side).' },
  oneToOne: { label: 'One-to-one', hint: 'A unique lookup: each row of the second table belongs to at most one row of the first, and the other way round.' },
  manyToMany: { label: 'Many-to-many', hint: 'A junction table with a lookup to each side and a unique pair; you can add columns that describe the pair.' },
  self: { label: 'Hierarchy (self)', hint: 'A lookup from the table to itself ("Parent").' },
}

export function RelationshipDialog({ open, onOpenChange, model, from, to, onCreate }: { open: boolean; onOpenChange(o: boolean): void; model: Model; from: string; to: string; onCreate(input: RelationshipInput): void }) {
  const self = from === to
  const [card, setCard] = useState<Card>(self ? 'self' : 'oneToMany')
  const [swap, setSwap] = useState(false)
  const [onDelete, setOnDelete] = useState<DeleteBehaviour>('restrict')
  const [required, setRequired] = useState(false)
  const [colName, setColName] = useState('')
  const [junction, setJunction] = useState('')
  const [extra, setExtra] = useState('')
  const [cycles, setCycles] = useState(true)
  useEffect(() => { if (open) { setCard(from === to ? 'self' : 'oneToMany'); setSwap(false); setOnDelete('restrict'); setRequired(false); setColName(''); setJunction(''); setExtra(''); setCycles(true) } }, [open, from, to])
  // dragging A onto B: A is the "many" side (gets the lookup) unless swapped
  const childId = swap ? to : from
  const parentId = swap ? from : to
  const child = tableById(model, childId)
  const parent = tableById(model, parentId)
  if (!child || !parent) return null
  const create = () => {
    onCreate({
      parent: parentId, child: childId, cardinality: self ? 'self' : card, onDelete: card === 'manyToMany' ? 'cascade' : onDelete,
      required: card !== 'manyToMany' && !self && required, columnName: colName.trim() || undefined, preventCycles: cycles,
      junctionName: junction.trim() || undefined,
      junctionColumns: extra.split(',').map((x) => x.trim()).filter(Boolean).map((x) => ({ displayName: x, type: 'text' as const })),
    })
    onOpenChange(false)
  }
  const cards: Card[] = self ? ['self'] : ['oneToMany', 'oneToOne', 'manyToMany']
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="relationship-dialog">
        <DialogHeader>
          <DialogTitle>New relationship</DialogTitle>
          <DialogDescription>{self ? `${child.displayName} rows get a parent of the same table.` : `Between ${child.displayName} and ${parent.displayName}.`}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <div className="grid grid-cols-3 gap-1.5">
            {cards.map((c) => (
              <button key={c} type="button" onClick={() => setCard(c)} data-testid={`rel-kind-${c}`}
                className={cn('rounded-md border px-2 py-1.5 text-xs font-medium', card === c ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent')}>{CARD_LABEL[c].label}</button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{CARD_LABEL[card].hint}</p>
          {card !== 'manyToMany' && !self && (
            <div className="flex items-center gap-2 rounded-md bg-muted p-2 text-xs">
              <span><b>{parent.displayName}</b> (one)</span><ArrowRight className="size-3" /><span><b>{child.displayName}</b> ({card === 'oneToOne' ? 'one' : 'many'}, gets the lookup)</span>
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setSwap((v) => !v)} data-testid="rel-swap">Swap</Button>
            </div>
          )}
          {card === 'manyToMany' ? (
            <>
              <Field label="Junction table"><Input value={junction} onChange={(e) => setJunction(e.target.value)} placeholder={`${child.displayName} ${parent.displayName}`} /></Field>
              <Field label="Extra columns on the junction" hint="Optional, separated by commas (e.g. Price, Lead time)."><Input value={extra} onChange={(e) => setExtra(e.target.value)} /></Field>
              <p className="text-xs text-muted-foreground">Deleting a row of either side deletes its junction rows (cascade). The pair is unique.</p>
            </>
          ) : (
            <>
              <Field label="Lookup column"><Input value={colName} onChange={(e) => setColName(e.target.value)} placeholder={self ? 'Parent' : parent.displayName} data-testid="rel-column" /></Field>
              <Field label={`When a ${parent.displayName} row is deleted`}>
                <Select value={onDelete} onValueChange={(v) => setOnDelete(v as DeleteBehaviour)}>
                  <SelectTrigger size="sm" className="w-full" data-testid="rel-dialog-on-delete"><SelectValue /></SelectTrigger>
                  <SelectContent>{DELETE_BEHAVIOURS.map((d) => <SelectItem key={d} value={d} disabled={d === 'setBlank' && required}>{DELETE_BEHAVIOUR_LABEL[d]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              {!self && (
                <label className="flex items-center gap-2"><Checkbox checked={required} onCheckedChange={(v) => { setRequired(v === true); if (v === true && onDelete === 'setBlank') setOnDelete('restrict') }} data-testid="rel-dialog-required" />Required parent</label>
              )}
              {self && <label className="flex items-center gap-2"><Checkbox checked={cycles} onCheckedChange={(v) => setCycles(v === true)} />Prevent loops (a row can never become its own ancestor)</label>}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} data-testid="rel-create">Add to draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ patterns */

const GROUP_ICON = { transactional: Table2, reporting: Eye, industry: Boxes }

export function PatternDialog({ open, onOpenChange, model, server, onApply }: { open: boolean; onOpenChange(o: boolean): void; model: Model; server: boolean; onApply(p: Pattern, params: Record<string, unknown>): string | null }) {
  const [key, setKey] = useState(PATTERNS[0].key)
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const p = PATTERNS.find((x) => x.key === key)!
  useEffect(() => {
    const d: Record<string, unknown> = {}
    for (const prm of p.params) if (prm.default !== undefined) d[prm.key] = prm.default
    setParams(d)
    setError(null)
  }, [key, open]) // eslint-disable-line react-hooks/exhaustive-deps
  const userTables = model.tables.filter((t) => !t.reporting && !isSystemTable(t))
  const src = typeof params.fact === 'string' ? tableById(model, params.fact) : typeof params.source === 'string' ? tableById(model, params.source) : undefined
  const set = (k: string, v: unknown) => setParams((x) => ({ ...x, [k]: v }))
  const toggle = (k: string, v: string) => setParams((x) => {
    const l = Array.isArray(x[k]) ? (x[k] as string[]) : []
    return { ...x, [k]: l.includes(v) ? l.filter((y) => y !== v) : [...l, v] }
  })
  const blocked = !!p.serverOnly && !server
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl" data-testid="pattern-dialog">
        <DialogHeader>
          <DialogTitle>Start from a pattern</DialogTitle>
          <DialogDescription>A pattern adds a starter model to your draft. Review and adjust it on the diagram, then apply.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-[420px] grid-cols-[260px_1fr] gap-4">
          <div className="max-h-[60vh] overflow-auto pr-1">
            {(Object.keys(PATTERN_GROUPS) as (keyof typeof PATTERN_GROUPS)[]).map((g) => {
              const Icon = GROUP_ICON[g]
              return (
                <div key={g} className="mb-3">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Icon className="size-3.5" />{PATTERN_GROUPS[g].label}</div>
                  {PATTERNS.filter((x) => x.group === g).map((x) => (
                    <button key={x.key} type="button" onClick={() => setKey(x.key)} data-testid={`pattern-${x.key}`}
                      className={cn('block w-full rounded-md px-2 py-1.5 text-left text-sm', key === x.key ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent')}>{x.label}</button>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="grid content-start gap-3 text-sm">
            <div className="text-base font-semibold">{p.label}</div>
            <p className="rounded-md bg-muted p-2"><b>When to use it:</b> {p.when}</p>
            <p className="text-muted-foreground">{p.explain}</p>
            {p.group === 'reporting' && (
              <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs" data-testid="pattern-reporting-note">
                <Info className="mt-px size-3.5 shrink-0" />{PATTERN_GROUPS.reporting.note} Keep entering data in your transactional tables; these are for reports and dashboards.
              </p>
            )}
            {blocked && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">This pattern needs the local server (database views or a scheduled refresh). In demo mode, read about it here and try it on a server install.</p>}
            {p.params.map((prm) => (
              <Field key={prm.key} label={prm.label} hint={prm.hint}>
                {prm.kind === 'text' || prm.kind === 'cron' || prm.kind === 'date' ? (
                  <Input type={prm.kind === 'date' ? 'date' : 'text'} value={String(params[prm.key] ?? '')} onChange={(e) => set(prm.key, e.target.value)} data-testid={`param-${prm.key}`} />
                ) : prm.kind === 'month' ? (
                  <Select value={String(params[prm.key] ?? 4)} onValueChange={(v) => set(prm.key, Number(v))}>
                    <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{['January', 'February', 'March', 'April (India: April to March)', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
                  </Select>
                ) : prm.kind === 'boolean' ? (
                  <label className="flex items-center gap-2"><Checkbox checked={params[prm.key] !== false} onCheckedChange={(v) => set(prm.key, v === true)} />Yes</label>
                ) : prm.kind === 'table' ? (
                  <div className="flex gap-2">
                    <Select value={tableById(model, String(params[prm.key] ?? '')) ? String(params[prm.key]) : '__new'} onValueChange={(v) => set(prm.key, v === '__new' ? (prm.default ?? '') : v)}>
                      <SelectTrigger size="sm" className="w-full" data-testid={`param-${prm.key}`}><SelectValue placeholder="Pick a table" /></SelectTrigger>
                      <SelectContent>
                        {prm.allowNew && <SelectItem value="__new">A new table...</SelectItem>}
                        {userTables.map((t) => <SelectItem key={t.id} value={t.id}>{t.displayName}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {prm.allowNew && !tableById(model, String(params[prm.key] ?? '')) && <Input value={String(params[prm.key] ?? '')} onChange={(e) => set(prm.key, e.target.value)} placeholder="Name of the new table" />}
                  </div>
                ) : (
                  <div className="flex max-h-32 flex-wrap gap-1.5 overflow-auto" data-testid={`param-${prm.key}`}>
                    {!src && <span className="text-xs text-muted-foreground">Pick the table first.</span>}
                    {src && userColumns(src).filter((c) => prm.kind === 'lookups' ? c.type === 'lookup' : prm.kind === 'measures' ? ['number', 'decimal', 'currency'].includes(c.type) : prm.kind === 'dateColumn' ? ['date', 'datetime'].includes(c.type) : !c.computed).map((c) => {
                      const on = prm.kind === 'dateColumn' ? params[prm.key] === c.name : Array.isArray(params[prm.key]) && (params[prm.key] as string[]).includes(c.name)
                      return <button key={c.name} type="button" onClick={() => (prm.kind === 'dateColumn' ? set(prm.key, on ? '' : c.name) : toggle(prm.key, c.name))} data-testid={`param-${prm.key}-${c.name}`}
                        className={cn('rounded-full border px-2 py-0.5 text-xs', on ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent')}>{c.displayName}</button>
                    })}
                  </div>
                )}
              </Field>
            ))}
            {error && <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert"><CircleAlert className="mt-px size-3.5" />{error}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={blocked} data-testid="pattern-add" onClick={() => { const e = onApply(p, params); if (e) setError(e); else onOpenChange(false) }}><Sparkles />Add to draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ import */

export interface ImportOutcome { kind: 'sheets'; inference: Inference; accepted: InferredRelationship[] }

export function ImportDialog({ open, onOpenChange, server, onSheets, onDatabase, onDbml }: {
  open: boolean; onOpenChange(o: boolean): void; server: boolean
  onSheets(inf: Inference, accepted: InferredRelationship[]): void
  onDatabase(connectionId: string, mode: 'link' | 'copy'): Promise<string[]>
  onDbml(text: string): string[]
}) {
  const connections = usePlatform((s) => s.connections).filter((c) => (c.connector === 'postgres' || c.connector === 'mysql') && c.id !== 'conn_default')
  const [tab, setTab] = useState('sheets')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inf, setInf] = useState<Inference | null>(null)
  const [accepted, setAccepted] = useState<Set<number>>(new Set())
  const [conn, setConn] = useState('')
  const [mode, setMode] = useState<'link' | 'copy'>('link')
  const [dbml, setDbml] = useState('')
  const [notes, setNotes] = useState<string[]>([])
  useEffect(() => { if (open) { setInf(null); setError(null); setNotes([]); setBusy(false) } }, [open])
  const pick = async (f: File | undefined) => {
    if (!f) return
    setBusy(true)
    setError(null)
    try {
      const sheets = await readSheets(f)
      const r = inferSheets(sheets)
      setInf(r)
      setAccepted(new Set(r.relationships.map((_, i) => i).filter((i) => r.relationships[i].confidence >= 0.6)))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="model-import">
        <DialogHeader>
          <DialogTitle>Import a model</DialogTitle>
          <DialogDescription>Tables and relationships go into your draft; you confirm them before anything is created.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="sheets"><FileSpreadsheet className="size-3.5" />Excel or CSV</TabsTrigger>
            <TabsTrigger value="db"><Database className="size-3.5" />Database</TabsTrigger>
            <TabsTrigger value="dbml"><FileText className="size-3.5" />DBML text</TabsTrigger>
          </TabsList>
          <TabsContent value="sheets" className="grid gap-3 text-sm">
            <p className="text-muted-foreground">One table per sheet. Types come from the values; a column whose values are all different becomes a key; columns named like another sheet, or whose values are that sheet's keys, become lookups. {server ? '' : 'Demo mode reads CSV files only.'}</p>
            <Input type="file" accept={server ? '.xlsx,.csv' : '.csv'} onChange={(e) => void pick(e.target.files?.[0])} data-testid="import-file" />
            {busy && <Spinner />}
            {inf && (
              <div className="grid max-h-80 gap-2 overflow-auto rounded-md border p-2" data-testid="import-inference">
                {inf.tables.map((t) => (
                  <div key={t.sheet} className="text-xs">
                    <b>{t.displayName}</b> <span className="text-muted-foreground">({t.rows} rows)</span>: {t.columns.map((c) => `${c.header} ${c.type}${c.header === t.key ? ' (key)' : ''}`).join(', ')}
                  </div>
                ))}
                {inf.relationships.length > 0 && <div className="mt-1 text-xs font-semibold">Likely relationships</div>}
                {inf.relationships.map((r, i) => (
                  <label key={i} className="flex items-start gap-2 text-xs">
                    <Checkbox checked={accepted.has(i)} onCheckedChange={(v) => setAccepted((s) => { const n = new Set(s); if (v === true) n.add(i); else n.delete(i); return n })} />
                    <span><b>{r.from}.{r.fromColumn}</b> → {r.to} ({Math.round(r.confidence * 100)}%): {r.reason}</span>
                  </label>
                ))}
              </div>
            )}
            <DialogFooter><Button disabled={!inf} onClick={() => { onSheets(inf!, inf!.relationships.filter((_, i) => accepted.has(i))); onOpenChange(false) }} data-testid="import-sheets-add">Add to draft</Button></DialogFooter>
          </TabsContent>
          <TabsContent value="db" className="grid gap-3 text-sm">
            {!server ? <p className="text-muted-foreground">Reading another database needs the local server.</p> : !connections.length ? <p className="text-muted-foreground">Add a PostgreSQL or MySQL connection first (Connections).</p> : (
              <>
                <Field label="Connection">
                  <Select value={conn} onValueChange={setConn}><SelectTrigger size="sm" className="w-full"><SelectValue placeholder="Pick a connection" /></SelectTrigger>
                    <SelectContent>{connections.map((c) => <SelectItem key={c.id} value={c.id}>{c.name} ({c.connector})</SelectItem>)}</SelectContent></Select>
                </Field>
                <div className="grid gap-1.5">
                  <label className="flex items-start gap-2"><input type="radio" checked={mode === 'link'} onChange={() => setMode('link')} className="mt-1" /><span><b>Link</b>: the tables stay in their database; Appbuilder registers them. Foreign keys to an id column become lookups.</span></label>
                  <label className="flex items-start gap-2"><input type="radio" checked={mode === 'copy'} onChange={() => setMode('copy')} className="mt-1" /><span><b>Copy the structure</b>: new tables in the default database with the same columns; every foreign key becomes a lookup. Rows are not copied.</span></label>
                </div>
                {notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
                <DialogFooter><Button disabled={!conn || busy} onClick={async () => { setBusy(true); setError(null); try { const w = await onDatabase(conn, mode); if (w.length) setNotes(w); else onOpenChange(false) } catch (e) { setError(errMsg(e)) } finally { setBusy(false) } }}>{busy && <Spinner />}Read the tables</Button></DialogFooter>
              </>
            )}
          </TabsContent>
          <TabsContent value="dbml" className="grid gap-3 text-sm">
            <textarea value={dbml} onChange={(e) => setDbml(e.target.value)} rows={12} className="w-full rounded-md border bg-background p-2 font-mono text-xs" placeholder={'Table Customer {\n  Name text [not null]\n}\nTable Order {\n  Customer lookup [ref: > Customer.id]\n}'} data-testid="import-dbml" />
            {notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
            <DialogFooter><Button disabled={!dbml.trim()} onClick={() => { const w = onDbml(dbml); if (w.length) setNotes(w); else onOpenChange(false) }} data-testid="import-dbml-add">Add to draft</Button></DialogFooter>
          </TabsContent>
        </Tabs>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ review changes */

const KIND_ICON = { table: Table2, column: LayoutGrid, relationship: GitBranch, view: Eye, index: Database, data: FileSpreadsheet }
const CHANGE_STYLE: Record<ModelPlanItem['change'], string> = {
  new: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  changed: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  removed: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
}

export function PlanList({ plan }: { plan: ModelPlan }) {
  const order: ModelPlanItem['change'][] = ['removed', 'changed', 'new']
  const items = [...plan.items].sort((a, b) => order.indexOf(a.change) - order.indexOf(b.change))
  return (
    <div className="grid gap-3" data-testid="model-plan">
      <div className="flex flex-wrap gap-1.5 text-xs" data-testid="model-plan-counts">
        {order.map((c) => { const n = plan.items.filter((i) => i.change === c).length; return n > 0 && <span key={c} className={cn('rounded px-1.5 py-0.5 font-medium', CHANGE_STYLE[c])}>{n} {c}</span> })}
      </div>
      {plan.problems.length > 0 && (
        <div className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive" role="alert" data-testid="model-plan-problems">
          <span className="flex items-center gap-1.5 font-semibold"><CircleAlert className="size-3.5" /> This cannot be applied yet:</span>
          {plan.problems.map((p) => <span key={p}>{p}</span>)}
        </div>
      )}
      {plan.destructive && (
        <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-800 dark:text-rose-200" data-testid="model-plan-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" /><span><b>Data will be lost.</b> Items in red drop tables or columns with data, or convert values with less precision.</span>
        </div>
      )}
      <div className="max-h-80 overflow-auto rounded-md border" data-testid="model-plan-items">
        {!items.length && <p className="p-3 text-sm text-muted-foreground">Nothing changes.</p>}
        {items.map((i, n) => {
          const Icon = KIND_ICON[i.kind]
          return (
            <div key={n} className={cn('border-b px-3 py-2 text-sm last:border-0', i.destructive && 'bg-rose-500/5')} data-testid={`model-plan-item-${i.kind}-${i.change}`} data-destructive={i.destructive ? 'true' : undefined}>
              <div className="flex items-center gap-2">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{i.kind}</span>
                <span className={cn('truncate font-medium', i.destructive && 'text-rose-700 dark:text-rose-300')}>{i.kind === 'column' ? `${i.table}.${i.name}` : i.kind === 'relationship' ? i.name : i.table}</span>
                {i.rows !== undefined && <span className="text-xs text-muted-foreground">{i.rows.toLocaleString()} rows</span>}
                <span className={cn('ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium', CHANGE_STYLE[i.change])}>{i.change}</span>
                {i.destructive && <TriangleAlert className="size-3.5 text-rose-600" aria-label="destructive" />}
              </div>
              {i.note && <div className="mt-0.5 pl-5 text-xs text-muted-foreground">{i.note}</div>}
              {i.conversion && (
                <div className={cn('mt-0.5 pl-5 text-xs', i.conversion.failing ? 'font-medium text-destructive' : 'text-emerald-700 dark:text-emerald-300')} data-testid="model-plan-conversion">
                  {i.conversion.failing ? `${i.conversion.failing} of ${i.conversion.checked} values will not convert, e.g. ${i.conversion.examples.map((x) => `"${x}"`).join(', ')}` : `All ${i.conversion.checked} values convert.`}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {plan.warnings.map((w) => <p key={w} className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-px size-3.5 shrink-0" /> {w}</p>)}
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="model-plan-backup"><Info className="mt-px size-3.5 shrink-0" /> {plan.backup.message}</p>
    </div>
  )
}

export function ReviewDialog({ open, onOpenChange, load, apply }: { open: boolean; onOpenChange(o: boolean): void; load(): Promise<ModelPlan>; apply(token: string): Promise<void> }) {
  const [plan, setPlan] = useState<ModelPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const refresh = useMemo(() => async () => {
    setPlan(null); setError(null); setAck(false)
    try { setPlan(await load()) } catch (e) { setError(errMsg(e)) }
  }, [load])
  useEffect(() => { if (open) void refresh() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const ok = !!plan && !plan.problems.length && plan.opCount > 0 && (!plan.destructive || ack)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="model-review">
        <DialogHeader>
          <DialogTitle>Review changes</DialogTitle>
          <DialogDescription>{modelBackend().mode === 'server' ? 'Everything below is applied together in one transaction, or not at all.' : 'Demo mode: the changes are applied one after the other in this browser.'}</DialogDescription>
        </DialogHeader>
        {!plan && !error && <div className="grid h-40 place-items-center"><Spinner /></div>}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        {plan && <PlanList plan={plan} />}
        {plan?.destructive && !plan.problems.length && (
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} data-testid="model-plan-ack" />I understand that the data in the red items is lost.</label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button disabled={!ok || busy} data-testid="model-apply" onClick={async () => {
            setBusy(true)
            try { await apply(plan!.token); onOpenChange(false) } catch (e) { setError(errMsg(e)); const p = (e as { plan?: ModelPlan }).plan; if (p) setPlan(p) } finally { setBusy(false) }
          }}>{busy && <Spinner />}Apply {plan ? `${plan.items.length} change${plan.items.length === 1 ? '' : 's'}` : ''}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

