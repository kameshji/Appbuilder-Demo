/**
 * Our own 1D barcode decoder (P2-A, docs/dev/phone.md "Scanner"): the fallback where the browser has no
 * BarcodeDetector (iOS Safari, desktop Firefox, Chrome on Windows/Linux). Formats: EAN-13 (and UPC-A as EAN-13 with a
 * leading 0), EAN-8, Code 128 (sets A, B, C), Code 39, ITF (Interleaved 2 of 5, even length, at least 6 digits).
 * QR and Data Matrix are NOT decoded here: they need the browser's BarcodeDetector (Android Chrome, Chrome on macOS).
 *
 * Method: a row of the image (luminance) is turned into run lengths (bars and spaces) with a threshold halfway between
 * the darkest and lightest pixel of the row; every symbology is tried at every bar after a quiet zone, both directions.
 * Checksums are always verified (EAN, Code 128) and a quiet zone of 5 modules is required, to keep false reads out;
 * decodeImage additionally requires two rows to agree. Pure functions (no DOM): unit-tested with generated images.
 */
export type Format1D = 'ean_13' | 'ean_8' | 'code_128' | 'code_39' | 'itf'
export interface Decoded { format: Format1D; text: string }

/* ------------------------------------------------------------------ runs */

/** run lengths of a luminance row; runs[0] is a space (light) run, then bar, space, ... */
export function runsOf(row: ArrayLike<number>): number[] {
  let lo = 255
  let hi = 0
  for (let i = 0; i < row.length; i++) {
    const v = row[i]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (hi - lo < 40) return []
  const t = (lo + hi) / 2
  const runs: number[] = []
  let dark = false
  let n = 0
  for (let i = 0; i < row.length; i++) {
    const d = row[i] < t
    if (d === dark) n++
    else {
      runs.push(n)
      dark = d
      n = 1
    }
  }
  runs.push(n)
  if (dark) runs.push(0)
  return runs
}

const sum = (a: number[], from: number, n: number) => {
  let s = 0
  for (let i = from; i < from + n; i++) s += a[i]
  return s
}

/** squared error between measured widths (scaled to `modules`) and an expected pattern */
function patternError(runs: number[], from: number, pattern: number[]): number {
  const total = sum(runs, from, pattern.length)
  const modules = pattern.reduce((a, b) => a + b, 0)
  if (total <= 0) return Infinity
  const unit = total / modules
  let err = 0
  for (let i = 0; i < pattern.length; i++) {
    const d = runs[from + i] / unit - pattern[i]
    err += d * d
  }
  return err / pattern.length
}

function best(runs: number[], from: number, table: number[][], maxErr: number): number {
  let bi = -1
  let be = maxErr
  for (let k = 0; k < table.length; k++) {
    const e = patternError(runs, from, table[k])
    if (e < be) {
      be = e
      bi = k
    }
  }
  return bi
}

const digits = (s: string) => s.split('').map(Number)
const quietBefore = (runs: number[], i: number, unit: number) => i > 0 && runs[i - 1] >= unit * 5
const quietAfter = (runs: number[], i: number, unit: number) => i < runs.length && (runs[i] >= unit * 5 || i === runs.length - 1)

/* ------------------------------------------------------------------ EAN */

const L = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'].map(digits)
const G = L.map((p) => p.slice().reverse())
const LG = [...L, ...G]
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

export function eanCheckOk(code: string): boolean {
  const d = digits(code)
  let s = 0
  for (let i = 0; i < d.length - 1; i++) s += d[d.length - 2 - i] * (i % 2 === 0 ? 3 : 1)
  return (10 - (s % 10)) % 10 === d[d.length - 1]
}

const EAN_DIGIT_ERR = 0.35

function ean(runs: number[], i: number, n: 13 | 8): string | null {
  const half = n === 13 ? 6 : 4
  const need = 3 + half * 4 + 5 + half * 4 + 3
  if (i + need > runs.length) return null
  const unit = sum(runs, i, need) / (n === 13 ? 95 : 67)
  if (!quietBefore(runs, i, unit) || !quietAfter(runs, i + need, unit)) return null
  if (patternError(runs, i, [1, 1, 1]) > 0.2) return null
  let p = i + 3
  let left = ''
  let parity = ''
  for (let k = 0; k < half; k++) {
    const b = best(runs, p, n === 13 ? LG : L, EAN_DIGIT_ERR)
    if (b < 0) return null
    left += String(b % 10)
    parity += b >= 10 ? 'G' : 'L'
    p += 4
  }
  if (patternError(runs, p, [1, 1, 1, 1, 1]) > 0.2) return null
  p += 5
  let right = ''
  for (let k = 0; k < half; k++) {
    const b = best(runs, p, L, EAN_DIGIT_ERR)
    if (b < 0) return null
    right += String(b)
    p += 4
  }
  if (patternError(runs, p, [1, 1, 1]) > 0.2) return null
  let code: string
  if (n === 13) {
    const first = PARITY.indexOf(parity)
    if (first < 0) return null
    code = String(first) + left + right
  } else code = left + right
  return eanCheckOk(code) ? code : null
}

/* ------------------------------------------------------------------ Code 128 */

export const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232',
].map(digits)
const C128_STOP = digits('2331112')

