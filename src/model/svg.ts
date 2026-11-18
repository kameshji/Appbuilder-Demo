/**
 * The diagram as a standalone SVG document (pure): what "Export SVG" saves and what "Export PNG" rasterises. Same
 * geometry as the canvas (layout.ts), plain colours (light or dark), text instead of icons, so it renders anywhere.
 */
import type { ColumnDef } from '../platform/contracts.ts'
import type { Model, ModelLayout, ModelTable } from './types.ts'
import { isSystemTable } from './types.ts'
import { CARD_PAD, CARD_W, HEADER_H, ROW_H, areaBox, bounds, boxOf, cardColumns, relationshipPath, rowCenter } from './layout.ts'
import type { CardOptions } from './layout.ts'
import { tableById } from './ops.ts'

export const TYPE_GLYPH: Record<string, string> = {
  text: 'Aa', multiline: '¶', email: '@', url: '⌁', phone: '☏', number: '#', decimal: '#.', currency: '₹',
  boolean: '✓', date: 'd', datetime: 'dt', choice: '≡', lookup: '→', image: '▣', autonumber: '№', file: '⎙',
}

export const AREA_FILL: Record<string, [string, string]> = {
  blue: ['#dbeafe', '#1e3a8a'], green: ['#dcfce7', '#14532d'], amber: ['#fef3c7', '#78350f'], rose: ['#ffe4e6', '#881337'],
  violet: ['#ede9fe', '#4c1d95'], teal: ['#ccfbf1', '#134e4a'], slate: ['#e2e8f0', '#1e293b'],
}

