/**
 * Auto apps (P2 package D, exit check 4): an ordinary app definition (AppDef) generated from table definitions. The
 * result is a normal app: nothing marks it as generated, the Studio edits it like any other.
 *
 * Per table: a list screen (DataTable over the table: search, sort by a header, paging from the server; phone cards
 * with CardColumns) and a detail screen (a Form with ordered fields, Save / Cancel, Delete with a confirmation dialog,
 * related lists of child tables and a record timeline). Phone and portrait sizes put the related lists on a third
 * screen. Several tables get a Home screen with a tile per table (its row count). Every formula is checked by the
 * tests with `fx.check` and the query translator (`analyze`): nothing it writes over a table is non-delegable.
 *
 * Shared-code style: no React, no DOM, no platform access; relative imports with `.ts`.
 */
import type { AppDef, ControlNode } from '../contracts.ts'
import type { ColumnDef, TableDef } from '../platform/contracts.ts'
import { Names, ident, listHeader, member, stemOf, str } from './names.ts'
import { planAutoApp, type AutoAppOptions, type AutoAppPlan, type TablePlan } from './plan.ts'

export type { AutoAppOptions, AutoAppPlan, AutoIssue, TablePlan, RelatedPlan, AutoDevice } from './plan.ts'
export { planAutoApp, SIZES } from './plan.ts'

/* ------------------------------------------------------------------ style */

const BRAND = '=RGBA(79, 70, 229, 1)'
const PAGE = '=RGBA(248, 250, 252, 1)'
const WHITE = '=Color.White'
const MUTED = '=RGBA(100, 116, 139, 1)'

interface Box { x: number; y: number; w: number; h: number }
const r = Math.round
const geo = (b: Box) => ({ X: `=${r(b.x)}`, Y: `=${r(b.y)}`, Width: `=${r(Math.max(1, b.w))}`, Height: `=${r(Math.max(1, b.h))}` })
type A = 'Start' | 'End' | 'Stretch' | 'Center'
const anchor = (h: A, v: A = 'Start') => ({ AnchorH: `=Anchor.${h}`, AnchorV: `=Anchor.${v}` })

/** Builds the UI component tree with unique names and fresh ids. */
class Builder {
  constructor(readonly names: Names, private readonly newId: () => string) {}
  node(base: string, type: string, props: Record<string, string>, children: ControlNode[] = []): ControlNode {
    return { id: this.newId(), name: this.names.take(base), type, props, children }
  }
  /** a node with a name taken earlier (formulas of other UI components already refer to it) */
  named(name: string, type: string, props: Record<string, string>, children: ControlNode[] = []): ControlNode {
    return { id: this.newId(), name, type, props, children }
  }
}

const randomId = () => 'n' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)

/* ------------------------------------------------------------------ names of one table's parts */

interface TableNames {
  list: string
  detail: string
  related: string
  table: string
  form: string
  tabs: string
  record: string
  confirm: string
}

/* ------------------------------------------------------------------ generator */

export interface AutoAppResult {
  def: AppDef
  plan: AutoAppPlan
}

