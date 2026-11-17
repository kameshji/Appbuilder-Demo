import type { AppDef, ControlNode, FxDiagnostic, FxRecord, FxScope, FxValue, PropMeta } from '@/contracts'
import { fx } from '@/fx'
import { controls } from '@/controls'
import { isRecord, walk } from './util'

export interface RuntimeView {
  vars: Record<string, FxValue>
  context: Record<string, FxValue>
  collections: Record<string, FxRecord[]>
  outputs: Record<string, Record<string, FxValue>>
  resetKeys: Record<string, number>
}

export interface RowCtx { galleryId: string; index: number; item: FxRecord }
export interface NodeCtx { rows: RowCtx[]; inert?: boolean }
export const ROOT_CTX: NodeCtx = { rows: [] }

export interface PropEval { value: FxValue; error?: string; diag?: FxDiagnostic }
export interface NodeEval { props: Record<string, FxValue>; errors: Record<string, string>; outputs: Record<string, FxValue> }
export interface NodeInfo { node: ControlNode; parent: ControlNode | null; screen: ControlNode; galleries: string[] }
export interface Geom { x: number; y: number; w: number; h: number }

const metaCache = new Map<string, Map<string, PropMeta>>()
function metaMap(type: string): Map<string, PropMeta> {
  let m = metaCache.get(type)
  if (!m) {
    m = new Map()
    try {
      for (const p of controls.propsOf(type)) m.set(p.name, p)
    } catch {
      /* unknown type */
    }
    metaCache.set(type, m)
  }
  return m
}

