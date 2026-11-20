/**
 * Camera code scanning (P2-A, docs/dev/phone.md "Scanner"). Uses the browser's BarcodeDetector for the formats it
 * supports (Android Chrome: QR, Data Matrix, EAN, Code 128/39, ITF ...). Whatever it does not support is read from
 * frames grabbed into a canvas: 1D barcodes by our own decoder (decode1d.ts: EAN-13/8, Code 128, Code 39, ITF) and QR
 * codes by jsQR (qr.ts, Apache-2.0, loaded on first use). Data Matrix has no fallback.
 * About 6 frames a second, on the main thread, frames scaled to at most 960 px wide.
 */
import { decodeImage, toGray, type Format1D } from './decode1d'
import { loadQrDecoder, type QrDecode } from './qr'

export type ScanFormat = Format1D | 'qr_code' | 'data_matrix'
export const ALL_FORMATS: ScanFormat[] = ['qr_code', 'data_matrix', 'ean_13', 'ean_8', 'code_128', 'code_39', 'itf']
export const FALLBACK_FORMATS: ScanFormat[] = ['ean_13', 'ean_8', 'code_128', 'code_39', 'itf']

export interface ScanResult { text: string; format: ScanFormat }

interface NativeDetector { detect(src: CanvasImageSource): Promise<Array<{ rawValue: string; format: string }>> }
interface NativeDetectorCtor { new (o?: { formats?: string[] }): NativeDetector; getSupportedFormats?(): Promise<string[]> }

/** formats text "All" or "qr_code, ean_13" -> list; unknown names are dropped */
export function parseFormats(text: string): ScanFormat[] {
  const t = text.trim().toLowerCase()
  if (!t || t === 'all') return ALL_FORMATS.slice()
  const alias: Record<string, ScanFormat> = { qr: 'qr_code', datamatrix: 'data_matrix', ean13: 'ean_13', ean8: 'ean_8', code128: 'code_128', code39: 'code_39', upc: 'ean_13', upc_a: 'ean_13' }
  return [...new Set(t.split(/[\s,;]+/).map((s) => alias[s.replace(/-/g, '_')] ?? (s.replace(/-/g, '_') as ScanFormat)).filter((f) => ALL_FORMATS.includes(f)))]
}

/** a camera frame as RGBA pixels (canvas ImageData layout) */
export interface Frame { data: Uint8ClampedArray; width: number; height: number }

/**
 * Reads one frame with our own decoders: 1D barcodes first (cheap), then a QR code when `qr` is given.
 * Pure (no DOM), so tests feed it generated images.
 */
export function decodeFrame(f: Frame, oneD: ReadonlySet<Format1D>, qr: QrDecode | null): ScanResult | null {
  if (oneD.size) {
    const d = decodeImage(toGray(f.data, f.width, f.height), f.width, f.height, oneD)
    if (d) return { text: d.text, format: d.format }
  }
  if (qr) {
    const text = qr(f.data, f.width, f.height)
    if (text) return { text, format: 'qr_code' }
  }
  return null
}

export interface Engine {
  /** 'native' (BarcodeDetector reads at least one wanted format) or 'fallback' (only our decoders: 1D and QR) */
  kind: 'native' | 'fallback'
  /** formats that can actually be read with this engine (native and our decoders together) */
  formats: ScanFormat[]
  /** wanted formats nothing here can read (Data Matrix without a native reader; QR when jsQR did not load) */
  unreadable: ScanFormat[]
  detect(video: HTMLVideoElement): Promise<ScanResult | null>
}

/** what createEngine needs from the outside; tests replace these (no DOM there) */
export interface EngineDeps {
  /** the BarcodeDetector constructor; the key present with undefined means "this browser has none" */
  detector?: NativeDetectorCtor | undefined
  loadQr?: () => Promise<QrDecode>
  grab?: (video: HTMLVideoElement) => Frame | null
}

let canvas: HTMLCanvasElement | null = null

/** the current video frame scaled to at most 960 px wide */
function grabFrame(video: HTMLVideoElement): Frame | null {
  if (!video.videoWidth) return null
  const scale = Math.min(1, 960 / video.videoWidth)
  const w = Math.round(video.videoWidth * scale)
  const h = Math.round(video.videoHeight * scale)
  canvas ??= document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, w, h)
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h }
}

