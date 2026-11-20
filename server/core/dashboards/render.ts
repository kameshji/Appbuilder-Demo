/**
 * A computed dashboard -> a PDF (P2-C second wave, scheduled snapshots; docs/dev/dashboards.md "Snapshots"). Pure apart
 * from the fonts: the tiles' charts are the dashboards' own `tileChartSpec` + `renderChartSvg`, drawn as vectors by the
 * print engine's SVG path (`chartOps` in server/core/print/layout.ts, svgops.ts); tables and text tiles are the print
 * engine's table and text blocks. Nothing here reads data: the rows come from computeDashboard (run as the recipient).
 *
 * Layout: A4 landscape; a heading, the date range and "as of" line, then the tiles in the dashboard's own order (rows of
 * the 12-column grid, each tile as wide as its columns). A tile that failed shows its message instead of a chart.
 */
import type { DashboardDef, TileDef } from '../../../src/dashboards/types.ts'
import type { TileData } from '../../../src/dashboards/viewer.ts'
import type { CalendarSettings, DateRange } from '../../../src/dashboards/dates.ts'
import { rangeLabel } from '../../../src/dashboards/dates.ts'
import { tileChartSpec } from '../../../src/dashboards/tile.ts'
import type { FormatDefaults, NumberFormat } from '../../../src/charts/format.ts'
import { formatDate, formatNumber } from '../../../src/charts/format.ts'
import { MM } from '../../../src/platform/print.ts'
import { PAGE_COUNT, PAGE_NUMBER, layoutDocument, paras, type LayoutStyle, type RBlock } from '../print/layout.ts'
import { pdfBuffer } from '../print/pdf.ts'

export const PAGE = { w: 841.89, h: 595.28 }
const MARGIN = 12 * MM
const GAP_MM = 5
const MAX_TABLE_ROWS = 50

export interface SnapshotPdfInput {
  def: DashboardDef
  tiles: Record<string, TileData>
  range: DateRange | null
  calendar: CalendarSettings
  defaults: FormatDefaults
  /** "as of" text (the generation time in the dashboard time zone) */
  asOf: string
  /** a line under the heading, e.g. whose access the data follows */
  note?: string
  /** fixed creation date of the PDF (tests: deterministic bytes) */
  createdOn?: Date
}

const STYLE: LayoutStyle = { fontSize: 8.5, color: '#1e293b', accent: '#4f46e5', headingColor: '#0f172a', tableStyle: 'zebra', lineHeight: 1.3 }

function cellText(v: unknown, f: NumberFormat | undefined, d: FormatDefaults, cal: CalendarSettings, grain?: string): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number') return formatNumber(v, f ?? {}, d)
  if (v instanceof Date) return formatDate(v, (grain ?? 'day') as never, { fiscalYearStart: cal.fiscalYearStart, timeZone: d.timeZone }, d)
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

function tableBlock(tile: TileDef, rows: Record<string, unknown>[], i: SnapshotPdfInput): RBlock {
  const q = tile.query!
  const v = tile.visual ?? {}
  const groups = [...(q.groupBy ?? []), ...(q.bucket ? ['__bucket'] : [])]
  const series: { key: string; label?: string; format?: NumberFormat }[] = v.series ?? [...q.measures.map((m) => ({ key: m.id, label: m.label ?? m.id })), ...(q.computed ?? []).map((c) => ({ key: c.id, label: c.label ?? c.id }))]
  const cols = [
    ...groups.map((g) => ({ key: g, header: g === '__bucket' ? (q.bucket?.col ?? 'Period') : g, format: undefined as NumberFormat | undefined, num: false })),
    ...series.map((s) => ({ key: s.key, header: s.label ?? s.key, format: s.format ?? v.format, num: true })),
  ].slice(0, 12)
  const shown = rows.slice(0, MAX_TABLE_ROWS)
  return {
    k: 'table', repeatHeader: true, style: 'zebra', fontSize: 7.5, avoidRowBreak: true, emptyText: 'No data',
    columns: cols.map((c) => ({ header: c.header, align: c.num ? 'right' as const : 'left' as const })),
    rows: shown.map((r) => ({ kind: 'row' as const, cells: cols.map((c) => cellText(r[c.key], c.format, i.defaults, i.calendar, c.key === '__bucket' ? q.bucket?.unit : undefined)) })),
    ...(rows.length > shown.length ? { spaceAfter: 1 } : {}),
  }
}

