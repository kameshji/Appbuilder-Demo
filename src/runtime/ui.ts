import { create } from 'zustand'

export interface Rect { x: number; y: number; w: number; h: number }
export interface Guide { axis: 'x' | 'y'; pos: number; from: number; to: number }
export type Pane = 'tree' | 'insert' | 'data' | 'vars'

const THEME_KEY = 'appbuilder-theme'
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2

export function initialTheme(): 'light' | 'dark' {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t === 'dark' || t === 'light') return t
  } catch {
    /* ignore */
  }
  return 'light'
}

interface UiState {
  theme: 'light' | 'dark'
  pane: Pane | null
  zoom: number
  pan: { x: number; y: number }
  viewport: { w: number; h: number }
  fitEpoch: number
  spaceDown: boolean
  hoverId: string | null
  /** transient rects (parent coordinates) while a move/resize gesture is live */
  dragRects: Record<string, Rect>
  dragging: boolean
  guides: Guide[]
  dropTargetId: string | null
  insertGhost: { type: string; x: number; y: number } | null
  lastProp: Record<string, string>
  focusToken: number
  setTheme(t: 'light' | 'dark'): void
  toggleTheme(): void
  setPane(p: Pane | null): void
  setViewport(w: number, h: number): void
  setPan(x: number, y: number): void
  zoomTo(z: number, ax?: number, ay?: number): void
  zoomBy(factor: number, ax?: number, ay?: number): void
  fit(appW: number, appH: number): void
  requestFit(): void
  set(p: Partial<UiState>): void
  clearDrag(): void
  setLastProp(type: string, prop: string): void
  focusFormula(type: string, prop: string): void
}

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme(),
  pane: 'tree',
  zoom: 1,
  pan: { x: 40, y: 40 },
  viewport: { w: 0, h: 0 },
  fitEpoch: 0,
  spaceDown: false,
  hoverId: null,
  dragRects: {},
  dragging: false,
  guides: [],
  dropTargetId: null,
  insertGhost: null,
  lastProp: {},
  focusToken: 0,
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore */
    }
    set({ theme })
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  setPane: (pane) => set({ pane }),
  setViewport: (w, h) => set({ viewport: { w, h } }),
  setPan: (x, y) => set({ pan: { x, y } }),
  zoomTo: (z, ax, ay) => {
    const { zoom, pan, viewport } = get()
    const nz = clamp(z)
    const cx = ax ?? viewport.w / 2
    const cy = ay ?? viewport.h / 2
    const k = nz / zoom
    set({ zoom: nz, pan: { x: cx - (cx - pan.x) * k, y: cy - (cy - pan.y) * k } })
  },
  zoomBy: (factor, ax, ay) => get().zoomTo(get().zoom * factor, ax, ay),
  fit: (appW, appH) => {
    const { viewport } = get()
    if (viewport.w < 50 || viewport.h < 50) return
    const z = clamp(Math.min((viewport.w - 96) / appW, (viewport.h - 110) / appH, 1))
    set({ zoom: z, pan: { x: (viewport.w - appW * z) / 2, y: (viewport.h - appH * z) / 2 + 6 } })
  },
  requestFit: () => set((s) => ({ fitEpoch: s.fitEpoch + 1 })),
  set: (p) => set(p),
  clearDrag: () => set({ dragRects: {}, dragging: false, guides: [], dropTargetId: null }),
  setLastProp: (type, prop) => set((s) => ({ lastProp: { ...s.lastProp, [type]: prop } })),
  focusFormula: (type, prop) => set((s) => ({ lastProp: { ...s.lastProp, [type]: prop }, focusToken: s.focusToken + 1 })),
}))
