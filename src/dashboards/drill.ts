/**
 * Drill-through from a tile to an app (P2-C), pure: no React, DOM or packages; shared-code rules. The only start-parameter
 * mechanism the app runtime has is the address: `#u-<appId>?name=value`, read inside the app with Param("name")
 * (src/runtime/evaluator.ts). Since P3-D the reserved parameter `screen` names the screen to open
 * (`#u-<appId>?screen=<name>&name=value`; src/runtime/startparams.ts reads it, an unknown name opens the start screen).
 * A drill target is an app, optionally a screen of it, plus the values to pass. docs/dev/dashboards.md ("Drill-through").
 */
import type { TileDef, TileDrill } from './types.ts'
import { DRILL_SCREEN_PARAM, MAX_DRILL_PARAMS } from './types.ts'

/** a value the clicked row can hand to the app */
export interface DrillField { field: string; label: string }

/** the fields of a tile's result rows that can be passed: group columns, the date grouping, measures and calculations */
export function drillFields(tile: TileDef): DrillField[] {
  const q = tile.query
  if (!q) return []
  const out: DrillField[] = (q.groupBy ?? []).map((g) => ({ field: g, label: g }))
  if (q.bucket) out.push({ field: '__bucket', label: `${q.bucket.col} (the date grouping)` })
  for (const m of q.measures) out.push({ field: m.id, label: m.label ?? m.id })
  for (const c of q.computed ?? []) out.push({ field: c.id, label: c.label ?? c.id })
  return out
}

/** a parameter name made from a field: letters, digits and _ (the date grouping becomes "date") */
export function paramNameOf(field: string): string {
  if (field === '__bucket') return 'date'
  let n = field.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 41)
  if (!/^[A-Za-z_]/.test(n)) n = `p${n}`.slice(0, 41)
  if (n.toLowerCase() === DRILL_SCREEN_PARAM) n = `${n}_value` // "screen" is the address's word for the screen to open
  return n
}

/** the parameters a new drill passes by default: the first group column, else the date grouping */
export function defaultDrillParams(tile: TileDef): NonNullable<TileDrill['params']> {
  const q = tile.query
  const f = q?.groupBy?.[0] ?? (q?.bucket ? '__bucket' : undefined)
  return f ? [{ name: paramNameOf(f), field: f }] : []
}

const pad = (n: number) => String(n).padStart(2, '0')

/** a row value as address text; null when there is nothing to pass (blank values are not sent) */
export function paramText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    const local = v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0 && v.getMilliseconds() === 0
    return local ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : v.toISOString()
  }
  if (typeof v === 'object') return null
  return String(v)
}

/** the name / value pairs of a click (no row: none) */
export function drillValues(drill: TileDrill, row: Record<string, unknown> | undefined): [string, string][] {
  if (!row) return []
  const out: [string, string][] = []
  for (const p of (drill.params ?? []).slice(0, MAX_DRILL_PARAMS)) {
    const t = paramText(row[p.field])
    if (t !== null) out.push([p.name, t])
  }
  return out
}

const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+')

/**
 * The address that opens the app with the clicked values: `#u-<appId>`, `#u-<appId>?Machine=Press+1&date=2026-03-01`, and
 * with a screen `#u-<appId>?screen=Machine+detail&Machine=Press+1`. `screen` is always the first parameter and is never
 * also a value (a value cannot be named "screen": checkDashboardDef refuses it, and it is skipped here for a hand-made drill).
 */
export function drillHash(drill: TileDrill, row?: Record<string, unknown>): string {
  const parts: string[] = []
  if (drill.screen && drill.screen.trim()) parts.push(`${DRILL_SCREEN_PARAM}=${enc(drill.screen.trim())}`)
  for (const [k, v] of drillValues(drill, row)) if (k.toLowerCase() !== DRILL_SCREEN_PARAM) parts.push(`${enc(k)}=${enc(v)}`)
  return `#u-${drill.appId}${parts.length ? `?${parts.join('&')}` : ''}`
}

/** the target in words, for the tile editor */
export function describeDrill(drill: TileDrill, appName: string, labelOf: (field: string) => string = (f) => f): string {
  const ps = drill.params ?? []
  const where = drill.screen ? `the screen "${drill.screen}" of ${appName}` : appName
  if (!ps.length) return `Clicking opens ${where}.`
  return `Clicking opens ${where} and passes ${ps.map((p) => `${labelOf(p.field)} as ${p.name}`).join(', ')}; the app reads them with Param("${ps[0]!.name}").`
}
