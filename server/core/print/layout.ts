/**
 * The layout engine of print templates (docs/dev/pdf.md "Layout"). Input: resolved blocks (every formula already
 * evaluated by bind.ts) and the page setup. Output: pages of drawing operations in points (origin top-left), which
 * pdf.ts writes with pdfkit. Pure and synchronous: the same input gives the same pages (golden tests compare text and
 * positions).
 *
 * Blocks become boxes (a paragraph line, a table row, an image row, a heading ...); pagination places boxes on pages:
 *  - a box that does not fit goes to the next page; a box taller than a page is sliced (clipped) over several pages;
 *  - paragraphs keep at least 2 lines at the bottom and the top of a page (orphans and widows);
 *  - headings, group headers and table headers stay with what follows (keepWithNext);
 *  - a table's header row is repeated at the top of every page the table continues on;
 *  - keepTogether moves a whole block to the next page when it fits on one page;
 *  - a page break block starts a new page.
 * Header and footer are laid out per page after the body, so "Page X of Y" knows Y.
 */
import { MM, parseRichText, type Align, type RichParagraph, type RichRun, type TableStyle } from '../../../src/platform/print.ts'
import { lineMetrics, segments, segmentWidth, splitGraphemes, textWidth, type FaceId, type TextStyle } from './text.ts'
import { code128Modules, qrMatrix } from './barcode.ts'
import { chartShapes, type ChartSpec } from './chart.ts'

/* ------------------------------------------------------------------ drawing operations */

export type Op =
  | { t: 'text'; x: number; y: number; text: string; face: FaceId; size: number; color: string; synthItalic?: boolean; actual?: string; endActual?: boolean }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; lw?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; lw: number; dash?: number[] }
  | { t: 'path'; d: string; x: number; y: number; fill?: string; stroke?: string; lw?: number }
  | { t: 'image'; x: number; y: number; w: number; h: number; key: string }
  | { t: 'clip'; x: number; y: number; w: number; h: number }
  | { t: 'unclip' }

export interface Page { ops: Op[] }

/* ------------------------------------------------------------------ resolved blocks */

export interface RBase { spaceBefore?: number; spaceAfter?: number; keepTogether?: boolean }
export interface ImageRef { key: string; width: number; height: number; caption?: string }
export interface RTableRow { cells: string[]; kind: 'row' | 'group' | 'subtotal' | 'total' }
export type RBlock =
  | (RBase & { k: 'heading'; text: string; level: 1 | 2 | 3; align: Align; color?: string })
  | (RBase & { k: 'text'; paras: RichParagraph[]; align: Align; size?: number; color?: string })
  | (RBase & { k: 'image'; images: ImageRef[]; width?: number; height?: number; align: 'left' | 'center' | 'right'; perRow: number })
  | (RBase & { k: 'table'; columns: { header: string; width?: number; flex?: number; align: 'left' | 'center' | 'right' }[]; rows: RTableRow[]; repeatHeader: boolean; style: TableStyle; fontSize?: number; avoidRowBreak: boolean; emptyText: string })
  | (RBase & { k: 'kv'; items: { label: string; value: string }[]; columns: number; labelWidth?: number; boxed: boolean })
  | (RBase & { k: 'columns'; cols: { width?: number; blocks: RBlock[] }[]; gap: number })
  | (RBase & { k: 'spacer'; h: number })
  | (RBase & { k: 'line'; thickness: number; color: string; dashed: boolean })
  | (RBase & { k: 'pageBreak' })
  | (RBase & { k: 'barcode'; symbology: 'code128' | 'qr'; text: string; width?: number; height?: number; showText: boolean; align: 'left' | 'center' | 'right' })
  | (RBase & { k: 'chart'; spec: ChartSpec; height: number })
  | (RBase & { k: 'signature'; labels: string[]; showDate: boolean })
  /** a problem shown in the document instead of the block (e.g. a barcode that cannot encode its text) */
  | (RBase & { k: 'notice'; text: string })

export interface LayoutStyle { fontSize: number; color: string; accent: string; headingColor: string; tableStyle: TableStyle; lineHeight: number }

/* ------------------------------------------------------------------ boxes */

interface Box {
  h: number
  ops: Op[]
  keepWithNext?: boolean
  /** a subtotal or total row: it does not start a page on its own, the row before it comes along */
  keepWithPrev?: boolean
  breakBefore?: boolean
  /** lines of one paragraph: widows and orphans */
  para?: { id: number; index: number; count: number }
  /** a table header (repeated) and rows of the table */
  tableHeader?: number
  tableRow?: number
  /** a keepTogether block */
  group?: number
  /** vertical space only: dropped at the top of a page */
  space?: boolean
}

let seq = 0
const nextId = () => ++seq

const PAD = 3.2 // cell padding (pt)
const HARD_BREAK = '\n'
/** placeholders of {PageNumber} / {PageCount} kept by the binder until the page is known */
export const PAGE_NUMBER = ''
export const PAGE_COUNT = ''

export const mm = (v: number | undefined, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d) * MM

