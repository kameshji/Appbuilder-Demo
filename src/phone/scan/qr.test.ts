import { describe, expect, it } from 'vitest'
import qrcode from 'qrcode-generator'
import jsQR from 'jsqr'
import { C128, decodeImage, toGray } from './decode1d'
import { loadQrDecoder, makeQrDecode } from './qr'
import { createEngine, decodeFrame, engineNotice, type EngineDeps, type Frame } from './scanner'

/* ------------------------------------------------------------------ test images: QR codes from qrcode-generator (the repo's own encoder), rasterised to RGBA */

type Matrix = boolean[][]

/** text as UTF-8 bytes in a Latin-1 string: qrcode-generator's default byte encoding writes one byte per char */
const utf8 = (s: string) => String.fromCharCode(...new TextEncoder().encode(s))

function qrMatrix(text: string, ecc: 'L' | 'M' | 'Q' | 'H' = 'M'): Matrix {
  const q = qrcode(0, ecc)
  q.addData(utf8(text), 'Byte')
  q.make()
  const n = q.getModuleCount()
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)))
}

/** a quarter turn clockwise */
const rot90 = (m: Matrix): Matrix => m.map((_, r) => m.map((__, c) => m[m.length - 1 - c][r]))
const rotate = (m: Matrix, deg: 0 | 90 | 180 | 270): Matrix => (deg === 0 ? m : deg === 90 ? rot90(m) : deg === 180 ? rot90(rot90(m)) : rot90(rot90(rot90(m))))

interface RenderOpts {
  px?: number
  /** quiet zone in modules */
  quiet?: number
  rotate?: 0 | 90 | 180 | 270
  /** gray levels of dark and light modules */
  dark?: number
  light?: number
  /** uniform noise amplitude (gray levels) */
  noise?: number
  blur?: boolean
  /** frame size; the code is centred on a light surround (like a camera frame with the code on a page) */
  frame?: { w: number; h: number }
  seed?: number
  /** remove this fraction of the code's rows from the bottom (a cut-off or half-hidden code) */
  cutBottom?: number
}

function renderQr(m: Matrix, o: RenderOpts = {}): Frame {
  const px = o.px ?? 4
  const quiet = o.quiet ?? 4
  const grid = rotate(m, o.rotate ?? 0)
  const n = grid.length
  const side = (n + quiet * 2) * px
  const w = o.frame?.w ?? side
  const h = o.frame?.h ?? side
  const dark = o.dark ?? 0
  const light = o.light ?? 255
  const gray = new Float32Array(w * h).fill(light)
  const ox = Math.floor((w - side) / 2) + quiet * px
  const oy = Math.floor((h - side) / 2) + quiet * px
  const rows = o.cutBottom ? Math.floor(n * (1 - o.cutBottom)) : n
  for (let r = 0; r < rows; r++) for (let c = 0; c < n; c++) {
    if (!grid[r][c]) continue
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) gray[(oy + r * px + y) * w + ox + c * px + x] = dark
  }
  if (o.cutBottom) for (let y = oy + rows * px; y < oy + n * px; y++) for (let x = 0; x < w; x++) gray[y * w + x] = light
  let g = gray
  if (o.blur) {
    g = new Float32Array(gray)
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += gray[(y + dy) * w + x + dx]
      g[y * w + x] = s / 9
    }
  }
  let seed = o.seed ?? 11
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const v = g[i] + (o.noise ? (rnd() - 0.5) * 2 * o.noise : 0)
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  return { data, width: w, height: h }
}

/** a Code 128 B barcode as a frame (bars 2 px wide, 80 px high, quiet zone around) */
function renderCode128(text: string): Frame {
  const vals = [104, ...text.split('').map((c) => c.charCodeAt(0) - 32)]
  let s = vals[0]
  for (let i = 1; i < vals.length; i++) s += vals[i] * i
  vals.push(s % 103)
  const widths = [...vals.flatMap((v) => C128[v]), 2, 3, 3, 1, 1, 1, 2]
  const mods: number[] = []
  let bar = true
  for (const wd of widths) {
    for (let i = 0; i < wd; i++) mods.push(bar ? 1 : 0)
    bar = !bar
  }
  const px = 3
  const quiet = 15
  const w = (mods.length + quiet * 2) * px
  const h = 140
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  for (let y = 30; y < 110; y++) for (let x = 0; x < mods.length * px; x++) {
    if (!mods[Math.floor(x / px)]) continue
    const i = (y * w + quiet * px + x) * 4
    data[i] = data[i + 1] = data[i + 2] = 0
  }
  return { data, width: w, height: h }
}

