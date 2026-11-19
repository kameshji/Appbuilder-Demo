import type { AppDef, ControlNode, FxDiagnostic, FxEngine, FxNamedFormula, FxRecord, FxScope, FxValue, PropMeta } from '@/contracts'
import { createEngine, splitFormulas } from '@/fx'
import { controls } from '@/controls'
import { isRecord, walk } from './util'
import { currentUserRecord, deletedRowsOf, isTable, queryDepsSince, recordById, sharedWithRows, tableRows } from './data'
import { deriveList, evaluateDelegated, type DelegationInfo, type ListView } from './delegation'

/**
 * Formula evaluation for one app definition.
 *
 * Every evaluated property is a cache entry that records what it read (other entries, outputs,
 * variables, collections, tables, the screen size ...). When the runtime state changes, only the
 * entries that depend on the changed parts are dropped, and the affected nodes get a new version
 * number; RenderNode subscribes to its own version, so typing in one input re-renders only the
 * controls that read it.
 */

export interface RuntimeView {
  vars: Record<string, FxValue>
  /** per-screen context variables: screenId -> name -> value */
  context: Record<string, Record<string, FxValue>>
  collections: Record<string, FxRecord[]>
  outputs: Record<string, Record<string, FxValue>>
  resetKeys: Record<string, number>
  focusKeys: Record<string, number>
  /** form mode overrides set by NewForm / EditForm / ViewForm */
  formModes: Record<string, string>
  /** changes whenever platform table rows or the table list change */
  dataKey: string
  /** server mode: bumps when cached query results change (see data.ts queryVersion) */
  queryVersion?: number
  userId: string
  currentScreenId?: string
}

/** actual size of the running screen (px) */
export interface Env { w: number; h: number }

export interface RowCtx { galleryId: string; index: number; item: FxRecord }
export interface NodeCtx { rows: RowCtx[]; inert?: boolean }
export const ROOT_CTX: NodeCtx = { rows: [] }

export interface PropEval {
  value: FxValue
  error?: string
  diag?: FxDiagnostic
  /** server mode: a query this value needs is on its way (value = the previous value, or the default) */
  loading?: boolean
  /** server mode: the formula reads tables; where it runs and why (Studio diagnostics) */
  delegation?: DelegationInfo
  /** a non-blocking note for the Studio (a small table evaluated in the browser) */
  warning?: string
  /** delegation stamp (same stamp, same value) */
  stamp?: string
}
export interface NodeEval { props: Record<string, FxValue>; errors: Record<string, string>; outputs: Record<string, FxValue> }
export interface NodeInfo { node: ControlNode; parent: ControlNode | null; screen: ControlNode; galleries: string[] }
export interface Geom { x: number; y: number; w: number; h: number }
export type LayoutKind = 'manual' | 'row' | 'column' | 'grid'
export interface LayoutInfo { kind: LayoutKind; alignItems: string; padding: number }