function shift(ops: Op[], dx: number, dy: number): Op[] {
  return ops.map((o) => {
    switch (o.t) {
      case 'text': case 'rect': case 'image': case 'clip': case 'path': return { ...o, x: o.x + dx, y: o.y + dy }
      case 'line': return { ...o, x1: o.x1 + dx, x2: o.x2 + dx, y1: o.y1 + dy, y2: o.y2 + dy }
      default: return o
    }
  })
}

/* ------------------------------------------------------------------ text */

interface Token { text: string; st: TextStyle; color: string; underline: boolean; space: boolean; br: boolean; w: number }

function tokenize(runs: RichRun[], base: { size: number; color: string; bold?: boolean }): Token[] {
  const out: Token[] = []
  for (const r of runs) {
    const st: TextStyle = { size: base.size, bold: !!(r.bold || base.bold), italic: !!r.italic }
    const color = r.color ?? base.color
    for (const part of r.text.split(/(\n|[ \t ]+)/)) {
      if (!part) continue
      if (part === HARD_BREAK) { out.push({ text: '', st, color, underline: false, space: false, br: true, w: 0 }); continue }
      const space = /^[ \t ]+$/.test(part)
      const text = space ? part.replace(/\t/g, '    ') : part
      out.push({ text, st, color, underline: !!r.underline, space, br: false, w: textWidth(text, st) })
    }
  }
  return out
}

interface Line { tokens: Token[]; width: number; hasDeva: boolean }

const DEVA_RE = /[ऀ-ॿ]/

function breakLines(tokens: Token[], width: number): Line[] {
  const lines: Line[] = []
  let cur: Token[] = []
  let w = 0
  const end = () => {
    while (cur.length && cur[cur.length - 1].space) w -= cur.pop()!.w
    lines.push({ tokens: cur, width: w, hasDeva: cur.some((t) => DEVA_RE.test(t.text)) })
    cur = []
    w = 0
  }
  for (const t of tokens) {
    if (t.br) { end(); continue }
    if (t.space) {
      if (!cur.length) continue
      cur.push(t)
      w += t.w
      continue
    }
    if (w + t.w <= width + 0.01) {
      cur.push(t)
      w += t.w
      continue
    }
    // does not fit: a new line (unless this one has only spaces), then a word wider than a line is cut between
    // grapheme clusters (a conjunct with its matras stays together)
    if (cur.some((x) => !x.space)) end()
    else { cur = []; w = 0 }
    if (t.w <= width + 0.01) {
      cur.push(t)
      w = t.w
      continue
    }
    let piece = ''
    for (const g of splitGraphemes(t.text)) {
      if (piece && textWidth(piece + g, t.st) > width) {
        cur.push({ ...t, text: piece, w: textWidth(piece, t.st) })
        w = cur[cur.length - 1].w
        end()
        piece = g
      } else piece += g
    }
    if (piece) { cur.push({ ...t, text: piece, w: textWidth(piece, t.st) }); w = cur[cur.length - 1].w }
  }
  if (cur.length || !lines.length) end()
  return lines
}

function lineHeightOf(size: number, lh: number, deva: boolean): number {
  return size * (deva ? Math.max(lh, 1.5) : lh)
}

/**
 * A line with Devanagari: its glyphs are in visual order (a pre-base matra comes first), so the line is wrapped in one
 * ActualText span with the logical text: copy, search and text extraction get the real characters.
 */
function actualLine(ops: Op[], text: string): Op[] {
  const texts = ops.filter((o): o is Extract<Op, { t: 'text' }> => o.t === 'text')
  if (!texts.some((o) => o.face.startsWith('deva'))) return ops
  texts[0].actual = text
  texts[texts.length - 1].endActual = true
  return ops
}

/** draws one line's tokens at (x, baseline) */
function drawTokens(tokens: Token[], x: number, baseline: number, extraPerSpace: number): Op[] {
  const ops: Op[] = []
  // merge neighbours of one style (fewer operations, spaces kept in the text for copy and search)
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    let text = t.text
    let w = t.w
    let j = i + 1
    if (!extraPerSpace) {
      while (j < tokens.length && tokens[j].st.bold === t.st.bold && tokens[j].st.italic === t.st.italic && tokens[j].st.size === t.st.size && tokens[j].color === t.color && tokens[j].underline === t.underline) {
        text += tokens[j].text
        w += tokens[j].w
        j++
      }
    } else if (t.space) {
      x += t.w + extraPerSpace
      i++
      continue
    }
    if (!/^\s*$/.test(text)) {
      let sx = x
      for (const s of segments(text, t.st)) {
        ops.push({ t: 'text', x: sx, y: baseline, text: s.text, face: s.face, size: t.st.size, color: t.color, ...(s.synthItalic ? { synthItalic: true } : {}) })
        sx += segmentWidth(s, t.st.size)
      }
      if (t.underline) ops.push({ t: 'line', x1: x, y1: baseline + t.st.size * 0.14, x2: x + w, y2: baseline + t.st.size * 0.14, color: t.color, lw: Math.max(0.4, t.st.size * 0.06) })
    }
    x += w
    i = j
  }
  return ops
}

