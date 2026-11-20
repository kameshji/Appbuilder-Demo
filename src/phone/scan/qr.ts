/**
 * QR code reading for browsers without a built-in reader (iPhone Safari, some desktop browsers). Decoder: jsQR 1.4.0
 * (Apache-2.0, pure JavaScript, no dependencies, by Cosmo Wolfe), loaded on first use with a dynamic import. The client
 * is a single-file build, so the import does not make a separate file: the code is part of index.html but is only
 * evaluated when a scanner sheet that wants QR codes needs it.
 * Data Matrix is not handled here (jsQR reads QR only).
 */
import type { QRCode } from 'jsqr'

/** RGBA pixels (canvas ImageData layout) in, the text of the QR code out; null when there is none */
export type QrDecode = (rgba: Uint8ClampedArray, width: number, height: number) => string | null

type JsQr = (data: Uint8ClampedArray, width: number, height: number, o?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }) => QRCode | null

/** the text of a code: jsQR's UTF-8 reading, or the raw bytes as Latin-1 when the payload is not valid UTF-8 */
function textOf(c: QRCode): string | null {
  if (c.data) return c.data
  if (!c.binaryData?.length) return null
  return String.fromCharCode(...c.binaryData)
}

/**
 * A decoder around jsQR. Every call tries the normal polarity (dark modules on light); every `invertEvery`-th call
 * tries inverted codes (light on dark) instead, which is rare, so it does not double the cost of every frame.
 * jsQR 1.4.0 quirks handled here: its "onlyInvert" option throws (the inverted image is never built), so the frame is
 * inverted here and read with "dontInvert"; the option is always passed because jsQR keeps the last one as its default;
 * a frame jsQR throws on (it does, on some pathological images) counts as no code.
 * Bounded cost: jsQR needs about 10-20 ms for a 960 x 540 frame on a laptop but about 300 ms for pure noise, so after a
 * call that took d ms the next calls within 2 x d ms are skipped (at most a third of the time goes to QR, however
 * slow the phone or busy the picture; calls under ~80 ms never cause a skip at the scanner's 160 ms pace).
 */
export function makeQrDecode(jsQR: JsQr, invertEvery = 4, now: () => number = () => performance.now()): QrDecode {
  let n = 0
  let resumeAt = -Infinity
  let flipped: Uint8ClampedArray | null = null
  return (rgba, width, height) => {
    if (now() < resumeAt) return null
    const invert = invertEvery > 0 && n++ % invertEvery === invertEvery - 1
    let px = rgba
    if (invert) {
      if (!flipped || flipped.length !== rgba.length) flipped = new Uint8ClampedArray(rgba.length)
      for (let i = 0; i < rgba.length; i += 4) {
        flipped[i] = 255 - rgba[i]
        flipped[i + 1] = 255 - rgba[i + 1]
        flipped[i + 2] = 255 - rgba[i + 2]
        flipped[i + 3] = 255
      }
      px = flipped
    }
    const t0 = now()
    try {
      const c = jsQR(px, width, height, { inversionAttempts: 'dontInvert' })
      return c ? textOf(c) : null
    } catch {
      return null
    } finally {
      const t1 = now()
      resumeAt = t1 + (t1 - t0) * 2 - 160 // a 160 ms scanner tick is free time anyway: only the excess pushes the next call out
    }
  }
}

let loading: Promise<QrDecode> | null = null

/** loads jsQR once; a failed load (offline chunk, blocked) is not cached, so the next scanner sheet tries again */
export function loadQrDecoder(): Promise<QrDecode> {
  loading ??= import('jsqr').then((m) => {
    const mod = m as unknown as { default?: unknown }
    let f: unknown = mod.default ?? m
    // CommonJS interop: the function may sit one level deeper depending on the bundler
    if (typeof f !== 'function' && f && typeof (f as { default?: unknown }).default === 'function') f = (f as { default: unknown }).default
    if (typeof f !== 'function') throw new Error('jsQR did not load')
    return makeQrDecode(f as JsQr)
  }).catch((e) => {
    loading = null
    throw e
  })
  return loading
}
