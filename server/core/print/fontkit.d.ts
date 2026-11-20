// Minimal types of fontkit 2 (MIT) as used by the print engine (no @types package exists for v2).
declare module 'fontkit' {
  export interface Glyph { id: number; advanceWidth: number; codePoints: number[]; name?: string }
  export interface GlyphPosition { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }
  export interface GlyphRun { glyphs: Glyph[]; positions: GlyphPosition[]; advanceWidth: number; script?: string }
  export interface Font {
    unitsPerEm: number
    ascent: number
    descent: number
    lineGap: number
    familyName: string
    fullName: string
    postscriptName: string
    version: string
    capHeight: number
    xHeight: number
    layout(text: string, features?: string[] | Record<string, boolean>, script?: string, language?: string, direction?: string): GlyphRun
    hasGlyphForCodePoint(cp: number): boolean
    glyphForCodePoint(cp: number): Glyph
  }
  export function create(buffer: Buffer | Uint8Array, postscriptName?: string): Font
  export function openSync(path: string, postscriptName?: string): Font
}
