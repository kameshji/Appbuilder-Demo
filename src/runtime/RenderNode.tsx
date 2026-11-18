import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { ControlNode, ControlType, FxRecord, FxValue } from '@/contracts'
import { controls } from '@/controls'
import { enumName, isTemplateType, ROOT_CTX, type Evaluator, type LayoutKind, type NodeCtx } from './evaluator'
import { evaluatorOf } from './store'
import { useAppStore, useAppStoreApi } from './context'
import { useUi } from './ui'
import { placeStyle, themeOf } from './layout'

export type RenderMode = 'design' | 'run'

const num = (v: FxValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/**
 * Size of a container's children box ([data-layout]) in design coordinates. The box may be smaller
 * than the control (Card / Dialog header), so it is measured: design box = actual box minus how much
 * the control itself grew beyond its design size.
 */
function useChildBox(ref: RefObject<HTMLDivElement | null>, designW: number, designH: number, fallback: { w: number; h: number }, enabled: boolean) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const wrap = ref.current
    if (!wrap) return
    const find = (): HTMLElement | null => {
      for (const el of wrap.querySelectorAll<HTMLElement>('[data-layout]')) if (el.closest('[data-node-id]') === wrap) return el
      return null
    }
    const measure = () => {
      const b = find()
      if (!b) {
        setBox((p) => (p === null ? p : null))
        return
      }
      const w = Math.max(0, b.clientWidth - (wrap.offsetWidth - designW))
      const h = Math.max(0, b.clientHeight - (wrap.offsetHeight - designH))
      setBox((p) => (p && Math.abs(p.w - w) < 0.5 && Math.abs(p.h - h) < 0.5 ? p : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    const b = find()
    if (b) ro.observe(b)
    return () => ro.disconnect()
  }, [ref, enabled, designW, designH])
  return enabled && box ? box : fallback
}

function getDef(type: string): ControlType | undefined {
  try {
    return controls.get(type)
  } catch {
    return undefined
  }
}

interface Props {
  node: ControlNode
  ctx: NodeCtx
  mode: RenderMode
  ev: Evaluator
  /** parent layout kind and children-box design size */
  pk: LayoutKind
  pdw: number
  pdh: number
  pai: string
}

/** One control: positioned wrapper + registry renderer. Used by the design canvas, the preview and the player. */
export const RenderNode = memo(function RenderNode({ node, ctx, mode, ev, pk, pdw, pdh, pai }: Props) {
  const store = useAppStoreApi()
  const nk = ev.nodeKey(node, ctx)
  // re-render only when something this node reads changed
  useAppStore((s) => evaluatorOf(s).versionOf(nk))
  // drag rectangles belong to the Studio canvas; a running copy of the same app (tab, preview) ignores them
  const canvas = mode === 'design' && !ctx.inert
  const rect = useUi((s) => (canvas ? s.dragRects[node.id] : undefined))
  const beingDragged = useUi((s) => canvas && s.dragging && s.dragRects[node.id] !== undefined)
  const flowGhost = useUi((s) => s.flowDragId === node.id)
  const wrapRef = useRef<HTMLDivElement>(null)
  const outKey = ev.outKey(node, ctx)
  const setOutput = useCallback((name: string, value: FxValue) => store.getState().setOutput(outKey, name, value), [store, outKey])
  const design = mode === 'design'
  const fire = useCallback(
    (event: string) => {
      if (design) return
      store.getState().fire(node.id, event, ctx)
    },
    [store, design, node.id, ctx],
  )

  const def = getDef(node.type)
  const ne = ev.evalNode(node, ctx)
  const p = ne.props
  const dw = def?.defaultSize.width ?? 100
  const dh = def?.defaultSize.height ?? 40
  const g = rect ?? { x: num(p.X, 0), y: num(p.Y, 0), w: num(p.Width, dw), h: num(p.Height, dh) }
  const isTemplate = !!def && (!!def.isTemplate || isTemplateType(node.type))
  const lay = def?.isContainer && !isTemplate ? ev.layoutOf(node, ctx) : null
  const box = useChildBox(wrapRef, g.w, g.h, { w: g.w, h: g.h }, !!lay)
  if (!def) return null

  const visible = p.Visible !== false
  const overlayRun = !!def.isOverlay && !design
  let style: CSSProperties
  if (overlayRun) {
    style = { position: 'absolute', left: 0, top: 0, width: 0, height: 0, zIndex: 200 }
  } else {
    style = placeStyle({ kind: pk, dw: pdw, dh: pdh, alignItems: pai }, g, {
      anchorH: enumName(p.AnchorH),
      anchorV: enumName(p.AnchorV),
      grow: num(p.Grow, 0),
      alignSelf: enumName(p.AlignSelf) || 'auto',
      exact: !!rect,
    })
  }
  style.pointerEvents = ctx.inert || beingDragged ? 'none' : 'auto'
  if (!visible) {
    if (design) style.opacity = 0.4
    else style.display = 'none'
  }
  if (flowGhost) style.opacity = 0.35

  let children: ReactNode = undefined
  let renderTemplate: ((item: FxRecord, index: number) => ReactNode) | undefined
  if (isTemplate) {
    const inner = ev.innerSize(node, ctx)
    renderTemplate = (item, index) => {
      const rowCtx: NodeCtx = {
        rows: [...ctx.rows, { galleryId: node.id, index, item }],
        inert: ctx.inert || (design && index > 0),
      }
      return (
        <div
          key={index}
          data-row-origin={index === 0 ? node.id : undefined}
          style={{ position: 'relative', width: '100%', height: '100%', opacity: design && index > 0 ? 0.5 : undefined }}
        >
          {node.children.map((c) => (
            <RenderNode key={c.id} node={c} ctx={rowCtx} mode={mode} ev={ev} pk="manual" pdw={inner.w} pdh={inner.h} pai="auto" />
          ))}
        </div>
      )
    }
  } else if (def.isContainer && lay) {
    children = node.children.map((c) => (
      <RenderNode key={c.id} node={c} ctx={ctx} mode={mode} ev={ev} pk={lay.kind} pdw={box.w} pdh={box.h} pai={lay.alignItems} />
    ))
  }

  const tooltip = !design && typeof p.Tooltip === 'string' && p.Tooltip ? p.Tooltip : undefined
  const errorList = Object.entries(ne.errors)
  const Render = def.render
  return (
    <div
      ref={wrapRef}
      data-testid={`control-${node.name}`}
      data-node-id={node.id}
      data-node-type={node.type}
      data-container={def.isContainer ? '1' : undefined}
      data-flow={pk !== 'manual' ? pk : undefined}
      title={tooltip}
      style={style}
    >
      <Render
        key={ev.resetKey(node.id)}
        node={node}
        props={p}
        mode={mode}
        outputs={ne.outputs}
        setOutput={setOutput}
        fire={fire}
        renderTemplate={renderTemplate}
        focusToken={design ? undefined : ev.focusKey(node.id)}
      >
        {children}
      </Render>
      {design && !ctx.inert && errorList.length > 0 && (
        <span
          title={errorList.map(([k, m]) => `${k}: ${m}`).join('\n')}
          data-error-badge="1"
          className="absolute rounded-full bg-red-500 ring-2 ring-white"
          style={{ right: 'calc(-5px * var(--inv, 1))', top: 'calc(-5px * var(--inv, 1))', width: 'calc(10px * var(--inv, 1))', height: 'calc(10px * var(--inv, 1))', zIndex: 5 }}
        />
      )}
    </div>
  )
})

/** A whole screen at `width` x `height` (actual size). */
export function ScreenView({ screenId, mode, width, height, testId = 'screen-frame' }: { screenId: string; mode: RenderMode; width: number; height: number; testId?: string }) {
  const store = useAppStoreApi()
  const ev = useAppStore((s) => evaluatorOf(s))
  const app = useAppStore((s) => s.app)
  const screen = app.screens.find((s) => s.id === screenId) ?? app.screens[0]
  useAppStore((s) => evaluatorOf(s).versionOf(screen.id))
  const wrapRef = useRef<HTMLDivElement>(null)
  const def = controls.get('Screen')
  const ne = ev.evalNode(screen, ROOT_CTX)
  const lay = ev.layoutOf(screen, ROOT_CTX)
  const box = useChildBox(wrapRef, app.width, app.height, { w: app.width, h: app.height }, true)
  const setOutput = useCallback(() => {}, [])
  const fire = useCallback(
    (event: string) => {
      if (mode === 'run') store.getState().fire(screen.id, event, ROOT_CTX)
    },
    [store, mode, screen.id],
  )

  useEffect(() => {
    if (mode === 'run') store.getState().fire(screen.id, 'OnVisible')
  }, [store, mode, screen.id])

  const theme = themeOf(app)
  const Render = def.render
  return (
    <div
      ref={wrapRef}
      data-testid={testId}
      data-node-id={screen.id}
      data-node-type="Screen"
      data-container="1"
      className={theme.className}
      style={{ ...theme.style, position: 'relative', width, height, overflow: 'hidden', isolation: 'isolate', transform: 'translateZ(0)' }}
    >
      <Render node={screen} props={ne.props} mode={mode} outputs={ne.outputs} setOutput={setOutput} fire={fire}>
        {screen.children.map((c) => (
          <RenderNode key={c.id} node={c} ctx={ROOT_CTX} mode={mode} ev={ev} pk={lay.kind} pdw={box.w} pdh={box.h} pai={lay.alignItems} />
        ))}
      </Render>
    </div>
  )
}