const num = (v: FxValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const rowKey = (rows: RowCtx[]) => rows.map((r) => r.index).join('.')

export class Evaluator {
  readonly byId = new Map<string, NodeInfo>()
  readonly byName = new Map<string, NodeInfo>()
  readonly screensByName = new Map<string, ControlNode>()
  private cache = new Map<string, PropEval>()
  private nodeCache = new Map<string, NodeEval>()
  private recCache = new Map<string, FxRecord>()
  private stack: string[] = []
  private cyclic = new Set<string>()

  constructor(readonly app: AppDef, readonly rt: RuntimeView) {
    const gal: Record<string, string[]> = {}
    walk(app.screens, (n, parent, screen) => {
      const galleries = parent ? [...(gal[parent.id] ?? []), ...(parent.type === 'Gallery' ? [parent.id] : [])] : []
      gal[n.id] = galleries
      const info = { node: n, parent, screen, galleries }
      this.byId.set(n.id, info)
      if (!this.byName.has(n.name)) this.byName.set(n.name, info)
      if (n.type === 'Screen') this.screensByName.set(n.name, n)
    })
  }

  invalidate() {
    this.cache.clear()
    this.nodeCache.clear()
    this.recCache.clear()
  }

  /* ---------------------------------------------------------------- contexts */

  /** Context to evaluate `node` in when editing (first row of every ancestor gallery). */
  designCtx(node: ControlNode): NodeCtx {
    const info = this.byId.get(node.id)
    const rows: RowCtx[] = []
    if (info) {
      for (const gid of info.galleries) {
        const g = this.byId.get(gid)!.node
        const items = this.evalProp(g, 'Items', { rows: [...rows] }).value
        const first = Array.isArray(items) && items.length ? items[0] : {}
        rows.push({ galleryId: gid, index: 0, item: isRecord(first) ? first : { Value: first } })
      }
    }
    return { rows }
  }

  private ctxFor(target: NodeInfo, ctx: NodeCtx): NodeCtx {
    if (!target.galleries.length) return ROOT_CTX
    return { rows: ctx.rows.filter((r) => target.galleries.includes(r.galleryId)) }
  }

  outKey(node: ControlNode, ctx: NodeCtx): string {
    const info = this.byId.get(node.id)
    const rows = info ? this.ctxFor(info, ctx).rows : []
    const k = rowKey(rows)
    return k ? `${node.id}#${k}` : node.id
  }

  resetKey(id: string): number {
    return this.rt.resetKeys[id] ?? 0
  }

  /* ---------------------------------------------------------------- evaluation */

  private defaultValue(node: ControlNode, meta: PropMeta | undefined, ctx: NodeCtx): FxValue {
    if (!meta) return null
    try {
      const r = fx.evaluate(meta.default, this.scopeFor(node, ctx))
      return r.ok ? r.value : null
    } catch {
      return null
    }
  }

  evalProp(node: ControlNode, prop: string, ctx: NodeCtx): PropEval {
    const meta = metaMap(node.type).get(prop)
    const key = `${node.id}|${rowKey(ctx.rows)}|${prop}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const idx = this.stack.indexOf(key)
    if (idx >= 0) {
      for (let j = idx; j < this.stack.length; j++) this.cyclic.add(this.stack[j])
      return { value: this.defaultValue(node, meta, ctx), error: 'Circular reference' }
    }
    const formula = node.props[prop] ?? meta?.default ?? '='
    this.stack.push(key)
    let res: PropEval
    try {
      if (meta?.kind === 'action') {
        const d = fx.check(formula)
        res = { value: null, error: d[0]?.message, diag: d[0] }
      } else {
        const r = fx.evaluate(formula, this.scopeFor(node, ctx))
        res = r.ok ? { value: r.value } : { value: this.defaultValue(node, meta, ctx), error: r.error.message, diag: r.error }
      }
    } catch (e) {
      res = { value: this.defaultValue(node, meta, ctx), error: e instanceof Error ? e.message : String(e) }
    } finally {
      this.stack.pop()
    }
    if (this.cyclic.delete(key)) res = { value: this.defaultValue(node, meta, ctx), error: 'Circular reference' }
    this.cache.set(key, res)
    return res
  }

  outputsOf(node: ControlNode, ctx: NodeCtx): Record<string, FxValue> {
    let def
    try {
      def = controls.get(node.type)
    } catch {
      return {}
    }
    const stored = this.rt.outputs[this.outKey(node, ctx)]
    const out: Record<string, FxValue> = {}
    for (const o of def.outputs) out[o.name] = stored && has(stored, o.name) ? stored[o.name] : o.initial
    return out
  }

  evalNode(node: ControlNode, ctx: NodeCtx): NodeEval {
    const key = `${node.id}|${rowKey(ctx.rows)}`
    const hit = this.nodeCache.get(key)
    if (hit) return hit
    const props: Record<string, FxValue> = {}
    const errors: Record<string, string> = {}
    for (const m of metaMap(node.type).values()) {
      const pe = this.evalProp(node, m.name, ctx)
      props[m.name] = pe.value
      if (pe.error) errors[m.name] = pe.error
    }
    const res = { props, errors, outputs: this.outputsOf(node, ctx) }
    this.nodeCache.set(key, res)
    return res
  }

  geom(node: ControlNode, ctx: NodeCtx): Geom {
    const p = this.evalNode(node, ctx).props
    return { x: num(p.X, 0), y: num(p.Y, 0), w: num(p.Width, 0), h: num(p.Height, 0) }
  }

  /** Size of the area children of `node` are positioned in. */
  innerSize(node: ControlNode): { w: number; h: number } {
    if (node.type === 'Screen') return { w: this.app.width, h: this.app.height }
    const ctx = this.designCtx(node)
    const g = this.geom(node, ctx)
    if (node.type === 'Gallery') return { w: g.w, h: num(this.evalProp(node, 'TemplateHeight', ctx).value, 64) }
    return { w: g.w, h: g.h }
  }

  /** Errors of every property of the node in its design context. */
  errorsOf(node: ControlNode): Record<string, string> {
    return this.evalNode(node, this.designCtx(node)).errors
  }

  /* ---------------------------------------------------------------- scope */

  controlRecord(node: ControlNode, ctx: NodeCtx): FxRecord {
    const key = `${node.id}|${rowKey(ctx.rows)}`
    const hit = this.recCache.get(key)
    if (hit) return hit
    const rec: FxRecord = {}
    for (const m of metaMap(node.type).values()) {
      Object.defineProperty(rec, m.name, { enumerable: true, configurable: true, get: () => this.evalProp(node, m.name, ctx).value })
    }
    const outs = this.outputsOf(node, ctx)
    for (const k of Object.keys(outs)) {
      Object.defineProperty(rec, k, { enumerable: true, configurable: true, get: () => this.outputsOf(node, ctx)[k] })
    }
    if (node.type === 'Screen') {
      rec.X = 0
      rec.Y = 0
      rec.Width = this.app.width
      rec.Height = this.app.height
    }
    this.recCache.set(key, rec)
    return rec
  }

  scopeFor(node: ControlNode | null, ctx: NodeCtx): FxScope {
    return { resolve: (name) => this.resolveName(node, ctx, name) }
  }

  private resolveName(node: ControlNode | null, ctx: NodeCtx, name: string): FxValue | undefined {
    if (name === 'ThisItem') return ctx.rows.length ? ctx.rows[ctx.rows.length - 1].item : undefined
    if (node) {
      if (name === 'Self') return this.controlRecord(node, ctx)
      if (name === 'Parent') {
        const info = this.byId.get(node.id)
        if (info?.parent) {
          const pinfo = this.byId.get(info.parent.id)!
          return this.controlRecord(info.parent, this.ctxFor(pinfo, ctx))
        }
        return undefined
      }
    }
    const info = this.byName.get(name)
    if (info) return this.controlRecord(info.node, this.ctxFor(info, ctx))
    const rt = this.rt
    if (has(rt.context, name)) return rt.context[name]
    if (has(rt.vars, name)) return rt.vars[name]
    if (has(rt.collections, name)) return rt.collections[name]
    return undefined
  }
}

/* ---------------------------------------------------------------- shared instance */

let cached: { app: AppDef; rt: RuntimeView; ev: Evaluator } | null = null

export function getEvaluator(app: AppDef, rt: RuntimeView): Evaluator {
  if (
    cached &&
    cached.app === app &&
    cached.rt.vars === rt.vars &&
    cached.rt.context === rt.context &&
    cached.rt.collections === rt.collections &&
    cached.rt.outputs === rt.outputs &&
    cached.rt.resetKeys === rt.resetKeys
  ) {
    return cached.ev
  }
  const ev = new Evaluator(app, rt)
  cached = { app, rt: { vars: rt.vars, context: rt.context, collections: rt.collections, outputs: rt.outputs, resetKeys: rt.resetKeys }, ev }
  return ev
}
