/**
 * Print templates (P2 package B, docs/dev/pdf.md): the constrained document model shared by the server's PDF engine
 * (server/core/print/**), the designer (src/print/**), solutions and the reference docs. A template is NOT arbitrary
 * HTML: it is a page setup, a header and a footer, and a list of blocks of a fixed set of kinds. Every text property
 * accepts formula expressions in `{...}` (evaluated on the server); properties named `rows`, `value`, `visible`, `items`
 * are formulas themselves.
 *
 * Units: page sizes, margins, widths and heights in millimetres; font sizes in points.
 * Pure module: no DOM, no Node; erasable TypeScript only (the server imports it).
 */

export const PRINT_DOC_VERSION = 1

export type PageSize = 'A4' | 'A5' | 'Letter' | 'Legal' | 'custom'
export type Orientation = 'portrait' | 'landscape'
export type Align = 'left' | 'center' | 'right' | 'justify'
export type CellFormat = 'text' | 'number' | 'integer' | 'currency' | 'percent' | 'date' | 'datetime' | 'boolean'
export type TableStyle = 'grid' | 'lines' | 'zebra' | 'plain'

/** width x height in mm, portrait */
export const PAGE_SIZES: Record<Exclude<PageSize, 'custom'>, [number, number]> = {
  A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6],
}

export interface PageSetup {
  size: PageSize
  /** custom size in mm (portrait sense: width < height is not required) */
  width?: number
  height?: number
  orientation: Orientation
  margins: { top: number; right: number; bottom: number; left: number }
}

/** a related list of a record source: child rows whose `column` (a lookup) points at the record */
export interface RelatedList {
  /** name in formulas: Related.<name> */
  name: string
  table: string
  column: string
  /** extra delegable filter (formula over the child row), e.g. `Severity <> "Minor"` */
  filter?: string
  sort?: { column: string; descending?: boolean }[]
  /** at most this many rows (default 1,000, at most 10,000) */
  top?: number
}

export type TemplateSource =
  | { kind: 'record'; table: string; related?: RelatedList[] }
  /** rows of a table: a delegable filter formula, sort and top; formulas see them as Rows */
  | { kind: 'query'; table: string; filter?: string; sort?: { column: string; descending?: boolean }[]; top?: number }
  /** a formula that returns a table (Rows) or a record (Record) */
  | { kind: 'formula'; formula: string }
  | { kind: 'none' }

export interface TemplateStyles {
  fontSize: number
  color: string
  accent: string
  headingColor: string
  tableStyle: TableStyle
  /** line height factor (default 1.3) */
  lineHeight?: number
}

export interface BlockBase {
  id: string
  /** formula; blank = always shown */
  visible?: string
  /** move the whole block to the next page instead of splitting it (when it fits on one page) */
  keepTogether?: boolean
  /** mm */
  spaceBefore?: number
  spaceAfter?: number
}

export interface TableColumn {
  header: string
  /** formula over ThisItem (the row), e.g. ThisItem.Qty * ThisItem.Price; a plain column name works too */
  value: string
  /** mm; blank = share the remaining width (weights `flex`, default 1) */
  width?: number
  flex?: number
  align?: 'left' | 'center' | 'right'
  format?: CellFormat
  decimals?: number
  /** totals row: the function over this column */
  total?: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'label'
  /** text of a 'label' total (e.g. "Total") */
  totalLabel?: string
}

