import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronsUpDown, List as ListIcon, Loader2, Search, Table2 } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord, FxValue } from '@/contracts'
import { platform, type TableDef } from '@/platform'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { isRecord, recordText, toBool, toNum, toRecords, toText } from '../util'
import { AttachmentCell } from '@/runtime/AttachmentCell'
import { attachmentIds, imageSource } from '@/runtime/attachments'
import { AvatarCircle } from './basics'
import { DynIcon, fieldText, formatDate, formatNumber, isIsoDateString, pick, prettify, selModeOf } from './helpers'
import { queryMeta, rowCountText, useVirtualRows, viewMatches } from '../virtual'
import { useDevice } from '@/phone/env'
import { useBoxWidth } from '@/phone/touch-hooks'
import { cardMode, cardPlan, parseCardColumns } from '@/phone/touch-logic'
import { lookupCell, lookupSort, lookupSortText } from '../lookups'
import { lookupLabel, tableOfRows, useLabelVersion, useLookupRequests } from '../lookupLabels'

/** a lookup column of a list: the target table and how it may be sorted */
interface LookupInfo { target: string; sortable: boolean; reason?: string }

/** a lookup cell: the target row's label; a neutral placeholder for a row the viewer cannot read; never the id */
function LookupCellView({ target, value }: { target: string; value: FxValue | undefined }) {
  const cell = lookupCell(value, typeof value === 'string' && value ? lookupLabel(target, value) : undefined)
  if (cell.state === 'blank') return null
  return (
    <span data-lookup-state={cell.state} className={cn(cell.state !== 'label' && 'text-muted-foreground', cell.state === 'missing' && 'italic')} title={cell.state === 'missing' ? 'This record was deleted or you cannot see it.' : undefined}>
      {cell.text}
    </span>
  )
}

/* ------------------------------------------------------------------ DataTable */

type ColKind = 'text' | 'number' | 'boolean' | 'date'
interface Col {
  field: string
  header: string
  kind: ColKind
}

function isHidden(key: string): boolean {
  return key.startsWith('__')
}

/** `table`: the TableDef the items come from, when known; with an empty spec its system columns (ColumnDef.system) are left out */
export function resolveColumns(items: FxRecord[], spec: string, table?: TableDef): Col[] {
  const system = new Set((table?.columns ?? []).filter((c) => c.system).map((c) => c.name))
  let defs: { field: string; header: string }[]
  if (spec.trim()) {
    defs = spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf(':')
        return i > 0 ? { field: s.slice(0, i).trim(), header: s.slice(i + 1).trim() } : { field: s, header: prettify(s) }
      })
  } else {
    const keys: string[] = []
    const seen = new Set<string>()
    for (const r of items.slice(0, 50)) {
      for (const k of Object.keys(r)) {
        if (isHidden(k) || seen.has(k) || system.has(k)) continue
        if (k === 'id' && typeof r.__id === 'string' && r.__id === r.id) continue
        seen.add(k)
        keys.push(k)
      }
    }
    defs = keys.map((k) => ({ field: k, header: prettify(k) }))
  }
  return defs.map((d) => {
    let kind: ColKind = 'text'
    for (const r of items.slice(0, 30)) {
      const v = pick(r, d.field)
      if (v == null || v === '') continue
      if (typeof v === 'boolean') kind = 'boolean'
      else if (typeof v === 'number') kind = 'number'
      else if (v instanceof Date || (typeof v === 'string' && isIsoDateString(v))) kind = 'date'
      break
    }
    return { ...d, kind }
  })
}

function cellText(v: FxValue | undefined, kind: ColKind): string {
  if (v == null) return ''
  if (kind === 'number' && typeof v === 'number') return formatNumber(v)
  if (kind === 'date') {
    const d = v instanceof Date ? v : new Date(toText(v))
    return Number.isNaN(d.getTime()) ? toText(v) : formatDate(d)
  }
  if (Array.isArray(v)) return v.map((x) => (isRecord(x) ? recordText(x) : toText(x))).join(', ')
  if (isRecord(v)) return recordText(v)
  return toText(v)
}