/** a paragraph as lines (each line a box) */
function paragraphBoxes(p: RichParagraph, width: number, o: { size: number; color: string; align: Align; lh: number; bold?: boolean }): Box[] {
  const indent = p.list ? o.size * 1.5 : 0
  const tokens = tokenize(p.runs, { size: o.size, color: o.color, bold: o.bold })
  const lines = breakLines(tokens, width - indent)
  const id = nextId()
  return lines.map((ln, i) => {
    const h = lineHeightOf(o.size, o.lh, ln.hasDeva)
    const baseline = h * 0.5 + o.size * 0.36
    const avail = width - indent
    let x = indent
    let extra = 0
    if (o.align === 'center') x += (avail - ln.width) / 2
    else if (o.align === 'right') x += avail - ln.width
    else if (o.align === 'justify' && i < lines.length - 1) {
      const spaces = ln.tokens.filter((t) => t.space).length
      if (spaces) extra = (avail - ln.width) / spaces
    }
    const ops = actualLine(drawTokens(ln.tokens, x, baseline, extra), ln.tokens.map((t) => t.text).join(''))
    if (i === 0 && p.list) {
      const marker = p.list === 'bullet' ? '•' : `${p.number ?? 1}.`
      for (const s of segments(marker, { size: o.size })) ops.push({ t: 'text', x: 0, y: baseline, text: s.text, face: s.face, size: o.size, color: o.color })
    }
    return { h, ops, para: { id, index: i, count: lines.length } }
  })
}

/** one line of plain text, clipped with an ellipsis to a width (table cells use wrapped text instead) */
export function wrapPlain(text: string, width: number, st: TextStyle): string[] {
  const toks = tokenize([{ text }], { size: st.size, color: '#000', bold: st.bold })
  return breakLines(toks, width).map((l) => l.tokens.map((t) => t.text).join(''))
}

/* ------------------------------------------------------------------ blocks */

interface Ctx {
  width: number
  style: LayoutStyle
  images: Map<string, { width: number; height: number }>
  /** page body height (the tallest a box may be before slicing) */
  frame: number
}

function textBlockBoxes(paras: RichParagraph[], width: number, o: { size: number; color: string; align: Align; lh: number; bold?: boolean }): Box[] {
  const out: Box[] = []
  paras.forEach((p, i) => {
    out.push(...paragraphBoxes(p, width, o))
    if (i < paras.length - 1) out.push({ h: o.size * (p.list && paras[i + 1].list ? 0.15 : 0.5), ops: [], space: true })
  })
  return out
}

