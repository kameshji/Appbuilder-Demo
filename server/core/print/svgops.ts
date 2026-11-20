/**
 * SVG -> drawing operations of the layout engine (docs/dev/pdf.md "Charts"). Converts exactly the SVG that
 * renderChartSvg (src/charts/svg.ts) writes, so charts in PDFs are the dashboards' charts, drawn as vectors:
 *
 *   <svg width height viewBox role font-family>, <title>, <desc> (not drawn), <g transform>, <rect>, <path>, <circle>,
 *   <line>, <text> (anchors, dominant-baseline, weight, rotate), fill / stroke / stroke-width / dashes / caps / opacity,
 *   colours as #hex or rgb()/rgba().
 *
 * Anything else (an element, an attribute, a transform, a colour, an entity) throws: the subset is closed on purpose, so a
 * change in svg.ts fails the tests instead of being dropped silently from PDFs. Text is not drawn from the SVG's fonts:
 * each string is laid out with the bundled Noto fonts (text.ts: script runs, fontkit shaping, Devanagari ActualText) by
 * the `text` callback, and anchors are computed from those widths. Output is deterministic (numbers rounded to 1/1000 pt).
 */
import type { Op } from './layout.ts'
import { loadFaces, textWidth, type TextStyle } from './text.ts'

export type TextLine = (text: string, x: number, baseline: number, st: TextStyle, color: string) => Op[]

export interface SvgOpsOptions {
  /** the width in points the SVG's viewBox is scaled to (uniformly) */
  width: number
  /** draws one line of text at a baseline (the layout engine's textLine) */
  text: TextLine
}

export class SvgSubsetError extends Error {}
const fail = (msg: string): never => { throw new SvgSubsetError(`svgToOps: ${msg}`) }

/* ------------------------------------------------------------------ parsing (a tiny XML reader for this subset) */

interface El { name: string; attrs: Map<string, string>; children: El[]; text: string }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decode(s: string): string {
  if (/&(?!(?:#x[0-9a-f]+|#\d+|[a-z]+);)/i.test(s)) fail('a bare & (not an entity)')
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fail(`bad character reference &${e};`)
    }
    return ENTITIES[e] ?? fail(`unknown entity &${e};`)
  })
}

export function parseSvg(src: string): El {
  let i = 0
  const root: El = { name: '#root', attrs: new Map(), children: [], text: '' }
  const stack: El[] = [root]
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    const chunk = lt < 0 ? src.slice(i) : src.slice(i, lt)
    if (chunk) stack[stack.length - 1].text += decode(chunk)
    if (lt < 0) break
    if (src.startsWith('<!--', lt) || src.startsWith('<?', lt) || src.startsWith('<!', lt)) fail('comments, processing instructions and declarations are not part of the subset')
    const gt = src.indexOf('>', lt)
    if (gt < 0) fail('an unterminated tag')
    const body = src.slice(lt + 1, gt)
    i = gt + 1
    if (body.startsWith('/')) {
      const name = body.slice(1).trim()
      const top = stack.pop()
      if (!top || top.name !== name) fail(`</${name}> does not close <${top?.name}>`)
      continue
    }
    const selfClose = body.endsWith('/')
    const inner = selfClose ? body.slice(0, -1) : body
    const m = /^([A-Za-z][\w:-]*)/.exec(inner)
    if (!m) fail(`a malformed tag <${body}>`)
    const el: El = { name: m![1], attrs: new Map(), children: [], text: '' }
    const rest = inner.slice(m![1].length)
    const attrRe = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g
    let pos = 0
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(rest))) {
      if (am.index !== pos) fail(`a malformed attribute in <${el.name}>`)
      if (el.attrs.has(am[1])) fail(`a repeated attribute ${am[1]} in <${el.name}>`)
      el.attrs.set(am[1], decode(am[2]))
      pos = attrRe.lastIndex
    }
    if (rest.slice(pos).trim()) fail(`a malformed attribute list in <${el.name}>`)
    stack[stack.length - 1].children.push(el)
    if (!selfClose) stack.push(el)
  }
  if (stack.length !== 1) fail(`<${stack[stack.length - 1].name}> is not closed`)
  if (root.children.length !== 1 || root.children[0].name !== 'svg' || root.text.trim()) fail('the input is not one <svg> element')
  return root.children[0]
}

/* ------------------------------------------------------------------ the subset */