export async function createEngine(wanted: ScanFormat[], deps: EngineDeps = {}): Promise<Engine> {
  const Ctor = 'detector' in deps ? deps.detector : (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector
  let det: NativeDetector | null = null
  let native: ScanFormat[] = []
  if (Ctor) {
    try {
      const supported = (await Ctor.getSupportedFormats?.()) ?? []
      const use = wanted.filter((f) => supported.includes(f))
      if (use.length) {
        det = new Ctor({ formats: use })
        native = use
      }
    } catch {
      det = null
      native = []
    }
  }
  // what the browser's reader does not do: our 1D decoder, and jsQR for QR codes (loaded only when QR is wanted and missing)
  const rest = wanted.filter((f) => !native.includes(f))
  const oneD = new Set(rest.filter((f): f is Format1D => (FALLBACK_FORMATS as string[]).includes(f)))
  let qr: QrDecode | null = null
  if (rest.includes('qr_code')) {
    try {
      qr = await (deps.loadQr ?? loadQrDecoder)()
    } catch {
      qr = null
    }
  }
  const viaFrames: ScanFormat[] = [...oneD, ...(qr ? (['qr_code'] as const) : [])]
  const unreadable = rest.filter((f) => !viaFrames.includes(f))
  const grab = deps.grab ?? grabFrame
  return {
    kind: det ? 'native' : 'fallback',
    formats: [...native, ...viaFrames],
    unreadable,
    async detect(video) {
      if (det) {
        try {
          const r = await det.detect(video)
          if (r[0]) return { text: r[0].rawValue, format: r[0].format as ScanFormat }
        } catch {
          /* a frame the browser's reader refused: our decoders still get it */
        }
      }
      if (!oneD.size && !qr) return null
      const f = grab(video)
      return f ? decodeFrame(f, oneD, qr) : null
    },
  }
}

const FORMAT_NAME: Record<ScanFormat, string> = { qr_code: 'QR codes', data_matrix: 'Data Matrix', ean_13: 'EAN', ean_8: 'EAN', code_128: 'Code 128', code_39: 'Code 39', itf: 'ITF' }
const names = (fs: ScanFormat[]) => {
  const n = [...new Set(fs.map((f) => FORMAT_NAME[f]))]
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] ?? ''
}

/** the line the scanner sheet shows when this browser cannot read some wanted format; '' when everything wanted works */
export function engineNotice(e: Pick<Engine, 'formats' | 'unreadable'>): string {
  if (!e.unreadable.length) return ''
  if (!e.formats.length) return 'This browser cannot read these codes with the camera.'
  const dm = e.unreadable.includes('data_matrix')
  const other = e.unreadable.filter((f) => f !== 'data_matrix')
  return [
    `Reads ${names(e.formats)} on this browser.`,
    dm ? 'Data Matrix needs a browser with a built-in reader (Chrome on Android) or a handheld scanner.' : '',
    other.length ? `${names(other)} could not be loaded.` : '',
  ].filter(Boolean).join(' ')
}

/** continuous scanning: the same code is reported again only after `ms` without it */
export class Debounce {
  private lastText = ''
  private lastAt = -Infinity
  constructor(private readonly ms = 2000) {}
  accept(text: string, at: number): boolean {
    const same = text === this.lastText && at - this.lastAt < this.ms
    if (text === this.lastText) this.lastAt = at
    if (same) return false
    this.lastText = text
    this.lastAt = at
    return true
  }
}

/** torch (flashlight) on the camera track where the device supports it; false when it does not */
export async function setTorch(stream: MediaStream | null, on: boolean): Promise<boolean> {
  const track = stream?.getVideoTracks()[0]
  const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean }
  if (!track || !caps.torch) return false
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
    return true
  } catch {
    return false
  }
}
export function torchSupported(stream: MediaStream | null): boolean {
  const track = stream?.getVideoTracks()[0]
  return !!(track?.getCapabilities?.() as { torch?: boolean } | undefined)?.torch
}