export type Block =
  | (BlockBase & { kind: 'heading'; text: string; level: 1 | 2 | 3; align?: Align; color?: string })
  /**
   * rich text: paragraphs separated by blank lines; **bold**, *italic*, __underline__, [color=#c00]...[/color],
   * lines starting "- " are bullets and "1. " numbered; {formula} anywhere.
   */
  | (BlockBase & { kind: 'text'; text: string; align?: Align; size?: number; color?: string })
  | (BlockBase & {
      kind: 'image'
      /** logo: the letterhead logo; static: `data` (a data: URL kept in the template); attachment: `value` is a formula returning file/image values (one or many) */
      source: 'logo' | 'static' | 'attachment'
      data?: string
      value?: string
      width?: number
      height?: number
      align?: 'left' | 'center' | 'right'
      /** several images (attachment source): per row */
      perRow?: number
      caption?: string
    })
  | (BlockBase & {
      kind: 'table'
      /** formula returning the rows, e.g. Related.Defects or Rows */
      rows: string
      columns: TableColumn[]
      repeatHeader?: boolean
      style?: TableStyle
      fontSize?: number
      /** formula over ThisItem: rows are grouped by it (in order of first appearance unless sortGroups) */
      groupBy?: string
      /** text of the group header; {Group} is the group's value, {Count} its row count */
      groupHeader?: string
      subtotals?: boolean
      totals?: boolean
      /** keep a row on one page (default true) */
      avoidRowBreak?: boolean
      emptyText?: string
    })
  | (BlockBase & { kind: 'keyValue'; items: { label: string; value: string; format?: CellFormat; decimals?: number }[]; columns?: 1 | 2 | 3 | 4; labelWidth?: number; boxed?: boolean })
  | (BlockBase & { kind: 'columns'; columns: { width?: number; blocks: Block[] }[]; gap?: number })
  | (BlockBase & { kind: 'spacer'; height: number })
  | (BlockBase & { kind: 'line'; thickness?: number; color?: string; dashed?: boolean })
  | (BlockBase & { kind: 'pageBreak' })
  | (BlockBase & { kind: 'barcode'; symbology: 'code128' | 'qr'; value: string; width?: number; height?: number; showText?: boolean; align?: 'left' | 'center' | 'right' })
  | (BlockBase & {
      kind: 'chart'
      chartType: 'bar' | 'line' | 'pie' | 'gauge'
      /** formula returning rows (bar, line, pie); gauge: unused */
      rows?: string
      /** formula over ThisItem: the category (bar, line, pie) */
      label?: string
      /** formulas over ThisItem: one per series (bar, line), the first for pie; gauge: one formula, the value */
      values: { name: string; value: string; color?: string }[]
      title?: string
      height?: number
      min?: number
      max?: number
      /** gauge bands (fractions of the range), e.g. [0.6, 0.85] red/amber/green */
      bands?: number[]
      unit?: string
    })
  | (BlockBase & { kind: 'signature'; labels: string[]; showDate?: boolean })
  /** the approval history of the record (from the approvals data, as the generating identity may read it) */
  | (BlockBase & { kind: 'approvals'; title?: string; emptyText?: string })
  /** its blocks once per row: ThisItem is the row (e.g. one section per inspection point) */
  | (BlockBase & { kind: 'repeat'; rows: string; blocks: Block[]; pageBreakBetween?: boolean })

export type BlockKind = Block['kind']

export interface Letterhead {
  companyName: string
  address?: string
  phone?: string
  email?: string
  website?: string
  /** plain text, no tax logic */
  gstin?: string
  /** data: URL of a PNG or JPEG */
  logo?: string
  /** colour of the letterhead rule */
  color?: string
}

export interface PrintSettings {
  letterhead: Letterhead
  /** indian: 12,34,567.89; international: 1,234,567.89 */
  grouping: 'indian' | 'international'
  /** currency code (default: Settings DefaultCurrency, else INR) */
  currency?: string
  /** dd-MM-yyyy, dd/MM/yyyy, yyyy-MM-dd, d MMM yyyy, MM/dd/yyyy */
  dateFormat: string
  /** IANA time zone (default: Settings TimeZone, else Asia/Kolkata) */
  timeZone?: string
  limits?: { maxPages?: number; maxRows?: number; timeoutSeconds?: number; maxImageMB?: number }
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  letterhead: { companyName: '' },
  grouping: 'indian',
  dateFormat: 'dd-MM-yyyy',
}

export interface HeaderFooter {
  blocks: Block[]
  /** header only: the environment's letterhead above the blocks */
  letterhead?: 'none' | 'first' | 'all'
  /** footer only: "Page X of Y" at the right (default true) */
  pageNumbers?: boolean
  /** left/center/right one-line texts (footer and header) */
  left?: string
  center?: string
  right?: string
}

export interface PrintTemplateDoc {
  version: number
  page: PageSetup
  source: TemplateSource
  styles: TemplateStyles
  header: HeaderFooter
  footer: HeaderFooter
  body: Block[]
  /** text with {formula}: the file name (without .pdf) */
  fileName?: string
  metadata?: { title?: string; subject?: string; keywords?: string }
}

export type TemplateKind = 'pdf' | 'docx'
export type RunAsMode = 'caller' | { serviceAccount: string }

