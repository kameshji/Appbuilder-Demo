/**
 * Auto apps (P2 package D): what the generator will make of a set of tables, before any UI component exists. The
 * dialog shows this plan (screens, fields, related lists, and everything it cannot handle); `generate.ts` builds the
 * app definition from it. Pure: no React, no DOM, no platform access.
 */
import type { ColumnDef, ColumnType, TableDef } from '../platform/contracts.ts'
import { isEnumName } from './names.ts'

export type AutoDevice = 'desktop' | 'phone'

export interface AutoAppOptions {
  /** app name (the dialog's Name field) */
  name: string
  /** desktop = 1920x1080, phone = 360x800; `width` / `height` override (Start with data passes any design size) */
  device: AutoDevice
  width?: number
  height?: number
  /** names of the tables to build screens for, in order; the first one is the main table */
  tables: string[]
  /**
   * tables the maker may read (by name); default: all. Related lists and lookups to other tables are only made for
   * readable tables; the rest are listed as issues.
   */
  readable?: (table: TableDef) => boolean
  /** id generator for UI components (tests pass a counter); default random */
  newId?: () => string
}

export type IssueLevel = 'blocked' | 'skipped' | 'limited' | 'note'

/** something the generator cannot do, or does only partly; shown in the dialog, never silently skipped */
export interface AutoIssue {
  level: IssueLevel
  table: string
  column?: string
  message: string
}

export interface RelatedPlan {
  /** the child table (it has a lookup column pointing at this table) */
  table: TableDef
  /** the child's lookup column */
  column: ColumnDef
  /** tab / heading text, e.g. "Orders" or "Orders (Bill to)" when the child has several lookups to this table */
  label: string
  /** the child also gets screens in this app (rows open its detail screen; "+ Add" creates a child row) */
  inApp: boolean
}

export interface ParentLink {
  column: ColumnDef
  table: TableDef
}

export interface TablePlan {
  table: TableDef
  /** read-only table (projection, read-only connection): no New, no Delete, the form only shows */
  readOnly: boolean
  /** column shown as the record's title */
  titleColumn: ColumnDef | null
  /** columns of the list (DataTable Columns), in order */
  listColumns: ColumnDef[]
  /** columns of a phone card (DataTable CardColumns): title, subtitle, lines */
  cardColumns: ColumnDef[]
  /** fields of the form, in order (Form Fields) */
  formFields: ColumnDef[]
  /** columns left out of the form and why (system columns) */
  leftOut: { column: ColumnDef; reason: string }[]
  /** a search box over the list (the table has a text column) */
  search: boolean
  /** newest first: the table has createdOn */
  sortNewest: boolean
  related: RelatedPlan[]
  /** lookups of this table to other tables of the app: "Open <parent>" buttons on desktop */
  parents: ParentLink[]
  /** a record timeline (comments, activities, history) from the core data model */
  timeline: boolean
  /** deletes can be undone (the table keeps deleted rows) */
  undo: boolean
  recycleDays: number
}

export interface AutoAppPlan {
  name: string
  width: number
  height: number
  /** wide: list and detail side by side panels (desktop, landscape); compact: one column (phone, portrait) */
  layout: 'wide' | 'compact'
  tables: TablePlan[]
  /** a home screen with a tile per table (several tables) */
  home: boolean
  /** every table the app reads (data sources): the chosen ones, related child tables, lookup targets */
  dataSources: string[]
  issues: AutoIssue[]
  /** the screens that will be created, for the preview */
  screens: { name: string; what: string }[]
}

export const SIZES: Record<AutoDevice, { w: number; h: number }> = {
  desktop: { w: 1920, h: 1080 },
  phone: { w: 360, h: 800 },
}

const TEXTISH: ColumnType[] = ['text', 'email', 'phone', 'url']
const NUMBERISH: ColumnType[] = ['number', 'decimal', 'currency']
const KNOWN: ColumnType[] = ['text', 'multiline', 'email', 'url', 'phone', 'number', 'decimal', 'currency', 'boolean', 'date', 'datetime', 'choice', 'lookup', 'image', 'autonumber', 'file']

