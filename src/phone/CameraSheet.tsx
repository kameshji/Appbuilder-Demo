/**
 * In-page camera (P2-A): a bottom sheet with the live camera (getUserMedia, back camera preferred) and a shutter.
 * Used where a device has a camera but no native capture picker (laptops, tablets with webcams); phones use the
 * native camera through `<input capture>` (better focus, flash and HDR). Permission prompts are the browser's; a refusal
 * or a missing camera is shown in words, never as a blank box. The stream stops when the sheet closes.
 */
import { useEffect, useRef, useState } from 'react'
import { Camera, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window !== 'undefined' && window.isSecureContext
}

/** maker-friendly text for a getUserMedia error */
export function cameraErrorText(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was refused. Allow the camera for this site in the browser settings, then try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  if (name === 'NotReadableError') return 'The camera is in use by another app.'
  return 'The camera could not be started.'
}

export function CameraSheet({ onPhoto, onClose }: { onPhoto(file: File): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let alive = true
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (!alive) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        if (video.current) {
          video.current.srcObject = s
          void video.current.play().then(() => setReady(true), () => setReady(true))
        }
      })
      .catch((e: unknown) => setError(cameraErrorText(e)))
    return () => {
      alive = false
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const shoot = () => {
    const v = video.current
    if (!v || !v.videoWidth) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d')?.drawImage(v, 0, 0)
    c.toBlob((b) => {
      if (b) onPhoto(new File([b], `photo-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.9)
  }

  return (
    <div className="fixed inset-0 z-[500] flex flex-col bg-black" data-testid="camera-sheet" role="dialog" aria-label="Camera">
      <div className="relative min-h-0 flex-1">
        <video ref={video} playsInline muted className="size-full object-contain" data-testid="camera-video" />
        {!ready && !error && <Loader2 className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 animate-spin text-white" />}
        {error && <p className="absolute inset-x-6 top-1/3 rounded-lg bg-white/90 p-4 text-center text-sm text-black" role="alert" data-testid="camera-error">{error}</p>}
      </div>
      <div className="flex items-center justify-between gap-4 p-4 ab-sheet-pad-bottom">
        <Button variant="secondary" className="h-12 min-w-12" onClick={onClose} aria-label="Close camera"><X /></Button>
        <button
          type="button"
          disabled={!ready}
          onClick={shoot}
          aria-label="Take photo"
          data-testid="camera-shutter"
          className="grid size-16 place-items-center rounded-full border-4 border-white bg-white/20 text-white disabled:opacity-40"
        >
          <Camera className="size-6" />
        </button>
        <span className="w-12" />
      </div>
    </div>
  )
}