function noiseFrame(w: number, h: number, seed = 3): Frame {
  let s = seed
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const v = (s >> 8) & 255
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  return { data, width: w, height: h }
}

const decode = makeQrDecode(jsQR, 0)
/** inverted codes are tried on every 4th frame in production: give the decoder four frames */
function readInFrames(f: Frame, tries = 4): string | null {
  const d = makeQrDecode(jsQR, 4)
  for (let i = 0; i < tries; i++) {
    const t = d(f.data, f.width, f.height)
    if (t) return t
  }
  return null
}

const URL_LONG = 'https://appbuilder.example.com/app/stock-count?site=Warehouse%20North&bin=A-12-07&batch=2026-11-20T09%3A30%3A00Z&ref=' + 'x'.repeat(120) + '&utm_source=phone'

/* ------------------------------------------------------------------ decoding */

describe('QR fallback decoder (jsQR) on generated images', () => {
  it('reads codes at several module sizes, with the standard quiet zone', () => {
    for (const px of [3, 4, 6, 10]) {
      const f = renderQr(qrMatrix('STOCK-00042'), { px })
      expect(decode(f.data, f.width, f.height), `px ${px}`).toBe('STOCK-00042')
    }
  })

  it('reads a code with a short quiet zone and a code inside a larger frame', () => {
    const f1 = renderQr(qrMatrix('A1-B2'), { px: 6, quiet: 2 })
    expect(decode(f1.data, f1.width, f1.height)).toBe('A1-B2')
    const f2 = renderQr(qrMatrix('FRAME-TEST-1234'), { px: 5, frame: { w: 960, h: 540 } })
    expect(decode(f2.data, f2.width, f2.height)).toBe('FRAME-TEST-1234')
  })

  it('reads at every error-correction level', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      const f = renderQr(qrMatrix('LEVEL-' + ecc, ecc), { px: 5 })
      expect(decode(f.data, f.width, f.height), ecc).toBe('LEVEL-' + ecc)
    }
  })

  it('reads a code turned by 90, 180 and 270 degrees', () => {
    for (const deg of [90, 180, 270] as const) {
      const f = renderQr(qrMatrix('ROTATED-CODE'), { px: 5, rotate: deg, frame: { w: 640, h: 480 } })
      expect(decode(f.data, f.width, f.height), `${deg}`).toBe('ROTATED-CODE')
    }
  })

  it('reads through mild noise and blur', () => {
    const noisy = renderQr(qrMatrix('NOISY-1'), { px: 5, noise: 60, seed: 5 })
    expect(decode(noisy.data, noisy.width, noisy.height)).toBe('NOISY-1')
    const blurred = renderQr(qrMatrix('BLURRED-1'), { px: 5, blur: true })
    expect(decode(blurred.data, blurred.width, blurred.height)).toBe('BLURRED-1')
    const both = renderQr(qrMatrix('BOTH-1'), { px: 6, blur: true, noise: 40, seed: 9 })
    expect(decode(both.data, both.width, both.height)).toBe('BOTH-1')
  })

  it('reads a low-contrast code (grey on light grey)', () => {
    const f = renderQr(qrMatrix('LOW-CONTRAST'), { px: 5, dark: 110, light: 170 })
    expect(decode(f.data, f.width, f.height)).toBe('LOW-CONTRAST')
    const g = renderQr(qrMatrix('LOW-CONTRAST-NOISE'), { px: 5, dark: 100, light: 180, noise: 20, seed: 4 })
    expect(decode(g.data, g.width, g.height)).toBe('LOW-CONTRAST-NOISE')
  })

  it('reads an inverted code (light on dark) within the four-frame inversion cycle, and not on the normal-only pass', () => {
    const f = renderQr(qrMatrix('INVERTED-OK'), { px: 5, dark: 255, light: 0 })
    expect(decode(f.data, f.width, f.height)).toBeNull() // normal polarity only
    expect(readInFrames(f)).toBe('INVERTED-OK')
  })

  it('reads Hindi text (UTF-8)', () => {
    const text = 'नमस्ते दुनिया - स्टॉक 123'
    const f = renderQr(qrMatrix(text), { px: 5 })
    expect(decode(f.data, f.width, f.height)).toBe(text)
  })

  it('reads a long URL', () => {
    const f = renderQr(qrMatrix(URL_LONG, 'L'), { px: 4, frame: { w: 960, h: 720 } })
    expect(URL_LONG.length).toBeGreaterThan(200)
    expect(decode(f.data, f.width, f.height)).toBe(URL_LONG)
  })

  it('returns nothing for noise, a blank frame, a 1D barcode and a truncated code', () => {
    const n = noiseFrame(640, 480)
    expect(decode(n.data, n.width, n.height)).toBeNull()
    expect(readInFrames(n)).toBeNull()
    const blank = { data: new Uint8ClampedArray(640 * 480 * 4).fill(255), width: 640, height: 480 }
    expect(readInFrames(blank)).toBeNull()
    const bar = renderCode128('STOCK-00042')
    expect(decodeImage(toGray(bar.data, bar.width, bar.height), bar.width, bar.height)?.text).toBe('STOCK-00042') // the test image really is a barcode
    expect(readInFrames(bar)).toBeNull()
    const cut = renderQr(qrMatrix('TRUNCATED-CODE-TEXT'), { px: 5, cutBottom: 0.45 })
    expect(readInFrames(cut)).toBeNull()
  })

  it('does not read a code with two of its three finder patterns hidden', () => {
    const f = renderQr(qrMatrix('FINDERS-HIDDEN'), { px: 6 })
    // paint over the top-right and bottom-left finder areas (a hand or a fold across the code)
    const px = 6
    const n = qrMatrix('FINDERS-HIDDEN').length
    const paint = (x0: number, y0: number, w: number, h: number) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * f.width + x) * 4; f.data[i] = f.data[i + 1] = f.data[i + 2] = 255 }
    }
    paint((4 + n - 8) * px, 4 * px, 8 * px, 8 * px)
    paint(4 * px, (4 + n - 8) * px, 8 * px, 8 * px)
    expect(readInFrames(f)).toBeNull()
  })
})