function tableBoxes(b: Extract<RBlock, { k: 'table' }>, c: Ctx): Box[] {
  const size = b.fontSize ?? Math.max(6, c.style.fontSize - 1)
  const lh = 1.25
  const n = b.columns.length
  // widths: fixed mm widths, the rest shared by flex
  const fixed = b.columns.reduce((a, col) => a + (col.width ? mm(col.width) : 0), 0)
  const flexSum = b.columns.reduce((a, col) => a + (col.width ? 0 : (col.flex ?? 1)), 0)
  const rest = Math.max(0, c.width - fixed)
  let widths = b.columns.map((col) => (col.width ? mm(col.width) : flexSum ? (rest * (col.flex ?? 1)) / flexSum : 0))
  const total = widths.reduce((a, x) => a + x, 0)
  if (total > c.width + 0.5) widths = widths.map((w) => (w * c.width) / total)
  const xs: number[] = []
  widths.reduce((a, w, i) => ((xs[i] = a), a + w), 0)
  const style = b.style
  const tid = nextId()
  const borderColor = '#cbd5e1'
  const accent = c.style.accent

  const rowBox = (cells: string[], kind: 'header' | RTableRow['kind'], zebraIndex: number): Box => {
    const bold = kind !== 'row'
    const st: TextStyle = { size, bold }
    const color = kind === 'header' ? '#ffffff' : c.style.color
    if (kind === 'group') {
      const lines = wrapPlain(cells[0] ?? '', c.width - PAD * 2, st)
      const h = lines.length * lineHeightOf(size, lh, lines.some((l) => DEVA_RE.test(l))) + PAD * 2
      const ops: Op[] = [{ t: 'rect', x: 0, y: 0, w: c.width, h, fill: tint(accent, 0.12) }]
      let y = PAD
      for (const l of lines) {
        const lh2 = lineHeightOf(size, lh, DEVA_RE.test(l))
        ops.push(...textLine(l, PAD, y + lh2 * 0.5 + size * 0.36, st, c.style.headingColor))
        y += lh2
      }
      if (style === 'grid') ops.push({ t: 'rect', x: 0, y: 0, w: c.width, h, stroke: borderColor, lw: 0.5 })
      return { h, ops, tableRow: tid, keepWithNext: true }
    }
    const wrapped = cells.map((txt, i) => wrapPlain(txt ?? '', Math.max(4, widths[i] - PAD * 2), st))
    const lineH = (l: string[]) => l.reduce((a, s) => a + lineHeightOf(size, lh, DEVA_RE.test(s)), 0)
    const h = Math.max(...wrapped.map(lineH), lineHeightOf(size, lh, false)) + PAD * 2
    const ops: Op[] = []
    if (kind === 'header') ops.push({ t: 'rect', x: 0, y: 0, w: c.width, h, fill: accent })
    else if (kind === 'total' || kind === 'subtotal') ops.push({ t: 'rect', x: 0, y: 0, w: c.width, h, fill: kind === 'total' ? tint(accent, 0.18) : '#f1f5f9' })
    else if ((style === 'zebra') && zebraIndex % 2 === 1) ops.push({ t: 'rect', x: 0, y: 0, w: c.width, h, fill: '#f8fafc' })
    wrapped.forEach((lines, i) => {
      let y = PAD
      for (const l of lines) {
        const lh2 = lineHeightOf(size, lh, DEVA_RE.test(l))
        const w = textWidth(l, st)
        const al = b.columns[i]?.align ?? 'left'
        const x = al === 'right' ? xs[i] + widths[i] - PAD - w : al === 'center' ? xs[i] + (widths[i] - w) / 2 : xs[i] + PAD
        ops.push(...textLine(l, x, y + lh2 * 0.5 + size * 0.36, st, color))
        y += lh2
      }
    })
    if (style === 'grid') {
      ops.push({ t: 'rect', x: 0, y: 0, w: c.width, h, stroke: borderColor, lw: 0.5 })
      for (let i = 1; i < n; i++) ops.push({ t: 'line', x1: xs[i], y1: 0, x2: xs[i], y2: h, color: borderColor, lw: 0.5 })
    } else if (style === 'lines' || style === 'zebra') {
      ops.push({ t: 'line', x1: 0, y1: h, x2: c.width, y2: h, color: kind === 'header' ? accent : '#e2e8f0', lw: 0.5 })
    }
    if (kind === 'total' || kind === 'subtotal') ops.push({ t: 'line', x1: 0, y1: 0, x2: c.width, y2: 0, color: '#64748b', lw: 0.8 })
    return { h, ops, ...(kind === 'header' ? { tableHeader: tid, keepWithNext: true } : { tableRow: tid }), ...(kind === 'total' || kind === 'subtotal' ? { keepWithPrev: true } : {}) }
  }

  const out: Box[] = []
  out.push(rowBox(b.columns.map((col) => col.header), 'header', 0))
  if (!b.repeatHeader) delete out[0].tableHeader
  if (!b.rows.length) {
    out.push({ h: size * 2.2, ops: textLine(b.emptyText || 'No rows.', PAD, size * 1.4, { size, italic: true }, '#64748b'), tableRow: tid })
    return out
  }
  let z = 0
  for (const r of b.rows) {
    if (r.kind === 'group') z = 0
    const box = rowBox(r.cells, r.kind, r.kind === 'row' ? z++ : 0)
    if (!b.avoidRowBreak) box.para = undefined
    out.push(box)
  }
  return out
}

function textLine(text: string, x: number, baseline: number, st: TextStyle, color: string): Op[] {
  const ops: Op[] = []
  let sx = x
  for (const s of segments(text, st)) {
    ops.push({ t: 'text', x: sx, y: baseline, text: s.text, face: s.face, size: st.size, color, ...(s.synthItalic ? { synthItalic: true } : {}) })
    sx += segmentWidth(s, st.size)
  }
  return actualLine(ops, text)
}

/** a colour mixed with white */
export function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(255 - (255 - c) * amount)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

function kvBoxes(b: Extract<RBlock, { k: 'kv' }>, c: Ctx): Box[] {
  const cols = Math.max(1, Math.min(4, b.columns))
  const gap = 8
  const cw = (c.width - gap * (cols - 1)) / cols
  const size = c.style.fontSize
  const out: Box[] = []
  for (let i = 0; i < b.items.length; i += cols) {
    const row = b.items.slice(i, i + cols)
    const cells = row.map((it) => {
      if (b.boxed) {
        const valSize = size * 1.6
        const lab = wrapPlain(it.label, cw - 12, { size: size * 0.85 })
        const val = wrapPlain(it.value, cw - 12, { size: valSize, bold: true })
        const ops: Op[] = []
        let y = 6
        for (const l of lab) { const h = lineHeightOf(size * 0.85, 1.2, DEVA_RE.test(l)); ops.push(...textLine(l, 6, y + h * 0.5 + size * 0.85 * 0.36, { size: size * 0.85 }, '#64748b')); y += h }
        y += 2
        for (const l of val) { const h = lineHeightOf(valSize, 1.15, DEVA_RE.test(l)); ops.push(...textLine(l, 6, y + h * 0.5 + valSize * 0.36, { size: valSize, bold: true }, c.style.headingColor)); y += h }
        return { h: y + 6, ops }
      }
      const lw = b.labelWidth ? mm(b.labelWidth) : Math.min(cw * 0.42, 34 * MM)
      const lab = wrapPlain(it.label, lw - 4, { size, bold: false })
      const val = wrapPlain(it.value, cw - lw, { size, bold: true })
      const ops: Op[] = []
      let y1 = 0
      for (const l of lab) { const h = lineHeightOf(size, c.style.lineHeight, DEVA_RE.test(l)); ops.push(...textLine(l, 0, y1 + h * 0.5 + size * 0.36, { size }, '#64748b')); y1 += h }
      let y2 = 0
      for (const l of val) { const h = lineHeightOf(size, c.style.lineHeight, DEVA_RE.test(l)); ops.push(...textLine(l, lw, y2 + h * 0.5 + size * 0.36, { size, bold: true }, c.style.color)); y2 += h }
      return { h: Math.max(y1, y2) + 3, ops }
    })
    const h = Math.max(...cells.map((x) => x.h))
    const ops: Op[] = []
    cells.forEach((cell, j) => {
      const x = j * (cw + gap)
      if (b.boxed) ops.push({ t: 'rect', x, y: 0, w: cw, h, fill: '#f8fafc', stroke: '#e2e8f0', lw: 0.6 })
      ops.push(...shift(cell.ops, x, 0))
    })
    out.push({ h: h + (b.boxed ? 6 : 0), ops })
  }
  return out
}