export interface PrintTemplateInfo {
  id: string
  name: string
  description?: string
  kind: TemplateKind
  /** the table of a record or query source (for pickers: "templates of this table") */
  table: string | null
  status: 'draft' | 'published'
  /** the published version number (0: never published) */
  version: number
  /** the draft differs from the published version */
  dirty: boolean
  runAs: RunAsMode
  ownerId: string
  ownerName?: string
  builtIn?: string
  solutionId?: string | null
  modifiedOn: string
  modifiedBy?: string | null
  /** docx: the uploaded file's name */
  docxFileName?: string
  canEdit: boolean
}

export interface PrintTemplateFull extends PrintTemplateInfo {
  doc: PrintTemplateDoc
  published: PrintTemplateDoc | null
}

export interface PrintRunInfo {
  id: string
  templateId: string
  templateName: string
  version: number
  kind: 'single' | 'bulk' | 'preview'
  status: 'running' | 'succeeded' | 'failed'
  userId: string | null
  runAs: string
  recordIds: string[]
  pages: number
  bytes: number
  ms: number
  warnings: string[]
  error?: string | null
  progress?: { done: number; total: number }
  fileToken?: string | null
  startedOn: string
  finishedOn?: string | null
  source: string
}

export interface GeneratedFile { token: string; fileName: string; mime: string; sizeBytes: number; url: string; pages?: number; warnings?: string[]; runId?: string }

/* ------------------------------------------------------------------ catalogue (designer palette, reference docs) */

export interface BlockDoc {
  kind: BlockKind
  title: string
  group: 'Text' | 'Data' | 'Layout' | 'Graphics'
  summary: string
  /** properties with one line each (reference docs) */
  props: [name: string, text: string][]
  example: Block
}

