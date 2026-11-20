/**
 * Dashboards backend for the browser (P2-C). Server mode: /api/v1/dashboards (stored definitions, settings, the batch
 * query endpoint, one round trip per refresh). Demo mode: definitions in browser storage, every plan through
 * platform.tables.query (the reference executor over the rows the current user may read), so one viewer works in both.
 * View tokens and email snapshots exist only on the server; pinned tiles are kept in browser storage in demo mode. The kiosk
 * page does NOT use this module (it must not send the session cookie or the CSRF header): see KioskPage.tsx.
 */
import { PlatformError, platform } from '@/platform'
import type { ColumnType } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import type { QueryPlan } from '@/platform/query'
import type { QueryValue } from '@/platform/http'
import { rowsFromWire } from '@/platform/query-wire'
import type { FxRecord } from '@/contracts'
import type { DashboardDef, DashboardInfo, TileDef } from '@/dashboards/types'
import { checkDashboardDef } from '@/dashboards/types'
import type { CalendarSettings, RangePreset } from '@/dashboards/dates'
import type { ReportSchedule } from '../actionsApi'
import { DEFAULT_CALENDAR } from '@/dashboards/dates'

export interface DashboardSettings extends CalendarSettings { locale: string; currency: string }
export const DEFAULT_SETTINGS: DashboardSettings = { ...DEFAULT_CALENDAR, locale: 'en-IN', currency: 'INR' }

export interface TileResult { id: string; ok: boolean; rows: FxRecord[]; filtered?: boolean; truncated?: boolean; cached?: boolean; ms: number; error?: string; status?: number }

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { [CSRF_HEADER]: '1', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...environmentHeaders() },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) {
    let b: { error?: { code?: PlatformError['code']; message?: string } } | null = null
    try { b = await res.json() } catch { /* not JSON */ }
    throw new PlatformError(b?.error?.code ?? (res.status === 403 ? 'denied' : res.status === 404 ? 'not-found' : 'invalid'), b?.error?.message ?? `The server answered ${res.status}`)
  }
  return (await res.json()) as T
}

const DEMO_KEY = 'appbuilder-dashboards'
function demoAll(): DashboardInfo[] {
  try { return JSON.parse(localStorage.getItem(DEMO_KEY) ?? '[]') as DashboardInfo[] } catch { return [] }
}
function demoSave(list: DashboardInfo[]): void {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(list)) } catch { throw new PlatformError('storage', 'The browser storage is full.') }
}
const DEMO_SETTINGS_KEY = 'appbuilder-dashboard-settings'
function demoSettings(): DashboardSettings {
  try {
    const o = JSON.parse(localStorage.getItem(DEMO_SETTINGS_KEY) ?? 'null') as Partial<DashboardSettings> | null
    return o && typeof o === 'object' ? { ...DEFAULT_SETTINGS, ...o } : DEFAULT_SETTINGS
  } catch { return DEFAULT_SETTINGS }
}
const isServer = () => platform.getState().mode === 'server'
const needServer = (what: string) => { if (!isServer()) throw new PlatformError('unavailable', `${what} need the server (start Appbuilder with npm start).`) }

/* view tokens, snapshots and pins: the server's shapes (server/core/dashboards/tokens.ts, snapshots.ts, pins.ts) */
export interface ViewTokenInfo {
  id: string; dashboardId: string; label: string; prefix: string
  viewAs: { kind: 'creator' | 'service'; userId: string; name: string | null }
  createdBy: string; createdOn: string; expiresOn: string | null; lastUsedOn: string | null; revokedOn: string | null
  status: 'active' | 'revoked' | 'expired'
}
export interface NewViewToken extends ViewTokenInfo { token: string; warnings: string[] }
export interface SnapshotDefInfo { name: string; schedule: ReportSchedule; recipients: { userIds: string[]; teamIds: string[] }; range?: RangePreset; filters?: Record<string, string>; optOut?: string[] }
export interface SnapshotInfo {
  id: string; dashboardId: string; name: string; ownerId: string; enabled: boolean; def: SnapshotDefInfo; scheduleText: string; nextRunAt: string | null
  lastRun: { id: string; startedOn: string; status: string; message: string | null } | null; createdOn: string; modifiedOn: string; canEdit: boolean
}
export interface SnapshotInput { name?: string; schedule: ReportSchedule; recipients?: { userIds: string[]; teamIds: string[] }; range?: RangePreset | null; filters?: Record<string, string>; enabled?: boolean }
export interface SnapshotRun {
  id: string; startedOn: string; finishedOn: string | null; status: string; trigger: string; message: string | null
  recipients: { userId: string; status: 'sent' | 'skipped' | 'failed'; mailId?: string; pages?: number; reason?: string }[]
}
export interface PinRef { dashboardId: string; tileId: string }
export type PinView =
  | { dashboardId: string; tileId: string; available: true; dashboardName: string; range: RangePreset; tile: TileDef }
  | { dashboardId: string; tileId: string; available: false }
