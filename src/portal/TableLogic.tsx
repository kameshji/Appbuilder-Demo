/**
 * Table designer tabs for server logic (docs/guide/maker/data.md): validation rules, formula columns, rollups and table
 * events, with formula checks by the server's engine and a test run against a sample row. Formula columns also work in
 * demo mode (computed in the browser); validation rules, rollups and events need the server.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, FlaskConical, Pencil, Play, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import type { ColumnDef, ColumnType, TableDef } from '@/platform'
import type { EventRunEntry, EventTestResult, FormulaProblem, RollupFn, TableEventDef, TableEventInput, TableEventOperation } from '@/platform/events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { Empty, Field, Panel, Segmented, errMsg, fmtRelative, useToast } from './kit'
import { useCaps } from './security'
import {
  checkFormula, createEvent, deleteEvent, listEvents, tableEventRuns, testEvent, updateEvent, type FormulaRole,
} from './eventsApi'

/* ------------------------------------------------------------------ shared pieces */

function ServerOnly({ what }: { what: string }) {
  return (
    <Panel className="flex items-start gap-3 p-5 text-sm" data-testid="server-only-note">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div>
        <div className="font-medium">{what} need the server</div>
        <p className="mt-0.5 text-muted-foreground">They run on the Appbuilder server (inside the save, or afterwards through its job queue) and are not available in the browser-only demo. Formula columns work here too.</p>
      </div>
    </Panel>
  )
}

/** a formula text box checked by the server's engine as you type (server mode) */
export function FormulaBox({ tableId, role, value, onChange, placeholder, rows = 3, testId }: {
  tableId: string; role: FormulaRole; value: string; onChange(v: string): void; placeholder?: string; rows?: number; testId?: string
}) {
  const caps = useCaps()
  const [problems, setProblems] = useState<FormulaProblem[] | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    if (!caps.server || !value.trim()) { setProblems(null); return }
    const n = ++seq.current
    const t = setTimeout(() => {
      checkFormula(tableId, value, role).then((p) => { if (n === seq.current) setProblems(p) }).catch(() => { if (n === seq.current) setProblems(null) })
    }, 350)
    return () => clearTimeout(t)
  }, [tableId, role, value, caps.server])
  return (
    <div className="grid gap-1">
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder} spellCheck={false} className="font-mono text-xs" data-testid={testId} />
      {problems && problems.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert" data-testid={testId ? `${testId}-problem` : undefined}><XCircle className="mt-0.5 size-3.5 shrink-0" />{problems[0].message}</p>
      )}
      {problems && problems.length === 0 && <p className="flex items-center gap-1.5 text-xs text-emerald-600"><CheckCircle2 className="size-3.5" />The server accepts this formula.</p>}
    </div>
  )
}

function useEvents(tableId: string, enabled: boolean) {
  const [items, setItems] = useState<TableEventDef[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    if (!enabled) return
    listEvents(tableId).then((x) => { setItems(x); setError('') }).catch((e) => setError(errMsg(e)))
  }, [tableId, enabled])
  useEffect(load, [load])
  return { items, error, reload: load }
}

const OPS: TableEventOperation[] = ['create', 'update', 'delete']
const opLabel: Record<TableEventOperation, string> = { create: 'Create', update: 'Update', delete: 'Delete' }

