import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { current, original, setAutoFreeze } from 'immer'
import type { AppDef, ControlNode, FxRecord, FxValue } from '@/contracts'
import { fx } from '@/fx'
import { controls } from '@/controls'
import { getEvaluator, ROOT_CTX, type NodeCtx } from './evaluator'
import { runFormula, type RunResult, type Toast, type ToastKind } from './host'
import { loadPersisted, savePersisted, clearPersisted } from './persist'
import { sampleApp, sampleCollections } from './sample'
import {
  allNames, cloneWithNewIds, deepEqual, findNode, findParent, isDescendant, mapNodes, parseNumberLiteral, round2, screenOf, uid,
  uniqueName, walk,
} from './util'

setAutoFreeze(false)

export interface RuntimeState {
  vars: Record<string, FxValue>
  context: Record<string, FxValue>
  collections: Record<string, FxRecord[]>
  outputs: Record<string, Record<string, FxValue>>
  resetKeys: Record<string, number>
  navStack: string[]
  toasts: Toast[]
}

export interface GeomChange { id: string; x?: number; y?: number; w?: number; h?: number }

export interface StudioState {
  app: AppDef
  selection: string[]
  currentScreenId: string
  mode: 'design' | 'preview'
  runtime: RuntimeState
  history: { past: AppDef[]; future: AppDef[]; lastKey: string | null; lastAt: number }
  clipboard: ControlNode[] | null
  pasteCount: number
  /** bumps when the whole app is replaced (import / reset) */
  epoch: number

  select(ids: string[]): void
  setCurrentScreen(id: string): void
  setProp(id: string, prop: string, formula: string, coalesceKey?: string): void
  setAppName(name: string): void
  setAppProp(name: string, formula: string): void
  setGeometry(changes: GeomChange[]): void
  nudge(ids: string[], dx: number, dy: number): void
  insert(type: string, opts?: { parentId?: string; x?: number; y?: number }): string | null
  remove(ids: string[]): void
  rename(id: string, name: string): string | null
  copy(ids: string[]): void
  paste(): void
  duplicate(ids: string[]): void
  reorder(id: string, where: 'front' | 'back'): void
  reparent(id: string, parentId: string, x: number, y: number): void
  addScreen(): string
  deleteScreen(id: string): void
  undo(): void
  redo(): void
  setApp(app: AppDef, collections?: Record<string, FxRecord[]> | null): void
  resetToSample(): void

  fire(nodeId: string, event: string, ctx?: NodeCtx): void
  runOnStart(): void
  startPreview(): void
  exitPreview(): void
  setOutput(key: string, name: string, value: FxValue): void
  notify(message: string, kind?: ToastKind): void
  dismissToast(id: string): void
}

const freshRuntime = (collections: Record<string, FxRecord[]>): RuntimeState => ({
  vars: {},
  context: {},
  collections,
  outputs: {},
  resetKeys: {},
  navStack: [],
  toasts: [],
})

const persisted = loadPersisted()
const initialApp = persisted?.app ?? sampleApp()
export const hadPersistedCollections = !!persisted?.collections

const MAX_HISTORY = 100
const COALESCE_MS = 1200

const isContainerType = (type: string) => {
  try {
    return !!controls.get(type).isContainer
  } catch {
    return false
  }
}

const fval = (n: number) => `=${round2(n)}`