function imageBoxes(b: Extract<RBlock, { k: 'image' }>, c: Ctx): Box[] {
  const out: Box[] = []
  if (!b.images.length) return out
  const per = b.images.length === 1 ? 1 : Math.max(1, Math.min(6, b.perRow))
  const gap = 6
  const slotW = per === 1 ? c.width : (c.width - gap * (per - 1)) / per
  for (let i = 0; i < b.images.length; i += per) {
    const row = b.images.slice(i, i + per)
    let rowH = 0
    const placed = row.map((im) => {
      const natW = im.width * 0.75
      const natH = im.height * 0.75
      let w = b.width ? mm(b.width) : Math.min(natW, slotW)
      w = Math.min(w, slotW)
      let h = b.height ? mm(b.height) : (w * natH) / Math.max(1, natW)
      if (b.height && !b.width) w = Math.min(slotW, (h * natW) / Math.max(1, natH))
      // never taller than most of a page
      const maxH = c.frame * 0.85
      if (h > maxH) { w = (w * maxH) / h; h = maxH }
      const cap = im.caption ? wrapPlain(im.caption, slotW, { size: c.style.fontSize * 0.85 }) : []
      const capH = cap.length * c.style.fontSize * 0.85 * 1.3
      rowH = Math.max(rowH, h + (capH ? capH + 3 : 0))
      return { im, w, h, cap }
    })
    const ops: Op[] = []
    placed.forEach((p, j) => {
      const slotX = per === 1 ? 0 : j * (slotW + gap)
      const x = per === 1 ? (b.align === 'center' ? (c.width - p.w) / 2 : b.align === 'right' ? c.width - p.w : 0) : slotX + (slotW - p.w) / 2
      ops.push({ t: 'image', x, y: 0, w: p.w, h: p.h, key: p.im.key })
      let y = p.h + 3
      for (const l of p.cap) {
        const s = c.style.fontSize * 0.85
        const w = textWidth(l, { size: s })
        ops.push(...textLine(l, per === 1 ? x + (p.w - w) / 2 : slotX + (slotW - w) / 2, y + s, { size: s }, '#475569'))
        y += s * 1.3
      }
    })
    out.push({ h: rowH + (i + per < b.images.length ? gap : 0), ops })
  }
  return out
}

function barcodeBox(b: Extract<RBlock, { k: 'barcode' }>, c: Ctx): Box {
  const ops: Op[] = []
  if (b.symbology === 'qr') {
    const m = qrMatrix(b.text)
    const w = Math.min(c.width, mm(b.width, 25))
    const quiet = 2
    const mod = w / (m.size + quiet * 2)
    const x0 = (b.align === 'center' ? (c.width - w) / 2 : b.align === 'right' ? c.width - w : 0)
    // one path per row of dark runs (compact)
    let d = ''
    for (let r = 0; r < m.size; r++) {
      let cc = 0
      while (cc < m.size) {
        if (!m.dark(r, cc)) { cc++; continue }
        let e = cc
        while (e < m.size && m.dark(r, e)) e++
        const x = (quiet + cc) * mod
        const y = (quiet + r) * mod
        d += `M${x.toFixed(3)} ${y.toFixed(3)}h${((e - cc) * mod).toFixed(3)}v${mod.toFixed(3)}h${(-(e - cc) * mod).toFixed(3)}Z`
        cc = e
      }
    }
    ops.push({ t: 'path', d, x: x0, y: 0, fill: '#000000' })
    let h = w
    if (b.showText) {
      const s = 7
      const tw = textWidth(b.text, { size: s })
      ops.push(...textLine(b.text, x0 + (w - tw) / 2, h + s, { size: s }, '#000000'))
      h += s * 1.6
    }
    return { h, ops }
  }
  const mods = code128Modules(b.text)
  const units = mods.reduce((a, [, w]) => a + w, 0) + 20
  const w = Math.min(c.width, mm(b.width, Math.max(40, units * 0.3)))
  const unit = w / units
  const h = mm(b.height, 14)
  const x0 = (b.align === 'center' ? (c.width - w) / 2 : b.align === 'right' ? c.width - w : 0)
  let x = x0 + 10 * unit
  let d = ''
  for (const [bar, n] of mods) {
    if (bar) d += `M${(x - x0).toFixed(3)} 0h${(n * unit).toFixed(3)}v${h.toFixed(3)}h${(-n * unit).toFixed(3)}Z`
    x += n * unit
  }
  ops.push({ t: 'path', d, x: x0, y: 0, fill: '#000000' })
  let total = h
  if (b.showText) {
    const s = 8
    const tw = textWidth(b.text, { size: s })
    ops.push(...textLine(b.text, x0 + (w - tw) / 2, h + s + 1, { size: s }, '#000000'))
    total += s * 1.6
  }
  return { h: total, ops }
}

