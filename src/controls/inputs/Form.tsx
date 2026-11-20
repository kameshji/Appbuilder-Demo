import { useContext, useEffect, useMemo, useRef, useState } from 'react'
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
import { normalizeNumberText, PHONE_WIDTH } from '@/phone/touch-logic'
import { useDevice } from '@/phone/env'
import { StickyBar } from '@/phone/sheet-bar'
import { useBoxWidth } from '@/phone/touch-hooks'
import { AttachmentField } from './AttachmentField'
import { SignatureField } from './SignatureField'
import { DraftScope, draftKeyOf, draftNote, draftRecordKey, formDrafts, restoreDecision } from '@/phone/drafts'
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
            const t = normalizeNumberText(e.target.value)
            if (t !== null) onChange(t)
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

const isoOf = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? v : null)

function FormRender({ node, props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const version = useWorkspaceVersion()
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const uid = useRef(Math.random().toString(36).slice(2, 8)).current
  // phones: the save bar stays reachable above the on-screen keyboard (src/phone/sheet-bar.tsx)
  const touch = useDevice().touch
  const boxWidth = useBoxWidth(root)
  const stickyBar = touch && !design && boxWidth > 0 && boxWidth < PHONE_WIDTH

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
  /* column-level security (UX mirror of the server): hidden columns are left out, read-only ones are shown but not editable */
  const colAccess = useMemo((): Record<string, string> => {
    if (!table) return {}
    return safe(() => platform.getState().session?.privileges.tables[table.id]?.columns ?? {}, {} as Record<string, string>)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, version])
  // system and calculated (formula / rollup) columns are read-only for everyone
  const accessOf = (c: ColumnDef): string => (c.system || c.computed ? 'read' : (colAccess[c.name] ?? 'update'))
  const cols = useMemo(
    () => (table ? visibleColumns(table, fieldsProp, formMode).filter((c) => (c.system ? 'read' : (colAccess[c.name] ?? 'update')) !== 'none') : []),
    [table, fieldsProp, formMode, colAccess],
  )
  const colsKey = cols.map((c) => `${c.name}:${c.type}`).join(',')
  // image / file columns that are signed instead of uploaded (SignatureField, src/phone/SignatureCanvas.tsx)
  const sigText = toText(props.SignatureFields)
  const sigSet = useMemo(() => new Set(sigText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)), [sigText])

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
  /*
   * Live refresh (package H): an Edit form follows its record by id. When the record changes elsewhere while the form has
   * no unsaved edits, the values simply reload; with unsaved edits the form keeps them and shows the conflict panel
   * ("changed by <name>": reload / keep mine) instead of overwriting them. The version the edits started from
   * (modifiedOn) goes with the save, so a stale save is refused (409) and opens the same panel.
   */
  const itemId = item ? toText(item.__id ?? item.id) : ''
  const followsId = formMode === 'Edit' && itemId !== '' && !!table
  const [reloadToken, setReloadToken] = useState(0)
  const [heldKey, setHeldKey] = useState<string | null>(null)
  const loadKey = [dsName, formMode, followsId ? `id:${itemId}` : iKey, resetToken, colsKey, reloadToken].join('\u0002')
  const [loaded, setLoaded] = useState(loadKey)
  const [contentKey, setContentKey] = useState(iKey)
  const [base, setBase] = useState<FxValue>(() => (item ? (item.modifiedOn ?? null) : null))
  const [conflict, setConflict] = useState<{ by: string | null; version?: string | null } | null>(null)
  const [values, setValues] = useState<FormValues>(() => initialValues(cols, formMode, item))
  const [baseline, setBaseline] = useState(() => serializeValues(values))
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [allTouched, setAllTouched] = useState(false)
  /** files chosen for file/image columns, uploaded after the row is saved (originals stay in the registry) */
  const [pending, setPending] = useState<Record<string, File[]>>({})
  /** the file cells as last loaded / saved: Updates only carries a file column that differs from it */
  const [fileBase, setFileBase] = useState<Record<string, string>>(() => fileCells(cols, values))
  /** "Draft restored ..." (src/phone/drafts.ts); null when nothing was restored */
  const [draftText, setDraftText] = useState<string | null>(null)
  if (loaded !== loadKey) {
    const v = initialValues(cols, formMode, item)
    setDraftText(null)
    setLoaded(loadKey)
    setContentKey(iKey)
    setBase(item ? (item.modifiedOn ?? null) : null)
    setConflict(null)
    setHeldKey(null)
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
    setDraftText(null)
  }

  /* ---- validation + outputs ---- */
  const errors: Record<string, string> = {}
  if (formMode !== 'View') {
    for (const c of cols) {
      if (accessOf(c) !== 'update') continue
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

  // the record changed elsewhere (live refresh or a save from another form)
  if (followsId && iKey !== contentKey && heldKey !== iKey) {
    const mine = toNum(outputs.__busy, 0) > 0 || serializeValues(initialValues(cols, formMode, item)) === serializeValues(values)
    if (mine) {
      // our own save (or the same values): nothing to reload, nothing to resolve
      setContentKey(iKey)
      setBase(item ? (item.modifiedOn ?? null) : null)
    } else if (!unsaved) {
      setContentKey(iKey)
      setReloadToken((n) => n + 1)
    } else {
      setHeldKey(iKey)
      if (!conflict) {
        const by = safe(() => platform.live.lastRowChange(table!.id, itemId)?.by.name ?? null, null)
        setConflict({ by, version: item?.modifiedOn instanceof Date ? item.modifiedOn.toISOString() : null })
      }
    }
  }

  // a live message says someone else changed this record (the Item may be a snapshot, such as a table's Selected)
  const unsavedRef = useRef(unsaved)
  unsavedRef.current = unsaved
  useEffect(() => {
    if (design || !followsId || !table) return
    return platform.live.subscribe(`table:${table.id}`, (m) => {
      if (m.t !== 'table' || m.self || m.op === 'insert' || !m.rows?.includes(itemId) || !unsavedRef.current) return
      setConflict((c) => c ?? { by: m.by?.name ?? null, version: null })
    })
  }, [design, followsId, table, itemId])

  // a stale save was refused (409): the same panel
  useEffect(() => {
    if (design || !table || !itemId) return
    return platform.onDataError((e) => {
      const err = e.error as typeof e.error & { field?: string; changedBy?: { name?: string }; current?: { modifiedOn?: string } }
      if (e.table !== table.name || !e.rowIds.includes(itemId) || err.code !== 'conflict' || err.field !== 'modifiedOn') return
      setConflict({ by: err.changedBy?.name ?? safe(() => platform.live.lastRowChange(table.id, itemId)?.by.name ?? null, null), version: err.current?.modifiedOn ?? null })
    })
  }, [design, table, itemId])

  const reloadTheirs = () => {
    setOutput('Error', '')
    setContentKey(iKey)
    setReloadToken((n) => n + 1)
  }
  const keepMine = () => {
    // the next save overwrites their version: start from the newest one we know
    // the version from a 409 when we have it; otherwise no version check: the next save replaces theirs
    setBase(conflict?.version ?? null)
    setHeldKey(iKey)
    setContentKey(iKey)
    setConflict(null)
    setOutput('Error', '')
  }

  /* ---- drafts across reloads (src/phone/drafts.ts): sealed in the user's offline store, never localStorage ---- */
  const dscope = useContext(DraftScope)
  const dKey = dscope && !design && table && formMode !== 'View' ? draftKeyOf(dscope.appId, dscope.screenOf(node.id) ?? '', node.name, table.name, draftRecordKey(formMode, followsId ? itemId : '')) : ''
  const live = useRef({ values, baseline, pSig, base, pending })
  live.current = { values, baseline, pSig, base, pending }
  // restore once per load (a reload, a discarded tab): only into a form nobody has typed in yet
  useEffect(() => {
    if (!dKey) return
    let alive = true
    void formDrafts.load(dKey).then((got) => {
      if (!alive || !got) return
      const cur = live.current
      const decision = restoreDecision({ draft: got.draft, mode: formMode, currentBase: cur.base, untouched: serializeValues(cur.values) === cur.baseline && cur.pSig === '' })
      if (decision === 'ignore') return
      const next: FormValues = { ...cur.values }
      for (const c of cols) if (Object.prototype.hasOwnProperty.call(got.draft.values, c.name)) next[c.name] = got.draft.values[c.name] as FieldVal
      const files: Record<string, File[]> = {}
      for (const f of got.files) (files[f.column] ??= []).push(f.file)
      setValues(next)
      setPending(files)
      // Edit: the save goes with the version the draft started from; a newer server row answers 409 (conflict panel)
      if (formMode === 'Edit' && followsId) setBase(got.draft.base)
      setDraftText(draftNote(got.draft.savedAt, decision === 'restore-changed', got.draft.filesDropped))
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dKey, loaded])
  // keep it while unsaved (debounced; at once when the page is hidden: a phone may discard a background tab)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftWrite = useRef<(() => void) | null>(null)
  const draftKept = useRef('')
  useEffect(() => {
    if (!dKey) return
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = null
    draftWrite.current = null
    // the form moved to another record: the edits of the old one were dropped (as always), so is their draft
    if (draftKept.current && draftKept.current !== dKey) {
      void formDrafts.remove(draftKept.current)
      draftKept.current = ''
    }
    if (!unsaved) {
      if (draftKept.current === dKey) {
        draftKept.current = ''
        void formDrafts.remove(dKey)
      }
      return
    }
    const write = () => {
      draftTimer.current = null
      draftWrite.current = null
      const cur = live.current
      const files = Object.entries(cur.pending).flatMap(([column, list]) => list.map((file) => ({ column, file })))
      draftKept.current = dKey
      void formDrafts.save(dKey, { values: cur.values, base: isoOf(cur.base), mode: formMode, table: table?.name ?? dsName, savedAt: Date.now() }, files)
    }
    draftWrite.current = write
    draftTimer.current = setTimeout(write, 600)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dKey, unsaved, serializeValues(values), pSig, String(isoOf(base))])
  useEffect(() => {
    if (!dKey) return
    const hide = () => {
      if (document.visibilityState === 'hidden' && draftWrite.current) {
        if (draftTimer.current) clearTimeout(draftTimer.current)
        draftWrite.current()
      }
    }
    const leave = () => draftWrite.current?.()
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', leave)
    }
  }, [dKey])
  // leaving the form inside the app (another screen, the app tab closed) is not an accident: no draft is left behind
  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current)
      draftWrite.current = null
      if (draftKept.current) void formDrafts.remove(draftKept.current)
    },
    [],
  )
  const discardDraft = () => {
    if (dKey) void formDrafts.remove(dKey)
    draftKept.current = ''
    setDraftText(null)
    setOutput('Error', '')
    setContentKey(iKey)
    setReloadToken((n) => n + 1)
  }

  const updates = useMemo(() => {
    const rec: FxRecord = {}
    for (const c of cols) {
      if (c.type === 'autonumber' || accessOf(c) !== 'update') continue
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
  }, [cols, values, pSig, fileBase, formMode, colAccess])

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
    const sig = serializeValues(values) + '|' + valid + '|' + unsaved + '|' + colsKey + '|' + pSig + '|' + serializeValues(fileBase as FormValues) + '|' + String(base instanceof Date ? base.getTime() : base) + followsId
    if (sig === lastOut.current) return
    lastOut.current = sig
    setOutput('Updates', updates)
    setOutput('Valid', valid)
    setOutput('Unsaved', unsaved)
    setOutput('__version', followsId && base instanceof Date ? base.toISOString() : followsId && typeof base === 'string' ? base : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, values, valid, unsaved, colsKey, updates, pSig, fileBase, base, followsId])

  /* ---- render ---- */
  const columnsN = Math.min(6, Math.max(1, Math.round(toNum(props.Columns, 2))))
  const showButtons = toBool(props.ShowButtons, true) && formMode !== 'View'
  const lastError = outputs.Error == null ? '' : toText(outputs.Error)
  /** the column a server refusal names (validation rules, Reject in table events) */
  const serverField = outputs.__errorField == null ? '' : toText(outputs.__errorField)
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
    setOutput('__errorField', '')
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
          const serverMsg = lastError !== '' && serverField !== '' && serverField.toLowerCase() === c.name.toLowerCase() ? lastError : ''
          const msg = errors[c.name] ?? (serverMsg || undefined)
          const showMsg = msg && (touched[c.name] || allTouched || !!serverMsg)
          return (
            <div key={c.name} className="min-w-0 space-y-1.5" style={wide ? { gridColumn: '1 / -1' } : undefined}>
              <Label htmlFor={id} className="text-sm font-medium">
                <span className="truncate">{c.displayName || c.name}</span>
                {c.required && formMode !== 'View' && <span className="text-destructive" aria-hidden="true">*</span>}
              </Label>
              {formMode === 'View' || accessOf(c) !== 'update' ? (
                <div className="min-h-9 whitespace-pre-wrap rounded-md bg-muted/50 px-3 py-2 text-sm" data-readonly={formMode === 'View' ? undefined : 'true'} title={formMode === 'View' ? undefined : 'Read-only for your role'}>
                  {isFileType(c.type) && attachmentIds(values[c.name]).length > 0 ? (
                    <AttachmentCell value={values[c.name]} thumb={40} max={6} />
                  ) : (
                    displayValue(c, values[c.name], lookups[c.name] ?? []) || <span className="text-muted-foreground">-</span>
                  )}
                </div>
              ) : isFileType(c.type) && sigSet.has(c.name.toLowerCase()) ? (
                <SignatureField
                  col={c}
                  id={id}
                  existing={typeof values[c.name] === 'string' ? (values[c.name] as string) : ''}
                  pending={pending[c.name] ?? []}
                  invalid={Boolean(showMsg)}
                  onPendingChange={(files) => editable && setPending((p) => ({ ...p, [c.name]: files }))}
                  onTouch={() => editable && setTouched((t) => (t[c.name] ? t : { ...t, [c.name]: true }))}
                />
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
        {conflict && !design && (
          <div role="alertdialog" aria-label="This record was changed" data-testid="form-conflict" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-900 dark:text-amber-100">
            <span className="min-w-0 flex-1"><b>This record was changed by {conflict.by ?? 'someone else'}</b> while you were editing it. Reload to see their version (your edits are dropped), or keep yours (saving then replaces theirs).</span>
            <Button type="button" size="sm" variant="outline" className="h-7" onClick={reloadTheirs} data-testid="form-conflict-reload">Reload</Button>
            <Button type="button" size="sm" className="h-7" onClick={keepMine} data-testid="form-conflict-keep">Keep mine</Button>
          </div>
        )}
        {draftText && !design && (
          <div role="status" data-testid="form-draft-note" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-sky-500/40 bg-sky-500/10 px-4 py-2 text-xs text-sky-900 dark:text-sky-100">
            <span className="min-w-0 flex-1">{draftText}</span>
            <Button type="button" size="sm" variant="outline" className={touch ? 'h-10' : 'h-7'} onClick={discardDraft} data-testid="form-draft-discard">Discard</Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
        {showButtons && table && (
          <StickyBar boxRef={root} active={stickyBar} className="flex items-center gap-3 border-t border-border bg-card px-4 py-3 text-card-foreground">
            <div className="min-w-0 flex-1 truncate text-xs">
              {lastError !== '' ? (
                <span className="text-destructive" role="alert">{lastError}</span>
              ) : unsaved ? (
                <span className="text-muted-foreground">Unsaved changes</span>
              ) : null}
            </div>
            <Button type="button" variant="outline" size="sm" className={touch ? 'h-11 px-4' : undefined} onClick={() => editable && fire('OnCancel')}>
              {toText(props.CancelText) || 'Cancel'}
            </Button>
            <Button type="button" size="sm" className={touch ? 'h-11 px-5' : undefined} onClick={save} disabled={busy} data-testid="form-save">
              {busy ? 'Saving...' : toText(props.SubmitText) || 'Save'}
            </Button>
          </StickyBar>
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
  { name: '__errorField', initial: '' },
  { name: 'Unsaved', initial: false },
  // Internal counters the runtime bumps (see report): reload values, show all validation, mark saved.
  { name: '__reset', initial: 0 },
  { name: '__touch', initial: 0 },
  { name: '__saved', initial: 0 },
  // 1 while a submit waits for the server / file uploads; { column: token } of files to upload after save
  { name: '__busy', initial: 0 },
  { name: '__files', initial: {} },
  // the record's modifiedOn the edits started from (sent with the save: optimistic concurrency, package H)
  { name: '__version', initial: '' },
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
    { name: 'SignatureFields', label: 'Signature fields', kind: 'text', group: 'Content', default: '=""', simple: false },
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

