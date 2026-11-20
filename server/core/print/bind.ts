/**
 * Data binding of print templates (docs/dev/pdf.md "Data and security"): loads the template's source AS THE GENERATING
 * IDENTITY (rows and columns it cannot read are simply absent), evaluates every formula with the server formula engine
 * and turns the template's blocks into resolved blocks for the layout engine.
 *
 *  - record source: the record (404 when the identity cannot read it), its related lists (child rows whose lookup points
 *    at it, with an optional delegable filter, sort and top), as `ThisRecord` / its fields by name, `Record`, `Related.<n>`;
 *  - query source: rows of a table with a delegable filter formula, sort and top, as `Rows`;
 *  - formula source: a formula returning a table (`Rows`) or a record (`Record` and its fields);
 *  - everywhere: `Company` (the letterhead), `User()`, `Now()`/`Today()` (fixed in tests), `ThisItem` inside tables,
 *    repeats and charts, and the functions FormatNumber, FormatCurrency, FormatPercent, FormatDate.
 *
 * A formula that fails prints blank and adds a warning to the generation log; a column the identity may not read prints
 * blank with a warning ("not an error": the same template serves people with different access). Lookups print the
 * target row's primary column (read with the identity's rights too).
 */
import type { FxEngine, FxRecord, FxScope, FxValue } from '../../../src/contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { ConditionV2, QueryPlan } from '../../../src/platform/query.ts'
import {
  PRINT_LIMITS, parseRichText, splitTemplateText, type Block, type CellFormat, type Letterhead, type PrintTemplateDoc, type RichParagraph, type TableColumn,
} from '../../../src/platform/print.ts'
import { formatCurrency, formatDate, formatNumber, formatPercent, formatValue, plainText, type FormatOptions } from '../../../src/platform/print-format.ts'
import { createEngine } from '../../../src/fx/engine.ts'
import { def, type FnDef } from '../../../src/fx/functions/types.ts'
import { analyze } from '../../../src/fx/query/index.ts'
import { isRecord } from '../../../src/fx/values.ts'
import { evaluate as evalFlowExpr, rowsToFx, src, type EvalEnv } from '../flows/expr.ts'
import { schemaOf } from '../event-fx.ts'
import { PAGE_COUNT, PAGE_NUMBER, type ImageRef, type RBlock, type RTableRow } from './layout.ts'
import { fromDataUrl, imageInfo } from './images.ts'
import { CHART_ROW_LIMIT, SINGLE_VALUE_KINDS, chartFromBlock, chartKind, type ChartBlockInput } from './chart.ts'

export class BindError extends Error {
  status: number
  constructor(message: string, status = 422) {
    super(message)
    this.status = status
  }
}

/** what binding needs from the platform (the service passes real ones; unit tests fakes) */
export interface BindData {
  tables: TableDef[]
  /** the identity's view of a table (column security applied) */
  visible(t: TableDef): TableDef
  /** Query v2 as the identity */
  query(t: TableDef, plan: QueryPlan): Promise<{ rows: Record<string, unknown>[]; nextCursor?: string | null }>
  /** an attachment's bytes when the identity may open it */
  attachment(id: string): Promise<{ bytes: Buffer; fileName: string } | null>
  /** formula reads (LookUp, Filter ...) as the identity */
  evalEnv: Omit<EvalEnv, 'engine'>
  user: { id: string; name: string; email: string }
}

export interface BindInput {
  doc: PrintTemplateDoc
  recordId?: string
  fmt: FormatOptions
  letterhead: Letterhead
  now: Date
  templateName: string
  maxRows: number
  maxImageBytes: number
  /** rows given by the caller (scheduled reports' automatic layout): Rows */
  presetRows?: Record<string, unknown>[]
}

export interface Bound {
  body: RBlock[]
  header: (page: number) => RBlock[]
  footer: (page: number) => RBlock[]
  images: Map<string, { bytes: Buffer; width: number; height: number }>
  warnings: string[]
  fileName: string
  title: string
  subject: string
  keywords: string
  recordLabel?: string
  /** the source's names (Record fields, Related, Rows, Company, User()) and the print engine: docx templates use them */
  scope: FxScope
  engine: FxEngine
  fmt: FormatOptions
}

