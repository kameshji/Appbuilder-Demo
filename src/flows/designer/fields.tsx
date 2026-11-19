/**
 * Building blocks of the step panels: table and column pickers, the record field mapping grid (Add / Update a row), the
 * visual filter and condition builders, a people/team picker, key-value lists, a duration picker and inputs generated
 * from a JSON Schema (connector actions) with a raw JSON view.
 */
import { useMemo, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { TableDef, ColumnDef } from '@/platform/contracts'
import { parse } from '@/fx/parser'
import { FxField, FormulaInput, DynamicContent, FieldError } from './FxField'
import { compileCondition, compileFilter, OPS, parseCondition, parseFilter, type FilterGroup, type FilterRule } from './filter'
import { columnType, member } from './dynamic'
import { textOf, type LiteralKind } from './literal'
import { useDesignerData } from './context'
import { useDesigner } from './store'

export const inputCls = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60'
export const labelCls = 'text-xs font-medium'

export function Section({ title, children, hint, testId }: { title: string; children: React.ReactNode; hint?: React.ReactNode; testId?: string }) {
  return (
    <section className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0" data-testid={testId}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {hint && <p className="-mt-1 text-[11px] text-muted-foreground">{hint}</p>}
      {children}
    </section>
  )
}

export function Labeled({ label, children, hint, htmlFor, required }: { label: string; children: React.ReactNode; hint?: React.ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <div className="grid gap-1">
      <label className={labelCls} htmlFor={htmlFor}>{label}{required && <span className="text-destructive"> *</span>}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function TablePicker({ value, onChange, testId, id, disabled }: { value: string; onChange(v: string): void; testId?: string; id?: string; disabled?: boolean }) {
  const { tables } = useDesignerData()
  const sorted = useMemo(() => [...tables].sort((a, b) => a.displayName.localeCompare(b.displayName)), [tables])
  const known = sorted.some((t) => t.name === value)
  return (
    <select id={id} className={inputCls} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} data-testid={testId ?? 'table-picker'}>
      <option value="">Choose a table</option>
      {!known && value && <option value={value}>{value} (not found)</option>}
      {sorted.filter((t) => !t.system).map((t) => <option key={t.id} value={t.name}>{t.displayName}</option>)}
      <optgroup label="System tables">{sorted.filter((t) => t.system).map((t) => <option key={t.id} value={t.name}>{t.displayName}</option>)}</optgroup>
    </select>
  )
}

/** the literal field kind of a column */
export function kindOfColumn(c: ColumnDef | undefined): { kind: LiteralKind; choices?: string[]; lookupTable?: string } {
  if (!c) return { kind: 'text' }
  if (c.type === 'choice') return { kind: 'choice', choices: c.choices }
  if (c.type === 'lookup') return { kind: 'lookup', lookupTable: c.lookupTable }
  const t = columnType(c.type)
  return { kind: t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : t === 'date' && c.type === 'date' ? 'date' : 'text' }
}

export const writableColumns = (t: TableDef | undefined): ColumnDef[] => (t?.columns ?? []).filter((c) => !c.system && !c.computed && c.type !== 'autonumber')

/** record field mapping (column -> value) with "add field" and the required columns pre-added */
export function MappingGrid({ stepId, table, values, onChange, requiredFirst }: { stepId: string; table: TableDef | undefined; values: Record<string, string>; onChange(v: Record<string, string>): void; requiredFirst: boolean }) {
  const ro = useDesigner((s) => s.readOnly)
  const cols = writableColumns(table)
  const [adding, setAdding] = useState('')
  if (!table) return <p className="text-xs text-muted-foreground">Choose a table first.</p>
  const shown = Object.keys(values)
  const missingRequired = requiredFirst ? cols.filter((c) => c.required && !(c.name in values)) : []
  const free = cols.filter((c) => !(c.name in values))
  return (
    <div className="grid gap-2" data-testid="mapping-grid">
      {missingRequired.length > 0 && <p className="text-[11px] text-amber-700 dark:text-amber-400">Required: {missingRequired.map((c) => c.displayName).join(', ')}</p>}
      {shown.map((name) => {
        const c = cols.find((x) => x.name === name) ?? table.columns.find((x) => x.name === name)
        const k = kindOfColumn(c)
        return (
          <div key={name} className="relative rounded-md border border-border p-2 pr-7" data-testid={`map-${name}`}>
            <FxField stepId={stepId} field={`values.${name}`} label={`${c?.displayName ?? name}${c ? ` · ${c.type}` : ' (no such column)'}`} required={c?.required} value={values[name]} onChange={(v) => onChange({ ...values, [name]: v })} kind={k.kind} choices={k.choices} lookupTable={k.lookupTable} testId={`map-value-${name}`} />
            {!ro && <button type="button" className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label={`Remove ${name}`} onClick={() => { const n = { ...values }; delete n[name]; onChange(n) }}><X className="size-3.5" /></button>}
          </div>
        )
      })}
      {!ro && free.length > 0 && (
        <div className="flex items-center gap-2">
          <select className={cn(inputCls, 'flex-1')} value={adding} onChange={(e) => setAdding(e.target.value)} data-testid="add-field-select" aria-label="Column to add">
            <option value="">Add a field…</option>
            {free.map((c) => <option key={c.name} value={c.name}>{c.displayName}{c.required ? ' *' : ''}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={!adding} data-testid="add-field" onClick={() => { onChange({ ...values, [adding]: '' }); setAdding('') }}><Plus className="size-4" />Add</Button>
          {missingRequired.length > 0 && <Button size="sm" variant="ghost" onClick={() => onChange({ ...values, ...Object.fromEntries(missingRequired.map((c) => [c.name, ''])) })}>Add required</Button>}
        </div>
      )}
    </div>
  )
}

/** rules editor shared by the filter and the condition builder */
function RulesEditor({ stepId, g, onChange, left, depth = 0, testId }: { stepId: string; g: FilterGroup; onChange(g: FilterGroup): void; left: (r: FilterRule, set: (r: FilterRule) => void) => React.ReactNode; depth?: number; testId?: string }) {
  const ro = useDesigner((s) => s.readOnly)
  const setRule = (i: number, r: FilterRule | FilterGroup) => onChange({ ...g, rules: g.rules.map((x, j) => (j === i ? r : x)) })
  return (
    <div className={cn('grid gap-1.5', depth && 'rounded-md border border-dashed border-border p-2')} data-testid={testId}>
      {g.rules.length > 1 && (
        <div className="flex items-center gap-1 text-[11px]">
          <span className="text-muted-foreground">Match</span>
          <select className="h-6 rounded border border-border bg-background px-1 text-[11px]" value={g.join} disabled={ro} onChange={(e) => onChange({ ...g, join: e.target.value as 'and' | 'or' })} data-testid="join-select">
            <option value="and">all of these</option><option value="or">any of these</option>
          </select>
        </div>
      )}
      {g.rules.map((r, i) => 'rules' in r ? (
        <div key={i} className="relative">
          <RulesEditor stepId={stepId} g={r} onChange={(x) => setRule(i, x)} left={left} depth={depth + 1} />
          {!ro && <button type="button" className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label="Remove group" onClick={() => onChange({ ...g, rules: g.rules.filter((_, j) => j !== i) })}><X className="size-3.5" /></button>}
        </div>
      ) : (
        <div key={i} className="grid grid-cols-[1fr_auto] items-start gap-1 rounded-md bg-muted/40 p-1.5" data-testid="rule">
          <div className="grid gap-1">
            {left(r, (x) => setRule(i, x))}
            <select className="h-7 rounded border border-border bg-background px-1 text-xs" value={r.op} disabled={ro} onChange={(e) => setRule(i, { ...r, op: e.target.value as FilterRule['op'] })} data-testid="rule-op" aria-label="Comparison">
              {OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
            {!OPS.find((o) => o.op === r.op)?.noValue && <FormulaInput stepId={stepId} value={r.value} onChange={(v) => setRule(i, { ...r, value: v })} placeholder='A value: "Open", 100, Trigger.Record.Amount' testId="rule-value" readOnly={ro} />}
          </div>
          {!ro && <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Remove rule" onClick={() => onChange({ ...g, rules: g.rules.filter((_, j) => j !== i) })}><Trash2 className="size-3.5" /></button>}
        </div>
      ))}
      {!ro && (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" className="h-7 text-xs" data-testid="add-rule" onClick={() => onChange({ ...g, rules: [...g.rules, { column: '', op: 'eq', value: '' }] })}><Plus className="size-3.5" />Rule</Button>
          {depth === 0 && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onChange({ ...g, rules: [...g.rules, { join: g.join === 'and' ? 'or' : 'and', rules: [{ column: '', op: 'eq', value: '' }] }] })}><Plus className="size-3.5" />Group</Button>}
        </div>
      )}
    </div>
  )
}

/** the filter of List rows: rules on the table's columns; "Advanced" edits the formula */
export function FilterBuilder({ stepId, field, table, value, onChange }: { stepId: string; field: string; table: TableDef | undefined; value: string | undefined; onChange(v: string): void }) {
  const columns = useMemo(() => ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner', ...(table?.columns ?? []).map((c) => c.name)], [table])
  const parsed = useMemo(() => parseFilter(value, columns), [value, columns])
  const [advanced, setAdvanced] = useState(parsed === null)
  const [g, setG] = useState<FilterGroup>(parsed ?? { join: 'and', rules: [] })
  const ro = useDesigner((s) => s.readOnly)
  const update = (x: FilterGroup) => { setG(x); onChange(compileFilter(x)) }
  return (
    <div className="grid gap-1.5" data-testid="filter-builder">
      <div className="flex items-center gap-2">
        <span className={labelCls}>Filter rows</span>
        <span className="ml-auto inline-flex rounded border border-border p-0.5 text-[10px]">
          <button type="button" className={cn('rounded px-1.5', !advanced && 'bg-accent font-medium')} disabled={ro} onClick={() => { const p = parseFilter(value, columns); if (p) { setG(p); setAdvanced(false) } else if (confirm('This filter cannot be shown as rules. Start over with rules?')) { setG({ join: 'and', rules: [] }); onChange(''); setAdvanced(false) } }} data-testid="filter-rules">Rules</button>
          <button type="button" className={cn('rounded px-1.5', advanced && 'bg-accent font-medium')} onClick={() => setAdvanced(true)} data-testid="filter-advanced">Advanced</button>
        </span>
      </div>
      {advanced ? (
        <FormulaInput stepId={stepId} value={value ?? ''} onChange={onChange} placeholder='Status = "Open" && Amount > 100' testId="filter-formula" readOnly={ro} />
      ) : (
        <RulesEditor stepId={stepId} g={g} onChange={update} testId="filter-rules-editor" left={(r, set) => (
          <select className="h-7 rounded border border-border bg-background px-1 text-xs" value={r.column} disabled={ro} onChange={(e) => set({ ...r, column: e.target.value })} data-testid="rule-column" aria-label="Column">
            <option value="">Column…</option>
            {columns.map((c) => <option key={c} value={c}>{table?.columns.find((x) => x.name === c)?.displayName ?? c}</option>)}
          </select>
        )} />
      )}
      {!advanced && g.rules.length === 0 && <p className="text-[11px] text-muted-foreground">No rules: every row (up to the row limit).</p>}
      <FieldError stepId={stepId} field={field} />
    </div>
  )
}

/** a condition (condition step, do until, table trigger): rules on any value, or a formula */
export function ConditionBuilder({ stepId, field, value, onChange, label, testId }: { stepId: string; field: string; value: string | undefined; onChange(v: string): void; label: string; testId?: string }) {
  const parsed = useMemo(() => parseCondition(value), [value])
  const [advanced, setAdvanced] = useState(parsed === null)
  const [g, setG] = useState<FilterGroup>(parsed ?? { join: 'and', rules: [] })
  const ro = useDesigner((s) => s.readOnly)
  const update = (x: FilterGroup) => { setG(x); onChange(compileCondition(x)) }
  return (
    <div className="grid gap-1.5" data-testid={testId ?? 'condition-builder'}>
      <div className="flex items-center gap-2">
        <span className={labelCls}>{label}</span>
        <span className="ml-auto inline-flex rounded border border-border p-0.5 text-[10px]">
          <button type="button" className={cn('rounded px-1.5', !advanced && 'bg-accent font-medium')} disabled={ro} data-testid="condition-rules" onClick={() => { const p = parseCondition(value); if (p) { setG(p); setAdvanced(false) } else if (confirm('This condition cannot be shown as rules. Start over with rules?')) { setG({ join: 'and', rules: [] }); onChange(''); setAdvanced(false) } }}>Rules</button>
          <button type="button" className={cn('rounded px-1.5 font-serif italic', advanced && 'bg-accent font-medium')} data-testid="condition-formula" onClick={() => setAdvanced(true)}>fx</button>
        </span>
      </div>
      {advanced ? (
        <FormulaInput stepId={stepId} value={value ?? ''} onChange={onChange} placeholder='Trigger.Record.Amount > 1000' testId={`${testId ?? 'condition'}-fx`} readOnly={ro} />
      ) : (
        <RulesEditor stepId={stepId} g={g} onChange={update} left={(r, set) => (
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1"><FormulaInput stepId={stepId} value={r.column} onChange={(v) => set({ ...r, column: v })} placeholder="A value: pick dynamic content" testId="rule-left" readOnly={ro} /></div>
          </div>
        )} />
      )}
      <FieldError stepId={stepId} field={field} />
    </div>
  )
}

/** people and teams: a list of emails / team:<id> as one text (or any formula) */
export function PeoplePicker({ stepId, field, label, value, onChange, required, testId }: { stepId: string; field: string; label: string; value: string | undefined; onChange(v: string): void; required?: boolean; testId?: string }) {
  const { users, teams } = useDesignerData()
  const ro = useDesigner((s) => s.readOnly)
  const text = textOf(value)
  const plain = text !== null && !text.includes('{')
  const [mode, setMode] = useState<'people' | 'formula'>(plain ? 'people' : 'formula')
  const [q, setQ] = useState('')
  const list = plain ? (text ?? '').split(/[;,]/).map((x) => x.trim()).filter(Boolean) : []
  const set = (l: string[]) => onChange(l.length ? `"${l.join(', ').replace(/"/g, '""')}"` : '')
  const label2 = (x: string) => (x.startsWith('team:') ? `Team ${teams.find((t) => t.id === x.slice(5))?.name ?? x.slice(5)}` : users.find((u) => u.email === x || u.id === x)?.name ?? x)
  const options = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return [
      ...users.filter((u) => u.kind !== 'service' && `${u.name} ${u.email}`.toLowerCase().includes(s)).slice(0, 8).map((u) => ({ v: u.email, l: `${u.name} · ${u.email}` })),
      ...teams.filter((t) => `${t.name} ${t.code}`.toLowerCase().includes(s)).slice(0, 5).map((t) => ({ v: `team:${t.id}`, l: `Team ${t.name}` })),
    ]
  }, [q, users, teams])
  return (
    <div className="grid gap-1" data-testid={testId ?? 'people-picker'}>
      <div className="flex items-center gap-2">
        <span className={labelCls}>{label}{required && <span className="text-destructive"> *</span>}</span>
        {!ro && (
          <span className="ml-auto inline-flex rounded border border-border p-0.5 text-[10px]">
            <button type="button" className={cn('rounded px-1.5', mode === 'people' && 'bg-accent font-medium')} onClick={() => { if (!plain && value && !confirm('This is a formula. Switch to picking people and clear it?')) return; if (!plain) onChange(''); setMode('people') }} data-testid="people-mode">People</button>
            <button type="button" className={cn('rounded px-1.5 font-serif italic', mode === 'formula' && 'bg-accent font-medium')} onClick={() => setMode('formula')} data-testid="people-formula">fx</button>
          </span>
        )}
      </div>
      {mode === 'formula' ? <FormulaInput stepId={stepId} value={value ?? ''} onChange={onChange} placeholder="Trigger.Record.Manager, or a table of people" testId={`${testId ?? 'people'}-fx`} readOnly={ro} /> : (
        <div className="grid gap-1">
          <div className="flex flex-wrap gap-1">
            {list.map((x) => <span key={x} className="flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs">{label2(x)}{!ro && <button type="button" aria-label={`Remove ${x}`} onClick={() => set(list.filter((y) => y !== x))}><X className="size-3" /></button>}</span>)}
          </div>
          {!ro && (
            <div className="relative">
              <input className={inputCls} placeholder="Search people and teams, or type an email and press Enter" value={q} onChange={(e) => setQ(e.target.value)} data-testid={`${testId ?? 'people'}-search`}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && q.includes('@')) { e.preventDefault(); set([...list, q.trim()]); setQ('') } }} />
              {options.length > 0 && (
                <ul className="absolute left-0 right-0 top-full z-40 mt-0.5 max-h-48 overflow-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md">
                  {options.map((o) => <li key={o.v}><button type="button" className="w-full truncate px-2 py-1 text-left hover:bg-accent" onClick={() => { if (!list.includes(o.v)) set([...list, o.v]); setQ('') }}>{o.l}</button></li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      <FieldError stepId={stepId} field={field} />
    </div>
  )
}

/** name -> formula pairs (headers, inputs without a schema) */
export function KeyValues({ stepId, field, value, onChange, keyLabel = 'Name' }: { stepId: string; field: string; value: Record<string, string> | undefined; onChange(v: Record<string, string>): void; keyLabel?: string }) {
  const ro = useDesigner((s) => s.readOnly)
  const entries = Object.entries(value ?? {})
  const [k, setK] = useState('')
  return (
    <div className="grid gap-1.5">
      {entries.map(([name, v]) => (
        <div key={name} className="relative rounded-md border border-border p-2 pr-7">
          <FxField stepId={stepId} field={`${field}.${name}`} label={name} value={v} onChange={(x) => onChange({ ...value, [name]: x })} />
          {!ro && <button type="button" className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label={`Remove ${name}`} onClick={() => { const n = { ...value }; delete n[name]; onChange(n) }}><X className="size-3.5" /></button>}
        </div>
      ))}
      {!ro && (
        <div className="flex gap-1">
          <input className={inputCls} placeholder={keyLabel} value={k} onChange={(e) => setK(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label={keyLabel} />
          <Button size="sm" variant="outline" disabled={!k.trim() || k.trim() in (value ?? {})} onClick={() => { onChange({ ...value, [k.trim()]: '' }); setK('') }}><Plus className="size-4" />Add</Button>
        </div>
      )}
    </div>
  )
}

/** minutes as days / hours / minutes */
export function DurationPicker({ minutes, onChange, testId }: { minutes: number | undefined; onChange(m: number | undefined): void; testId?: string }) {
  const ro = useDesigner((s) => s.readOnly)
  const m = minutes ?? 0
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mi = m % 60
  const put = (dd: number, hh: number, mm: number) => onChange(dd * 1440 + hh * 60 + mm || undefined)
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0))
  return (
    <div className="flex items-center gap-1 text-xs" data-testid={testId ?? 'duration'}>
      <input type="number" min={0} className="h-8 w-16 rounded-md border border-input bg-background px-2 text-sm" value={d} disabled={ro} onChange={(e) => put(num(e.target.value), h, mi)} aria-label="Days" data-testid="duration-days" /> days
      <input type="number" min={0} max={23} className="h-8 w-14 rounded-md border border-input bg-background px-2 text-sm" value={h} disabled={ro} onChange={(e) => put(d, num(e.target.value), mi)} aria-label="Hours" data-testid="duration-hours" /> h
      <input type="number" min={0} max={59} className="h-8 w-14 rounded-md border border-input bg-background px-2 text-sm" value={mi} disabled={ro} onChange={(e) => put(d, h, num(e.target.value))} aria-label="Minutes" data-testid="duration-minutes" /> min
    </div>
  )
}

/* ------------------------------------------------------------------ inputs from a JSON Schema */

export interface Schema { type?: string | string[]; title?: string; description?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; default?: unknown; format?: string; 'x-order'?: string[] }

const typeOf = (s: Schema): string => (Array.isArray(s.type) ? s.type.find((x) => x !== 'null') ?? 'string' : s.type ?? (s.properties ? 'object' : 'string'))

/** the fields of a record formula `{a: x, b: y}` (null: not a record literal) */
export function recordFields(fx: string | undefined): Record<string, string> | null {
  const t = (fx ?? '').trim().replace(/^=/, '')
  if (!t) return {}
  const src = `=${t}`
  const p = parse(src)
  if (!p.ast || p.ast.t !== 'rec') return null
  return Object.fromEntries(p.ast.fields.map((f) => [f.name, src.slice(f.value.start, f.value.end)]))
}
export function recordFx(fields: Record<string, string>): string {
  const parts = Object.entries(fields).filter(([, v]) => v.trim()).map(([k, v]) => `${member(k)}: ${v}`)
  return parts.length ? `{${parts.join(', ')}}` : ''
}
/** the items of a table formula `[a, b]` (null: not a list literal) */
export function listItems(fx: string | undefined): string[] | null {
  const t = (fx ?? '').trim().replace(/^=/, '')
  if (!t) return []
  const src = `=${t}`
  const p = parse(src)
  if (!p.ast || p.ast.t !== 'tab') return null
  return p.ast.items.map((n) => src.slice(n.start, n.end))
}
export const listFx = (items: string[]): string => (items.filter((x) => x.trim()).length ? `[${items.filter((x) => x.trim()).join(', ')}]` : '')

function SchemaField({ stepId, field, name, schema, required, value, onChange, depth }: { stepId: string; field: string; name: string; schema: Schema; required: boolean; value: string | undefined; onChange(v: string): void; depth: number }) {
  const ty = typeOf(schema)
  const label = `${schema.title ?? name}`
  if (schema.enum?.length && ty === 'string') return <FxField stepId={stepId} field={field} label={label} required={required} hint={schema.description} value={value} onChange={onChange} kind="choice" choices={schema.enum.map(String)} testId={`input-${name}`} />
  if (ty === 'object' && schema.properties && depth < 3) {
    const rec = recordFields(value)
    if (rec === null) return <FxField stepId={stepId} field={field} label={`${label} (record)`} required={required} hint={schema.description} value={value} onChange={onChange} formulaOnly testId={`input-${name}`} />
    return (
      <fieldset className="grid gap-2 rounded-md border border-border p-2" data-testid={`input-${name}`}>
        <legend className="px-1 text-xs font-medium">{label}{required && <span className="text-destructive"> *</span>}</legend>
        {schema.description && <p className="text-[11px] text-muted-foreground">{schema.description}</p>}
        <SchemaFields stepId={stepId} field={field} schema={schema} values={rec} onChange={(r) => onChange(recordFx(r))} depth={depth + 1} />
      </fieldset>
    )
  }
  if (ty === 'array' && depth < 3) {
    const items = listItems(value)
    if (items === null) return <FxField stepId={stepId} field={field} label={`${label} (list)`} required={required} hint={schema.description} value={value} onChange={onChange} formulaOnly testId={`input-${name}`} />
    const it = schema.items ?? { type: 'string' }
    return (
      <fieldset className="grid gap-2 rounded-md border border-border p-2" data-testid={`input-${name}`}>
        <legend className="px-1 text-xs font-medium">{label} (list){required && <span className="text-destructive"> *</span>}</legend>
        {items.map((x, i) => (
          <div key={i} className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              {typeOf(it) === 'object' && it.properties
                ? <SchemaFields stepId={stepId} field={`${field}[${i}]`} schema={it} values={recordFields(x) ?? {}} onChange={(r) => onChange(listFx(items.map((y, j) => (j === i ? recordFx(r) : y))))} depth={depth + 1} />
                : <FormulaInput stepId={stepId} value={x} onChange={(v) => onChange(listFx(items.map((y, j) => (j === i ? v : y))))} />}
            </div>
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Remove item" onClick={() => onChange(listFx(items.filter((_, j) => j !== i)))}><Trash2 className="size-3.5" /></button>
          </div>
        ))}
        <Button size="sm" variant="outline" className="h-7 w-fit text-xs" onClick={() => onChange(`[${[...items, typeOf(it) === 'object' ? '{}' : '""'].join(', ')}]`)}><Plus className="size-3.5" />Item</Button>
      </fieldset>
    )
  }
  const kind: LiteralKind = ty === 'number' || ty === 'integer' ? 'number' : ty === 'boolean' ? 'boolean' : schema.format === 'date' ? 'date' : 'text'
  return <FxField stepId={stepId} field={field} label={label} required={required} hint={schema.description} value={value} onChange={onChange} kind={kind} testId={`input-${name}`} />
}

export function SchemaFields({ stepId, field, schema, values, onChange, depth = 0 }: { stepId: string; field: string; schema: Schema; values: Record<string, string>; onChange(v: Record<string, string>): void; depth?: number }) {
  const props = schema.properties ?? {}
  const order = [...(schema['x-order'] ?? []), ...Object.keys(props)].filter((k, i, a) => props[k] && a.indexOf(k) === i)
  const req = new Set(schema.required ?? [])
  const extra = Object.keys(values).filter((k) => !props[k])
  return (
    <div className="grid gap-2">
      {order.map((k) => <SchemaField key={k} stepId={stepId} field={`${field}.${k}`} name={k} schema={props[k]} required={req.has(k)} value={values[k]} onChange={(v) => { const n = { ...values }; if (v) n[k] = v; else delete n[k]; onChange(n) }} depth={depth} />)}
      {extra.map((k) => <FxField key={k} stepId={stepId} field={`${field}.${k}`} label={`${k} (not in the action's inputs)`} value={values[k]} onChange={(v) => onChange({ ...values, [k]: v })} />)}
    </div>
  )
}

/** action inputs: generated form, or the raw JSON of { input: formula } */
export function ActionInputs({ stepId, schema, values, onChange }: { stepId: string; schema: Schema | null; values: Record<string, string>; onChange(v: Record<string, string>): void }) {
  const [raw, setRaw] = useState(false)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const ro = useDesigner((s) => s.readOnly)
  return (
    <div className="grid gap-2" data-testid="action-inputs">
      <div className="flex items-center">
        <span className={labelCls}>Inputs</span>
        <span className="ml-auto inline-flex rounded border border-border p-0.5 text-[10px]">
          <button type="button" className={cn('rounded px-1.5', !raw && 'bg-accent font-medium')} onClick={() => setRaw(false)}>Form</button>
          <button type="button" className={cn('rounded px-1.5', raw && 'bg-accent font-medium')} data-testid="inputs-raw" onClick={() => { setText(JSON.stringify(values, null, 2)); setErr(null); setRaw(true) }}>Raw JSON</button>
        </span>
      </div>
      {raw ? (
        <>
          <textarea className="min-h-40 rounded-md border border-input bg-background p-2 font-mono text-xs" value={text} readOnly={ro} data-testid="inputs-json" onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              setText(e.target.value)
              try {
                const v = JSON.parse(e.target.value)
                if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => typeof x !== 'string')) throw new Error('An object of input name to formula text: { "name": "Trigger.Record.Title" }')
                setErr(null)
                onChange(v)
              } catch (x) { setErr((x as Error).message) }
            }} />
          {err && <p className="text-[11px] text-destructive">{err}</p>}
          <p className="text-[11px] text-muted-foreground">Each value is a formula: text in quotes ("abc"), numbers as they are, dynamic content as Trigger.Record.X.</p>
        </>
      ) : schema && (schema.properties || schema.type === 'object') ? (
        <SchemaFields stepId={stepId} field="inputs" schema={schema} values={values} onChange={onChange} />
      ) : (
        <KeyValues stepId={stepId} field="inputs" value={values} onChange={onChange} keyLabel="Input name" />
      )}
    </div>
  )
}

export { DynamicContent }