export const BLOCK_CATALOGUE: BlockDoc[] = [
  {
    kind: 'heading', title: 'Heading', group: 'Text', summary: 'A title line in one of three sizes, in the heading colour.',
    props: [['text', 'Text with {formula} parts'], ['level', '1, 2 or 3'], ['align', 'left, center, right'], ['color', 'Colour (#rrggbb); blank: the template\'s heading colour']],
    example: { id: 'h1', kind: 'heading', text: 'Inspection report {Number}', level: 1 },
  },
  {
    kind: 'text', title: 'Rich text', group: 'Text', summary: 'Paragraphs with **bold**, *italic*, __underline__, [color=#c00]colour[/color], bullet ("- ") and numbered ("1. ") lists and {formula} parts.',
    props: [['text', 'The text; a blank line starts a new paragraph'], ['align', 'left, center, right, justify'], ['size', 'Font size in points'], ['color', 'Colour (#rrggbb)']],
    example: { id: 't1', kind: 'text', text: 'Inspected by **{Inspector}** on {FormatDate(InspectedOn)}.' },
  },
  {
    kind: 'keyValue', title: 'Key-value grid', group: 'Data', summary: 'Labels and values in 1 to 4 columns (record fields, totals, KPIs).',
    props: [['items', 'Label and value formula (with an optional format) per entry'], ['columns', '1 to 4'], ['labelWidth', 'Label width in mm'], ['boxed', 'Draw a box around each entry (KPI tiles)']],
    example: { id: 'kv', kind: 'keyValue', columns: 2, items: [{ label: 'Machine', value: 'Machine' }, { label: 'Shift', value: 'Shift' }] },
  },
  {
    kind: 'table', title: 'Table', group: 'Data', summary: 'Rows from a related list, a query or a formula; column widths, header repeated on every page, zebra rows, totals, grouping with subtotals; a row is never split across pages.',
    props: [['rows', 'Formula returning the rows: Related.<name>, Rows, or a delegable Filter(...)'], ['columns', 'Header, value formula over ThisItem, width (mm) or share, alignment, format (number, currency, percent, date ...) and total (sum, count, avg, min, max, label)'], ['repeatHeader', 'Header row on every page (default on)'], ['style', 'grid, lines, zebra or plain'], ['groupBy', 'Formula over ThisItem; rows are grouped by its value'], ['groupHeader', 'Group header text: {Group}, {Count}'], ['subtotals', 'A subtotal row after each group'], ['totals', 'A totals row at the end'], ['avoidRowBreak', 'Keep each row on one page (default on)'], ['emptyText', 'Shown when there are no rows']],
    example: { id: 'tb', kind: 'table', rows: 'Related.Lines', columns: [{ header: 'Item', value: 'ThisItem.Item' }, { header: 'Qty', value: 'ThisItem.Qty', align: 'right', format: 'number', total: 'sum' }], totals: true },
  },
  {
    kind: 'repeat', title: 'Repeated section', group: 'Data', summary: 'Its blocks once per child row (ThisItem is the row), optionally a page per row.',
    props: [['rows', 'Formula returning the rows'], ['blocks', 'The blocks of one section'], ['pageBreakBetween', 'Start every section on a new page']],
    example: { id: 'rp', kind: 'repeat', rows: 'Related.Points', blocks: [{ id: 'rph', kind: 'heading', level: 3, text: '{ThisItem.Name}' }] },
  },
  {
    kind: 'approvals', title: 'Approval history', group: 'Data', summary: 'Who decided what and when on the record\'s approval requests (stage, person, decision, comment, date), as far as the generating identity may read them.',
    props: [['title', 'Heading above the table'], ['emptyText', 'Shown when there was no approval']],
    example: { id: 'ap', kind: 'approvals', title: 'Approval history' },
  },
  {
    kind: 'image', title: 'Image', group: 'Graphics', summary: 'The letterhead logo, an image kept in the template, or photos from an image or file column (several in a grid).',
    props: [['source', 'logo, static (uploaded into the template) or attachment'], ['value', 'attachment: formula returning image values, e.g. Photos'], ['width', 'mm'], ['height', 'mm (blank: keep the aspect ratio)'], ['align', 'left, center, right'], ['perRow', 'Images per row for several images'], ['caption', 'Text under each image']],
    example: { id: 'im', kind: 'image', source: 'attachment', value: 'Photos', perRow: 3, width: 55 },
  },
  {
    kind: 'chart', title: 'Chart', group: 'Graphics', summary: 'Bar, line, pie or gauge chart drawn as vectors.',
    props: [['chartType', 'bar, line, pie or gauge'], ['rows', 'Formula returning the rows (bar, line, pie)'], ['label', 'Category formula over ThisItem'], ['values', 'Series: name, value formula over ThisItem, colour; gauge: the first value formula is the value'], ['min', 'Gauge minimum'], ['max', 'Gauge maximum'], ['bands', 'Gauge band limits as fractions, e.g. 0.6, 0.85'], ['height', 'mm'], ['title', 'Title above the chart'], ['unit', 'Unit after values, e.g. %']],
    example: { id: 'ch', kind: 'chart', chartType: 'bar', rows: 'Rows', label: 'ThisItem.Machine', values: [{ name: 'OEE', value: 'ThisItem.OEE' }], height: 60 },
  },
  {
    kind: 'barcode', title: 'Barcode or QR code', group: 'Graphics', summary: 'Code 128 barcode or QR code drawn as vectors (scannable on paper).',
    props: [['symbology', 'code128 or qr'], ['value', 'Formula: the encoded text'], ['width', 'mm'], ['height', 'mm'], ['showText', 'Print the text under a barcode'], ['align', 'left, center, right']],
    example: { id: 'bc', kind: 'barcode', symbology: 'qr', value: '"INSP-" & Number', width: 25 },
  },
  {
    kind: 'columns', title: 'Columns', group: 'Layout', summary: 'Two to four side-by-side columns, each with its own blocks.',
    props: [['columns', 'Width (mm, blank: share) and the blocks of each column'], ['gap', 'Space between columns in mm']],
    example: { id: 'co', kind: 'columns', columns: [{ blocks: [] }, { blocks: [] }] },
  },
  {
    kind: 'signature', title: 'Signature lines', group: 'Layout', summary: 'One to four signature lines with labels and an optional date line.',
    props: [['labels', 'One label per line, e.g. Inspected by, Approved by'], ['showDate', 'A "Date" line under each']],
    example: { id: 'sg', kind: 'signature', labels: ['Prepared by', 'Approved by'], showDate: true },
  },
  { kind: 'spacer', title: 'Spacer', group: 'Layout', summary: 'Empty vertical space.', props: [['height', 'mm']], example: { id: 'sp', kind: 'spacer', height: 6 } },
  { kind: 'line', title: 'Line', group: 'Layout', summary: 'A horizontal rule.', props: [['thickness', 'Points'], ['color', 'Colour'], ['dashed', 'Dashed line']], example: { id: 'ln', kind: 'line' } },
  { kind: 'pageBreak', title: 'Page break', group: 'Layout', summary: 'The next block starts on a new page.', props: [], example: { id: 'pb', kind: 'pageBreak' } },
]