describe('frame pipeline (1D decoder and QR together)', () => {
  const qr = makeQrDecode(jsQR, 0)
  it('reads a QR code only when QR is wanted', () => {
    const f = renderQr(qrMatrix('PIPE-QR'), { px: 5 })
    expect(decodeFrame(f, new Set(['code_128']), qr)).toEqual({ text: 'PIPE-QR', format: 'qr_code' })
    expect(decodeFrame(f, new Set(['code_128']), null)).toBeNull()
  })
  it('reads a 1D barcode with the 1D decoder, also when QR is wanted', () => {
    const f = renderCode128('STOCK-00042')
    expect(decodeFrame(f, new Set(['code_128']), qr)).toEqual({ text: 'STOCK-00042', format: 'code_128' })
    expect(decodeFrame(f, new Set(), qr)).toBeNull()
  })
})

describe('loadQrDecoder', () => {
  it('loads jsQR with a dynamic import and reads a code', async () => {
    const d = await loadQrDecoder()
    const f = renderQr(qrMatrix('LAZY-LOAD'), { px: 5 })
    expect(d(f.data, f.width, f.height)).toBe('LAZY-LOAD')
    expect(await loadQrDecoder()).toBe(d) // loaded once
  })
})

/* ------------------------------------------------------------------ cost per frame */

describe('decode cost', () => {
  it('measures the time per 960 x 540 frame (nothing to find, the worst case; and with a code)', () => {
    const empty = noiseFrame(960, 540)
    // a camera-like frame: smooth gradient with mild noise, no code
    for (let y = 0; y < 540; y++) for (let x = 0; x < 960; x++) {
      const i = (y * 960 + x) * 4
      const v = 120 + (x / 960) * 60 + ((i * 2654435761) % 40) / 4
      empty.data[i] = empty.data[i + 1] = empty.data[i + 2] = v
    }
    const withCode = renderQr(qrMatrix(URL_LONG, 'L'), { px: 3, frame: { w: 960, h: 540 }, noise: 20 })
    const flipped = (f: Frame): Frame => ({ ...f, data: f.data.map((v, i) => (i % 4 === 3 ? 255 : 255 - v)) })
    const run = (f: Frame, mode: 'dontInvert' | 'onlyInvert') => { const x = mode === 'onlyInvert' ? flipped(f) : f; return jsQR(x.data, x.width, x.height, { inversionAttempts: 'dontInvert' }) }
    const time = (f: Frame, mode: 'dontInvert' | 'onlyInvert', runs = 9) => {
      run(f, mode) // warm up
      const t: number[] = []
      for (let i = 0; i < runs; i++) {
        const s = performance.now()
        run(f, mode)
        t.push(performance.now() - s)
      }
      t.sort((a, b) => a - b)
      return { median: t[Math.floor(runs / 2)], max: t[runs - 1] }
    }
    const worst = time(noiseFrame(960, 540), 'dontInvert', 3) // white noise: the most edges the locator can be fed
    const a = time(empty, 'dontInvert')
    const b = time(empty, 'onlyInvert')
    const c = time(withCode, 'dontInvert')
    process.stdout.write(`jsQR 960x540 (node, this machine): no code normal ${a.median.toFixed(1)} ms (max ${a.max.toFixed(1)}), no code inverted ${b.median.toFixed(1)} ms, with a long-URL code ${c.median.toFixed(1)} ms, pure noise ${worst.median.toFixed(1)} ms
`)
    // a generous ceiling: far above the measured time on a laptop, so only a real regression (or a broken loop) fails it
    expect(a.median).toBeLessThan(1000)
    expect(c.median).toBeLessThan(1000)
    expect(worst.median).toBeLessThan(3000)
  }, 60_000)
})