function chartBox(b: Extract<RBlock, { k: 'chart' }>, c: Ctx): Box {
  const h = Math.min(mm(b.height, 60), c.frame * 0.9)
  const w = c.width
  const ops: Op[] = []
  const measure = (t: string, size: number, bold?: boolean) => textWidth(t, { size, bold })
  for (const s of chartShapes(b.spec, w, h, measure)) {
    if (s.t === 'rect') ops.push({ t: 'rect', x: s.x, y: s.y, w: s.w, h: s.h, ...(s.fill ? { fill: s.fill } : {}), ...(s.stroke ? { stroke: s.stroke, lw: s.lw ?? 1 } : {}) })
    else if (s.t === 'line') ops.push({ t: 'line', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, color: s.color, lw: s.lw, ...(s.dash ? { dash: s.dash } : {}) })
    else if (s.t === 'path') ops.push({ t: 'path', d: s.d, x: 0, y: 0, ...(s.fill ? { fill: s.fill } : {}), ...(s.stroke ? { stroke: s.stroke, lw: s.lw ?? 1 } : {}) })
    else {
      const st: TextStyle = { size: s.size, bold: s.bold }
      const tw = textWidth(s.text, st)
      const x = s.anchor === 'middle' ? s.x - tw / 2 : s.anchor === 'end' ? s.x - tw : s.x
      ops.push(...textLine(s.text, x, s.y, st, s.color))
    }
  }
  return { h, ops }
}

function signatureBox(b: Extract<RBlock, { k: 'signature' }>, c: Ctx): Box {
  const n = Math.max(1, b.labels.length)
  const gap = 18
  const w = (c.width - gap * (n - 1)) / n
  const size = c.style.fontSize * 0.9
  const ops: Op[] = []
  const lineY = 34
  b.labels.forEach((label, i) => {
    const x = i * (w + gap)
    ops.push({ t: 'line', x1: x, y1: lineY, x2: x + w, y2: lineY, color: '#334155', lw: 0.7 })
    ops.push(...textLine(label, x, lineY + size + 3, { size }, '#475569'))
    if (b.showDate) {
      ops.push(...textLine('Date:', x, lineY + size * 2 + 14, { size }, '#475569'))
      const dx = x + textWidth('Date: ', { size })
      ops.push({ t: 'line', x1: dx, y1: lineY + size * 2 + 15, x2: x + w * 0.7, y2: lineY + size * 2 + 15, color: '#94a3b8', lw: 0.5 })
    }
  })
  return { h: lineY + size * (b.showDate ? 3 : 1.6) + (b.showDate ? 16 : 4), ops }
}

export function blockBoxes(b: RBlock, c: Ctx): Box[] {
  const s = c.style
  let boxes: Box[]
  switch (b.k) {
    case 'heading': {
      const size = s.fontSize * (b.level === 1 ? 1.8 : b.level === 2 ? 1.4 : 1.15)
      boxes = textBlockBoxes([{ runs: [{ text: b.text }] }], c.width, { size, color: b.color ?? s.headingColor, align: b.align, lh: 1.25, bold: true })
      for (const x of boxes) x.keepWithNext = true
      break
    }
    case 'text':
      boxes = textBlockBoxes(b.paras, c.width, { size: b.size ?? s.fontSize, color: b.color ?? s.color, align: b.align, lh: s.lineHeight })
      break
    case 'notice':
      boxes = textBlockBoxes([{ runs: [{ text: b.text, italic: true }] }], c.width, { size: s.fontSize * 0.9, color: '#b45309', align: 'left', lh: s.lineHeight })
      break
    case 'table': boxes = tableBoxes(b, c); break
    case 'kv': boxes = kvBoxes(b, c); break
    case 'image': boxes = imageBoxes(b, c); break
    case 'spacer': boxes = [{ h: mm(b.h), ops: [] }]; break
    case 'line': boxes = [{ h: b.thickness + 6, ops: [{ t: 'line', x1: 0, y1: 3 + b.thickness / 2, x2: c.width, y2: 3 + b.thickness / 2, color: b.color, lw: b.thickness, ...(b.dashed ? { dash: [3, 2] } : {}) }] }]; break
    case 'pageBreak': boxes = [{ h: 0, ops: [], breakBefore: true }]; return boxes
    case 'barcode': boxes = [barcodeBox(b, c)]; break
    case 'chart': boxes = [chartBox(b, c)]; break
    case 'signature': boxes = [signatureBox(b, c)]; break
    case 'columns': boxes = columnsBoxes(b, c); break
  }
  if (b.keepTogether && boxes.length > 1) {
    const g = nextId()
    for (const x of boxes) x.group = g
  }
  const out: Box[] = []
  if (b.spaceBefore) out.push({ h: mm(b.spaceBefore), ops: [], space: true })
  out.push(...boxes)
  const after = b.spaceAfter ?? (b.k === 'heading' ? 1.5 : b.k === 'spacer' ? 0 : 3)
  if (after) out.push({ h: mm(after), ops: [], space: true })
  return out
}