export const BLOCK_KINDS = BLOCK_CATALOGUE.map((b) => b.kind)

/** limits of the engine (docs/admin/printing.md) */
export const PRINT_LIMITS = {
  maxPages: 500,
  maxRows: 20_000,
  timeoutSeconds: 60,
  maxImageMB: 10,
  maxImagesMB: 60,
  maxBlocks: 400,
  maxNesting: 6,
  maxDocBytes: 2 * 1024 * 1024,
  maxStaticImageBytes: 600 * 1024,
  bulkMaxRecords: 2_000,
  fileTokenHours: 24,
  docxMaxMB: 10,
} as const

/* ------------------------------------------------------------------ defaults and helpers */

export function emptyDoc(table?: string): PrintTemplateDoc {
  return {
    version: PRINT_DOC_VERSION,
    page: { size: 'A4', orientation: 'portrait', margins: { top: 15, right: 15, bottom: 15, left: 15 } },
    source: table ? { kind: 'record', table, related: [] } : { kind: 'none' },
    styles: { fontSize: 10, color: '#1e293b', accent: '#4f46e5', headingColor: '#0f172a', tableStyle: 'zebra' },
    header: { blocks: [], letterhead: 'first' },
    footer: { blocks: [], pageNumbers: true },
    body: [],
  }
}

/** page width and height in mm after orientation */
export function pageSizeMm(p: PageSetup): [number, number] {
  let [w, h] = p.size === 'custom' ? [Number(p.width) || 210, Number(p.height) || 297] : PAGE_SIZES[p.size] ?? PAGE_SIZES.A4
  if (p.orientation === 'landscape' ? w < h : w > h) [w, h] = [h, w]
  return [w, h]
}

export const MM = 72 / 25.4

let idSeq = 0
export function newBlockId(kind: string): string {
  idSeq = (idSeq + 1) % 1_000_000
  return `${kind.slice(0, 3)}${Date.now().toString(36).slice(-5)}${idSeq.toString(36)}`
}

/** a new block of a kind with sensible defaults (designer palette) */
export function newBlock(kind: BlockKind): Block {
  const doc = BLOCK_CATALOGUE.find((b) => b.kind === kind)
  const b = structuredClone(doc ? doc.example : { id: '', kind: 'spacer', height: 5 }) as Block
  b.id = newBlockId(kind)
  return b
}

/** every block of a list, depth first (columns and repeat included), with its parent list */
export function walkBlocks(list: Block[], fn: (b: Block, depth: number) => void, depth = 0): void {
  for (const b of list) {
    fn(b, depth)
    if (b.kind === 'columns') for (const c of b.columns) walkBlocks(c.blocks ?? [], fn, depth + 1)
    if (b.kind === 'repeat') walkBlocks(b.blocks ?? [], fn, depth + 1)
  }
}

export interface DocProblem { path: string; message: string }