/** Generate the app definition. `all` is every table of the environment (for relationships and lookups). */
export function generateApp(all: TableDef[], opts: AutoAppOptions): AutoAppResult {
  const plan = planAutoApp(all, opts)
  // a name is never a table name: `Orders` in a formula must always be the table
  const b = new Builder(new Names(all.map((t) => t.name)), opts.newId ?? randomId)
  const W = plan.width
  const H = plan.height
  const wide = plan.layout === 'wide'

  // names first: screens and forms refer to each other across tables
  const tn = new Map<string, TableNames>()
  const home = plan.home ? b.names.take('Home') : ''
  for (const p of plan.tables) {
    const s = stemOf(p.table.name)
    tn.set(p.table.name, {
      list: b.names.take(`${s}List`),
      detail: b.names.take(`${s}Detail`),
      related: b.names.take(`${s}Related`),
      table: b.names.take(`${s}Table`),
      form: b.names.take(`${s}Form`),
      tabs: b.names.take(`${s}Tabs`),
      record: b.names.take(`var${s}`),
      confirm: b.names.take(`varDelete${s}`),
    })
  }

  const screens: ControlNode[] = []
  if (plan.home) screens.push(homeScreen(b, plan, tn, home, W, wide))
  for (const p of plan.tables) {
    const n = tn.get(p.table.name)!
    screens.push(listScreen(b, p, n, home, W, H, wide))
    const hasRelated = p.timeline || p.related.length > 0
    screens.push(detailScreen(b, plan, p, n, tn, W, H, wide, hasRelated && !wide))
    if (!wide && hasRelated) screens.push(relatedScreen(b, p, n, tn, W, H))
  }
  // nothing could be generated (the dialog does not offer Create then): still a valid app with one screen
  if (screens.length === 0) screens.push(b.node('Screen1', 'Screen', { Fill: WHITE }, [b.node('NothingLabel', 'Label', { ...geo({ x: 24, y: 24, w: Math.min(600, W - 48), h: 40 }), ...anchor('Stretch'), Text: '="No table could be used: see the list of issues in the Create app dialog."', Color: MUTED })]))
  const def: AppDef = {
    formatVersion: 2,
    name: plan.name,
    width: W,
    height: H,
    scaleMode: 'responsive',
    theme: { mode: 'light' },
    dataSources: plan.dataSources,
    // the variables the screens use, declared (the Studio runs OnStart, so their names are known while editing)
    appProps: { OnStart: plan.tables.length ? `=${plan.tables.map((p) => { const n = tn.get(p.table.name)!; return `Set(${n.record}, Blank()); Set(${n.confirm}, false)` }).join('; ')}` : '=false' },
    screens,
  }
  return { def, plan }
}

/* ------------------------------------------------------------------ pieces */

function header(b: Builder, base: string, W: number, wide: boolean): ControlNode {
  return b.node(base, 'Rectangle', { ...geo({ x: 0, y: 0, w: W, h: wide ? 64 : 56 }), ...anchor('Stretch'), Fill: BRAND, Radius: '=0', BorderWidth: '=0' })
}

function headerTitle(b: Builder, base: string, text: string, x: number, w: number, wide: boolean): ControlNode {
  return b.node(base, 'Label', { ...geo({ x, y: wide ? 14 : 12, w, h: wide ? 36 : 32 }), ...anchor('Stretch'), Text: text, Size: wide ? '=22' : '=18', FontWeight: '=FontWeight.Semibold', Color: WHITE })
}

function headerButton(b: Builder, base: string, text: string, box: Box, onSelect: string, opts: { end?: boolean; style?: string; visible?: string } = {}): ControlNode {
  return b.node(base, 'Button', {
    ...geo(box),
    ...anchor(opts.end ? 'End' : 'Start'),
    Text: `=${str(text)}`,
    Style: `=ButtonStyle.${opts.style ?? 'Secondary'}`,
    // on the coloured header bar
    ...(opts.style === 'Ghost' ? { Color: WHITE } : {}),
    OnSelect: `=${onSelect}`,
    ...(opts.visible ? { Visible: `=${opts.visible}` } : {}),
  })
}

const fieldList = (cols: ColumnDef[]) => `=${str(cols.map((c) => c.name).join(', '))}`
const columnList = (cols: ColumnDef[]) => `=${str(cols.map((c) => `${c.name}:${listHeader(c.displayName || c.name)}`).join(', '))}`

/** Items of a list: the table, newest first when it has createdOn (delegable: one sorted, paged query) */
function itemsOf(p: TablePlan): string {
  const t = ident(p.table.name)
  return p.sortNewest ? `=Sort(${t}, createdOn, SortOrder.Descending)` : `=${t}`
}

/** open a record of table `target` on its detail screen */
function openRecord(n: TableNames, record: string, readOnly: boolean): string {
  return `Set(${n.record}, ${record}); ${readOnly ? 'ViewForm' : 'EditForm'}(${n.form}); Navigate(${n.detail})`
}