function columnsBoxes(b: Extract<RBlock, { k: 'columns' }>, c: Ctx): Box[] {
  const n = b.cols.length
  const gap = mm(b.gap, 6)
  const fixed = b.cols.reduce((a, col) => a + (col.width ? mm(col.width) : 0), 0)
  const shared = b.cols.filter((col) => !col.width).length
  const rest = Math.max(0, c.width - fixed - gap * (n - 1))
  const widths = b.cols.map((col) => (col.width ? Math.min(mm(col.width), c.width) : shared ? rest / shared : 0))
  const laid = b.cols.map((col, i) => {
    const inner: Ctx = { ...c, width: widths[i] }
    const boxes = col.blocks.flatMap((x) => blockBoxes(x, inner)).filter((x) => !x.breakBefore)
    let y = 0
    const ops: Op[] = []
    for (const x of boxes) { ops.push(...shift(x.ops, 0, y)); y += x.h }
    return { h: y, ops, boxes }
  })
  const h = Math.max(0, ...laid.map((l) => l.h))
  if (h <= c.frame) {
    const ops: Op[] = []
    let x = 0
    laid.forEach((l, i) => { ops.push(...shift(l.ops, x, 0)); x += widths[i] + gap })
    return [{ h, ops }]
  }
  // taller than a page: the columns are stacked (each column's boxes flow over pages)
  return laid.flatMap((l) => l.boxes)
}

/* ------------------------------------------------------------------ pagination */

export interface Frame { top: number; height: number }

interface Placed { box: Box; y: number; slice?: { offset: number; h: number }; rep?: boolean }

function paginate(boxes: Box[], frameOf: (page: number) => Frame): Placed[][] {
  const pages: Placed[][] = []
  let cur: Placed[] = []
  let y = 0
  let frame = frameOf(0)
  const headers = new Map<number, Box>()
  const newPage = () => {
    pages.push(cur)
    cur = []
    y = 0
    frame = frameOf(pages.length)
  }
  const place = (box: Box) => {
    cur.push({ box, y })
    y += box.h
  }
  /** only repeated headers and space on this page so far */
  const nothingReal = () => cur.every((p) => p.box.space || p.rep || p.box.tableHeader)
  let i = 0
  let guard = 0
  while (i < boxes.length) {
    if (++guard > boxes.length * 20 + 1000) throw new Error('The layout did not converge.')
    const box = boxes[i]
    if (box.tableHeader) headers.set(box.tableHeader, box)
    if (box.breakBefore) {
      if (cur.some((p) => !p.box.space)) newPage()
      i++
      continue
    }
    // space at the top of a page is dropped
    if (box.space && !cur.length) { i++; continue }
    // a table continued on a new page: its header first
    if (!cur.length && pages.length && box.tableRow && headers.has(box.tableRow)) {
      const hd = headers.get(box.tableRow)!
      cur.push({ box: hd, y, rep: true })
      y += hd.h
    }
    if (y + box.h <= frame.height + 0.01) {
      place(box)
      i++
      continue
    }
    // does not fit
    if (box.space) { newPage(); i++; continue }
    if (box.h > frame.height - y && nothingReal()) {
      // taller than what a page can hold: sliced over pages, starting here
      let off = 0
      for (;;) {
        const h = Math.min(frame.height - y, box.h - off)
        cur.push({ box, y, slice: { offset: off, h } })
        off += h
        y += h
        if (off >= box.h - 0.01) break
        newPage()
      }
      i++
      continue
    }
    // where should this page end (an index <= i)?
    let breakAt = i
    if (box.para && box.para.count > 1) {
      // orphans: at least 2 lines of a paragraph at the bottom; widows: at least 2 at the top
      const k = box.para.index
      const n = box.para.count
      if (k > 0 && k < 2) breakAt = i - k
      else if (n - k < 2 && k >= 3) breakAt = i - (2 - (n - k))
    }
    if (box.keepWithPrev && breakAt === i && i > 0 && boxes[i - 1].tableRow === box.tableRow) breakAt = i - 1
    const g = boxes[breakAt]?.group
    if (g) {
      // a keepTogether block moves as a whole when it fits on one page
      let s = breakAt
      while (s > 0 && boxes[s - 1].group === g) s--
      let e = s
      let gh = 0
      while (e < boxes.length && boxes[e].group === g) { gh += boxes[e].h; e++ }
      if (gh <= frameOf(pages.length + 1).height) breakAt = s
    }
    // headings, table headers and group headers go with what follows them
    const onThisPage = (k: number) => cur.some((p) => p.box === boxes[k] && !p.slice && !p.rep)
    while (breakAt > 0 && onThisPage(breakAt - 1) && (boxes[breakAt - 1].keepWithNext || boxes[breakAt - 1].space)) breakAt--
    // something real must stay on this page; otherwise break right here
    const staying = cur.filter((p) => !p.box.space && !p.slice && !p.rep && boxes.indexOf(p.box) < breakAt)
    if (breakAt < i && !staying.length) breakAt = i
    if (breakAt < i) {
      const moved = new Set(boxes.slice(breakAt, i))
      cur = cur.filter((p) => p.rep || !moved.has(p.box))
      y = cur.length ? cur[cur.length - 1].y + (cur[cur.length - 1].slice?.h ?? cur[cur.length - 1].box.h) : 0
    }
    newPage()
    i = breakAt
  }
  if (cur.length || !pages.length) pages.push(cur)
  return pages
}