function code128(runs: number[], i: number): string | null {
  if (i + 6 + 6 + 7 > runs.length) return null
  const unit0 = sum(runs, i, 6) / 11
  if (!quietBefore(runs, i, unit0)) return null
  const start = best(runs, i, C128, 0.3)
  if (start < 103 || start > 105) return null
  const values: number[] = [start]
  let p = i + 6
  for (;;) {
    if (p + 7 <= runs.length && patternError(runs, p, C128_STOP) < 0.3 && quietAfter(runs, p + 7, unit0)) break
    if (p + 6 > runs.length) return null
    const v = best(runs, p, C128, 0.3)
    if (v < 0 || v > 102) return null
    values.push(v)
    p += 6
    if (values.length > 80) return null
  }
  if (values.length < 3) return null
  const check = values.pop()!
  let s = values[0]
  for (let k = 1; k < values.length; k++) s += values[k] * k
  if (s % 103 !== check) return null
  let set: 'A' | 'B' | 'C' = start === 103 ? 'A' : start === 104 ? 'B' : 'C'
  let out = ''
  let shift = false
  for (let k = 1; k < values.length; k++) {
    const v = values[k]
    const cur = shift ? (set === 'A' ? 'B' : 'A') : set
    shift = false
    if (cur === 'C') {
      if (v < 100) out += String(v).padStart(2, '0')
      else if (v === 100) set = 'B'
      else if (v === 101) set = 'A'
      // 102 FNC1 (GS1): ignored
      continue
    }
    if (v < 96) {
      if (cur === 'A') out += String.fromCharCode(v < 64 ? v + 32 : v - 64)
      else out += String.fromCharCode(v + 32)
    } else if (v === 98) shift = true
    else if (v === 99) set = 'C'
    else if (v === 100) set = cur === 'A' ? 'B' : set
    else if (v === 101) set = cur === 'B' ? 'A' : set
    // 96, 97, 102: FNC codes, ignored
  }
  return out
}

/* ------------------------------------------------------------------ Code 39 */

const C39_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. *$/+%'
const C39 = [
  'nnnwwnwnn', 'wnnwnnnnw', 'nnwwnnnnw', 'wnwwnnnnn', 'nnnwwnnnw', 'wnnwwnnnn', 'nnwwwnnnn', 'nnnwnnwnw', 'wnnwnnwnn', 'nnwwnnwnn',
  'wnnnnwnnw', 'nnwnnwnnw', 'wnwnnwnnn', 'nnnnwwnnw', 'wnnnwwnnn', 'nnwnwwnnn', 'nnnnnwwnw', 'wnnnnwwnn', 'nnwnnwwnn', 'nnnnwwwnn',
  'wnnnnnnww', 'nnwnnnnww', 'wnwnnnnwn', 'nnnnwnnww', 'wnnnwnnwn', 'nnwnwnnwn', 'nnnnnnwww', 'wnnnnnwwn', 'nnwnnnwwn', 'nnnnwnwwn',
  'wwnnnnnnw', 'nwwnnnnnw', 'wwwnnnnnn', 'nwnnwnnnw', 'wwnnwnnnn', 'nwwnwnnnn', 'nwnnnnwnw', 'wwnnnnwnn', 'nwwnnnwnn', 'nwnnwnwnn',
  'nwnwnwnnn', 'nwnwnnnwn', 'nwnnnwnwn', 'nnnwnwnwn',
]
export const CODE39 = { chars: C39_CHARS, patterns: C39 }

/** narrow/wide classification of 9 runs: the 3 widest are wide, and they must be clearly wider than the rest */
function c39Char(runs: number[], from: number): number {
  if (from + 9 > runs.length) return -1
  const w = runs.slice(from, from + 9)
  const sorted = w.slice().sort((a, b) => a - b)
  const narrowMax = sorted[5]
  const wideMin = sorted[6]
  if (wideMin < narrowMax * 1.5) return -1
  const key = w.map((x) => (x >= wideMin ? 'w' : 'n')).join('')
  return C39.indexOf(key)
}