export function columnBadges(t: ModelTable, c: ColumnDef): string[] {
  const out: string[] = []
  if (c.name === t.primaryColumn) out.push('D')
  if (c.required) out.push('R')
  if (c.unique) out.push('U')
  if (c.indexed) out.push('IX')
  if (c.type === 'lookup') out.push('FK')
  if (c.computed?.kind === 'formula') out.push('fx')
  if (c.computed?.kind === 'rollup') out.push('Σ')
  return out
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export interface SvgOptions extends CardOptions {
  dark?: boolean
  /** tables to draw (default: all with a position) */
  ids?: string[]
  title?: string
}

/** crow's-foot marks: `many` = three prongs at (x, y) opening towards dir; `one` = a bar; optional adds a circle */
export function endMarks(x: number, y: number, dir: 1 | -1, many: boolean, optional: boolean, stroke: string): string {
  const parts: string[] = []
  const a = x + dir * 14
  if (many) parts.push(`<path d="M ${a} ${y} L ${x} ${y - 7} M ${a} ${y} L ${x} ${y} M ${a} ${y} L ${x} ${y + 7}" stroke="${stroke}" fill="none" stroke-width="1.4"/>`)
  else parts.push(`<path d="M ${x + dir * 8} ${y - 7} L ${x + dir * 8} ${y + 7}" stroke="${stroke}" stroke-width="1.4"/>`)
  const c = x + dir * (many ? 21 : 15)
  if (optional) parts.push(`<circle cx="${c}" cy="${y}" r="4" fill="white" stroke="${stroke}" stroke-width="1.4"/>`)
  else parts.push(`<path d="M ${c} ${y - 7} L ${c} ${y + 7}" stroke="${stroke}" stroke-width="1.4"/>`)
  return parts.join('')
}

export function renderModelSvg(m: Model, layout: ModelLayout, o: SvgOptions = {}): string {
  const pal = o.dark
    ? { bg: '#0f172a', card: '#1e293b', head: '#334155', text: '#e2e8f0', muted: '#94a3b8', line: '#64748b', border: '#475569', sys: '#3f3f46', view: '#164e63' }
    : { bg: '#ffffff', card: '#ffffff', head: '#f1f5f9', text: '#0f172a', muted: '#64748b', line: '#64748b', border: '#cbd5e1', sys: '#f4f4f5', view: '#ecfeff' }
  const ids = new Set(o.ids ?? m.tables.filter((t) => layout.positions[t.id]).map((t) => t.id))
  const tables = m.tables.filter((t) => ids.has(t.id) && layout.positions[t.id])
  const boxes = tables.map((t) => boxOf(t, layout, o))
  const b = bounds(boxes, 48)
  const top = o.title ? 34 : 0
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(b.w)}" height="${Math.ceil(b.h + top)}" viewBox="${b.x} ${b.y - top} ${b.w} ${b.h + top}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="12">`)
  parts.push(`<rect x="${b.x}" y="${b.y - top}" width="${b.w}" height="${b.h + top}" fill="${pal.bg}"/>`)
  if (o.title) parts.push(`<text x="${b.x + 16}" y="${b.y - top + 22}" font-size="15" font-weight="600" fill="${pal.text}">${esc(o.title)}</text>`)
  // areas behind everything
  for (const a of layout.areas) {
    const box = areaBox(m, layout, a.tables.filter((x) => ids.has(x)), o)
    if (!box) continue
    const [fill, ink] = AREA_FILL[a.color] ?? AREA_FILL.slate
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="10" fill="${fill}" fill-opacity="${o.dark ? 0.12 : 0.55}" stroke="${fill}"/>`)
    parts.push(`<text x="${box.x + 10}" y="${box.y + 13}" font-size="11" font-weight="600" fill="${o.dark ? fill : ink}">${esc(a.name)}</text>`)
  }
  // relationship lines
  for (const r of m.relationships) {
    const child = tableById(m, r.fromTable)
    const parent = tableById(m, r.toTable)
    if (!child || !parent || !ids.has(child.id) || !ids.has(parent.id)) continue
    const col = child.columns.find((c) => c.name === r.fromColumn)
    const p = relationshipPath(boxOf(child, layout, o), rowCenter(child, r.fromColumn, o), boxOf(parent, layout, o), r.kind === 'self')
    parts.push(`<path d="${p.d}" fill="none" stroke="${pal.line}" stroke-width="1.3"${col?.required ? '' : ' stroke-dasharray="5 3"'}/>`)
    parts.push(endMarks(p.from.x, p.from.y, p.from.dir, r.kind !== 'oneToOne', !col?.required, pal.line))
    parts.push(endMarks(p.to.x, p.to.y, p.to.dir, false, !col?.required && r.kind === 'self', pal.line))
  }
  for (const t of tables) {
    const box = boxOf(t, layout, o)
    const sys = isSystemTable(t)
    const view = t.reporting?.kind === 'view'
    parts.push(`<g>`)
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${CARD_W}" height="${box.h}" rx="8" fill="${sys ? pal.sys : pal.card}" stroke="${pal.border}"/>`)
    parts.push(`<path d="M ${box.x} ${box.y + 8} a 8 8 0 0 1 8 -8 h ${CARD_W - 16} a 8 8 0 0 1 8 8 v ${HEADER_H - 8} h ${-CARD_W} z" fill="${view ? pal.view : pal.head}"/>`)
    parts.push(`<text x="${box.x + 12}" y="${box.y + 21}" font-weight="600" font-size="13" fill="${pal.text}">${esc(clip(t.displayName, 26))}</text>`)
    const tag = sys ? 'system' : view ? `${(t.reporting as { role: string }).role} view` : t.reporting?.kind === 'summary' ? 'summary' : t.reporting?.kind === 'date' ? 'dates' : ''
    if (tag) parts.push(`<text x="${box.x + CARD_W - 10}" y="${box.y + 21}" text-anchor="end" font-size="10" fill="${pal.muted}">${tag}</text>`)
    const cols = cardColumns(t, o)
    if (!cols.length) parts.push(`<text x="${box.x + 12}" y="${box.y + HEADER_H + CARD_PAD + 15}" fill="${pal.muted}" font-style="italic">no columns</text>`)
    cols.forEach((c, i) => {
      const y = box.y + HEADER_H + CARD_PAD + i * ROW_H
      parts.push(`<text x="${box.x + 12}" y="${y + 15}" font-size="10" fill="${pal.muted}">${esc(TYPE_GLYPH[c.type] ?? '·')}</text>`)
      parts.push(`<text x="${box.x + 34}" y="${y + 15}" fill="${pal.text}"${c.name === t.primaryColumn ? ' font-weight="600"' : ''}>${esc(clip(c.displayName, 22))}</text>`)
      const badges = columnBadges(t, c).filter((x) => x !== 'D').join(' ')
      if (badges) parts.push(`<text x="${box.x + CARD_W - 10}" y="${y + 15}" text-anchor="end" font-size="9" fill="${pal.muted}">${esc(badges)}</text>`)
    })
    parts.push(`</g>`)
  }
  parts.push(`</svg>`)
  return parts.join('\n')
}
