/**
 * Dashboards backend for the browser (P2-C). Server mode: /api/v1/dashboards (stored definitions, settings, the batch
 * query endpoint, one round trip per refresh). Demo mode: definitions in browser storage, every plan through
 * platform.tables.query (the reference executor over the rows the current user may read), so one viewer works in both.
 */
import { PlatformError, platform } from '@/platform'
import type { ColumnType } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import type { QueryPlan } from '@/platform/query'
import type { QueryValue } from '@/platform/http'
import { rowsFromWire } from '@/platform/query-wire'
import type { FxRecord } from '@/contracts'
import type { DashboardDef, DashboardInfo } from '@/dashboards/types'
import { checkDashboardDef } from '@/dashboards/types'
import type { CalendarSettings } from '@/dashboards/dates'
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
const isServer = () => platform.getState().mode === 'server'
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
    return DEFAULT_SETTINGS
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