const PAINT = ['fill', 'stroke', 'stroke-width', 'opacity']
const ALLOWED: Record<string, string[]> = {
  svg: ['xmlns', 'width', 'height', 'viewBox', 'role', 'font-family'],
  title: [],
  desc: [],
  g: ['transform'],
  rect: ['x', 'y', 'width', 'height', 'rx', ...PAINT],
  path: ['d', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', ...PAINT],
  circle: ['cx', 'cy', 'r', ...PAINT],
  line: ['x1', 'y1', 'x2', 'y2', 'stroke-dasharray', ...PAINT],
  text: ['x', 'y', 'font-size', 'fill', 'text-anchor', 'dominant-baseline', 'font-weight', 'transform', 'opacity'],
}

/** every element and attribute is in the subset (throws otherwise) */
function check(el: El): void {
  const allowed = ALLOWED[el.name]
  if (!allowed) fail(`unsupported SVG element <${el.name}>`)
  for (const a of el.attrs.keys()) if (!allowed!.includes(a)) fail(`unsupported attribute ${a} on <${el.name}>`)
  if (el.name !== 'text' && el.name !== 'title' && el.name !== 'desc' && el.text.trim()) fail(`text inside <${el.name}>`)
  if ((el.name === 'text' || el.name === 'title' || el.name === 'desc') && el.children.length) fail(`elements inside <${el.name}>`)
  for (const c of el.children) check(c)
}

/* ------------------------------------------------------------------ values */

const r3 = (v: number) => Math.round(v * 1000) / 1000

function numAttr(el: El, name: string, d?: number): number {
  const s = el.attrs.get(name)
  if (s === undefined) return d ?? fail(`<${el.name}> needs ${name}`)
  const v = Number(s.trim())
  return Number.isFinite(v) && s.trim() !== '' ? v : fail(`${name}="${s}" on <${el.name}> is not a number`)
}

interface Color { hex: string; alpha: number }

/** #rgb, #rrggbb, rgb(), rgba(); none / transparent -> null */
export function parseColor(s: string | undefined): Color | null {
  if (s === undefined) return null
  const v = s.trim().toLowerCase()
  if (v === 'none' || v === 'transparent') return null
  if (/^#[0-9a-f]{3}$/.test(v)) return { hex: `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`, alpha: 1 }
  if (/^#[0-9a-f]{6}$/.test(v)) return { hex: v, alpha: 1 }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v)
  if (m) {
    const ch = [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, Math.round(Number(x)))))
    const alpha = m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4])))
    return { hex: '#' + ch.map((x) => x.toString(16).padStart(2, '0')).join(''), alpha }
  }
  return fail(`unsupported colour "${s}"`)
}

/** a uniform scale and a translation: page = local * s + (tx, ty) */
interface Tf { s: number; tx: number; ty: number }
const apply = (t: Tf, x: number, y: number): [number, number] => [x * t.s + t.tx, y * t.s + t.ty]

/** translate(...) and uniform scale(...) of a <g> (rotate only on <text>, handled there) */
function groupTransform(parent: Tf, src: string | undefined): Tf {
  if (!src) return parent
  let t = parent
  const re = /\s*(translate|scale)\(\s*([^)]*)\)\s*/gy
  let m: RegExpExecArray | null
  let consumed = 0
  while ((m = re.exec(src))) {
    const a = m[2].split(/[\s,]+/).filter(Boolean).map(Number)
    if (!a.length || a.some((x) => !Number.isFinite(x))) fail(`bad transform "${src}"`)
    if (m[1] === 'translate') {
      if (a.length > 2) fail(`bad transform "${src}"`)
      t = { s: t.s, tx: t.tx + (a[0] ?? 0) * t.s, ty: t.ty + (a[1] ?? 0) * t.s }
    } else {
      if (a.length > 2 || (a.length === 2 && a[0] !== a[1])) fail(`only uniform scale is supported: "${src}"`)
      t = { s: t.s * a[0], tx: t.tx, ty: t.ty }
    }
    consumed = re.lastIndex
  }
  if (consumed !== src.length) fail(`unsupported transform "${src}"`)
  return t
}

/** stroke-dasharray -> points */
function dashOf(el: El, s: number): number[] | undefined {
  const v = el.attrs.get('stroke-dasharray')
  if (v === undefined || v.trim() === 'none') return undefined
  const a = v.trim().split(/[\s,]+/).map(Number)
  if (!a.length || a.some((x) => !Number.isFinite(x) || x < 0)) fail(`bad stroke-dasharray "${v}"`)
  if (a.every((x) => x === 0)) return undefined
  const d = (a.length % 2 ? [...a, ...a] : a).map((x) => r3(Math.max(0.001, x * s)))
  return d
}

