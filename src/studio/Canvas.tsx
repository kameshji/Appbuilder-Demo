import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal,
  AlignStartVertical, AlignVerticalDistributeCenter, Eye, Lock, Plus,
} from 'lucide-react'
import { ScreenView } from '@/runtime/RenderNode'
import { metaMap, type LayoutKind } from '@/runtime/evaluator'
import { evaluatorOf, useStore, type AlignKind } from '@/runtime/store'
import { useUi, type Rect } from '@/runtime/ui'
import { isDescendant } from '@/runtime/util'
import { controls } from '@/controls'
import { cn } from '@/lib/utils'
import {
  HANDLES, buildTargets, containerAt, containerOrigin, flowInsertion, nodeRect, originOfOffsetParent, snapGrid, snapMove, snapResize,
  type Handle, type Targets,
} from './geo'
import type { ControlNode } from '@/contracts'
import type { Geom } from '@/runtime/evaluator'

/* ------------------------------------------------------------------ gesture state */

interface MoveGesture {
  kind: 'move'
  pointerId: number
  sx: number
  sy: number
  started: boolean
  hitId: string
  shift: boolean
  wasSelected: boolean
  ids: string[]
  start: Record<string, Geom>
  parentId: string
  sameParent: boolean
  parentOrigin: { x: number; y: number }
  targets: Targets
  /** parent-coordinate rects of the last frame */
  rects: Record<string, Rect>
  target: string | null
  lastClient: { x: number; y: number }
  alt: boolean
  /** parent lays children out automatically: the drag reorders instead of moving */
  flow: LayoutKind
  /** auto-layout drop: container + index into its children */
  flowDrop: { parentId: string; index: number } | null
  grab: { x: number; y: number }
}
interface ResizeGesture {
  kind: 'resize'
  pointerId: number
  sx: number
  sy: number
  handle: Handle
  id: string
  start: Geom
  parentOrigin: { x: number; y: number }
  targets: Targets
  started: boolean
  rect: Rect | null
  flow: boolean
}
interface MarqueeGesture { kind: 'marquee'; pointerId: number; sx: number; sy: number; fx: number; fy: number; started: boolean; screenId: string; shift: boolean }
interface PanGesture { kind: 'pan'; pointerId: number; sx: number; sy: number; px: number; py: number }
type Gesture = MoveGesture | ResizeGesture | PanGesture | MarqueeGesture

interface OverlayRects {
  sel: Record<string, Rect>
  hover: Rect | null
  drop: Rect | null
}

const sameRect = (a: Rect | undefined | null, b: Rect | undefined | null) =>
  a === b || (!!a && !!b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01)

function sameOverlay(a: OverlayRects, b: OverlayRects) {
  if (!sameRect(a.hover, b.hover) || !sameRect(a.drop, b.drop)) return false
  const ka = Object.keys(a.sel)
  if (ka.length !== Object.keys(b.sel).length) return false
  return ka.every((k) => sameRect(a.sel[k], b.sel[k]))
}

