import { useEffect, useState } from 'react'
import { Key, Lock, Plus, Rows3, Trash2, X } from 'lucide-react'
import { platform, usePlatform, type ColumnDef, type ColumnType, type TableDef } from '@/platform'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog, Empty, Field, Panel, slugName, useToast } from './kit'
import { TYPE_INFO } from './columnTypes'
import { TypeSelect } from './Tables'

type Mode = { kind: 'new' } | { kind: 'edit'; name: string }

function ColumnEditor({ table, mode, onClose }: { table: TableDef; mode: Mode; onClose(): void }) {
  const tables = usePlatform((s) => s.tables)
  const { fail, toast } = useToast()
  const existing = mode.kind === 'edit' ? table.columns.find((c) => c.name === mode.name) : undefined
  const [displayName, setDisplayName] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [type, setType] = useState<ColumnType>('text')
  const [required, setRequired] = useState(false)
  const [unique, setUnique] = useState(false)
  const [indexed, setIndexed] = useState(false)
  const [def, setDef] = useState('')
  const [choices, setChoices] = useState<string[]>([])
  const [newChoice, setNewChoice] = useState('')
  const [lookupTable, setLookupTable] = useState('')
  const [prefix, setPrefix] = useState('')
  const [multiple, setMultiple] = useState(false)
  const [accept, setAccept] = useState('')
  const [maxSize, setMaxSize] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const c = existing
    setDisplayName(c?.displayName ?? '')
    setName(c?.name ?? '')
    setNameTouched(false)
    setType(c?.type ?? 'text')
    setRequired(!!c?.required)
    setUnique(!!c?.unique)
    setIndexed(!!c?.indexed)
    setDef(c?.default ?? '')
    setChoices(c?.choices ?? [])
    setNewChoice('')
    setLookupTable(c?.lookupTable ?? '')
    setPrefix(c?.prefix ?? '')
    setMultiple(!!c?.multiple)
    setAccept((c?.accept ?? []).join(', '))
    setMaxSize(c?.maxSizeMB ? String(c.maxSizeMB) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.kind, mode.kind === 'edit' ? mode.name : '', table.id])

  // system columns, and the platform's own columns of a system table (core data model), cannot be changed
  const locked = !!existing?.system || !!existing?.locked
  const finalName = mode.kind === 'edit' ? mode.name : nameTouched ? name : slugName(displayName)
  const nameClash = mode.kind === 'new' && !!finalName && table.columns.some((c) => c.name.toLowerCase() === finalName.toLowerCase())
  const attach = type === 'file' || type === 'image'
  // a Query v2 index (server mode, PostgreSQL): long text and attachments can't be indexed; lookups and unique columns always are
  const server = usePlatform((s) => s.mode) === 'server'
  const indexable = server && !attach && type !== 'multiline'
  const maxOk = !maxSize.trim() || (Number.isFinite(Number(maxSize)) && Number(maxSize) > 0)
  const valid = !!displayName.trim() && !!finalName && !nameClash && maxOk && (type !== 'lookup' || !!lookupTable) && (type !== 'choice' || choices.length > 0 || !!newChoice.trim())

  const addChoice = () => {
    const t = newChoice.trim()
    if (!t) return
    if (!choices.includes(t)) setChoices([...choices, t])
    setNewChoice('')
  }

  const save = async () => {
    setBusy(true)
    try {
      const finalChoices = type === 'choice' ? (newChoice.trim() && !choices.includes(newChoice.trim()) ? [...choices, newChoice.trim()] : choices) : undefined
      const body: Partial<ColumnDef> = {
        displayName: displayName.trim(),
        type,
        required,
        unique,
        indexed: indexable ? indexed : undefined,
        default: def.trim() || undefined,
        choices: finalChoices,
        lookupTable: type === 'lookup' ? lookupTable : undefined,
        prefix: type === 'autonumber' ? prefix : undefined,
        multiple: attach ? multiple : undefined,
        accept: attach ? accept.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) : undefined,
        maxSizeMB: attach && maxSize.trim() ? Number(maxSize) : undefined,
      }
      if (mode.kind === 'new') {
        await platform.tables.addColumn(table.id, { ...body, name: finalName, displayName: displayName.trim(), type })
        toast(`Added column "${displayName.trim()}"`, 'success')
      } else {
        await platform.tables.updateColumn(table.id, mode.name, body)
        toast('Column updated', 'success')
      }
      onClose()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const otherTables = tables

  return (
    <Panel className="flex h-full flex-col" data-testid="column-editor">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="text-sm font-semibold">{mode.kind === 'new' ? 'New column' : locked ? 'System column' : 'Edit column'}</div>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} aria-label="Close panel"><X /></Button>
      </div>
      <form className="grid flex-1 content-start gap-4 overflow-auto p-4" onSubmit={(e) => { e.preventDefault(); if (valid && !locked) void save() }}>
        {locked && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{existing?.locked ? 'This column belongs to a system table: the platform manages its definition, so it cannot be changed or removed.' : 'System columns are managed by the platform and cannot be changed or removed.'}</p>}
        <Field label="Display name" htmlFor="col-display">
          <Input id="col-display" autoFocus={mode.kind === 'new'} disabled={locked} value={displayName} onChange={(e) => setDisplayName(e.target.value)} data-testid="col-display-name" placeholder="e.g. Due date" />
        </Field>
        <Field label="Name" htmlFor="col-name" hint={mode.kind === 'edit' ? 'The name is used in formulas and cannot be changed.' : 'Used in formulas and as the CSV header. Generated from the display name.'}>
          <Input id="col-name" className="font-mono text-xs" disabled={mode.kind === 'edit'} value={finalName} onChange={(e) => { setNameTouched(true); setName(e.target.value.replace(/[^A-Za-z0-9_]/g, '')) }} data-testid="col-name" />
          {nameClash && <p className="text-xs text-destructive">A column with this name already exists.</p>}
        </Field>
        <Field label="Type">
          <TypeSelect value={type} onChange={setType} disabled={locked} />
          {mode.kind === 'edit' && !locked && existing && type !== existing.type && <p className="text-xs text-muted-foreground">Existing values are converted to the new type where possible.</p>}
        </Field>

        {type === 'choice' && (
          <div className="grid gap-1.5">
            <Label className="text-xs font-medium">Choices</Label>
            <div className="grid gap-1" data-testid="choices-editor">
              {choices.map((c, i) => (
                <div key={c + i} className="flex items-center gap-1.5">
                  <Input className="h-8" aria-label={`Choice ${i + 1}`} disabled={locked} value={c} onChange={(e) => setChoices(choices.map((x, j) => (j === i ? e.target.value : x)))} />
                  <Button type="button" variant="ghost" size="icon-sm" disabled={locked} aria-label={`Remove choice ${c}`} onClick={() => setChoices(choices.filter((_, j) => j !== i))}><X /></Button>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <Input className="h-8" disabled={locked} placeholder="Add a choice and press Enter" value={newChoice} onChange={(e) => setNewChoice(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChoice() } }} data-testid="choice-input" />
                <Button type="button" variant="outline" size="icon-sm" disabled={locked} aria-label="Add choice" onClick={addChoice}><Plus /></Button>
              </div>
            </div>
          </div>
        )}
        {type === 'lookup' && (
          <Field label="Look up rows from" hint="The cell stores the id of the selected row; its primary column is shown.">
            <Select value={lookupTable} onValueChange={setLookupTable} disabled={locked}>
              <SelectTrigger className="w-full" size="sm" data-testid="lookup-table"><SelectValue placeholder="Choose a table" /></SelectTrigger>
              <SelectContent>{otherTables.map((t) => <SelectItem key={t.id} value={t.name}>{t.displayName}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
        {type === 'autonumber' && (
          <Field label="Prefix" hint='For example "INV-" produces INV-0001, INV-0002...'>
            <Input value={prefix} disabled={locked} onChange={(e) => setPrefix(e.target.value)} data-testid="col-prefix" />
          </Field>
        )}
        {attach && (
          <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3" data-testid="attachment-options">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Allow several files<span className="block text-xs text-muted-foreground">Each row can hold a list of attachments.</span></span>
              <Switch checked={multiple} disabled={locked} onCheckedChange={setMultiple} aria-label="Allow several files" data-testid="col-multiple" />
            </label>
            <Field label="Accepted types" hint={<>Comma-separated MIME patterns, e.g. <code className="font-mono">image/*, application/pdf</code>. Empty accepts anything.</>}>
              <Input value={accept} disabled={locked} onChange={(e) => setAccept(e.target.value)} placeholder={type === 'image' ? 'image/*' : 'any type'} data-testid="col-accept" className="font-mono text-xs" />
              <div className="flex flex-wrap gap-1">
                {[['Images', 'image/*'], ['PDF', 'application/pdf'], ['Office', 'application/vnd.openxmlformats-officedocument.*, application/msword'], ['Text', 'text/*']].map(([l, v]) => (
                  <Button key={l} type="button" variant="outline" size="xs" disabled={locked} onClick={() => setAccept(v)}>{l}</Button>
                ))}
              </div>
            </Field>
            <Field label="Largest file (MB)" hint="Leave empty for the server default (25 MB).">
              <Input value={maxSize} disabled={locked} inputMode="decimal" onChange={(e) => setMaxSize(e.target.value.replace(/[^0-9.]/g, ''))} data-testid="col-max-size" className="w-32" />
              {!maxOk && <p className="text-xs text-destructive">Enter a number above zero.</p>}
            </Field>
          </div>
        )}
        {type !== 'autonumber' && !attach && (
          <Field label="Default value" hint={type === 'boolean' ? 'Use true or false.' : type === 'choice' ? 'Must be one of the choices.' : undefined}>
            <Input value={def} disabled={locked} onChange={(e) => setDef(e.target.value)} data-testid="col-default" />
          </Field>
        )}
        <div className="grid gap-2.5">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Required<span className="block text-xs text-muted-foreground">A row cannot be saved without a value.</span></span>
            <Switch checked={required} disabled={locked} onCheckedChange={setRequired} data-testid="col-required" aria-label="Required" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Unique<span className="block text-xs text-muted-foreground">No two rows may share a value.</span></span>
            <Switch checked={unique} disabled={locked} onCheckedChange={setUnique} data-testid="col-unique" aria-label="Unique" />
          </label>
          {indexable && (
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Indexed<span className="block text-xs text-muted-foreground">{type === 'lookup' || unique ? 'Always indexed. Turn on to also make descending sorts and text search fast.' : 'Keeps filtering, sorting and searching by this column fast on large tables. Adds a little work to every save.'}</span></span>
              <Switch checked={indexed} disabled={locked} onCheckedChange={setIndexed} data-testid="col-indexed" aria-label="Indexed" />
            </label>
          )}
        </div>
        <button type="submit" className="sr-only" tabIndex={-1}>Save</button>
      </form>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="outline" size="sm" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</Button>
        {!locked && <Button size="sm" disabled={busy || !valid} onClick={() => void save()} data-testid="col-save">{mode.kind === 'new' ? 'Add column' : 'Save changes'}</Button>}
      </div>
    </Panel>
  )
}

export function ColumnsPanel({ table }: { table: TableDef }) {
  const { toast } = useToast()
  const [mode, setMode] = useState<Mode | null>(null)
  const [del, setDel] = useState<ColumnDef | null>(null)
  // server mode, a table that existed before it was linked: removing a column only unmaps it
  const linkedTable = usePlatform((st) => st.mode === 'server') && table.managed !== true && table.origin?.kind !== 'file'

  useEffect(() => { setMode(null) }, [table.id])
  // close the editor if the column it edits disappears
  useEffect(() => {
    if (mode?.kind === 'edit' && !table.columns.some((c) => c.name === mode.name)) setMode(null)
  }, [table, mode])

  return (
    <div className={cn('grid gap-4', mode ? 'grid-cols-[minmax(0,1fr)_380px]' : 'grid-cols-1')} data-testid="columns-tab">
      <div className="min-w-0">
        <div className="mb-3 flex items-center">
          <p className="text-sm text-muted-foreground">{table.columns.filter((c) => !c.system).length} columns · {table.system ? (table.extensible && !table.readOnly ? 'the platform columns of this system table are locked; you can add your own' : 'a system table: its columns are managed by the platform') : 'system columns are locked'}</p>
          {(!table.system || (table.extensible && !table.readOnly)) && <Button size="sm" className="ml-auto" onClick={() => setMode({ kind: 'new' })} data-testid="add-column-button"><Plus /> New column</Button>}
        </div>
        {table.columns.length === 0 ? (
          <Empty icon={Rows3} title="No columns" description="Add a column to define what this table stores." />
        ) : (
          <Panel className="overflow-hidden">
            <ul data-testid="column-list" role="list">
              {table.columns.map((c) => {
                const I = TYPE_INFO[c.type]?.icon ?? Key
                const selected = mode?.kind === 'edit' && mode.name === c.name
                return (
                  <li key={c.name} className={cn('group flex items-center border-b border-border last:border-0', selected ? 'bg-accent/60' : 'hover:bg-accent/30')} data-testid={`column-${c.name}`}>
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left outline-none focus-visible:bg-accent/60" onClick={() => setMode({ kind: 'edit', name: c.name })} aria-label={`Edit column ${c.displayName}`}>
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><I className="size-3.5" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{c.displayName}</span>
                          {c.name === table.primaryColumn && <Badge variant="secondary"><Key /> Primary</Badge>}
                          {c.system && <Badge variant="outline"><Lock /> System</Badge>}
                          {c.required && <Badge variant="outline">Required</Badge>}
                          {c.unique && <Badge variant="outline">Unique</Badge>}
                          {c.indexed && <Badge variant="outline">Indexed</Badge>}
                          {c.computed && <Badge variant="secondary" title={c.computed.kind === 'formula' ? c.computed.formula : `${c.computed.fn} of ${c.computed.table}`}>{c.computed.kind === 'formula' ? 'Formula' : 'Rollup'}</Badge>}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{c.name}{c.type === 'choice' && c.choices?.length ? ` · ${c.choices.join(', ')}` : ''}{c.type === 'lookup' && c.lookupTable ? ` · to ${c.lookupTable}` : ''}{(c.type === 'file' || c.type === 'image') ? `${c.multiple ? ' · several' : ' · one'}${c.accept?.length ? ` · ${c.accept.join(', ')}` : ''}${c.maxSizeMB ? ` · max ${c.maxSizeMB} MB` : ''}` : ''}</span>
                      </span>
                      <span className="w-44 shrink-0 text-xs text-muted-foreground">{TYPE_INFO[c.type]?.label ?? c.type}</span>
                    </button>
                    <div className="w-12 pr-2">
                      {!c.system && (
                        <Button variant="ghost" size="icon-sm" className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Delete column ${c.displayName}`} onClick={() => setDel(c)} data-testid={`delete-column-${c.name}`}>
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Panel>
        )}
      </div>
      {mode && <ColumnEditor table={table} mode={mode} onClose={() => setMode(null)} />}
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete column "${del?.displayName ?? ''}"?`}
        description={linkedTable
          ? 'Appbuilder stops showing and writing this column. This is a linked table, so the column and its values stay in the database. Apps that use it will show errors.'
          : 'The column and all of its values are removed from the table and its CSV file. Apps that use it will show errors.'}
        onConfirm={async () => {
          if (!del) return
          await platform.tables.removeColumn(table.id, del.name)
          toast('Column deleted', 'success')
        }}
      />
    </div>
  )
}