/** order of a field in the form: by kind (short text first, long text and files last) */
function fieldRank(c: ColumnDef): number {
  if (c.computed) return 12
  switch (c.type) {
    case 'autonumber': return 2
    case 'text': case 'email': case 'phone': case 'url': return 3
    case 'choice': return 4
    case 'lookup': return 5
    case 'number': case 'decimal': case 'currency': return 6
    case 'date': case 'datetime': return 7
    case 'boolean': return 8
    case 'multiline': return 9
    case 'image': return 10
    case 'file': return 11
    default: return 13
  }
}

const isSystemCol = (c: ColumnDef) => !!c.system
const stable = <T,>(list: T[], key: (x: T) => number): T[] => list.map((x, i) => ({ x, i, k: key(x) })).sort((a, b) => a.k - b.k || a.i - b.i).map((e) => e.x)

/** the column shown as a record's title: the primary column when it can be shown as text, else the first text column */
export function titleColumnOf(t: TableDef): ColumnDef | null {
  const usable = (c: ColumnDef | undefined) => !!c && !c.system && !['image', 'file', 'multiline', 'lookup'].includes(c.type)
  const primary = t.columns.find((c) => c.name === t.primaryColumn)
  if (usable(primary)) return primary!
  return t.columns.find((c) => !c.system && c.type === 'text') ?? t.columns.find((c) => usable(c)) ?? null
}

/** the form's fields: the title first, then required ones, then by kind (table order within a kind) */
export function orderFields(t: TableDef, title: ColumnDef | null): ColumnDef[] {
  const cols = t.columns.filter((c) => !isSystemCol(c) && KNOWN.includes(c.type))
  return stable(cols, (c) => (c === title ? 0 : c.required && !c.computed && c.type !== 'autonumber' ? 1 : fieldRank(c)))
}

/** list columns: title, then required, then short values; never long text, files or lookups (lists show lookup ids) */
export function listColumnsOf(t: TableDef, title: ColumnDef | null, max: number): ColumnDef[] {
  const listable = (c: ColumnDef) => !isSystemCol(c) && !['multiline', 'file', 'lookup'].includes(c.type) && KNOWN.includes(c.type)
  const rank = (c: ColumnDef) => {
    if (c === title) return 0
    if (c.required) return 1
    if (c.type === 'image') return 9
    if (TEXTISH.includes(c.type) || c.type === 'choice' || c.type === 'autonumber') return 2
    if (NUMBERISH.includes(c.type) || c.type === 'date' || c.type === 'datetime') return 3
    return 4
  }
  return stable(t.columns.filter(listable), rank).slice(0, max)
}

/** a phone card: title, a subtitle (a choice or text), then up to two lines (dates and numbers first) */
export function cardColumnsOf(title: ColumnDef | null, list: ColumnDef[]): ColumnDef[] {
  const rest = list.filter((c) => c !== title && c.type !== 'image')
  const sub = rest.find((c) => c.type === 'choice') ?? rest.find((c) => TEXTISH.includes(c.type))
  const lines = stable(rest.filter((c) => c !== sub), (c) => (c.type === 'date' || c.type === 'datetime' || NUMBERISH.includes(c.type) ? 0 : 1)).slice(0, 2)
  return [...(title ? [title] : []), ...(sub ? [sub] : []), ...lines]
}

const lookupTarget = (all: TableDef[], c: ColumnDef) => (c.lookupTable ? all.find((t) => t.name === c.lookupTable || t.id === c.lookupTable) : undefined)