function tileBlocks(tile: TileDef, widthMm: number, i: SnapshotPdfInput): RBlock[] {
  const out: RBlock[] = []
  if (tile.title) out.push({ k: 'heading', level: 3, text: tile.title, align: 'left', spaceAfter: 1 })
  if (tile.kind === 'text') {
    out.push({ k: 'text', paras: paras(tile.text ?? ''), align: 'left' })
    return out
  }
  const data = i.tiles[tile.id]
  if (!data) { out.push({ k: 'notice', text: 'No data for this tile.' }); return out }
  if (data.error) { out.push({ k: 'notice', text: data.error }); return out }
  if (tile.kind === 'table') {
    out.push(tableBlock(tile, data.rows, i))
    if (data.rows.length > MAX_TABLE_ROWS) out.push({ k: 'text', paras: paras(`The first ${MAX_TABLE_ROWS} of ${data.rows.length} rows.`), align: 'left', size: 7, color: '#64748b' })
  } else {
    const heightMm = Math.max(30, Math.min(110, tile.layout.h * 19))
    const pxW = Math.max(120, Math.round((widthMm * MM) / 0.75))
    const pxH = Math.max(90, Math.round((heightMm * MM) / 0.75))
    // the tile's title is printed above; the chart keeps no title of its own (as on the dashboard)
    const { width: _w, height: _h, ...spec } = tileChartSpec(tile, data.rows, { width: pxW, height: pxH }, { calendar: i.calendar, defaults: i.defaults })
    out.push({ k: 'chart', chart: { spec, rows: data.rows }, height: heightMm })
  }
  if (data.filtered) out.push({ k: 'text', paras: paras('Based on the rows you can see.'), align: 'left', size: 6.5, color: '#64748b', spaceAfter: 1 })
  return out
}

/** the blocks of a snapshot (exported for tests) */
export function snapshotBlocks(i: SnapshotPdfInput): RBlock[] {
  const contentMm = (PAGE.w - 2 * MARGIN) / MM
  const body: RBlock[] = [
    { k: 'heading', level: 1, text: i.def.title, align: 'left' },
    { k: 'text', paras: paras(`${rangeLabel(i.range)} · as of ${i.asOf}${i.note ? ` · ${i.note}` : ''}`), align: 'left', size: 8, color: '#64748b', spaceAfter: 4 },
  ]
  if (i.def.description) body.splice(1, 0, { k: 'text', paras: paras(i.def.description), align: 'left', color: '#475569', spaceAfter: 1 })
  const tiles = [...i.def.tiles].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
  // rows of the grid: tiles that start on the same grid row print side by side
  const rows: TileDef[][] = []
  for (const t of tiles) {
    const last = rows[rows.length - 1]
    if (last && last[0]!.layout.y === t.layout.y && last.reduce((a, x) => a + x.layout.w, 0) + t.layout.w <= 12) last.push(t)
    else rows.push([t])
  }
  for (const r of rows) {
    const n = r.length
    const unit = (contentMm - GAP_MM * (n - 1)) / 12
    if (n === 1 && r[0]!.layout.w === 12) {
      body.push(...tileBlocks(r[0]!, contentMm, i), { k: 'spacer', h: 3 })
      continue
    }
    body.push({ k: 'columns', gap: GAP_MM, keepTogether: true, cols: r.map((t) => ({ width: unit * t.layout.w, blocks: tileBlocks(t, unit * t.layout.w, i) })), spaceAfter: 4 })
  }
  return body
}

export async function renderSnapshotPdf(i: SnapshotPdfInput): Promise<{ bytes: Buffer; pages: number }> {
  const footer = (): RBlock[] => [{ k: 'text', paras: [{ runs: [{ text: `${i.def.title} · page ${PAGE_NUMBER} of ${PAGE_COUNT}` }] }], align: 'right', size: 7, color: '#94a3b8' }]
  const pages = layoutDocument({
    pageW: PAGE.w, pageH: PAGE.h, margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }, style: STYLE,
    body: snapshotBlocks(i), header: () => [], footer, images: new Map(), maxPages: 60,
  })
  const bytes = await pdfBuffer({ pageW: PAGE.w, pageH: PAGE.h, pages, images: new Map(), meta: { title: i.def.title, subject: `Dashboard snapshot, ${rangeLabel(i.range)}`, createdOn: i.createdOn ?? new Date() } })
  return { bytes, pages: pages.length }
}
