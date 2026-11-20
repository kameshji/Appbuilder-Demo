/**
 * The Form's lookup field: a searchable picker that asks the server as you type (docs/dev/frontend.md "Lookup fields
 * and labels"). The target table's primary column is searched with a delegable Query v2 plan (lookups.ts pickerPlan),
 * as the signed-in user, after a pause in typing, 25 rows at a time (more on scroll, with the exact count). The label of
 * the current value is read by id (lookupLabels.ts), so it shows even when that row is not on the first page.
 *
 * Desktop: a combobox button opening a popover with a search box (arrows, Enter, Escape; Backspace or Delete on the
 * closed button clears an optional value). Touch: the bottom sheet with search (src/phone/sheet-picker.tsx). Demo mode
 * runs the same plans in the browser; offline, tables kept on the device answer from there and others say so.
 *
 * ChoiceSheetField: a Form choice field on touch devices (the bottom sheet instead of the Radix select).
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { platform } from '@/platform'
import type { ColumnDef, Row, TableDef } from '@/platform/contracts'
import { useQuery } from '@/platform/useQuery'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { useDevice } from '@/phone/env'
import { useConnectivity } from '@/phone/connectivity'
import { PickerSheet } from '@/phone/sheet-picker'
import { PICKER_PAGE, isNoConnection, labelText, lookupCell, pickerMessage, pickerNote, pickerPlan, primaryOf } from '../lookups'
import { lookupLabel, rememberLabel, useLabelVersion, useLookupRequests } from '../lookupLabels'

let seq = 0
const STEP = 50

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

const fieldCls = 'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-left text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'
const errCls = 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20'

/** the label of a lookup value, read by id (View mode, read-only fields) */
export function LookupText({ col, value }: { col: ColumnDef; value: string }) {
  useLabelVersion()
  const target = col.lookupTable ?? ''
  useLookupRequests(value && target ? [{ table: target, ids: [value] }] : [])
  const known = safe(() => !!platform.tables.get(target), false)
  const cell = lookupCell(value, known ? lookupLabel(target, value) : null)
  if (cell.state === 'blank') return null
  return <span className={cn(cell.state !== 'label' && 'text-muted-foreground')} data-lookup-state={cell.state} title={cell.state === 'missing' ? 'This record was deleted or you cannot see it.' : undefined}>{cell.text}</span>
}