/* ------------------------------------------------------------------ home */

function homeScreen(b: Builder, plan: AutoAppPlan, tn: Map<string, TableNames>, name: string, W: number, wide: boolean): ControlNode {
  const kids: ControlNode[] = [header(b, 'HomeHeader', W, wide), headerTitle(b, 'HomeTitle', `=${str(plan.name)}`, wide ? 24 : 16, W - (wide ? 48 : 32), wide)]
  const top = wide ? 96 : 72
  const pad = wide ? 24 : 16
  const cols = wide ? Math.min(4, plan.tables.length) : 1
  const gap = wide ? 24 : 12
  const tileW = wide ? Math.min(400, (W - pad * 2 - gap * (cols - 1)) / cols) : W - pad * 2
  const tileH = wide ? 120 : 64
  const countH = 26
  plan.tables.forEach((p, i) => {
    const n = tn.get(p.table.name)!
    const s = stemOf(p.table.name)
    const x = pad + (i % cols) * (tileW + gap)
    const y = top + Math.floor(i / cols) * (tileH + countH + gap)
    const h = wide ? 'Start' : 'Stretch'
    kids.push(b.node(`${s}Tile`, 'Button', {
      ...geo({ x, y, w: tileW, h: tileH }), ...anchor(h),
      Text: `=${str(p.table.displayName)}`, Style: '=ButtonStyle.Outline', Size: wide ? '=20' : '=17', Radius: '=12',
      OnSelect: `=Navigate(${n.list})`,
    }))
    // the row count (a count query; the cheap dashboard of the home screen)
    kids.push(b.node(`${s}Count`, 'Label', {
      ...geo({ x, y: y + tileH + 4, w: tileW, h: 20 }), ...anchor(h),
      Text: `=Text(CountRows(${ident(p.table.name)})) & ${str(' records')}`, Size: '=13', Color: MUTED, Align: '=Align.Center',
    }))
  })
  return b.named(name, 'Screen', { Fill: PAGE }, kids)
}

/* ------------------------------------------------------------------ list */

function listScreen(b: Builder, p: TablePlan, n: TableNames, home: string, W: number, H: number, wide: boolean): ControlNode {
  const s = stemOf(p.table.name)
  const kids: ControlNode[] = [header(b, `${s}ListHeader`, W, wide)]
  const bh = 36
  const by = wide ? 14 : 10
  let x = wide ? 24 : 12
  if (home) {
    kids.push(headerButton(b, `${s}HomeButton`, wide ? '< Home' : '<', { x: wide ? 16 : 8, y: by, w: wide ? 100 : 44, h: bh }, `Navigate(${home})`, { style: 'Ghost' }))
    x = wide ? 128 : 60
  }
  const newW = wide ? 140 : 84
  kids.push(headerTitle(b, `${s}ListTitle`, `=${str(p.table.displayName)}`, x, W - x - (p.readOnly ? 16 : newW + 32), wide))
  if (!p.readOnly) {
    kids.push(headerButton(b, `${s}NewButton`, '+ New', { x: W - (wide ? 24 : 12) - newW, y: by, w: newW, h: bh }, `Set(${n.record}, Blank()); NewForm(${n.form}); Navigate(${n.detail})`, { end: true }))
  }
  const top = wide ? 88 : 56
  const pad = wide ? 24 : 0
  kids.push(b.named(n.table, 'DataTable', {
    ...geo({ x: pad, y: top, w: W - pad * 2, h: H - top - (wide ? 24 : 0) }), ...anchor('Stretch', 'Stretch'),
    Items: itemsOf(p),
    Columns: columnList(p.listColumns),
    CardColumns: fieldList(p.cardColumns),
    Searchable: p.search ? '=true' : '=false',
    Sortable: '=true',
    SelectionMode: '=SelectionMode.Single',
    EmptyText: `=${str(p.readOnly ? `No ${p.table.displayName.toLowerCase()}` : `No ${p.table.displayName.toLowerCase()} yet. Select + New to add one.`)}`,
    OnSelect: `=${openRecord(n, `${n.table}.Selected`, p.readOnly)}`,
  }))
  return b.named(n.list, 'Screen', { Fill: wide ? PAGE : WHITE }, kids)
}

