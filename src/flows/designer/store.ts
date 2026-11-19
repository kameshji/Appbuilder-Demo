/**
 * State of the open flow designer (one at a time): the definition being edited and its connection references, undo/redo,
 * selection and keyboard focus, collapsed containers, validation problems, the draft's save state, the run shown on the
 * canvas. Edits go through `edit(fn, key?)`: one history entry per edit; edits with the same key within a second (typing
 * in a field) are merged into one.
 */
import { create } from 'zustand'
import type { FlowRunDetail, ValidationProblem } from '@/platform/flows'
import type { FlowDoc } from './model'

export interface Snapshot { doc: FlowDoc; connections: Record<string, string> }

export type Selection = { kind: 'steps'; ids: string[] } | { kind: 'trigger' } | { kind: 'settings'; tab?: string } | null

export interface DesignerState {
  flowId: string | null
  doc: FlowDoc
  connections: Record<string, string>
  past: Snapshot[]
  future: Snapshot[]
  lastKey: { key: string; at: number } | null
  selection: Selection
  /** keyboard focus on the canvas: a step id, 'trigger' or an insertion point key */
  focus: string | null
  collapsed: Set<string>
  problems: ValidationProblem[]
  validating: boolean
  readOnly: boolean
  /** something changed since the last draft save (or publish) */
  dirty: boolean
  /** the edited definition differs from the published one */
  unpublished: boolean
  draftState: 'none' | 'saving' | 'saved' | 'error'
  draftError: string | null
  run: FlowRunDetail | null
  /** loop id -> iteration shown on the canvas */
  iteration: Record<string, number>
  /** field to focus in the panel (a problem was clicked) */
  focusField: { step: string; field: string; at: number } | null
  notes: string[]
  /** the step picker is open for this insertion point */
  picker: { slot: import('./model').Slot; index: number; replace?: string } | null
  /** a small dialog about a step */
  dialog: { kind: 'rename' | 'note' | 'runAfter'; id: string } | null
  /** search on the canvas */
  search: string

  reset(s: { flowId: string | null; doc: FlowDoc; connections: Record<string, string>; readOnly: boolean; unpublished: boolean }): void
  edit(fn: (s: Snapshot) => Snapshot | null, key?: string): boolean
  undo(): void
  redo(): void
  select(s: Selection): void
  setFocus(f: string | null): void
  toggleCollapsed(id: string, on?: boolean): void
  set(p: Partial<DesignerState>): void
}

const LIMIT = 100

export const useDesigner = create<DesignerState>((set, get) => ({
  flowId: null,
  doc: { name: '', runAs: 'owner', trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [], settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' } },
  connections: {},
  past: [],
  future: [],
  lastKey: null,
  selection: null,
  focus: null,
  collapsed: new Set(),
  problems: [],
  validating: false,
  readOnly: false,
  dirty: false,
  unpublished: false,
  draftState: 'none',
  draftError: null,
  run: null,
  iteration: {},
  focusField: null,
  notes: [],
  picker: null,
  dialog: null,
  search: '',

  reset: (s) => set({ ...s, past: [], future: [], lastKey: null, selection: null, focus: null, collapsed: new Set(), problems: [], dirty: false, draftState: 'none', draftError: null, run: null, iteration: {}, focusField: null, notes: [], picker: null, dialog: null, search: '' }),
  edit: (fn, key) => {
    const st = get()
    if (st.readOnly) return false
    const cur = { doc: st.doc, connections: st.connections }
    const next = fn(cur)
    if (!next || (next.doc === cur.doc && next.connections === cur.connections)) return false
    const now = Date.now()
    const merge = !!key && st.lastKey?.key === key && now - st.lastKey.at < 1000
    set({
      doc: next.doc, connections: next.connections,
      past: merge ? st.past : [...st.past, cur].slice(-LIMIT), future: [],
      lastKey: key ? { key, at: now } : null, dirty: true, unpublished: true,
    })
    return true
  },
  undo: () => {
    const st = get()
    if (st.readOnly || !st.past.length) return
    const prev = st.past[st.past.length - 1]
    set({ doc: prev.doc, connections: prev.connections, past: st.past.slice(0, -1), future: [{ doc: st.doc, connections: st.connections }, ...st.future], lastKey: null, dirty: true, unpublished: true })
  },
  redo: () => {
    const st = get()
    if (st.readOnly || !st.future.length) return
    const next = st.future[0]
    set({ doc: next.doc, connections: next.connections, future: st.future.slice(1), past: [...st.past, { doc: st.doc, connections: st.connections }], lastKey: null, dirty: true, unpublished: true })
  },
  select: (s) => set({ selection: s }),
  setFocus: (f) => set({ focus: f }),
  toggleCollapsed: (id, on) => {
    const c = new Set(get().collapsed)
    const want = on ?? !c.has(id)
    if (want) c.add(id)
    else c.delete(id)
    set({ collapsed: c })
  },
  set: (p) => set(p),
}))

export const selectedIds = (s: Selection): string[] => (s?.kind === 'steps' ? s.ids : [])

/* ------------------------------------------------------------------ clipboard (across flows, per browser) */

const CLIP = 'appbuilder-flow-clipboard'
export function writeClipboard(steps: unknown[]): void {
  try { localStorage.setItem(CLIP, JSON.stringify({ v: 1, steps })) } catch { /* private mode */ }
}
export function readClipboard(): unknown[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(CLIP) ?? 'null')
    return v && Array.isArray(v.steps) ? v.steps : null
  } catch {
    return null
  }
}