const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** structural checks of a template document (formulas are checked by the server) */
export function docProblems(raw: unknown): DocProblem[] {
  const out: DocProblem[] = []
  if (!isObj(raw)) return [{ path: '', message: 'The template must be an object.' }]
  const d = raw as unknown as PrintTemplateDoc
  if (!isObj(d.page)) out.push({ path: 'page', message: 'The page setup is missing.' })
  else {
    if (!['A4', 'A5', 'Letter', 'Legal', 'custom'].includes(d.page.size)) out.push({ path: 'page.size', message: 'The page size is A4, A5, Letter, Legal or custom.' })
    if (d.page.size === 'custom' && !(Number(d.page.width) >= 50 && Number(d.page.width) <= 1200 && Number(d.page.height) >= 50 && Number(d.page.height) <= 1200)) out.push({ path: 'page.width', message: 'A custom page is 50 to 1,200 mm wide and high.' })
    if (!['portrait', 'landscape'].includes(d.page.orientation)) out.push({ path: 'page.orientation', message: 'The orientation is portrait or landscape.' })
    const m = d.page.margins
    if (!isObj(m) || ['top', 'right', 'bottom', 'left'].some((k) => !(Number((m as unknown as Record<string, unknown>)[k]) >= 0 && Number((m as unknown as Record<string, unknown>)[k]) <= 100))) out.push({ path: 'page.margins', message: 'Margins are 0 to 100 mm.' })
    else {
      const [w, h] = pageSizeMm(d.page)
      if (m.left + m.right > w - 30 || m.top + m.bottom > h - 30) out.push({ path: 'page.margins', message: 'The margins leave too little room on the page.' })
    }
  }
  if (!isObj(d.source) || !['record', 'query', 'formula', 'none'].includes(String(d.source.kind))) out.push({ path: 'source', message: 'The data source is a record, a query, a formula or none.' })
  else if ((d.source.kind === 'record' || d.source.kind === 'query') && !String(d.source.table ?? '').trim()) out.push({ path: 'source.table', message: 'Choose the table of the data source.' })
  else if (d.source.kind === 'formula' && !String(d.source.formula ?? '').trim()) out.push({ path: 'source.formula', message: 'Write the formula of the data source.' })
  if (d.source?.kind === 'record') {
    const names = new Set<string>()
    for (const [i, r] of (d.source.related ?? []).entries()) {
      if (!isObj(r) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(r.name ?? ''))) out.push({ path: `source.related.${i}.name`, message: 'A related list needs a name made of letters, digits and _.' })
      else if (names.has(r.name.toLowerCase())) out.push({ path: `source.related.${i}.name`, message: `The related list name "${r.name}" is used twice.` })
      else names.add(r.name.toLowerCase())
      if (!String(r?.table ?? '').trim() || !String(r?.column ?? '').trim()) out.push({ path: `source.related.${i}`, message: 'A related list needs its table and the lookup column that points at the record.' })
    }
  }
  if (!isObj(d.styles)) out.push({ path: 'styles', message: 'The styles are missing.' })
  else {
    if (!(Number(d.styles.fontSize) >= 5 && Number(d.styles.fontSize) <= 30)) out.push({ path: 'styles.fontSize', message: 'The font size is 5 to 30 points.' })
    for (const k of ['color', 'accent', 'headingColor'] as const) if (!COLOR_RE.test(String(d.styles[k] ?? ''))) out.push({ path: `styles.${k}`, message: 'Colours are written #rrggbb.' })
  }
  let count = 0
  const check = (list: unknown, path: string, depth: number) => {
    if (!Array.isArray(list)) { out.push({ path, message: 'Blocks must be a list.' }); return }
    if (depth > PRINT_LIMITS.maxNesting) { out.push({ path, message: `Blocks are nested more than ${PRINT_LIMITS.maxNesting} deep.` }); return }
    const ids = new Set<string>()
    for (const [i, b] of (list as unknown[]).entries()) {
      const p = `${path}.${i}`
      count++
      if (!isObj(b) || !BLOCK_KINDS.includes(b.kind as BlockKind)) { out.push({ path: p, message: `Unknown block kind "${isObj(b) ? String(b.kind) : ''}".` }); continue }
      const blk = b as unknown as Block
      if (typeof blk.id !== 'string' || !blk.id) out.push({ path: p, message: 'Every block needs an id.' })
      else if (ids.has(blk.id)) out.push({ path: p, message: `The block id "${blk.id}" is used twice.` })
      else ids.add(blk.id)
      for (const k of ['color'] as const) if ((blk as { color?: string })[k] && !COLOR_RE.test(String((blk as { color?: string })[k]))) out.push({ path: `${p}.${k}`, message: 'Colours are written #rrggbb.' })
      switch (blk.kind) {
        case 'heading': if (![1, 2, 3].includes(blk.level)) out.push({ path: `${p}.level`, message: 'The heading level is 1, 2 or 3.' }); break
        case 'table':
          if (!String(blk.rows ?? '').trim()) out.push({ path: `${p}.rows`, message: 'Write the formula that returns the rows of the table.' })
          if (!Array.isArray(blk.columns) || !blk.columns.length) out.push({ path: `${p}.columns`, message: 'A table needs at least one column.' })
          else if (blk.columns.length > 20) out.push({ path: `${p}.columns`, message: 'A table has at most 20 columns.' })
          break
        case 'repeat':
          if (!String(blk.rows ?? '').trim()) out.push({ path: `${p}.rows`, message: 'Write the formula that returns the rows.' })
          check(blk.blocks, `${p}.blocks`, depth + 1)
          break
        case 'columns':
          if (!Array.isArray(blk.columns) || blk.columns.length < 1 || blk.columns.length > 4) out.push({ path: `${p}.columns`, message: 'A columns block has 1 to 4 columns.' })
          else blk.columns.forEach((c, j) => check(c?.blocks, `${p}.columns.${j}.blocks`, depth + 1))
          break
        case 'image':
          if (!['logo', 'static', 'attachment'].includes(blk.source)) out.push({ path: `${p}.source`, message: 'The image source is logo, static or attachment.' })
          if (blk.source === 'static' && !/^data:image\/(png|jpeg);base64,/.test(String(blk.data ?? ''))) out.push({ path: `${p}.data`, message: 'Upload a PNG or JPEG image.' })
          if (blk.source === 'static' && String(blk.data ?? '').length > PRINT_LIMITS.maxStaticImageBytes * 1.37) out.push({ path: `${p}.data`, message: `An image kept in a template is at most ${Math.round(PRINT_LIMITS.maxStaticImageBytes / 1024)} KB.` })
          if (blk.source === 'attachment' && !String(blk.value ?? '').trim()) out.push({ path: `${p}.value`, message: 'Write the formula that returns the images.' })
          break
        case 'barcode':
          if (!['code128', 'qr'].includes(blk.symbology)) out.push({ path: `${p}.symbology`, message: 'The symbology is code128 or qr.' })
          if (!String(blk.value ?? '').trim()) out.push({ path: `${p}.value`, message: 'Write the formula of the encoded text.' })
          break
        case 'chart':
          if (!['bar', 'line', 'pie', 'gauge'].includes(blk.chartType)) out.push({ path: `${p}.chartType`, message: 'The chart type is bar, line, pie or gauge.' })
          if (!Array.isArray(blk.values) || !blk.values.length) out.push({ path: `${p}.values`, message: 'A chart needs at least one value.' })
          if (blk.chartType !== 'gauge' && !String(blk.rows ?? '').trim()) out.push({ path: `${p}.rows`, message: 'Write the formula that returns the rows of the chart.' })
          break
        case 'spacer': if (!(Number(blk.height) >= 0 && Number(blk.height) <= 300)) out.push({ path: `${p}.height`, message: 'A spacer is 0 to 300 mm high.' }); break
        case 'signature': if (!Array.isArray(blk.labels) || blk.labels.length < 1 || blk.labels.length > 4) out.push({ path: `${p}.labels`, message: 'One to four signature lines.' }); break
        case 'keyValue': if (!Array.isArray(blk.items)) out.push({ path: `${p}.items`, message: 'The entries must be a list.' }); break
      }
    }
  }
  check(d.body, 'body', 0)
  if (isObj(d.header)) check(d.header.blocks ?? [], 'header.blocks', 0)
  if (isObj(d.footer)) check(d.footer.blocks ?? [], 'footer.blocks', 0)
  if (count > PRINT_LIMITS.maxBlocks) out.push({ path: 'body', message: `A template has at most ${PRINT_LIMITS.maxBlocks} blocks.` })
  return out
}

