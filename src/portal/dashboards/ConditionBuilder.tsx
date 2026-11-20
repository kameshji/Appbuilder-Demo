/**
 * The simple condition builder of the tile editor: rows of "column, operator, value" joined by all / any. A condition
 * the builder cannot edit exactly (nested groups, "one of", column comparisons, calculations, lookups) is shown in words
 * and kept as it is until the maker chooses to replace it. Logic: src/dashboards/editor.ts (simpleFilterOf).
 */
import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { ConditionV2 } from '@/platform/query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { EditorColumn, FilterOp, FilterRow, SimpleFilter } from '@/dashboards/editor'
import { conditionOfSimple, describeCondition, filterOpLabel, filterOpsFor, newFilterRow, opNeedsValue, simpleFilterOf } from '@/dashboards/editor'

export const sel = 'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50'

export function ConditionBuilder({ value, columns, timeZone, onChange, onError, testId, emptyText = 'Every row' }: {
  value: ConditionV2 | undefined
  columns: EditorColumn[]
  timeZone: string
  onChange(c: ConditionV2 | undefined): void
  /** a row whose value does not fit its column (the last valid condition stays in the tile) */
  onError?(message: string | null): void
  testId: string
  emptyText?: string
}) {
  const emitted = useRef<string>(JSON.stringify(value ?? null))
  const [draft, setDraft] = useState<SimpleFilter | null>(() => simpleFilterOf(value, columns, timeZone))
  const [error, setError] = useState<string | null>(null)
  // a change from outside (another table, a removed column) resets the rows
  useEffect(() => {
    const now = JSON.stringify(value ?? null)
    if (now === emitted.current) return
    emitted.current = now
    setDraft(simpleFilterOf(value, columns, timeZone))
    setError(null)
    onError?.(null)
  }, [value, columns, timeZone, onError])
  const labelOf = (c: string) => columns.find((x) => x.name.toLowerCase() === c.toLowerCase())?.label ?? c

  if (!draft) {
    return (
      <div className="grid gap-2 rounded-md border border-dashed p-2 text-xs" data-testid={`${testId}-advanced`}>
        <div><span className="font-medium">Rows where </span>{describeCondition(value, labelOf)}</div>
        <div className="text-muted-foreground">This condition was written outside the editor and is kept as it is.</div>
        <div><Button type="button" size="sm" variant="outline" onClick={() => { emitted.current = 'null'; setDraft({ join: 'and', rows: [] }); onChange(undefined) }}>Replace it with a simple condition</Button></div>
      </div>
    )
  }

  const push = (next: SimpleFilter) => {
    setDraft(next)
    try {
      const c = conditionOfSimple(next, timeZone)
      emitted.current = JSON.stringify(c ?? null)
      setError(null)
      onError?.(null)
      onChange(c)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setError(m)
      onError?.(m)
    }
  }
  const setRow = (i: number, r: FilterRow) => push({ ...draft, rows: draft.rows.map((x, j) => (j === i ? r : x)) })
  const first = columns.find((c) => c.kind !== 'other') ?? columns[0]

  return (
    <div className="grid gap-2" data-testid={testId}>
      {draft.rows.length === 0 && <div className="text-xs text-muted-foreground">{emptyText}</div>}
      {draft.rows.length > 1 && (
        <label className="flex items-center gap-2 text-xs">
          Rows that match
          <select className={sel} value={draft.join} onChange={(e) => push({ ...draft, join: e.target.value as 'and' | 'or' })} aria-label="Match all or any" data-testid={`${testId}-join`}>
            <option value="and">all of these</option>
            <option value="or">any of these</option>
          </select>
        </label>
      )}
      {draft.rows.map((r, i) => {
        const c = columns.find((x) => x.name.toLowerCase() === r.col.toLowerCase())
        const ops = filterOpsFor(r.kind)
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5" data-testid={`${testId}-row-${i}`}>
            <select className={`${sel} max-w-[11rem]`} value={c?.name ?? r.col} aria-label="Column" data-testid={`${testId}-col-${i}`}
              onChange={(e) => { const n = columns.find((x) => x.name === e.target.value); if (n) setRow(i, newFilterRow(n)) }}>
              {!c && <option value={r.col}>{r.col} (missing)</option>}
              {columns.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
            </select>
            <select className={sel} value={r.op} aria-label="Operator" data-testid={`${testId}-op-${i}`} onChange={(e) => setRow(i, { ...r, op: e.target.value as FilterOp })}>
              {(ops.includes(r.op) ? ops : [r.op, ...ops]).map((o) => <option key={o} value={o}>{filterOpLabel(o, r.kind)}</option>)}
            </select>
            {opNeedsValue(r.op) && <ValueInput row={r} column={c} onChange={(value) => setRow(i, { ...r, value })} testId={`${testId}-value-${i}`} />}
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Remove this condition" onClick={() => push({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })}><X className="size-3.5" /></button>
          </div>
        )
      })}
      {error && <div className="text-xs text-destructive" role="alert">{error}</div>}
      {first && (
        <div><Button type="button" size="sm" variant="ghost" onClick={() => push({ ...draft, rows: [...draft.rows, newFilterRow(first)] })} data-testid={`${testId}-add`}><Plus /> Add a condition</Button></div>
      )}
    </div>
  )
}

function ValueInput({ row, column, onChange, testId }: { row: FilterRow; column?: EditorColumn; onChange(v: string): void; testId: string }) {
  const cls = 'h-8 w-40'
  if (row.kind === 'boolean') {
    return (
      <select className={sel} value={/^(true|yes)$/i.test(row.value) ? 'true' : 'false'} onChange={(e) => onChange(e.target.value)} aria-label="Value" data-testid={testId}>
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    )
  }
  if (row.kind === 'text' && column?.choices?.length && ['eq', 'ne'].includes(row.op)) {
    const lower = column.choices.map((x) => x.toLowerCase())
    return (
      <select className={sel} value={row.value} onChange={(e) => onChange(e.target.value)} aria-label="Value" data-testid={testId}>
        {!lower.includes(row.value.toLowerCase()) && <option value={row.value}>{row.value || '(choose)'}</option>}
        {/* a stored value that differs only in case ("breakdown") stays as it is */}
        {column.choices.map((x) => <option key={x} value={x.toLowerCase() === row.value.toLowerCase() ? row.value : x}>{x}</option>)}
      </select>
    )
  }
  const type = row.kind === 'number' ? 'number' : row.kind === 'date' ? 'date' : row.kind === 'datetime' ? 'datetime-local' : 'text'
  return <Input className={cls} type={type} value={row.value} onChange={(e) => onChange(e.target.value)} aria-label="Value" data-testid={testId} />
}