/** Plan an auto app over `opts.tables` (names) of `all` (every table of the environment). Never throws. */
export function planAutoApp(all: TableDef[], opts: AutoAppOptions): AutoAppPlan {
  const size = SIZES[opts.device] ?? SIZES.desktop
  const width = Math.round(opts.width ?? size.w)
  const height = Math.round(opts.height ?? size.h)
  const layout: AutoAppPlan['layout'] = width < 700 || height > width ? 'compact' : 'wide'
  const readable = (t: TableDef) => (opts.readable ? opts.readable(t) : true)
  const issues: AutoIssue[] = []
  const seen = new Set<string>()
  const chosen: TableDef[] = []
  for (const name of opts.tables) {
    const t = all.find((x) => x.name === name || x.id === name)
    if (!t) { issues.push({ level: 'blocked', table: name, message: `Table "${name}" was not found.` }); continue }
    if (seen.has(t.name)) continue
    seen.add(t.name)
    if (!readable(t)) { issues.push({ level: 'blocked', table: t.displayName, message: 'You cannot read this table, so no screens are made for it.' }); continue }
    if (isEnumName(t.name)) {
      issues.push({ level: 'blocked', table: t.displayName, message: `Its formula name "${t.name}" is also a built-in name of the formula language, so formulas cannot refer to it. Rename the table first.` })
      continue
    }
    chosen.push(t)
  }
  const inApp = new Set(chosen.map((t) => t.name))
  const sources = new Set<string>(chosen.map((t) => t.name))
  const plans: TablePlan[] = chosen.map((t) => {
    const title = titleColumnOf(t)
    const readOnly = !!t.readOnly || t.systemKind === 'projection'
    const formFields = orderFields(t, title)
    // a phone card can only show columns of the list (DataTable CardColumns picks among Columns): on phones the card
    // columns lead the list; on desktop the card (touch screens under 600 px) picks from the desktop list
    const cardColumns = cardColumnsOf(title, listColumnsOf(t, title, layout === 'wide' ? 7 : 40))
    const listColumns = layout === 'wide'
      ? listColumnsOf(t, title, 7)
      : [...cardColumns, ...listColumnsOf(t, title, 40).filter((c) => !cardColumns.includes(c))].slice(0, Math.max(4, cardColumns.length))
    const leftOut = t.columns.filter(isSystemCol).map((column) => ({ column, reason: 'system column (filled in by the platform)' }))
    const issue = (level: IssueLevel, message: string, column?: ColumnDef) => issues.push({ level, table: t.displayName, ...(column ? { column: column.displayName || column.name } : {}), message })

    if (!title) issue('limited', 'No column can be shown as a title (no text, number, date or choice column): records are listed without a title.')
    if (formFields.length === 0) issue('blocked', 'The table has no columns of its own: the form has no fields. Add columns first.')
    if (readOnly) issue('note', 'The table is read-only here: the app shows records but cannot add, change or delete them.')
    for (const c of t.columns) {
      if (c.system) continue
      if (!KNOWN.includes(c.type)) { issue('skipped', `Column type "${String(c.type)}" is not known to the generator: left out.`, c); continue }
      if (c.computed) issue('note', 'Calculated by the server: shown read-only in the form.', c)
      if (c.type === 'lookup') {
        const target = lookupTarget(all, c)
        if (!target) issue('limited', `Looks up "${c.lookupTable ?? '?'}", which does not exist here: the field has nothing to pick.`, c)
        else if (!readable(target)) issue('limited', `Looks up ${target.displayName}, which you cannot read: the field may have nothing to pick.`, c)
        else {
          sources.add(target.name)
          issue('limited', `Picked from a list of ${target.displayName} (the form's picker is a plain list, not a search box, and only shows rows the browser holds: up to 2,000). Not shown in the record list (lists would show the row id).`, c)
        }
      }
      if (c.type === 'multiline' || c.type === 'file') issue('note', `Shown in the form only (${c.type === 'file' ? 'files' : 'long text'} are not shown in the list).`, c)
    }
    const searchable = t.columns.some((c) => !c.system && ['text', 'multiline', 'email', 'url', 'phone', 'choice', 'autonumber'].includes(c.type))
    if (!searchable) issue('note', 'No text column: the list has no search box (sorting by a column still works).')
    if (listColumns.length < t.columns.filter((c) => !c.system).length && layout === 'compact') issue('note', `The phone card shows ${cardColumns.length} of the columns; all of them are in the form.`)

    const related: RelatedPlan[] = []
    for (const child of all) {
      const links = child.columns.filter((c) => !c.system && c.type === 'lookup' && (c.lookupTable === t.name || c.lookupTable === t.id))
      if (links.length === 0) continue
      if (!readable(child)) { issue('skipped', `${child.displayName} points at this table, but you cannot read it: no related list.`); continue }
      if (isEnumName(child.name)) { issue('skipped', `${child.displayName} points at this table, but its formula name is a built-in name: no related list.`); continue }
      for (const col of links) {
        related.push({ table: child, column: col, label: links.length > 1 ? `${child.displayName} (${col.displayName || col.name})` : child.displayName, inApp: inApp.has(child.name) })
        sources.add(child.name)
      }
      const other = child.columns.filter((c) => !c.system && c.type === 'lookup' && !links.includes(c))
      if (other.length > 0 && child.uniqueTogether?.length) issue('limited', `${child.displayName} links this table to ${other.map((c) => lookupTarget(all, c)?.displayName ?? c.lookupTable).join(', ')}: its related list shows its own columns, not the names on the other side.`)
    }
    const parents: ParentLink[] = []
    for (const c of formFields) {
      if (c.type !== 'lookup') continue
      const target = lookupTarget(all, c)
      if (target && inApp.has(target.name) && target.name !== t.name) parents.push({ column: c, table: target })
    }
    if (parents.length > 2 && layout === 'wide') issue('note', `Only the first two lookups get an "Open" button on the detail screen (${parents.slice(2).map((p) => p.column.displayName).join(', ')} do not).`)
    if (parents.length > 0 && layout === 'compact') issue('note', 'Phone layout: no "Open" buttons for lookups to other tables of the app (use the related lists or the home screen).')
    const timeline = !t.system
    const recycleDays = t.recycleDays ?? 0
    const undo = recycleDays > 0
    if (t.connectionId && t.connectionId !== 'conn_default' && !t.origin) issue('note', 'Stored in another connection: if it cannot run queries (MySQL, data files, Google Sheets), lists cover at most its first 5,000 rows.')
    return {
      table: t, readOnly, titleColumn: title, listColumns, cardColumns, formFields, leftOut, search: searchable,
      sortNewest: t.columns.some((c) => c.name === 'createdOn') && !(t.missingSystem ?? []).includes('createdOn'),
      related, parents: layout === 'wide' ? parents.slice(0, 2) : [], timeline, undo, recycleDays,
    }
  })
  const home = plans.length > 1
  const screens: AutoAppPlan['screens'] = []
  if (home) screens.push({ name: 'Home', what: `a tile per table (${plans.map((p) => p.table.displayName).join(', ')}) with its row count` })
  for (const p of plans) {
    const d = p.table.displayName
    screens.push({ name: `${d}: list`, what: `${p.search ? 'search, ' : ''}sort by any column, ${layout === 'compact' ? 'phone cards' : 'a table'} paged from the server${p.readOnly ? '' : ', New'}` })
    const extras = [p.timeline ? 'timeline' : '', ...p.related.map((r) => r.label)].filter(Boolean)
    screens.push({ name: `${d}: details`, what: `a form with ${p.formFields.length} ${p.formFields.length === 1 ? 'field' : 'fields'}${p.readOnly ? ' (read-only)' : `, Save, Cancel, Delete with confirmation${p.undo ? ' and Undo' : ''}`}${extras.length && layout === 'wide' ? `; ${extras.join(', ')}` : ''}` })
    if (layout === 'compact' && extras.length) screens.push({ name: `${d}: related`, what: extras.join(', ') })
  }
  for (const p of plans) for (const r of p.related) if (r.column.lookupTable === p.table.name && r.table.name === p.table.name) issues.push({ level: 'note', table: p.table.displayName, column: r.column.displayName, message: 'Looks up its own table: the related list shows the records that point at this one.' })
  // most serious first; table order within a level
  const order: IssueLevel[] = ['blocked', 'skipped', 'limited', 'note']
  const sorted = issues.map((x, i) => ({ x, i })).sort((a, b) => order.indexOf(a.x.level) - order.indexOf(b.x.level) || a.i - b.i).map((e) => e.x)
  return { name: opts.name.trim() || (plans[0] ? `${plans[0].table.displayName} app` : 'App'), width, height, layout, tables: plans, home, dataSources: [...sources], issues: sorted, screens }
}