/* ------------------------------------------------------------------ path data */

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

/** path data with every length scaled by s (arc rotation and flags kept); absolute coordinates stay in the local frame */
export function scalePath(d: string, s: number): string {
  let i = 0
  const out: string[] = []
  const ws = () => { while (i < d.length && /[\s,]/.test(d[i])) i++ }
  const number = (): number => {
    ws()
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(d.slice(i))
    if (!m) fail(`bad path data near "${d.slice(i, i + 12)}"`)
    i += m![0].length
    return Number(m![0])
  }
  const flag = (): number => {
    ws()
    const c = d[i]
    if (c !== '0' && c !== '1') fail(`bad arc flag in path data near "${d.slice(i, i + 12)}"`)
    i++
    return Number(c)
  }
  ws()
  while (i < d.length) {
    const c = d[i]
    const up = c.toUpperCase()
    if (!(up in ARITY)) fail(`bad path command "${c}"`)
    i++
    const n = ARITY[up]
    if (!n) { out.push(c); ws(); continue }
    let first = true
    do {
      const p: number[] = []
      for (let k = 0; k < n; k++) {
        if (up === 'A' && (k === 3 || k === 4)) p.push(flag())
        else {
          const v = number()
          p.push(up === 'A' && k === 2 ? v : r3(v * s))
        }
      }
      out.push((first ? c : '') + (first ? '' : ' ') + p.join(' '))
      first = false
      ws()
    } while (i < d.length && !/[A-Za-z]/.test(d[i]))
  }
  return out.join('')
}

/* ------------------------------------------------------------------ conversion */

interface Paint { fill?: Color; stroke?: Color; lw: number; opacity: number }

function paintOf(el: El, s: number, defaultFill: string | undefined): Paint {
  const fillAttr = el.attrs.get('fill') ?? defaultFill
  const fill = parseColor(fillAttr) ?? undefined
  const stroke = parseColor(el.attrs.get('stroke')) ?? undefined
  const opacity = Math.max(0, Math.min(1, numAttr(el, 'opacity', 1)))
  return { fill, stroke, lw: numAttr(el, 'stroke-width', 1) * s, opacity }
}

/** fill and stroke opacity fields of an op (only when below 1) */
function alphaFields(p: Paint): { fillOpacity?: number; strokeOpacity?: number } {
  const fo = p.fill ? r3(p.fill.alpha * p.opacity) : 1
  const so = p.stroke ? r3(p.stroke.alpha * p.opacity) : 1
  return { ...(p.fill && fo < 1 ? { fillOpacity: fo } : {}), ...(p.stroke && so < 1 ? { strokeOpacity: so } : {}) }
}

function capOf(el: El): { cap?: 'round' } {
  const c = el.attrs.get('stroke-linecap')
  const j = el.attrs.get('stroke-linejoin')
  if (c !== undefined && c !== 'round' && c !== 'butt') fail(`unsupported stroke-linecap "${c}"`)
  if (j !== undefined && j !== 'round' && j !== 'miter') fail(`unsupported stroke-linejoin "${j}"`)
  return c === 'round' ? { cap: 'round' } : {}
}

/** the rotation of a text element: rotate(a [cx cy]) and nothing else */
function textRotation(el: El): { deg: number; cx: number; cy: number } | null {
  const src = el.attrs.get('transform')
  if (!src) return null
  const m = /^\s*rotate\(\s*([-+.\deE]+)(?:[\s,]+([-+.\deE]+)[\s,]+([-+.\deE]+))?\s*\)\s*$/.exec(src)
  if (!m) fail(`unsupported transform "${src}" on <text>`)
  const deg = Number(m![1])
  const cx = m![2] === undefined ? 0 : Number(m![2])
  const cy = m![3] === undefined ? 0 : Number(m![3])
  if (![deg, cx, cy].every(Number.isFinite)) fail(`bad transform "${src}" on <text>`)
  return { deg, cx, cy }
}

