/**
 * A stored dashboard computed ON THE SERVER for one identity (P2-C second wave; docs/dev/dashboards.md "Server-side
 * compute"). The view-token endpoint and scheduled snapshots never take plans from a client: the server compiles the
 * tiles of the stored definition itself (`buildBatch`, the viewer's own code) with a date range, dashboard filter values
 * and a cross-filter that are checked against the definition, then runs the plans with `runBatch` as the identity
 * (row and column security in the statement) and assembles the tiles (`assemble`). Also: who may open / change a
 * dashboard and the environment's dashboard settings.
 */
import type { CoreServices } from '../services.ts'
import type { SqlDb, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { DashboardDef } from '../../../src/dashboards/types.ts'
import { DEFAULT_CALENDAR, RANGE_PRESETS, localNow, resolvePreset } from '../../../src/dashboards/dates.ts'
import type { CalendarSettings, DateRange, RangePreset } from '../../../src/dashboards/dates.ts'
import { assemble, buildBatch } from '../../../src/dashboards/viewer.ts'
import type { BatchAnswer, CrossFilter, TileData } from '../../../src/dashboards/viewer.ts'
import { DEFAULT_FORMAT } from '../../../src/charts/format.ts'
import { isTimeZone } from '../../../src/fx/query/buckets.ts'
import { currentEnvironment } from '../env-context.ts'
import { hasAnyTableAccess } from '../security.ts'
import { runBatch, type BatchResult } from './batch.ts'

export interface DashboardSettings extends CalendarSettings { locale: string; currency: string }
export const DEFAULT_SETTINGS: DashboardSettings = { ...DEFAULT_CALENDAR, locale: DEFAULT_FORMAT.locale, currency: DEFAULT_FORMAT.currency }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const T = (t: string) => `"${currentEnvironment().schema}"."${t}"`

export function parseSettings(raw: unknown): DashboardSettings {
  const o = isObj(raw) ? raw : {}
  const s: DashboardSettings = { ...DEFAULT_SETTINGS }
  if (typeof o.locale === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(o.locale)) s.locale = o.locale
  if (typeof o.currency === 'string' && /^[A-Za-z]{3}$/.test(o.currency)) s.currency = o.currency.toUpperCase()
  if (isTimeZone(o.timeZone)) s.timeZone = o.timeZone
  if (Number.isInteger(o.fiscalYearStart) && (o.fiscalYearStart as number) >= 1 && (o.fiscalYearStart as number) <= 12) s.fiscalYearStart = o.fiscalYearStart as number
  if (o.weekStart === 1 || o.weekStart === 7) s.weekStart = o.weekStart
  if (Array.isArray(o.shifts)) {
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/
    s.shifts = o.shifts.filter(isObj).slice(0, 6).map((x) => ({ name: String(x.name ?? '').slice(0, 20), start: String(x.start ?? ''), end: String(x.end ?? '') })).filter((x) => x.name && hm.test(x.start) && hm.test(x.end))
  }
  return s
}

export async function loadSettings(db: SqlDb): Promise<DashboardSettings> {
  const rows = await db.query<{ v: unknown }>(`SELECT v FROM ${T('ab_dashboard_settings')} WHERE k = 'defaults'`)
  return parseSettings(rows[0]?.v)
}

export interface DashboardRow { id: string; name: string; owner_id: string; roles: string[]; def: DashboardDef; modified_on: unknown }

/** who may open a dashboard: administrators, makers, the owner, anyone holding a listed viewer role */
export function canView(who: UserContext, r: { owner_id: string; roles: string[] }): boolean {
  return who.privileges.isAdmin || who.privileges.isMaker || r.owner_id === who.user.id || (r.roles ?? []).some((id) => who.roles.some((x) => x.id === id))
}
/** who may change it (and manage its view tokens): administrators, or the owner while a maker */
export const canEdit = (who: UserContext, r: { owner_id: string }): boolean => who.privileges.isAdmin || (who.privileges.isMaker && r.owner_id === who.user.id)

export async function dashboardRow(db: SqlDb, id: string): Promise<DashboardRow | null> {
  const r = (await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_dashboards')} WHERE id = $1`, [id]))[0]
  if (!r) return null
  return { id: String(r.id), name: String(r.name), owner_id: String(r.owner_id), roles: Array.isArray(r.roles) ? (r.roles as string[]) : [], def: r.def as DashboardDef, modified_on: r.modified_on }
}

/* ------------------------------------------------------------------ choices */

export interface ServerChoices {
  range: DateRange | null
  filters: Record<string, string>
  cross: CrossFilter | null
  /** the local date-time in the dashboard time zone (server clock) */
  now: string
}

const LOCAL = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/

/**
 * Checks what a request may choose against the stored definition (422 otherwise): `range` a preset key, `null` (all
 * time) or `{ from, to }` (local date-times, from before to); `filters` only the dashboard's own filter ids, a value
 * among the filter's options when it lists any; `cross` only from a tile marked crossFilter, on one of its group
 * columns. Nothing else of the request reaches the plans: tables, measures and conditions come from the definition.
 */
export function checkChoices(def: DashboardDef, raw: unknown, settings: CalendarSettings, at: Date = new Date()): ServerChoices {
  const b = isObj(raw) ? raw : {}
  const bad = (m: string, f: string) => new HttpError(422, 'invalid', m, f)
  let range: DateRange | null
  if (b.range === undefined) range = resolvePreset(def.range, at, settings)
  else if (b.range === null) range = null
  else if (typeof b.range === 'string') {
    if (!RANGE_PRESETS.some((p) => p.key === b.range)) throw bad(`Unknown date range "${b.range.slice(0, 40)}".`, 'range')
    range = resolvePreset(b.range as RangePreset, at, settings)
  } else if (isObj(b.range) && typeof b.range.from === 'string' && typeof b.range.to === 'string' && LOCAL.test(b.range.from) && LOCAL.test(b.range.to) && b.range.from < b.range.to) {
    range = { from: b.range.from, to: b.range.to }
  } else throw bad('range is a preset name, null (all time) or { from, to } as YYYY-MM-DDTHH:MM with from before to.', 'range')
  const filters: Record<string, string> = {}
  if (b.filters !== undefined) {
    if (!isObj(b.filters)) throw bad('filters maps dashboard filter ids to a value.', 'filters')
    for (const [k, v] of Object.entries(b.filters)) {
      const f = (def.filters ?? []).find((x) => x.id === k)
      if (!f) throw bad(`This dashboard has no filter "${k.slice(0, 40)}".`, 'filters')
      if (v === '' || v === null || v === undefined) continue
      if (typeof v !== 'string' || v.length > 200) throw bad(`The value of the filter "${f.label}" must be text.`, 'filters')
      if (f.options.length && !f.options.includes(v)) throw bad(`"${v.slice(0, 40)}" is not one of the values of the filter "${f.label}".`, 'filters')
      filters[k] = v
    }
  }
  let cross: CrossFilter | null = null
  if (b.cross !== undefined && b.cross !== null) {
    const c = isObj(b.cross) ? b.cross : {}
    const tile = def.tiles.find((t) => t.id === c.tileId)
    if (!tile || !tile.crossFilter || !tile.query) throw bad('A cross-filter comes from a tile of this dashboard that allows it.', 'cross')
    const column = String(c.column ?? '')
    if (!(tile.query.groupBy ?? []).includes(column)) throw bad('A cross-filter filters by a group column of its tile.', 'cross')
    const v = c.value
    if (!(v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) || (typeof v === 'string' && v.length > 200)) throw bad('A cross-filter value is text, a number, yes / no or blank.', 'cross')
    cross = { tileId: tile.id, table: tile.query.table, column, value: v }
  }
  return { range, filters, cross, now: localNow(at, settings.timeZone) }
}

/* ------------------------------------------------------------------ compute */

export interface ComputedDashboard {
  results: BatchResult[]
  /** compile messages per tile id (a tile whose spec does not compile; the others still load) */
  errors: Record<string, string>
  tiles: Record<string, TileData>
  range: DateRange | null
  now: string
}

/** the column names `who` sees on a table (by id or name), or null when they cannot see it */
export async function columnsFor(services: CoreServices, who: UserContext): Promise<(table: string) => string[] | null> {
  const all = await services.meta.tables.list()
  return (name: string) => {
    const t = all.find((x) => x.id === name) ?? all.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!t || (!who.privileges.isMaker && !hasAnyTableAccess(who, t))) return null
    return who.visibleDef(t).columns.map((c) => c.name)
  }
}

export function toAnswers(results: BatchResult[]): BatchAnswer[] {
  return results.map((r) => ({ id: r.id, ok: r.ok, rows: (r.rows ?? []) as Record<string, unknown>[], ms: r.ms, ...(r.error ? { error: r.error.message, status: r.error.status } : {}), ...(r.filtered ? { filtered: true } : {}), ...(r.truncated ? { truncated: true } : {}) }))
}

/** compiles every tile of the stored definition and runs them as `who` */
export async function computeDashboard(services: CoreServices, who: UserContext, def: DashboardDef, choices: ServerChoices, settings: CalendarSettings, o: { noCache?: boolean } = {}): Promise<ComputedDashboard> {
  const columns = await columnsFor(services, who)
  const { queries, errors } = buildBatch(def, { range: choices.range, filters: choices.filters, cross: choices.cross, calendar: settings, now: choices.now, columns })
  const results = queries.length ? await runBatch(services, who, queries, { noCache: o.noCache }) : []
  const tiles = assemble(def, { range: choices.range, calendar: settings, now: choices.now }, toAnswers(results), errors)
  return { results, errors, tiles, range: choices.range, now: choices.now }
}