/** a sample row for test runs: one of the table's loaded rows, or blank */
function SamplePicker({ table, value, onChange }: { table: TableDef; value: string; onChange(id: string): void }) {
  const rows = platform.tables.rows(table.name, { secure: false }).slice(0, 50)
  return (
    <Select value={value || '__blank'} onValueChange={(v) => onChange(v === '__blank' ? '' : v)}>
      <SelectTrigger size="sm" className="w-64" data-testid="sample-row"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__blank">A blank row</SelectItem>
        {rows.map((r) => <SelectItem key={String(r.id)} value={String(r.id)}>{String(r[table.primaryColumn] ?? r.id ?? '').slice(0, 60) || String(r.id)}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function sampleOf(table: TableDef, id: string, overrides: Record<string, string>): Record<string, unknown> {
  const row = id ? platform.tables.rows(table.name, { secure: false }).find((r) => String(r.id) === id) : undefined
  const out: Record<string, unknown> = {}
  for (const c of table.columns) {
    if (c.system && c.name !== 'id') continue
    const v = row?.[c.name]
    out[c.name] = v instanceof Date ? (c.type === 'date' ? v.toISOString().slice(0, 10) : v.toISOString()) : (v ?? null)
  }
  for (const [k, v] of Object.entries(overrides)) if (v !== '') out[k] = v
  return out
}

function TestResultView({ r }: { r: EventTestResult }) {
  const line = (icon: ReactNode, text: ReactNode, tone = '') => <div className={cn('flex items-start gap-1.5', tone)}>{icon}<span>{text}</span></div>
  return (
    <div className="grid gap-1 rounded-md border border-border bg-muted/40 p-3 text-xs" data-testid="test-result">
      {r.error && line(<XCircle className="mt-0.5 size-3.5 text-destructive" />, `Error: ${r.error}`, 'text-destructive')}
      {r.skipped && line(<CheckCircle2 className="mt-0.5 size-3.5 text-muted-foreground" />, 'The condition is false: the event would not run for this row.')}
      {r.rejected && line(<XCircle className="mt-0.5 size-3.5 text-destructive" />, <>Refused: <b>{r.rejected.message}</b>{r.rejected.field ? <> (shown on {r.rejected.field})</> : null}</>, 'text-destructive')}
      {!r.error && !r.skipped && !r.rejected && line(<CheckCircle2 className="mt-0.5 size-3.5 text-emerald-600" />, 'Passes.')}
      {Object.keys(r.changes).length > 0 && <div>Sets: {Object.entries(r.changes).map(([k, v]) => <code key={k} className="mr-2">{k} = {JSON.stringify(v)}</code>)}</div>}
      {r.writes.map((w, i) => <div key={i}>Would {w.op} {w.table}{w.rowId ? ` row ${w.rowId.slice(0, 8)}` : ''}{w.values ? `: ${JSON.stringify(w.values)}` : ''}</div>)}
      {r.notifications.map((n, i) => <div key={`n${i}`}>Would notify {n.to}: {n.message}</div>)}
      {r.jobs.map((j, i) => <div key={`j${i}`}>Would enqueue job {j.type}</div>)}
      {r.traces.map((t, i) => <div key={`t${i}`} className="text-muted-foreground">Trace: {t}</div>)}
      <div className="text-muted-foreground">{r.durationMs} ms, {r.rowsRead} {r.rowsRead === 1 ? 'row' : 'rows'} read. Nothing was saved.</div>
    </div>
  )
}

/* ------------------------------------------------------------------ the editor of one rule or event */

interface Draft {
  name: string
  timing: 'before' | 'after'
  operations: TableEventOperation[]
  condition: string
  actions: string
  message: string
  field: string
  order: string
  runAs: 'caller' | 'system'
  enabled: boolean
}

const draftOf = (e: TableEventDef | null, kind: 'validation' | 'event'): Draft => ({
  name: e?.name ?? '', timing: e?.timing ?? 'before', operations: e?.operations ?? ['create', 'update'], condition: e?.condition ?? '', actions: e?.actions ?? '',
  message: e?.message ?? '', field: e?.field ?? '', order: String(e?.order ?? 100), runAs: e?.runAs ?? 'caller', enabled: e?.enabled ?? true,
  ...(kind === 'validation' ? { timing: 'before' as const } : {}),
})

function inputOf(d: Draft, kind: 'validation' | 'event'): TableEventInput {
  const base: TableEventInput = { kind, name: d.name.trim(), operations: d.operations, order: Number(d.order) || 0, enabled: d.enabled, runAs: d.runAs, condition: d.condition }
  return kind === 'validation' ? { ...base, timing: 'before', message: d.message, field: d.field } : { ...base, timing: d.timing, actions: d.actions }
}

function EventEditor({ table, kind, event, onDone }: { table: TableDef; kind: 'validation' | 'event'; event: TableEventDef | null; onDone(saved: boolean): void }) {
  const caps = useCaps()
  const { toast } = useToast()
  const [d, setD] = useState<Draft>(() => draftOf(event, kind))
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [sampleId, setSampleId] = useState('')
  const [result, setResult] = useState<EventTestResult | null>(null)
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))
  const cols = table.columns.filter((c) => !c.system)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      if (event) await updateEvent(table.id, event.id, inputOf(d, kind))
      else await createEvent(table.id, inputOf(d, kind))
      toast(kind === 'validation' ? 'Validation rule saved' : 'Event saved', 'success')
      onDone(true)
    } catch (e) {
      setError({ message: errMsg(e), field: (e as { field?: string }).field })
    } finally {
      setBusy(false)
    }
  }
  const test = async () => {
    setResult(null)
    try {
      setResult(await testEvent(table.id, { ...inputOf(d, kind), name: d.name || 'Test' }, sampleOf(table, sampleId, {}), d.operations[0] ?? 'create'))
    } catch (e) {
      setError({ message: errMsg(e), field: (e as { field?: string }).field })
    }
  }
  return (
    <Panel className="grid gap-4 p-5" data-testid={`${kind}-editor`}>
      <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-4">
        <Field label="Name"><Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={kind === 'validation' ? 'Quantity must be positive' : 'Set the line total'} data-testid="event-name" /></Field>
        <Field label="Order" hint="Lower runs first"><Input value={d.order} onChange={(e) => set({ order: e.target.value })} inputMode="numeric" /></Field>
      </div>
      {kind === 'event' && (
        <div className="flex flex-wrap items-end gap-6">
          <Field label="Runs">
            <Segmented label="When the event runs" value={d.timing} onChange={(v) => set({ timing: v })} options={[{ value: 'before', label: 'Before saving' }, { value: 'after', label: 'After saving' }]} size="sm" />
          </Field>
          <Field label="On">
            <div className="flex h-8 items-center gap-4">
              {OPS.map((o) => (
                <label key={o} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={d.operations.includes(o)} onCheckedChange={(v) => set({ operations: v === true ? [...d.operations, o] : d.operations.filter((x) => x !== o) })} />{opLabel[o]}
                </label>
              ))}
            </div>
          </Field>
        </div>
      )}
      {kind === 'validation' ? (
        <>
          <Field label="Rule: a formula that must be true for the record" hint={<>Column names refer to the record being saved, for example <code>Qty &gt; 0</code> or <code>IsBlank(EndDate) || EndDate &gt;= StartDate</code>.</>}>
            <FormulaBox tableId={table.id} role="validation" value={d.condition} onChange={(v) => set({ condition: v })} rows={2} testId="rule-condition" />
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)_220px] gap-4">
            <Field label="Message when it is not"><Input value={d.message} onChange={(e) => set({ message: e.target.value })} placeholder="Quantity must be more than 0" data-testid="rule-message" /></Field>
            <Field label="Show it on the field">
              <Select value={d.field || '__none'} onValueChange={(v) => set({ field: v === '__none' ? '' : v })}>
                <SelectTrigger size="sm" data-testid="rule-field"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">No particular field</SelectItem>
                  {cols.map((c) => <SelectItem key={c.name} value={c.name}>{c.displayName}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Condition (optional): the event runs only when this is true" hint={<>Use <code>New.Column</code> and <code>Old.Column</code>; inside Filter and LookUp, plain names are the searched table's columns.</>}>
            <FormulaBox tableId={table.id} role="condition" value={d.condition} onChange={(v) => set({ condition: v })} rows={2} testId="event-condition" />
          </Field>
          <Field label="Actions" hint={d.timing === 'before'
            ? <>Before saving: <code>SetField(&#123;Column: value&#125;)</code> changes this record, <code>Reject("message", Column)</code> refuses the save. LookUp and Filter read other tables.</>
            : <>After saving (in the background, retried on failure): <code>Patch</code>, <code>Collect</code> and <code>Remove</code> change rows, <code>NotifyUser(email, message)</code>, <code>EnqueueJob(type, payload)</code>.</>}>
            <FormulaBox tableId={table.id} role={d.timing} value={d.actions} onChange={(v) => set({ actions: v })} rows={4} testId="event-actions" />
          </Field>
          <Field label="Reads and writes as">
            <Segmented label="Identity" size="sm" value={d.runAs} onChange={(v) => set({ runAs: v })} options={[
              { value: 'caller', label: 'The person who saved' },
              { value: 'system', label: 'The system (all rows)', title: caps.isAdmin ? 'Ignores row and column security. Recorded in the audit log.' : 'Only administrators can choose this' },
            ]} disabled={!caps.isAdmin && d.runAs !== 'system'} />
          </Field>
        </>
      )}
      <label className="flex items-center gap-2 text-sm"><Switch checked={d.enabled} onCheckedChange={(v) => set({ enabled: v })} /> Enabled</label>
      {error && <p className="text-sm text-destructive" role="alert" data-testid="event-error">{error.message}</p>}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <span className="text-xs text-muted-foreground">Test against</span>
        <SamplePicker table={table} value={sampleId} onChange={setSampleId} />
        <Button variant="outline" size="sm" onClick={() => void test()} data-testid="event-test"><FlaskConical /> Test run</Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => onDone(false)}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} disabled={busy || !d.name.trim()} data-testid="event-save">Save</Button>
      </div>
      {result && <TestResultView r={result} />}
    </Panel>
  )
}

