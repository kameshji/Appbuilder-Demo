/**
 * Fonts and text measurement of the print engine (docs/dev/pdf.md "Fonts and shaping").
 *
 * Bundled fonts (SIL Open Font License 1.1, files and licences in ./fonts): Noto Sans (regular, bold, italic, bold
 * italic: Latin, Greek, Cyrillic, ₹) and Noto Sans Devanagari (regular, bold). Text is split into runs by script:
 * Devanagari characters (and the marks, ZWJ/ZWNJ and dandas that belong to them) use Noto Sans Devanagari, everything
 * else Noto Sans; a character neither font has prints as the font's missing-glyph box. Shaping (conjuncts, reph,
 * matra reordering, mark positioning) is fontkit's OpenType layout; it is verified against HarfBuzz in
 * print.test.ts ("Devanagari shaping"). Devanagari has no italic face: italic is a slant applied when drawing.
 *
 * Widths are measured with the same fontkit layout the PDF writer (pdfkit) uses to place the glyphs, so what the layout
 * engine measured is what gets drawn.
 */
import fs from 'node:fs'
import * as fontkit from 'fontkit'

export type FaceId = 'sans' | 'sans-bold' | 'sans-italic' | 'sans-bolditalic' | 'deva' | 'deva-bold'

export interface Face {
  id: FaceId
  font: fontkit.Font
  bytes: Buffer
  /** ascent and descent per 1 pt of size */
  ascent: number
  descent: number
  /** drawn with a slant (Devanagari italic) */
  synthItalic?: boolean
}

const FILES: Record<FaceId, URL> = {
  'sans': new URL('./fonts/NotoSans-Regular.ttf', import.meta.url),
  'sans-bold': new URL('./fonts/NotoSans-Bold.ttf', import.meta.url),
  'sans-italic': new URL('./fonts/NotoSans-Italic.ttf', import.meta.url),
  'sans-bolditalic': new URL('./fonts/NotoSans-BoldItalic.ttf', import.meta.url),
  'deva': new URL('./fonts/NotoSansDevanagari-Regular.ttf', import.meta.url),
  'deva-bold': new URL('./fonts/NotoSansDevanagari-Bold.ttf', import.meta.url),
}
// the licence texts ship next to the fonts (the release build copies files named with new URL(...))
export const FONT_LICENCES = [new URL('./fonts/OFL-NotoSans.txt', import.meta.url), new URL('./fonts/OFL-NotoSansDevanagari.txt', import.meta.url)]

let faces: Map<FaceId, Face> | null = null

export function loadFaces(): Map<FaceId, Face> {
  if (faces) return faces
  const m = new Map<FaceId, Face>()
  for (const [id, url] of Object.entries(FILES) as [FaceId, URL][]) {
    const bytes = fs.readFileSync(url)
    const font = fontkit.create(bytes)
    m.set(id, { id, font, bytes, ascent: font.ascent / font.unitsPerEm, descent: -font.descent / font.unitsPerEm })
  }
  faces = m
  return m
}

export interface TextStyle { size: number; bold?: boolean; italic?: boolean }

/** U+0900-097F Devanagari, A8E0-A8FF Devanagari Extended, 1CD0-1CFF Vedic Extensions, 11B00-11B5F Devanagari Extended-A */
export const isDevanagari = (cp: number): boolean => (cp >= 0x900 && cp <= 0x97f) || (cp >= 0xa8e0 && cp <= 0xa8ff) || (cp >= 0x1cd0 && cp <= 0x1cff) || (cp >= 0x11b00 && cp <= 0x11b5f)
/** characters that join the script of the text around them */
const isJoiner = (cp: number): boolean => cp === 0x200c || cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || cp === 0x25cc

export function faceFor(script: 'latin' | 'deva', st: TextStyle): FaceId {
  if (script === 'deva') return st.bold ? 'deva-bold' : 'deva'
  return st.bold ? (st.italic ? 'sans-bolditalic' : 'sans-bold') : st.italic ? 'sans-italic' : 'sans'
}

export interface Segment { text: string; face: FaceId; synthItalic: boolean }

/** splits text into runs of one face */
export function segments(text: string, st: TextStyle): Segment[] {
  const f = loadFaces()
  const latin = f.get(faceFor('latin', st))!.font
  const out: Segment[] = []
  let cur: 'latin' | 'deva' | null = null
  let buf = ''
  const push = () => {
    if (!buf) return
    out.push({ text: buf, face: faceFor(cur ?? 'latin', st), synthItalic: cur === 'deva' && !!st.italic })
    buf = ''
  }
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    let script: 'latin' | 'deva'
    if (isDevanagari(cp)) script = 'deva'
    else if (isJoiner(cp) && cur) script = cur
    else if (!latin.hasGlyphForCodePoint(cp) && f.get('deva')!.font.hasGlyphForCodePoint(cp) && cp > 0x20) script = 'deva'
    else script = 'latin'
    if (script !== cur) { push(); cur = script }
    buf += ch
  }
  push()
  return out
}

const widthCache = new Map<string, number>()

/** advance width of one segment in pt */
export function segmentWidth(seg: Segment, size: number): number {
  const key = `${seg.face}\u0000${seg.text}`
  let w = widthCache.get(key)
  if (w === undefined) {
    const face = loadFaces().get(seg.face)!
    w = face.font.layout(seg.text).advanceWidth / face.font.unitsPerEm
    if (widthCache.size > 200_000) widthCache.clear()
    widthCache.set(key, w)
  }
  return w * size
}

export function textWidth(text: string, st: TextStyle): number {
  let w = 0
  for (const s of segments(text, st)) w += segmentWidth(s, st.size)
  return w
}

/** ascent and descent (pt) of a line of this style: the larger of the two scripts, so mixed lines line up */
export function lineMetrics(st: TextStyle): { ascent: number; descent: number } {
  const f = loadFaces()
  const a = Math.max(f.get(faceFor('latin', st))!.ascent, f.get(faceFor('deva', st))!.ascent * 0.92)
  const d = Math.max(f.get(faceFor('latin', st))!.descent, f.get(faceFor('deva', st))!.descent * 0.75)
  return { ascent: a * st.size, descent: d * st.size }
}

/** grapheme clusters (a conjunct with its matras stays together when a long word must be cut) */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export function splitGraphemes(s: string): string[] {
  return [...graphemes.segment(s)].map((x) => x.segment)
}

/** glyph ids and positions of a text in one face (tests compare these with HarfBuzz) */
export function shape(text: string, face: FaceId): { id: number; xAdvance: number; xOffset: number; yOffset: number }[] {
  const f = loadFaces().get(face)!.font
  const r = f.layout(text)
  return r.glyphs.map((g, i) => ({ id: g.id, xAdvance: r.positions[i].xAdvance, xOffset: r.positions[i].xOffset, yOffset: r.positions[i].yOffset }))
}
