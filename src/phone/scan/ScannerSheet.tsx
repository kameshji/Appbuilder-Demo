/**
 * The full-screen camera scanner (P2-A): live camera (back camera preferred), an aiming frame, the torch where the
 * device has one, and the engine (native BarcodeDetector, our 1D decoder, jsQR for QR codes). One-shot: closes on the first code.
 * Continuous (stock counts): stays open, lists what was scanned, and reports each code once per 2 seconds.
 */
import { useEffect, useRef, useState } from 'react'
import { Flashlight, Loader2, X, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cameraErrorText } from '../CameraSheet'
import { createEngine, Debounce, engineNotice, setTorch, torchSupported, type ScanFormat, type ScanResult } from './scanner'

export function ScannerSheet({ formats, continuous, onScan, onClose }: { formats: ScanFormat[]; continuous: boolean; onScan(r: ScanResult): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [torch, setTorchState] = useState<boolean | null>(null)
  const [engineInfo, setEngineInfo] = useState('')
  const [scans, setScans] = useState<ScanResult[]>([])
  const onScanRef = useRef(onScan)
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const deb = new Debounce(2000)
    ;(async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(window.isSecureContext ? 'This browser has no camera access.' : 'The camera needs a secure (HTTPS) connection. Ask your administrator for the HTTPS address.')
        return
      }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      } catch (e) {
        setError(cameraErrorText(e))
        return
      }
      if (!alive) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      setTorchState(torchSupported(stream) ? false : null)
      const v = video.current!
      v.srcObject = stream
      await v.play().catch(() => {})
      setReady(true)
      const engine = await createEngine(formats)
      setEngineInfo(engineNotice(engine))
      const tick = async () => {
        if (!alive) return
        try {
          const r = await engine.detect(v)
          if (r && alive && deb.accept(r.text, Date.now())) {
            onScanRef.current(r)
            if (!continuous) {
              alive = false
              onClose()
              return
            }
            setScans((s) => [r, ...s].slice(0, 50))
          }
        } catch {
          /* a frame that could not be read */
        }
        if (alive) timer = setTimeout(tick, 160)
      }
      void tick()
    })()
    return () => {
      alive = false
      clearTimeout(timer)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [formats, continuous, onClose])

  return (
    <div className="fixed inset-0 z-[500] flex flex-col bg-black text-white" data-testid="scanner-sheet" role="dialog" aria-label="Scan a code">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <video ref={video} playsInline muted className="size-full object-cover" data-testid="scanner-video" />
        <div className="pointer-events-none absolute inset-x-[10%] top-1/2 h-[28%] -translate-y-1/2 rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        {!ready && !error && <Loader2 className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 animate-spin" />}
        {error && <p className="absolute inset-x-6 top-1/3 rounded-lg bg-white/90 p-4 text-center text-sm text-black" role="alert" data-testid="scanner-error">{error}</p>}
        {engineInfo && !error && <p className="absolute inset-x-4 top-4 rounded-md bg-black/60 px-3 py-2 text-center text-xs">{engineInfo}</p>}
      </div>
      {continuous && scans.length > 0 && (
        <ul className="max-h-32 overflow-y-auto border-t border-white/20 px-4 py-2 text-sm" data-testid="scanner-list">
          {scans.map((s, i) => <li key={i} className="flex items-center gap-2 py-0.5"><Check className="size-3.5 text-emerald-400" /> {s.text}</li>)}
        </ul>
      )}
      <div className="flex items-center justify-between gap-4 p-4 ab-sheet-pad-bottom">
        <Button variant="secondary" className="h-12 min-w-12" onClick={onClose} aria-label="Close scanner" data-testid="scanner-close"><X /> {continuous ? 'Done' : ''}</Button>
        <span className="text-xs text-white/80">{continuous ? `${scans.length} scanned` : 'Point the camera at the code'}</span>
        {torch !== null ? (
          <Button variant="secondary" className="h-12 min-w-12" aria-pressed={torch} aria-label="Torch" onClick={async () => { const ok = await setTorch(streamRef.current, !torch); if (ok) setTorchState(!torch) }}>
            <Flashlight />
          </Button>
        ) : <span className="w-12" />}
      </div>
    </div>
  )
}
