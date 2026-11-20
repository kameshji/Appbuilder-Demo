/**
 * Barcodes of the print engine, drawn as vector rectangles: Code 128 (own encoder: code sets B and C, switching to C
 * for runs of digits; ISO/IEC 15417 patterns) and QR codes (qrcode-generator, MIT, Kazuhiko Arase; error correction M,
 * text as UTF-8 bytes). Both are decoded in the tests from rasterised PDFs (print.test.ts, zxing-cpp when available).
 */
import qrcode from 'qrcode-generator'

/** bar/space widths of the 107 Code 128 symbols (106 = stop, 7 elements with the final bar) */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
const START_B = 104
const START_C = 105
const CODE_B = 100
const CODE_C = 99
const STOP = 106

/** the symbol values of a text (printable ASCII 32-126 only) */
export function code128Values(text: string): number[] {
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 32 || c > 126) throw new Error('A Code 128 barcode holds printable ASCII characters only (letters, digits, punctuation); use a QR code for other text.')
  }
  if (!text) throw new Error('The barcode text is blank.')
  const out: number[] = []
  let set: 'B' | 'C' | null = null
  let i = 0
  const digitsAt = (k: number) => {
    let n = 0
    while (k + n < text.length && text[k + n] >= '0' && text[k + n] <= '9') n++
    return n
  }
  while (i < text.length) {
    const run = digitsAt(i)
    // set C pays off for 4+ digits (or the whole text when it is an even run of 2+ digits)
    const useC = run >= 4 || (i === 0 && run === text.length && run >= 2 && run % 2 === 0)
    if (useC) {
      const even = run - (run % 2)
      if (set !== 'C') { out.push(set === null ? START_C : CODE_C); set = 'C' }
      for (let k = 0; k < even; k += 2) out.push(Number(text.slice(i + k, i + k + 2)))
      i += even
      continue
    }
    if (set !== 'B') { out.push(set === null ? START_B : CODE_B); set = 'B' }
    out.push(text.charCodeAt(i) - 32)
    i++
  }
  let sum = out[0]
  for (let k = 1; k < out.length; k++) sum += out[k] * k
  out.push(sum % 103, STOP)
  return out
}

/** modules (unit widths) of a barcode: [isBar, width] in order, quiet zones not included */
export function code128Modules(text: string): [boolean, number][] {
  const mods: [boolean, number][] = []
  for (const v of code128Values(text)) {
    const p = PATTERNS[v]
    for (let k = 0; k < p.length; k++) mods.push([k % 2 === 0, Number(p[k])])
  }
  return mods
}

export const code128Width = (text: string): number => code128Modules(text).reduce((a, [, w]) => a + w, 0)

/** the dark modules of a QR code: a size x size grid */
export function qrMatrix(text: string): { size: number; dark: (r: number, c: number) => boolean } {
  if (!text) throw new Error('The QR code text is blank.')
  const q = qrcode as unknown as (t: number, e: string) => { addData(s: string, m?: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean }
  // the library maps each character to one byte: give it the UTF-8 bytes as characters 0-255
  const qr = q(0, 'M')
  qr.addData(Buffer.from(text, 'utf8').toString('latin1'), 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  return { size: n, dark: (r, c) => qr.isDark(r, c) }
}