const unionRect = (rs: Rect[]): Rect => {
  const x1 = Math.min(...rs.map((r) => r.x))
  const y1 = Math.min(...rs.map((r) => r.y))
  const x2 = Math.max(...rs.map((r) => r.x + r.w))
  const y2 = Math.max(...rs.map((r) => r.y + r.h))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

const round1 = (n: number) => Math.round(n * 10) / 10

/* ------------------------------------------------------------------ component */

export function Canvas() {
  const app = useStore((s) => s.app)
  const mode = useStore((s) => s.mode)
  const selection = useStore((s) => s.selection)
  const currentScreenId = useStore((s) => s.currentScreenId)
  const epoch = useStore((s) => s.epoch)
  const zoom = useUi((s) => s.zoom)
  const pan = useUi((s) => s.pan)
  const guides = useUi((s) => s.guides)
  const dragRects = useUi((s) => s.dragRects)
  const dragging = useUi((s) => s.dragging)
  const hoverId = useUi((s) => s.hoverId)
  const dropTargetId = useUi((s) => s.dropTargetId)
  const spaceDown = useUi((s) => s.spaceDown)
  const fitEpoch = useUi((s) => s.fitEpoch)
  const vp = useUi((s) => s.viewport)
  const viewSize = useUi((s) => s.viewSize)
  const flowLine = useUi((s) => s.flowLine)
  const flowGhost = useUi((s) => s.flowGhost)
  const marquee = useUi((s) => s.marquee)
  const locked = useUi((s) => s.locked)

  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [ov, setOv] = useState<OverlayRects>({ sel: {}, hover: null, drop: null })
  const [panning, setPanning] = useState(false)

  const screen = app.screens.find((s) => s.id === currentScreenId) ?? app.screens[0]
  const frameW = viewSize?.w ?? app.width
  const frameH = viewSize?.h ?? app.height
  const readOnly = !!viewSize && (viewSize.w !== app.width || viewSize.h !== app.height)

  /* ---- publish the canvas size as App.Width / App.Height while designing */
  useEffect(() => {
    if (mode === 'design') useStore.getState().setEnv(frameW, frameH)
  }, [mode, frameW, frameH])

  /* ---- viewport size + initial fit */
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      useUi.getState().setViewport(r.width, r.height)
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    useUi.getState().setViewport(r.width, r.height)
    return () => ro.disconnect()
  }, [])

  const fitted = useRef(-1)
  useEffect(() => {
    const key = epoch * 100000 + fitEpoch
    if (vp.w < 50 || fitted.current === key) return
    fitted.current = key
    const a = useStore.getState().app
    const v = useUi.getState().viewSize
    useUi.getState().fit(v?.w ?? a.width, v?.h ?? a.height)
  }, [vp.w, vp.h, epoch, fitEpoch])

  /* ---- wheel: pan, ctrl/cmd+wheel: zoom */
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const ui = useUi.getState()
      const scale = e.deltaMode === 1 ? 16 : 1
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect()
        ui.zoomBy(Math.exp(-e.deltaY * scale * 0.0022), e.clientX - r.left, e.clientY - r.top)
      } else {
        ui.setPan(ui.pan.x - e.deltaX * scale, ui.pan.y - e.deltaY * scale)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  /* ---- measure overlay rectangles from the DOM after every render */
  useLayoutEffect(() => {
    const world = worldRef.current
    const frame = world?.querySelector<HTMLElement>('[data-testid="screen-frame"]')
    if (!frame) {
      setOv((p) => (Object.keys(p.sel).length || p.hover || p.drop ? { sel: {}, hover: null, drop: null } : p))
      return
    }
    const fr = frame.getBoundingClientRect()
    const measure = (id: string | null): Rect | null => {
      if (!id) return null
      const el = id === screen.id ? frame : frame.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: (r.left - fr.left) / zoom, y: (r.top - fr.top) / zoom, w: r.width / zoom, h: r.height / zoom }
    }
    const sel: Record<string, Rect> = {}
    for (const id of selection) {
      const r = measure(id)
      if (r) sel[id] = r
    }
    const next: OverlayRects = {
      sel,
      hover: hoverId && !selection.includes(hoverId) && !dragging ? measure(hoverId) : null,
      drop: dropTargetId ? measure(dropTargetId) : null,
    }
    setOv((prev) => (sameOverlay(prev, next) ? prev : next))
  })

  /* ---------------------------------------------------------------- gestures */

  const releaseGesture = () => {
    gesture.current = null
    useUi.getState().clearDrag()
    setPanning(false)
  }

  const cancelGesture = () => {
    if (!gesture.current) return false
    releaseGesture()
    return true
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gesture.current) {
        e.stopPropagation()
        cancelGesture()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const layoutKindOf = (id: string): LayoutKind => {
    const st = useStore.getState()
    const ev = evaluatorOf(st)
    const n = ev.byId.get(id)?.node
    if (!n) return 'manual'
    try {
      if (controls.get(n.type).isTemplate || n.type === 'Gallery') return 'manual'
    } catch {
      return 'manual'
    }
    return ev.layoutOf(n, ev.designCtx(n)).kind
  }

  const initMove = (g: MoveGesture) => {
    const st = useStore.getState()
    const ev = evaluatorOf(st)
    const infos = g.ids.map((id) => ev.byId.get(id)!)
    const first = infos[0]
    const parent = first.parent
    if (!parent) return false
    g.sameParent = infos.every((i) => i.parent?.id === parent.id)
    g.parentId = parent.id
    g.flow = layoutKindOf(parent.id)
    if (g.flow !== 'manual' && g.ids.length > 1) return false
    const hitEl = document.querySelector<HTMLElement>(`[data-testid="screen-frame"] [data-node-id="${g.ids.includes(g.hitId) ? g.hitId : g.ids[0]}"]`)
    g.parentOrigin = originOfOffsetParent(hitEl, useUi.getState().zoom)
    if (g.flow === 'manual' && g.sameParent) {
      const sibs = parent.children.filter((c) => !g.ids.includes(c.id)).map((c) => ev.geom(c, ev.designCtx(c)))
      const inner = ev.innerSize(parent)
      g.targets = buildTargets(sibs, inner.w, inner.h)
    }
    if (g.flow !== 'manual') {
      const r = nodeRect(g.ids[0], useUi.getState().zoom)
      const pt = clientToFrameLocal(g.sx, g.sy)
      if (r && pt) g.grab = { x: pt.x - r.x, y: pt.y - r.y }
      useUi.setState({ flowDragId: g.ids[0] })
    }
    return true
  }

  const clientToFrameLocal = (cx: number, cy: number) => {
    const f = worldRef.current?.querySelector<HTMLElement>('[data-testid="screen-frame"]')
    if (!f) return null
    const r = f.getBoundingClientRect()
    const z = useUi.getState().zoom
    return { x: (cx - r.left) / z, y: (cy - r.top) / z }
  }

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (useStore.getState().mode !== 'design') return
    const t = e.target as HTMLElement
    if (t.closest('[data-chrome]')) return
    const ui = useUi.getState()
    const vpEl = viewportRef.current!
    if (e.button === 1 || (e.button === 0 && ui.spaceDown)) {
      e.preventDefault()
      vpEl.setPointerCapture(e.pointerId)
      gesture.current = { kind: 'pan', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, px: ui.pan.x, py: ui.pan.y }
      setPanning(true)
      return
    }
    if (e.button !== 0) return
    const st = useStore.getState()
    const ev = evaluatorOf(st)

    const handleEl = t.closest<HTMLElement>('[data-handle]')
    if (handleEl && st.selection.length === 1 && !readOnly) {
      const id = st.selection[0]
      const info = ev.byId.get(id)
      if (!info?.parent || ui.locked.includes(id)) return
      vpEl.setPointerCapture(e.pointerId)
      const node = info.node
      const flow = layoutKindOf(info.parent.id) !== 'manual'
      const sibs = flow ? [] : info.parent.children.filter((c) => c.id !== id).map((c) => ev.geom(c, ev.designCtx(c)))
      const inner = ev.innerSize(info.parent)
      const el = document.querySelector<HTMLElement>(`[data-testid="screen-frame"] [data-node-id="${id}"]`)
      gesture.current = {
        kind: 'resize',
        pointerId: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        handle: handleEl.getAttribute('data-handle') as Handle,
        id,
        start: ev.geom(node, ev.designCtx(node)),
        parentOrigin: originOfOffsetParent(el, ui.zoom),
        targets: flow ? { xs: [], ys: [] } : buildTargets(sibs, inner.w, inner.h),
        started: false,
        rect: null,
        flow,
      }
      e.preventDefault()
      return
    }

    const hitEl = t.closest<HTMLElement>('[data-node-id]')
    const hitId = hitEl?.getAttribute('data-node-id') ?? screen.id
    const isScreen = ev.byId.get(hitId)?.node.type === 'Screen'
    const wasSelected = st.selection.includes(hitId)
    if (isScreen && !readOnly) {
      // empty screen: click selects the screen, drag draws a marquee
      vpEl.setPointerCapture(e.pointerId)
      const pt = clientToFrameLocal(e.clientX, e.clientY)
      gesture.current = { kind: 'marquee', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, fx: pt?.x ?? 0, fy: pt?.y ?? 0, started: false, screenId: screen.id, shift: e.shiftKey }
      if (!e.shiftKey) st.select([hitId])
      return
    }
    if (e.shiftKey && !isScreen && !st.selection.some((id) => ev.byId.get(id)?.node.type === 'Screen')) {
      st.select(wasSelected ? st.selection.filter((i) => i !== hitId) : [...st.selection, hitId])
      if (wasSelected) return
    } else if (!wasSelected || isScreen) {
      st.select([hitId])
    }
    if (isScreen) return
    const sel = useStore.getState().selection.filter((id) => ev.byId.get(id) && ev.byId.get(id)!.node.type !== 'Screen')
    if (!sel.length) return
    vpEl.setPointerCapture(e.pointerId)
    const start: Record<string, Geom> = {}
    for (const id of sel) {
      const n = ev.byId.get(id)!.node
      start[id] = ev.geom(n, ev.designCtx(n))
    }
    gesture.current = {
      kind: 'move',
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      started: false,
      hitId,
      shift: e.shiftKey,
      wasSelected,
      ids: sel,
      start,
      parentId: '',
      sameParent: true,
      parentOrigin: { x: 0, y: 0 },
      targets: { xs: [], ys: [] },
      rects: {},
      target: null,
      lastClient: { x: e.clientX, y: e.clientY },
      alt: e.altKey,
      flow: 'manual',
      flowDrop: null,
      grab: { x: 0, y: 0 },
    }
  }

  /** auto-layout drop position for the dragged control at the pointer, if the container under it flows */
  const flowDropAt = (g: MoveGesture, cx: number, cy: number, hit: string | null) => {
    const st = useStore.getState()
    const ev = evaluatorOf(st)
    const containerId = hit ?? g.parentId
    const kind = layoutKindOf(containerId)
    if (kind === 'manual') return null
    const container = ev.byId.get(containerId)?.node
    if (!container) return null
    const ids = container.children.filter((c) => c.id !== g.ids[0]).map((c) => c.id)
    const pt = clientToFrameLocal(cx, cy)
    if (!pt) return null
    const r = flowInsertion(kind, containerId, ids, pt.x, pt.y, useUi.getState().zoom)
    const index = r.index < ids.length ? container.children.findIndex((c) => c.id === ids[r.index]) : container.children.length
    return { parentId: containerId, index, line: r.line }
  }

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    const ui = useUi.getState()
    if (!g) {
      if (useStore.getState().mode !== 'design' || ui.spaceDown) return
      const id = (e.target as HTMLElement).closest?.('[data-node-id]')?.getAttribute('data-node-id') ?? null
      if (id !== ui.hoverId) useUi.setState({ hoverId: id })
      return
    }
    if (g.pointerId !== e.pointerId) return
    const z = ui.zoom
    if (g.kind === 'pan') {
      ui.setPan(g.px + (e.clientX - g.sx), g.py + (e.clientY - g.sy))
      return
    }
    if (g.kind === 'marquee') {
      if (!g.started && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return
      g.started = true
      const pt = clientToFrameLocal(e.clientX, e.clientY)
      if (!pt) return
      useUi.setState({ marquee: { x: Math.min(g.fx, pt.x), y: Math.min(g.fy, pt.y), w: Math.abs(pt.x - g.fx), h: Math.abs(pt.y - g.fy) } })
      return
    }
    const thr = Math.max(1, 5 / z)
    if (g.kind === 'move') {
      if (!g.started) {
        if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return
        if (readOnly || g.ids.some((id) => ui.locked.includes(id))) {
          gesture.current = null
          return
        }
        if (!initMove(g)) {
          gesture.current = null
          return
        }
        g.started = true
      }
      g.lastClient = { x: e.clientX, y: e.clientY }
      g.alt = e.altKey
      const st = useStore.getState()
      const ev = evaluatorOf(st)
      // container under the pointer (single control only)
      let hit: string | null = null
      if (g.ids.length === 1) {
        const dragged = ev.byId.get(g.ids[0])!.node
        hit = containerAt(e.clientX, e.clientY, (id) => id === dragged.id || isDescendant(dragged, id))
      }
      const flowTarget = g.ids.length === 1 ? flowDropAt(g, e.clientX, e.clientY, hit) : null
      if (g.flow !== 'manual') {
        // a flow child: show a ghost + insertion line, or drop into a manual container
        const pt = clientToFrameLocal(e.clientX, e.clientY)
        const s0 = g.start[g.ids[0]]
        const r0 = nodeRect(g.ids[0], z)
        const ghost = pt ? { x: pt.x - g.grab.x, y: pt.y - g.grab.y, w: r0?.w ?? s0.w, h: r0?.h ?? s0.h } : null
        g.flowDrop = flowTarget ? { parentId: flowTarget.parentId, index: flowTarget.index } : null
        g.target = !flowTarget && hit && hit !== g.parentId ? hit : null
        if (!flowTarget && !g.target && hit === g.parentId) g.target = null
        useUi.setState({
          flowGhost: ghost,
          flowLine: flowTarget?.line ?? null,
          dragging: true,
          dropTargetId: flowTarget && flowTarget.parentId !== g.parentId ? flowTarget.parentId : g.target,
        })
        return
      }
      const dx = (e.clientX - g.sx) / z
      const dy = (e.clientY - g.sy) / z
      const boxes = g.ids.map((id) => g.start[id])
      const bb = unionRect(boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })))
      const moved = { x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h }
      let box = moved
      let gl: ReturnType<typeof snapMove>['guides'] = []
      if (g.sameParent) {
        const r = snapMove(moved, { targets: g.targets, thr, free: e.altKey, origin: g.parentOrigin })
        box = r.box
        gl = r.guides
      }
      const ox = box.x - bb.x
      const oy = box.y - bb.y
      const rects: Record<string, Rect> = {}
      for (const id of g.ids) rects[id] = { x: g.start[id].x + ox, y: g.start[id].y + oy, w: g.start[id].w, h: g.start[id].h }
      g.rects = rects
      g.flowDrop = flowTarget && flowTarget.parentId !== g.parentId ? { parentId: flowTarget.parentId, index: flowTarget.index } : null
      g.target = !g.flowDrop && hit && hit !== g.parentId ? hit : null
      useUi.setState({
        dragRects: rects,
        dragging: true,
        guides: g.target || g.flowDrop ? [] : gl,
        dropTargetId: g.flowDrop?.parentId ?? g.target,
        flowLine: g.flowDrop ? (flowTarget?.line ?? null) : null,
      })
      return
    }
    // resize
    if (!g.started) {
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 2) return
      g.started = true
    }
    const dx = (e.clientX - g.sx) / z
    const dy = (e.clientY - g.sy) / z
    const r = snapResize(g.start, g.handle, dx, dy, { targets: g.targets, thr, free: e.altKey, origin: g.parentOrigin }, e.shiftKey)
    g.rect = r.box
    useUi.setState({ dragRects: { [g.id]: r.box }, dragging: true, guides: g.flow ? [] : r.guides })
  }

  const runAltClick = (id: string) => {
    const st = useStore.getState()
    const ev = evaluatorOf(st)
    const node = ev.byId.get(id)?.node
    if (!node) return
    const metas = metaMap(node.type)
    let prim = ''
    try {
      prim = controls.get(node.type).primaryProp
    } catch {
      /* ignore */
    }
    const actions = [...metas.values()].filter((m) => m.kind === 'action')
    const ev0 = actions.find((m) => m.name === prim) ?? actions.find((m) => m.name === 'OnSelect') ?? actions[0]
    if (!ev0) {
      st.notify(`${node.name} has no event to run`, 'info')
      return
    }
    st.fire(node.id, ev0.name, ev.designCtx(node), { allowInDesign: true })
    st.notify(`Ran ${node.name}.${ev0.name}`, 'info')
  }

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.pointerId !== e.pointerId) return
    const vpEl = viewportRef.current
    if (vpEl?.hasPointerCapture(e.pointerId)) vpEl.releasePointerCapture(e.pointerId)
    const st = useStore.getState()
    if (g.kind === 'marquee') {
      const m = useUi.getState().marquee
      if (g.started && m) {
        const z = useUi.getState().zoom
        const scr = st.app.screens.find((s) => s.id === g.screenId)
        const hits = (scr?.children ?? [])
          .filter((c) => {
            const r = nodeRect(c.id, z)
            return r && r.x < m.x + m.w && r.x + r.w > m.x && r.y < m.y + m.h && r.y + r.h > m.y
          })
          .map((c) => c.id)
        const base = g.shift ? st.selection.filter((id) => id !== g.screenId) : []
        const next = [...new Set([...base, ...hits])]
        st.select(next.length ? next : [g.screenId])
      }
    } else if (g.kind === 'move') {
      if (!g.started) {
        if (g.alt) runAltClick(g.hitId)
        else if (g.wasSelected && !g.shift && st.selection.length > 1) st.select([g.hitId])
      } else if (g.flowDrop) {
        const id = g.ids[0]
        st.moveNode(id, g.flowDrop.parentId, g.flowDrop.index)
      } else if (g.ids.length === 1 && g.target) {
        const id = g.ids[0]
        const z = useUi.getState().zoom
        const origin = containerOrigin(g.target, z)
        let x: number
        let y: number
        if (g.flow !== 'manual') {
          const ghost = useUi.getState().flowGhost
          x = (ghost?.x ?? 0) - origin.x
          y = (ghost?.y ?? 0) - origin.y
        } else {
          const r = g.rects[id]
          x = g.parentOrigin.x + r.x - origin.x
          y = g.parentOrigin.y + r.y - origin.y
        }
        if (!g.alt) {
          x = snapGrid(x)
          y = snapGrid(y)
        }
        st.reparent(id, g.target, Math.max(0, x), Math.max(0, y))
      } else if (g.flow === 'manual') {
        st.setGeometry(g.ids.map((id) => ({ id, x: g.rects[id].x, y: g.rects[id].y })))
      }
    } else if (g.kind === 'resize' && g.started && g.rect) {
      if (g.flow) st.setGeometry([{ id: g.id, w: g.rect.w, h: g.rect.h }])
      else st.setGeometry([{ id: g.id, x: g.rect.x, y: g.rect.y, w: g.rect.w, h: g.rect.h }])
    }
    releaseGesture()
  }

  const onPointerCancel = () => releaseGesture()

  const onDoubleClick = (e: React.MouseEvent) => {
    // double-click on a control selects its primary property in the formula bar
    const id = (e.target as HTMLElement).closest?.('[data-node-id]')?.getAttribute('data-node-id')
    if (!id) return
    const st = useStore.getState()
    const n = evaluatorOf(st).byId.get(id)?.node
    if (n && n.type !== 'Screen') document.querySelector<HTMLElement>('[data-testid="formula-input"]')?.focus()
  }

  /* ---------------------------------------------------------------- render */

  const inv = 1 / zoom
  const worldStyle: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transformOrigin: '0 0',
    ['--inv' as string]: String(inv),
    willChange: 'transform',
  }
  const cursor = panning ? 'grabbing' : spaceDown ? 'grab' : undefined
  const single = selection.length === 1 && selection[0] !== screen.id ? selection[0] : null
  const singleLocked = !!single && locked.includes(single)
  const handleSize = 8 * inv
  const live = (id: string): Rect | undefined => ov.sel[id]

  return (
    <div
      ref={viewportRef}
      data-testid="canvas"
      data-canvas-viewport="1"
      data-readonly={readOnly ? '1' : undefined}
      className="relative size-full select-none overflow-hidden bg-canvas"
      style={{
        cursor,
        touchAction: 'none',
        backgroundImage: 'radial-gradient(circle, color-mix(in oklab, var(--foreground) 17%, transparent) 1px, transparent 1.2px)',
        backgroundSize: `${16 * zoom}px ${16 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => useUi.getState().hoverId && useUi.setState({ hoverId: null })}
      onDoubleClick={onDoubleClick}
    >
      <div ref={worldRef} style={worldStyle}>
        {mode === 'design' && (
          <>
            <div className="absolute whitespace-nowrap font-medium text-muted-foreground" style={{ left: 0, top: -22 * inv, fontSize: 11 * inv }}>
              {screen.name}{' '}
              <span className="opacity-60">
                · {frameW} × {frameH}
                {readOnly ? ` (design ${app.width} × ${app.height})` : ''}
              </span>
            </div>
            <div
              style={{ boxShadow: '0 0 0 1px var(--border), 0 12px 40px -8px rgb(0 0 0 / 0.18), 0 2px 6px rgb(0 0 0 / 0.06)' }}
              className="rounded-[2px]"
            >
              <ScreenView screenId={screen.id} mode="design" width={frameW} height={frameH} />
            </div>

            {/* overlay: selection, hover, drop target, guides (frame coordinates) */}
            <div className="pointer-events-none absolute left-0 top-0" style={{ width: frameW, height: frameH }}>
              {ov.drop && (
                <div
                  className="absolute rounded-[2px] bg-primary/10"
                  style={{ left: ov.drop.x, top: ov.drop.y, width: ov.drop.w, height: ov.drop.h, outline: `${2 * inv}px dashed var(--primary)`, outlineOffset: -1 * inv }}
                />
              )}
              {ov.hover && (
                <div
                  className="absolute"
                  style={{ left: ov.hover.x, top: ov.hover.y, width: ov.hover.w, height: ov.hover.h, outline: `${1 * inv}px solid color-mix(in oklab, var(--primary) 55%, transparent)` }}
                />
              )}
              {selection.map((id) => {
                const r = live(id)
                if (!r) return null
                const isScreen = id === screen.id
                if (isScreen) {
                  return (
                    <div
                      key={id}
                      className="absolute"
                      style={{ left: 0, top: 0, width: r.w, height: r.h, outline: `${1.5 * inv}px solid var(--primary)`, outlineOffset: -1.5 * inv }}
                    />
                  )
                }
                return (
                  <div key={id} className="absolute" style={{ left: r.x, top: r.y, width: r.w, height: r.h, outline: `${1.5 * inv}px solid var(--primary)` }}>
                    {selection.length === 1 && <NameTag id={id} inv={inv} locked={locked.includes(id)} />}
                  </div>
                )
              })}
              {selection.length > 1 &&
                (() => {
                  const rs = selection.map(live).filter((r): r is Rect => !!r)
                  if (rs.length < 2) return null
                  const u = unionRect(rs)
                  return <div className="absolute" style={{ left: u.x, top: u.y, width: u.w, height: u.h, outline: `${1 * inv}px dashed var(--primary)`, outlineOffset: 3 * inv }} />
                })()}
              {single &&
                !readOnly &&
                !singleLocked &&
                live(single) &&
                (() => {
                  const r = live(single)!
                  return (
                    <>
                      {HANDLES.map((h) => (
                        <div
                          key={h.h}
                          data-handle={h.h}
                          className="pointer-events-auto absolute bg-white"
                          style={{
                            left: r.x + r.w * h.cx - handleSize / 2,
                            top: r.y + r.h * h.cy - handleSize / 2,
                            width: handleSize,
                            height: handleSize,
                            border: `${1.5 * inv}px solid var(--primary)`,
                            borderRadius: 1.5 * inv,
                            cursor: h.cursor,
                            zIndex: 3,
                          }}
                        />
                      ))}
                      {dragging && dragRects[single] && (
                        <div
                          className="absolute whitespace-nowrap rounded bg-primary font-medium text-primary-foreground"
                          style={{
                            left: r.x + r.w / 2,
                            top: r.y + r.h + 8 * inv,
                            transform: 'translateX(-50%)',
                            fontSize: 10.5 * inv,
                            padding: `${2 * inv}px ${6 * inv}px`,
                            zIndex: 4,
                          }}
                        >
                          {round1(dragRects[single].w)} × {round1(dragRects[single].h)} · {round1(dragRects[single].x)}, {round1(dragRects[single].y)}
                        </div>
                      )}
                    </>
                  )
                })()}
              {guides.map((g, i) => (
                <div
                  key={i}
                  className="absolute"
                  style={
                    g.axis === 'x'
                      ? { left: g.pos - 0.5 * inv, top: g.from, width: 1 * inv, height: Math.max(0, g.to - g.from), background: '#f43f5e' }
                      : { top: g.pos - 0.5 * inv, left: g.from, height: 1 * inv, width: Math.max(0, g.to - g.from), background: '#f43f5e' }
                  }
                />
              ))}
              {flowGhost && (
                <div
                  className="absolute rounded-[3px] bg-primary/10"
                  style={{ left: flowGhost.x, top: flowGhost.y, width: flowGhost.w, height: flowGhost.h, outline: `${1.5 * inv}px dashed var(--primary)` }}
                />
              )}
              {flowLine && (
                <div
                  data-testid="flow-indicator"
                  className="absolute rounded-full bg-primary"
                  style={{ left: flowLine.x, top: flowLine.y, width: Math.max(flowLine.w, 3 * inv), height: Math.max(flowLine.h, 3 * inv) }}
                />
              )}
              {marquee && (
                <div
                  data-testid="marquee"
                  className="absolute bg-primary/10"
                  style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, outline: `${1 * inv}px solid var(--primary)` }}
                />
              )}
            </div>
          </>
        )}
      </div>

      {readOnly && mode === 'design' && (
        <div data-chrome="1" data-testid="viewport-banner" className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-500/40 bg-amber-50 px-3 py-1 text-xs text-amber-900 shadow-sm dark:bg-amber-950 dark:text-amber-100">
          <Eye className="size-3.5" />
          Viewing at {frameW}×{frameH}. Switch to design size to edit.
          <button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={() => { useUi.setState({ viewSize: null }); useUi.getState().requestFit() }}>
            Design size
          </button>
        </div>
      )}
      {!readOnly && mode === 'design' && selection.length > 1 && <AlignToolbar ids={selection} />}

      {/* screen tabs */}
      <div data-chrome="1" className="absolute bottom-3 left-3 flex max-w-[60%] items-center gap-1 overflow-x-auto rounded-lg border border-border bg-card/90 p-1 shadow-sm backdrop-blur">
        {app.screens.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => useStore.getState().setCurrentScreen(s.id)}
            className={cn(
              'h-6 shrink-0 rounded-md px-2.5 text-xs font-medium transition-colors',
              s.id === screen.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {s.name}
          </button>
        ))}
        <button
          type="button"
          title="New screen"
          onClick={() => useStore.getState().addScreen()}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

const ALIGN: Array<{ k: AlignKind; label: string; Icon: typeof AlignStartVertical; min?: number }> = [
  { k: 'left', label: 'Align left', Icon: AlignStartVertical },
  { k: 'hcenter', label: 'Align centres horizontally', Icon: AlignCenterVertical },
  { k: 'right', label: 'Align right', Icon: AlignEndVertical },
  { k: 'top', label: 'Align top', Icon: AlignStartHorizontal },
  { k: 'vcenter', label: 'Align middles', Icon: AlignCenterHorizontal },
  { k: 'bottom', label: 'Align bottom', Icon: AlignEndHorizontal },
  { k: 'hdist', label: 'Distribute horizontally', Icon: AlignHorizontalDistributeCenter, min: 3 },
  { k: 'vdist', label: 'Distribute vertically', Icon: AlignVerticalDistributeCenter, min: 3 },
]

function AlignToolbar({ ids }: { ids: string[] }) {
  const screens = useStore((s) => s.app.screens)
  const real = ids.filter((id) => !screens.some((x) => x.id === id))
  if (real.length < 2) return null
  return (
    <div data-chrome="1" data-testid="align-toolbar" className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-card/95 p-1 shadow-md backdrop-blur">
      <span className="px-1.5 text-[11px] text-muted-foreground">{real.length} selected</span>
      {ALIGN.map(({ k, label, Icon, min }) => (
        <button
          key={k}
          type="button"
          title={label}
          data-testid={`align-${k}`}
          disabled={real.length < (min ?? 2)}
          onClick={() => useStore.getState().align(real, k)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  )
}

function NameTag({ id, inv, locked }: { id: string; inv: number; locked?: boolean }) {
  const name = useStore((s) => {
    let found = ''
    const visit = (nodes: ControlNode[]) => {
      for (const n of nodes) {
        if (n.id === id) found = n.name
        if (!found) visit(n.children)
      }
    }
    visit(s.app.screens)
    return found
  })
  return (
    <div
      className="absolute left-0 whitespace-nowrap rounded-sm bg-primary font-medium leading-none text-primary-foreground"
      style={{ bottom: '100%', marginBottom: 3 * inv, fontSize: 10.5 * inv, padding: `${3 * inv}px ${6 * inv}px` }}
    >
      {locked && <Lock className="mr-1 inline" style={{ width: 9 * inv, height: 9 * inv }} />}
      {name}
    </div>
  )
}