const PATH_RE = /^\s*(?:(ThisItem|ThisRecord|Record)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$/

/** the print natives: formatting with the environment's settings, a fixed clock */
function printEngine(fmt: FormatOptions, now: Date): FxEngine {
  const natives: FnDef[] = [
    def('Now', 'Now()', 'The date and time of the generation.', 0, 0, () => now),
    def('Today', 'Today()', 'The date of the generation.', 0, 0, () => new Date(now.getFullYear(), now.getMonth(), now.getDate())),
    def('FormatNumber', 'FormatNumber(value [, decimals])', 'A number with the environment\'s digit grouping (Indian 12,34,567 or international 1,234,567).', 1, 2, (c) => formatNumber(c.value(0), c.argc > 1 ? c.num(1) : undefined, fmt)),
    def('FormatCurrency', 'FormatCurrency(value [, currency [, decimals]])', 'An amount with the currency symbol and grouping, e.g. ₹12,34,567.00.', 1, 3, (c) => formatCurrency(c.value(0), fmt, c.argc > 2 ? c.num(2) : 2, c.argc > 1 ? c.text(1) : undefined)),
    def('FormatPercent', 'FormatPercent(value [, decimals])', 'A fraction (0.785) or a percentage (78.5) as 78.5%.', 1, 2, (c) => formatPercent(c.value(0), fmt, c.argc > 1 ? c.num(1) : 1)),
    def('FormatDate', 'FormatDate(value [, pattern])', 'A date in the environment\'s date format, or a pattern such as "d MMM yyyy HH:mm".', 1, 2, (c) => formatDate(c.value(0), c.argc > 1 ? c.text(1) : fmt.dateFormat, fmt.timeZone, c.argc < 2 && c.value(0) instanceof Date && !isMidnight(c.value(0) as Date))),
  ]
  return createEngine({}, natives)
}
const isMidnight = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0

export const PRINT_FUNCTIONS = ['FormatNumber', 'FormatCurrency', 'FormatPercent', 'FormatDate']

interface Scope {
  record: FxRecord | null
  related: FxRecord
  rows: FxRecord[] | null
  item: FxValue | undefined
  company: FxRecord
  user: FxRecord
  extra?: Record<string, FxValue>
}

export async function bindTemplate(inp: BindInput, data: BindData): Promise<Bound> {
  const warnings = new Set<string>()
  const warn = (m: string) => { if (warnings.size < 200) warnings.add(m) }
  const engine = printEngine(inp.fmt, inp.now)
  const env: EvalEnv = { ...data.evalEnv, engine }
  const tableByName = (n: string): TableDef | undefined => data.tables.find((t) => t.name === n || t.id === n) ?? data.tables.find((t) => t.name.toLowerCase() === n.toLowerCase())
  const tableNames = new Set(data.tables.map((t) => t.name))
  /** hidden columns per table (for the warning when a formula names one) */
  const hidden = new Map<string, string[]>()
  const images = new Map<string, { bytes: Buffer; width: number; height: number }>()
  let imageBytes = 0

  /* ---------------------------------------------------------------- loading rows as the identity */

  async function readRows(t: TableDef, filter: ConditionV2 | undefined, sort: QueryPlan['sort'], top: number): Promise<FxRecord[]> {
    const vis = data.visible(t)
    hidden.set(t.name, t.columns.filter((c) => !vis.columns.some((v) => v.name === c.name)).map((c) => c.name))
    const out: Record<string, unknown>[] = []
    let cursor: string | undefined
    const limit = Math.min(top, inp.maxRows)
    for (let i = 0; i < 1000 && out.length < limit; i++) {
      const plan: QueryPlan = { version: 2, table: t.name, ...(filter ? { filter } : {}), ...(sort?.length ? { sort } : {}), take: { n: limit, from: 'start' }, page: { size: Math.min(500, limit - out.length), ...(cursor ? { cursor } : {}) } }
      const res = await data.query(t, plan)
      out.push(...res.rows)
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }
    if (top > inp.maxRows && out.length >= inp.maxRows) warn(`${t.displayName || t.name}: only the first ${inp.maxRows.toLocaleString('en')} rows are printed (the limit of this server).`)
    const recs = rowsToFx(vis, out)
    // hidden columns are present and blank, so formulas naming them print blank instead of failing
    for (const r of recs) for (const h of hidden.get(t.name) ?? []) if (!(h in r)) r[h] = null
    await expandLookups(vis, recs)
    return recs
  }

  /** lookup cells become {id, <primary column>, __display}: they print as the target's name */
  async function expandLookups(t: TableDef, recs: FxRecord[]): Promise<void> {
    for (const c of t.columns) {
      if (c.type !== 'lookup' || !c.lookupTable) continue
      const target = tableByName(c.lookupTable)
      if (!target) continue
      const ids = [...new Set(recs.map((r) => r[c.name]).filter((v): v is string => typeof v === 'string' && !!v))]
      if (!ids.length) continue
      const prim = target.primaryColumn || 'id'
      const found = new Map<string, Record<string, unknown>>()
      for (let i = 0; i < ids.length; i += 500) {
        try {
          const res = await data.query(target, { version: 2, table: target.name, filter: { col: 'id', op: 'in', value: ids.slice(i, i + 500) }, page: { size: 500 } })
          for (const row of res.rows) found.set(String(row.id), row)
        } catch {
          // a lookup table the identity cannot read: the ids stay as they are
          return
        }
      }
      const tv = data.visible(target)
      for (const r of recs) {
        const id = r[c.name]
        if (typeof id !== 'string') continue
        const row = found.get(id)
        if (!row) continue
        const rec = rowsToFx(tv, [row])[0]
        rec.__display = plainText(rec[prim] ?? id, inp.fmt)
        r[c.name] = rec
      }
    }
  }

  /** a delegable filter formula over a table -> a Query v2 condition */
  function filterOf(t: TableDef, formula: string | undefined, what: string): ConditionV2 | undefined {
    if (!formula?.trim()) return undefined
    const a = analyze(`=Filter(${t.name}, ${formula.replace(/^\s*=/, '')})`, schemaOf(data.tables), { engine, clientRowLimit: 5000 })
    const err = a.diagnostics.find((d) => d.severity === 'error')
    if (err || a.plans.length !== 1 || a.residual) throw new BindError(`${what}: ${err?.message ?? 'the filter must be readable in the database (delegable).'}`)
    return a.plans[0].plan.filter
  }
  const sortOf = (s?: { column: string; descending?: boolean }[]) => s?.map((x) => ({ col: x.column, dir: x.descending ? 'desc' as const : 'asc' as const }))

  /* ---------------------------------------------------------------- the source */

  const company: FxRecord = {
    Name: inp.letterhead.companyName || '', Address: inp.letterhead.address ?? '', Phone: inp.letterhead.phone ?? '', Email: inp.letterhead.email ?? '',
    Website: inp.letterhead.website ?? '', GSTIN: inp.letterhead.gstin ?? '',
  }
  const user: FxRecord = { Id: data.user.id, FullName: data.user.name, Email: data.user.email, Name: data.user.name }
  const base: Scope = { record: null, related: {}, rows: null, item: undefined, company, user }
  const s = inp.doc.source
  let recordTable: TableDef | null = null
  if (s.kind === 'record') {
    const t = tableByName(s.table)
    if (!t) throw new BindError(`The table "${s.table}" of this template does not exist here.`)
    recordTable = t
    if (!inp.recordId) throw new BindError('Choose the record to print.')
    const rows = await readRows(t, { col: 'id', op: 'eq', value: inp.recordId }, undefined, 1)
    if (!rows.length) throw new BindError('The record was not found, or you may not read it.', 404)
    base.record = rows[0]
    for (const r of s.related ?? []) {
      const ct = tableByName(r.table)
      if (!ct) { warn(`Related list ${r.name}: the table "${r.table}" does not exist here.`); base.related[r.name] = []; continue }
      if (!data.visible(ct).columns.some((c) => c.name === r.column)) { warn(`Related list ${r.name}: you may not read the column ${r.column} of ${ct.displayName || ct.name}; the list is empty.`); base.related[r.name] = []; continue }
      const byParent: ConditionV2 = { col: r.column, op: 'eq', value: inp.recordId }
      const extra = filterOf(ct, r.filter, `Related list ${r.name}`)
      try {
        base.related[r.name] = await readRows(ct, extra ? { and: [byParent, extra] } : byParent, sortOf(r.sort), Math.min(r.top ?? 1000, 10_000))
      } catch (e) {
        const st = (e as { status?: number }).status
        if (st === 403 || st === 404) { warn(`Related list ${r.name}: you may not read ${ct.displayName || ct.name}; the list is empty.`); base.related[r.name] = [] }
        else throw e
      }
    }
  } else if (s.kind === 'query') {
    const t = tableByName(s.table)
    if (!t) throw new BindError(`The table "${s.table}" of this template does not exist here.`)
    base.rows = await readRows(t, filterOf(t, s.filter, 'The query filter'), sortOf(s.sort), Math.min(s.top ?? 5000, PRINT_LIMITS.maxRows))
  } else if (inp.presetRows) {
    base.rows = inp.presetRows.map((r) => ({ ...(r as FxRecord) }))
  } else if (s.kind === 'formula') {
    const v = await fx(s.formula, base, 'The source formula', true)
    if (Array.isArray(v)) base.rows = v.filter(isRecord) as FxRecord[]
    else if (isRecord(v)) base.record = v as FxRecord
    else base.rows = []
  }

  /* ---------------------------------------------------------------- formulas */

  function scopeOf(sc: Scope): FxScope {
    return {
      resolve(name) {
        switch (name) {
          case 'ThisRecord': case 'Record': return sc.record ?? undefined
          case 'Related': return sc.related
          case 'Rows': return sc.rows ?? []
          case 'ThisItem': return sc.item
          case 'Company': return sc.company
          case 'User()': return sc.user
        }
        if (sc.extra && name in sc.extra) return sc.extra[name]
        if (isRecord(sc.item) && name in (sc.item as FxRecord)) return (sc.item as FxRecord)[name]
        if (sc.record && name in sc.record) return sc.record[name]
        if (tableNames.has(name)) return []
        return undefined
      },
    }
  }

  const kinds = new Map<string, 'path' | 'pure' | 'reads'>()
  function checkHidden(formula: string, label: string) {
    for (const [tn, cols] of hidden) for (const c of cols) {
      if (new RegExp(`(^|[^A-Za-z0-9_'"])${c}($|[^A-Za-z0-9_])`).test(formula)) warn(`${label}: the column ${c} of ${tn} is not visible to ${data.user.name}; it prints blank.`)
    }
  }

  async function fx(formula: string, sc: Scope, label: string, strict = false): Promise<FxValue> {
    const f = formula.trim()
    if (!f) return null
    const pm = PATH_RE.exec(f)
    if (pm) {
      // plain field paths: no engine round trip (tables of thousands of rows)
      const field = pm[2]
      const holder = pm[1] === 'ThisItem' ? sc.item : pm[1] ? sc.record : undefined
      if (pm[1] && isRecord(holder) && field in (holder as FxRecord)) { checkHidden(f, label); return (holder as FxRecord)[field] }
      if (pm[1] && isRecord(holder) && !field.startsWith('__')) {
        // a misspelt column prints blank: say so (the formula engine reads a missing field as blank silently)
        warn(`${label}: ${pm[1]} has no column ${field} (printed blank)`)
        return null
      }
      if (!pm[1]) {
        if (sc.extra && field in sc.extra) return sc.extra[field]
        if (isRecord(sc.item) && field in (sc.item as FxRecord)) { checkHidden(f, label); return (sc.item as FxRecord)[field] }
        if (sc.record && field in sc.record) { checkHidden(f, label); return sc.record[field] }
      }
    }
    checkHidden(f, label)
    let kind = kinds.get(f)
    if (!kind) {
      const a = analyze(src(f), schemaOf(data.tables), { scope: scopeOf(sc), engine, clientRowLimit: 5000 })
      kind = a.plans.length ? 'reads' : 'pure'
      kinds.set(f, kind)
    }
    if (kind === 'pure') {
      const r = engine.evaluate(src(f), scopeOf(sc))
      if (r.ok) return r.value
      if (strict) throw new BindError(`${label}: ${r.error.message}`)
      warn(`${label}: ${r.error.message} (printed blank)`)
      return null
    }
    const r = await evalFlowExpr(f, scopeOf(sc), env)
    if (r.ok) return r.value
    const msg = r.error.replace(/ for a flow/g, ' for a print template').replace(/a flow/g, 'a print template')
    if (strict) throw new BindError(`${label}: ${msg}`)
    warn(`${label}: ${msg} (printed blank)`)
    return null
  }

  const asText = (v: FxValue): string => (isRecord(v) && typeof (v as FxRecord).__display === 'string' ? String((v as FxRecord).__display) : plainText(v, inp.fmt))

  /** a text property with {formula} parts; page tokens become placeholders */
  async function text(t: string | undefined, sc: Scope, label: string): Promise<string> {
    if (!t) return ''
    let out = ''
    for (const part of splitTemplateText(t)) {
      if ('lit' in part) { out += part.lit; continue }
      const name = part.fx.trim()
      if (name === 'PageNumber') { out += PAGE_NUMBER; continue }
      if (name === 'PageCount') { out += PAGE_COUNT; continue }
      out += asText(await fx(part.fx, sc, label))
    }
    return out
  }

  /** rich text: formulas first (their values are not parsed as markup), then the markup */
  async function rich(t: string, sc: Scope, label: string): Promise<RichParagraph[]> {
    const values: string[] = []
    let marked = ''
    for (const part of splitTemplateText(t)) {
      if ('lit' in part) { marked += part.lit; continue }
      const name = part.fx.trim()
      const v = name === 'PageNumber' ? PAGE_NUMBER : name === 'PageCount' ? PAGE_COUNT : asText(await fx(part.fx, sc, label))
      values.push(v)
      marked += `${values.length - 1}`
    }
    const paras = parseRichText(marked)
    for (const p of paras) for (const r of p.runs) r.text = r.text.replace(/(\d+)/g, (_m, i) => values[Number(i)] ?? '')
    return paras
  }

  async function rowsOf(formula: string, sc: Scope, label: string): Promise<FxRecord[]> {
    const v = await fx(formula, sc, label)
    if (v === null || v === undefined) return []
    if (Array.isArray(v)) return (v.filter(isRecord) as FxRecord[]).slice(0, inp.maxRows)
    if (isRecord(v)) return [v as FxRecord]
    warn(`${label}: the formula does not return rows.`)
    return []
  }

  async function addImage(bytes: Buffer, label: string, caption?: string): Promise<ImageRef | null> {
    const info = imageInfo(bytes)
    if (!info) { warn(`${label}: only PNG and JPEG images can be printed; one image was left out.`); return null }
    if (bytes.length > inp.maxImageBytes) { warn(`${label}: an image is larger than ${Math.round(inp.maxImageBytes / 1048576)} MB and was left out.`); return null }
    if (imageBytes + bytes.length > PRINT_LIMITS.maxImagesMB * 1048576) { warn(`${label}: the images of this document are larger than ${PRINT_LIMITS.maxImagesMB} MB together; the rest were left out.`); return null }
    const { createHash } = await import('node:crypto')
    const key = createHash('sha1').update(bytes).digest('hex')
    if (!images.has(key)) { images.set(key, { bytes, width: info.width, height: info.height }); imageBytes += bytes.length }
    return { key, width: info.width, height: info.height, ...(caption ? { caption } : {}) }
  }

  function attachmentIdsOf(v: FxValue): string[] {
    const out: string[] = []
    const add = (x: unknown) => {
      if (x === null || x === undefined) return
      if (Array.isArray(x)) { for (const y of x) add(y); return }
      if (typeof x === 'string') {
        const s2 = x.trim()
        if (s2.startsWith('[')) { try { add(JSON.parse(s2)) } catch { /* not a list */ } return }
        if (s2) out.push(s2)
        return
      }
      if (isRecord(x as FxValue)) {
        const r = x as Record<string, unknown>
        add(r.id ?? r.Id ?? r.attachmentId ?? r.Value ?? null)
      }
    }
    add(v)
    return [...new Set(out)].slice(0, 60)
  }

  /* ---------------------------------------------------------------- blocks */

  const fmtCell = (v: FxValue, f: CellFormat | undefined, d?: number) => (f && f !== 'text' ? formatValue(v, f, inp.fmt, d) : asText(v))
  const num = (v: FxValue): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)

  async function table(b: Extract<Block, { kind: 'table' }>, sc: Scope, label: string): Promise<RBlock> {
    const rows = await rowsOf(b.rows, sc, `${label} rows`)
    const cols = b.columns
    const out: RTableRow[] = []
    const values: FxValue[][] = []
    const groups: { key: string; rows: number[] }[] = []
    for (const [i, r] of rows.entries()) {
      const rs: Scope = { ...sc, item: r }
      const vals: FxValue[] = []
      for (const [j, c] of cols.entries()) vals.push(await fx(c.value, rs, `${label}, column ${c.header || j + 1}`))
      values.push(vals)
      if (b.groupBy?.trim()) {
        const k = asText(await fx(b.groupBy, rs, `${label} group`))
        const g = groups.find((x) => x.key === k)
        if (g) g.rows.push(i)
        else groups.push({ key: k, rows: [i] })
      }
    }
    const agg = (idx: number[], c: TableColumn, j: number): string => {
      const nums = idx.map((i) => num(values[i][j])).filter((x): x is number => x !== null)
      switch (c.total) {
        case 'sum': return fmtCell(nums.reduce((a, x) => a + x, 0), c.format ?? 'number', c.decimals)
        case 'avg': return nums.length ? fmtCell(nums.reduce((a, x) => a + x, 0) / nums.length, c.format ?? 'number', c.decimals ?? (c.format && c.format !== 'number' ? undefined : 2)) : ''
        case 'min': return nums.length ? fmtCell(Math.min(...nums), c.format ?? 'number', c.decimals) : ''
        case 'max': return nums.length ? fmtCell(Math.max(...nums), c.format ?? 'number', c.decimals) : ''
        case 'count': return formatNumber(idx.length, 0, inp.fmt)
        case 'label': return c.totalLabel ?? 'Total'
        default: return ''
      }
    }
    const rowOf = (i: number): RTableRow => ({ kind: 'row', cells: cols.map((c, j) => fmtCell(values[i][j], c.format, c.decimals)) })
    const hasTotals = cols.some((c) => c.total)
    if (groups.length) {
      for (const g of groups) {
        const header = await text(b.groupHeader || '{Group}', { ...sc, extra: { Group: g.key, Count: g.rows.length } }, `${label} group header`)
        out.push({ kind: 'group', cells: [header] })
        for (const i of g.rows) out.push(rowOf(i))
        if (b.subtotals && hasTotals) out.push({ kind: 'subtotal', cells: cols.map((c, j) => (c.total === 'label' ? 'Subtotal' : agg(g.rows, c, j))) })
      }
    } else for (let i = 0; i < rows.length; i++) out.push(rowOf(i))
    if (b.totals && hasTotals && rows.length) out.push({ kind: 'total', cells: cols.map((c, j) => agg(rows.map((_, i) => i), c, j)) })
    return {
      k: 'table', columns: cols.map((c) => ({ header: c.header, ...(c.width ? { width: c.width } : {}), ...(c.flex ? { flex: c.flex } : {}), align: c.align ?? (['number', 'integer', 'currency', 'percent'].includes(c.format ?? '') ? 'right' : 'left') })),
      rows: out, repeatHeader: b.repeatHeader !== false, style: b.style ?? inp.doc.styles.tableStyle, ...(b.fontSize ? { fontSize: b.fontSize } : {}),
      avoidRowBreak: b.avoidRowBreak !== false, emptyText: b.emptyText ?? 'No rows.',
    }
  }

  async function approvals(b: Extract<Block, { kind: 'approvals' }>, sc: Scope, label: string): Promise<RBlock[]> {
    const out: RBlock[] = []
    if (b.title) out.push({ k: 'heading', text: await text(b.title, sc, label), level: 3, align: 'left' })
    const reqT = tableByName('sys_approval_requests') ?? data.tables.find((t) => t.id === 'sys_approval_requests')
    const histT = data.tables.find((t) => t.id === 'sys_approval_history')
    const id = sc.record?.id ?? sc.record?.__id
    const empty = (): RBlock => ({ k: 'text', paras: [{ runs: [{ text: b.emptyText ?? 'No approvals.', italic: true }] }], align: 'left' })
    if (!reqT || !histT || typeof id !== 'string') { out.push(empty()); return out }
    try {
      const reqs = await readRows(reqT, { col: 'regardingId', op: 'eq', value: id.toLowerCase() }, [{ col: 'createdOn', dir: 'asc' }], 50)
      if (!reqs.length) { out.push(empty()); return out }
      const hist = await readRows(histT, { col: 'Request', op: 'in', value: reqs.map((r) => String(r.id)) }, [{ col: 'createdOn', dir: 'asc' }], 1000)
      const title = new Map(reqs.map((r) => [String(r.id), plainText(r.Title, inp.fmt)]))
      const reqId = (v: FxValue) => (isRecord(v) ? String((v as FxRecord).id ?? '') : String(v ?? ''))
      // the history's details are JSON: the answer and its comment are what a reader wants; bookkeeping entries are left out
      const detail = (v: FxValue): Record<string, unknown> => {
        if (isRecord(v)) return v as Record<string, unknown>
        try { const o = JSON.parse(String(v ?? '')); return o && typeof o === 'object' ? o : {} } catch { return {} }
      }
      const SHOWN = new Set(['requested', 'responded', 'decided', 'delegated', 'reassigned', 'escalated', 'cancelled', 'expired', 'info', 'resubmitted'])
      const rows: RTableRow[] = hist.filter((h) => SHOWN.has(String(h.Action ?? ''))).map((h) => {
        const d = detail(h.Details)
        const action = String(h.Action) === 'responded' && d.response ? String(d.response) : String(h.Action) === 'decided' && d.outcome ? `decided: ${String(d.outcome)}` : asText(h.Action)
        const comment = typeof d.comment === 'string' ? d.comment : typeof d.reason === 'string' ? d.reason : ''
        return { kind: 'row' as const, cells: [formatValue(h.createdOn, 'datetime', inp.fmt), title.get(reqId(h.Request)) ?? '', h.Stage === null || h.Stage === undefined ? '' : String(h.Stage), action, asText(h.Actor), comment] }
      })
      for (const r of reqs) rows.push({ kind: 'total', cells: ['Status', title.get(String(r.id)) ?? '', '', asText(r.Status), r.Outcome ? asText(r.Outcome) : '', r.CompletedOn ? formatValue(r.CompletedOn, 'datetime', inp.fmt) : ''] })
      out.push({
        k: 'table', columns: [{ header: 'When', width: 32, align: 'left' }, { header: 'Request', flex: 2, align: 'left' }, { header: 'Stage', width: 13, align: 'center' }, { header: 'Action', width: 32, align: 'left' }, { header: 'By', flex: 1.5, align: 'left' }, { header: 'Comment', flex: 2, align: 'left' }],
        rows, repeatHeader: true, style: 'lines', avoidRowBreak: true, emptyText: b.emptyText ?? 'No approvals.',
      })
    } catch (e) {
      warn(`${label}: the approval history could not be read (${(e as Error).message}).`)
      out.push(empty())
    }
    return out
  }

  async function blocks(list: Block[], sc: Scope, where: string): Promise<RBlock[]> {
    const out: RBlock[] = []
    for (const b of list) {
      const label = `${where} ${b.kind} "${b.id}"`
      if (b.visible?.trim()) {
        const v = await fx(b.visible, sc, `${label} visible`)
        if (v === false || v === null || v === 0 || v === '') continue
      }
      const common = { ...(b.spaceBefore !== undefined ? { spaceBefore: b.spaceBefore } : {}), ...(b.spaceAfter !== undefined ? { spaceAfter: b.spaceAfter } : {}), ...(b.keepTogether ? { keepTogether: true } : {}) }
      switch (b.kind) {
        case 'heading': out.push({ ...common, k: 'heading', text: await text(b.text, sc, label), level: b.level, align: b.align ?? 'left', ...(b.color ? { color: b.color } : {}) }); break
        case 'text': out.push({ ...common, k: 'text', paras: await rich(b.text, sc, label), align: b.align ?? 'left', ...(b.size ? { size: b.size } : {}), ...(b.color ? { color: b.color } : {}) }); break
        case 'keyValue': {
          const items: { label: string; value: string }[] = []
          for (const it of b.items ?? []) items.push({ label: await text(it.label, sc, label), value: fmtCell(await fx(it.value, sc, `${label} ${it.label}`), it.format, it.decimals) })
          out.push({ ...common, k: 'kv', items, columns: b.columns ?? 2, ...(b.labelWidth ? { labelWidth: b.labelWidth } : {}), boxed: !!b.boxed })
          break
        }
        case 'table': out.push({ ...common, ...(await table(b, sc, label)) }); break
        case 'approvals': {
          const r = await approvals(b, sc, label)
          if (r.length) Object.assign(r[0], common)
          out.push(...r)
          break
        }
        case 'repeat': {
          const rows = await rowsOf(b.rows, sc, `${label} rows`)
          for (const [i, r] of rows.entries()) {
            if (i > 0 && b.pageBreakBetween) out.push({ k: 'pageBreak' })
            out.push(...(await blocks(b.blocks ?? [], { ...sc, item: r }, `${where} ${b.id}#${i + 1}`)))
          }
          break
        }
        case 'columns': {
          const cols: { width?: number; blocks: RBlock[] }[] = []
          for (const c of b.columns) cols.push({ ...(c.width ? { width: c.width } : {}), blocks: await blocks(c.blocks ?? [], sc, where) })
          out.push({ ...common, k: 'columns', cols, gap: b.gap ?? 6 })
          break
        }
        case 'image': {
          const refs: ImageRef[] = []
          const caption = b.caption ? await text(b.caption, sc, label) : undefined
          if (b.source === 'logo') {
            const bytes = inp.letterhead.logo ? fromDataUrl(inp.letterhead.logo) : null
            if (bytes) { const r = await addImage(bytes, label, caption); if (r) refs.push(r) }
          } else if (b.source === 'static') {
            const bytes = b.data ? fromDataUrl(b.data) : null
            if (bytes) { const r = await addImage(bytes, label, caption); if (r) refs.push(r) }
          } else {
            for (const id of attachmentIdsOf(await fx(b.value ?? '', sc, label))) {
              const a = await data.attachment(id)
              if (!a) { warn(`${label}: an image is not available to ${data.user.name} and was left out.`); continue }
              const r = await addImage(a.bytes, label, caption)
              if (r) refs.push(r)
            }
          }
          if (refs.length) out.push({ ...common, k: 'image', images: refs, ...(b.width ? { width: b.width } : {}), ...(b.height ? { height: b.height } : {}), align: b.align ?? 'left', perRow: b.perRow ?? 3 })
          break
        }
        case 'barcode': {
          const t = asText(await fx(b.value, sc, label)).trim()
          if (!t) { warn(`${label}: the barcode text is blank; nothing was printed.`); break }
          if (b.symbology === 'code128' && !/^[\x20-\x7e]+$/.test(t)) { out.push({ ...common, k: 'notice', text: `[Code 128 cannot encode "${t.slice(0, 40)}": use a QR code]` }); warn(`${label}: Code 128 holds printable ASCII only.`); break }
          if (b.symbology === 'qr' && Buffer.byteLength(t) > 1200) { warn(`${label}: the QR text is longer than 1,200 bytes; nothing was printed.`); break }
          out.push({ ...common, k: 'barcode', symbology: b.symbology, text: t, ...(b.width ? { width: b.width } : {}), ...(b.height ? { height: b.height } : {}), showText: b.showText !== false && b.symbology === 'code128' ? true : !!b.showText, align: b.align ?? 'left' })
          break
        }
        case 'chart': {
          // the block -> the dashboards' ChartSpec and rows (chart.ts); drawn by renderChartSvg in the layout
          const cb = b as unknown as ChartBlockInput
          const kind = chartKind(cb.chartType)
          const defs = Array.isArray(cb.values) ? cb.values : []
          const single: FxValue[] = []
          const rowsIn: { label: string; values: FxValue[] }[] = []
          if (SINGLE_VALUE_KINDS.includes(kind)) {
            for (const x of defs.slice(0, 2)) single.push(await fx(x.value ?? '', sc, label))
          } else {
            const rows = await rowsOf(b.rows ?? '', sc, `${label} rows`)
            for (const r of rows.slice(0, CHART_ROW_LIMIT(kind))) {
              const rs: Scope = { ...sc, item: r }
              const values: FxValue[] = []
              for (const x of defs) values.push(await fx(x.value ?? '', rs, label))
              rowsIn.push({ label: b.label ? asText(await fx(b.label, rs, label)) : '', values })
            }
          }
          const chart = chartFromBlock(cb, {
            ...(b.title ? { title: await text(b.title, sc, label) } : {}),
            rows: rowsIn, single, asText: (v) => asText(v as FxValue), now: inp.now,
            grouping: inp.fmt.grouping, currency: inp.fmt.currency, timeZone: inp.fmt.timeZone,
          })
          out.push({ ...common, k: 'chart', chart, height: b.height ?? 60 })
          break
        }
        case 'signature': {
          const labels: string[] = []
          for (const l of b.labels ?? []) labels.push(await text(l, sc, label))
          out.push({ ...common, k: 'signature', labels, showDate: !!b.showDate })
          break
        }
        case 'spacer': out.push({ ...common, k: 'spacer', h: b.height ?? 5 }); break
        case 'line': out.push({ ...common, k: 'line', thickness: b.thickness ?? 0.6, color: b.color ?? '#cbd5e1', dashed: !!b.dashed }); break
        case 'pageBreak': out.push({ k: 'pageBreak' }); break
      }
    }
    return out
  }

  /* ---------------------------------------------------------------- header, footer, letterhead */

  const body = await blocks(inp.doc.body, base, 'Body')
  const lh = inp.letterhead
  const letterheadBlocks: RBlock[] = []
  if (lh.companyName || lh.logo) {
    const lines = [lh.address, [lh.phone, lh.email, lh.website].filter(Boolean).join('  ·  '), lh.gstin ? `GSTIN: ${lh.gstin}` : ''].filter(Boolean).join('\n')
    const textCol: RBlock[] = [
      ...(lh.companyName ? [{ k: 'text' as const, paras: [{ runs: [{ text: lh.companyName, bold: true }] }], align: 'right' as const, size: 13, color: '#0f172a', spaceAfter: 0.5 }] : []),
      ...(lines ? [{ k: 'text' as const, paras: [{ runs: [{ text: lines }] }], align: 'right' as const, size: 7.5, color: '#475569', spaceAfter: 0 }] : []),
    ]
    const logoBytes = lh.logo ? fromDataUrl(lh.logo) : null
    const logo = logoBytes ? await addImage(logoBytes, 'Letterhead logo') : null
    letterheadBlocks.push(logo
      ? { k: 'columns', cols: [{ width: 45, blocks: [{ k: 'image', images: [logo], height: 14, align: 'left', perRow: 1, spaceAfter: 0 }] }, { blocks: textCol }], gap: 6, spaceAfter: 0 }
      : { k: 'columns', cols: [{ blocks: textCol }], gap: 0, spaceAfter: 0 })
    letterheadBlocks.push({ k: 'line', thickness: 1, color: lh.color && /^#[0-9a-fA-F]{6}$/.test(lh.color) ? lh.color : inp.doc.styles.accent, dashed: false, spaceAfter: 0 })
  }
  const headerBlocks = await blocks(inp.doc.header.blocks ?? [], base, 'Header')
  const footerBlocks = await blocks(inp.doc.footer.blocks ?? [], base, 'Footer')
  const lcr = async (hf: { left?: string; center?: string; right?: string }, pageNumbers: boolean, where: string): Promise<RBlock[]> => {
    const l = await text(hf.left, base, where)
    const c = await text(hf.center, base, where)
    let r = await text(hf.right, base, where)
    if (pageNumbers && !r) r = `Page ${PAGE_NUMBER} of ${PAGE_COUNT}`
    if (!l && !c && !r) return []
    const t = (s: string, align: 'left' | 'center' | 'right'): RBlock => ({ k: 'text', paras: [{ runs: [{ text: s }] }], align, size: 7.5, color: '#64748b', spaceAfter: 0 })
    return [{ k: 'columns', cols: [{ blocks: l ? [t(l, 'left')] : [] }, { blocks: c ? [t(c, 'center')] : [] }, { blocks: r ? [t(r, 'right')] : [] }], gap: 4, spaceAfter: 0 }]
  }
  const headerLine = await lcr(inp.doc.header, false, 'Header')
  const footerLine = await lcr(inp.doc.footer, inp.doc.footer.pageNumbers !== false, 'Footer')
  const mode = inp.doc.header.letterhead ?? 'first'

  const recordLabel = recordTable && base.record ? asText(base.record[recordTable.primaryColumn || 'id'] ?? base.record.id) : undefined
  const fileName = (await text(inp.doc.fileName || (recordLabel ? `${inp.templateName} ${recordLabel}` : inp.templateName), base, 'File name')).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 120) || 'document'
  const meta = inp.doc.metadata ?? {}
  return {
    body,
    header: (p) => [...(mode === 'all' || (mode === 'first' && p === 0) ? letterheadBlocks : []), ...headerLine, ...headerBlocks],
    footer: () => [...footerBlocks, ...footerLine],
    images, warnings: [...warnings], fileName,
    title: meta.title ? await text(meta.title, base, 'Title') : fileName,
    subject: meta.subject ? await text(meta.subject, base, 'Subject') : '',
    keywords: meta.keywords ? await text(meta.keywords, base, 'Keywords') : '',
    ...(recordLabel ? { recordLabel } : {}),
    scope: scopeOf(base), engine, fmt: inp.fmt,
  }
}
