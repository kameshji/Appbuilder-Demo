/**
 * The drawing surface of the signature pad (docs/dev/phone.md "Signature pad"), shared by the SignaturePad UI component
 * and the Form's signature fields. Pointer events (finger, stylus, mouse), one pointer at a time; the canvas has
 * `touch-action: none` (the page does not scroll and pull to refresh does not start while drawing: `data-no-pull`);
 * the backing store is drawn at devicePixelRatio. Strokes are kept in pad units (signature.ts), simplified when a stroke
 * ends and drawn smoothed. `exportPng` draws the signature on white at a bounded size (signature.ts `exportSize`).
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { exportSize, hasSignature, padRect, penWidthFor, simplify, strokePath, toPad, type Stroke } from './signature'

export interface SignatureHandle {
  clear(): void
  /** the signature as a PNG file and data URL, or null when nothing is drawn */
  exportPng(name?: string): Promise<{ file: File; dataUrl: string } | null>
  signed(): boolean
}

interface Props {
  handle?: Ref<SignatureHandle>
  disabled?: boolean
  penColor?: string
  penWidth?: number
  placeholder?: string
  /** after every finished stroke and after Clear */
  onChange?(signed: boolean): void
  /** a stroke ended (OnSign) */
  onStrokeEnd?(): void
  className?: string
  testId?: string
}

function drawStrokes(g: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number, color: string, width: number, ox = 0, oy = 0) {
  g.strokeStyle = color
  g.fillStyle = color
  g.lineWidth = width
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const s of strokes) {
    const cmds = strokePath(s, w, h, ox, oy)
    if (!cmds.length) continue
    if (cmds[0]!.t === 'dot') {
      g.beginPath()
      g.arc(cmds[0]!.x, cmds[0]!.y, width / 2, 0, Math.PI * 2)
      g.fill()
      continue
    }
    g.beginPath()
    for (const c of cmds) {
      if (c.t === 'M') g.moveTo(c.x, c.y)
      else if (c.t === 'L') g.lineTo(c.x, c.y)
      else if (c.t === 'Q') g.quadraticCurveTo(c.cx, c.cy, c.x, c.y)
    }
    g.stroke()
  }
}

export function SignatureCanvas({ handle, disabled, penColor = '#111827', penWidth = 2.5, placeholder = 'Sign here', onChange, onStrokeEnd, className, testId = 'signature-canvas' }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Stroke[]>([])
  const live = useRef<{ id: number; pts: Stroke } | null>(null)
  const [rect, setRect] = useState({ x: 0, y: 0, w: 0, h: 0 })
  const [empty, setEmpty] = useState(true)
  const frame = useRef(0)

  // the pad: the largest 3:1 area of the box
  useEffect(() => {
    const el = box.current
    if (!el) return
    const update = () => {
      const r = padRect(el.clientWidth, el.clientHeight)
      setRect((o) => (Math.abs(o.w - r.w) < 0.5 && Math.abs(o.h - r.h) < 0.5 && Math.abs(o.x - r.x) < 0.5 && Math.abs(o.y - r.y) < 0.5 ? o : r))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const redraw = useCallback(() => {
    const c = canvas.current
    if (!c || rect.w <= 0) return
    const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
    const W = Math.round(rect.w * dpr)
    const H = Math.round(rect.h * dpr)
    if (c.width !== W || c.height !== H) {
      c.width = W
      c.height = H
    }
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, rect.w, rect.h)
    const all = live.current ? [...strokes.current, live.current.pts] : strokes.current
    drawStrokes(g, all, rect.w, rect.h, penColor, penWidthFor(penWidth, rect.w))
  }, [rect, penColor, penWidth])
  useEffect(() => redraw(), [redraw])
  const schedule = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      redraw()
    })
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const signedNow = () => hasSignature(strokes.current, rect.w || 360, rect.h || 120)
  useImperativeHandle(handle, () => ({
    clear() {
      strokes.current = []
      live.current = null
      setEmpty(true)
      redraw()
      onChange?.(false)
    },
    signed: signedNow,
    async exportPng(name = 'signature.png') {
      if (!signedNow()) return null
      const size = exportSize(rect.w, rect.h)
      const c = document.createElement('canvas')
      c.width = size.w
      c.height = size.h
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, size.w, size.h)
      drawStrokes(g, strokes.current, size.w, size.h, penColor, penWidthFor(penWidth, rect.w) * size.scale)
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))
      if (!blob) return null
      const dataUrl = c.toDataURL('image/png')
      return { file: new File([blob], name, { type: 'image/png', lastModified: Date.now() }), dataUrl }
    },
  }))

  const pos = (e: { clientX: number; clientY: number; timeStamp: number }) => {
    const r = canvas.current!.getBoundingClientRect()
    return toPad(e.clientX, e.clientY, r, e.timeStamp)
  }
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || live.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* not capturable */
    }
    live.current = { id: e.pointerId, pts: [pos(e)] }
    setEmpty(false)
    schedule()
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = live.current
    if (!l || l.id !== e.pointerId) return
    e.preventDefault()
    const list = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : []
    for (const ev of list.length ? list : [e.nativeEvent]) l.pts.push(pos(ev))
    schedule()
  }
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = live.current
    if (!l || l.id !== e.pointerId) return
    live.current = null
    strokes.current = [...strokes.current, simplify(l.pts, rect.w, rect.h)]
    redraw()
    const s = signedNow()
    setEmpty(strokes.current.length === 0)
    onChange?.(s)
    onStrokeEnd?.()
  }

  return (
    <div ref={box} className={className ?? 'relative size-full'} data-no-pull>
      <div
        className="absolute overflow-hidden rounded-md border border-input bg-white"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        {/* the signature line */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-[6%] border-b border-dashed border-neutral-300" style={{ top: '72%' }} />
        {empty && placeholder && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 text-center text-sm text-neutral-400" style={{ top: '40%' }}>
            {placeholder}
          </div>
        )}
        <canvas
          ref={canvas}
          role="img"
          aria-label={empty ? 'Signature pad, empty' : 'Signature pad, signed'}
          data-testid={testId}
          className="absolute inset-0 size-full"
          style={{ touchAction: 'none', cursor: disabled ? 'default' : 'crosshair' }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      </div>
    </div>
  )
}