/** fills what an older or partial document lacks (never removes anything) */
export function normaliseDoc(raw: unknown): PrintTemplateDoc {
  const base = emptyDoc()
  const d = (isObj(raw) ? raw : {}) as Partial<PrintTemplateDoc>
  return {
    ...base, ...d,
    version: PRINT_DOC_VERSION,
    page: { ...base.page, ...(isObj(d.page) ? d.page : {}), margins: { ...base.page.margins, ...(isObj(d.page?.margins) ? d.page.margins : {}) } },
    styles: { ...base.styles, ...(isObj(d.styles) ? d.styles : {}) },
    source: isObj(d.source) ? (d.source as TemplateSource) : base.source,
    header: { ...base.header, ...(isObj(d.header) ? d.header : {}), blocks: Array.isArray(d.header?.blocks) ? d.header.blocks : [] },
    footer: { ...base.footer, ...(isObj(d.footer) ? d.footer : {}), blocks: Array.isArray(d.footer?.blocks) ? d.footer.blocks : [] },
    body: Array.isArray(d.body) ? d.body : [],
  }
}

/* ------------------------------------------------------------------ rich text markup (shared by engine and designer preview) */

export interface RichRun { text: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string }
export interface RichParagraph { runs: RichRun[]; list?: 'bullet' | 'number'; number?: number }