/** ▲ ▼ ■ (the KPI's change arrows): Noto Sans has no glyphs for them, so they are drawn as shapes on the baseline */
const SYMBOL_ADVANCE = 0.78
const SYMBOLS: Record<string, (size: number) => string> = {
  '▲': (z) => `M${r3(0.09 * z)} 0L${r3(0.69 * z)} 0L${r3(0.39 * z)} ${r3(-0.6 * z)}Z`,
  '▼': (z) => `M${r3(0.09 * z)} ${r3(-0.6 * z)}L${r3(0.69 * z)} ${r3(-0.6 * z)}L${r3(0.39 * z)} 0Z`,
  '■': (z) => `M${r3(0.12 * z)} 0L${r3(0.66 * z)} 0L${r3(0.66 * z)} ${r3(-0.54 * z)}L${r3(0.12 * z)} ${r3(-0.54 * z)}Z`,
}
const SYMBOL_SPLIT = /([▲▼■])/

function convertText(el: El, t: Tf, o: SvgOpsOptions, out: Op[]): void {
  const content = el.text.replace(/\s+/g, ' ').trim()
  if (!content) return
  const p = paintOf(el, t.s, '#000000')
  if (el.attrs.has('stroke')) fail('stroked text is not part of the subset')
  if (!p.fill) return
  const sizeLocal = numAttr(el, 'font-size', 16)
  const weight = el.attrs.get('font-weight')
  if (weight !== undefined && !/^(\d{3}|normal|bold)$/.test(weight)) fail(`unsupported font-weight "${weight}"`)
  const bold = weight === 'bold' || (weight !== undefined && /^\d{3}$/.test(weight) && Number(weight) >= 600)
  const st: TextStyle = { size: r3(sizeLocal * t.s), ...(bold ? { bold: true } : {}) }
  const anchor = el.attrs.get('text-anchor') ?? 'start'
  if (!['start', 'middle', 'end'].includes(anchor)) fail(`unsupported text-anchor "${anchor}"`)
  const baselineAttr = el.attrs.get('dominant-baseline') ?? 'auto'
  if (!['auto', 'alphabetic', 'central', 'middle', 'hanging'].includes(baselineAttr)) fail(`unsupported dominant-baseline "${baselineAttr}"`)
  // the baseline offset (local units) from the face's metrics: central = the middle of ascent and descent
  const face = loadFaces().get(bold ? 'sans-bold' : 'sans')!
  const shiftLocal = baselineAttr === 'central' || baselineAttr === 'middle' ? ((face.ascent - face.descent) / 2) * sizeLocal : baselineAttr === 'hanging' ? face.ascent * 0.8 * sizeLocal : 0
  const x = numAttr(el, 'x', 0)
  const y = numAttr(el, 'y', 0)
  const rot = textRotation(el)
  // pieces: text, and the KPI arrows (no bundled font has them) drawn as shapes
  const pieces = content.split(SYMBOL_SPLIT).filter((s) => s !== '')
  if (rot && pieces.some((s) => SYMBOLS[s])) fail('symbols in rotated text are not part of the subset')
  const pieceW = (s: string) => (SYMBOLS[s] ? SYMBOL_ADVANCE * st.size : textWidth(s, st))
  const w = pieces.reduce((a, s) => a + pieceW(s), 0) / t.s // local units
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x
  const alpha = alphaFields(p)
  const ops: Op[] = []
  let at = 0
  for (const s of pieces) {
    if (SYMBOLS[s]) {
      const [px, py] = apply(t, x0 + at / t.s, y + shiftLocal)
      out.push({ t: 'path', d: SYMBOLS[s](st.size), x: r3(px), y: r3(py), fill: p.fill.hex, ...alpha })
    } else ops.push(...o.text(s, at, 0, st, p.fill.hex))
    at += pieceW(s)
  }
  for (const op of ops) {
    if (op.t === 'text') {
      // local position of this run along the baseline, then the text's rotation, then the group transform
      let lx = x0 + op.x / t.s
      let ly = y + shiftLocal
      if (rot) {
        const a = (rot.deg * Math.PI) / 180
        const dx = lx - rot.cx, dy = ly - rot.cy
        lx = rot.cx + dx * Math.cos(a) - dy * Math.sin(a)
        ly = rot.cy + dx * Math.sin(a) + dy * Math.cos(a)
      }
      const [px, py] = apply(t, lx, ly)
      out.push({ ...op, x: r3(px), y: r3(py), ...(rot && rot.deg % 360 ? { rotate: r3(rot.deg) } : {}), ...(alpha.fillOpacity !== undefined ? { opacity: alpha.fillOpacity } : {}) })
    } else fail(`the text callback returned a ${op.t} operation`)
  }
}

