/**
 * Small shared pieces of the Accounts area: a loader hook, the money cell, a plain table and CrudTable (a list with an
 * add / edit form under it, driven by a field list; used for reference data, customers and suppliers, items, number
 * series and the chart of accounts).
 */
import { useState, type ReactNode } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Field, Panel, useToast } from '../kit'
import { inr } from './api'

export const sel = 'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-md:h-11'
export const th = 'px-2 py-1.5 text-left text-xs font-medium text-muted-foreground'
export const td = 'px-2 py-1.5 align-top'
export const num = 'px-2 py-1.5 text-right align-top tabular-nums'

export function Loading({ error }: { error: string }) {
  return error ? <p className="text-sm text-destructive" role="alert">{error}</p> : <Spinner />
}

export const Money = ({ value, blankZero }: { value: number; blankZero?: boolean }) => <>{blankZero && !value ? '' : inr(value)}</>

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 text-base font-semibold">{children}</h2>{actions}</div>
}

export interface FieldSpec {
  key: string
  label: string
  type?: 'text' | 'select' | 'bool' | 'date'
  options?: { value: string; label: string }[]
  hint?: string
  /** not shown as a column of the list */
  formOnly?: boolean
  /** shown in the list only */
  listOnly?: boolean
  /** value when adding */
  initial?: string | boolean
}
interface Row { id: string }
const cellOf = (r: Row, key: string): unknown => (r as unknown as Record<string, unknown>)[key]

/** a list with "Add" and "Edit" opening a form under it. Saving goes to the server; the list is reloaded by the caller. */
export function CrudTable<R extends Row>({ title, fields, rows, onSave, onDelete, canEdit, testid, empty, intro }: {
  title: string; fields: FieldSpec[]; rows: R[]; onSave(id: string | null, values: Record<string, unknown>): Promise<unknown>; onDelete?(row: R): Promise<unknown>
  canEdit: boolean; testid: string; empty: string; intro?: ReactNode
}) {
  const { fail, toast } = useToast()
  const [edit, setEdit] = useState<{ id: string | null; values: Record<string, unknown> } | null>(null)
  const [busy, setBusy] = useState(false)
  const cols = fields.filter((f) => !f.formOnly)
  const form = fields.filter((f) => !f.listOnly)
  const start = (r: R | null) => setEdit({ id: r?.id ?? null, values: Object.fromEntries(form.map((f) => [f.key, r ? cellOf(r, f.key) ?? (f.type === 'bool' ? false : '') : f.initial ?? (f.type === 'bool' ? false : '')])) })
  const save = async () => {
    if (!edit) return
    setBusy(true)
    try {
      await onSave(edit.id, edit.values)
      toast('Saved', 'success')
      setEdit(null)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const show = (f: FieldSpec, v: unknown): string => (f.type === 'bool' ? (v ? 'Yes' : '') : f.type === 'select' ? f.options?.find((o) => o.value === v)?.label ?? String(v ?? '') : v === null || v === undefined ? '' : String(v))
  return (
    <div data-testid={testid}>
      <SectionTitle actions={canEdit && <Button size="sm" onClick={() => start(null)} data-testid={`${testid}-add`}><Plus /> Add</Button>}>{title}</SectionTitle>
      {intro}
      {rows.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p> : (
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>{cols.map((f) => <th key={f.key} className={th}>{f.label}</th>)}{canEdit && <th className={th} />}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/60" data-testid={`${testid}-row`}>
                  {cols.map((f) => <td key={f.key} className={td}>{show(f, cellOf(r, f.key))}</td>)}
                  {canEdit && (
                    <td className={`${td} whitespace-nowrap text-right`}>
                      <Button size="icon-sm" variant="ghost" className="max-md:size-11" aria-label="Edit" onClick={() => start(r)}><Pencil /></Button>
                      {onDelete && <Button size="icon-sm" variant="ghost" className="max-md:size-11" aria-label="Delete" onClick={() => onDelete(r).catch(fail)}><Trash2 /></Button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      {edit && (
        <Panel className="mt-3 grid gap-3 p-4" data-testid={`${testid}-form`}>
          <div className="text-sm font-semibold">{edit.id ? 'Change' : 'Add'}</div>
          <div className="grid gap-3 md:grid-cols-3">
            {form.map((f) => {
              const v = edit.values[f.key]
              const set = (x: unknown) => setEdit({ ...edit, values: { ...edit.values, [f.key]: x } })
              return (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  {f.type === 'select' ? (
                    <select className={sel} value={String(v ?? '')} onChange={(e) => set(e.target.value)} aria-label={f.label} data-testid={`${testid}-f-${f.key}`}>
                      {!f.options?.some((o) => o.value === '') && <option value="">(choose)</option>}
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : f.type === 'bool' ? (
                    <label className="flex h-8 items-center gap-2 text-sm"><input type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked)} data-testid={`${testid}-f-${f.key}`} /> Yes</label>
                  ) : (
                    <Input className="h-8 max-md:h-11" type={f.type === 'date' ? 'date' : 'text'} value={String(v ?? '')} onChange={(e) => set(e.target.value)} aria-label={f.label} data-testid={`${testid}-f-${f.key}`} />
                  )}
                </Field>
              )
            })}
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save()} data-testid={`${testid}-save`}>Save</Button>
            <Button size="sm" variant="outline" onClick={() => setEdit(null)}>Cancel</Button>
          </div>
        </Panel>
      )}
    </div>
  )
}
