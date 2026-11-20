/**
 * Camera barcode scanning (P2-A, docs/dev/phone.md "Scanner"). Uses the browser's BarcodeDetector when it exists and
 * supports the wanted formats (Android Chrome: QR, Data Matrix, EAN, Code 128/39, ITF ...); otherwise grabs frames into
 * a canvas and runs our own 1D decoder (decode1d.ts: EAN-13/8, Code 128, Code 39, ITF; no QR, no Data Matrix).
 * About 6 frames a second, on the main thread, frames scaled to at most 960 px wide.
 */
import { decodeImage, toGray, type Format1D } from './decode1d'

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

export interface Engine {
  /** 'native' (BarcodeDetector) or 'fallback' (our 1D decoder) */
  kind: 'native' | 'fallback'
  /** formats that can actually be read with this engine */
  formats: ScanFormat[]
  detect(video: HTMLVideoElement): Promise<ScanResult | null>
}

let canvas: HTMLCanvasElement | null = null

export async function createEngine(wanted: ScanFormat[]): Promise<Engine> {
  const Ctor = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector
  if (Ctor) {
    try {
      const supported = (await Ctor.getSupportedFormats?.()) ?? []
      const use = wanted.filter((f) => supported.includes(f))
      if (use.length) {
        const det = new Ctor({ formats: use })
        return {
          kind: 'native',
          formats: use,
          async detect(video) {
            const r = await det.detect(video)
            return r[0] ? { text: r[0].rawValue, format: r[0].format as ScanFormat } : null
          },
        }
      }
    } catch {
      /* fall back */
    }
  }
  const fb = wanted.filter((f): f is Format1D => (FALLBACK_FORMATS as string[]).includes(f))
  const set = new Set<Format1D>(fb)
  return {
    kind: 'fallback',
    formats: fb,
    async detect(video) {
      if (!video.videoWidth || !set.size) return null
      const scale = Math.min(1, 960 / video.videoWidth)
      const w = Math.round(video.videoWidth * scale)
      const h = Math.round(video.videoHeight * scale)
      canvas ??= document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.drawImage(video, 0, 0, w, h)
      const d = decodeImage(toGray(ctx.getImageData(0, 0, w, h).data, w, h), w, h, set)
      return d ? { text: d.text, format: d.format } : null
    },
  }
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
