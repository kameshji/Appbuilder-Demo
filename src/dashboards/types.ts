/**
 * Dashboard definitions (P2-C): stored as JSON (ab_dashboards.def on the server, browser storage in demo mode). Pure types
 * plus validation, shared by the browser and the server. docs/dev/dashboards.md.
 */
import type { ChartKind, SeriesSpec, StatusRule } from '../charts/geometry.ts'
import type { NumberFormat } from '../charts/format.ts'
import type { QuerySpec } from './measures.ts'
import type { RangePreset } from './dates.ts'
import { RANGE_PRESETS } from './dates.ts'
import { CHART_KINDS } from '../charts/geometry.ts'

export type TileKind = ChartKind | 'table' | 'text'
export const TILE_KINDS: TileKind[] = [...CHART_KINDS, 'table', 'text']

export interface TileVisual {
  /** x of cartesian charts, labels of pie / funnel: a group column or "__bucket" */
  category?: string
  series?: SeriesSpec[]
  stack?: 'none' | 'stacked' | 'percent'
  orientation?: 'vertical' | 'horizontal'
  curve?: 'linear' | 'step'
  format?: NumberFormat
  bands?: { from: number; to: number; status?: 'good' | 'warn' | 'bad' }[]
  min?: number
  max?: number
  target?: number
  /** KPI: the measure shown, compared with the previous period (`compare` in the query) or the target */
  kpi?: { measure: string; base?: 'compare' | 'target'; higherIsBetter?: boolean; rules?: StatusRule[]; spark?: string }
  /** table tile: conditional formatting of measure cells */
  rules?: { measure: string; op: 'lt' | 'le' | 'gt' | 'ge'; value: number; status: 'good' | 'warn' | 'bad' }[]
  /** heat map: the row field (a group column or "__bucket") */
  row?: string
  dataLabels?: boolean
}

export interface TileDef {
  id: string
  title: string
  kind: TileKind
  query?: QuerySpec
  visual?: TileVisual
  /** markdown-lite text of a text tile */
  text?: string
  /** 12-column grid: column 0-11, row (80 px units), width in columns, height in rows */
  layout: { x: number; y: number; w: number; h: number }
  /** clicking a category filters the other tiles on the same table by that group column */
  crossFilter?: boolean
}

export interface DashboardFilterDef {
  id: string
  label: string
  /** the column filtered (on every tile whose table has it) */
  column: string
  /** the values offered */
  options: string[]
}

export interface DashboardDef {
  version: 1
  title: string
  description?: string
  range: RangePreset
  /** seconds; 0 = off (minimum 15) */
  refreshSeconds?: number
  filters?: DashboardFilterDef[]
  tiles: TileDef[]
}

export interface DashboardInfo {
  id: string
  name: string
  def: DashboardDef
  ownerId: string
  /** role ids that may view; empty = the owner, makers and administrators only */
  roles: string[]
  modifiedOn: string
  canEdit: boolean
}

export const MAX_TILES = 40

/** structural check of a definition (throws with a readable message); returns a cleaned copy */
export function checkDashboardDef(raw: unknown): DashboardDef {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!o) throw new Error('The dashboard definition must be an object.')
  const title = String(o.title ?? '').trim().slice(0, 200)
  if (!title) throw new Error('A dashboard needs a title.')
  const range = RANGE_PRESETS.some((p) => p.key === o.range) ? (o.range as RangePreset) : 'thisMonth'
  const refresh = Number(o.refreshSeconds ?? 0)
  if (!Array.isArray(o.tiles)) throw new Error('tiles must be a list.')
  if (o.tiles.length > MAX_TILES) throw new Error(`A dashboard has at most ${MAX_TILES} tiles.`)
  const ids = new Set<string>()
  const tiles = (o.tiles as unknown[]).map((t, i) => {
    const x = t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
    const id = String(x.id ?? `t${i + 1}`)
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || ids.has(id)) throw new Error(`Tile ${i + 1} needs a unique id.`)
    ids.add(id)
    if (!TILE_KINDS.includes(x.kind as TileKind)) throw new Error(`Tile ${id}: unknown kind ${String(x.kind)}.`)
    const l = (x.layout && typeof x.layout === 'object' ? x.layout : {}) as Record<string, unknown>
    const int = (v: unknown, d: number, lo: number, hi: number) => (Number.isInteger(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d)
    const layout = { x: int(l.x, 0, 0, 11), y: int(l.y, i * 3, 0, 500), w: int(l.w, 4, 1, 12), h: int(l.h, 3, 1, 12) }
    if (layout.x + layout.w > 12) layout.x = 12 - layout.w
    if (x.kind !== 'text' && (!x.query || typeof x.query !== 'object')) throw new Error(`Tile ${id} needs a query.`)
    const out: TileDef = { id, title: String(x.title ?? '').slice(0, 200), kind: x.kind as TileKind, layout }
    if (x.query) out.query = x.query as QuerySpec
    if (x.visual && typeof x.visual === 'object') out.visual = x.visual as TileVisual
    if (typeof x.text === 'string') out.text = x.text.slice(0, 4000)
    if (x.crossFilter === true) out.crossFilter = true
    return out
  })
  if (JSON.stringify(tiles).length > 256 * 1024) throw new Error('The dashboard definition is too large.')
  const filters = Array.isArray(o.filters) ? (o.filters as Record<string, unknown>[]).slice(0, 10).map((f, i) => ({
    id: String(f.id ?? `f${i + 1}`).slice(0, 40), label: String(f.label ?? f.column ?? '').slice(0, 100), column: String(f.column ?? '').slice(0, 64),
    options: Array.isArray(f.options) ? f.options.slice(0, 200).map(String) : [],
  })).filter((f) => f.column) : []
  return { version: 1, title, ...(typeof o.description === 'string' ? { description: o.description.slice(0, 1000) } : {}), range, refreshSeconds: refresh >= 15 ? Math.min(3600, Math.trunc(refresh)) : 0, filters, tiles }
}