export const MAX_PINS = 24
const DEMO_PINS_KEY = 'appbuilder-dashboard-pins'
const pinKey = (p: PinRef) => `${p.dashboardId}\u0000${p.tileId}`
function demoPins(): PinRef[] {
  try {
    const v = JSON.parse(localStorage.getItem(DEMO_PINS_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is PinRef => !!x && typeof x.dashboardId === 'string' && typeof x.tileId === 'string').slice(0, MAX_PINS) : []
  } catch { return [] }
}
function demoResolvePins(items: PinRef[]): PinView[] {
  const all = demoAll()
  return items.map((p) => {
    const d = all.find((x) => x.id === p.dashboardId)
    const tile = d?.def.tiles.find((t) => t.id === p.tileId)
    return d && tile ? { ...p, available: true as const, dashboardName: d.name, range: d.def.range, tile } : { ...p, available: false as const }
  })
}
const me = () => platform.getState().session?.user.id ?? platform.getState().currentUserId ?? 'me'

function tableTypes(name: string): Record<string, ColumnType> {
  const t = platform.tables.get(name)
  return t ? Object.fromEntries(t.columns.map((c) => [c.name, c.type])) : {}
}

export const dashboardsApi = {
  async list(): Promise<DashboardInfo[]> {
    if (isServer()) return (await call<{ items: DashboardInfo[] }>('GET', '/dashboards')).items
    return demoAll()
  },
  async get(id: string): Promise<DashboardInfo> {
    if (isServer()) return call<DashboardInfo>('GET', `/dashboards/${encodeURIComponent(id)}`)
    const d = demoAll().find((x) => x.id === id)
    if (!d) throw new PlatformError('not-found', 'Dashboard not found.')
    return d
  },
  async create(def: DashboardDef, roles: string[] = []): Promise<DashboardInfo> {
    if (isServer()) return call<DashboardInfo>('POST', '/dashboards', { def, roles })
    const clean = checkDashboardDef(def)
    const d: DashboardInfo = { id: `dsh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean.title, def: clean, ownerId: me(), roles, modifiedOn: new Date().toISOString(), canEdit: true }
    demoSave([...demoAll(), d])
    return d
  },
  async update(id: string, patch: { name?: string; def?: DashboardDef; roles?: string[] }): Promise<DashboardInfo> {
    if (isServer()) return call<DashboardInfo>('PATCH', `/dashboards/${encodeURIComponent(id)}`, patch)
    const list = demoAll()
    const i = list.findIndex((x) => x.id === id)
    if (i < 0) throw new PlatformError('not-found', 'Dashboard not found.')
    const def = patch.def ? checkDashboardDef(patch.def) : list[i]!.def
    list[i] = { ...list[i]!, def, name: patch.name ?? def.title, roles: patch.roles ?? list[i]!.roles, modifiedOn: new Date().toISOString() }
    demoSave(list)
    return list[i]!
  },
  async remove(id: string): Promise<void> {
    if (isServer()) { await call('DELETE', `/dashboards/${encodeURIComponent(id)}`); return }
    demoSave(demoAll().filter((x) => x.id !== id))
  },
  async settings(): Promise<DashboardSettings> {
    if (isServer()) return (await call<{ settings: DashboardSettings }>('GET', '/dashboards/settings')).settings
    return demoSettings()
  },
  /** administrators only on the server (403 otherwise); demo mode keeps the values in browser storage */
  async saveSettings(s: DashboardSettings): Promise<DashboardSettings> {
    if (isServer()) return (await call<{ settings: DashboardSettings }>('PUT', '/dashboards/settings', { settings: s })).settings
    try { localStorage.setItem(DEMO_SETTINGS_KEY, JSON.stringify(s)) } catch { throw new PlatformError('storage', 'The browser storage is full.') }
    return s
  },
  /* ---------------------------------------------------------------- view tokens (server only) */
  async tokens(id: string): Promise<ViewTokenInfo[]> {
    needServer('View tokens')
    return (await call<{ items: ViewTokenInfo[] }>('GET', `/dashboards/${encodeURIComponent(id)}/tokens`)).items
  },
  async createToken(id: string, body: { label: string; expiresOn?: string | null; viewAs?: 'creator' | { serviceAccount: string } }): Promise<NewViewToken> {
    needServer('View tokens')
    return call<NewViewToken>('POST', `/dashboards/${encodeURIComponent(id)}/tokens`, body)
  },
  async revokeToken(id: string, tokenId: string): Promise<void> {
    needServer('View tokens')
    await call('DELETE', `/dashboards/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}`)
  },
  /* ---------------------------------------------------------------- email snapshots (server only) */
  async snapshots(id: string): Promise<SnapshotInfo[]> {
    needServer('Email snapshots')
    return (await call<{ items: SnapshotInfo[] }>('GET', `/dashboards/${encodeURIComponent(id)}/snapshots`)).items
  },
  async createSnapshot(id: string, body: SnapshotInput): Promise<SnapshotInfo> {
    needServer('Email snapshots')
    return call<SnapshotInfo>('POST', `/dashboards/${encodeURIComponent(id)}/snapshots`, body)
  },
  async updateSnapshot(sid: string, body: Partial<SnapshotInput>): Promise<SnapshotInfo> {
    return call<SnapshotInfo>('PATCH', `/dashboards/snapshots/${encodeURIComponent(sid)}`, body)
  },
  async removeSnapshot(sid: string): Promise<void> {
    await call('DELETE', `/dashboards/snapshots/${encodeURIComponent(sid)}`)
  },
  async runSnapshot(sid: string): Promise<{ jobId: string }> {
    return call<{ jobId: string }>('POST', `/dashboards/snapshots/${encodeURIComponent(sid)}/run`)
  },
  async snapshotRuns(sid: string): Promise<SnapshotRun[]> {
    return (await call<{ items: SnapshotRun[] }>('GET', `/dashboards/snapshots/${encodeURIComponent(sid)}/runs`)).items
  },
  /* ---------------------------------------------------------------- pinned tiles (server: ab.user_settings; demo: browser storage) */
  async pins(): Promise<PinView[]> {
    if (isServer()) return (await call<{ items: PinView[] }>('GET', '/dashboards/pins')).items
    return demoResolvePins(demoPins())
  },
  /** the whole list (pin, unpin, reorder) */
  async savePins(items: PinRef[]): Promise<PinView[]> {
    if (isServer()) return (await call<{ items: PinView[] }>('PUT', '/dashboards/pins', { items: items.map((p) => ({ dashboardId: p.dashboardId, tileId: p.tileId })) })).items
    if (items.length > MAX_PINS) throw new PlatformError('invalid', `You can pin at most ${MAX_PINS} tiles.`)
    const had = new Set(demoPins().map(pinKey))
    for (const p of items) if (!had.has(pinKey(p)) && !demoAll().some((d) => d.id === p.dashboardId && d.def.tiles.some((t) => t.id === p.tileId))) throw new PlatformError('not-found', 'Tile not found.')
    const clean = [...new Map(items.map((p) => [pinKey(p), { dashboardId: p.dashboardId, tileId: p.tileId }])).values()]
    try { localStorage.setItem(DEMO_PINS_KEY, JSON.stringify(clean)) } catch { throw new PlatformError('storage', 'The browser storage is full.') }
    return demoResolvePins(clean)
  },
  /** every plan of a refresh in one round trip (server) or through the local executor (demo) */
  async query(queries: { id: string; plan: QueryPlan }[]): Promise<TileResult[]> {
    if (!queries.length) return []
    if (isServer()) {
      const r = await call<{ results: { id: string; ok: boolean; rows?: Record<string, QueryValue>[]; filtered?: boolean; truncated?: boolean; cached?: boolean; ms: number; error?: { status: number; message: string } }[] }>('POST', '/dashboards/query', { queries })
      return r.results.map((x) => {
        const plan = queries.find((q) => q.id === x.id)!.plan
        return { id: x.id, ok: x.ok, rows: x.ok ? rowsFromWire(plan, x.rows ?? [], tableTypes(plan.table)) : [], filtered: x.filtered, truncated: x.truncated, cached: x.cached, ms: x.ms, ...(x.error ? { error: x.error.message, status: x.error.status } : {}) }
      })
    }
    return Promise.all(queries.map(async (q) => {
      const t0 = performance.now()
      try {
        const s = await platform.tables.query(q.plan)
        if (s.status === 'error') return { id: q.id, ok: false, rows: [], ms: performance.now() - t0, error: s.error?.message ?? 'The query failed.' }
        return { id: q.id, ok: true, rows: s.rows as FxRecord[], ms: performance.now() - t0 }
      } catch (e) {
        return { id: q.id, ok: false, rows: [], ms: performance.now() - t0, error: e instanceof Error ? e.message : String(e) }
      }
    }))
  },
}
