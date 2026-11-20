/**
 * Scheduled reports (P1 package D; User mode #u-reports and Dev mode #reports): a saved query built with a simple
 * builder (columns, filters, sort, group and totals) or a formula that returns a table, a schedule and recipients. Each
 * recipient gets the data their own access allows, unless an administrator chose a service account (warned).
 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, History, Pause, Play, Plus, Send, Trash2, TriangleAlert } from 'lucide-react'
import { usePlatform } from '@/platform'
import type { ColumnDef, TableDef } from '@/platform/contracts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { ConfirmDialog, Empty, Field, PageHeader, Panel, Segmented, fmtRelative, useToast } from './kit'
import { useCaps } from './security'
import { printApi } from '@/print/api'
import { reportsApi, type ReportDef, type ReportInfo, type ReportRun, type ReportSchedule } from './actionsApi'

const sel = 'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30'
const OPS = [
  { v: 'eq', l: 'is' }, { v: 'ne', l: 'is not' }, { v: 'gt', l: '>' }, { v: 'ge', l: '>=' }, { v: 'lt', l: '<' }, { v: 'le', l: '<=' },
  { v: 'contains', l: 'contains' }, { v: 'startsWith', l: 'starts with' }, { v: 'isNull', l: 'is blank' },
]
const NUMERIC = new Set(['number', 'decimal', 'currency', 'autonumber'])
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface Builder {
  columns: string[]
  filters: { col: string; op: string; value: string }[]
  sort: { col: string; dir: 'asc' | 'desc' } | null
  groupBy: string
  measures: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; col: string }[]
}

/** builder state -> Query v2 plan (literals typed by the column) */
export function buildPlan(t: TableDef, b: Builder): Record<string, unknown> {
  const col = (n: string): ColumnDef | undefined => t.columns.find((c) => c.name === n)
  const lit = (c: ColumnDef | undefined, v: string): unknown => {
    if (!c) return v
    if (NUMERIC.has(c.type)) return Number(v)
    if (c.type === 'boolean') return v === 'true' || v === 'yes'
    if (c.type === 'date') return { $date: v.slice(0, 10) }
    if (c.type === 'datetime') return { $datetime: new Date(v).toISOString() }
    return v
  }
  const conds = b.filters.filter((f) => f.col).map((f) => (f.op === 'isNull' ? { col: f.col, op: 'isNull' } : { col: f.col, op: f.op, value: lit(col(f.col), f.value) }))
  const plan: Record<string, unknown> = { version: 2, table: t.name }
  if (conds.length) plan.filter = conds.length === 1 ? conds[0] : { and: conds }
  if (b.groupBy || b.measures.length) {
    const measures = b.measures.map((m) => ({ name: m.fn === 'count' ? 'Count' : `${m.fn === 'avg' ? 'Average' : m.fn[0].toUpperCase() + m.fn.slice(1)} ${col(m.col)?.displayName ?? m.col}`.slice(0, 64), fn: m.fn, ...(m.fn !== 'count' ? { col: m.col } : {}) }))
    plan.aggregate = { groupBy: b.groupBy ? [b.groupBy] : [], measures: measures.length ? measures : [{ name: 'Count', fn: 'count' }], ...(b.sort ? { sort: [{ col: b.sort.col === b.groupBy || measures.some((m) => m.name === b.sort!.col) ? b.sort.col : b.groupBy || measures[0]?.name, dir: b.sort.dir }] } : {}) }
  } else {
    if (b.sort) plan.sort = [{ col: b.sort.col, dir: b.sort.dir }]
    if (b.columns.length) plan.select = b.columns
  }
  return plan
}

const blankBuilder = (): Builder => ({ columns: [], filters: [], sort: null, groupBy: '', measures: [] })
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }

function ReportDialog({ report, onClose, onSaved }: { report: ReportInfo | 'new' | null; onClose(): void; onSaved(): void }) {
  const caps = useCaps()
  const tables = usePlatform((s) => s.tables)
  const users = usePlatform((s) => s.users)
  const teams = usePlatform((s) => s.teams)
  const me = usePlatform((s) => s.currentUserId)
  const { fail, toast } = useToast()
  const existing = report && report !== 'new' ? report : null
  const d = existing?.def
  const [name, setName] = useState(d?.name ?? '')
  const [description, setDescription] = useState(d?.description ?? '')
  const [kind, setKind] = useState<'table' | 'formula'>(d?.source.kind ?? 'table')
  const [tableId, setTableId] = useState(d?.source.kind === 'table' ? d.source.tableId : '')
  const [builder, setBuilder] = useState<Builder>(() => (d?.source.kind === 'table' && d.source.builder ? (d.source.builder as Builder) : blankBuilder()))
  const [formula, setFormula] = useState(d?.source.kind === 'formula' ? d.source.formula : '')
  const [schedule, setSchedule] = useState<ReportSchedule>(d?.schedule ?? { frequency: 'daily', time: '08:00', timeZone: browserZone() })
  const [userIds, setUserIds] = useState<string[]>(d?.recipients.userIds ?? (me ? [me] : []))
  const [teamIds, setTeamIds] = useState<string[]>(d?.recipients.teamIds ?? [])
  const [inlineRows, setInlineRows] = useState(String(d?.inlineRows ?? 20))
  const [onEmpty, setOnEmpty] = useState<'skip' | 'send'>(d?.onEmpty ?? 'skip')
  // P2-B: attach a PDF (automatic layout or a print template with a query, formula or no source)
  const [pdf, setPdf] = useState<string>(d?.pdf ? (d.pdf.mode === 'auto' ? 'auto' : d.pdf.template) : '')
  const [pdfTemplates, setPdfTemplates] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { printApi.list().then((r) => setPdfTemplates(r.items.filter((t) => t.status === 'published' && t.kind === 'pdf').map((t) => ({ id: t.id, name: t.name })))).catch(() => {}) }, [])
  const [serviceAccount, setServiceAccount] = useState(d && typeof d.runAs === 'object' ? d.runAs.serviceAccount : '')
  const [preview, setPreview] = useState<{ columns: { name: string; label: string }[]; rows: Record<string, unknown>[]; total: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const table = tables.find((t) => t.id === tableId)
  const cols = (table?.columns ?? []).filter((c) => !['image', 'file'].includes(c.type))
  const canPick = caps.isAdmin || caps.isMaker
  const services = users.filter((u) => (u as { kind?: string }).kind === 'service')

  const def = (): Partial<ReportDef> => ({
    name: name.trim(), description: description.trim() || undefined,
    source: kind === 'table' ? { kind: 'table', tableId, plan: table ? buildPlan(table, builder) : {}, builder } : { kind: 'formula', formula },
    schedule, recipients: { userIds, teamIds }, inlineRows: Number(inlineRows) || 0, csvRows: 5000, onEmpty, pdf: pdf === 'auto' ? { mode: 'auto' } : pdf ? { mode: 'template', template: pdf } : null,
    runAs: serviceAccount ? { serviceAccount } : 'recipient',
  })
  const doPreview = async () => {
    setBusy(true)
    try {
      setPreview(await reportsApi.preview(def()))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    setBusy(true)
    try {
      if (existing) await reportsApi.update(existing.id, def())
      else await reportsApi.create(def())
      toast(existing ? 'Report saved' : 'Report created', 'success')
      onSaved()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const setB = (p: Partial<Builder>) => { setBuilder((b) => ({ ...b, ...p })); setPreview(null) }

  return (
    <Dialog open={!!report} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto overflow-x-hidden sm:max-w-3xl" data-testid="report-dialog">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit "${existing.name}"` : 'New scheduled report'}</DialogTitle>
          <DialogDescription>An email with a table (the first rows) and a CSV file of all of it, on a schedule. Each person gets what their own access allows.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Open orders every morning" data-testid="report-name" /></Field>
            <Field label="Description (in the email)"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          </div>
          <Segmented label="Source" value={kind} onChange={(v) => { setKind(v); setPreview(null) }} options={[{ value: 'table', label: 'Table (builder)' }, { value: 'formula', label: 'Formula' }]} />
          {kind === 'table' ? (
            <div className="grid gap-3 rounded-lg border border-border p-3" data-testid="report-builder">
              <Field label="Table">
                <select className={sel} value={tableId} onChange={(e) => { setTableId(e.target.value); setBuilder(blankBuilder()); setPreview(null) }} data-testid="report-table">
                  <option value="">Choose a table...</option>
                  {tables.map((t) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
                </select>
              </Field>
              {table && (
                <>
                  <div className="grid gap-1">
                    <div className="text-xs font-medium">Columns <span className="font-normal text-muted-foreground">(none ticked: every column you may see)</span></div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {cols.map((c) => (
                        <label key={c.name} className="flex items-center gap-1 text-xs">
                          <input type="checkbox" checked={builder.columns.includes(c.name)} onChange={(e) => setB({ columns: e.target.checked ? [...builder.columns, c.name] : builder.columns.filter((x) => x !== c.name) })} data-testid={`report-col-${c.name}`} />
                          {c.displayName}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <div className="text-xs font-medium">Filters (all must match)</div>
                    {builder.filters.map((f, i) => (
                      <div key={i} className="flex items-center gap-2" data-testid={`report-filter-${i}`}>
                        <select className={sel} value={f.col} onChange={(e) => setB({ filters: builder.filters.map((x, j) => (j === i ? { ...x, col: e.target.value } : x)) })} aria-label="Column">{cols.map((c) => <option key={c.name} value={c.name}>{c.displayName}</option>)}</select>
                        <select className={sel} value={f.op} onChange={(e) => setB({ filters: builder.filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })} aria-label="Operator">{OPS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                        {f.op !== 'isNull' && <Input className="h-8" value={f.value} onChange={(e) => setB({ filters: builder.filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} aria-label="Value" />}
                        <Button variant="ghost" size="icon-sm" aria-label="Remove filter" onClick={() => setB({ filters: builder.filters.filter((_, j) => j !== i) })}><Trash2 /></Button>
                      </div>
                    ))}
                    <div><Button size="xs" variant="outline" onClick={() => setB({ filters: [...builder.filters, { col: cols[0]?.name ?? '', op: 'eq', value: '' }] })} data-testid="report-add-filter"><Plus /> Filter</Button></div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Group by (totals)">
                      <select className={sel} value={builder.groupBy} onChange={(e) => setB({ groupBy: e.target.value, measures: e.target.value && !builder.measures.length ? [{ fn: 'count', col: '' }] : builder.measures })} data-testid="report-group">
                        <option value="">No grouping (rows)</option>
                        {cols.map((c) => <option key={c.name} value={c.name}>{c.displayName}</option>)}
                      </select>
                    </Field>
                    <Field label="Sort">
                      <div className="flex gap-2">
                        <select className={sel} value={builder.sort?.col ?? ''} onChange={(e) => setB({ sort: e.target.value ? { col: e.target.value, dir: builder.sort?.dir ?? 'asc' } : null })} data-testid="report-sort">
                          <option value="">Natural order</option>
                          {cols.map((c) => <option key={c.name} value={c.name}>{c.displayName}</option>)}
                        </select>
                        {builder.sort && <select className={sel} value={builder.sort.dir} onChange={(e) => setB({ sort: { col: builder.sort!.col, dir: e.target.value as 'asc' | 'desc' } })} aria-label="Direction"><option value="asc">ascending</option><option value="desc">descending</option></select>}
                      </div>
                    </Field>
                  </div>
                  <div className="grid gap-1.5">
                    <div className="text-xs font-medium">Totals</div>
                    {builder.measures.map((m, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <select className={sel} value={m.fn} onChange={(e) => setB({ measures: builder.measures.map((x, j) => (j === i ? { ...x, fn: e.target.value as Builder['measures'][number]['fn'] } : x)) })} aria-label="Total">{['count', 'sum', 'avg', 'min', 'max'].map((f) => <option key={f}>{f}</option>)}</select>
                        {m.fn !== 'count' && <select className={sel} value={m.col} onChange={(e) => setB({ measures: builder.measures.map((x, j) => (j === i ? { ...x, col: e.target.value } : x)) })} aria-label="Of column"><option value="">Choose...</option>{cols.filter((c) => NUMERIC.has(c.type)).map((c) => <option key={c.name} value={c.name}>{c.displayName}</option>)}</select>}
                        <Button variant="ghost" size="icon-sm" aria-label="Remove total" onClick={() => setB({ measures: builder.measures.filter((_, j) => j !== i) })}><Trash2 /></Button>
                      </div>
                    ))}
                    <div><Button size="xs" variant="outline" onClick={() => setB({ measures: [...builder.measures, { fn: 'sum', col: cols.find((c) => NUMERIC.has(c.type))?.name ?? '' }] })} data-testid="report-add-total"><Plus /> Total</Button></div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Field label="Formula returning a table" hint='Reads must be delegable, e.g. Filter(Orders, Status = "Open" && Amount > 1000)'>
              <textarea className="h-20 w-full rounded-md border border-input bg-background p-2 font-mono text-xs" value={formula} onChange={(e) => { setFormula(e.target.value); setPreview(null) }} data-testid="report-formula" />
            </Field>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy || (kind === 'table' ? !table : !formula.trim())} onClick={() => void doPreview()} data-testid="report-preview">{busy ? <Spinner /> : <Play />} Preview as me</Button>
            {preview && <span className="text-xs text-muted-foreground">{preview.total} row{preview.total === 1 ? '' : 's'}</span>}
          </div>
          {preview && (
            <div className="max-h-56 overflow-auto rounded-md border border-border" data-testid="report-preview-table">
              <table className="w-full text-xs">
                <thead><tr className="bg-muted/50">{preview.columns.map((c) => <th key={c.name} className="px-2 py-1 text-left">{c.label}</th>)}</tr></thead>
                <tbody>{preview.rows.slice(0, 20).map((r, i) => <tr key={i} className="border-t border-border/60">{preview.columns.map((c) => <td key={c.name} className="px-2 py-1">{r[c.name] === null || r[c.name] === undefined ? '' : String(r[c.name])}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
          <div className="grid grid-cols-[150px_1fr] items-end gap-3" data-testid="report-schedule">
            <Field label="When">
              <select className={sel} value={schedule.frequency} onChange={(e) => setSchedule({ ...schedule, frequency: e.target.value as ReportSchedule['frequency'] })} data-testid="report-frequency">
                {['daily', 'weekdays', 'weekly', 'monthly', 'hourly', 'manual'].map((f) => <option key={f} value={f}>{f === 'manual' ? 'only by hand' : f}</option>)}
              </select>
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              {schedule.frequency === 'weekly' && <select className={sel} value={schedule.weekday ?? 1} onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })} aria-label="Weekday">{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</select>}
              {schedule.frequency === 'monthly' && <Input className="h-8 w-20" inputMode="numeric" value={String(schedule.day ?? 1)} onChange={(e) => setSchedule({ ...schedule, day: Number(e.target.value) || 1 })} aria-label="Day of month" />}
              {schedule.frequency === 'hourly' && <Input className="h-8 w-20" inputMode="numeric" value={String(schedule.minute ?? 0)} onChange={(e) => setSchedule({ ...schedule, minute: Number(e.target.value) || 0 })} aria-label="Minute" />}
              {['daily', 'weekdays', 'weekly', 'monthly'].includes(schedule.frequency) && <Input type="time" className="h-8 w-28" value={schedule.time ?? '08:00'} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} aria-label="Time" data-testid="report-time" />}
              {schedule.frequency !== 'manual' && <Input className="h-8 w-48" value={schedule.timeZone ?? 'UTC'} onChange={(e) => setSchedule({ ...schedule, timeZone: e.target.value })} aria-label="Time zone" />}
            </div>
          </div>
          <div className="grid gap-1.5" data-testid="report-recipients">
            <div className="text-xs font-medium">Recipients</div>
            {canPick ? (
              <>
                <div className="flex flex-wrap gap-1">{userIds.map((u) => <Badge key={u} variant="secondary" className="gap-1">{users.find((x) => x.id === u)?.name ?? u}<button type="button" aria-label="Remove" onClick={() => setUserIds(userIds.filter((x) => x !== u))}>x</button></Badge>)}{teamIds.map((t) => <Badge key={t} variant="outline" className="gap-1">Team {teams.find((x) => x.id === t)?.name ?? t}<button type="button" aria-label="Remove" onClick={() => setTeamIds(teamIds.filter((x) => x !== t))}>x</button></Badge>)}</div>
                <select className={sel} value="" onChange={(e) => { const v = e.target.value; if (v.startsWith('team:')) setTeamIds([...new Set([...teamIds, v.slice(5)])]); else if (v) setUserIds([...new Set([...userIds, v])]) }} data-testid="report-add-recipient">
                  <option value="">Add a person or team...</option>
                  {users.filter((u) => !userIds.includes(u.id) && (u as { kind?: string }).kind !== 'service').map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                  {teams.map((t) => <option key={t.id} value={`team:${t.id}`}>Team {t.name}</option>)}
                </select>
              </>
            ) : <p className="text-xs text-muted-foreground">You (only makers and administrators send reports to other people).</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Rows in the email body" hint="All rows are in the CSV file (up to 5,000)"><Input inputMode="numeric" value={inlineRows} onChange={(e) => setInlineRows(e.target.value.replace(/[^0-9]/g, ''))} /></Field>
            <Field label="Attach a PDF" hint="A printable table of the rows, or a print template (made with each recipient's access)">
              <select className={sel} value={pdf} onChange={(e) => setPdf(e.target.value)} data-testid="report-pdf">
                <option value="">No PDF</option><option value="auto">The rows as a printable table</option>
                {pdfTemplates.map((t) => <option key={t.id} value={t.id}>Print template: {t.name}</option>)}
              </select>
            </Field>
            <Field label="When there are no rows"><Segmented label="Empty result" value={onEmpty} onChange={setOnEmpty} options={[{ value: 'skip', label: 'Send nothing' }, { value: 'send', label: 'Send anyway' }]} /></Field>
          </div>
          {caps.isAdmin && (
            <Field label="Run as" hint="Default: each recipient's own access. A service account gives everybody the same data.">
              <select className={sel} value={serviceAccount} onChange={(e) => setServiceAccount(e.target.value)} data-testid="report-run-as">
                <option value="">Each recipient (recommended)</option>
                {services.map((u) => <option key={u.id} value={u.id}>Service account: {u.name}</option>)}
              </select>
            </Field>
          )}
          {serviceAccount && <p className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs"><TriangleAlert className="size-4 shrink-0" />Everyone on the list gets the service account's data, including rows and columns they could not open themselves. This choice is audited.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !name.trim() || (kind === 'table' ? !table : !formula.trim())} data-testid="report-save">{busy && <Spinner />} {existing ? 'Save' : 'Create report'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RunsDialog({ report, onClose }: { report: ReportInfo | null; onClose(): void }) {
  const users = usePlatform((s) => s.users)
  const [runs, setRuns] = useState<ReportRun[] | null>(null)
  useEffect(() => { if (report) reportsApi.runs(report.id).then((r) => setRuns(r.items)).catch(() => setRuns([])) }, [report])
  return (
    <Dialog open={!!report} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl" data-testid="report-runs">
        <DialogHeader><DialogTitle>History of "{report?.name}"</DialogTitle><DialogDescription>Each run, and what happened for each recipient.</DialogDescription></DialogHeader>
        {!runs ? <Spinner /> : !runs.length ? <p className="text-sm text-muted-foreground">No runs yet.</p> : (
          <ul className="grid gap-2">
            {runs.map((r) => (
              <li key={r.id} className="rounded-md border border-border p-2 text-xs">
                <div className="flex items-center gap-2"><Badge variant={r.status === 'succeeded' ? 'secondary' : 'destructive'}>{r.status}</Badge><span>{fmtRelative(r.startedOn)}</span><span className="text-muted-foreground">{r.trigger} · {r.message}</span></div>
                <ul className="mt-1 grid gap-0.5 pl-2">{r.recipients.map((x) => <li key={x.userId}>{users.find((u) => u.id === x.userId)?.name ?? x.userId}: {x.status}{x.rows !== undefined ? ` (${x.rows} rows)` : ''}{x.reason ? `: ${x.reason}` : ''}</li>)}</ul>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ReportsPage() {
  const mode = usePlatform((s) => s.mode)
  const { fail, toast } = useToast()
  const [items, setItems] = useState<ReportInfo[] | null>(null)
  const [edit, setEdit] = useState<ReportInfo | 'new' | null>(null)
  const [runs, setRuns] = useState<ReportInfo | null>(null)
  const [del, setDel] = useState<ReportInfo | null>(null)
  const load = () => { reportsApi.list().then((r) => setItems(r.items)).catch((e) => { setItems([]); fail(e) }) }
  useEffect(() => { if (mode === 'server') load() }, [mode])
  const sorted = useMemo(() => items ?? [], [items])
  if (mode !== 'server') return <Empty icon={CalendarClock} title="Scheduled reports need the server" description="Reports are emailed by the server's job queue; start Appbuilder with npm start." />
  return (
    <div className="p-4" data-testid="reports-page">
      <PageHeader icon={CalendarClock} title="Scheduled reports" subtitle="A table or a total, emailed on a schedule with a CSV file. Everyone gets what their own access allows." actions={<Button size="sm" onClick={() => setEdit('new')} data-testid="new-report"><Plus /> New report</Button>} />
      {!items ? <Spinner /> : !sorted.length ? <Empty icon={CalendarClock} title="No reports yet" description="Create one: choose a table, columns and filters, a time, and who gets it." /> : (
        <Panel className="overflow-hidden">
          <table className="w-full text-sm" data-testid="report-list">
            <thead><tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground"><th className="px-3 py-2">Report</th><th className="px-3 py-2">When</th><th className="px-3 py-2">Last run</th><th /></tr></thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0" data-testid={`report-${r.id}`}>
                  <td className="px-3 py-2"><div className="font-medium">{r.name}{!r.enabled && <Badge variant="outline" className="ml-2">paused</Badge>}{typeof r.def.runAs === 'object' && <Badge variant="destructive" className="ml-2">service account</Badge>}</div><div className="text-xs text-muted-foreground">{r.ownerName ? `by ${r.ownerName} · ` : ''}{r.def.recipients.userIds.length} people{r.def.recipients.teamIds.length ? `, ${r.def.recipients.teamIds.length} teams` : ''}</div></td>
                  <td className="px-3 py-2 text-xs">{r.scheduleText}{r.nextRunAt ? <div className="text-muted-foreground">next {fmtRelative(r.nextRunAt)}</div> : null}</td>
                  <td className="px-3 py-2 text-xs">{r.lastRun ? <span className={cn(r.lastRun.status === 'succeeded' ? '' : 'text-destructive')}>{r.lastRun.status} {fmtRelative(r.lastRun.startedOn)}</span> : 'never'}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="outline" onClick={() => reportsApi.run(r.id).then(() => { toast(r.canEdit ? 'The report is being sent' : 'Your copy is being sent', 'success'); setTimeout(load, 1500) }).catch(fail)} data-testid={`run-report-${r.id}`}><Send /> {r.canEdit ? 'Send now' : 'Send me a copy'}</Button>
                      <Button size="xs" variant="ghost" onClick={() => setRuns(r)}><History /> History</Button>
                      {r.canEdit && <Button size="xs" variant="ghost" onClick={() => reportsApi.update(r.id, { enabled: !r.enabled }).then(load).catch(fail)} aria-label={r.enabled ? 'Pause' : 'Resume'}>{r.enabled ? <Pause /> : <Play />}</Button>}
                      {r.canEdit && <Button size="xs" variant="ghost" onClick={() => setEdit(r)} data-testid={`edit-report-${r.id}`}>Edit</Button>}
                      {r.canEdit && <Button size="icon-sm" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => setDel(r)}><Trash2 /></Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      {edit && <ReportDialog report={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load() }} />}
      <RunsDialog report={runs} onClose={() => setRuns(null)} />
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete report "${del?.name ?? ''}"?`} description="Its schedule and history are removed." onConfirm={async () => { if (del) { await reportsApi.remove(del.id); load() } }} />
    </div>
  )
}
