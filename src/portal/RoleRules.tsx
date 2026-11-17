/** Per-table column access (CLS) grid and row filter (RLS) builder for one role. */
import { useEffect, useMemo, useState } from 'react'
import { Plus, RotateCcw, Save, X } from 'lucide-react'
import { usePlatform, type ColumnAccess, type ColumnDef, type RoleDef, type RowCondition, type TableDef, type TablePrivilege } from '@/platform'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Segmented } from './kit'
import { TYPE_INFO } from './columnTypes'
import { isNumeric } from './cells'
import { COLUMN_ACCESS, OPS, TOKEN_EMAIL, TOKEN_ME, TOKEN_OPS, describeRows, opInfo, securedColumns } from './security'

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

/* ------------------------------------------------------------------ row filter */

interface Draft { column: string; op: RowCondition['op']; mode: 'value' | typeof TOKEN_ME | typeof TOKEN_EMAIL; text: string }

function toDraft(c: RowCondition): Draft {
  if (c.value === TOKEN_ME || c.value === TOKEN_EMAIL) return { column: c.column, op: c.op, mode: c.value, text: '' }
  return { column: c.column, op: c.op, mode: 'value', text: Array.isArray(c.value) ? c.value.join(', ') : c.value === undefined ? '' : String(c.value) }
}

function toCondition(d: Draft, col: ColumnDef | undefined): RowCondition | null {
  if (!d.column) return null
  const info = opInfo(d.op)
  if (!info.needsValue) return { column: d.column, op: d.op }
  if (d.mode !== 'value' && TOKEN_OPS.includes(d.op)) return { column: d.column, op: d.op, value: d.mode }
  const num = col ? isNumeric(col.type) : false
  const conv = (t: string): string | number | boolean => {
    const s = t.trim()
    if (col?.type === 'boolean') return s === 'true'
    if (num && s !== '' && Number.isFinite(Number(s))) return Number(s)
    return s
  }
  if (d.op === 'in') {
    const parts = d.text.split(',').map((x) => x.trim()).filter(Boolean)
    return parts.length ? { column: d.column, op: 'in', value: parts.map((p) => conv(p) as string | number) } : null
  }
  if (d.text.trim() === '' && col?.type !== 'boolean') return null
  return { column: d.column, op: d.op, value: conv(d.text) }
}

function ValueEditor({ d, col, onChange }: { d: Draft; col: ColumnDef | undefined; onChange(p: Partial<Draft>): void }) {
  const info = opInfo(d.op)
  if (!info.needsValue) return <span className="text-xs text-muted-foreground">no value needed</span>
  const tokens = TOKEN_OPS.includes(d.op)
  const mode = tokens ? d.mode : 'value'
  return (
    <div className="flex items-center gap-1.5">
      {tokens && (
        <Select value={mode} onValueChange={(v) => onChange({ mode: v as Draft['mode'] })}>
          <SelectTrigger size="sm" className="w-44" aria-label="Value type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="value">A specific value</SelectItem>
            <SelectItem value={TOKEN_ME}>Current user</SelectItem>
            <SelectItem value={TOKEN_EMAIL}>Current user's email</SelectItem>
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
          <Input className="h-8 w-44" aria-label="Value" value={d.text} placeholder={d.op === 'in' ? 'a, b, c' : 'value'} inputMode={col && isNumeric(col.type) ? 'decimal' : undefined} onChange={(e) => onChange({ text: e.target.value })} />
        )
      )}
    </div>
  )
}

