/**
 * Flow definitions and their satellites in the environment schema (docs/dev/flows.md "Tables"): ab_flows (current
 * definition), ab_flow_versions (history), ab_flow_connections (connection references and who granted them),
 * ab_flow_run_grants (roles that may run a flow; '*' = every flow), ab_flow_settings (kill switch, limits),
 * health of the run history.
 */
import type { MetaStore, SqlDb } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { currentEnvironment } from '../env-context.ts'
import {
  DEFAULT_SETTINGS, type FlowConnectionRef, type FlowDef, type FlowDefinition, type FlowHealth, type FlowVersionInfo, type RunAs, type RunStatus,
} from '../../../src/platform/flows.ts'

type Row = Record<string, unknown>
const q = (id: string): string => `"${id}"`
export const T = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())
/** jsonb columns arrive parsed (pg); a jsonb text is a JS string */
const parse = <X>(v: unknown, d: X): X => (v === null || v === undefined ? d : v as X)

/** the document a version stores: everything a maker edits */
export interface FlowDoc extends FlowDefinition { name: string; description?: string; runAs: RunAs }

/** the designer's unpublished draft (package B) */
export interface FlowDraft { doc: FlowDoc; connections: Record<string, string>; baseVersion: number; savedBy?: string; savedByName?: string; savedOn: string }

export interface EnvFlowSettings {
  /** kill switch: no run starts or continues while paused (triggers still record their runs) */
  paused: boolean
  pausedBy?: string
  pausedOn?: string
  /** runs per minute of the whole environment */
  environmentRunsPerMinute: number
}

export function toFlowDef(r: Row, connections: FlowConnectionRef[] = []): FlowDef {
  const d = parse<Partial<FlowDefinition>>(r.definition, {})
  const f: FlowDef = {
    id: String(r.id), name: String(r.name), enabled: r.enabled === true, version: Number(r.version) || 1,
    runAs: parse<RunAs>(r.run_as, 'owner'), ownerId: String(r.owner_id), connections,
    trigger: d.trigger as FlowDef['trigger'], steps: d.steps ?? [], ...(d.variables ? { variables: d.variables } : {}),
    settings: { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) },
    createdOn: iso(r.created_on), modifiedOn: iso(r.modified_on),
  }
  if (r.description) f.description = String(r.description)
  if (r.solution_id) f.solutionId = String(r.solution_id)
  if (r.suspended) f.suspended = String(r.suspended)
  if (r.modified_by) f.modifiedBy = String(r.modified_by)
  return f
}

export const docOf = (f: FlowDef): FlowDoc => ({
  name: f.name, ...(f.description ? { description: f.description } : {}), runAs: f.runAs,
  trigger: f.trigger, steps: f.steps, ...(f.variables ? { variables: f.variables } : {}), settings: f.settings,
})

export type FlowStore = ReturnType<typeof createFlowStore>