function EventList({ table, kind }: { table: TableDef; kind: 'validation' | 'event' }) {
  const caps = useCaps()
  const { fail, toast } = useToast()
  const { items, error, reload } = useEvents(table.id, caps.server)
  const [editing, setEditing] = useState<TableEventDef | 'new' | null>(null)
  if (!caps.server) return <ServerOnly what={kind === 'validation' ? 'Validation rules' : 'Table events'} />
  const list = (items ?? []).filter((e) => e.kind === kind)
  const toggle = async (e: TableEventDef) => {
    try {
      await updateEvent(table.id, e.id, { enabled: !e.enabled })
      reload()
    } catch (x) { fail(x) }
  }
  const remove = async (e: TableEventDef) => {
    try {
      await deleteEvent(table.id, e.id)
      toast(`Deleted "${e.name}"`, 'success')
      reload()
    } catch (x) { fail(x) }
  }
  return (
    <div className="grid max-w-4xl gap-3" data-testid={`${kind}-list`}>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{kind === 'validation'
          ? 'Checked by the server on every save, from apps, the grid, imports and the API. A refused save shows the message on the field.'
          : 'Server logic of this table: before-events change or refuse a save inside it; after-events run once the save is done.'}</p>
        <Button size="sm" onClick={() => setEditing('new')} data-testid={`add-${kind}`}><Plus /> {kind === 'validation' ? 'Add rule' : 'Add event'}</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {editing === 'new' && <EventEditor table={table} kind={kind} event={null} onDone={(s) => { setEditing(null); if (s) reload() }} />}
      {items && !list.length && editing !== 'new' && (
        <Empty icon={kind === 'validation' ? CheckCircle2 : Play} title={kind === 'validation' ? 'No validation rules' : 'No events'} description={kind === 'validation' ? 'Add a rule such as "Quantity must be more than 0".' : 'Add an event to set fields, refuse saves, or update other tables.'} />
      )}
      {list.map((e) => editing !== 'new' && editing?.id === e.id ? (
        <EventEditor key={e.id} table={table} kind={kind} event={e} onDone={(s) => { setEditing(null); if (s) reload() }} />
      ) : (
        <Panel key={e.id} className="flex items-start gap-3 p-4" data-testid={`${kind}-item`}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {e.name}
              {kind === 'event' && <Badge variant="secondary">{e.timing === 'before' ? 'Before saving' : 'After saving'}</Badge>}
              <Badge variant="outline">{e.operations.map((o) => opLabel[o]).join(', ')}</Badge>
              {e.runAs === 'system' && <Badge variant="destructive">Runs as system</Badge>}
              {!e.enabled && <Badge variant="outline">Off</Badge>}
            </div>
            <code className="mt-1 block truncate text-xs text-muted-foreground">{kind === 'validation' ? e.condition : `${e.condition ? `If ${e.condition}: ` : ''}${e.actions}`}</code>
            {kind === 'validation' && <div className="mt-0.5 text-xs">"{e.message}"{e.field ? ` on ${table.columns.find((c) => c.name === e.field)?.displayName ?? e.field}` : ''}</div>}
          </div>
          <Switch checked={e.enabled} onCheckedChange={() => void toggle(e)} aria-label="Enabled" />
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(e)} aria-label="Edit"><Pencil /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => void remove(e)} aria-label="Delete"><Trash2 /></Button>
        </Panel>
      ))}
      {kind === 'event' && <RunLog table={table} />}
    </div>
  )
}

