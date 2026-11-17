import { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardList } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord, FxValue } from '@/contracts'
import { platform, usePlatform } from '@/platform'
import type { ColumnDef, TableDef } from '@/platform/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { AttachmentCell } from '@/runtime/AttachmentCell'
import { attachmentIds, registerFiles } from '@/runtime/attachments'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { isRecord, toBool, toNum, toText } from '../util'
import { Shell, formatDate, startOfDay, useDefaultApply, useFocusToken } from './shared'
import { DatePopover } from './DatePopover'
import { AttachmentField } from './AttachmentField'
import {
  type FieldVal,
  type FormModeName,
  type FormValues,
  type LookupOption,
  initialValues,
  isFileType,
  itemKey,
  parseFormMode,
  serializeValues,
  toFxValue,
  validateField,
  visibleColumns,
} from './formSchema'

/* ------------------------------------------------------------------ platform access (never throws) */

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** Re-render when schemas or rows change. The hook calls are unconditional; a missing platform just yields 0. */
function useWorkspaceVersion(): number {
  let v = 0
  try {
    v += usePlatform((s) => s.dataVersion)
    v += usePlatform((s) => s.tables.length)
    // schema edits replace the TableDef (modifiedOn changes)
    const stamp = usePlatform((s) => s.tables.map((t) => t.modifiedOn).join('|'))
    v += stamp.length
  } catch {
    /* platform not ready */
  }
  return v
}

const NONE = '__none__'

const pendingSig = (p: Record<string, File[]>) =>
  Object.keys(p)
    .sort()
    .map((k) => k + ':' + p[k].map((f) => `${f.name}/${f.size}/${f.lastModified}`).join(','))
    .join(';')

/** the file/image cells of a value set (attachment ids as text) */
function fileCells(cols: ColumnDef[], v: FormValues): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of cols) if (isFileType(c.type)) out[c.name] = typeof v[c.name] === 'string' ? (v[c.name] as string) : ''
  return out
}

/* ------------------------------------------------------------------ field editors */

interface FieldProps {
  col: ColumnDef
  id: string
  value: FieldVal
  onChange(v: FieldVal): void
  onBlur(): void
  invalid: boolean
  lookups: LookupOption[]
}