describe('decode budget', () => {
  const ticks = (cost: number) => {
    let t = 0
    let calls = 0
    const slow = (() => { calls++; t += cost; return null }) as unknown as typeof jsQR
    const d = makeQrDecode(slow, 0, () => t)
    const px = new Uint8ClampedArray(16)
    for (let i = 0; i < 20; i++) { d(px, 2, 2); t += 160 } // the scanner's 160 ms pace
    return calls
  }
  it('a fast decoder runs on every tick, a slow one is limited to about a third of the time', () => {
    expect(ticks(10)).toBe(20)
    expect(ticks(80)).toBe(20)
    const slow = ticks(300) // 300 ms per call, 20 ticks = about 3.2 s + the calls themselves
    expect(slow).toBeGreaterThanOrEqual(3)
    expect(slow).toBeLessThanOrEqual(7)
  })
  it('a code is still read right after a slow frame once the pause is over', () => {
    let t = 0
    const f = renderQr(qrMatrix('AFTER-PAUSE'), { px: 5 })
    const d = makeQrDecode((px, w, h, o) => { const r = jsQR(px, w, h, o); t += 1000; return r }, 0, () => t)
    expect(d(f.data, f.width, f.height)).toBe('AFTER-PAUSE')
    expect(d(f.data, f.width, f.height)).toBeNull() // inside the pause
    t += 5000
    expect(d(f.data, f.width, f.height)).toBe('AFTER-PAUSE')
  })
})

/* ------------------------------------------------------------------ engine selection (no DOM: the detector, the loader and the frame source are injected) */

