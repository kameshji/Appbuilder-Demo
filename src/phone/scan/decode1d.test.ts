import { describe, expect, it } from 'vitest'
import { C128, CODE39, decodeImage, decodeRow, eanCheckOk, type Format1D } from './decode1d'

/* ------------------------------------------------------------------ test encoders (independent of the decoder's tables where possible) */

const widthsToModules = (widths: number[], startBar = true): number[] => {
  const out: number[] = []
  let bar = startBar
  for (const w of widths) {
    for (let i = 0; i < w; i++) out.push(bar ? 1 : 0)
    bar = !bar
  }
  return out
}

// EAN tables from the GS1 specification (written as module bit strings, not widths, so they are independent of the decoder)
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const EAN_R = EAN_L.map((p) => p.split('').map((c) => (c === '1' ? '0' : '1')).join(''))
const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']
const bits = (s: string) => s.split('').map(Number)
function ean13(code: string): number[] {
  const d = code.split('').map(Number)
  const par = PAR[d[0]]
  let m = '101'
  for (let i = 0; i < 6; i++) m += par[i] === 'L' ? EAN_L[d[i + 1]] : EAN_G[d[i + 1]]
  m += '01010'
  for (let i = 0; i < 6; i++) m += EAN_R[d[i + 7]]
  return bits(m + '101')
}
function ean8(code: string): number[] {
  const d = code.split('').map(Number)
  let m = '101'
  for (let i = 0; i < 4; i++) m += EAN_L[d[i]]
  m += '01010'
  for (let i = 4; i < 8; i++) m += EAN_R[d[i]]
  return bits(m + '101')
}
function code128B(text: string): number[] {
  const vals = [104, ...text.split('').map((c) => c.charCodeAt(0) - 32)]
  let s = vals[0]
  for (let i = 1; i < vals.length; i++) s += vals[i] * i
  vals.push(s % 103)
  return [...vals.flatMap((v) => widthsToModules(C128[v])), ...widthsToModules([2, 3, 3, 1, 1, 1, 2])]
}
function code128C(digits: string): number[] {
  const vals = [105]
  for (let i = 0; i < digits.length; i += 2) vals.push(Number(digits.slice(i, i + 2)))
  let s = vals[0]
  for (let i = 1; i < vals.length; i++) s += vals[i] * i
  vals.push(s % 103)
  return [...vals.flatMap((v) => widthsToModules(C128[v])), ...widthsToModules([2, 3, 3, 1, 1, 1, 2])]
}
function code39(text: string, wide = 3): number[] {
  const out: number[] = []
  for (const ch of `*${text}*`) {
    const p = CODE39.patterns[CODE39.chars.indexOf(ch)]
    out.push(...widthsToModules(p.split('').map((c) => (c === 'w' ? wide : 1))), 0)
  }
  out.pop()
  return out
}
const ITF_P = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn']
function itf(digits: string): number[] {
  const w: number[] = [1, 1, 1, 1]
  for (let i = 0; i < digits.length; i += 2) {
    const a = ITF_P[Number(digits[i])]
    const b = ITF_P[Number(digits[i + 1])]
    for (let k = 0; k < 5; k++) w.push(a[k] === 'w' ? 3 : 1, b[k] === 'w' ? 3 : 1)
  }
  w.push(3, 1, 1)
  return widthsToModules(w)
}

/** render modules to a grayscale image: module px, quiet zone (modules), height, optional noise and blur */
function render(modules: number[], o: { px?: number; quiet?: number; h?: number; noise?: number; blur?: boolean; seed?: number; offset?: number } = {}) {
  const px = o.px ?? 3
  const quiet = o.quiet ?? 12
  const off = o.offset ?? 0
  const w = Math.ceil((modules.length + quiet * 2) * px + off * 2)
  const h = o.h ?? 60
  const img = new Uint8Array(w * h)
  let seed = o.seed ?? 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = Math.floor((x - off) / px) - quiet
      const dark = m >= 0 && m < modules.length && modules[m] === 1
      let v = dark ? 30 : 225
      if (o.noise) v += (rnd() - 0.5) * 2 * o.noise
      img[y * w + x] = Math.max(0, Math.min(255, Math.round(v)))
    }
  }
  if (o.blur) {
    const b = new Uint8Array(img)
    for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) b[y * w + x] = (img[y * w + x - 1] + 2 * img[y * w + x] + img[y * w + x + 1]) >> 2
    return { img: b, w, h }
  }
  return { img, w, h }
}
const dec = (m: number[], o?: Parameters<typeof render>[1], formats?: Format1D[]) => {
  const r = render(m, o)
  return decodeImage(r.img, r.w, r.h, formats ? new Set(formats) : undefined)
}

describe('1D decoder', () => {
  it('table sanity: Code 128 patterns are 11 modules and unique, Code 39 has 3 wide of 9', () => {
    expect(C128).toHaveLength(106)
    expect(C128.every((p) => p.reduce((a, b) => a + b, 0) === 11)).toBe(true)
    expect(new Set(C128.map((p) => p.join(''))).size).toBe(106)
    expect(CODE39.patterns.every((p) => p.length === 9 && p.split('w').length - 1 === 3)).toBe(true)
  })

  it('EAN-13 check digits', () => {
    expect(eanCheckOk('4006381333931')).toBe(true)
    expect(eanCheckOk('4006381333932')).toBe(false)
    expect(eanCheckOk('96385074')).toBe(true)
  })

  it.each([
    ['ean_13', '4006381333931', ean13('4006381333931')],
    ['ean_13', '0036000291452', ean13('0036000291452')],
    ['ean_8', '96385074', ean8('96385074')],
    ['code_128', 'LOT-2026/11 A7', code128B('LOT-2026/11 A7')],
    ['code_128', '0123456789', code128C('0123456789')],
    ['code_39', 'PART-42.X', code39('PART-42.X')],
    ['itf', '12345678', itf('12345678')],
  ] as const)('decodes %s %s (clean, scaled, noisy, blurred, reversed)', (format, text, modules) => {
    expect(dec([...modules])).toEqual({ format, text })
    expect(dec([...modules], { px: 2 })).toEqual({ format, text })
    expect(dec([...modules], { px: 5, noise: 40, blur: true })).toEqual({ format, text })
    expect(dec([...modules].reverse(), { px: 3, offset: 1.5 })).toEqual({ format, text })
  })

  it('Code 39 with a 2:1 wide ratio', () => {
    expect(dec(code39('AB12', 2))).toEqual({ format: 'code_39', text: 'AB12' })
  })

  it('rejects a bad EAN checksum, noise and missing quiet zones', () => {
    expect(dec(ean13('4006381333932'))).toBeNull()
    const noise = render([], { h: 40 })
    let seed = 3
    for (let i = 0; i < noise.img.length; i++) noise.img[i] = (seed = (seed * 69069 + 1) >>> 0) % 255
    expect(decodeImage(noise.img, noise.w, noise.h)).toBeNull()
    expect(dec(ean13('4006381333931'), { quiet: 1 })).toBeNull()
    expect(decodeRow(new Uint8Array(200).fill(200))).toBeNull()
  })

  it('restricts formats when asked', () => {
    expect(dec(code39('AB12'), {}, ['ean_13'])).toBeNull()
    expect(dec(code39('AB12'), {}, ['code_39'])).toEqual({ format: 'code_39', text: 'AB12' })
  })
})