/* ------------------------------------------------------------------ detail */

const notNew = (n: TableNames) => `${n.form}.Mode <> FormMode.New`

function titleFormula(p: TablePlan, n: TableNames): string {
  const d = p.table.displayName
  const fallback = str(d)
  const shown = p.titleColumn ? `Coalesce(${member(n.record, p.titleColumn.name)}, ${fallback})` : fallback
  return p.readOnly ? `=${shown}` : `=If(${n.form}.Mode = FormMode.New, ${str(`New ${d.toLowerCase()}`)}, ${shown})`
}

function detailScreen(b: Builder, plan: AutoAppPlan, p: TablePlan, n: TableNames, tn: Map<string, TableNames>, W: number, H: number, wide: boolean, moreScreen: boolean): ControlNode {
  const s = stemOf(p.table.name)
  const kids: ControlNode[] = [header(b, `${s}DetailHeader`, W, wide)]
  const by = wide ? 14 : 10
  const bh = 36
  kids.push(headerButton(b, `${s}BackButton`, wide ? '< Back' : '<', { x: wide ? 16 : 8, y: by, w: wide ? 100 : 44, h: bh }, 'Back()', { style: 'Ghost' }))
  const tx = wide ? 128 : 60
  // header buttons on the right: Delete, then "Open <parent>" (desktop)
  const right: ControlNode[] = []
  let rx = W - (wide ? 24 : 8)
  if (!p.readOnly) {
    const w = wide ? 120 : 76
    rx -= w
    right.push(headerButton(b, `${s}DeleteButton`, 'Delete', { x: rx, y: by, w, h: bh }, `Set(${n.confirm}, true)`, { end: true, visible: notNew(n) }))
    rx -= 12
  }
  for (const link of p.parents) {
    const pn = tn.get(link.table.name)!
    const label = `Open ${link.column.displayName || link.column.name}`
    const w = Math.min(260, Math.max(140, label.length * 9 + 32))
    rx -= w
    const pp = plan.tables.find((x) => x.table.name === link.table.name)!
    right.push(headerButton(b, `${s}Open${stemOf(link.column.name, 20)}`, label, { x: rx, y: by, w, h: bh },
      `${openRecord(pn, `LookUp(${ident(link.table.name)}, id = ${member(n.record, link.column.name)})`, pp.readOnly)}`,
      { end: true, style: 'Outline', visible: `${notNew(n)} && !IsBlank(${member(n.record, link.column.name)})` }))
    rx -= 12
  }
  kids.push(headerTitle(b, `${s}DetailTitle`, titleFormula(p, n), tx, Math.max(80, rx - tx - 8), wide))
  kids.push(...right)

  const top = wide ? 88 : 56
  const side = wide && (p.timeline || p.related.length > 0)
  const sideW = side ? Math.min(640, Math.round(W * 0.33)) : 0
  const pad = wide ? 24 : 0
  const bottomBar = moreScreen ? 60 : 0
  const formW = side ? W - pad * 3 - sideW : W - pad * 2
  kids.push(b.named(n.form, 'Form', {
    ...geo({ x: pad, y: top, w: formW, h: H - top - (wide ? 24 : 0) - bottomBar }), ...anchor('Stretch', 'Stretch'),
    DataSource: `=${str(p.table.name)}`,
    Item: `=${n.record}`,
    Mode: p.readOnly ? '=FormMode.View' : '=FormMode.Edit',
    Fields: fieldList(p.formFields),
    Columns: wide ? (formW >= 1100 && p.formFields.length > 12 ? '=3' : '=2') : (W >= 600 ? '=2' : '=1'),
    ...(p.readOnly ? { ShowButtons: '=false' } : {
      // no success toast: it would cover the Save button of the next form for 4 seconds; going back is the feedback
      OnSuccess: '=Back()',
      OnFailure: `=Notify(${n.form}.Error, NotificationType.Error)`,
      OnCancel: '=Back()',
    }),
  }))
  if (moreScreen) {
    const labels = [p.timeline ? 'activity' : '', ...p.related.map((x) => x.label.toLowerCase())].filter(Boolean)
    kids.push(b.node(`${s}MoreButton`, 'Button', {
      ...geo({ x: 12, y: H - 52, w: W - 24, h: 44 }), ...anchor('Stretch', 'End'),
      Text: `=${str(`Related: ${labels.join(', ')} >`.slice(0, 90))}`, Style: '=ButtonStyle.Outline',
      Visible: `=${notNew(n)}`,
      OnSelect: `=Navigate(${n.related})`,
    }))
  }
  if (side) kids.push(...relatedPanel(b, p, n, tn, { x: W - pad - sideW, y: top, w: sideW, h: H - top - pad }, true))
  if (!p.readOnly) kids.push(deleteDialog(b, p, n, W, H, wide))
  return b.named(n.detail, 'Screen', { Fill: wide ? PAGE : WHITE }, kids)
}