/* ------------------------------------------------------------------ the document */

export interface LayoutInput {
  pageW: number
  pageH: number
  margins: { top: number; right: number; bottom: number; left: number }
  style: LayoutStyle
  body: RBlock[]
  /** header blocks per page kind; page tokens are replaced per page */
  header: (page: number) => RBlock[]
  footer: (page: number) => RBlock[]
  images: Map<string, { width: number; height: number }>
  maxPages: number
}

function substitute(blocks: RBlock[], pageNo: number, pageCount: number): RBlock[] {
  const sub = (s: string) => s.split(PAGE_NUMBER).join(String(pageNo)).split(PAGE_COUNT).join(String(pageCount))
  return blocks.map((b) => {
    switch (b.k) {
      case 'heading': return { ...b, text: sub(b.text) }
      case 'text': return { ...b, paras: b.paras.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, text: sub(r.text) })) })) }
      case 'kv': return { ...b, items: b.items.map((it) => ({ label: sub(it.label), value: sub(it.value) })) }
      case 'columns': return { ...b, cols: b.cols.map((c) => ({ ...c, blocks: substitute(c.blocks, pageNo, pageCount) })) }
      default: return b
    }
  })
}

function stack(blocks: RBlock[], c: Ctx): { h: number; ops: Op[] } {
  let y = 0
  const ops: Op[] = []
  for (const b of blocks) for (const x of blockBoxes(b, c)) {
    if (x.breakBefore) continue
    ops.push(...shift(x.ops, 0, y))
    y += x.h
  }
  return { h: y, ops }
}

export class PageLimitError extends Error {}

export function layoutDocument(inp: LayoutInput): Page[] {
  seq = 0
  const contentW = inp.pageW - inp.margins.left - inp.margins.right
  const ctxFor = (frame: number): Ctx => ({ width: contentW, style: inp.style, images: inp.images, frame })
  // header and footer heights: measured with wide page numbers, per page kind (the first page may carry the letterhead)
  const measureHeader = (p: number) => stack(substitute(inp.header(p), 999, 999), ctxFor(inp.pageH)).h
  const measureFooter = (p: number) => stack(substitute(inp.footer(p), 999, 999), ctxFor(inp.pageH)).h
  const hh = [measureHeader(0), measureHeader(1)]
  const fh = [measureFooter(0), measureFooter(1)]
  const gap = 4 * MM
  const frameOf = (p: number): Frame => {
    const k = p === 0 ? 0 : 1
    const top = inp.margins.top + (hh[k] ? hh[k] + gap : 0)
    const bottom = inp.margins.bottom + (fh[k] ? fh[k] + gap : 0)
    return { top, height: Math.max(36, inp.pageH - top - bottom) }
  }
  const minFrame = Math.min(frameOf(0).height, frameOf(1).height)
  const boxes = inp.body.flatMap((b) => blockBoxes(b, ctxFor(minFrame)))
  const placed = paginate(boxes, frameOf)
  if (placed.length > inp.maxPages) throw new PageLimitError(`The document has more than ${inp.maxPages} pages (the limit of this server); print fewer rows.`)
  const total = placed.length
  return placed.map((items, p) => {
    const fr = frameOf(p)
    const ops: Op[] = []
    for (const it of items) {
      if (it.slice) {
        ops.push({ t: 'clip', x: inp.margins.left - 1, y: fr.top, w: contentW + 2, h: it.slice.h })
        ops.push(...shift(it.box.ops, inp.margins.left, fr.top - it.slice.offset))
        ops.push({ t: 'unclip' })
      } else ops.push(...shift(it.box.ops, inp.margins.left, fr.top + it.y))
    }
    const head = stack(substitute(inp.header(p), p + 1, total), ctxFor(inp.pageH))
    ops.push(...shift(head.ops, inp.margins.left, inp.margins.top))
    const foot = stack(substitute(inp.footer(p), p + 1, total), ctxFor(inp.pageH))
    ops.push(...shift(foot.ops, inp.margins.left, inp.pageH - inp.margins.bottom - foot.h))
    return { ops }
  })
}

/** convenience for tests and simple callers: plain paragraphs from markup */
export const paras = (text: string): RichParagraph[] => parseRichText(text)
export { lineMetrics }