/**
 * Parses the rich text markup (after formulas were replaced): **bold**, *italic*, __underline__, [color=#rrggbb]...[/color].
 * A blank line separates paragraphs; a single newline is a line break inside the paragraph (kept as "\n" in a run).
 * Unbalanced markers are printed as they are.
 */
export function parseRichText(src: string): RichParagraph[] {
  const paras: RichParagraph[] = []
  const blocks = src.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
  for (const block of blocks) {
    const lines = block.split('\n')
    // list items: every line that starts with "- " or "1. " is its own paragraph
    let buf: string[] = []
    const flush = () => {
      if (buf.length) paras.push({ runs: inline(buf.join('\n')) })
      buf = []
    }
    for (const line of lines) {
      const b = /^\s*[-•]\s+(.*)$/.exec(line)
      const n = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line)
      if (b) { flush(); paras.push({ runs: inline(b[1]), list: 'bullet' }) }
      else if (n) { flush(); paras.push({ runs: inline(n[2]), list: 'number', number: Number(n[1]) }) }
      else buf.push(line)
    }
    flush()
  }
  return paras.filter((p, i) => p.runs.some((r) => r.text) || i < paras.length - 1 || paras.length === 1)
}

function inline(s: string): RichRun[] {
  const out: RichRun[] = []
  const st = { bold: false, italic: false, underline: false, color: [] as string[] }
  let text = ''
  const push = () => {
    if (!text) return
    out.push({ text, ...(st.bold ? { bold: true } : {}), ...(st.italic ? { italic: true } : {}), ...(st.underline ? { underline: true } : {}), ...(st.color.length ? { color: st.color[st.color.length - 1] } : {}) })
    text = ''
  }
  // markers must be balanced to count: count them first
  const count = (m: string) => s.split(m).length - 1
  const okBold = count('**') % 2 === 0
  const okUnder = count('__') % 2 === 0
  const singles = s.replace(/\*\*/g, '').split('*').length - 1
  const okItalic = singles % 2 === 0
  let i = 0
  while (i < s.length) {
    if (okBold && s.startsWith('**', i)) { push(); st.bold = !st.bold; i += 2; continue }
    if (okUnder && s.startsWith('__', i)) { push(); st.underline = !st.underline; i += 2; continue }
    if (okItalic && s[i] === '*') { push(); st.italic = !st.italic; i += 1; continue }
    const c = /^\[color=(#[0-9a-fA-F]{6})\]/.exec(s.slice(i, i + 16))
    if (c) { push(); st.color.push(c[1]); i += c[0].length; continue }
    if (st.color.length && s.startsWith('[/color]', i)) { push(); st.color.pop(); i += 8; continue }
    text += s[i]
    i++
  }
  push()
  return out.length ? out : [{ text: '' }]
}

/**
 * Splits a text property into literal parts and {formula} parts. `{{` and `}}` are literal braces. Braces inside a
 * formula's strings ("...") are kept with the formula.
 */
export function splitTemplateText(s: string): ({ lit: string } | { fx: string })[] {
  const out: ({ lit: string } | { fx: string })[] = []
  let lit = ''
  let i = 0
  while (i < s.length) {
    if (s.startsWith('{{', i)) { lit += '{'; i += 2; continue }
    if (s.startsWith('}}', i)) { lit += '}'; i += 2; continue }
    if (s[i] === '{') {
      let depth = 1
      let j = i + 1
      let inStr = false
      while (j < s.length && depth > 0) {
        const ch = s[j]
        if (inStr) { if (ch === '"') { if (s[j + 1] === '"') j++; else inStr = false } }
        else if (ch === '"') inStr = true
        else if (ch === '{') depth++
        else if (ch === '}') depth--
        j++
      }
      if (depth !== 0) { lit += s.slice(i); break }
      if (lit) { out.push({ lit }); lit = '' }
      out.push({ fx: s.slice(i + 1, j - 1) })
      i = j
      continue
    }
    lit += s[i]
    i++
  }
  if (lit) out.push({ lit })
  return out
}

/** the tokens a header or footer may use for page numbers */
export const PAGE_TOKENS = ['PageNumber', 'PageCount'] as const