export function RowFilterBuilder({ role, table, priv, disabled, onChange }: { role: RoleDef; table: TableDef; priv: TablePrivilege; disabled: boolean; onChange(p: Partial<TablePrivilege>): void }) {
  usePlatform((s) => s.mode)
  const initial = useMemo(() => (priv.rowFilter ?? []).map(toDraft), [priv.rowFilter])
  const [draft, setDraft] = useState<Draft[]>(initial)
  useEffect(() => { setDraft(initial) }, [initial, table.id, role.id])
  const colOf = (n: string) => table.columns.find((c) => c.name === n)
  const filterable = table.columns
  const conds = draft.map((d) => toCondition(d, colOf(d.column)))
  const complete = conds.every((c) => c !== null)
  const clean = conds.filter((c): c is RowCondition => c !== null)
  const dirty = JSON.stringify(clean) !== JSON.stringify(priv.rowFilter ?? []) || draft.length !== (priv.rowFilter ?? []).length
  const patch = (i: number, p: Partial<Draft>) => setDraft((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const scope = priv.read !== 'none' ? priv.read : priv.update !== 'none' ? priv.update : priv.delete
  const sentence = scope === 'none'
    ? 'This role has no read, update or delete access to the table, so the filter has no effect yet.'
    : `${role.name} see ${describeRows(scope, clean, table.columns)}.`
  return (
    <div className="grid gap-3" data-testid="role-rowfilter">
      <p className="text-xs text-muted-foreground">Rows must match every condition below (they are combined with AND) for this role's read, update and delete access to apply.</p>
      {draft.length === 0 && <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">No filter: where the role has access, it covers all rows.</p>}
      <ul className="grid gap-2">
        {draft.map((d, i) => (
          <li key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card p-2" data-testid={`rf-cond-${i}`}>
            <Select value={d.column} disabled={disabled} onValueChange={(v) => patch(i, { column: v })}>
              <SelectTrigger size="sm" className="w-44" aria-label="Column" data-testid={`rf-column-${i}`}><SelectValue placeholder="Column" /></SelectTrigger>
              <SelectContent>{filterable.map((c) => <SelectItem key={c.name} value={c.name}>{c.displayName}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={d.op} disabled={disabled} onValueChange={(v) => patch(i, { op: v as RowCondition['op'] })}>
              <SelectTrigger size="sm" className="w-40" aria-label="Operator" data-testid={`rf-op-${i}`}><SelectValue /></SelectTrigger>
              <SelectContent>{OPS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
            <div className={disabled ? 'pointer-events-none opacity-60' : ''} data-testid={`rf-value-${i}`}><ValueEditor d={d} col={colOf(d.column)} onChange={(p) => patch(i, p)} /></div>
            <Button variant="ghost" size="icon-sm" className="ml-auto" disabled={disabled} aria-label="Remove condition" onClick={() => setDraft((l) => l.filter((_, j) => j !== i))}><X /></Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={() => setDraft((l) => [...l, { column: table.columns.find((c) => c.name === 'owner') ? 'owner' : filterable[0]?.name ?? '', op: 'eq', mode: TOKEN_ME, text: '' }])} data-testid="rf-add"><Plus /> Add condition</Button>
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span>}
          <Button type="button" variant="ghost" size="xs" disabled={!dirty} onClick={() => setDraft(initial)}><RotateCcw /> Revert</Button>
          <Button type="button" size="xs" disabled={disabled || !dirty || !complete} onClick={() => onChange({ rowFilter: clean.length ? clean : undefined })} data-testid="rf-save"><Save /> Save filter</Button>
        </div>
      </div>
      {!complete && <p className="text-xs text-destructive" role="alert">Every condition needs a column and, unless it checks for empty, a value.</p>}
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
        <Segmented label="Rule type" value={tab} onChange={setTab} options={[{ value: 'columns', label: `Columns${nCls ? ` (${nCls})` : ''}` }, { value: 'rows', label: `Row filter${priv.rowFilter?.length ? ` (${priv.rowFilter.length})` : ''}` }]} />
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close" onClick={onClose}><X /></Button>
      </div>
      {tab === 'columns' ? <ColumnsGrid table={table} priv={priv} disabled={disabled} onChange={onChange} /> : <RowFilterBuilder role={role} table={table} priv={priv} disabled={disabled} onChange={onChange} />}
    </div>
  )
}
