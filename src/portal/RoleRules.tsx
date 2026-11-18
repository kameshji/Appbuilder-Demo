/** Per-table column access (CLS) grid and row filter (RLS) builder for one role. */
import { useEffect, useMemo, useState } from 'react'
import { Plus, RotateCcw, Save, X } from 'lucide-react'
import { isRowCompare, isRowExists, usePlatform, type ColumnAccess, type ColumnDef, type RoleDef, type RowCompare, type RowCondition, type TableDef, type TablePrivilege } from '@/platform'
import { ruleProblems } from '@/platform/orgsec'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Segmented } from './kit'
import { TYPE_INFO } from './columnTypes'
import { isNumeric } from './cells'
import { COLUMN_ACCESS, OPS, TOKENS, TOKEN_ME, TOKEN_OPS, describeCondition, describeRows, opInfo, securedColumns } from './security'

/* ------------------------------------------------------------------ columns */

export function ColumnsGrid({ table, priv, disabled, onChange }: { table: TableDef; priv: TablePrivilege; disabled: boolean; onChange(p: Partial<TablePrivilege>): void }) {
  const cols = securedColumns(table)
  const get = (c: ColumnDef): ColumnAccess => priv.columns?.[c.name] ?? 'update'
  const apply = (next: Record<string, ColumnAccess>) => onChange({ columns: Object.keys(next).length ? next : undefined })
  const set = (c: ColumnDef, a: ColumnAccess) => {
    const next = { ...(priv.columns ?? {}) }
    if (a === 'update') delete next[c.name]
    else next[c.name] = a
    apply(next)
  }
  const all = (a: ColumnAccess) => apply(a === 'update' ? {} : Object.fromEntries(cols.map((c) => [c.name, a])))
  const hidden = cols.filter((c) => get(c) === 'none').length
  const ro = cols.filter((c) => get(c) === 'read').length
  return (
    <div className="grid gap-3" data-testid="role-columns-grid">
      <div className="flex items-center gap-2">
        <p className="text-xs text-muted-foreground">
          {hidden === 0 && ro === 0 ? 'Every column is fully available.' : `${hidden} hidden, ${ro} read-only, ${cols.length - hidden - ro} editable.`} A user with several roles gets the most permissive access per column.
        </p>
        {!disabled && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Set all:</span>
            <Button size="xs" variant="outline" onClick={() => all('update')}>Update</Button>
            <Button size="xs" variant="outline" onClick={() => all('read')}>Read</Button>
            <Button size="xs" variant="outline" onClick={() => all('none')}>None</Button>
          </div>
        )}
      </div>
      {priv.read === 'none' && !disabled && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">This role cannot read the table yet, so these settings have no effect. Give it Read access above.</p>}
      {cols.length === 0 ? (
        <p className="text-sm text-muted-foreground">This table has no columns to secure.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground"><th className="px-3 py-2">Column</th><th className="px-3 py-2">Access</th></tr>
            </thead>
            <tbody>
              {cols.map((c) => {
                const I = TYPE_INFO[c.type]?.icon
                return (
                  <tr key={c.name} className="border-b border-border last:border-0" data-testid={`cls-row-${c.name}`}>
                    <td className="px-3 py-1.5"><span className="flex items-center gap-2">{I && <I className="size-3.5 text-muted-foreground" />}<span className="font-medium">{c.displayName}</span><span className="font-mono text-[11px] text-muted-foreground">{c.name}</span></span></td>
                    <td className="px-3 py-1.5" data-testid={`cls-${c.name}`}>
                      <Segmented size="sm" label={`Access to ${c.displayName}`} disabled={disabled} value={get(c)} onChange={(v) => set(c, v)} options={COLUMN_ACCESS} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ row rules (filter, relationship rules) */

/**
 * Drafts of the rule AST (RowCondition in src/platform/contracts.ts):
 *  - field: a column or a path through lookups (at most two hops), an operator and a value or token;
 *  - exists: rows of another table (a junction) that point at this row and match field conditions;
 *  - raw: anything the builder does not edit (an "any of" group made elsewhere): shown and removable.
 */
type ValueMode = 'value' | string
interface FieldDraft { kind: 'field'; path: string[]; op: RowCompare['op']; mode: ValueMode; text: string }
interface ExistsDraft { kind: 'exists'; table: string; link: string; linkTo: string; where: FieldDraft[] }
interface RawDraft { kind: 'raw'; rule: RowCondition }
type Draft = FieldDraft | ExistsDraft | RawDraft

const isTokenText = (v: unknown): v is string => typeof v === 'string' && v.startsWith('@')

function fieldDraft(c: RowCompare): FieldDraft {
  const path = c.column.split('.')
  if (isTokenText(c.value)) return { kind: 'field', path, op: c.op, mode: c.value, text: '' }
  return { kind: 'field', path, op: c.op, mode: 'value', text: Array.isArray(c.value) ? c.value.join(', ') : c.value === undefined ? '' : String(c.value) }
}

function toDraft(c: RowCondition): Draft {
  if (isRowExists(c)) {
    const corr = c.exists.where.find((w) => isRowCompare(w) && typeof w.value === 'string' && /^@this(\.|$)/.test(w.value)) as RowCompare | undefined
    const rest = c.exists.where.filter((w) => w !== corr)
    if (!corr || !rest.every(isRowCompare)) return { kind: 'raw', rule: c }
    const linkTo = String(corr.value) === '@this' ? 'id' : String(corr.value).slice(6)
    return { kind: 'exists', table: c.exists.table, link: corr.column, linkTo, where: (rest as RowCompare[]).map(fieldDraft) }
  }
  if (isRowCompare(c)) return fieldDraft(c)
  return { kind: 'raw', rule: c }
}

/** the column at the end of a path (for typed value editors) */
function columnAt(table: TableDef | undefined, path: string[], tables: TableDef[]): ColumnDef | undefined {
  let t = table
  let col: ColumnDef | undefined
  for (const p of path) {
    col = t?.columns.find((c) => c.name === p)
    t = col?.lookupTable ? tables.find((x) => x.name === col!.lookupTable || x.id === col!.lookupTable) : undefined
  }
  return col
}

function fieldRule(d: FieldDraft, table: TableDef | undefined, tables: TableDef[]): RowCompare | null {
  if (!d.path.length || d.path.some((p) => !p)) return null
  const column = d.path.join('.')
  const info = opInfo(d.op)
  if (!info.needsValue) return { column, op: d.op }
  if (d.mode !== 'value') {
    const tok = TOKENS.find((t) => t.value === d.mode)
    if (d.op === 'in' || (tok?.list && !['eq', 'ne'].includes(d.op))) return null
    if (!tok?.list && !TOKEN_OPS.includes(d.op) && !/^@(team|department|departmentTree):/.test(d.mode)) return null
    return { column, op: d.op, value: d.mode }
  }
  const col = columnAt(table, d.path, tables)
  const num = col ? isNumeric(col.type) : false
  const conv = (t: string): string | number | boolean => {
    const s = t.trim()
    if (col?.type === 'boolean') return s === 'true'
    if (num && s !== '' && Number.isFinite(Number(s))) return Number(s)
    return s
  }
  if (d.op === 'in') {
    const parts = d.text.split(',').map((x) => x.trim()).filter(Boolean)
    return parts.length ? { column, op: 'in', value: parts.map((p) => conv(p) as string | number) } : null
  }
  if (d.text.trim() === '' && col?.type !== 'boolean') return null
  return { column, op: d.op, value: conv(d.text) }
}

function toRule(d: Draft, table: TableDef, tables: TableDef[]): RowCondition | null {
  if (d.kind === 'raw') return d.rule
  if (d.kind === 'field') return fieldRule(d, table, tables)
  const target = tables.find((t) => t.name === d.table || t.id === d.table)
  if (!target || !d.link) return null
  const where: RowCondition[] = [{ column: d.link, op: 'eq', value: d.linkTo === 'id' ? '@this' : `@this.${d.linkTo}` }]
  for (const w of d.where) {
    const r = fieldRule(w, target, tables)
    if (!r) return null
    where.push(r)
  }
  return { exists: { table: target.name, where } }
}

/** a column picker that can follow lookup columns (at most `hops` of them) */
function PathPicker({ table, tables, path, hops, disabled, onChange, testId }: { table: TableDef | undefined; tables: TableDef[]; path: string[]; hops: number; disabled: boolean; onChange(p: string[]): void; testId: string }) {
  const levels: { cols: ColumnDef[]; value: string }[] = []
  let t = table
  for (let i = 0; i <= hops && t; i++) {
    levels.push({ cols: t.columns, value: path[i] ?? '' })
    const col = t.columns.find((c) => c.name === path[i])
    if (!col || col.type !== 'lookup' || i === hops || path.length <= i + 1) {
      // a lookup column offers one more level ("its ...") when there is room
      if (col?.type === 'lookup' && i < hops && path.length === i + 1) {
        const next = tables.find((x) => x.name === col.lookupTable || x.id === col.lookupTable)
        if (next) levels.push({ cols: next.columns, value: '' })
      }
      break
    }
    t = tables.find((x) => x.name === col.lookupTable || x.id === col.lookupTable)
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {levels.map((lv, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-xs text-muted-foreground">its</span>}
          <Select value={lv.value || (i > 0 ? '__self' : '')} disabled={disabled} onValueChange={(v) => onChange(v === '__self' ? path.slice(0, i) : [...path.slice(0, i), v])}>
            <SelectTrigger size="sm" className="w-40" aria-label={i === 0 ? 'Column' : 'Column of the looked-up row'} data-testid={`${testId}-path-${i}`}><SelectValue placeholder="Column" /></SelectTrigger>
            <SelectContent>
              {i > 0 && <SelectItem value="__self">(the row itself)</SelectItem>}
              {lv.cols.map((c) => <SelectItem key={c.name} value={c.name}>{c.displayName}{c.type === 'lookup' ? ' >' : ''}</SelectItem>)}
            </SelectContent>
          </Select>
        </span>
      ))}
    </span>
  )
}

function ValueEditor({ d, col, onChange, testId }: { d: FieldDraft; col: ColumnDef | undefined; onChange(p: Partial<FieldDraft>): void; testId: string }) {
  const teams = usePlatform((s) => s.teams)
  const departments = usePlatform((s) => s.departments)
  const info = opInfo(d.op)
  if (!info.needsValue) return <span className="text-xs text-muted-foreground">no value needed</span>
  const tokensOk = d.op !== 'in'
  const mode = tokensOk ? d.mode : 'value'
  return (
    <div className="flex items-center gap-1.5">
      {tokensOk && (
        <Select value={mode} onValueChange={(v) => onChange({ mode: v })}>
          <SelectTrigger size="sm" className="w-56" aria-label="Value type" data-testid={`${testId}-mode`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="value">A specific value</SelectItem>
            {TOKENS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label[0].toUpperCase() + t.label.slice(1)}</SelectItem>)}
            {teams.map((t) => <SelectItem key={t.id} value={`@team:${t.code}`}>Team {t.name}</SelectItem>)}
            {departments.map((x) => <SelectItem key={x.id} value={`@department:${x.code}`}>Department {x.name}</SelectItem>)}
            {departments.map((x) => <SelectItem key={`t-${x.id}`} value={`@departmentTree:${x.code}`}>Department {x.name} or below</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {mode === 'value' && (
        col?.type === 'boolean' && d.op !== 'in' ? (
          <Select value={d.text === 'true' ? 'true' : 'false'} onValueChange={(v) => onChange({ text: v })}>
            <SelectTrigger size="sm" className="w-28" aria-label="Value"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="true">Yes</SelectItem><SelectItem value="false">No</SelectItem></SelectContent>
          </Select>
        ) : col?.type === 'choice' && d.op !== 'in' && (d.op === 'eq' || d.op === 'ne') ? (
          <Select value={d.text} onValueChange={(v) => onChange({ text: v })}>
            <SelectTrigger size="sm" className="w-44" aria-label="Value"><SelectValue placeholder="Choose" /></SelectTrigger>
            <SelectContent>{(col.choices ?? []).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        ) : (
          <Input className="h-8 w-44" aria-label="Value" value={d.text} placeholder={d.op === 'in' ? 'a, b, c' : 'value'} inputMode={col && isNumeric(col.type) ? 'decimal' : undefined} onChange={(e) => onChange({ text: e.target.value })} data-testid={`${testId}-text`} />
        )
      )}
    </div>
  )
}

function FieldRow({ d, table, tables, hops, disabled, onChange, onRemove, testId }: { d: FieldDraft; table: TableDef | undefined; tables: TableDef[]; hops: number; disabled: boolean; onChange(p: Partial<FieldDraft>): void; onRemove(): void; testId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <PathPicker table={table} tables={tables} path={d.path} hops={hops} disabled={disabled} onChange={(path) => onChange({ path })} testId={testId} />
      <Select value={d.op} disabled={disabled} onValueChange={(v) => onChange({ op: v as RowCompare['op'] })}>
        <SelectTrigger size="sm" className="w-36" aria-label="Operator" data-testid={`${testId}-op`}><SelectValue /></SelectTrigger>
        <SelectContent>{OPS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
      <div className={disabled ? 'pointer-events-none opacity-60' : ''}><ValueEditor d={d} col={columnAt(table, d.path, tables)} onChange={onChange} testId={testId} /></div>
      <Button variant="ghost" size="icon-sm" className="ml-auto" disabled={disabled} aria-label="Remove condition" onClick={onRemove}><X /></Button>
    </div>
  )
}

export function RowFilterBuilder({ role, table, priv, disabled, onChange }: { role: RoleDef; table: TableDef; priv: TablePrivilege; disabled: boolean; onChange(p: Partial<TablePrivilege>): void }) {
  const tables = usePlatform((s) => s.tables)
  const initial = useMemo(() => (priv.rowFilter ?? []).map(toDraft), [priv.rowFilter])
  const [draft, setDraft] = useState<Draft[]>(initial)
  useEffect(() => { setDraft(initial) }, [initial, table.id, role.id])
  const rules = draft.map((d) => toRule(d, table, tables))
  const complete = rules.every((c) => c !== null)
  const clean = rules.filter((c): c is RowCondition => c !== null)
  const dirty = JSON.stringify(clean) !== JSON.stringify(priv.rowFilter ?? []) || draft.length !== (priv.rowFilter ?? []).length
  const patch = (i: number, p: Partial<FieldDraft> | Partial<ExistsDraft>) => setDraft((l) => l.map((x, j) => (j === i ? ({ ...x, ...p } as Draft) : x)))
  const scope = priv.read !== 'none' ? priv.read : priv.update !== 'none' ? priv.update : priv.delete
  const sentence = scope === 'none'
    ? 'This role has no read, update or delete access to the table, so the rules have no effect yet.'
    : `${role.name} see ${describeRows(scope, clean, table.columns, tables)}.`
  // tables with a lookup to this one: candidates for "related rows" rules (a junction such as Enrolment)
  const junctions = tables.filter((t) => t.columns.some((c) => c.type === 'lookup' && (c.lookupTable === table.name || c.lookupTable === table.id)))
  const problems = complete ? ruleProblems(table, clean, tables) : []
  return (
    <div className="grid gap-3" data-testid="role-rowfilter">
      <p className="text-xs text-muted-foreground">Rows must match every rule below (they are combined with AND) for this role's read, update and delete access to apply. A rule can follow lookup columns (for example Section, then its Teacher) or look at related rows in another table.</p>
      {draft.length === 0 && <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">No rules: where the role has access, it covers all rows.</p>}
      <ul className="grid gap-2">
        {draft.map((d, i) => (
          <li key={i} className="rounded-lg border border-border bg-card p-2" data-testid={`rf-cond-${i}`}>
            {d.kind === 'field' && <FieldRow d={d} table={table} tables={tables} hops={2} disabled={disabled} onChange={(p) => patch(i, p)} onRemove={() => setDraft((l) => l.filter((_, j) => j !== i))} testId={`rf-${i}`} />}
            {d.kind === 'raw' && (
              <div className="flex items-center gap-2 text-sm"><span className="flex-1">{describeCondition(d.rule, table.columns, tables)}</span><Button variant="ghost" size="icon-sm" disabled={disabled} aria-label="Remove condition" onClick={() => setDraft((l) => l.filter((_, j) => j !== i))}><X /></Button></div>
            )}
            {d.kind === 'exists' && (() => {
              const target = tables.find((t) => t.name === d.table || t.id === d.table)
              return (
                <div className="grid gap-2" data-testid={`rf-exists-${i}`}>
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="text-xs font-medium">A row of</span>
                    <Select value={d.table} disabled={disabled} onValueChange={(v) => patch(i, { table: v, link: '', where: [] })}>
                      <SelectTrigger size="sm" className="w-40" aria-label="Related table" data-testid={`rf-exists-${i}-table`}><SelectValue placeholder="Table" /></SelectTrigger>
                      <SelectContent>{tables.map((t) => <SelectItem key={t.id} value={t.name}>{t.displayName}</SelectItem>)}</SelectContent>
                    </Select>
                    <span className="text-xs font-medium">exists whose</span>
                    <Select value={d.link} disabled={disabled || !target} onValueChange={(v) => patch(i, { link: v })}>
                      <SelectTrigger size="sm" className="w-40" aria-label="Column pointing at this row" data-testid={`rf-exists-${i}-link`}><SelectValue placeholder="Column" /></SelectTrigger>
                      <SelectContent>{(target?.columns ?? []).map((c) => <SelectItem key={c.name} value={c.name}>{c.displayName}</SelectItem>)}</SelectContent>
                    </Select>
                    <span className="text-xs font-medium">is</span>
                    <Select value={d.linkTo} disabled={disabled} onValueChange={(v) => patch(i, { linkTo: v })}>
                      <SelectTrigger size="sm" className="w-44" aria-label="This row" data-testid={`rf-exists-${i}-to`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="id">this row</SelectItem>
                        {table.columns.filter((c) => c.name !== 'id').map((c) => <SelectItem key={c.name} value={c.name}>this row's {c.displayName}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon-sm" className="ml-auto" disabled={disabled} aria-label="Remove rule" onClick={() => setDraft((l) => l.filter((_, j) => j !== i))}><X /></Button>
                  </div>
                  <div className="grid gap-1.5 border-l-2 border-primary/30 pl-3">
                    {d.where.map((w, k) => (
                      <FieldRow key={k} d={w} table={target} tables={tables} hops={2} disabled={disabled}
                        onChange={(p) => patch(i, { where: d.where.map((x, m) => (m === k ? { ...x, ...p } : x)) })}
                        onRemove={() => patch(i, { where: d.where.filter((_, m) => m !== k) })} testId={`rf-${i}-w${k}`} />
                    ))}
                    <Button type="button" variant="ghost" size="xs" className="justify-self-start" disabled={disabled || !target} onClick={() => patch(i, { where: [...d.where, { kind: 'field', path: [], op: 'eq', mode: TOKEN_ME, text: '' }] })} data-testid={`rf-exists-${i}-add`}><Plus /> and where...</Button>
                  </div>
                </div>
              )
            })()}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={() => setDraft((l) => [...l, { kind: 'field', path: table.columns.find((c) => c.name === 'owner') ? ['owner'] : [table.columns[0]?.name ?? ''], op: 'eq', mode: TOKEN_ME, text: '' }])} data-testid="rf-add"><Plus /> Add condition</Button>
        <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={() => {
          const j = junctions[0]
          const link = j?.columns.find((c) => c.type === 'lookup' && (c.lookupTable === table.name || c.lookupTable === table.id))?.name ?? ''
          setDraft((l) => [...l, { kind: 'exists', table: j?.name ?? '', link, linkTo: 'id', where: [] }])
        }} data-testid="rf-add-exists"><Plus /> Related rows rule</Button>
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span>}
          <Button type="button" variant="ghost" size="xs" disabled={!dirty} onClick={() => setDraft(initial)}><RotateCcw /> Revert</Button>
          <Button type="button" size="xs" disabled={disabled || !dirty || !complete || problems.length > 0} onClick={() => onChange({ rowFilter: clean.length ? clean : undefined })} data-testid="rf-save"><Save /> Save rules</Button>
        </div>
      </div>
      {!complete && <p className="text-xs text-destructive" role="alert">Every condition needs a column and, unless it checks for empty, a value that fits the operator (lists such as "one of my teams" work with "is" and "is not").</p>}
      {problems.length > 0 && <p className="text-xs text-destructive" role="alert" data-testid="rf-problems">{problems[0]}</p>}
      <p className="rounded-md bg-muted/60 px-3 py-2 text-sm" data-testid="role-rowfilter-preview">{sentence}</p>
    </div>
  )
}

/** Panel shown under the privilege matrix for the chosen table. */
export function TableRules({ role, table, priv, disabled, onChange, onClose }: { role: RoleDef; table: TableDef; priv: TablePrivilege; disabled: boolean; onChange(p: Partial<TablePrivilege>): void; onClose(): void }) {
  const [tab, setTab] = useState<'columns' | 'rows'>('columns')
  const nCls = Object.values(priv.columns ?? {}).filter((a) => a !== 'update').length
  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/20 p-4" data-testid="table-rules">
      <div className="mb-3 flex items-center gap-3">
        <h4 className="text-sm font-semibold">{table.displayName}: finer rules</h4>
        <Segmented label="Rule type" value={tab} onChange={setTab} options={[{ value: 'columns', label: `Columns${nCls ? ` (${nCls})` : ''}` }, { value: 'rows', label: `Row rules${priv.rowFilter?.length ? ` (${priv.rowFilter.length})` : ''}` }]} />
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close" onClick={onClose}><X /></Button>
      </div>
      {tab === 'columns' ? <ColumnsGrid table={table} priv={priv} disabled={disabled} onChange={onChange} /> : <RowFilterBuilder role={role} table={table} priv={priv} disabled={disabled} onChange={onChange} />}
    </div>
  )
}
