/**
 * The designer's side panel: the inspector of the selected table (names, display column, area, columns with inline
 * rename / retype / flags / delete, unique pairs, relationships) or relationship (delete behaviour, required parent,
 * cycle prevention), and the model checks (lint).
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Info, Lock, Plus, Trash2, Search as SearchIcon, RefreshCw, GitBranch } from 'lucide-react'
import type { ColumnDef, ColumnType } from '@/platform'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DeleteBehaviour, Model, ModelLayout } from '@/model/types'
import { AREA_COLORS, DELETE_BEHAVIOURS, DELETE_BEHAVIOUR_LABEL, isSystemTable } from '@/model/types'
import { isSystemColumn, tableById, tableByName, userColumns } from '@/model/ops'
import type { LintFinding } from '@/model/lint'
import { shortHex } from '@/model/names'
import { TypeSelect } from '../Tables'
import { Field } from '../kit'

const FLAG: { key: 'required' | 'unique' | 'indexed'; label: string; title: string }[] = [
  { key: 'required', label: 'R', title: 'Required' },
  { key: 'unique', label: 'U', title: 'Unique' },
  { key: 'indexed', label: 'IX', title: 'Indexed (fast filters and sorting on large tables)' },
]

export interface InspectorActions {
  updateTable(id: string, patch: { displayName?: string; description?: string; primaryColumn?: string; uniqueTogether?: string[][] }): void
  removeTable(id: string): void
  addColumn(table: string, col: Partial<ColumnDef>): void
  updateColumn(table: string, name: string, patch: Partial<ColumnDef>): void
  removeColumn(table: string, name: string): void
  updateRelationship(id: string, patch: { onDelete?: DeleteBehaviour; required?: boolean; preventCycles?: boolean }): void
  removeRelationship(id: string): void
  setArea(table: string, area: string | null, newArea?: { name: string; color: string }): void
  select(kind: 'table' | 'relationship', id: string): void
  openTable(id: string): void
}

export function TableInspector({ model, layout, id, readOnly, live, a }: { model: Model; layout: ModelLayout; id: string; readOnly: boolean; live: boolean; a: InspectorActions }) {
  const t = tableById(model, id)
  const [newArea, setNewArea] = useState('')
  if (!t) return <p className="p-3 text-sm text-muted-foreground">Select a table or a relationship.</p>
  const sys = isSystemTable(t)
  const view = t.reporting?.kind === 'view'
  const locked = readOnly || view
  const canAdd = !readOnly && !view && (!sys || !!(t as { extensible?: boolean }).extensible)
  const cols = userColumns(t)
  const area = layout.areas.find((x) => x.tables.includes(t.id))
  const rels = model.relationships.filter((r) => r.fromTable === t.id || r.toTable === t.id)
  const lookups = cols.filter((c) => c.type === 'lookup')
  const tablesForLookup = model.tables.filter((x) => x.reporting?.kind !== 'view')
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3 text-sm" data-testid="table-inspector" data-table={t.name}>
      <div className="flex items-center gap-2">
        <span className="truncate text-base font-semibold">{t.displayName}</span>
        {sys && <Badge variant="secondary"><Lock className="mr-1 size-3" />System</Badge>}
        {view && <Badge variant="secondary">Reporting view</Badge>}
        {t.reporting?.kind === 'summary' && <Badge variant="secondary">Summary</Badge>}
        {t.reporting?.kind === 'date' && <Badge variant="secondary">Date dimension</Badge>}
        {!live && <Badge className="bg-emerald-600">New</Badge>}
      </div>
      {view && t.reporting?.kind === 'view' && (
        <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
          Read-only view over <b>{tableById(model, t.reporting.base)?.displayName ?? 'its source'}</b>. Every reader sees only the rows and columns they may see there. To change it, remove it and generate it again.
        </p>
      )}
      {sys && <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">A system table of every environment. Its columns are fixed{canAdd ? '; you may add your own' : ''}.</p>}
      <Field label="Display name" htmlFor="insp-display">
        <Input id="insp-display" value={t.displayName} disabled={locked || sys} onChange={(e) => a.updateTable(t.id, { displayName: e.target.value })} data-testid="insp-display-name" />
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Field label="Name (in formulas)"><Input value={t.name} disabled className="font-mono text-xs" /></Field>
        <Field label="Display column">
          <Select value={t.primaryColumn} onValueChange={(v) => a.updateTable(t.id, { primaryColumn: v })} disabled={locked || sys}>
            <SelectTrigger size="sm" className="w-full" data-testid="insp-primary"><SelectValue /></SelectTrigger>
            <SelectContent>{cols.map((c) => <SelectItem key={c.name} value={c.name}>{c.displayName}</SelectItem>)}<SelectItem value="id">Id</SelectItem></SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Description">
        <Input value={t.description ?? ''} disabled={locked || sys} onChange={(e) => a.updateTable(t.id, { description: e.target.value })} placeholder="What one row is" />
      </Field>
      <Field label="Area">
        <div className="flex gap-2">
          <Select value={area?.id ?? '__none'} onValueChange={(v) => a.setArea(t.id, v === '__none' ? null : v)} disabled={readOnly}>
            <SelectTrigger size="sm" className="w-full" data-testid="insp-area"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">No area</SelectItem>
              {layout.areas.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input value={newArea} disabled={readOnly} onChange={(e) => setNewArea(e.target.value)} placeholder="New area" className="h-8 w-32" data-testid="insp-new-area"
            onKeyDown={(e) => { if (e.key === 'Enter' && newArea.trim()) { a.setArea(t.id, null, { name: newArea.trim(), color: AREA_COLORS[layout.areas.length % AREA_COLORS.length] }); setNewArea('') } }} />
        </div>
      </Field>

      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Columns ({cols.length})</span>
        {canAdd && <Button size="xs" variant="outline" onClick={() => a.addColumn(t.id, { displayName: 'New column', type: 'text' })} data-testid="insp-add-column"><Plus />Column</Button>}
      </div>
      <div className="grid gap-1.5">
        {cols.map((c) => {
          const fixed = locked || c.locked || isSystemColumn(c) || (sys && !!c.locked)
          return (
            <div key={c.name} className="grid gap-1 rounded-md border p-1.5" data-testid={`insp-col-${c.name}`}>
              <div className="flex items-center gap-1">
                <Input value={c.displayName} disabled={fixed} onChange={(e) => a.updateColumn(t.id, c.name, { displayName: e.target.value })} className="h-7 flex-1 text-xs" aria-label="Column display name" />
                {!fixed && <button type="button" aria-label={`Remove ${c.displayName}`} className="rounded p-1 text-muted-foreground hover:text-destructive" onClick={() => a.removeColumn(t.id, c.name)}><Trash2 className="size-3.5" /></button>}
              </div>
              <div className="flex items-center gap-1">
                <TypeSelect value={c.type} onChange={(v: ColumnType) => a.updateColumn(t.id, c.name, { type: v, ...(v === 'lookup' ? { lookupTable: tablesForLookup.find((x) => x.id !== t.id)?.name ?? t.name } : {}) })} disabled={fixed || !!c.computed} className="h-7 min-w-0 flex-1" />
                {FLAG.map((f) => (
                  <button key={f.key} type="button" title={f.title} disabled={fixed || !!c.computed}
                    className={cn('h-7 rounded border px-1.5 text-[10px] font-semibold', c[f.key] ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground', (fixed || c.computed) && 'opacity-50')}
                    onClick={() => a.updateColumn(t.id, c.name, { [f.key]: !c[f.key] || undefined })} data-testid={`flag-${c.name}-${f.key}`}>{f.label}</button>
                ))}
              </div>
              {c.type === 'lookup' && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ArrowRight className="size-3" />
                  <Select value={tableByName(model, c.lookupTable)?.name ?? ''} onValueChange={(v) => a.updateColumn(t.id, c.name, { lookupTable: v })} disabled={fixed}>
                    <SelectTrigger size="sm" className="h-7 min-w-0 flex-1"><SelectValue placeholder="Target table" /></SelectTrigger>
                    <SelectContent>{tablesForLookup.map((x) => <SelectItem key={x.id} value={x.name}>{x.displayName}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
              {c.type === 'choice' && (
                <Input value={(c.choices ?? []).join(', ')} disabled={fixed} onChange={(e) => a.updateColumn(t.id, c.name, { choices: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} className="h-7 text-xs" placeholder="Choices, separated by commas" />
              )}
              {c.computed && <span className="text-[11px] text-muted-foreground">{c.computed.kind === 'formula' ? `Formula: ${c.computed.formula}` : `Rollup: ${c.computed.fn} of ${c.computed.table}.${c.computed.column ?? '*'}`}</span>}
            </div>
          )
        })}
      </div>

      {lookups.length >= 2 && !locked && (
        <div className="grid gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unique together</span>
          {(t.uniqueTogether ?? []).map((set, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="flex-1">{set.join(' + ')}</span>
              <button type="button" className="text-muted-foreground hover:text-destructive" aria-label="Remove unique pair" onClick={() => a.updateTable(t.id, { uniqueTogether: (t.uniqueTogether ?? []).filter((_, j) => j !== i) })}><Trash2 className="size-3.5" /></button>
            </div>
          ))}
          {!(t.uniqueTogether ?? []).some((s) => lookups.slice(0, 2).every((l) => s.includes(l.name))) && (
            <Button size="xs" variant="outline" className="w-fit" onClick={() => a.updateTable(t.id, { uniqueTogether: [...(t.uniqueTogether ?? []), lookups.slice(0, 2).map((l) => l.name)] })}>
              Make {lookups.slice(0, 2).map((l) => l.displayName).join(' + ')} unique together
            </Button>
          )}
        </div>
      )}

      {rels.length > 0 && (
        <div className="grid gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Relationships</span>
          {rels.map((r) => (
            <button key={r.id} type="button" className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent" onClick={() => a.select('relationship', r.id)}>
              <GitBranch className="size-3 text-muted-foreground" />
              <span className="truncate">{tableById(model, r.fromTable)?.displayName}.{tableById(model, r.fromTable)?.columns.find((c) => c.name === r.fromColumn)?.displayName ?? r.fromColumn} → {tableById(model, r.toTable)?.displayName}</span>
              <span className="ml-auto text-muted-foreground">{r.onDelete === 'setBlank' ? 'set blank' : r.onDelete}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {live && !view && <Button size="xs" variant="outline" onClick={() => a.openTable(t.id)}>Open in table designer</Button>}
        {!readOnly && !sys && <Button size="xs" variant="outline" className="text-destructive" onClick={() => a.removeTable(t.id)} data-testid="insp-remove-table"><Trash2 />Remove table</Button>}
      </div>
    </div>
  )
}

export function RelationshipInspector({ model, id, readOnly, a }: { model: Model; id: string; readOnly: boolean; a: InspectorActions }) {
  const r = model.relationships.find((x) => x.id === id)
  if (!r) return <p className="p-3 text-sm text-muted-foreground">Select a table or a relationship.</p>
  const child = tableById(model, r.fromTable)
  const parent = tableById(model, r.toTable)
  const col = child?.columns.find((c) => c.name === r.fromColumn)
  const fixed = readOnly || !!col?.locked || (child ? isSystemTable(child) && !!col?.locked : false) || child?.reporting?.kind === 'view'
  const kind = r.junction ? 'Many-to-many (one side of a junction table)' : r.kind === 'oneToOne' ? 'One-to-one (unique lookup)' : r.kind === 'self' ? 'Hierarchy (self relationship)' : 'One-to-many'
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3 text-sm" data-testid="relationship-inspector">
      <div className="font-semibold">{parent?.displayName} <span className="text-muted-foreground">→</span> {child?.displayName}</div>
      <p className="text-xs text-muted-foreground">{kind}. Each {child?.displayName} row points at {col?.required ? 'one' : 'at most one'} {parent?.displayName} row through <b>{col?.displayName ?? r.fromColumn}</b>.</p>
      <Field label="When a parent row is deleted">
        <Select value={r.onDelete} onValueChange={(v) => a.updateRelationship(r.id, { onDelete: v as DeleteBehaviour })} disabled={fixed}>
          <SelectTrigger size="sm" className="w-full" data-testid="rel-on-delete"><SelectValue /></SelectTrigger>
          <SelectContent>{DELETE_BEHAVIOURS.map((d) => <SelectItem key={d} value={d} disabled={d === 'setBlank' && !!col?.required}>{DELETE_BEHAVIOUR_LABEL[d]}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <p className="text-xs text-muted-foreground">
        {r.onDelete === 'restrict' && `A ${parent?.displayName} row cannot be deleted while ${child?.displayName} rows point at it.`}
        {r.onDelete === 'cascade' && `Its ${child?.displayName} rows are deleted too, with the permissions of the person deleting (all or nothing).`}
        {r.onDelete === 'setBlank' && `Its ${child?.displayName} rows stay, with ${col?.displayName ?? r.fromColumn} cleared.`}
      </p>
      {r.kind !== 'self' && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={!!col?.required} disabled={fixed} onCheckedChange={(v) => a.updateRelationship(r.id, { required: v === true })} data-testid="rel-required" />
          Required parent (every {child?.displayName} row must have one)
        </label>
      )}
      {r.kind === 'self' && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={!!r.preventCycles} disabled={fixed} onCheckedChange={(v) => a.updateRelationship(r.id, { preventCycles: v === true })} />
          Prevent loops (a row cannot become its own ancestor)
        </label>
      )}
      {!fixed && <Button size="xs" variant="outline" className="w-fit text-destructive" onClick={() => a.removeRelationship(r.id)} data-testid="rel-remove"><Trash2 />Remove relationship{r.junction ? ' (and junction table)' : ' (and its lookup column)'}</Button>}
    </div>
  )
}

export function ChecksPanel({ findings, onFocus, onCheckData, checking }: { findings: LintFinding[]; onFocus(table: string): void; onCheckData(): void; checking: boolean }) {
  const sorted = useMemo(() => [...findings].sort((x, y) => (x.level === y.level ? 0 : x.level === 'warning' ? -1 : 1)), [findings])
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2 p-3 text-sm" data-testid="model-checks">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{findings.filter((f) => f.level === 'warning').length} warnings, {findings.filter((f) => f.level === 'info').length} notes</span>
        <Button size="xs" variant="outline" className="ml-auto" onClick={onCheckData} disabled={checking}><RefreshCw className={cn(checking && 'animate-spin')} />Check data</Button>
      </div>
      {!sorted.length && <p className="text-muted-foreground">No findings. The model looks consistent.</p>}
      {sorted.map((f, i) => (
        <button key={`${f.code}-${f.table ?? ''}-${f.column ?? ''}-${i}`} type="button" disabled={!f.table} onClick={() => f.table && onFocus(f.table)}
          className="grid gap-0.5 rounded-md border p-2 text-left text-xs hover:bg-accent disabled:hover:bg-transparent" data-testid={`finding-${f.code}`}>
          <span className="flex items-start gap-1.5">
            {f.level === 'warning' ? <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-500" /> : <Info className="mt-px size-3.5 shrink-0 text-sky-500" />}
            <span>{f.message}</span>
            {f.table && <SearchIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />}
          </span>
          {f.fix && <span className="pl-5 text-muted-foreground">{f.fix}</span>}
        </button>
      ))}
    </div>
  )
}

export const newAreaId = () => `area_${shortHex(8)}`