function convert(el: El, t: Tf, o: SvgOpsOptions, out: Op[]): void {
  switch (el.name) {
    case 'title': case 'desc': return
    case 'g': {
      const g = groupTransform(t, el.attrs.get('transform'))
      for (const c of el.children) convert(c, g, o, out)
      return
    }
    case 'rect': {
      const p = paintOf(el, t.s, '#000000')
      const w = numAttr(el, 'width') * t.s, h = numAttr(el, 'height') * t.s
      if (w <= 0 || h <= 0 || (!p.fill && !p.stroke)) return
      const [x, y] = apply(t, numAttr(el, 'x', 0), numAttr(el, 'y', 0))
      const rx = Math.min(numAttr(el, 'rx', 0) * t.s, w / 2, h / 2)
      out.push({ t: 'rect', x: r3(x), y: r3(y), w: r3(w), h: r3(h), ...(rx > 0 ? { r: r3(rx) } : {}), ...(p.fill ? { fill: p.fill.hex } : {}), ...(p.stroke ? { stroke: p.stroke.hex, lw: r3(p.lw) } : {}), ...alphaFields(p) })
      return
    }
    case 'path': {
      const p = paintOf(el, t.s, '#000000')
      const d = el.attrs.get('d') ?? fail('<path> needs d')
      if (!d.trim() || (!p.fill && !p.stroke)) return
      const dash = dashOf(el, t.s)
      out.push({ t: 'path', d: scalePath(d, t.s), x: r3(t.tx), y: r3(t.ty), ...(p.fill ? { fill: p.fill.hex } : {}), ...(p.stroke ? { stroke: p.stroke.hex, lw: r3(p.lw) } : {}), ...(dash && p.stroke ? { dash } : {}), ...(p.stroke ? capOf(el) : {}), ...alphaFields(p) })
      return
    }
    case 'circle': {
      const p = paintOf(el, t.s, '#000000')
      const r = numAttr(el, 'r') * t.s
      if (r <= 0 || (!p.fill && !p.stroke)) return
      const [cx, cy] = apply(t, numAttr(el, 'cx', 0), numAttr(el, 'cy', 0))
      const R = r3(r)
      const d = `M${r3(-R)} 0A${R} ${R} 0 1 0 ${R} 0A${R} ${R} 0 1 0 ${r3(-R)} 0Z`
      out.push({ t: 'path', d, x: r3(cx), y: r3(cy), ...(p.fill ? { fill: p.fill.hex } : {}), ...(p.stroke ? { stroke: p.stroke.hex, lw: r3(p.lw) } : {}), ...alphaFields(p) })
      return
    }
    case 'line': {
      const p = paintOf(el, t.s, undefined)
      if (el.attrs.has('fill')) fail('fill on <line> is not part of the subset')
      if (!p.stroke) return
      const [x1, y1] = apply(t, numAttr(el, 'x1', 0), numAttr(el, 'y1', 0))
      const [x2, y2] = apply(t, numAttr(el, 'x2', 0), numAttr(el, 'y2', 0))
      const dash = dashOf(el, t.s)
      const a = alphaFields(p)
      out.push({ t: 'line', x1: r3(x1), y1: r3(y1), x2: r3(x2), y2: r3(y2), color: p.stroke.hex, lw: r3(p.lw), ...(dash ? { dash } : {}), ...(a.strokeOpacity !== undefined ? { opacity: a.strokeOpacity } : {}) })
      return
    }
    case 'text': convertText(el, t, o, out); return
    default: fail(`unsupported SVG element <${el.name}>`)
  }
}

/**
 * The SVG as operations in a box of `width` x (width * viewBox height / viewBox width) points, origin top-left.
 * Throws SvgSubsetError on anything outside the subset.
 */
export function svgToOps(svg: string, o: SvgOpsOptions): { ops: Op[]; height: number } {
  const root = parseSvg(svg)
  check(root)
  const vb = (root.attrs.get('viewBox') ?? `0 0 ${numAttr(root, 'width')} ${numAttr(root, 'height')}`).trim().split(/[\s,]+/).map(Number)
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v)) || vb[2] <= 0 || vb[3] <= 0) fail(`bad viewBox "${root.attrs.get('viewBox')}"`)
  const s = o.width / vb[2]
  const t: Tf = { s, tx: -vb[0] * s, ty: -vb[1] * s }
  const out: Op[] = []
  for (const c of root.children) convert(c, t, o, out)
  return { ops: out, height: vb[3] * s }
}