describe('createEngine selection', () => {
  const video = {} as HTMLVideoElement
  const supports = (formats: string[], reads: Record<string, string> = {}) => {
    const calls = { ctor: 0, detect: 0 }
    class Det {
      static async getSupportedFormats() { return formats }
      constructor(o?: { formats?: string[] }) { calls.ctor++; this.formats = o?.formats ?? [] }
      formats: string[]
      async detect() { calls.detect++; const k = Object.keys(reads)[0]; return k ? [{ rawValue: reads[k], format: k }] : [] }
    }
    return { Det: Det as unknown as NonNullable<EngineDeps['detector']>, calls }
  }
  const spy = (qrText: string | null = null) => {
    const calls = { load: 0, qr: 0, grab: 0 }
    const deps: Pick<EngineDeps, 'loadQr' | 'grab'> = {
      loadQr: async () => { calls.load++; return () => { calls.qr++; return qrText } },
      grab: () => { calls.grab++; return { data: new Uint8ClampedArray(16 * 16 * 4).fill(255), width: 16, height: 16 } },
    }
    return { deps, calls }
  }

  it('BarcodeDetector with qr_code: native, jsQR is not even loaded', async () => {
    const { Det, calls: dc } = supports(['qr_code', 'ean_13', 'code_128'], { qr_code: 'native-text' })
    const s = spy('fallback-text')
    const e = await createEngine(['qr_code', 'ean_13'], { detector: Det, ...s.deps })
    expect(e.kind).toBe('native')
    expect(e.formats).toEqual(['qr_code', 'ean_13'])
    expect(e.unreadable).toEqual([])
    expect(await e.detect(video)).toEqual({ text: 'native-text', format: 'qr_code' })
    expect(dc.detect).toBe(1)
    expect(s.calls).toEqual({ load: 0, qr: 0, grab: 0 })
    expect(engineNotice(e)).toBe('')
  })

  it('no BarcodeDetector: the fallback reads QR through jsQR', async () => {
    const s = spy('fallback-text')
    const e = await createEngine(['qr_code'], { detector: undefined, ...s.deps })
    expect(e.kind).toBe('fallback')
    expect(e.formats).toEqual(['qr_code'])
    expect(await e.detect(video)).toEqual({ text: 'fallback-text', format: 'qr_code' })
    expect(s.calls).toEqual({ load: 1, qr: 1, grab: 1 })
    expect(engineNotice(e)).toBe('')
  })

  it('BarcodeDetector without qr_code: native for the rest, jsQR for QR, native first', async () => {
    const { Det } = supports(['ean_13', 'code_128'], { ean_13: '4006381333931' })
    const s = spy('fallback-text')
    const e = await createEngine(['qr_code', 'ean_13'], { detector: Det, ...s.deps })
    expect(e.kind).toBe('native')
    expect(e.formats.sort()).toEqual(['ean_13', 'qr_code'])
    expect(await e.detect(video)).toEqual({ text: '4006381333931', format: 'ean_13' })
    expect(s.calls.qr).toBe(0) // the native reader found something: no second decode on that frame
    const { Det: none } = supports(['ean_13'])
    const e2 = await createEngine(['qr_code', 'ean_13'], { detector: none, ...s.deps })
    expect(await e2.detect(video)).toEqual({ text: 'fallback-text', format: 'qr_code' })
    expect(s.calls.qr).toBe(1)
  })

  it('a BarcodeDetector that supports none of the wanted formats, or throws: the fallback', async () => {
    const s = spy('t')
    const { Det } = supports(['aztec'])
    expect((await createEngine(['qr_code'], { detector: Det, ...s.deps })).kind).toBe('fallback')
    class Broken { static async getSupportedFormats(): Promise<string[]> { throw new Error('no') } }
    expect((await createEngine(['qr_code'], { detector: Broken as never, ...s.deps })).kind).toBe('fallback')
  })

  it('QR not wanted: the fallback never loads or calls jsQR, the 1D decoder still runs', async () => {
    const s = spy('must-not-be-read')
    const e = await createEngine(['code_128', 'ean_13'], { detector: undefined, ...s.deps })
    expect(e.kind).toBe('fallback')
    expect(e.formats).toEqual(['code_128', 'ean_13'])
    expect(await e.detect(video)).toBeNull() // the frame is blank: no barcode
    expect(s.calls.load).toBe(0)
    expect(s.calls.qr).toBe(0)
    expect(s.calls.grab).toBe(1)
  })

  it('only Data Matrix wanted, no native reader: nothing readable, no frames grabbed, the sheet says so', async () => {
    const s = spy('x')
    const e = await createEngine(['data_matrix'], { detector: undefined, ...s.deps })
    expect(e.formats).toEqual([])
    expect(e.unreadable).toEqual(['data_matrix'])
    expect(await e.detect(video)).toBeNull()
    expect(s.calls).toEqual({ load: 0, qr: 0, grab: 0 })
    expect(engineNotice(e)).toBe('This browser cannot read these codes with the camera.')
  })

  it('all formats without a native reader: QR and 1D read, Data Matrix is named as unsupported', async () => {
    const s = spy(null)
    const e = await createEngine(['qr_code', 'data_matrix', 'ean_13', 'ean_8', 'code_128', 'code_39', 'itf'], { detector: undefined, ...s.deps })
    expect(e.formats).toEqual(['ean_13', 'ean_8', 'code_128', 'code_39', 'itf', 'qr_code'])
    expect(e.unreadable).toEqual(['data_matrix'])
    expect(engineNotice(e)).toBe('Reads EAN, Code 128, Code 39, ITF and QR codes on this browser. Data Matrix needs a browser with a built-in reader (Chrome on Android) or a handheld scanner.')
  })

  it('jsQR failing to load: QR is reported as not loaded, 1D keeps working', async () => {
    const e = await createEngine(['qr_code', 'code_128'], { detector: undefined, loadQr: async () => { throw new Error('chunk') }, grab: () => null })
    expect(e.formats).toEqual(['code_128'])
    expect(e.unreadable).toEqual(['qr_code'])
    expect(engineNotice(e)).toBe('Reads Code 128 on this browser. QR codes could not be loaded.')
  })

  it('end to end with the real decoder: a generated frame is read through the fallback engine', async () => {
    const f = renderQr(qrMatrix('ENGINE-E2E'), { px: 5, frame: { w: 640, h: 360 } })
    const e = await createEngine(['qr_code', 'code_128'], { detector: undefined, grab: () => f })
    expect(await e.detect(video)).toEqual({ text: 'ENGINE-E2E', format: 'qr_code' })
  })
})