/** Tabs (Activity, then one tab per related list) and their content in `area`; the Tabs strip is left out for one tab */
function relatedPanel(b: Builder, p: TablePlan, n: TableNames, tn: Map<string, TableNames>, area: Box, desktop: boolean): ControlNode[] {
  const s = stemOf(p.table.name)
  const tabs = [...(p.timeline ? ['Activity'] : []), ...p.related.map((x) => x.label)]
  const out: ControlNode[] = []
  const h: A = desktop ? 'End' : 'Stretch'
  const showTabs = tabs.length > 1
  const tabH = 40
  const content: Box = showTabs ? { x: area.x, y: area.y + tabH + 8, w: area.w, h: area.h - tabH - 8 } : area
  const guard = desktop ? `${notNew(n)} && ` : ''
  const visible = (i: number) => (showTabs ? `=${guard}${n.tabs}.SelectedIndex = ${i + 1}` : desktop ? `=${notNew(n)}` : '=true')
  if (showTabs) {
    out.push(b.named(n.tabs, 'Tabs', {
      ...geo({ x: area.x, y: area.y, w: area.w, h: tabH }), ...anchor(h),
      Items: `=[${tabs.map(str).join(', ')}]`,
      Variant: '="Pills"',
      ...(desktop ? { Visible: `=${notNew(n)}` } : {}),
    }))
  }
  let i = 0
  if (p.timeline) {
    out.push(b.node(`${s}Timeline`, 'RecordTimeline', {
      ...geo(content), ...anchor(h, 'Stretch'),
      Record: `=${n.record}`, Table: `=${str(p.table.name)}`, Visible: visible(i),
    }))
    i++
  }
  for (const rel of p.related) {
    const cs = stemOf(rel.table.name, 20)
    const cn = rel.inApp ? tn.get(rel.table.name) : undefined
    const childPlan = rel.table
    // the child's columns without the lookup that points back here (it is this record)
    const cols = listColumnsForChild(childPlan, rel.column)
    const addH = cn ? 44 : 0
    const listBox: Box = { x: content.x, y: content.y + addH, w: content.w, h: content.h - addH }
    const vis = visible(i)
    if (cn) {
      // "+ Add": a new child row with the lookup already set (New-mode starting values of the Form)
      out.push(b.node(`${s}Add${cs}`, 'Button', {
        ...geo({ x: content.x, y: content.y, w: Math.min(content.w, 220), h: 36 }), ...anchor(desktop ? 'End' : 'Start'),
        Text: `=${str(`+ Add ${rel.table.displayName.toLowerCase()}`.slice(0, 40))}`, Style: '=ButtonStyle.Outline',
        Visible: vis,
        OnSelect: `=Set(${cn.record}, {${ident(rel.column.name)}: ${n.record}.id}); NewForm(${cn.form}); Navigate(${cn.detail})`,
      }))
    }
    const listName = b.names.take(`${s}Related${cs}${p.related.filter((x) => x.table === rel.table).length > 1 ? stemOf(rel.column.name, 16) : ''}`)
    out.push(b.named(listName, 'DataTable', {
      ...geo(listBox), ...anchor(h, 'Stretch'),
      Items: `=Filter(${ident(rel.table.name)}, ${member('ThisRecord', rel.column.name)} = Coalesce(${n.record}.id, ${str('-')}))`,
      Columns: columnList(cols),
      CardColumns: fieldList(cols.slice(0, 4)),
      Searchable: '=false',
      Sortable: '=true',
      SelectionMode: cn ? '=SelectionMode.Single' : '=SelectionMode.None',
      EmptyText: `=${str(`No ${rel.table.displayName.toLowerCase()} for this record`)}`,
      Visible: vis,
      ...(cn ? { OnSelect: `=${openRecord(cn, `${listName}.Selected`, false)}` } : {}),
    }))
    i++
  }
  return out
}