function FieldEditor({ col, id, value, onChange, onBlur, invalid, lookups }: FieldProps) {
  const err = invalid ? 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20' : ''
  const str = typeof value === 'string' ? value : ''
  switch (col.type) {
    case 'multiline':
      return <Textarea id={id} value={str} rows={3} className={cn('min-h-20', err)} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} aria-invalid={invalid || undefined} />
    case 'boolean':
      return (
        <div className="flex h-9 items-center">
          <Switch id={id} checked={value === true} onCheckedChange={(c) => onChange(c)} onBlur={onBlur} />
        </div>
      )
    case 'date':
      return (
        <div className="h-9">
          <DatePopover id={id} value={value instanceof Date ? value : null} clearable invalid={invalid} placeholder="Pick a date" onChange={onChange} onBlur={onBlur} />
        </div>
      )
    case 'datetime': {
      const d = value instanceof Date ? value : null
      const pad = (n: number) => String(n).padStart(2, '0')
      return (
        <div className="flex h-9 gap-2">
          <div className="min-w-0 flex-1">
            <DatePopover
              id={id}
              value={d}
              clearable
              invalid={invalid}
              placeholder="Pick a date"
              onChange={(nd) => onChange(nd ? new Date(nd.getFullYear(), nd.getMonth(), nd.getDate(), d?.getHours() ?? 0, d?.getMinutes() ?? 0) : null)}
              onBlur={onBlur}
            />
          </div>
          <Input
            type="time"
            aria-label={`${col.displayName} time`}
            className={cn('w-28 shrink-0', err)}
            value={d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''}
            onChange={(e) => {
              const m = /^(\d{2}):(\d{2})/.exec(e.target.value)
              if (!m) return
              const base = d ?? startOfDay(new Date())
              onChange(new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(m[1]), Number(m[2])))
            }}
            onBlur={onBlur}
          />
        </div>
      )
    }
    case 'choice':
    case 'lookup': {
      const options: LookupOption[] = col.type === 'choice' ? (col.choices ?? []).map((c) => ({ id: c, label: c })) : lookups
      return (
        <Select
          value={str === '' ? undefined : str}
          onValueChange={(v) => {
            onChange(v === NONE ? '' : v)
            onBlur()
          }}
        >
          <SelectTrigger id={id} className={cn('h-9 w-full', err)} aria-invalid={invalid || undefined}>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {!col.required && str !== '' && <SelectItem value={NONE}>(none)</SelectItem>}
            {options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label === '' ? ' ' : o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }
    case 'autonumber':
      return <Input id={id} value={str} readOnly disabled className="h-9" placeholder="Assigned on save" />
    case 'email':
      return <Input id={id} type="email" value={str} className={cn('h-9', err)} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} aria-invalid={invalid || undefined} />
    case 'url':
      return <Input id={id} type="url" value={str} className={cn('h-9', err)} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} aria-invalid={invalid || undefined} />
    case 'phone':
      return <Input id={id} type="tel" value={str} className={cn('h-9', err)} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} aria-invalid={invalid || undefined} />
    case 'number':
    case 'decimal':
    case 'currency':
      return (
        <Input
          id={id}
          type="text"
          inputMode={col.type === 'number' ? 'numeric' : 'decimal'}
          value={str}
          className={cn('h-9 text-right', err)}
          onChange={(e) => {
            const t = e.target.value
            if (/^-?\d*\.?\d*$/.test(t)) onChange(t)
          }}
          onBlur={onBlur}
          aria-invalid={invalid || undefined}
        />
      )
    default:
      return <Input id={id} type="text" value={str} className={cn('h-9', err)} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} aria-invalid={invalid || undefined} />
  }
}

/** Read-only rendering of a value (View mode). */
function displayValue(col: ColumnDef, v: FieldVal | undefined, lookups: LookupOption[]): string {
  if (col.type === 'boolean') return v === true ? 'Yes' : 'No'
  if (v instanceof Date) {
    const d = formatDate(v, 'yyyy-mm-dd')
    return col.type === 'datetime' ? `${d} ${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(2, '0')}` : d
  }
  const s = typeof v === 'string' ? v : ''
  if (col.type === 'lookup') return lookups.find((o) => o.id === s)?.label ?? s
  return s
}

/* ------------------------------------------------------------------ the form */

function FormRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const version = useWorkspaceVersion()
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const uid = useRef(Math.random().toString(36).slice(2, 8)).current

  /* ---- schema ---- */
  const dsName = toText(props.DataSource).trim()
  const table: TableDef | undefined = useMemo(
    () => (dsName === '' ? undefined : safe(() => platform.tables.get(dsName), undefined)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dsName, version],
  )

  /* ---- mode: the Mode output is authoritative once the runtime (NewForm/EditForm/ViewForm) writes it ---- */
  const modeProp = parseFormMode(props.Mode)
  useDefaultApply(modeProp, toText(outputs.Mode).trim() === '', () => setOutput('Mode', modeProp))
  const formMode: FormModeName = toText(outputs.Mode).trim() === '' ? modeProp : parseFormMode(outputs.Mode)

  const fieldsProp = toText(props.Fields)
  const cols = useMemo(() => (table ? visibleColumns(table, fieldsProp, formMode) : []), [table, fieldsProp, formMode])
  const colsKey = cols.map((c) => `${c.name}:${c.type}`).join(',')

  const item: FxRecord | null = isRecord(props.Item) ? props.Item : null
  const iKey = itemKey(item)

  /* ---- lookup options ---- */
  const lookups = useMemo(() => {
    const out: Record<string, LookupOption[]> = {}
    for (const c of cols) {
      if (c.type !== 'lookup' || !c.lookupTable) continue
      out[c.name] = safe(() => {
        const t = platform.tables.get(c.lookupTable as string)
        const primary = t?.primaryColumn ?? 'id'
        return platform.tables.rows(c.lookupTable as string).map((r) => {
          const id = toText(r.__id ?? r.id)
          const label = toText(r[primary])
          return { id, label: label === '' ? id : label }
        })
      }, [] as LookupOption[])
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colsKey, version])

  /* ---- values (reload on Item / table / mode / reset) ---- */
  const resetToken = toNum(outputs.__reset, 0)
  const loadKey = [dsName, formMode, iKey, resetToken, colsKey].join('\u0002')
  const [loaded, setLoaded] = useState(loadKey)
  const [values, setValues] = useState<FormValues>(() => initialValues(cols, formMode, item))
  const [baseline, setBaseline] = useState(() => serializeValues(values))
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [allTouched, setAllTouched] = useState(false)
  /** files chosen for file/image columns, uploaded after the row is saved (originals stay in the registry) */
  const [pending, setPending] = useState<Record<string, File[]>>({})
  /** the file cells as last loaded / saved: Updates only carries a file column that differs from it */
  const [fileBase, setFileBase] = useState<Record<string, string>>(() => fileCells(cols, values))
  if (loaded !== loadKey) {
    const v = initialValues(cols, formMode, item)
    setLoaded(loadKey)
    setValues(v)
    setPending({})
    setFileBase(fileCells(cols, v))
    setBaseline(serializeValues(v))
    setTouched({})
    setAllTouched(false)
  }

  // Runtime asked to show every validation message (SubmitForm with invalid data).
  const touchToken = toNum(outputs.__touch, 0)
  const [seenTouch, setSeenTouch] = useState(touchToken)
  if (seenTouch !== touchToken) {
    setSeenTouch(touchToken)
    setAllTouched(true)
  }
  // Runtime finished a successful submit: current values become the saved baseline.
  const savedToken = toNum(outputs.__saved, 0)
  const [seenSaved, setSeenSaved] = useState(savedToken)
  if (seenSaved !== savedToken) {
    setSeenSaved(savedToken)
    // uploads changed the file cells: take them from the stored row, then the pending files are done
    const last = isRecord(outputs.LastSubmit) ? outputs.LastSubmit : null
    let nextValues = values
    if (last) {
      nextValues = { ...values }
      for (const c of cols) if (isFileType(c.type) && last[c.name] !== undefined) nextValues[c.name] = toText(last[c.name])
      setValues(nextValues)
    }
    setPending({})
    setFileBase(fileCells(cols, nextValues))
    setBaseline(serializeValues(nextValues))
  }

  /* ---- validation + outputs ---- */
  const errors: Record<string, string> = {}
  if (formMode !== 'View') {
    for (const c of cols) {
      if (isFileType(c.type)) {
        const has = attachmentIds(values[c.name]).length > 0 || (pending[c.name]?.length ?? 0) > 0
        if (c.required && !has) errors[c.name] = `${c.displayName || c.name} is required`
        continue
      }
      const m = validateField(c, values[c.name], lookups)
      if (m) errors[c.name] = m
    }
  }
  const errorCount = Object.keys(errors).length
  const valid = errorCount === 0
  const pSig = pendingSig(pending)
  const unsaved = serializeValues(values) !== baseline || pSig !== ''

  const updates = useMemo(() => {
    const rec: FxRecord = {}
    for (const c of cols) {
      if (c.type === 'autonumber') continue
      if (isFileType(c.type)) {
        // new files are uploaded after the row exists (see __files); only removed attachments are written here
        if (formMode === 'New') continue
        const cell = typeof values[c.name] === 'string' ? (values[c.name] as string) : ''
        const replacing = !c.multiple && (pending[c.name]?.length ?? 0) > 0 && attachmentIds(cell).length > 0
        if (replacing) rec[c.name] = null
        else if (cell !== (fileBase[c.name] ?? '')) rec[c.name] = cell === '' ? null : cell
        continue
      }
      rec[c.name] = toFxValue(c, values[c.name])
    }
    return rec
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, values, pSig, fileBase, formMode])

  /* hidden __files output: { column: token } of the File objects to upload after save */
  const tokens = useRef<Record<string, string>>({})
  useEffect(() => {
    if (design) return
    const next: Record<string, string> = {}
    for (const c of cols) {
      if (!isFileType(c.type)) continue
      const t = registerFiles(pending[c.name] ?? [], tokens.current[c.name])
      if (t) next[c.name] = t
    }
    tokens.current = next
    setOutput('__files', next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, pSig, colsKey])
  useEffect(
    () => () => {
      for (const t of Object.values(tokens.current)) registerFiles([], t)
    },
    [],
  )

  const lastOut = useRef('')
  useEffect(() => {
    if (design) return
    const sig = serializeValues(values) + '|' + valid + '|' + unsaved + '|' + colsKey + '|' + pSig + '|' + serializeValues(fileBase as FormValues)
    if (sig === lastOut.current) return
    lastOut.current = sig
    setOutput('Updates', updates)
    setOutput('Valid', valid)
    setOutput('Unsaved', unsaved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, values, valid, unsaved, colsKey, updates, pSig, fileBase])

  /* ---- render ---- */
  const columnsN = Math.min(6, Math.max(1, Math.round(toNum(props.Columns, 2))))
  const showButtons = toBool(props.ShowButtons, true) && formMode !== 'View'
  const lastError = outputs.Error == null ? '' : toText(outputs.Error)
  const busy = toNum(outputs.__busy, 0) > 0
  const editable = !design

  const setField = (name: string, v: FieldVal) => {
    if (!editable) return
    setValues((prev) => ({ ...prev, [name]: v }))
  }

  const save = () => {
    if (!editable || busy) return
    setAllTouched(true)
    if (!valid) {
      const first = cols.find((c) => errors[c.name])
      setOutput('Error', first ? errors[first.name] : 'Fix the highlighted fields')
      fire('OnFailure')
      return
    }
    setOutput('Error', '')
    fire('__submit')
  }

  let body: React.ReactNode
  if (!table) {
    body = (
      <div className="flex size-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        {dsName === '' ? 'Set the DataSource property to a table name.' : `Table "${dsName}" was not found.`}
      </div>
    )
  } else if (cols.length === 0) {
    body = <div className="flex size-full items-center justify-center p-4 text-center text-sm text-muted-foreground">No fields to show.</div>
  } else {
    body = (
      <div className="grid gap-x-4 gap-y-4" style={{ gridTemplateColumns: `repeat(${columnsN}, minmax(0, 1fr))` }}>
        {cols.map((c) => {
          const id = `${uid}-${c.name}`
          const wide = c.type === 'multiline' || columnsN === 1
          const msg = errors[c.name]
          const showMsg = msg && (touched[c.name] || allTouched)
          return (
            <div key={c.name} className="min-w-0 space-y-1.5" style={wide ? { gridColumn: '1 / -1' } : undefined}>
              <Label htmlFor={id} className="text-sm font-medium">
                <span className="truncate">{c.displayName || c.name}</span>
                {c.required && formMode !== 'View' && <span className="text-destructive" aria-hidden="true">*</span>}
              </Label>
              {formMode === 'View' ? (
                <div className="min-h-9 whitespace-pre-wrap rounded-md bg-muted/50 px-3 py-2 text-sm">
                  {isFileType(c.type) && attachmentIds(values[c.name]).length > 0 ? (
                    <AttachmentCell value={values[c.name]} thumb={40} max={6} />
                  ) : (
                    displayValue(c, values[c.name], lookups[c.name] ?? []) || <span className="text-muted-foreground">-</span>
                  )}
                </div>
              ) : isFileType(c.type) ? (
                <AttachmentField
                  col={c}
                  id={id}
                  existing={typeof values[c.name] === 'string' ? (values[c.name] as string) : ''}
                  pending={pending[c.name] ?? []}
                  invalid={Boolean(showMsg)}
                  onExistingChange={(cell) => setField(c.name, cell)}
                  onPendingChange={(files) => editable && setPending((p) => ({ ...p, [c.name]: files }))}
                  onTouch={() => editable && setTouched((t) => (t[c.name] ? t : { ...t, [c.name]: true }))}
                />
              ) : (
                <FieldEditor
                  col={c}
                  id={id}
                  value={values[c.name] ?? (c.type === 'boolean' ? false : '')}
                  lookups={lookups[c.name] ?? []}
                  invalid={Boolean(showMsg)}
                  onChange={(v) => setField(c.name, v)}
                  onBlur={() => editable && setTouched((t) => (t[c.name] ? t : { ...t, [c.name]: true }))}
                />
              )}
              {showMsg && (
                <p className="text-xs text-destructive" role="alert">
                  {msg}
                </p>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <Shell design={design} rootRef={root} className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex size-full flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
        {showButtons && table && (
          <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-3">
            <div className="min-w-0 flex-1 truncate text-xs">
              {lastError !== '' ? (
                <span className="text-destructive" role="alert">{lastError}</span>
              ) : unsaved ? (
                <span className="text-muted-foreground">Unsaved changes</span>
              ) : null}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => editable && fire('OnCancel')}>
              {toText(props.CancelText) || 'Cancel'}
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={busy} data-testid="form-save">
              {busy ? 'Saving...' : toText(props.SubmitText) || 'Save'}
            </Button>
          </div>
        )}
      </div>
    </Shell>
  )
}

const FORM_OUTPUTS: { name: string; initial: FxValue }[] = [
  { name: 'Updates', initial: {} },
  { name: 'Valid', initial: true },
  { name: 'Mode', initial: '' },
  { name: 'LastSubmit', initial: null },
  { name: 'Error', initial: '' },
  { name: 'Unsaved', initial: false },
  // Internal counters the runtime bumps (see report): reload values, show all validation, mark saved.
  { name: '__reset', initial: 0 },
  { name: '__touch', initial: 0 },
  { name: '__saved', initial: 0 },
  // 1 while a submit waits for the server / file uploads; { column: token } of files to upload after save
  { name: '__busy', initial: 0 },
  { name: '__files', initial: {} },
]

export const Form: ControlType = {
  type: 'Form',
  label: 'Form',
  icon: ClipboardList,
  category: 'Data',
  props: [
    { name: 'DataSource', kind: 'tableName', group: 'Data', default: '="Contacts"' },
    { name: 'Item', kind: 'record', group: 'Data', default: '=Blank()' },
    {
      name: 'Mode',
      kind: 'enum',
      group: 'Content',
      default: '=FormMode.Edit',
      options: ['FormMode.Edit', 'FormMode.New', 'FormMode.View'],
    },
    { name: 'Fields', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Columns', kind: 'number', group: 'Layout', default: '=2' },
    { name: 'ShowButtons', label: 'Show buttons', kind: 'boolean', group: 'Content', default: '=true' },
    { name: 'SubmitText', label: 'Save button text', kind: 'text', group: 'Content', default: '="Save"', simple: false },
    { name: 'CancelText', label: 'Cancel button text', kind: 'text', group: 'Content', default: '="Cancel"', simple: false },
    { name: 'OnSuccess', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'OnFailure', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'OnCancel', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: FORM_OUTPUTS,
  defaultSize: { width: 720, height: 420 },
  isContainer: false,
  primaryProp: 'DataSource',
  render: FormRender,
}