export function createFlowStore(deps: { db(): SqlDb | null; meta(): MetaStore }) {
  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const settingsCache = new Map<string, { at: number; v: EnvFlowSettings }>()

  async function connections(flowId: string): Promise<FlowConnectionRef[]> {
    const rows = await db().query<Row>(
      `SELECT fc.ref, fc.connection_id, fc.granted_by, fc.granted_on, c.name, c.connector FROM ${T('ab_flow_connections')} fc
       LEFT JOIN ${T('ab_connections')} c ON c.id = fc.connection_id WHERE fc.flow_id = $1 ORDER BY fc.ref`, [flowId],
    )
    return rows.map((r) => ({
      ref: String(r.ref), connectionId: String(r.connection_id), ...(r.name ? { connectionName: String(r.name) } : {}), ...(r.connector ? { connector: String(r.connector) } : {}),
      ...(r.granted_by ? { grantedBy: String(r.granted_by) } : {}), grantedOn: iso(r.granted_on),
    }))
  }

  async function get(id: string): Promise<FlowDef | null> {
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_flows')} WHERE id = $1`, [id])
    return rows.length ? toFlowDef(rows[0], await connections(id)) : null
  }

  async function byName(name: string): Promise<FlowDef | null> {
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_flows')} WHERE lower(name) = lower($1)`, [name])
    return rows.length ? toFlowDef(rows[0], await connections(String(rows[0].id))) : null
  }

  /** by id, then by name */
  async function resolve(idOrName: string): Promise<FlowDef | null> {
    return (await get(idOrName)) ?? (await byName(idOrName))
  }

  async function list(): Promise<FlowDef[]> {
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_flows')} ORDER BY lower(name), id`)
    const conns = await db().query<Row>(`SELECT fc.flow_id, fc.ref, fc.connection_id, fc.granted_by, fc.granted_on, c.name, c.connector FROM ${T('ab_flow_connections')} fc LEFT JOIN ${T('ab_connections')} c ON c.id = fc.connection_id`)
    const by = new Map<string, FlowConnectionRef[]>()
    for (const r of conns) {
      const k = String(r.flow_id)
      by.set(k, [...(by.get(k) ?? []), { ref: String(r.ref), connectionId: String(r.connection_id), ...(r.name ? { connectionName: String(r.name) } : {}), ...(r.connector ? { connector: String(r.connector) } : {}), ...(r.granted_by ? { grantedBy: String(r.granted_by) } : {}), grantedOn: iso(r.granted_on) }])
    }
    return rows.map((r) => toFlowDef(r, by.get(String(r.id)) ?? []))
  }

  /** a new flow (version 1); joins the caller's transaction */
  async function insert(f: { id: string; doc: FlowDoc; ownerId: string; enabled: boolean; solutionId?: string | null; by: string | null; note?: string; version?: number }): Promise<void> {
    const now = new Date()
    const { name, description, runAs, ...def } = f.doc
    const version = f.version ?? 1
    try {
      await db().exec(
        `INSERT INTO ${T('ab_flows')} (id, name, description, definition, enabled, version, owner_id, run_as, solution_id, created_by, created_on, modified_by, modified_on)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10, $11, $10, $11)`,
        [f.id, name, description ?? null, JSON.stringify(def), f.enabled, version, f.ownerId, JSON.stringify(runAs), f.solutionId ?? null, f.by, now],
      )
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'conflict', `A flow named "${name}" already exists.`, 'name')
      throw e
    }
    await db().exec(`INSERT INTO ${T('ab_flow_versions')} (flow_id, version, doc, saved_by, saved_on, note) VALUES ($1, $2, $3::jsonb, $4, $5, $6) ON CONFLICT DO NOTHING`, [f.id, version, JSON.stringify(f.doc), f.by, now, f.note ?? null])
  }

  /** a new version of the definition (version + 1, a version row); joins the caller's transaction */
  async function saveVersion(id: string, doc: FlowDoc, by: string | null, o: { note?: string; ownerId?: string; solutionId?: string | null } = {}): Promise<number> {
    const now = new Date()
    const { name, description, runAs, ...def } = doc
    let rows: Row[]
    try {
      rows = await db().query<Row>(
        `UPDATE ${T('ab_flows')} SET name = $2, description = $3, definition = $4::jsonb, run_as = $5::jsonb, version = version + 1, modified_by = $6, modified_on = $7,
           owner_id = COALESCE($8, owner_id), solution_id = CASE WHEN $9::boolean THEN $10 ELSE solution_id END, suspended = NULL
         WHERE id = $1 RETURNING version`,
        [id, name, description ?? null, JSON.stringify(def), JSON.stringify(runAs), by, now, o.ownerId ?? null, o.solutionId !== undefined, o.solutionId ?? null],
      )
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'conflict', `A flow named "${name}" already exists.`, 'name')
      throw e
    }
    if (!rows.length) throw new HttpError(404, 'not-found', 'Flow not found.')
    const v = Number(rows[0].version)
    await db().exec(`INSERT INTO ${T('ab_flow_versions')} (flow_id, version, doc, saved_by, saved_on, note) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`, [id, v, JSON.stringify(doc), by, now, o.note ?? null])
    return v
  }

  async function setEnabled(id: string, enabled: boolean, by: string | null): Promise<void> {
    await db().exec(`UPDATE ${T('ab_flows')} SET enabled = $2, modified_by = $3, modified_on = now(), suspended = CASE WHEN $2 THEN NULL ELSE suspended END WHERE id = $1`, [id, enabled, by])
  }

  async function setSuspended(id: string, reason: string | null): Promise<boolean> {
    const r = await db().exec(`UPDATE ${T('ab_flows')} SET suspended = $2 WHERE id = $1 AND suspended IS DISTINCT FROM $2`, [id, reason])
    return r.affectedRows > 0
  }

  async function remove(id: string): Promise<void> {
    for (const t of ['ab_flow_connections', 'ab_flow_run_grants', 'ab_flow_alerts']) await db().exec(`DELETE FROM ${T(t)} WHERE flow_id = $1`, [id])
    await db().exec(`DELETE FROM ${T('ab_flow_versions')} WHERE flow_id = $1`, [id])
    await db().exec(`DELETE FROM ${T('ab_flows')} WHERE id = $1`, [id])
  }

  async function versions(id: string): Promise<FlowVersionInfo[]> {
    const rows = await db().query<Row>(`SELECT v.version, v.saved_by, v.saved_on, v.note, u.name AS by_name FROM ${T('ab_flow_versions')} v LEFT JOIN "ab"."users" u ON u.id = v.saved_by WHERE v.flow_id = $1 ORDER BY v.version DESC`, [id])
    return rows.map((r) => ({ version: Number(r.version), savedBy: r.saved_by ? String(r.saved_by) : null, ...(r.by_name ? { savedByName: String(r.by_name) } : {}), savedOn: iso(r.saved_on), ...(r.note ? { note: String(r.note) } : {}) }))
  }

  async function versionDoc(id: string, version: number): Promise<FlowDoc | null> {
    const rows = await db().query<Row>(`SELECT doc FROM ${T('ab_flow_versions')} WHERE flow_id = $1 AND version = $2`, [id, version])
    return rows.length ? parse<FlowDoc>(rows[0].doc, null as unknown as FlowDoc) : null
  }

  /** replaces the connection references (ref -> connection); joins the caller's transaction */
  async function setConnections(flowId: string, refs: { ref: string; connectionId: string; grantedBy: string | null; keepGrant?: boolean }[]): Promise<void> {
    const before = new Map((await connections(flowId)).map((c) => [c.ref, c]))
    await db().exec(`DELETE FROM ${T('ab_flow_connections')} WHERE flow_id = $1`, [flowId])
    for (const r of refs) {
      const prev = before.get(r.ref)
      const same = prev && prev.connectionId === r.connectionId
      await db().exec(
        `INSERT INTO ${T('ab_flow_connections')} (flow_id, ref, connection_id, granted_by, granted_on) VALUES ($1, $2, $3, $4, $5)`,
        [flowId, r.ref, r.connectionId, same ? (prev.grantedBy ?? r.grantedBy) : r.grantedBy, same && prev.grantedOn ? new Date(prev.grantedOn) : new Date()],
      )
    }
  }

  /** role ids allowed to run the flow ('*': every flow) */
  async function grants(flowId: string): Promise<string[]> {
    return (await db().query<Row>(`SELECT role_id FROM ${T('ab_flow_run_grants')} WHERE flow_id = $1 ORDER BY role_id`, [flowId])).map((r) => String(r.role_id))
  }
  async function setGrants(flowId: string, roleIds: string[], by: string | null): Promise<void> {
    await db().exec(`DELETE FROM ${T('ab_flow_run_grants')} WHERE flow_id = $1`, [flowId])
    for (const r of [...new Set(roleIds)]) await db().exec(`INSERT INTO ${T('ab_flow_run_grants')} (flow_id, role_id, granted_by, granted_on) VALUES ($1, $2, $3, now())`, [flowId, r, by])
  }
  /** the flows (or '*') the roles may run */
  async function grantedFlows(roleIds: string[]): Promise<Set<string>> {
    if (!roleIds.length) return new Set()
    return new Set((await db().query<Row>(`SELECT flow_id FROM ${T('ab_flow_run_grants')} WHERE role_id = ANY($1::text[])`, [roleIds])).map((r) => String(r.flow_id)))
  }

  async function settings(): Promise<EnvFlowSettings> {
    const env = currentEnvironment().id
    const c = settingsCache.get(env)
    if (c && Date.now() - c.at < 2000) return c.v
    const rows = await db().query<Row>(`SELECT k, v, modified_by, modified_on FROM ${T('ab_flow_settings')}`)
    const m = new Map(rows.map((r) => [String(r.k), r]))
    const paused = m.get('paused')
    const v: EnvFlowSettings = {
      paused: parse<boolean>(paused?.v, false) === true,
      ...(paused?.modified_by ? { pausedBy: String(paused.modified_by) } : {}),
      ...(paused?.modified_on ? { pausedOn: iso(paused.modified_on) } : {}),
      environmentRunsPerMinute: Number(parse<number>(m.get('environmentRunsPerMinute')?.v, 6000)) || 6000,
    }
    settingsCache.set(env, { at: Date.now(), v })
    return v
  }
  async function setSetting(k: string, v: unknown, by: string | null): Promise<void> {
    await db().exec(`INSERT INTO ${T('ab_flow_settings')} (k, v, modified_by, modified_on) VALUES ($1, $2::jsonb, $3, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, modified_by = EXCLUDED.modified_by, modified_on = now()`, [k, JSON.stringify(v), by])
    settingsCache.delete(currentEnvironment().id)
  }
  async function rawSetting(k: string): Promise<unknown> {
    const r = await db().query<Row>(`SELECT v FROM ${T('ab_flow_settings')} WHERE k = $1`, [k])
    return r.length ? parse<unknown>(r[0].v, null) : null
  }

  /** success rate, last run and average duration over the last 7 days (normal runs) */
  async function health(): Promise<Map<string, FlowHealth>> {
    const rows = await db().query<Row>(
      `SELECT flow_id, count(*)::int AS runs,
              count(*) FILTER (WHERE state = 'succeeded')::int AS ok,
              count(*) FILTER (WHERE state IN ('failed', 'timedOut'))::int AS bad,
              avg(EXTRACT(EPOCH FROM finished_on - started_on) * 1000) FILTER (WHERE finished_on IS NOT NULL AND started_on IS NOT NULL)::float8 AS avg_ms
         FROM ${T('ab_flow_runs')} WHERE mode = 'normal' AND created_on > now() - interval '7 days' GROUP BY flow_id`,
    )
    const last = await db().query<Row>(
      `SELECT DISTINCT ON (flow_id) flow_id, created_on, state FROM ${T('ab_flow_runs')} WHERE mode = 'normal' ORDER BY flow_id, created_on DESC`,
    )
    const out = new Map<string, FlowHealth>()
    for (const r of rows) {
      const runs = Number(r.runs)
      const ok = Number(r.ok)
      const bad = Number(r.bad)
      out.set(String(r.flow_id), { runs7d: runs, succeeded7d: ok, failed7d: bad, successRate: ok + bad ? ok / (ok + bad) : null, lastRunOn: null, lastStatus: null, avgDurationMs: r.avg_ms === null ? null : Math.round(Number(r.avg_ms)) })
    }
    for (const r of last) {
      const k = String(r.flow_id)
      const h = out.get(k) ?? { runs7d: 0, succeeded7d: 0, failed7d: 0, successRate: null, lastRunOn: null, lastStatus: null, avgDurationMs: null }
      h.lastRunOn = iso(r.created_on)
      h.lastStatus = String(r.state) as RunStatus
      out.set(k, h)
    }
    return out
  }

  /** the designer's unpublished draft of a flow (package B): { doc, connections, baseVersion } with who saved it when */
  async function draft(id: string): Promise<FlowDraft | null> {
    const rows = await db().query<Row>(`SELECT f.draft, f.draft_by, f.draft_on, u.name AS by_name FROM ${T('ab_flows')} f LEFT JOIN "ab"."users" u ON u.id = f.draft_by WHERE f.id = $1`, [id])
    const r = rows[0]
    if (!r || !r.draft) return null
    const d = parse<{ doc: FlowDoc; connections?: Record<string, string>; baseVersion?: number }>(r.draft, null as never)
    return { doc: d.doc, connections: d.connections ?? {}, baseVersion: Number(d.baseVersion) || 0, ...(r.draft_by ? { savedBy: String(r.draft_by) } : {}), ...(r.by_name ? { savedByName: String(r.by_name) } : {}), savedOn: iso(r.draft_on) }
  }
  /** replaces the draft (null clears it); joins the caller's transaction */
  async function setDraft(id: string, d: { doc: FlowDoc; connections: Record<string, string>; baseVersion: number } | null, by: string | null): Promise<void> {
    await db().exec(`UPDATE ${T('ab_flows')} SET draft = $2::jsonb, draft_by = $3, draft_on = CASE WHEN $2::jsonb IS NULL THEN NULL ELSE now() END WHERE id = $1`, [id, d ? JSON.stringify(d) : null, d ? by : null])
  }

  return { draft, setDraft, get, byName, resolve, list, insert, saveVersion, setEnabled, setSuspended, remove, versions, versionDoc, connections, setConnections, grants, setGrants, grantedFlows, settings, setSetting, rawSetting, health, invalidateSettings: () => settingsCache.clear() }
}