const metaCache = new Map<string, Map<string, PropMeta>>()
export function metaMap(type: string): Map<string, PropMeta> {
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

export function isTemplateType(type: string): boolean {
  try {
    const c = controls.get(type)
    return !!c.isTemplate || type === 'Gallery'
  } catch {
    return false
  }
}
export function isContainerType(type: string): boolean {
  try {
    return !!controls.get(type).isContainer
  } catch {
    return false
  }
}
export function isOverlayType(type: string): boolean {
  try {
    return !!controls.get(type).isOverlay
  } catch {
    return false
  }
}

const num = (v: FxValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const text = (v: FxValue | undefined) => (typeof v === 'string' ? v : v == null ? '' : String(v))
/** enum text, tolerant of 'Layout.Row' and 'row' */
export const enumName = (v: FxValue | undefined) => {
  const s = text(v).trim()
  const i = s.lastIndexOf('.')
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase()
}

export function nodeKeyOf(id: string, rows: RowCtx[]): string {
  return rows.length ? `${id}#${rows.map((r) => r.index).join('.')}` : id
}

export function parseFormulas(source: string | undefined): { named: FxNamedFormula[]; udfs: FxNamedFormula[]; errors: FxDiagnostic[] } {
  try {
    return splitFormulas(source)
  } catch (e) {
    return { named: [], udfs: [], errors: [{ message: e instanceof Error ? e.message : String(e), start: 0, end: 0 }] }
  }
}

function structureKey(app: AppDef): string {
  const parts: string[] = []
  walk(app.screens, (n, p) => parts.push(`${n.id}:${n.name}:${n.type}:${p?.id ?? ''}`))
  return parts.join('|')
}

export class Evaluator {
  app: AppDef
  rt: RuntimeView
  env: Env
  readonly byId = new Map<string, NodeInfo>()
  readonly byName = new Map<string, NodeInfo>()
  readonly screensByName = new Map<string, ControlNode>()
  readonly named = new Map<string, string>()
  namedErrors: FxDiagnostic[] = []
  private structKey: string
  private formulasSrc: string | undefined
  /**
   * This app's formula engine: its user-defined functions (App.Formulas) live here, so several mounted apps
   * (app tabs, Studio + preview) never see each other's definitions. Named formulas stay in `named` (the
   * evaluator resolves and dependency-tracks them itself).
   */
  readonly engine: FxEngine = createEngine()

  private cache = new Map<string, PropEval>()
  private deps = new Map<string, Set<string>>()
  private rdeps = new Map<string, Set<string>>()
  private frames: Set<string>[] = []
  private stack: string[] = []
  private cyclic = new Set<string>()
  private nodeVer = new Map<string, number>()
  private nodeKeysById = new Map<string, Set<string>>()
  private nodeCache = new Map<string, NodeEval>()
  private recCache = new Map<string, FxRecord>()
  private parentRecCache = new Map<string, FxRecord>()
  private sizeCache = new Map<string, { w: number; h: number }>()

  constructor(app: AppDef, rt: RuntimeView, env?: Env) {
    this.app = app
    this.rt = rt
    this.env = env ?? { w: app.width, h: app.height }
    this.structKey = structureKey(app)
    this.indexApp(app)
    this.formulasSrc = app.appProps.Formulas
    this.loadFormulas()
  }

  private indexApp(app: AppDef) {
    this.byId.clear()
    this.byName.clear()
    this.screensByName.clear()
    const gal: Record<string, string[]> = {}
    walk(app.screens, (n, parent, screen) => {
      const galleries = parent ? [...(gal[parent.id] ?? []), ...(isTemplateType(parent.type) ? [parent.id] : [])] : []
      gal[n.id] = galleries
      const info = { node: n, parent, screen, galleries }
      this.byId.set(n.id, info)
      if (!this.byName.has(n.name)) this.byName.set(n.name, info)
      if (n.type === 'Screen') this.screensByName.set(n.name, n)
    })
  }

  private loadFormulas() {
    const { named, udfs, errors } = parseFormulas(this.app.appProps.Formulas)
    this.named.clear()
    for (const n of named) this.named.set(n.name, n.formula)
    this.namedErrors = errors
    this.engine.setUserFunctions(udfs)
  }

  /**
   * Adopt a new definition. Returns false when the structure changed (names, types, nesting) and
   * the caller must build a new evaluator; otherwise only the changed properties are invalidated.
   */
  withApp(app: AppDef): boolean {
    if (app === this.app) return true
    if (structureKey(app) !== this.structKey) return false
    if (app.appProps.Formulas !== this.formulasSrc) return false
    const old = new Map(this.byId)
    const oldApp = this.app
    this.app = app
    this.indexApp(app)
    for (const [id, info] of this.byId) {
      const prev = old.get(id)?.node
      const cur = info.node
      if (!prev || prev === cur || prev.props === cur.props) continue
      const keys = new Set([...Object.keys(prev.props), ...Object.keys(cur.props)])
      for (const k of keys) if (prev.props[k] !== cur.props[k]) this.invalidateProp(id, k)
    }
    if (oldApp.width !== app.width || oldApp.height !== app.height) this.invalidate('e')
    // records / parent records hold node references through closures over ids: they stay valid
    return true
  }

  /** apply a runtime change: drop what depends on the parts that changed */
  update(rt: RuntimeView, env: Env) {
    const o = this.rt
    if (env.w !== this.env.w || env.h !== this.env.h) {
      this.env = env
      this.invalidate('e')
    }
    if (rt === o) return
    this.rt = rt
    if (rt.vars !== o.vars) this.diffFlat('v:', o.vars, rt.vars)
    if (rt.collections !== o.collections) this.diffFlat('k:', o.collections, rt.collections)
    if (rt.context !== o.context) {
      const scr = new Set([...Object.keys(o.context), ...Object.keys(rt.context)])
      for (const s of scr) if (o.context[s] !== rt.context[s]) this.diffFlat(`c:${s}:`, o.context[s] ?? {}, rt.context[s] ?? {})
    }
    if (rt.outputs !== o.outputs) {
      const keys = new Set([...Object.keys(o.outputs), ...Object.keys(rt.outputs)])
      for (const k of keys) {
        if (o.outputs[k] !== rt.outputs[k]) {
          this.invalidate('o:' + k)
          this.bump(k)
        }
      }
    }
    if (rt.formModes !== o.formModes) {
      const keys = new Set([...Object.keys(o.formModes), ...Object.keys(rt.formModes)])
      for (const k of keys) if (o.formModes[k] !== rt.formModes[k]) this.invalidate('f:' + k)
    }
    for (const field of ['resetKeys', 'focusKeys'] as const) {
      if (rt[field] === o[field]) continue
      const keys = new Set([...Object.keys(o[field]), ...Object.keys(rt[field])])
      for (const id of keys) if (o[field][id] !== rt[field][id]) for (const nk of this.nodeKeysById.get(id) ?? [id]) this.bump(nk)
    }
    if (rt.dataKey !== o.dataKey) this.invalidateTables()
    if ((rt.queryVersion ?? 0) !== (o.queryVersion ?? 0)) {
      const deps = queryDepsSince(o.queryVersion ?? 0)
      if (deps === null) {
        for (const d of [...this.rdeps.keys()]) if (d.startsWith('q:') || d.startsWith('ts:')) this.invalidate(d)
      } else for (const d of deps) this.invalidate(d)
    }
    if (rt.userId !== o.userId) this.invalidate('u')
  }

  private diffFlat(prefix: string, a: Record<string, unknown>, b: Record<string, unknown>) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (a[k] !== b[k] || has(a, k) !== has(b, k)) this.invalidate(prefix + k)
  }

  /* ---------------------------------------------------------------- dependency bookkeeping */

  private record(dep: string) {
    const f = this.frames[this.frames.length - 1]
    if (f) f.add(dep)
  }

  private track<T>(entry: string, compute: () => T): T {
    const frame = new Set<string>()
    this.frames.push(frame)
    try {
      return compute()
    } finally {
      this.frames.pop()
      this.deps.set(entry, frame)
      for (const d of frame) {
        let s = this.rdeps.get(d)
        if (!s) this.rdeps.set(d, (s = new Set()))
        s.add(entry)
      }
    }
  }

  private drop(entry: string) {
    this.cache.delete(entry)
    if (entry.startsWith('S|')) {
      this.sizeCache.delete(entry)
    } else if (entry.startsWith('N|')) {
      this.cache.delete(entry)
    }
    const fwd = this.deps.get(entry)
    if (fwd) {
      for (const d of fwd) this.rdeps.get(d)?.delete(entry)
      this.deps.delete(entry)
    }
    if (entry.startsWith('P|')) this.bump(entry.slice(2, entry.lastIndexOf('|')))
    else if (entry.startsWith('S|')) this.bump(entry.slice(2))
  }

  /** drop every entry that (transitively) depends on `dep` */
  invalidate(dep: string) {
    const queue = [dep]
    while (queue.length) {
      const d = queue.pop()!
      const ents = this.rdeps.get(d)
      if (!ents) continue
      this.rdeps.delete(d)
      for (const e of ents) {
        this.drop(e)
        queue.push(e)
      }
    }
  }

  /** platform table rows changed */
  invalidateTables() {
    for (const d of [...this.rdeps.keys()]) if (d.startsWith('t:')) this.invalidate(d)
  }

  private invalidateEntry(entry: string) {
    this.drop(entry)
    this.invalidate(entry)
  }

  private invalidateProp(id: string, prop: string) {
    for (const nk of this.nodeKeysById.get(id) ?? [id]) {
      this.invalidateEntry(`P|${nk}|${prop}`)
      this.bump(nk)
    }
  }

  private bump(nk: string) {
    this.nodeVer.set(nk, (this.nodeVer.get(nk) ?? 0) + 1)
    this.nodeCache.delete(nk)
  }

  /** changes whenever anything the node renders from may have changed */
  versionOf(nk: string): number {
    return this.nodeVer.get(nk) ?? 0
  }

  private noteNodeKey(id: string, nk: string) {
    let s = this.nodeKeysById.get(id)
    if (!s) this.nodeKeysById.set(id, (s = new Set()))
    s.add(nk)
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

  nodeKey(node: ControlNode, ctx: NodeCtx): string {
    const nk = nodeKeyOf(node.id, ctx.rows)
    this.noteNodeKey(node.id, nk)
    return nk
  }

  outKey(node: ControlNode, ctx: NodeCtx): string {
    const info = this.byId.get(node.id)
    const rows = info ? this.ctxFor(info, ctx).rows : []
    return this.nodeKey(node, { rows })
  }

  resetKey(id: string): number {
    return this.rt.resetKeys[id] ?? 0
  }
  focusKey(id: string): number {
    return this.rt.focusKeys[id] ?? 0
  }

  /* ---------------------------------------------------------------- evaluation */

  private defaultValue(node: ControlNode, meta: PropMeta | undefined, ctx: NodeCtx): FxValue {
    if (!meta) return null
    try {
      const r = this.engine.evaluate(meta.default, this.scopeFor(node, ctx))
      return r.ok ? r.value : null
    } catch {
      return null
    }
  }

  evalProp(nodeIn: ControlNode, prop: string, ctx: NodeCtx): PropEval {
    // records and parent records capture nodes; always read the current definition
    const node = this.byId.get(nodeIn.id)?.node ?? nodeIn
    const meta = metaMap(node.type).get(prop)
    const nk = this.nodeKey(node, ctx)
    const key = `P|${nk}|${prop}`
    this.record(key)
    const hit = this.cache.get(key)
    if (hit) return hit
    const idx = this.stack.indexOf(key)
    if (idx >= 0) {
      for (let j = idx; j < this.stack.length; j++) this.cyclic.add(this.stack[j])
      return { value: this.defaultValue(node, meta, ctx), error: 'Circular reference' }
    }
    this.stack.push(key)
    let res: PropEval
    try {
      res = this.track(key, () => this.computeProp(node, prop, meta, ctx))
    } finally {
      this.stack.pop()
    }
    if (this.cyclic.delete(key)) res = { value: this.defaultValue(node, meta, ctx), error: 'Circular reference' }
    this.cache.set(key, res)
    return res
  }

  private computeProp(node: ControlNode, prop: string, meta: PropMeta | undefined, ctx: NodeCtx): PropEval {
    const formula = node.props[prop] ?? meta?.default ?? '='
    try {
      if (meta?.kind === 'action') {
          const d = this.engine.check(formula)
        return { value: null, error: d[0]?.message, diag: d[0] }
      }
      const key = `P|${this.nodeKey(node, ctx)}|${prop}`
      const view = this.listView(node, prop, ctx)
      const delegated = this.delegate(key, formula, this.scopeFor(node, ctx), () => this.defaultValue(node, meta, ctx), view)
      if (delegated) return delegated
      const r = this.engine.evaluate(formula, this.scopeFor(node, ctx))
      // a server list from a named formula / variable, shown with the control's own sort or search: re-plan it
      if (r.ok && view) {
        const d = deriveList(r.value, view, key, (dep) => this.record(dep))
        if (d) return this.settleDelegated(key, d, () => this.defaultValue(node, meta, ctx))
      }
      return r.ok ? { value: r.value } : { value: this.defaultValue(node, meta, ctx), error: r.error.message, diag: r.error }
    } catch (e) {
      return { value: this.defaultValue(node, meta, ctx), error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** last good value of a delegated property (shown while a refresh is loading: no flicker) */
  private prevValues = new Map<string, PropEval>()

  /** server mode: run the table reads of a formula on the server (null: evaluate in the browser as usual) */
  private delegate(key: string, formula: string, scope: FxScope, fallback: () => FxValue, view?: ListView): PropEval | null {
    const res = evaluateDelegated({
      formula, scope, engine: this.engine, collections: this.rt.collections, record: (dep) => this.record(dep), owner: key, view,
    })
    if (!res) {
      this.prevValues.delete(key)
      return null
    }
    if (res.browser) {
      // a small, fully loaded table: the browser evaluates the formula (the Studio shows the warning)
      this.prevValues.delete(key)
      const r = this.engine.evaluate(formula, scope)
      return r.ok ? { value: r.value, delegation: res.info, warning: res.warning } : { value: fallback(), error: r.error.message, diag: r.error, delegation: res.info }
    }
    return this.settleDelegated(key, res, fallback)
  }

  /** loading keeps the previous value (no flicker); the same stamp keeps the same value identity */
  private settleDelegated(key: string, res: import('./delegation').DelegatedResult, fallback: () => FxValue): PropEval {
    const prev = this.prevValues.get(key)
    if (res.loading) return { value: prev ? prev.value : fallback(), loading: true, delegation: res.info, warning: res.warning }
    if (res.error !== undefined) return { value: fallback(), error: res.error, diag: res.diag, delegation: res.info }
    if (prev && prev.stamp !== undefined && prev.stamp === res.stamp) return { ...prev, delegation: res.info, warning: res.warning }
    const out: PropEval = { value: res.value ?? null, delegation: res.info, warning: res.warning, stamp: res.stamp }
    this.prevValues.set(key, out)
    return out
  }

  /** DataTable header sort and search box shape the server query of its Items */
  private listView(node: ControlNode, prop: string, ctx: NodeCtx): ListView | undefined {
    if (prop !== 'Items') return undefined
    if (node.type !== 'DataTable' && node.type !== 'Dropdown' && node.type !== 'ComboBox') return undefined
    const out = this.outputsOf(node, ctx)
    const view: ListView = {}
    const col = typeof out.SortColumn === 'string' ? out.SortColumn : ''
    const order = typeof out.SortOrder === 'string' ? out.SortOrder : ''
    if (col && (order === 'Ascending' || order === 'Descending')) view.sort = { col, dir: order === 'Descending' ? 'desc' : 'asc' }
    if (typeof out.SearchText === 'string' && out.SearchText.trim()) view.search = out.SearchText
    if (node.type === 'ComboBox' && view.search) {
      const fields = [this.evalProp(node, 'SearchField', ctx).value, this.evalProp(node, 'DisplayField', ctx).value]
        .map((v) => (typeof v === 'string' ? v : '')).find((v) => v.trim() !== '')
      if (fields) view.searchColumns = fields.split(',').map((x) => x.trim()).filter(Boolean)
    }
    return view.sort || view.search ? view : undefined
  }

  /** a named formula from App.Formulas, evaluated lazily and cached */
  evalNamed(name: string): PropEval {
    const key = `N|${name}`
    this.record(key)
    const hit = this.cache.get(key)
    if (hit) return hit
    if (this.stack.includes(key)) return { value: null, error: `Circular reference in named formula ${name}` }
    const formula = this.named.get(name) ?? '='
    this.stack.push(key)
    let res: PropEval
    try {
      res = this.track(key, () => {
        try {
          const delegated = this.delegate(key, formula, this.scopeFor(null, ROOT_CTX), () => null)
          if (delegated) return delegated.error ? { ...delegated, error: `${name}: ${delegated.error}` } : delegated
          const r = this.engine.evaluate(formula, this.scopeFor(null, ROOT_CTX))
          return r.ok ? { value: r.value } : { value: null, error: `${name}: ${r.error.message}` }
        } catch (e) {
          return { value: null, error: e instanceof Error ? e.message : String(e) }
        }
      })
    } finally {
      this.stack.pop()
    }
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
    const ok = this.outKey(node, ctx)
    this.record('o:' + ok)
    const stored = this.rt.outputs[ok]
    const out: Record<string, FxValue> = {}
    for (const o of def.outputs) out[o.name] = stored && has(stored, o.name) ? stored[o.name] : o.initial
    return out
  }

  evalNode(node: ControlNode, ctx: NodeCtx): NodeEval {
    const nk = this.nodeKey(node, ctx)
    const hit = this.nodeCache.get(nk)
    if (hit) return hit
    const props: Record<string, FxValue> = {}
    const errors: Record<string, string> = {}
    for (const m of metaMap(node.type).values()) {
      const pe = this.evalProp(node, m.name, ctx)
      props[m.name] = pe.value
      if (pe.error) errors[m.name] = pe.error
    }
    const res = { props, errors, outputs: this.outputsOf(node, ctx) }
    this.nodeCache.set(nk, res)
    return res
  }

  geom(node: ControlNode, ctx: NodeCtx): Geom {
    if (node.type === 'Screen') return { x: 0, y: 0, w: this.app.width, h: this.app.height }
    const p = (k: string) => this.evalProp(node, k, ctx).value
    let size = { width: 100, height: 40 }
    try {
      size = controls.get(node.type).defaultSize
    } catch {
      /* ignore */
    }
    return { x: num(p('X'), 0), y: num(p('Y'), 0), w: num(p('Width'), size.width), h: num(p('Height'), size.height) }
  }

  /** how `node` lays out its children */
  layoutOf(node: ControlNode, ctx: NodeCtx): LayoutInfo {
    const metas = metaMap(node.type)
    let kind: LayoutKind = 'manual'
    if (metas.has('LayoutMode')) {
      const k = enumName(this.evalProp(node, 'LayoutMode', ctx).value)
      if (k === 'row' || k === 'column' || k === 'grid') kind = k
    } else if (node.type === 'Row' || node.type === 'Column' || node.type === 'Grid') {
      kind = node.type.toLowerCase() as LayoutKind
    }
    const alignItems = metas.has('AlignItems') ? enumName(this.evalProp(node, 'AlignItems', ctx).value) : 'auto'
    const padding = metas.has('Padding') ? Math.max(0, num(this.evalProp(node, 'Padding', ctx).value, 0)) : 0
    return { kind, alignItems, padding }
  }

  /** Design size of the area children of `node` are positioned in. */
  innerSize(node: ControlNode, ctx?: NodeCtx): { w: number; h: number } {
    if (node.type === 'Screen') {
      this.record('e')
      return { w: this.app.width, h: this.app.height }
    }
    const c = ctx ?? this.designCtx(node)
    const g = this.geom(node, c)
    if (isTemplateType(node.type)) {
      const metas = metaMap(node.type)
      const pv = (k: string, d: number) => (metas.has(k) ? num(this.evalProp(node, k, c).value, d) : d)
      const th = pv('TemplateHeight', 64)
      const lay = metas.has('Layout') ? enumName(this.evalProp(node, 'Layout', c).value) : 'vertical'
      if (lay === 'horizontal') return { w: pv('TemplateWidth', 240), h: th }
      if (lay === 'grid') {
        const cols = Math.max(1, Math.round(pv('Columns', 3)))
        const gap = Math.max(0, pv('Gap', 8))
        return { w: Math.max(0, (g.w - gap * (cols - 1)) / cols), h: th }
      }
      return { w: g.w, h: th }
    }
    // absolutely positioned children use the padding box, so padding does not shrink it
    return { w: g.w, h: g.h }
  }

  /** Actual (rendered) size of a node at the current screen size, following anchors. */
  actualSize(node: ControlNode, ctx: NodeCtx): { w: number; h: number } {
    if (node.type === 'Screen') {
      this.record('e')
      return { w: this.env.w, h: this.env.h }
    }
    const key = `S|${this.nodeKey(node, ctx)}`
    this.record(key)
    const hit = this.sizeCache.get(key)
    if (hit) return hit
    if (this.stack.includes(key)) return { w: 0, h: 0 }
    this.stack.push(key)
    let res: { w: number; h: number }
    try {
      res = this.track(key, () => this.computeActual(node, ctx))
    } finally {
      this.stack.pop()
    }
    this.sizeCache.set(key, res)
    return res
  }

  private computeActual(node: ControlNode, ctx: NodeCtx): { w: number; h: number } {
    const info = this.byId.get(node.id)
    const g = this.geom(node, ctx)
    if (!info?.parent) return { w: g.w, h: g.h }
    const parent = info.parent
    const pinfo = this.byId.get(parent.id)!
    const pctx = this.ctxFor(pinfo, ctx)
    if (!isTemplateType(parent.type) && parent.type !== 'Screen' && this.layoutOf(parent, pctx).kind !== 'manual') return { w: g.w, h: g.h }
    const pd = this.innerSize(parent, pctx)
    const pa0 = this.actualSize(parent, pctx)
    const pa = isTemplateType(parent.type)
      ? { w: pd.w + (pa0.w - this.geom(parent, pctx).w), h: pd.h }
      : parent.type === 'Screen'
        ? pa0
        : { w: pa0.w - (this.geom(parent, pctx).w - pd.w), h: pa0.h - (this.geom(parent, pctx).h - pd.h) }
    const ah = enumName(this.evalProp(node, 'AnchorH', ctx).value)
    const av = enumName(this.evalProp(node, 'AnchorV', ctx).value)
    const size = (a: string, s: number, d: number, act: number) => (a === 'stretch' ? Math.max(0, s + act - d) : a === 'scale' && d > 0 ? (s * act) / d : s)
    return { w: size(ah, g.w, pd.w, pa.w), h: size(av, g.h, pd.h, pa.h) }
  }

  /** Errors of every property of the node in its design context. */
  errorsOf(node: ControlNode): Record<string, string> {
    return this.evalNode(node, this.designCtx(node)).errors
  }

  /** Server mode: non-blocking notes (a table formula that runs in the browser because the table is small). */
  warningsOf(node: ControlNode): Record<string, string> {
    const ctx = this.designCtx(node)
    const out: Record<string, string> = {}
    for (const m of metaMap(node.type).values()) {
      const pe = this.evalProp(node, m.name, ctx)
      if (pe.warning && !pe.error) out[m.name] = pe.warning
    }
    return out
  }

  /* ---------------------------------------------------------------- scope */

  controlRecord(node: ControlNode, ctx: NodeCtx): FxRecord {
    const key = this.nodeKey(node, ctx)
    const hit = this.recCache.get(key)
    if (hit) return hit
    const rec: FxRecord = {}
    for (const m of metaMap(node.type).values()) {
      Object.defineProperty(rec, m.name, { enumerable: true, configurable: true, get: () => this.evalProp(node, m.name, ctx).value })
    }
    let outNames: string[] = []
    try {
      outNames = controls.get(node.type).outputs.map((o) => o.name)
    } catch {
      /* ignore */
    }
    for (const k of outNames) {
      Object.defineProperty(rec, k, { enumerable: true, configurable: true, get: () => this.outputsOf(node, ctx)[k] })
    }
    if (node.type === 'Screen') {
      const env = () => {
        this.record('e')
        return this.env
      }
      Object.defineProperty(rec, 'X', { enumerable: true, configurable: true, value: 0 })
      Object.defineProperty(rec, 'Y', { enumerable: true, configurable: true, value: 0 })
      Object.defineProperty(rec, 'Width', { enumerable: true, configurable: true, get: () => env().w })
      Object.defineProperty(rec, 'Height', { enumerable: true, configurable: true, get: () => env().h })
      Object.defineProperty(rec, 'Name', { enumerable: true, configurable: true, value: node.name })
    }
    this.recCache.set(key, rec)
    return rec
  }

  /** `Parent`: the parent's record with Width/Height = its actual size */
  private parentRecord(parent: ControlNode, pctx: NodeCtx): FxRecord {
    if (parent.type === 'Screen') return this.controlRecord(parent, pctx)
    const key = this.nodeKey(parent, pctx)
    const hit = this.parentRecCache.get(key)
    if (hit) return hit
    const base = this.controlRecord(parent, pctx)
    const rec: FxRecord = {}
    for (const k of Object.keys(base)) {
      if (k === 'Width' || k === 'Height') continue
      Object.defineProperty(rec, k, { enumerable: true, configurable: true, get: () => base[k] })
    }
    Object.defineProperty(rec, 'Width', { enumerable: true, configurable: true, get: () => this.actualSize(parent, pctx).w })
    Object.defineProperty(rec, 'Height', { enumerable: true, configurable: true, get: () => this.actualSize(parent, pctx).h })
    this.parentRecCache.set(key, rec)
    return rec
  }

  scopeFor(node: ControlNode | null, ctx: NodeCtx): FxScope {
    return {
      resolve: (name) => this.resolveName(node, ctx, name),
      // lookup columns (createdBy, owner, a lookup to Users ...): `.Field` reads the row the id points at
      recordById: (id) => {
        this.record('t:Users')
        return recordById(id)
      },
    }
  }

  screenIdOf(node: ControlNode | null): string | undefined {
    if (node) return this.byId.get(node.id)?.screen.id
    return this.rt.currentScreenId
  }

  private resolveName(node: ControlNode | null, ctx: NodeCtx, name: string): FxValue | undefined {
    if (name === 'ThisItem') {
      if (!ctx.rows.length) return undefined
      const last = ctx.rows[ctx.rows.length - 1]
      this.record(`P|${nodeKeyOf(last.galleryId, ctx.rows.slice(0, -1))}|Items`)
      return last.item
    }
    if (node) {
      if (name === 'Self') return this.controlRecord(node, ctx)
      if (name === 'Parent') {
        const info = this.byId.get(node.id)
        if (info?.parent) {
          const pinfo = this.byId.get(info.parent.id)!
          return this.parentRecord(info.parent, this.ctxFor(pinfo, ctx))
        }
        return undefined
      }
    }
    if (name === 'App') {
      this.record('e')
      const scr = this.screenIdOf(node)
      return {
        Width: this.env.w,
        Height: this.env.h,
        DesignWidth: this.app.width,
        DesignHeight: this.app.height,
        Name: this.app.name,
        ActiveScreen: scr ? (this.byId.get(scr)?.node.name ?? null) : null,
      }
    }
    if (name === 'User()') {
      this.record('u')
      return currentUserRecord() ?? { FullName: '', Email: '', Id: '', Roles: [] }
    }
    if (name.startsWith('SharedWith:')) {
      const id = name.slice(11)
      this.record('q:sw:' + id)
      return sharedWithRows(id)
    }
    // DeletedRows(Table) (recycle bin): the server's Deleted view of the table, cached; reloads after deletes and restores
    if (name.startsWith('DeletedRows:')) {
      const table = name.slice(12)
      if (!isTable(table)) return undefined
      this.record('q:del:' + table.toLowerCase())
      return deletedRowsOf(table)
    }
    if (name.startsWith('Param:')) {
      try {
        const v = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get(name.slice(6))
        if (v !== null) return v
        // a deep link inside Appbuilder carries its parameters after the route: #u-<appId>?record=<id> (notifications)
        const hq = typeof location === 'undefined' ? '' : (location.hash.split('?')[1] ?? '')
        return new URLSearchParams(hq).get(name.slice(6)) ?? undefined
      } catch {
        return undefined
      }
    }
    const info = this.byName.get(name)
    if (info) return this.controlRecord(info.node, this.ctxFor(info, ctx))
    const rt = this.rt
    const scr = this.screenIdOf(node)
    if (scr) {
      this.record(`c:${scr}:${name}`)
      const c = rt.context[scr]
      if (c && has(c, name)) return c[name]
    }
    this.record('v:' + name)
    if (has(rt.vars, name)) return rt.vars[name]
    this.record('k:' + name)
    if (has(rt.collections, name)) return rt.collections[name]
    if (this.named.has(name)) return this.evalNamed(name).value
    this.record('t:' + name)
    if (isTable(name)) return tableRows(name)
    return undefined
  }
}

/* ---------------------------------------------------------------- shared instance */

/**
 * Holds one store's evaluator, reused (and incrementally invalidated) across state changes. Every app store has its
 * own slot (see createAppStore), so two mounted apps never share cached values. A class instance: immer does not
 * draft it, so it can live in zustand state without being copied.
 */
export class EvaluatorSlot {
  private cached: Evaluator | null = null
  get(app: AppDef, rt: RuntimeView, env?: Env): Evaluator {
    const e = env ?? { w: app.width, h: app.height }
    if (this.cached && this.cached.withApp(app)) {
      this.cached.update(rt, e)
      return this.cached
    }
    this.cached = new Evaluator(app, rt, e)
    return this.cached
  }
}

const sharedSlot = new EvaluatorSlot()

/** The evaluator for a state outside any store (kept for callers without a slot). Stores use their own EvaluatorSlot. */
export function getEvaluator(app: AppDef, rt: RuntimeView, env?: Env): Evaluator {
  return sharedSlot.get(app, rt, env)
}
