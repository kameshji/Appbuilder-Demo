import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { current, original, setAutoFreeze } from 'immer'
import type { AppDef, ControlNode, FxRecord, FxValue } from '@/contracts'
import { fx } from '@/fx'
import { controls } from '@/controls'
import { getEvaluator, isContainerType, isOverlayType, metaMap, ROOT_CTX, type Env, type Evaluator, type NodeCtx } from './evaluator'
import { runFormula, type DeferredSubmit, type RunResult, type Toast, type ToastKind, type TraceEntry } from './host'
import { SubmitError } from './submit'
import { readClipboard, writeClipboard } from './persist'
import { useUi } from './ui'
import { blankApp, sampleApp } from './sample'
import {
  allNames, cloneWithNewIds, deepEqual, findNode, findParent, isDescendant, mapNodes, parseNumberLiteral, round2, screenOf, uid,
  uniqueName, walk,
} from './util'
import { currentUserId, dataVersion, ensureTablesLoaded, errorMessage, isTable, platformState, subscribePlatform, subscribeDataErrors } from './data'

setAutoFreeze(false)

export interface RuntimeState {
  vars: Record<string, FxValue>
  context: Record<string, Record<string, FxValue>>
  collections: Record<string, FxRecord[]>
  outputs: Record<string, Record<string, FxValue>>
  resetKeys: Record<string, number>
  focusKeys: Record<string, number>
  formModes: Record<string, string>
  navStack: string[]
  toasts: Toast[]
  dataKey: string
  userId: string
  currentScreenId?: string
  /** Exit() was called */
  exited: boolean
}

export interface GeomChange { id: string; x?: number; y?: number; w?: number; h?: number }
export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'hdist' | 'vdist'
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error'

export interface StudioState {
  appId: string | null
  app: AppDef
  loadState: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  loadError: string | null
  saveState: SaveState
  selection: string[]
  currentScreenId: string
  mode: 'design' | 'preview'
  runtime: RuntimeState
  /** actual size of the surface currently rendering the app */
  env: Env
  history: { past: AppDef[]; future: AppDef[]; lastKey: string | null; lastAt: number }
  pasteCount: number
  /** bumps when the whole app is replaced (load / import) */
  epoch: number
  debugLog: TraceEntry[]

  select(ids: string[]): void
  setCurrentScreen(id: string): void
  setProp(id: string, prop: string, formula: string, coalesceKey?: string): void
  setAppName(name: string): void
  setAppProp(name: string, formula: string): void
  setAppSettings(patch: Partial<Pick<AppDef, 'name' | 'width' | 'height' | 'scaleMode' | 'theme'>>): void
  addDataSource(name: string): void
  removeDataSource(name: string): void
  setGeometry(changes: GeomChange[]): void
  nudge(ids: string[], dx: number, dy: number): void
  align(ids: string[], kind: AlignKind): void
  insert(type: string, opts?: { parentId?: string; x?: number; y?: number; index?: number }): string | null
  remove(ids: string[]): void
  rename(id: string, name: string): string | null
  copy(ids: string[]): void
  paste(): void
  duplicate(ids: string[]): void
  reorder(id: string, where: 'front' | 'back'): void
  reparent(id: string, parentId: string, x: number, y: number): void
  /** move into `parentId` at child index (tree drag, auto-layout reorder); optional new X/Y */
  moveNode(id: string, parentId: string, index: number, pos?: { x: number; y: number }): void
  toggleVisible(id: string): void
  addScreen(): string
  deleteScreen(id: string): void
  undo(): void
  redo(): void

  loadApp(id: string | null, app: AppDef, opts?: { runOnStart?: boolean; designRun?: boolean }): void
  /** hot reload: new definition, keep runtime state */
  replaceDefinition(app: AppDef): void
  setSaveState(s: SaveState): void
  setLoadState(s: StudioState['loadState'], error?: string | null): void
  setEnv(w: number, h: number): void

  fire(nodeId: string, event: string, ctx?: NodeCtx, opts?: { allowInDesign?: boolean }): void
  runOnStart(designRun?: boolean): void
  /** reset runtime state and run OnStart (preview restart, debug-window hot restart) */
  restartRuntime(): void
  startPreview(): void
  exitPreview(): void
  navigateTo(screenId: string): void
  setOutput(key: string, name: string, value: FxValue): void
  notify(message: string, kind?: ToastKind): void
  dismissToast(id: string): void
  log(entries: TraceEntry[]): void
  clearLog(): void
}