function collectIds(app: AppDef): Set<string> {
  const s = new Set<string>()
  walk(app.screens, (n) => s.add(n.id))
  return s
}

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

    const applyRun = (r: RunResult) => {
      set((s) => {
        const rt = s.runtime
        rt.vars = r.vars
        rt.context = r.context
        rt.collections = r.collections
        rt.navStack = r.navStack
        for (const id of r.resetIds) {
          const outs = { ...rt.outputs }
          for (const k of Object.keys(outs)) if (k === id || k.startsWith(id + '#')) delete outs[k]
          rt.outputs = outs
          rt.resetKeys = { ...rt.resetKeys, [id]: (rt.resetKeys[id] ?? 0) + 1 }
        }
        rt.toasts.push(...r.toasts)
      })
      for (const t of r.toasts) setTimeout(() => get().dismissToast(t.id), 3500)
    }

    const run = (node: ControlNode | null, ctx: NodeCtx, formula: string, label: string) => {
      const st = get()
      applyRun(runFormula({ app: st.app, rt: st.runtime, node, ctx, formula, label }))
    }

    return {
      app: initialApp,
      selection: [initialApp.screens[0].id],
      currentScreenId: initialApp.screens[0].id,
      mode: 'design',
      runtime: freshRuntime(persisted?.collections ?? sampleCollections()),
      history: { past: [], future: [], lastKey: null, lastAt: 0 },
      clipboard: null,
      pasteCount: 0,
      epoch: 0,

      select(ids) {
        set((s) => {
          const clean = ids.length ? ids : [s.currentScreenId]
          s.selection = clean
          const scr = screenOf(s.app, clean[0])
          if (scr) s.currentScreenId = scr.id
        })
      },

      setCurrentScreen(id) {
        set((s) => {
          if (!s.app.screens.some((x) => x.id === id)) return
          s.currentScreenId = id
          s.selection = [id]
        })
      },

      setProp(id, prop, formula, coalesceKey) {
        mutate((app) => {
          const n = findNode(app, id)
          if (!n) return
          if (n.props[prop] === formula) return
          n.props[prop] = formula
        }, coalesceKey ?? `prop:${id}:${prop}`)
      },

      setAppName(name) {
        mutate((app) => {
          app.name = name
        }, 'appname')
      },

      setAppProp(name, formula) {
        mutate((app) => {
          if (app.appProps[name] === formula) return
          app.appProps[name] = formula
        }, `appprop:${name}`)
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
        const st = get()
        const ev = getEvaluator(st.app, st.runtime)
        const base = ids
          .map((id) => ev.byId.get(id)?.node)
          .filter((n): n is ControlNode => !!n && n.type !== 'Screen')
          .map((n) => ({ id: n.id, g: ev.geom(n, ev.designCtx(n)) }))
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

      insert(type, opts = {}) {
        const st = get()
        const ev = getEvaluator(st.app, st.runtime)
        let def
        try {
          def = controls.get(type)
        } catch {
          return null
        }
        let parent: ControlNode | undefined = opts.parentId ? ev.byId.get(opts.parentId)?.node : undefined
        if (!parent) {
          const sel = st.selection.length === 1 ? ev.byId.get(st.selection[0]) : undefined
          if (sel) parent = isContainerType(sel.node.type) ? sel.node : (sel.parent ?? sel.screen)
          else parent = ev.byId.get(st.currentScreenId)?.node
        }
        if (!parent) return null
        const { w: pw, h: ph } = ev.innerSize(parent)
        const { width, height } = def.defaultSize
        let x: number
        let y: number
        if (opts.x !== undefined && opts.y !== undefined) {
          x = opts.x
          y = opts.y
        } else {
          x = Math.max(0, Math.round((pw - width) / 2 / 8) * 8)
          y = Math.max(0, Math.round((ph - height) / 2 / 8) * 8)
          for (let i = 0; i < 12; i++) {
            const taken = parent.children.some((c) => {
              const g = ev.geom(c, ev.designCtx(c))
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
          p.children.push({ id, name: uniqueName(app, type), type, props: { X: fval(x), Y: fval(y) }, children: [] })
          s.selection = [id]
          const scr = screenOf(app, id)
          if (scr) s.currentScreenId = scr.id
        })
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
        const reserved = new Set(['ThisItem', 'ThisRecord', 'Self', 'Parent', 'App', 'true', 'false', ...Object.keys(fx.enums()), ...fx.functions().map((f) => f.name)])
        if (reserved.has(name)) return `"${name}" is a reserved name`
        const old = node.name
        mutate((app) => {
          const rewrite = (props: Record<string, string>) => {
            for (const k of Object.keys(props)) if (props[k].includes(old)) props[k] = fx.renameIdentifier(props[k], old, name)
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
        set((s) => {
          s.clipboard = JSON.parse(JSON.stringify(nodes)) as ControlNode[]
          s.pasteCount = 0
        })
      },

      paste() {
        const st = get()
        if (!st.clipboard?.length) return
        const sel = st.selection.length === 1 ? findNode(st.app, st.selection[0]) : null
        const clip = st.clipboard
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
          for (const c of clones) {
            mapNodes(c, (node) => {
              for (const k of Object.keys(node.props)) {
                for (const [from, to] of renames) if (node.props[k].includes(from)) node.props[k] = fx.renameIdentifier(node.props[k], from, to)
              }
            })
            const x = parseNumberLiteral(c.props.X)
            const y = parseNumberLiteral(c.props.Y)
            if (x !== null) c.props.X = fval(x + 16 * n)
            if (y !== null) c.props.Y = fval(y + 16 * n)
            target.children.push(c)
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
            parent.children.push(c)
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
        mutate((app) => {
          const n = findNode(app, id)
          const target = findNode(app, parentId)
          if (!n || !target || n.id === target.id || n.type === 'Screen') return
          if (isDescendant(n, target.id)) return
          const old = findParent(app, id)
          if (!old) return
          old.children = old.children.filter((c) => c.id !== id)
          n.props.X = fval(x)
          n.props.Y = fval(y)
          target.children.push(n)
        })
        set((s) => {
          const scr = screenOf(s.app, id)
          if (scr) s.currentScreenId = scr.id
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

      setApp(app, collections) {
        set((s) => {
          s.app = app
          s.history = { past: [], future: [], lastKey: null, lastAt: 0 }
          s.selection = [app.screens[0].id]
          s.currentScreenId = app.screens[0].id
          s.mode = 'design'
          s.runtime = freshRuntime(collections ?? {})
          s.epoch += 1
        })
        if (!collections) get().runOnStart()
      },

      resetToSample() {
        clearPersisted()
        get().setApp(sampleApp(), sampleCollections())
      },

      fire(nodeId, event, ctx) {
        const st = get()
        const ev = getEvaluator(st.app, st.runtime)
        const info = ev.byId.get(nodeId)
        if (!info) return
        const node = info.node
        const meta = controls.propsOf(node.type).find((p) => p.name === event)
        const formula = node.props[event] ?? meta?.default ?? '=false'
        run(node, ctx ?? ROOT_CTX, formula, `${node.name}.${event}`)
      },

      runOnStart() {
        const f = get().app.appProps.OnStart
        if (f && f.trim() !== '=') run(null, ROOT_CTX, f, 'App.OnStart')
      },

      startPreview() {
        set((s) => {
          const c = s.runtime.collections
          s.runtime = { ...freshRuntime(c), navStack: [s.app.screens[0].id] }
        })
        get().runOnStart()
        set((s) => {
          s.mode = 'preview'
        })
      },

      exitPreview() {
        set((s) => {
          s.mode = 'design'
          s.runtime = freshRuntime(s.runtime.collections)
        })
        get().runOnStart()
      },

      setOutput(key, name, value) {
        const cur = get().runtime.outputs[key]
        if (cur && name in cur && deepEqual(cur[name], value)) return
        set((s) => {
          const o = s.runtime.outputs
          if (!o[key]) o[key] = {}
          o[key][name] = value
        })
      },

      notify(message, kind = 'info') {
        const t: Toast = { id: uid(), message, kind }
        set((s) => {
          s.runtime.toasts.push(t)
        })
        setTimeout(() => get().dismissToast(t.id), 3500)
      },

      dismissToast(id) {
        set((s) => {
          s.runtime.toasts = s.runtime.toasts.filter((t) => t.id !== id)
        })
      },
    }
  }),
)

/* ------------------------------------------------------------------ autosave + bootstrap */

let booted = false
export function bootstrap() {
  if (booted) return
  booted = true
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ab = { store: useStore }
  if (!hadPersistedCollections) useStore.getState().runOnStart()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    const s = useStore.getState()
    savePersisted(s.app, s.runtime.collections)
  }
  useStore.subscribe((s, prev) => {
    if (s.app === prev.app && s.runtime.collections === prev.runtime.collections) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, 400)
  })
  window.addEventListener('beforeunload', flush)
}