function code39(runs: number[], i: number): string | null {
  const star = C39_CHARS.indexOf('*')
  if (c39Char(runs, i) !== star) return null
  const unit = sum(runs, i, 9) / 15 // a char is 12-15 modules at ratio 2-3: rough narrow width
  if (!quietBefore(runs, i, unit)) return null
  let p = i + 10
  let out = ''
  for (;;) {
    const c = c39Char(runs, p)
    if (c < 0) return null
    if (c === star) {
      if (!quietAfter(runs, p + 9, unit)) return null
      break
    }
    out += C39_CHARS[c]
    p += 10
    if (out.length > 60) return null
  }
  return out.length ? out : null
}

/* ------------------------------------------------------------------ ITF */

const ITF = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn']

function itf(runs: number[], i: number): string | null {
  if (i + 4 + 10 * 3 + 3 > runs.length) return null
  const narrow = sum(runs, i, 4) / 4
  if (!quietBefore(runs, i, narrow * 2)) return null
  for (let k = 0; k < 4; k++) if (runs[i + k] > narrow * 1.6 || runs[i + k] < narrow * 0.5) return null
  let p = i + 4
  let out = ''
  for (;;) {
    // stop: wide bar, narrow space, narrow bar
    if (p + 3 <= runs.length && runs[p] > narrow * 1.8 && runs[p + 1] < narrow * 1.6 && runs[p + 2] < narrow * 1.6 && quietAfter(runs, p + 3, narrow * 2)) break
    if (p + 10 > runs.length) return null
    const w = runs.slice(p, p + 10)
    const thr = (Math.min(...w) + Math.max(...w)) / 2
    if (Math.max(...w) < Math.min(...w) * 1.8) return null
    const bars = [0, 2, 4, 6, 8].map((k) => (w[k] > thr ? 'w' : 'n')).join('')
    const spaces = [1, 3, 5, 7, 9].map((k) => (w[k] > thr ? 'w' : 'n')).join('')
    const a = ITF.indexOf(bars)
    const b = ITF.indexOf(spaces)
    if (a < 0 || b < 0) return null
    out += String(a) + String(b)
    p += 10
    if (out.length > 40) return null
  }
  return out.length >= 6 ? out : null
}

/* ------------------------------------------------------------------ rows and images */

export function decodeRuns(runs: number[], formats?: ReadonlySet<Format1D>): Decoded | null {
  const want = (f: Format1D) => !formats || formats.has(f)
  for (let i = 1; i < runs.length; i += 2) {
    if (want('ean_13')) {
      const t = ean(runs, i, 13)
      if (t) return { format: 'ean_13', text: t }
    }
    if (want('ean_8')) {
      const t = ean(runs, i, 8)
      if (t) return { format: 'ean_8', text: t }
    }
    if (want('code_128')) {
      const t = code128(runs, i)
      if (t) return { format: 'code_128', text: t }
    }
    if (want('code_39')) {
      const t = code39(runs, i)
      if (t) return { format: 'code_39', text: t }
    }
    if (want('itf')) {
      const t = itf(runs, i)
      if (t) return { format: 'itf', text: t }
    }
  }
  return null
}

/** decode one luminance row, left to right and right to left */
export function decodeRow(row: ArrayLike<number>, formats?: ReadonlySet<Format1D>): Decoded | null {
  const runs = runsOf(row)
  if (runs.length < 20) return null
  const fwd = decodeRuns(runs, formats)
  if (fwd) return fwd
  // runs start and end with a space run, so the reversed list keeps the space/bar alternation
  return decodeRuns(runs.slice().reverse(), formats)
}

/** RGBA pixels -> luminance (0..255) */
export function toGray(rgba: ArrayLike<number>, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8
  return g
}

/**
 * Decode a grayscale image: rows from 20 % to 80 % of the height (every `step` rows, about 25 rows), averaged with
 * the rows next to them against noise. A result needs two rows that agree.
 */
export function decodeImage(gray: Uint8Array, w: number, h: number, formats?: ReadonlySet<Format1D>): Decoded | null {
  const seen = new Map<string, number>()
  const step = Math.max(2, Math.floor(h / 40))
  const row = new Float32Array(w)
  for (let y = Math.floor(h * 0.2); y < h * 0.8; y += step) {
    for (let x = 0; x < w; x++) {
      const a = gray[(y - 1) * w + x] ?? gray[y * w + x]
      const b = gray[y * w + x]
      const c = gray[(y + 1) * w + x] ?? b
      row[x] = (a + 2 * b + c) / 4
    }
    const d = decodeRow(row, formats)
    if (!d) continue
    const key = `${d.format}\u0000${d.text}`
    const n = (seen.get(key) ?? 0) + 1
    if (n >= 2) return d
    seen.set(key, n)
  }
  return null
}