const freshRuntime = (collections: Record<string, FxRecord[]> = {}, firstScreen?: string): RuntimeState => ({
  vars: {},
  context: {},
  collections,
  outputs: {},
  resetKeys: {},
  focusKeys: {},
  formModes: {},
  navStack: firstScreen ? [firstScreen] : [],
  toasts: [],
  dataKey: platformDataKey(),
  userId: currentUserId(),
  currentScreenId: firstScreen,
  exited: false,
})

export function platformDataKey(): string {
  const st = platformState()
  if (!st) return '0'
  return `${dataVersion()}|${(st.loading ?? []).join('+')}|${st.tables.map((t) => `${t.name}:${t.columns.length}:${t.modifiedOn}`).join(',')}`
}

/** formatVersion 1 apps (960x600, single screen size) open as 'fit' */
export function migrateApp(def: AppDef): AppDef {
  const out: AppDef = { ...def, appProps: { ...(def.appProps ?? {}) } }
  if (def.formatVersion !== 2) {
    out.formatVersion = 2
    out.scaleMode = def.scaleMode ?? 'fit'
  }
  if (!out.scaleMode) out.scaleMode = 'responsive'
  if (!Array.isArray(out.dataSources)) out.dataSources = []
  if (!(out.width >= out.height)) {
    const w = Math.max(out.width, out.height)
    out.height = Math.min(out.width, out.height)
    out.width = w
  }
  return out
}

const MAX_HISTORY = 100
const COALESCE_MS = 1200
const MAX_LOG = 500

const fval = (n: number) => `=${round2(n)}`

function collectIds(app: AppDef): Set<string> {
  const s = new Set<string>()
  walk(app.screens, (n) => s.add(n.id))
  return s
}

/** table names a formula references that are platform tables but not yet data sources */
function newTableRefs(app: AppDef, formula: string): string[] {
  const used = new Set(app.dataSources ?? [])
  const out: string[] = []
  try {
    for (const n of fx.referencedNames(formula)) if (!used.has(n) && isTable(n)) out.push(n)
  } catch {
    /* ignore */
  }
  return out
}

const logListeners = new Set<(entries: TraceEntry[]) => void>()
/** the run window forwards trace / error output to the Studio */
export function onLog(fn: (entries: TraceEntry[]) => void): () => void {
  logListeners.add(fn)
  return () => logListeners.delete(fn)
}
const exitListeners = new Set<() => void>()
export function onExit(fn: () => void): () => void {
  exitListeners.add(fn)
  return () => exitListeners.delete(fn)
}

const initialApp = blankApp('App', 1920, 1080)