function listColumnsForChild(child: TableDef, back: ColumnDef): ColumnDef[] {
  const usable = (c: ColumnDef) => !c.system && c !== back && !['multiline', 'file', 'lookup', 'image'].includes(c.type)
  const primary = child.columns.find((c) => c.name === child.primaryColumn && usable(c))
  const rest = child.columns.filter((c) => usable(c) && c !== primary)
  return [...(primary ? [primary] : []), ...rest].slice(0, 6)
}

function deleteDialog(b: Builder, p: TablePlan, n: TableNames, W: number, H: number, wide: boolean): ControlNode {
  const s = stemOf(p.table.name)
  const w = wide ? 460 : W - 32
  const h = 230
  const what = p.table.displayName.toLowerCase()
  const text = p.undo
    ? `The ${what} record is deleted for everyone. You can undo it right after, and it stays in the recycle bin for ${p.recycleDays} ${p.recycleDays === 1 ? 'day' : 'days'}.`
    : `The ${what} record is deleted for everyone. This cannot be undone.`
  const bw = 120
  return b.node(`${s}DeleteDialog`, 'Dialog', {
    ...geo({ x: (W - w) / 2, y: (H - h) / 2, w, h }), ...anchor('Center', 'Center'),
    Open: `=${n.confirm}`,
    Title: '="Delete this record?"',
    Description: `=${str(text)}`,
    OnClose: `=Set(${n.confirm}, false)`,
  }, [
    b.node(`${s}DeleteCancel`, 'Button', { ...geo({ x: w - 24 - bw * 2 - 12, y: 40, w: bw, h: 40 }), ...anchor('End'), Text: '="Cancel"', Style: '=ButtonStyle.Outline', OnSelect: `=Set(${n.confirm}, false)` }),
    b.node(`${s}DeleteConfirm`, 'Button', { ...geo({ x: w - 24 - bw, y: 40, w: bw, h: 40 }), ...anchor('End'), Text: '="Delete"', Style: '=ButtonStyle.Destructive', OnSelect: `=Remove(${ident(p.table.name)}, ${n.record}); Set(${n.confirm}, false); Back()` }),
  ])
}

/* ------------------------------------------------------------------ related (phone, portrait) */

function relatedScreen(b: Builder, p: TablePlan, n: TableNames, tn: Map<string, TableNames>, W: number, H: number): ControlNode {
  const s = stemOf(p.table.name)
  const d = p.table.displayName
  const kids: ControlNode[] = [header(b, `${s}RelatedHeader`, W, false)]
  kids.push(headerButton(b, `${s}RelatedBack`, '<', { x: 8, y: 10, w: 44, h: 36 }, 'Back()', { style: 'Ghost' }))
  const shown = p.titleColumn ? `Coalesce(${member(n.record, p.titleColumn.name)}, ${str(d)})` : str(d)
  kids.push(headerTitle(b, `${s}RelatedTitle`, `=${shown}`, 60, W - 72, false))
  kids.push(...relatedPanel(b, p, n, tn, { x: 8, y: 64, w: W - 16, h: H - 72 }, false))
  return b.named(n.related, 'Screen', { Fill: WHITE }, kids)
}
