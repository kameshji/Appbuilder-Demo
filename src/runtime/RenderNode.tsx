import { useCallback, useEffect, type CSSProperties, type ReactNode } from 'react'
import type { ControlNode, FxRecord, FxValue } from '@/contracts'
import { controls } from '@/controls'
import { getEvaluator, ROOT_CTX, type Evaluator, type NodeCtx } from './evaluator'
import { useStore } from './store'
import { useUi } from './ui'

export type RenderMode = 'design' | 'run'

interface Props { node: ControlNode; ctx: NodeCtx; mode: RenderMode; ev: Evaluator }

const num = (v: FxValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** One control: positioned wrapper + registry renderer. Used by the design canvas and the preview. */
export function RenderNode({ node, ctx, mode, ev }: Props) {
  const rect = useUi((s) => s.dragRects[node.id])
  const beingDragged = useUi((s) => s.dragging && s.dragRects[node.id] !== undefined)
  const outKey = ev.outKey(node, ctx)
  const setOutput = useCallback(
    (name: string, value: FxValue) => useStore.getState().setOutput(outKey, name, value),
    [outKey],
  )

  let def
  try {
    def = controls.get(node.type)
  } catch {
    return null
  }
  const design = mode === 'design'
  const ne = ev.evalNode(node, ctx)
  const p = ne.props
  const x = rect?.x ?? num(p.X, 0)
  const y = rect?.y ?? num(p.Y, 0)
  const w = rect?.w ?? num(p.Width, def.defaultSize.width)
  const h = rect?.h ?? num(p.Height, def.defaultSize.height)
  const visible = p.Visible !== false
  const errorList = Object.entries(ne.errors)

  const fire = (event: string) => {
    if (design) return
    useStore.getState().fire(node.id, event, ctx)
  }

  const style: CSSProperties = {
    position: 'absolute',
    left: x,
    top: y,
    width: w,
    height: h,
    pointerEvents: ctx.inert || beingDragged ? 'none' : 'auto',
  }
  if (!visible) {
    if (design) style.opacity = 0.4
    else style.display = 'none'
  }

  const isGallery = node.type === 'Gallery'
  let children: ReactNode = undefined
  let renderTemplate: ((item: FxRecord, index: number) => ReactNode) | undefined
  if (isGallery) {
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
            <RenderNode key={c.id} node={c} ctx={rowCtx} mode={mode} ev={ev} />
          ))}
        </div>
      )
    }
  } else if (def.isContainer) {
    children = node.children.map((c) => <RenderNode key={c.id} node={c} ctx={ctx} mode={mode} ev={ev} />)
  }

  const Render = def.render
  return (
    <div
      data-testid={`control-${node.name}`}
      data-node-id={node.id}
      data-node-type={node.type}
      data-container={def.isContainer ? '1' : undefined}
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
}

/** A whole screen at design size. Subscribes to the store so every runtime change re-renders it. */
export function ScreenView({ screenId, mode, testId = 'screen-frame' }: { screenId: string; mode: RenderMode; testId?: string }) {
  const app = useStore((s) => s.app)
  const rt = useStore((s) => s.runtime)
  const ev = getEvaluator(app, rt)
  const screen = app.screens.find((s) => s.id === screenId) ?? app.screens[0]
  const def = controls.get('Screen')
  const ne = ev.evalNode(screen, ROOT_CTX)
  const noop = useCallback(() => {}, [])
  const setOutput = useCallback(() => {}, [])

  useEffect(() => {
    if (mode === 'run') useStore.getState().fire(screen.id, 'OnVisible')
  }, [mode, screen.id])

  const Render = def.render
  return (
    <div
      data-testid={testId}
      data-node-id={screen.id}
      data-node-type="Screen"
      data-container="1"
      style={{ position: 'relative', width: app.width, height: app.height, overflow: 'hidden', isolation: 'isolate' }}
    >
      <Render node={screen} props={ne.props} mode={mode} outputs={ne.outputs} setOutput={setOutput} fire={noop}>
        {screen.children.map((c) => (
          <RenderNode key={c.id} node={c} ctx={ROOT_CTX} mode={mode} ev={ev} />
        ))}
      </Render>
    </div>
  )
}