export function LookupPicker({ col, id, value, onChange, onBlur, invalid }: {
  col: ColumnDef
  id: string
  value: string
  onChange(v: string): void
  onBlur(): void
  invalid: boolean
}) {
  const touch = useDevice().touch
  const offlineNow = useConnectivity((s) => s.status === 'offline')
  const target: TableDef | undefined = safe(() => platform.tables.get(col.lookupTable ?? ''), undefined)
  const title = target?.displayName || col.lookupTable || 'records'
  const [owner] = useState(() => `lookup-picker-${++seq}`)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(STEP)
  // the highlighted row (keyboard): kept while it is shown, else the first row, so Enter always picks something visible
  const [active, setActive] = useState('')
  useEffect(() => {
    if (text === search) return
    const t = setTimeout(() => {
      setSearch(text)
      setLimit(STEP)
    }, 250)
    return () => clearTimeout(t)
  }, [text, search])
  const plan = useMemo(() => (open && target ? pickerPlan(target, search) : null), [open, target, search])
  const st = useQuery(plan, { owner, pageSize: PICKER_PAGE })

  // the current value's label (by id: it may be far from the first page)
  useLabelVersion()
  useLookupRequests(value && target ? [{ table: target.name, ids: [value] }] : [])
  const cell = lookupCell(value, target ? lookupLabel(target.name, value) : null)

  const primary = target ? (primaryOf(target)?.name ?? target.primaryColumn) : ''
  // while the next search loads, the previous answer stays on screen (no flash of "Searching…" between keystrokes)
  const [kept, setKept] = useState<Row[]>([])
  const fresh = st?.status === 'ready' ? st.rows : null
  if (fresh && fresh !== kept) setKept(fresh)
  const source = fresh ?? (st?.status === 'error' || !open ? [] : kept)
  const rows = useMemo(() => source.map((r) => ({ id: String(r.__id ?? r.id ?? ''), label: labelText(r[primary]) })).filter((r) => r.id !== ''), [source, primary])
  const shown = rows.slice(0, limit)
  const typing = text.trim() !== search.trim()
  const status = !st || typing ? 'loading' : st.status
  const message = pickerMessage({ status, rows: shown.length, search, table: title, offline: !!st?.error && (offlineNow || isNoConnection(st.error)), errorMessage: st?.error?.message })
  const note = st ? pickerNote(shown.length, st.count, st.hasMore || shown.length < rows.length) : null
  const nearEnd = () => {
    if (limit < rows.length) setLimit((l) => l + STEP)
    else if (st?.hasMore && !st.loadingMore) void safe(() => platform.tables.loadMore(st.key), Promise.resolve())
  }

  const changeOpen = (o: boolean) => {
    setOpen(o)
    if (!o) {
      setText('')
      setSearch('')
      setLimit(STEP)
      setKept([])
      onBlur()
    }
  }
  const pick = (rid: string, label: string) => {
    if (target) rememberLabel(target.name, rid, label)
    onChange(rid)
    changeOpen(false)
  }
  const clear = () => {
    onChange('')
    onBlur()
  }
  const clearable = !col.required && value !== ''

  if (!target) {
    return (
      <div id={id} className={cn(fieldCls, 'text-muted-foreground')} aria-disabled="true" data-testid="lookup-picker" data-lookup-state="no-table">
        {value ? 'Not available' : `You cannot see ${col.lookupTable ?? 'the table'} here`}
      </div>
    )
  }

  const shownLabel = cell.state === 'blank' ? '' : cell.text
  const trigger = (onClick?: () => void) => (
    <button
      type="button"
      id={id}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-invalid={invalid || undefined}
      aria-label={`${col.displayName || col.name}: ${shownLabel || 'none'}`}
      data-testid="lookup-picker"
      data-lookup-state={cell.state}
      className={cn(fieldCls, invalid && errCls, touch && 'h-11')}
      onClick={onClick}
      onKeyDown={(e) => {
        if ((e.key === 'Backspace' || e.key === 'Delete') && clearable) {
          e.preventDefault()
          clear()
        } else if ((e.key === 'ArrowDown' || e.key === 'Enter') && !open) {
          e.preventDefault()
          changeOpen(true)
        }
      }}
    >
      <span className={cn('min-w-0 truncate', clearable && 'mr-7', cell.state !== 'label' && 'text-muted-foreground')}>{shownLabel || `Search ${title}...`}</span>
      <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
    </button>
  )
  const clearButton = clearable && (
    <button
      type="button"
      aria-label={`Clear ${col.displayName || col.name}`}
      data-testid="lookup-clear"
      data-touch-target=""
      className="absolute inset-y-0 right-9 flex w-6 items-center justify-center text-muted-foreground hover:text-foreground"
      onClick={clear}
    >
      <X className="size-3.5" />
    </button>
  )
  const statusLine = message && <div className="px-3 py-4 text-center text-sm text-muted-foreground" role={status === 'error' ? 'alert' : 'status'} data-testid="lookup-message">{message}</div>
  const noteLine = (note || st?.loadingMore) && <div className="px-3 py-1.5 text-xs text-muted-foreground" data-testid="lookup-note">{st?.loadingMore ? 'Loading…' : note}</div>

  if (touch) {
    return (
      <div className="relative min-w-0">
        {trigger(() => changeOpen(true))}
        {clearButton}
        <PickerSheet
          open={open}
          onClose={() => changeOpen(false)}
          label={`Pick ${col.displayName || col.name}`}
          rows={message ? [] : shown.map((r, i) => ({ index: i, text: r.label, selected: r.id === value }))}
          search={text}
          onSearch={setText}
          onPick={(i) => { const r = shown[i]; if (r) pick(r.id, r.label) }}
          emptyText={message ?? 'No results.'}
          note={noteLine || undefined}
          onNearEnd={nearEnd}
          searchPlaceholder={`Search ${title}...`}
        />
      </div>
    )
  }

  return (
    <div className="relative min-w-0">
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>{trigger()}</PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" data-testid="lookup-popover">
          <Command shouldFilter={false} label={`Search ${title}`} value={shown.some((r) => r.id === active) ? active : (shown[0]?.id ?? '')} onValueChange={setActive}>
            <CommandInput placeholder={`Search ${title}...`} value={text} onValueChange={setText} aria-label={`Search ${title}`} />
            <CommandList
              onScroll={(e) => {
                const el = e.currentTarget
                if (el.scrollTop + el.clientHeight > el.scrollHeight - 120) nearEnd()
              }}
            >
              {message ? statusLine : (
                <CommandGroup>
                  {shown.map((r) => (
                    <CommandItem key={r.id} value={r.id} onSelect={() => pick(r.id, r.label)} data-testid="lookup-option">
                      <Check className={cn('size-4', r.id === value ? 'opacity-100' : 'opacity-0')} />
                      <span className="truncate">{r.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {!message && noteLine}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {clearButton}
    </div>
  )
}

/** a Form choice field on touch devices: the bottom sheet (search, 44 px rows), "(none)" for optional fields */
export function ChoiceSheetField({ col, id, value, onChange, onBlur, invalid }: {
  col: ColumnDef
  id: string
  value: string
  onChange(v: string): void
  onBlur(): void
  invalid: boolean
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const choices = col.choices ?? []
  const q = text.trim().toLowerCase()
  const shown = choices.map((c, i) => ({ c, i })).filter((x) => !q || x.c.toLowerCase().includes(q))
  const close = () => {
    setOpen(false)
    setText('')
    onBlur()
  }
  const clearable = !col.required && value !== ''
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={invalid || undefined}
        data-testid="choice-picker"
        className={cn(fieldCls, 'h-11', invalid && errCls)}
        onClick={() => setOpen(true)}
      >
        <span className={cn('min-w-0 truncate', clearable && 'mr-7', value === '' && 'text-muted-foreground')}>{value === '' ? 'Select...' : value}</span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
      </button>
      {clearable && (
        <button type="button" aria-label={`Clear ${col.displayName || col.name}`} data-touch-target="" className="absolute inset-y-0 right-9 flex w-6 items-center justify-center text-muted-foreground" onClick={() => { onChange(''); onBlur() }}>
          <X className="size-3.5" />
        </button>
      )}
      <PickerSheet
        open={open}
        onClose={close}
        label={`Pick ${col.displayName || col.name}`}
        rows={shown.map((x) => ({ index: x.i, text: x.c, selected: x.c === value }))}
        search={text}
        onSearch={setText}
        onPick={(i) => { onChange(choices[i] ?? ''); close() }}
        emptyText={q ? `No choice matches "${text.trim()}".` : 'No choices are set up for this column.'}
      />
    </div>
  )
}