export const useStore = create<StudioState>()(
  immer((set, get) => {
    /** apply an edit to `app`, recording one undo step (or coalescing into the previous one with the same key) */
    const mutate = (fn: (app: AppDef, s: StudioState) => void, key?: string) => {
      set((s) => {
        const before = original(s.app) as AppDef
        fn(s.app, s as StudioState)
        if (current(s.app) === before) return
        const h = s.history
        const now = Date.now()
        if (!(key && h.lastKey === key && now - h.lastAt < COALESCE_MS)) {
          h.past.push(before)
          if (h.past.length > MAX_HISTORY) h.past.shift()
        }
        h.future = []
        h.lastKey = key ?? null
        h.lastAt = now
      })
    }

    const sanitise = (s: StudioState) => {
      const ids = collectIds(s.app)
      s.selection = s.selection.filter((i) => ids.has(i))
      if (!s.app.screens.some((x) => x.id === s.currentScreenId)) s.currentScreenId = s.app.screens[0].id
      if (!s.selection.length) s.selection = [s.currentScreenId]
    }

    const ev = (): Evaluator => {
      const st = get()
      return getEvaluator(st.app, st.runtime, st.env)
    }

    const applyRun = (r: RunResult) => {
      set((s) => {
        const rt = s.runtime
        rt.vars = r.vars
        rt.context = r.context
        rt.collections = r.collections
        rt.navStack = r.navStack
        rt.formModes = r.formModes
        if (s.mode === 'preview' || !s.appId || surfaceIsRun) rt.currentScreenId = r.navStack[r.navStack.length - 1] ?? rt.currentScreenId
        if (r.resetIds.length) {
          const outs = { ...rt.outputs }
          const keys = { ...rt.resetKeys }
          for (const id of r.resetIds) {
            for (const k of Object.keys(outs)) if (k === id || k.startsWith(id + '#')) delete outs[k]
            keys[id] = (keys[id] ?? 0) + 1
          }
          rt.outputs = outs
          rt.resetKeys = keys
        }
        if (r.focusIds.length) {
          const keys = { ...rt.focusKeys }
          for (const id of r.focusIds) keys[id] = (keys[id] ?? 0) + 1
          rt.focusKeys = keys
        }
        const outKeys = Object.keys(r.outputs)
        if (outKeys.length) {
          const outs = { ...rt.outputs }
          for (const k of outKeys) outs[k] = { ...(outs[k] ?? {}), ...r.outputs[k] }
          rt.outputs = outs
        }
        rt.toasts.push(...r.toasts)
        if (r.exit) rt.exited = true
        if (r.traces.length) {
          s.debugLog.push(...r.traces)
          if (s.debugLog.length > MAX_LOG) s.debugLog.splice(0, s.debugLog.length - MAX_LOG)
        }
      })
      for (const t of r.toasts) setTimeout(() => get().dismissToast(t.id), 4000)
      if (r.traces.length) logListeners.forEach((fn) => fn(r.traces))
      if (r.exit) {
        if (get().mode === 'preview') get().exitPreview()
        exitListeners.forEach((fn) => fn())
      }
    }

    /** the server's verdict on a submitted form (and its file uploads) arrived */
    const finishDeferred = (d: DeferredSubmit) => {
      void d.work().then(
        (stored) => {
          const cur = get().runtime.outputs[d.key]
          const saved = typeof cur?.__saved === 'number' ? cur.__saved : 0
          set((s) => {
            s.runtime.outputs[d.key] = { ...(cur ?? {}), LastSubmit: stored, Error: '', Unsaved: false, __busy: 0, __saved: saved + 1 }
          })
          get().fire(d.nodeId, 'OnSuccess', d.ctx, { allowInDesign: true })
        },
        (e: unknown) => {
          const message = errorMessage(e)
          const upload = e instanceof SubmitError && e.stage === 'upload'
          set((s) => {
            s.runtime.outputs[d.key] = { ...(s.runtime.outputs[d.key] ?? {}), Error: message, __busy: 0 }
          })
          // a refused write was already reported (toast, error list) through platform.onDataError
          if (upload) {
            get().notify(`${d.name}: ${message}`, 'error')
            get().log([{ id: uid(), at: Date.now(), kind: 'error', message: `${d.name}: ${message}`, source: d.label }])
            logListeners.forEach((fn) => fn([{ id: uid(), at: Date.now(), kind: 'error', message: `${d.name}: ${message}`, source: d.label }]))
          }
          get().fire(d.nodeId, 'OnFailure', d.ctx, { allowInDesign: true })
        },
      )
    }

    let depth = 0
    const run = (node: ControlNode | null, ctx: NodeCtx, label: string, what: { formula?: string; action?: Parameters<typeof runFormula>[0]['action']; fromSubmitButton?: boolean }, designRun = false) => {
      const st = get()
      const r = runFormula({ app: st.app, rt: st.runtime, env: st.env, node, ctx, label, ...what, dryData: designRun })
      applyRun(r)
      r.deferred.forEach(finishDeferred)
      if (r.failed || depth > 8) return
      depth++
      try {
        for (const f of r.followUps) get().fire(f.nodeId, f.event, f.ctx, { allowInDesign: true })
      } finally {
        depth--
      }
    }

    return {
      appId: null,
      app: initialApp,
      loadState: 'idle',
      loadError: null,
      saveState: 'saved',
      selection: [initialApp.screens[0].id],
      currentScreenId: initialApp.screens[0].id,
      mode: 'design',
      runtime: freshRuntime(),
      env: { w: initialApp.width, h: initialApp.height },
      history: { past: [], future: [], lastKey: null, lastAt: 0 },
      pasteCount: 0,
      epoch: 0,
      debugLog: [],

      select(ids) {
        set((s) => {
          const clean = ids.length ? ids : [s.currentScreenId]
          s.selection = clean
          const scr = screenOf(s.app, clean[0])
          if (scr) s.currentScreenId = scr.id
          if (s.mode === 'design' && scr) s.runtime.currentScreenId = scr.id
        })
      },

      setCurrentScreen(id) {
        set((s) => {
          if (!s.app.screens.some((x) => x.id === id)) return
          s.currentScreenId = id
          s.selection = [id]
          if (s.mode === 'design') s.runtime.currentScreenId = id
        })
      },

      setProp(id, prop, formula, coalesceKey) {
        const refs = newTableRefs(get().app, formula)
        const target = findNode(get().app, id)
        if (target && metaMap(target.type).get(prop)?.kind === 'tableName') {
          const m = /^=\s*"((?:[^"]|"")*)"\s*$/.exec(formula)
          const name = m?.[1].replace(/""/g, '"')
          if (name && isTable(name) && !(get().app.dataSources ?? []).includes(name) && !refs.includes(name)) refs.push(name)
        }
        mutate((app) => {
          const n = findNode(app, id)
          if (!n) return
          if (n.props[prop] === formula) return
          n.props[prop] = formula
          if (refs.length) app.dataSources = [...(app.dataSources ?? []), ...refs]
        }, coalesceKey ?? `prop:${id}:${prop}`)
      },

      setAppName(name) {
        mutate((app) => {
          app.name = name
        }, 'appname')
      },

      setAppProp(name, formula) {
        const refs = name === 'Formulas' ? [] : newTableRefs(get().app, formula)
        mutate((app) => {
          if (app.appProps[name] === formula) return
          app.appProps[name] = formula
          if (refs.length) app.dataSources = [...(app.dataSources ?? []), ...refs]
        }, `appprop:${name}`)
      },

      setAppSettings(patch) {
        mutate((app) => {
          if (patch.name !== undefined) app.name = patch.name
          if (patch.width !== undefined) app.width = patch.width
          if (patch.height !== undefined) app.height = patch.height
          if (patch.scaleMode !== undefined) app.scaleMode = patch.scaleMode
          if (patch.theme !== undefined) app.theme = { ...(app.theme ?? {}), ...patch.theme }
        }, 'settings')
      },

      addDataSource(name) {
        mutate((app) => {
          const list = app.dataSources ?? []
          if (!list.includes(name)) app.dataSources = [...list, name]
        })
      },

      removeDataSource(name) {
        mutate((app) => {
          app.dataSources = (app.dataSources ?? []).filter((n) => n !== name)
        })
      },

      setGeometry(changes) {
        mutate((app) => {
          for (const c of changes) {
            const n = findNode(app, c.id)
            if (!n) continue
            if (c.x !== undefined) n.props.X = fval(c.x)
            if (c.y !== undefined) n.props.Y = fval(c.y)
            if (c.w !== undefined) n.props.Width = fval(c.w)
            if (c.h !== undefined) n.props.Height = fval(c.h)
          }
        })
      },

      nudge(ids, dx, dy) {
        const e = ev()
        const base = ids
          .map((id) => e.byId.get(id)?.node)
          .filter((n): n is ControlNode => !!n && n.type !== 'Screen')
          .map((n) => ({ id: n.id, g: e.geom(n, e.designCtx(n)) }))
        if (!base.length) return
        mutate((app) => {
          for (const b of base) {
            const n = findNode(app, b.id)
            if (!n) continue
            if (dx) n.props.X = fval(b.g.x + dx)
            if (dy) n.props.Y = fval(b.g.y + dy)
          }
        }, `nudge:${ids.join(',')}`)
      },

      align(ids, kind) {
        const e = ev()
        const items = ids
          .map((id) => e.byId.get(id)?.node)
          .filter((n): n is ControlNode => !!n && n.type !== 'Screen')
          .map((n) => ({ id: n.id, g: e.geom(n, e.designCtx(n)) }))
        if (items.length < 2) return
        const x1 = Math.min(...items.map((i) => i.g.x))
        const y1 = Math.min(...items.map((i) => i.g.y))
        const x2 = Math.max(...items.map((i) => i.g.x + i.g.w))
        const y2 = Math.max(...items.map((i) => i.g.y + i.g.h))
        const changes: GeomChange[] = []
        if (kind === 'hdist' || kind === 'vdist') {
          if (items.length < 3) return
          const h = kind === 'hdist'
          const sorted = items.slice().sort((a, b) => (h ? a.g.x - b.g.x : a.g.y - b.g.y))
          const total = sorted.reduce((acc, i) => acc + (h ? i.g.w : i.g.h), 0)
          const gap = ((h ? x2 - x1 : y2 - y1) - total) / (sorted.length - 1)
          let pos = h ? x1 : y1
          for (const i of sorted) {
            changes.push(h ? { id: i.id, x: pos } : { id: i.id, y: pos })
            pos += (h ? i.g.w : i.g.h) + gap
          }
        } else {
          for (const i of items) {
            if (kind === 'left') changes.push({ id: i.id, x: x1 })
            if (kind === 'right') changes.push({ id: i.id, x: x2 - i.g.w })
            if (kind === 'hcenter') changes.push({ id: i.id, x: (x1 + x2) / 2 - i.g.w / 2 })
            if (kind === 'top') changes.push({ id: i.id, y: y1 })
            if (kind === 'bottom') changes.push({ id: i.id, y: y2 - i.g.h })
            if (kind === 'vcenter') changes.push({ id: i.id, y: (y1 + y2) / 2 - i.g.h / 2 })
          }
        }
        get().setGeometry(changes)
      },

      insert(type, opts = {}) {
        const st = get()
        const e = ev()
        let def
        try {
          def = controls.get(type)
        } catch {
          return null
        }
        let parent: ControlNode | undefined = opts.parentId ? e.byId.get(opts.parentId)?.node : undefined
        if (!parent) {
          const sel = st.selection.length === 1 ? e.byId.get(st.selection[0]) : undefined
          if (sel) parent = isContainerType(sel.node.type) ? sel.node : (sel.parent ?? sel.screen)
          else parent = e.byId.get(st.currentScreenId)?.node
        }
        if (!parent) return null
        if (def.isOverlay) parent = e.byId.get(parent.id)?.screen ?? parent
        const { w: pw, h: ph } = e.innerSize(parent)
        const { width, height } = def.defaultSize
        let x: number
        let y: number
        if (opts.x !== undefined && opts.y !== undefined && !def.isOverlay) {
          x = opts.x
          y = opts.y
        } else {
          x = Math.max(0, Math.round((pw - width) / 2 / 8) * 8)
          y = Math.max(0, Math.round((ph - height) / 2 / 8) * 8)
          for (let i = 0; i < 12; i++) {
            const taken = parent.children.some((c) => {
              const g = e.geom(c, e.designCtx(c))
              return Math.abs(g.x - x) < 1 && Math.abs(g.y - y) < 1
            })
            if (!taken) break
            x += 16
            y += 16
          }
        }
        const id = uid()
        const parentId = parent.id
        mutate((app, s) => {
          const p = findNode(app, parentId)
          if (!p) return
          const n: ControlNode = { id, name: uniqueName(app, type), type, props: { X: fval(x), Y: fval(y) }, children: [] }
          if (opts.index !== undefined && opts.index >= 0 && opts.index <= p.children.length) p.children.splice(opts.index, 0, n)
          else p.children.push(n)
          s.selection = [id]
          const scr = screenOf(app, id)
          if (scr) s.currentScreenId = scr.id
        })
        recordRecent(type)
        return id
      },

      remove(ids) {
        mutate((app, s) => {
          const kill = new Set(ids)
          const rm = (list: ControlNode[]) => {
            for (let i = list.length - 1; i >= 0; i--) {
              if (kill.has(list[i].id)) list.splice(i, 1)
              else rm(list[i].children)
            }
          }
          for (const scr of app.screens) rm(scr.children)
          sanitise(s)
        })
      },

      rename(id, newName) {
        const name = newName.trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'Use letters, digits and _ (not starting with a digit)'
        const st = get()
        const node = findNode(st.app, id)
        if (!node) return 'Control not found'
        if (name === node.name) return null
        if (allNames(st.app).has(name)) return `"${name}" is already used`
        let reservedList: string[] = []
        try {
          reservedList = [...Object.keys(fx.enums()), ...fx.functions().map((f) => f.name)]
        } catch {
          /* ignore */
        }
        const reserved = new Set(['ThisItem', 'ThisRecord', 'Self', 'Parent', 'App', 'User', 'true', 'false', ...reservedList])
        if (reserved.has(name)) return `"${name}" is a reserved name`
        if (isTable(name)) return `"${name}" is the name of a table`
        const old = node.name
        mutate((app) => {
          const rewrite = (props: Record<string, string>) => {
            for (const k of Object.keys(props)) {
              if (k === 'Formulas' || !props[k].includes(old)) continue
              props[k] = fx.renameIdentifier(props[k], old, name)
            }
          }
          walk(app.screens, (n) => {
            rewrite(n.props)
            if (n.id === id) n.name = name
          })
          rewrite(app.appProps)
        })
        return null
      },

      copy(ids) {
        const st = get()
        const nodes = ids.map((i) => findNode(st.app, i)).filter((n): n is ControlNode => !!n && n.type !== 'Screen')
        if (!nodes.length) return
        writeClipboard(JSON.parse(JSON.stringify(nodes)) as ControlNode[])
        set((s) => {
          s.pasteCount = 0
        })
      },

      paste() {
        const st = get()
        const clip = readClipboard()
        if (!clip?.length) return
        const sel = st.selection.length === 1 ? findNode(st.app, st.selection[0]) : null
        const n = st.pasteCount + 1
        const newIds: string[] = []
        mutate((app, s) => {
          let target: ControlNode | null = null
          if (sel) {
            const asContainer = isContainerType(sel.type) && !clip.some((c) => c.id === sel.id)
            target = asContainer ? findNode(app, sel.id) : findParent(app, sel.id)
          }
          if (!target) target = findNode(app, s.currentScreenId)
          if (!target) return
          const used = new Set<string>()
          const renames = new Map<string, string>()
          const clones = clip.map((c) => cloneWithNewIds(c, renames, app, used))
          // pasted at the same place only when it came from another screen/app; otherwise offset
          const fromHere = clip.some((c) => !!findNode(app, c.id))
          for (const c of clones) {
            mapNodes(c, (node) => {
              for (const k of Object.keys(node.props)) {
                for (const [from, to] of renames) if (node.props[k].includes(from)) node.props[k] = fx.renameIdentifier(node.props[k], from, to)
              }
            })
            if (fromHere) {
              const x = parseNumberLiteral(c.props.X)
              const y = parseNumberLiteral(c.props.Y)
              if (x !== null) c.props.X = fval(x + 16 * n)
              if (y !== null) c.props.Y = fval(y + 16 * n)
            }
            if (isOverlayType(c.type)) findNode(app, s.currentScreenId)?.children.push(c)
            else target.children.push(c)
            newIds.push(c.id)
          }
          s.selection = newIds
          s.pasteCount = n
        })
      },

      duplicate(ids) {
        const st = get()
        const nodes = ids.map((i) => findNode(st.app, i)).filter((n): n is ControlNode => !!n && n.type !== 'Screen')
        if (!nodes.length) return
        const newIds: string[] = []
        mutate((app, s) => {
          for (const src of nodes) {
            const parent = findParent(app, src.id)
            if (!parent) continue
            const renames = new Map<string, string>()
            const c = cloneWithNewIds(JSON.parse(JSON.stringify(src)) as ControlNode, renames, app, new Set())
            mapNodes(c, (node) => {
              for (const k of Object.keys(node.props)) {
                for (const [from, to] of renames) if (node.props[k].includes(from)) node.props[k] = fx.renameIdentifier(node.props[k], from, to)
              }
            })
            const x = parseNumberLiteral(c.props.X)
            const y = parseNumberLiteral(c.props.Y)
            if (x !== null) c.props.X = fval(x + 16)
            if (y !== null) c.props.Y = fval(y + 16)
            const i = parent.children.findIndex((ch) => ch.id === src.id)
            parent.children.splice(i + 1, 0, c)
            newIds.push(c.id)
          }
          if (newIds.length) s.selection = newIds
        })
      },

      reorder(id, where) {
        mutate((app) => {
          const p = findParent(app, id)
          if (!p) return
          const i = p.children.findIndex((c) => c.id === id)
          if (i < 0) return
          if (where === 'front' ? i === p.children.length - 1 : i === 0) return
          const [n] = p.children.splice(i, 1)
          if (where === 'front') p.children.push(n)
          else p.children.unshift(n)
        })
      },

      reparent(id, parentId, x, y) {
        get().moveNode(id, parentId, Number.MAX_SAFE_INTEGER, { x, y })
      },

      moveNode(id, parentId, index, pos) {
        mutate((app, s) => {
          const n = findNode(app, id)
          const target = findNode(app, parentId)
          if (!n || !target || n.id === target.id || n.type === 'Screen') return
          if (isDescendant(n, target.id)) return
          if (!isContainerType(target.type)) return
          const old = findParent(app, id)
          if (!old) return
          const oldIndex = old.children.findIndex((c) => c.id === id)
          if (old.id === target.id && (oldIndex === index || oldIndex + 1 === index) && !pos) return
          old.children.splice(oldIndex, 1)
          let i = index
          if (old.id === target.id && oldIndex < index) i -= 1
          i = Math.max(0, Math.min(target.children.length, i))
          if (pos) {
            n.props.X = fval(pos.x)
            n.props.Y = fval(pos.y)
          }
          target.children.splice(i, 0, n)
          const scr = screenOf(app, id)
          if (scr) s.currentScreenId = scr.id
        })
      },

      toggleVisible(id) {
        mutate((app) => {
          const n = findNode(app, id)
          if (!n || n.type === 'Screen') return
          const cur = n.props.Visible
          n.props.Visible = cur && /^=\s*false\s*$/i.test(cur) ? '=true' : '=false'
        })
      },

      addScreen() {
        const id = uid()
        mutate((app, s) => {
          app.screens.push({ id, name: uniqueName(app, 'Screen'), type: 'Screen', props: { Fill: '=Color.White' }, children: [] })
          s.currentScreenId = id
          s.selection = [id]
        })
        return id
      },

      deleteScreen(id) {
        mutate((app, s) => {
          if (app.screens.length < 2) return
          app.screens = app.screens.filter((x) => x.id !== id)
          sanitise(s)
        })
      },

      undo() {
        set((s) => {
          const prev = s.history.past.pop()
          if (!prev) return
          s.history.future.push(original(s.app) as AppDef)
          s.app = prev
          s.history.lastKey = null
          sanitise(s as StudioState)
        })
      },

      redo() {
        set((s) => {
          const next = s.history.future.pop()
          if (!next) return
          s.history.past.push(original(s.app) as AppDef)
          s.app = next
          s.history.lastKey = null
          sanitise(s as StudioState)
        })
      },

      loadApp(id, def, opts = {}) {
        const app = migrateApp(def)
        set((s) => {
          s.appId = id
          s.app = app
          s.loadState = 'ready'
          s.loadError = null
          s.saveState = 'saved'
          s.history = { past: [], future: [], lastKey: null, lastAt: 0 }
          s.selection = [app.screens[0].id]
          s.currentScreenId = app.screens[0].id
          s.mode = 'design'
          s.runtime = freshRuntime({}, app.screens[0].id)
          s.env = { w: app.width, h: app.height }
          s.epoch += 1
          s.pasteCount = 0
        })
        if (opts.runOnStart !== false) get().runOnStart(opts.designRun ?? true)
      },

      replaceDefinition(def) {
        const app = migrateApp(def)
        set((s) => {
          s.app = app
          const ids = new Set(app.screens.map((x) => x.id))
          const nav = s.runtime.navStack.filter((x) => ids.has(x))
          if (!nav.length) nav.push(app.screens[0].id)
          s.runtime.navStack = nav
          s.runtime.currentScreenId = nav[nav.length - 1]
          if (!ids.has(s.currentScreenId)) s.currentScreenId = app.screens[0].id
          sanitise(s as StudioState)
        })
      },

      setSaveState(v) {
        if (get().saveState !== v)
          set((s) => {
            s.saveState = v
          })
      },

      setLoadState(v, error = null) {
        set((s) => {
          s.loadState = v
          s.loadError = error
        })
      },

      setEnv(w, h) {
        const e = get().env
        const rw = Math.round(w)
        const rh = Math.round(h)
        if (e.w === rw && e.h === rh) return
        set((s) => {
          s.env = { w: rw, h: rh }
        })
      },

      fire(nodeId, event, ctx, opts) {
        const st = get()
        if (st.mode === 'design' && !surfaceIsRun && !opts?.allowInDesign) return
        const e = ev()
        const info = e.byId.get(nodeId)
        if (!info) return
        const node = info.node
        if (event === '__submit') {
          run(node, ctx ?? ROOT_CTX, `${node.name}.Submit`, { action: (h) => h.form('submit', node.name), fromSubmitButton: true })
          return
        }
        const meta = metaMap(node.type).get(event)
        const formula = node.props[event] ?? meta?.default ?? '=false'
        if (/^=\s*(false)?\s*$/i.test(formula)) return
        run(node, ctx ?? ROOT_CTX, `${node.name}.${event}`, { formula })
      },

      runOnStart(designRun = false) {
        const f = get().app.appProps.OnStart
        if (f && f.trim() !== '=' && !/^=\s*false\s*$/i.test(f)) run(null, ROOT_CTX, 'App.OnStart', { formula: f }, designRun)
      },

      restartRuntime() {
        set((s) => {
          s.runtime = freshRuntime({}, s.app.screens[0].id)
        })
        get().runOnStart()
      },

      startPreview() {
        set((s) => {
          s.runtime = { ...freshRuntime(s.runtime.collections, s.app.screens[0].id) }
          s.mode = 'preview'
        })
        get().runOnStart()
      },

      exitPreview() {
        set((s) => {
          s.mode = 'design'
          s.runtime = freshRuntime(s.runtime.collections, s.currentScreenId)
        })
        get().runOnStart(true)
      },

      navigateTo(screenId) {
        set((s) => {
          if (!s.app.screens.some((x) => x.id === screenId)) return
          s.runtime.navStack = [...s.runtime.navStack, screenId]
          s.runtime.currentScreenId = screenId
        })
      },

      setOutput(key, name, value) {
        const cur = get().runtime.outputs[key]
        if (cur && name in cur && deepEqual(cur[name], value)) return
        set((s) => {
          const o = s.runtime.outputs
          o[key] = { ...(o[key] ?? {}), [name]: value }
        })
      },

      notify(message, kind = 'info') {
        const t: Toast = { id: uid(), message, kind }
        set((s) => {
          s.runtime.toasts.push(t)
        })
        setTimeout(() => get().dismissToast(t.id), 4000)
      },

      dismissToast(id) {
        if (!get().runtime.toasts.some((t) => t.id === id)) return
        set((s) => {
          s.runtime.toasts = s.runtime.toasts.filter((t) => t.id !== id)
        })
      },

      log(entries) {
        if (!entries.length) return
        set((s) => {
          s.debugLog.push(...entries)
          if (s.debugLog.length > MAX_LOG) s.debugLog.splice(0, s.debugLog.length - MAX_LOG)
        })
      },

      clearLog() {
        set((s) => {
          s.debugLog = []
        })
      },
    }
  }),
)