function compareValues(a: FxValue | undefined, b: FxValue | undefined, kind: ColKind): number {
  const an = a == null || a === ''
  const bn = b == null || b === ''
  if (an || bn) return an === bn ? 0 : an ? 1 : -1 // blanks last (caller flips for desc separately)
  if (kind === 'number') return toNum(a, 0) - toNum(b, 0)
  if (kind === 'boolean') return Number(!!a) - Number(!!b)
  if (kind === 'date') {
    const da = a instanceof Date ? a.getTime() : new Date(toText(a)).getTime()
    const db = b instanceof Date ? b.getTime() : new Date(toText(b)).getTime()
    return (Number.isNaN(da) ? 0 : da) - (Number.isNaN(db) ? 0 : db)
  }
  const sa = isRecord(a) ? recordText(a) : toText(a)
  const sb = isRecord(b) ? recordText(b) : toText(b)
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })
}

function keyOf(rec: FxRecord): string {
  const id = rec.__id
  if (typeof id === 'string' && id) return id
  try {
    return JSON.stringify(rec)
  } catch {
    return String(Math.random())
  }
}

/** the TableDef when these items are the rows of a platform table (their keys are all columns of one table) */
function sourceTable(items: FxRecord[]): TableDef | undefined {
  if (items.length === 0) return undefined
  try {
    const names = new Set(Object.keys(items[0]).filter((k) => !k.startsWith('__')))
    if (!names.has('id')) return undefined
    return platform.getState().tables.find((t) => {
      const cols = new Set(t.columns.map((c) => c.name))
      return t.columns.some((c) => c.name === 'id') && [...names].every((n) => cols.has(n))
    })
  } catch {
    return undefined
  }
}

function DataTableRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const items = useMemo(() => toRecords(props.Items), [props.Items])
  // server mode: Items is a paged query result; sorting and searching happen on the server (the evaluator re-plans the
  // query from SortColumn / SortOrder / SearchText), more rows load as the user scrolls
  const meta = queryMeta(props.Items)
  const colSpecRaw = toText(props.Columns)
  // an explicit Columns list skips columns the (CLS-trimmed) table does not have; other item sources are untouched
  const colSpec = useMemo(() => {
    if (!colSpecRaw.trim()) return colSpecRaw
    const t = sourceTable(items)
    if (!t) return colSpecRaw
    const have = new Set(t.columns.map((c) => c.name.toLowerCase()))
    const kept = colSpecRaw.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => have.has((s.includes(':') ? s.slice(0, s.indexOf(':')) : s).trim().toLowerCase()))
    return kept.join(',')
  }, [colSpecRaw, items])
  const cols = useMemo(() => resolveColumns(items, colSpec, sourceTable(items)), [items, colSpec])
  // lookup columns show the target row's label (resolved in batches, src/controls/lookupLabels.ts)
  const labelsV = useLabelVersion()
  const srcDef = useMemo(() => tableOfRows(items, meta?.table), [items, meta?.table])
  const lookupCols = useMemo(() => {
    const out = new Map<string, LookupInfo>()
    for (const c of cols) {
      const def = srcDef?.columns.find((x) => x.name === c.field)
      if (!def || def.type !== 'lookup' || !def.lookupTable) continue
      const distinct = meta ? 0 : new Set(items.map((r) => pick(r, c.field)).filter((v) => typeof v === 'string' && v !== '')).size
      out.set(c.field, { target: def.lookupTable, ...lookupSort(!!meta, c.header, distinct) })
    }
    return out
  }, [cols, srcDef, meta, items])
  /** the text of a cell for a search or a sort held in the browser (a lookup: its label) */
  const textOf = (c: Col, v: FxValue | undefined): string => {
    const lk = lookupCols.get(c.field)
    return lk ? lookupSortText(v, typeof v === 'string' && v ? lookupLabel(lk.target, v) : undefined) : cellText(v, c.kind)
  }
  const canSort = (c: Col) => (meta ? !!meta.columns[c.field] : true) && (lookupCols.get(c.field)?.sortable ?? true)
  const striped = toBool(props.Striped, false)
  const dense = toBool(props.Dense, false)
  const sortable = toBool(props.Sortable, true)
  const searchable = toBool(props.Searchable, false)
  const selMode = selModeOf(props.SelectionMode, 'single')
  const pageSize = Math.max(0, Math.round(toNum(props.PageSize, 0)))
  const emptyText = toText(props.EmptyText) || 'No data'
  // phones: a table narrower than a phone on a touch device is drawn as cards (CardColumns picks and orders the columns)
  const touch = useDevice().touch
  const boxRef = useRef<HTMLDivElement>(null)
  const boxWidth = useBoxWidth(boxRef)
  const cards = cardMode(touch, boxWidth, design)
  const plan = useMemo(() => (cards ? cardPlan(cols, parseCardColumns(toText(props.CardColumns))) : null), [cards, cols, props.CardColumns])
  const [cardLimit, setCardLimit] = useState(100)

  const [query, setQuery] = useState(() => toText(outputs.SearchText))
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current) }, [])
  const sortCol = toText(outputs.SortColumn)
  const sortDir = toText(outputs.SortOrder) === 'Descending' ? 'desc' : toText(outputs.SortOrder) === 'Ascending' ? 'asc' : ''
  const selectedItems = toRecords(outputs.SelectedItems)
  const selKeys = useMemo(() => new Set(selectedItems.map(keyOf)), [outputs.SelectedItems]) // eslint-disable-line react-hooks/exhaustive-deps

  // search -> sort pipeline (in the browser for plain tables; the server already did both for a query result)
  const serverView = !!meta && viewMatches(meta, sortCol && sortDir ? { col: sortCol, dir: sortDir as 'asc' | 'desc' } : null, toText(outputs.SearchText))
  const rows = useMemo(() => {
    if (serverView) return items
    let r = items
    const q = query.trim().toLowerCase()
    if (q) r = r.filter((rec) => cols.some((c) => textOf(c, pick(rec, c.field)).toLowerCase().includes(q)))
    const sc = sortCol && sortDir ? cols.find((c) => c.field === sortCol && canSort(c)) : undefined
    const lk = sc ? lookupCols.get(sc.field) : undefined
    if (sc) {
      const dir = sortDir === 'desc' ? -1 : 1
      r = r
        .map((rec, i) => ({ rec, i }))
        .sort((a, b) => {
          const va = lk ? textOf(sc, pick(a.rec, sc.field)) : pick(a.rec, sc.field)
          const vb = lk ? textOf(sc, pick(b.rec, sc.field)) : pick(b.rec, sc.field)
          const blankA = va == null || va === ''
          const blankB = vb == null || vb === ''
          if (blankA || blankB) return blankA === blankB ? a.i - b.i : blankA ? 1 : -1
          return dir * compareValues(va, vb, lk ? 'text' : sc.kind) || a.i - b.i
        })
        .map((x) => x.rec)
    }
    return r
    // labelsV: the labels a lookup search / sort reads changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cols, query, sortCol, sortDir, serverView, lookupCols, labelsV])

  // the exact number of rows of the whole result (server count), or the rows we hold
  const totalRows = serverView ? (meta?.count ?? rows.length) : rows.length
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(totalRows / pageSize)) : 1
  const rawPage = typeof outputs.Page === 'number' ? Math.round(outputs.Page) : 1
  const page = Math.min(pageCount, Math.max(1, rawPage))
  const pageRows = pageSize > 0 ? rows.slice((page - 1) * pageSize, page * pageSize) : rows
  // a pager over a query result fetches the pages it shows
  useEffect(() => {
    if (meta && pageSize > 0 && meta.hasMore && !meta.loadingMore && rows.length < page * pageSize) void meta.loadMore()
  }, [meta, pageSize, page, rows.length])

  useEffect(() => {
    if (rawPage !== page) setOutput('Page', page)
    if (outputs.VisibleCount !== totalRows) setOutput('VisibleCount', totalRows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPage, page, totalRows, outputs.VisibleCount])

  // windowed rows (long lists, query results) with infinite scroll
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLTableRowElement>(null)
  const [pitch, setPitch] = useState(dense ? 29 : 41)
  // measure the real row height once rows are on screen (attachment thumbnails make rows taller)
  const firstRowKey = pageRows[0] ? keyOf(pageRows[0]) : ''
  useEffect(() => {
    const h = rowRef.current?.offsetHeight
    if (h && Math.abs(h - pitch) > 0.5) setPitch(h)
  }, [firstRowKey, dense, pitch])
  const virtualOn = !design && !cards && pageSize === 0 && (!!meta || rows.length > 300)
  const win = useVirtualRows({
    count: pageRows.length, pitch, enabled: virtualOn, scrollRef,
    onNearEnd: !cards && meta && pageSize === 0 && meta.hasMore ? () => void meta.loadMore() : undefined,
  })
  const shownRows = virtualOn ? pageRows.slice(win.start, win.end) : cards ? pageRows.slice(0, cardLimit) : pageRows
  // labels of the lookups on screen (one batch per target table); a search or sort held in the browser needs them all
  const needAll = !serverView && (query.trim() !== '' || (!!sortCol && lookupCols.has(sortCol)))
  const labelRows = needAll ? items : shownRows
  const labelReqs: { table: string; ids: (FxValue | undefined)[] }[] = []
  for (const [field, lk] of lookupCols) labelReqs.push({ table: lk.target, ids: labelRows.map((r) => pick(r, field)) })
  useLookupRequests(labelReqs)
  // a new sort or search starts at the top
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setCardLimit(100)
  }, [sortCol, sortDir, outputs.SearchText])
  // cards have different heights: more cards (and more rows of a server query) load when the end is near
  const onScroll = (e: React.UIEvent<HTMLElement>) => {
    win.onScroll(e)
    if (!cards) return
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 300) return
    if (cardLimit < pageRows.length) setCardLimit((l) => l + 100)
    else if (meta && pageSize === 0 && meta.hasMore && !meta.loadingMore) void meta.loadMore()
  }
  // card layout has no column headers: a sort control takes their place
  const setSort = (field: string, dir: 'asc' | 'desc') => {
    if (!field) {
      setOutput('SortColumn', '')
      setOutput('SortOrder', '')
    } else {
      setOutput('SortColumn', field)
      setOutput('SortOrder', dir === 'desc' ? 'Descending' : 'Ascending')
    }
    setOutput('Page', 1)
  }

  const setPage = (p: number) => setOutput('Page', Math.min(pageCount, Math.max(1, p)))

  const onHeader = (c: Col) => {
    if (!sortable || design) return
    // a query result sorts on the server: only columns of the table can be sorted, and never a lookup (it would sort by id)
    if (!canSort(c)) return
    if (sortCol !== c.field || !sortDir) {
      setOutput('SortColumn', c.field)
      setOutput('SortOrder', 'Ascending')
    } else if (sortDir === 'asc') {
      setOutput('SortOrder', 'Descending')
    } else {
      setOutput('SortColumn', '')
      setOutput('SortOrder', '')
    }
    setOutput('Page', 1)
  }

  const commit = (list: FxRecord[], focus: FxRecord | null) => {
    setOutput('SelectedItems', list)
    setOutput('Selected', focus)
    fire('OnSelect')
  }
  const onRow = (rec: FxRecord) => {
    if (design || selMode === 'none') return
    if (selMode === 'single') return commit([rec], rec)
    const k = keyOf(rec)
    if (selKeys.has(k)) {
      const rest = selectedItems.filter((s) => keyOf(s) !== k)
      commit(rest, rest.length ? rest[rest.length - 1] : null)
    } else commit([...selectedItems, rec], rec)
  }
  const pageAllSelected = pageRows.length > 0 && pageRows.every((r) => selKeys.has(keyOf(r)))
  const pageSomeSelected = pageRows.some((r) => selKeys.has(keyOf(r)))
  const onAll = () => {
    if (design) return
    if (pageAllSelected) {
      const drop = new Set(pageRows.map(keyOf))
      const rest = selectedItems.filter((s) => !drop.has(keyOf(s)))
      commit(rest, rest.length ? rest[rest.length - 1] : null)
    } else {
      const have = new Set(selectedItems.map(keyOf))
      const merged = [...selectedItems, ...pageRows.filter((r) => !have.has(keyOf(r)))]
      commit(merged, merged[merged.length - 1] ?? null)
    }
  }

  const pad = dense ? 'px-3 py-1' : 'px-3 py-2.5'
  const showCheck = selMode === 'multiple'
  const total = totalRows
  const from = total === 0 ? 0 : pageSize > 0 ? (page - 1) * pageSize + 1 : 1
  const to = pageSize > 0 ? Math.min(total, page * pageSize) : total
  const busy = !!meta && (meta.refreshing || meta.loadingMore)

  return (
    <div ref={boxRef} data-layout={cards ? 'cards' : 'table'} className={cn('box-border flex size-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground', dense ? 'text-xs' : 'text-sm', design && 'pointer-events-none')}>
      {searchable && (
        <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2">
          <div className="relative w-64 max-w-full">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder="Search"
              className="h-8 pl-8"
              tabIndex={design ? -1 : undefined}
              onChange={(e) => {
                const v = e.target.value
                setQuery(v)
                // a query result searches on the server: wait for a pause in typing
                if (searchTimer.current) clearTimeout(searchTimer.current)
                if (meta) {
                  searchTimer.current = setTimeout(() => {
                    setOutput('SearchText', v)
                    setOutput('Page', 1)
                  }, 300)
                } else {
                  setOutput('SearchText', v)
                  setOutput('Page', 1)
                }
              }}
            />
          </div>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground" data-row-count>
            {busy && <Loader2 className="size-3 animate-spin" aria-label="Loading" />}
            {meta ? rowCountText(meta.count, items.length) : query.trim() ? `${total} of ${items.length} ${items.length === 1 ? 'row' : 'rows'}` : rowCountText(undefined, items.length)}
          </span>
        </div>
      )}
      {cards && sortable && cols.length > 0 && items.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2" data-testid="card-sort">
          <select
            aria-label="Sort by"
            className="h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
            value={sortCol && cols.some((c) => c.field === sortCol) ? sortCol : ''}
            onChange={(e) => setSort(e.target.value, sortDir === 'desc' ? 'desc' : 'asc')}
          >
            <option value="">Sort: none</option>
            {cols.filter(canSort).map((c) => (
              <option key={c.field} value={c.field}>Sort by {c.header}</option>
            ))}
          </select>
          <Button type="button" variant="outline" className="size-11 shrink-0 p-0" aria-label={sortDir === 'desc' ? 'Descending: tap for ascending' : 'Ascending: tap for descending'} disabled={!sortCol} onClick={() => setSort(sortCol, sortDir === 'desc' ? 'asc' : 'desc')}>
            {sortDir === 'desc' ? <ArrowDown /> : <ArrowUp />}
          </Button>
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
        {cols.length === 0 || (items.length === 0 && !query && !meta?.count) ? (
          <div className="flex size-full min-h-24 flex-col items-center justify-center gap-2 p-6 text-muted-foreground">
            <Table2 className="size-7 opacity-60" strokeWidth={1.5} />
            <span className="text-sm">{emptyText}</span>
          </div>
        ) : cards && plan ? (
          <div role="list" className="divide-y" data-testid="data-cards">
            {shownRows.map((rec, ri) => {
              const sel = selKeys.size > 0 && selKeys.has(keyOf(rec))
              const show = (c: Col) => {
                const v = pick(rec, c.field)
                const attIds = c.kind === 'text' ? attachmentIds(v) : []
                if (c.kind === 'boolean' && typeof v === 'boolean') return v ? <Check className="size-4 text-primary" aria-label="Yes" /> : <span className="text-muted-foreground/60" aria-label="No">No</span>
                if (attIds.length > 0) return <AttachmentCell value={v} thumb={28} />
                const lk = lookupCols.get(c.field)
                if (lk) return <LookupCellView target={lk.target} value={v} />
                return cellText(v, c.kind)
              }
              const blank = (c: Col) => {
                const v = pick(rec, c.field)
                return v == null || v === '' || (Array.isArray(v) && v.length === 0)
              }
              return (
                <div
                  key={typeof rec.__id === 'string' ? rec.__id : ri}
                  role="listitem"
                  data-card=""
                  aria-current={sel || undefined}
                  onClick={() => onRow(rec)}
                  className={cn('flex min-h-11 items-start gap-3 px-4 py-3 transition-colors', selMode !== 'none' && 'cursor-pointer active:bg-muted/60', sel ? 'bg-primary/10' : striped && ri % 2 === 1 ? 'bg-muted/40' : '')}
                >
                  {showCheck && (
                    <span onClick={(e) => e.stopPropagation()} className="-ml-1 mt-0.5 grid size-6 shrink-0 place-items-center" data-touch-target="">
                      <Checkbox aria-label="Select row" checked={sel} onCheckedChange={() => onRow(rec)} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-sm font-semibold leading-snug">{blank(plan.title) ? <span className="text-muted-foreground">-</span> : show(plan.title)}</div>
                    {plan.subtitle && !blank(plan.subtitle) && <div className="mt-0.5 break-words text-sm text-muted-foreground">{show(plan.subtitle)}</div>}
                    {plan.lines.some((c) => !blank(c)) && (
                      <dl className="mt-1.5 space-y-0.5 text-xs">
                        {plan.lines.filter((c) => !blank(c)).map((c) => (
                          <div key={c.field} className="flex gap-2">
                            <dt className="shrink-0 text-muted-foreground">{c.header}:</dt>
                            <dd className="min-w-0 break-words tabular-nums">{show(c)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </div>
              )
            })}
            {pageRows.length === 0 && (
              <div className="px-3 py-10 text-center text-muted-foreground">{meta && (meta.refreshing || meta.loadingMore) ? 'Loading…' : 'No matching rows'}</div>
            )}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                {showCheck && (
                  <th className={cn('sticky top-0 z-10 w-9 border-b bg-muted', dense ? 'px-3 py-1' : 'px-3 py-2')}>
                    <Checkbox
                      aria-label="Select all"
                      checked={pageAllSelected ? true : pageSomeSelected ? 'indeterminate' : false}
                      onCheckedChange={onAll}
                    />
                  </th>
                )}
                {cols.map((c) => {
                  const active = sortCol === c.field && !!sortDir
                  const sortHere = sortable && canSort(c)
                  const noSort = sortable && !sortHere ? lookupCols.get(c.field)?.reason : undefined
                  return (
                    <th
                      key={c.field}
                      scope="col"
                      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                      onClick={() => onHeader(c)}
                      title={noSort}
                      data-sortable={sortable ? String(sortHere) : undefined}
                      className={cn(
                        'sticky top-0 z-10 select-none whitespace-nowrap border-b bg-muted text-xs font-medium text-muted-foreground',
                        dense ? 'px-3 py-1.5' : 'px-3 py-2',
                        (c.kind === 'number') && 'text-right',
                        sortHere && 'cursor-pointer hover:text-foreground',
                        active && 'text-foreground',
                      )}
                    >
                      <span className={cn('inline-flex items-center gap-1', c.kind === 'number' && 'flex-row-reverse')}>
                        {c.header}
                        {sortHere &&
                          (active ? (
                            sortDir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
                          ) : (
                            <ChevronsUpDown className="size-3 opacity-40" />
                          ))}
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {win.padTop > 0 && <tr aria-hidden style={{ height: win.padTop }} />}
              {shownRows.map((rec, i) => {
                const ri = i + (virtualOn ? win.start : 0)
                const sel = selKeys.size > 0 && selKeys.has(keyOf(rec))
                return (
                  <tr
                    ref={i === 0 ? rowRef : undefined}
                    key={typeof rec.__id === 'string' ? rec.__id : ri}
                    aria-selected={selMode !== 'none' ? sel : undefined}
                    onClick={() => onRow(rec)}
                    className={cn(
                      'transition-colors',
                      selMode !== 'none' && 'cursor-pointer',
                      sel ? 'bg-primary/10' : striped && ri % 2 === 1 ? 'bg-muted/40' : '',
                      !sel && 'hover:bg-muted/60',
                    )}
                  >
                    {showCheck && (
                      <td className={cn('w-9 border-b', pad)} onClick={(e) => e.stopPropagation()}>
                        <Checkbox aria-label="Select row" checked={sel} onCheckedChange={() => onRow(rec)} />
                      </td>
                    )}
                    {cols.map((c) => {
                      const v = pick(rec, c.field)
                      const lk = lookupCols.get(c.field)
                      const attIds = c.kind === 'text' && !lk ? attachmentIds(v) : []
                      return (
                        <td
                          key={c.field}
                          title={c.kind === 'boolean' || attIds.length ? undefined : lk ? textOf(c, v) || undefined : cellText(v, c.kind)}
                          className={cn('max-w-xs overflow-hidden text-ellipsis whitespace-nowrap border-b', pad, c.kind === 'number' && 'text-right tabular-nums')}
                        >
                          {c.kind === 'boolean' && typeof v === 'boolean' ? (
                            v ? <Check className="size-4 text-primary" aria-label="Yes" /> : <span className="text-muted-foreground/50" aria-label="No">–</span>
                          ) : attIds.length > 0 ? (
                            <AttachmentCell value={v} thumb={dense ? 20 : 28} />
                          ) : lk ? (
                            <LookupCellView target={lk.target} value={v} />
                          ) : (
                            cellText(v, c.kind)
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
              {win.padBottom > 0 && <tr aria-hidden style={{ height: win.padBottom }} />}
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={cols.length + (showCheck ? 1 : 0)} className="px-3 py-10 text-center text-muted-foreground">
                    {meta && (meta.refreshing || meta.loadingMore) ? 'Loading…' : 'No matching rows'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {meta && pageSize === 0 && !searchable && (
        <div className="flex shrink-0 items-center justify-end gap-1.5 border-t px-3 py-1 text-xs text-muted-foreground" data-row-count>
          {busy && <Loader2 className="size-3 animate-spin" aria-label="Loading" />}
          <span className="tabular-nums">{rowCountText(meta.count, items.length)}{meta.truncated ? ' (first rows only)' : ''}</span>
        </div>
      )}
      {pageSize > 0 && total > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {from}–{to} of {total}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="First page" disabled={page <= 1} onClick={() => setPage(1)}><ChevronsLeft /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft /></Button>
            <span className="px-2 tabular-nums">Page {page} of {pageCount}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage(page + 1)}><ChevronRight /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Last page" disabled={page >= pageCount || (!!meta && meta.hasMore && (meta.count ?? 0) - items.length > 2000)} onClick={() => setPage(pageCount)}><ChevronsRight /></Button>
          </div>
        </div>
      )}
    </div>
  )
}

export const DataTable: ControlType = {
  type: 'DataTable',
  label: 'Data table',
  icon: Table2,
  category: 'Data',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=[]' },
    { name: 'Columns', kind: 'text', group: 'Data', default: '=""' },
    { name: 'SelectionMode', kind: 'enum', group: 'Behaviour', default: '=SelectionMode.Single', options: ['SelectionMode.None', 'SelectionMode.Single', 'SelectionMode.Multiple'] },
    { name: 'Searchable', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Sortable', kind: 'boolean', group: 'Behaviour', default: '=true' },
    { name: 'PageSize', kind: 'number', group: 'Layout', default: '=0' },
    { name: 'Striped', kind: 'boolean', group: 'Style', default: '=false' },
    { name: 'Dense', kind: 'boolean', group: 'Style', default: '=false' },
    { name: 'CardColumns', label: 'Phone card columns', kind: 'text', group: 'Layout', default: '=""', simple: false },
    { name: 'EmptyText', kind: 'text', group: 'Content', default: '="No data"' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedItems', initial: [] },
    { name: 'SortColumn', initial: '' },
    { name: 'SortOrder', initial: '' },
    { name: 'Page', initial: 1 },
    { name: 'SearchText', initial: '' },
    { name: 'VisibleCount', initial: 0 },
  ],
  defaultSize: { width: 640, height: 360 },
  primaryProp: 'Items',
  render: DataTableRender,
}

/* ------------------------------------------------------------------ List */

function ListRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const items = toRecords(props.Items)
  const titleF = toText(props.TitleField)
  const subF = toText(props.SubtitleField)
  const iconF = toText(props.IconField)
  const imgF = toText(props.ImageField)
  const trailF = toText(props.TrailingField)
  const selectable = toBool(props.Selectable, true)
  const dividers = toBool(props.Dividers, true)
  const selIdx = typeof outputs.SelectedIndex === 'number' ? outputs.SelectedIndex : null
  const emptyText = toText(props.EmptyText) || 'No items'

  if (items.length === 0) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <ListIcon className="size-6 opacity-60" strokeWidth={1.5} />
        <span className="text-sm">{emptyText}</span>
      </div>
    )
  }
  return (
    <div className={cn('size-full', design ? 'pointer-events-none overflow-hidden' : 'overflow-y-auto')}>
      {items.map((rec, i) => {
        const title = fieldText(rec, titleF)
        const sub = subF ? fieldText(rec, subF) : ''
        const trail = trailF ? fieldText(rec, trailF) : ''
        const img = imgF ? imageSource(fieldText(rec, imgF)) : ''
        const icon = iconF ? pick(rec, iconF) : undefined
        const active = selectable && selIdx === i + 1
        return (
          <div
            key={i}
            role={selectable ? 'button' : undefined}
            onClick={
              selectable && !design
                ? () => { setOutput('Selected', rec); setOutput('SelectedIndex', i + 1); fire('OnSelect') }
                : undefined
            }
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 transition-colors',
              dividers && i < items.length - 1 && 'border-b',
              selectable && 'cursor-pointer hover:bg-muted/50',
              active && 'bg-primary/10 shadow-[inset_3px_0_0_0_var(--primary)] hover:bg-primary/10',
            )}
          >
            {imgF !== '' ? (
              <AvatarCircle src={img} name={title} size="36px" />
            ) : iconF !== '' ? (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <DynIcon name={icon} className="size-4.5" />
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{title}</div>
              {sub !== '' && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
            </div>
            {trail !== '' && <div className="shrink-0 text-xs text-muted-foreground">{trail}</div>}
          </div>
        )
      })}
    </div>
  )
}

export const ListControl: ControlType = {
  type: 'List',
  label: 'List',
  icon: ListIcon,
  category: 'Data',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=[]' },
    { name: 'TitleField', kind: 'text', group: 'Data', default: '=""' },
    { name: 'SubtitleField', kind: 'text', group: 'Data', default: '=""' },
    { name: 'IconField', kind: 'text', group: 'Data', default: '=""', simple: false },
    { name: 'ImageField', kind: 'text', group: 'Data', default: '=""', simple: false },
    { name: 'TrailingField', kind: 'text', group: 'Data', default: '=""' },
    { name: 'Selectable', kind: 'boolean', group: 'Behaviour', default: '=true' },
    { name: 'Dividers', kind: 'boolean', group: 'Style', default: '=true' },
    { name: 'EmptyText', kind: 'text', group: 'Content', default: '="No items"' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedIndex', initial: null },
  ],
  defaultSize: { width: 360, height: 320 },
  primaryProp: 'Items',
  render: ListRender,
}
