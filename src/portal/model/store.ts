/**
 * Designer state (zustand): the live model, the draft (base snapshot + edited model + undo/redo), the diagram layout,
 * selection and view options. Every edit goes through edit(), which pushes the previous model on the undo stack and
 * schedules a save of the draft (per user and environment, on the server or in this browser).
 */
import { create } from 'zustand'
import type { Model, ModelDraft, ModelLayout, ModelResponse } from '@/model/types'
import { clone, diffModels } from '@/model/ops'
import { placeMissing } from '@/model/layout'
import { modelBackend } from './modelApi'

export type Selection = { kind: 'table'; id: string } | { kind: 'relationship'; id: string } | null

export interface ViewOptions {
  showSystem: boolean
  keysOnly: boolean
  /** show only the tables of this solution ('' = all) */
  solution: string
  search: string
  /** whose positions: the shared layout or my own */
  layoutScope: 'shared' | 'mine'
}

interface State {
  loaded: boolean
  error: string | null
  locked: boolean
  live: Model
  base: Model
  model: Model
  past: Model[]
  future: Model[]
  layout: ModelLayout
  sharedLayout: ModelLayout
  myLayout: ModelLayout | null
  selection: Selection
  options: ViewOptions
  saving: 'idle' | 'saving' | 'error'
  /** a table to bring into view (search, lint) */
  focus: { id: string; at: number } | null
  load(): Promise<void>
  edit(fn: (m: Model) => Model, layout?: (l: ModelLayout) => ModelLayout): void
  undo(): void
  redo(): void
  discard(): Promise<void>
  setLayout(fn: (l: ModelLayout) => ModelLayout, persist?: boolean): void
  select(s: Selection): void
  setOption<K extends keyof ViewOptions>(k: K, v: ViewOptions[K]): void
  setFocus(id: string): void
  /** the draft changed something */
  dirty(): boolean
}

const EMPTY: Model = { tables: [], relationships: [] }
const MAX_HISTORY = 30
let saveTimer: ReturnType<typeof setTimeout> | null = null
let layoutTimer: ReturnType<typeof setTimeout> | null = null

export const useModel = create<State>((set, get) => {
  const persistDraft = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      const s = get()
      if (s.locked) return
      const draft: ModelDraft = { base: s.base, model: s.model, past: s.past.slice(-MAX_HISTORY), future: s.future.slice(0, MAX_HISTORY), layout: s.layout }
      set({ saving: 'saving' })
      try {
        if (diffModels(s.base, s.model).length === 0 && !s.past.length) await modelBackend().discardDraft()
        else await modelBackend().saveDraft(draft)
        set({ saving: 'idle' })
      } catch {
        set({ saving: 'error' })
      }
    }, 700)
  }
  const persistLayout = () => {
    if (layoutTimer) clearTimeout(layoutTimer)
    layoutTimer = setTimeout(async () => {
      const s = get()
      if (s.locked) return
      // positions of tables that exist only in the draft travel with the draft; the rest are saved now
      const liveIds = new Set(s.live.tables.map((t) => t.id))
      const positions = Object.fromEntries(Object.entries(s.layout.positions).filter(([k]) => liveIds.has(k)))
      const areas = s.layout.areas.map((a) => ({ ...a, tables: a.tables.filter((t) => liveIds.has(t)) }))
      try {
        await modelBackend().saveLayout({ positions, areas }, s.options.layoutScope)
      } catch {
        /* the next move saves again */
      }
      persistDraft()
    }, 600)
  }
  return {
    loaded: false,
    error: null,
    locked: false,
    live: EMPTY,
    base: EMPTY,
    model: EMPTY,
    past: [],
    future: [],
    layout: { positions: {}, areas: [] },
    sharedLayout: { positions: {}, areas: [] },
    myLayout: null,
    selection: null,
    options: { showSystem: false, keysOnly: false, solution: '', search: '', layoutScope: 'shared' },
    saving: 'idle',
    focus: null,
    async load() {
      try {
        const r: ModelResponse = await modelBackend().load()
        const draft = r.draft
        const scope = r.myLayout ? 'mine' : get().options.layoutScope
        const chosen = scope === 'mine' && r.myLayout ? r.myLayout : r.layout
        const model = draft?.model ?? r.model
        const merged: ModelLayout = { positions: { ...chosen.positions, ...(draft?.layout?.positions ?? {}) }, areas: draft?.layout?.areas?.length ? draft.layout.areas : chosen.areas }
        set({
          loaded: true, error: null, locked: r.locked, live: r.model, base: draft?.base ?? r.model, model,
          past: draft?.past ?? [], future: draft?.future ?? [], sharedLayout: r.layout, myLayout: r.myLayout ?? null,
          layout: placeMissing(model, merged), options: { ...get().options, layoutScope: scope },
        })
      } catch (e) {
        set({ loaded: true, error: e instanceof Error ? e.message : String(e) })
      }
    },
    edit(fn, layoutFn) {
      const s = get()
      if (s.locked) return
      const next = fn(clone(s.model))
      if (next === s.model) return
      const layout = placeMissing(next, layoutFn ? layoutFn(s.layout) : s.layout)
      set({ model: next, past: [...s.past.slice(-MAX_HISTORY + 1), s.model], future: [], layout })
      persistDraft()
    },
    undo() {
      const s = get()
      if (!s.past.length || s.locked) return
      const prev = s.past[s.past.length - 1]
      set({ model: prev, past: s.past.slice(0, -1), future: [s.model, ...s.future], layout: placeMissing(prev, s.layout) })
      persistDraft()
    },
    redo() {
      const s = get()
      if (!s.future.length || s.locked) return
      const nx = s.future[0]
      set({ model: nx, future: s.future.slice(1), past: [...s.past, s.model], layout: placeMissing(nx, s.layout) })
      persistDraft()
    },
    async discard() {
      const s = get()
      set({ model: s.live, base: s.live, past: [], future: [], selection: null, layout: placeMissing(s.live, s.layout) })
      if (saveTimer) clearTimeout(saveTimer)
      await modelBackend().discardDraft()
    },
    setLayout(fn, persist = true) {
      const s = get()
      set({ layout: fn(s.layout) })
      if (persist && !s.locked) persistLayout()
    },
    select(sel) {
      set({ selection: sel })
    },
    setOption(k, v) {
      const s = get()
      set({ options: { ...s.options, [k]: v } })
      if (k === 'layoutScope') {
        const l = v === 'mine' ? (s.myLayout ?? s.layout) : s.sharedLayout
        set({ layout: placeMissing(s.model, { positions: { ...l.positions }, areas: l.areas }) })
      }
    },
    setFocus(id) {
      set({ focus: { id, at: Date.now() }, selection: { kind: 'table', id } })
    },
    dirty() {
      const s = get()
      return diffModels(s.base, s.model).length > 0
    },
  }
})