/** the evaluator for the current state */
export function evaluatorOf(s: StudioState = useStore.getState()): Evaluator {
  return getEvaluator(s.app, s.runtime, s.env)
}

/** true in the player / debug window: events fire even though the store has no 'preview' mode */
let surfaceIsRun = false
export function setRunSurface(on: boolean) {
  surfaceIsRun = on
}
export function isRunSurface() {
  return surfaceIsRun
}

/* ------------------------------------------------------------------ recent inserts */

const RECENT_KEY = 'appbuilder-recent-controls'
export function recentControls(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function recordRecent(type: string) {
  try {
    const list = [type, ...recentControls().filter((t) => t !== type)].slice(0, 6)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ platform link */

let linked = false
/** keep the runtime's data key / current user in step with the platform (re-evaluates formulas) */
export function linkPlatform() {
  if (linked) return
  linked = true
  const sync = () => {
    const key = platformDataKey()
    const uid2 = currentUserId()
    const rt = useStore.getState().runtime
    if (rt.dataKey === key && rt.userId === uid2) return
    useStore.setState((s) => {
      s.runtime.dataKey = key
      s.runtime.userId = uid2
    })
  }
  subscribePlatform(sync)
  sync()
  // load the rows of the app's tables when an app opens and whenever a data source is added
  useStore.subscribe((s, prev) => {
    if (s.app !== prev.app && s.app.dataSources !== prev.app.dataSources) ensureTablesLoaded(s.app.dataSources ?? [])
  })
  ensureTablesLoaded(useStore.getState().app.dataSources ?? [])
  // writes the server refused (the platform already rolled the cache back)
  subscribeDataErrors((e) => {
    const verb = e.op === 'create' ? 'add to' : e.op === 'update' ? 'change' : 'delete from'
    const message = `Could not ${verb} ${e.table}: ${e.error.message}`
    const entries: TraceEntry[] = [
      { id: uid(), at: Date.now(), kind: 'error', message, source: 'Data' },
      { id: uid(), at: Date.now(), kind: 'trace', message: `Data error (${e.op} ${e.table})`, data: JSON.stringify({ code: e.error.code, rows: e.rowIds, message: e.error.message }), source: 'Data' },
    ]
    const st = useStore.getState()
    st.log(entries)
    logListeners.forEach((fn) => fn(entries))
    if (st.mode === 'preview' || surfaceIsRun) st.notify(e.error.message, 'error')
  })
  ;(window as unknown as Record<string, unknown>).__ab = { store: useStore, ui: useUi, evaluator: () => evaluatorOf(), sampleApp }
}