export function ValidationRulesPanel({ table }: { table: TableDef }) {
  return <EventList table={table} kind="validation" />
}

export function EventsPanel({ table }: { table: TableDef }) {
  return <EventList table={table} kind="event" />
}

/* ------------------------------------------------------------------ run log */

export function RunStatus({ s }: { s: EventRunEntry['status'] }) {
  const v = s === 'ok' ? 'secondary' : s === 'skipped' ? 'outline' : 'destructive'
  return <Badge variant={v} className="w-[68px] justify-center">{s === 'ok' ? 'OK' : s === 'rejected' ? 'Refused' : s === 'failed' ? 'Failed' : 'Skipped'}</Badge>
}

function RunLog({ table }: { table: TableDef }) {
  const [items, setItems] = useState<EventRunEntry[] | null>(null)
  const load = useCallback(() => { tableEventRuns(table.id, 30).then(setItems).catch(() => setItems([])) }, [table.id])
  useEffect(load, [load])
  return (
    <div className="mt-4 grid gap-2" data-testid="event-run-log">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold">Recent runs</h3>
        <Button variant="ghost" size="sm" onClick={load}><RefreshCw /> Refresh</Button>
      </div>
      {items && !items.length && <p className="text-sm text-muted-foreground">No runs yet.</p>}
      {items && items.length > 0 && (
        <Panel className="divide-y divide-border">
          {items.map((r) => (
            <div key={r.id} className="grid grid-cols-[76px_minmax(0,180px)_70px_60px_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-xs">
              <RunStatus s={r.status} />
              <span className="truncate font-medium">{r.eventName}</span>
              <span className="text-muted-foreground">{r.timing} {r.op}</span>
              <span className="text-right tabular-nums text-muted-foreground">{r.durationMs} ms</span>
              <span className="truncate" title={r.message}>{r.message ?? ''} <span className="text-muted-foreground">{fmtRelative(r.at)}</span></span>
            </div>
          ))}
        </Panel>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ formula columns */

const FORMULA_TYPES: { value: ColumnType; label: string }[] = [
  { value: 'decimal', label: 'Decimal number' }, { value: 'number', label: 'Whole number' }, { value: 'currency', label: 'Currency' },
  { value: 'text', label: 'Text' }, { value: 'boolean', label: 'Yes / no' }, { value: 'date', label: 'Date' }, { value: 'datetime', label: 'Date and time' },
]

export function FormulaColumnsPanel({ table }: { table: TableDef }) {
  const { fail, toast } = useToast()
  const caps = useCaps()
  const cols = table.columns.filter((c) => c.computed?.kind === 'formula')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState<ColumnType>('decimal')
  const [formula, setFormula] = useState('')
  const [busy, setBusy] = useState(false)
  const reset = () => { setAdding(false); setEditing(null); setName(''); setFormula(''); setType('decimal') }
  const save = async () => {
    setBusy(true)
    try {
      if (editing) await platform.tables.updateColumn(table.id, editing, { computed: { kind: 'formula', formula } })
      else await platform.tables.addColumn(table.id, { displayName: name.trim(), type, computed: { kind: 'formula', formula } })
      toast(caps.server ? 'Formula column saved; existing rows are filled in the background' : 'Formula column saved', 'success')
      reset()
      await platform.tables.reload(table.name).catch(() => {})
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const editor = (
    <Panel className="grid gap-4 p-5" data-testid="formula-column-editor">
      <p className="text-xs text-muted-foreground" role="note" data-testid="formula-visibility-note">Calculated by the system: if the formula reads a column some people may not see, they still see its result in this column. Limit this column in column security when that matters.</p>
      {!editing && (
        <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-4">
          <Field label="Column name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Line total" data-testid="formula-column-name" /></Field>
          <Field label="Result type">
            <Select value={type} onValueChange={(v) => setType(v as ColumnType)}>
              <SelectTrigger size="sm" data-testid="formula-column-type"><SelectValue /></SelectTrigger>
              <SelectContent>{FORMULA_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <Field label="Formula" hint={<>Uses the columns of the same row, for example <code>Qty * Price</code> or <code>If(Status = "Done", 0, Budget - Spent)</code>. Calculated when the row is saved and stored; read-only everywhere.</>}>
        <FormulaBox tableId={table.id} role="formulaColumn" value={formula} onChange={setFormula} rows={2} testId="formula-column-formula" />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={reset}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} disabled={busy || !formula.trim() || (!editing && !name.trim())} data-testid="formula-column-save">Save</Button>
      </div>
    </Panel>
  )
  return (
    <div className="grid max-w-4xl gap-3" data-testid="formula-columns">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">Columns the {caps.server ? 'server' : 'app'} calculates from other columns of the row whenever one of them changes. Changing a formula recalculates every row.</p>
        <Button size="sm" onClick={() => { reset(); setAdding(true) }} data-testid="add-formula-column"><Plus /> Add formula column</Button>
      </div>
      {adding && editor}
      {!cols.length && !adding && <Empty icon={FlaskConical} title="No formula columns" description="For example a line total: Qty * Price." />}
      {cols.map((c) => editing === c.name ? <div key={c.name}>{editor}</div> : (
        <Panel key={c.name} className="flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{c.displayName} <span className="font-mono text-xs text-muted-foreground">{c.name}</span> <Badge variant="outline">{FORMULA_TYPES.find((t) => t.value === c.type)?.label ?? c.type}</Badge></div>
            <code className="mt-1 block truncate text-xs text-muted-foreground">{(c.computed as { formula: string }).formula}</code>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Edit" onClick={() => { setAdding(false); setEditing(c.name); setFormula((c.computed as { formula: string }).formula) }}><Pencil /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Delete" onClick={() => { platform.tables.removeColumn(table.id, c.name).then(() => toast(`Deleted "${c.displayName}"`, 'success')).catch(fail) }}><Trash2 /></Button>
        </Panel>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ rollups */

const FNS: { value: RollupFn; label: string }[] = [{ value: 'count', label: 'Count of rows' }, { value: 'sum', label: 'Sum of' }, { value: 'min', label: 'Smallest' }, { value: 'max', label: 'Largest' }]
const NUMERIC: ColumnType[] = ['number', 'decimal', 'currency']

export function RollupsPanel({ table }: { table: TableDef }) {
  const caps = useCaps()
  const tables = usePlatform((s) => s.tables)
  const { fail, toast } = useToast()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [child, setChild] = useState('')
  const [via, setVia] = useState('')
  const [fn, setFn] = useState<RollupFn>('count')
  const [column, setColumn] = useState('')
  const sources = useMemo(() => tables.filter((t) => t.columns.some((c) => c.type === 'lookup' && (c.lookupTable === table.name || c.lookupTable === table.id))), [tables, table.name, table.id])
  if (!caps.server) return <ServerOnly what="Rollup columns" />
  const childDef = sources.find((t) => t.name === child)
  const links = childDef?.columns.filter((c) => c.type === 'lookup' && (c.lookupTable === table.name || c.lookupTable === table.id)) ?? []
  const values = childDef?.columns.filter((c) => !c.system && (fn === 'sum' ? NUMERIC.includes(c.type) : [...NUMERIC, 'date', 'datetime'].includes(c.type))) ?? []
  const src: ColumnDef | undefined = values.find((c) => c.name === column)
  const resultType: ColumnType = fn === 'count' ? 'number' : src ? (NUMERIC.includes(src.type) ? (src.type === 'number' && fn === 'sum' ? 'decimal' : src.type) : src.type) : 'decimal'
  const rollups = table.columns.filter((c) => c.computed?.kind === 'rollup')
  const save = async () => {
    try {
      await platform.tables.addColumn(table.id, { displayName: name.trim(), type: resultType, computed: { kind: 'rollup', table: child, via: via || links[0]?.name || '', fn, ...(fn !== 'count' ? { column } : {}) } })
      toast('Rollup saved; values are filled in the background', 'success')
      setAdding(false)
      setName('')
    } catch (e) { fail(e) }
  }
  return (
    <div className="grid max-w-4xl gap-3" data-testid="rollups">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">A rollup counts or totals the related rows of another table (rows whose lookup points at this row). It is updated shortly after those rows change, and checked every hour.</p>
        <Button size="sm" onClick={() => setAdding(true)} disabled={!sources.length} data-testid="add-rollup"><Plus /> Add rollup</Button>
      </div>
      {!sources.length && <p className="text-sm text-muted-foreground">No table has a lookup column pointing at {table.displayName} yet; add one there first.</p>}
      {adding && (
        <Panel className="grid gap-4 p-5" data-testid="rollup-editor">
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200" role="note" data-testid="rollup-visibility-warning">
            A rollup is calculated by the system over <b>all</b> related rows, including rows and columns some people may not open. Everyone who can see this column sees the total.
            If the related rows are private (own rows, a row rule, a hidden column), limit who sees this column in the table's column security.
          </p>
          <Field label="Column name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Order total" data-testid="rollup-name" /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Related table">
              <Select value={child} onValueChange={(v) => { setChild(v); setVia(''); setColumn('') }}>
                <SelectTrigger size="sm" data-testid="rollup-table"><SelectValue placeholder="Choose a table" /></SelectTrigger>
                <SelectContent>{sources.map((t) => <SelectItem key={t.id} value={t.name}>{t.displayName}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            {links.length > 1 && (
              <Field label="Through the lookup">
                <Select value={via || links[0].name} onValueChange={setVia}>
                  <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>{links.map((c) => <SelectItem key={c.name} value={c.name}>{c.displayName}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            )}
            <Field label="Calculate">
              <Select value={fn} onValueChange={(v) => setFn(v as RollupFn)}>
                <SelectTrigger size="sm" data-testid="rollup-fn"><SelectValue /></SelectTrigger>
                <SelectContent>{FNS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            {fn !== 'count' && (
              <Field label="Of the column">
                <Select value={column} onValueChange={setColumn}>
                  <SelectTrigger size="sm" data-testid="rollup-column"><SelectValue placeholder="Choose a column" /></SelectTrigger>
                  <SelectContent>{values.map((c) => <SelectItem key={c.name} value={c.name}>{c.displayName}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={() => void save()} disabled={!name.trim() || !child || (fn !== 'count' && !column)} data-testid="rollup-save">Save</Button>
          </div>
        </Panel>
      )}
      {!rollups.length && !adding && sources.length > 0 && <Empty icon={FlaskConical} title="No rollups" description="For example the total of an order's lines." />}
      {rollups.map((c) => {
        const r = c.computed as Extract<NonNullable<ColumnDef['computed']>, { kind: 'rollup' }>
        return (
          <Panel key={c.name} className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">{c.displayName} <span className="font-mono text-xs text-muted-foreground">{c.name}</span></div>
              <div className="text-xs text-muted-foreground">{FNS.find((f) => f.value === r.fn)?.label}{r.column ? ` ${r.column}` : ''} in {tables.find((t) => t.name === r.table)?.displayName ?? r.table} (through {r.via})</div>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Delete" onClick={() => { platform.tables.removeColumn(table.id, c.name).then(() => toast(`Deleted "${c.displayName}"`, 'success')).catch(fail) }}><Trash2 /></Button>
          </Panel>
        )
      })}
    </div>
  )
}
