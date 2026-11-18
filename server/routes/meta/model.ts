/**
 * Data model designer API (P0-K, docs/dev/data-api.md "Data model"): the live model, per-user drafts, diagram layouts,
 * plan and apply, import from a connection, data checks for the lint panel, the reporting views registry and the
 * "data model" solution package. Makers only; every change is audited; writes are design routes (locked production
 * environments refuse them).
 */
import type { ModelDraft, ModelLayout, ModelOp, ModelResponse } from '../../../src/model/types.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { Router, Services } from '../../core/contracts.ts'
import { HttpError } from '../../core/contracts.ts'
import type { CoreServices } from '../../core/services.ts'
import { applyModel, fingerprint, liveModel, planModel } from '../../core/model/engine.ts'
import { introspect } from '../../core/model/introspect.ts'
import { registerSummaryJob } from '../../core/model/summary.ts'
import { currentEnvironment } from '../../core/env-context.ts'
import { quoteId } from '../../connectors/postgres/sql.ts'
import { DEFAULT_CONNECTION_ID } from '../../core/connections.ts'
import { audit } from './tables-core.ts'
import { PACKAGE_VERSION, tableEntry } from './packages.ts'
import { bodyObj, invalid, isObj, me, toYaml } from './util.ts'
import { kindOf, parseCsv, parseXlsx } from '../../connectors/files/formats.ts'

const SHARED = ''

function readLayout(v: unknown): ModelLayout {
  if (!isObj(v)) throw invalid('layout must be an object.')
  const positions: ModelLayout['positions'] = {}
  if (isObj(v.positions)) {
    for (const [k, p] of Object.entries(v.positions)) {
      if (Object.keys(positions).length >= 5000) break
      if (k.length <= 80 && isObj(p) && Number.isFinite(p.x) && Number.isFinite(p.y)) positions[k] = { x: Math.round(Number(p.x)), y: Math.round(Number(p.y)) }
    }
  }
  const areas: ModelLayout['areas'] = []
  if (Array.isArray(v.areas)) {
    for (const a of v.areas.slice(0, 100)) {
      if (!isObj(a) || typeof a.id !== 'string' || typeof a.name !== 'string') continue
      areas.push({ id: a.id.slice(0, 80), name: a.name.slice(0, 120), color: typeof a.color === 'string' ? a.color.slice(0, 20) : 'slate', tables: Array.isArray(a.tables) ? a.tables.filter((x): x is string => typeof x === 'string').slice(0, 1000) : [] })
    }
  }
  return { positions, areas }
}

function readOps(v: unknown): ModelOp[] {
  if (!Array.isArray(v)) throw invalid('ops must be a list.', 'ops')
  const kinds = new Set(['createTable', 'updateTable', 'dropTable', 'addColumn', 'updateColumn', 'dropColumn', 'putRelationship', 'dropRelationship'])
  for (const o of v) if (!isObj(o) || !kinds.has(String(o.op))) throw invalid('An operation is malformed.', 'ops')
  return v as ModelOp[]
}

function readDraft(v: unknown): ModelDraft {
  if (!isObj(v) || !isObj(v.base) || !isObj(v.model) || !Array.isArray((v.model as { tables?: unknown }).tables) || !Array.isArray((v.base as { tables?: unknown }).tables)) throw invalid('draft must have a base and a model.', 'draft')
  const d = v as unknown as ModelDraft
  const trim = (list: unknown) => (Array.isArray(list) ? list.slice(-30) : [])
  return { base: d.base, model: d.model, ...(d.layout ? { layout: readLayout(d.layout) } : {}), past: trim(d.past), future: trim(d.future) }
}

export function registerModelRoutes(router: Router, s: Services): void {
  if ((s as CoreServices).kernel?.jobs) registerSummaryJob(s as CoreServices)

  router.add('GET', '/api/v1/model', async (ctx) => {
    const u = me(ctx)
    const model = await liveModel(s)
    const store = s.meta.relationships
    const out: ModelResponse = {
      model,
      layout: (await store?.layouts.get(SHARED)) ?? { positions: {}, areas: [] },
      draft: (await store?.drafts.get(u.user.id)) ?? null,
      locked: !!(await s.environments?.isLocked(ctx.environmentId)),
      version: fingerprint(model),
    }
    const mine = await store?.layouts.get(u.user.id)
    if (mine) out.myLayout = mine
    return out
  }, { auth: 'maker' })

  router.add('PUT', '/api/v1/model/draft', async (ctx) => {
    const u = me(ctx)
    const store = s.meta.relationships
    if (!store) throw invalid('Drafts are not available.')
    const draft = readDraft(bodyObj(ctx).draft)
    const modifiedOn = await store.drafts.put(u.user.id, draft)
    return { ok: true, modifiedOn }
  }, { auth: 'maker', design: true, maxBodyMB: 16 })

  router.add('DELETE', '/api/v1/model/draft', async (ctx) => {
    await s.meta.relationships?.drafts.remove(me(ctx).user.id)
    return { ok: true }
  }, { auth: 'maker' })

  router.add('PUT', '/api/v1/model/layout', async (ctx) => {
    const u = me(ctx)
    const b = bodyObj(ctx)
    const layout = readLayout(b.layout)
    const scope = b.scope === 'mine' ? u.user.id : SHARED
    await s.meta.relationships?.layouts.put(scope, layout)
    if (scope === SHARED) await audit(s, ctx, 'model.layout', { tables: Object.keys(layout.positions).length, areas: layout.areas.length })
    return { ok: true }
  }, { auth: 'maker', design: true, maxBodyMB: 4 })

  router.add('DELETE', '/api/v1/model/layout', async (ctx) => {
    await s.meta.relationships?.layouts.remove(me(ctx).user.id)
    return { ok: true }
  }, { auth: 'maker' })

  router.add('POST', '/api/v1/model/plan', async (ctx) => {
    const ops = readOps(bodyObj(ctx).ops)
    return (await planModel(s, me(ctx), ops)).plan
  }, { auth: 'maker', maxBodyMB: 16 })

  router.add('POST', '/api/v1/model/apply', async (ctx) => {
    const u = me(ctx)
    const b = bodyObj(ctx)
    const ops = readOps(b.ops)
    const result = await applyModel(s, ctx, ops, b.token)
    // positions of the new tables: draft ids become real ids; the shared layout (or the caller's own) keeps them
    if (b.layout !== undefined && s.meta.relationships) {
      const given = readLayout(b.layout)
      const scope = b.layoutScope === 'mine' ? u.user.id : SHARED
      const current = (await s.meta.relationships.layouts.get(scope)) ?? { positions: {}, areas: [] }
      const map = (id: string) => result.ids[id] ?? id
      const positions = { ...current.positions }
      for (const [k, p] of Object.entries(given.positions)) positions[map(k)] = p
      const areas = given.areas.map((a) => ({ ...a, tables: a.tables.map(map) }))
      await s.meta.relationships.layouts.put(scope, { positions, areas: areas.length ? areas : current.areas })
    }
    if (b.clearDraft === true) await s.meta.relationships?.drafts.remove(u.user.id)
    return result
  }, { auth: 'maker', design: true, maxBodyMB: 16 })

  router.add('POST', '/api/v1/model/introspect', async (ctx) => {
    const b = bodyObj(ctx)
    const connectionId = typeof b.connectionId === 'string' ? b.connectionId : ''
    if (!connectionId) throw invalid('Pick a connection.', 'connectionId')
    const mode = b.mode === 'copy' ? 'copy' : 'link'
    const into = isObj(b.into) && Array.isArray((b.into as { tables?: unknown }).tables) ? (b.into as unknown as Parameters<typeof introspect>[3]) : await liveModel(s)
    const only = Array.isArray(b.tables) ? b.tables.filter((x): x is string => typeof x === 'string') : undefined
    return introspect(s, connectionId, mode, into, only)
  }, { auth: 'maker', maxBodyMB: 16 })

  /* a spreadsheet (xlsx or csv) read into sheets for "Import a model" (nothing is stored); at most 2,000 rows per sheet */
  router.add('POST', '/api/v1/model/sheets', async (ctx) => {
    const name = (ctx.query.get('name') ?? 'file.xlsx').slice(0, 200)
    const bytes = ctx.rawBody
    if (!bytes?.length) throw invalid('The request body must be the file.')
    const kind = kindOf(name)
    if (kind !== 'xlsx' && kind !== 'csv') throw invalid('Pick an Excel (.xlsx) or CSV file.')
    const sheets = kind === 'xlsx' ? await parseXlsx(bytes) : parseCsv(bytes, name.replace(/\.csv$/i, ''))
    const text = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, v.getUTCHours() || v.getUTCMinutes() ? 19 : 10) : String(v))
    return { sheets: sheets.map((sh) => ({ name: sh.name, headers: sh.headers.map(String), rows: sh.rows.slice(0, 2000).map((r) => r.map(text)) })) }
  }, { auth: 'maker', raw: true, maxBodyMB: 25 })

  /* text columns whose values look like numbers or dates (lint), first 5,000 rows of each table */
  router.add('GET', '/api/v1/model/stats', async () => {
    const db = s.env.systemDb?.()
    const out: { table: string; column: string; values: number; numeric: number; dates: number }[] = []
    if (!db) return { items: out }
    const schema = currentEnvironment().schema
    const tables = (await s.meta.tables.list()).filter((t) => (t.connectionId ?? DEFAULT_CONNECTION_ID) === DEFAULT_CONNECTION_ID && t.source && !t.reporting).slice(0, 80)
    for (const t of tables) {
      const cols = t.columns.filter((c) => !c.system && (c.type === 'text' || c.type === 'multiline'))
      if (!cols.length) continue
      try {
        const parts = cols.flatMap((c, i) => {
          const q = quoteId(c.name)
          return [
            `count(*) FILTER (WHERE ${q} IS NOT NULL AND btrim(${q}) <> '') AS v${i}`,
            `count(*) FILTER (WHERE ${q} ~ '^\\s*[+-]?[0-9]+([.,][0-9]+)?\\s*$') AS n${i}`,
            `count(*) FILTER (WHERE ${q} ~ '^\\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{4})') AS d${i}`,
          ]
        })
        const r = (await db.query<Record<string, unknown>>(`SELECT ${parts.join(', ')} FROM (SELECT * FROM ${quoteId(schema)}.${quoteId(t.source!)} LIMIT 5000) AS x`))[0] ?? {}
        cols.forEach((c, i) => out.push({ table: t.id, column: c.name, values: Number(r[`v${i}`] ?? 0), numeric: Number(r[`n${i}`] ?? 0), dates: Number(r[`d${i}`] ?? 0) }))
      } catch {
        /* a table that cannot be read is simply not checked */
      }
    }
    return { items: out }
  }, { auth: 'maker' })

  /* the reporting views registry: views with their lineage */
  router.add('GET', '/api/v1/model/views', async () => {
    const tables = await s.meta.tables.list()
    return {
      items: tables.filter((t) => t.reporting?.kind === 'view').map((t) => {
        const r = t.reporting as Extract<NonNullable<TableDef['reporting']>, { kind: 'view' }>
        return { id: t.id, name: t.name, displayName: t.displayName, role: r.role, base: r.base, baseName: tables.find((x) => x.id === r.base)?.name ?? null, columns: r.columns }
      }),
    }
  }, { auth: 'maker' })

  /* the model (or some of its tables) as a solution package (schemas, relationships, reporting settings; no rows) */
  router.add('POST', '/api/v1/model/package', async (ctx) => {
    const u = me(ctx)
    const b = bodyObj(ctx)
    const all = await s.meta.tables.list()
    const want = Array.isArray(b.tables) ? new Set(b.tables.filter((x): x is string => typeof x === 'string')) : null
    const chosen = all.filter((t) => !t.system && (!want || want.has(t.id)))
    if (!chosen.length) throw invalid('There are no tables to export.')
    chosen.sort((a, z) => Number(a.reporting?.kind === 'view') - Number(z.reporting?.kind === 'view'))
    const tables = []
    for (const t of chosen) tables.push(await tableEntry(s, u, t, false))
    const env = currentEnvironment().id
    const displayName = typeof b.displayName === 'string' && b.displayName.trim() ? b.displayName.trim().slice(0, 120) : 'Data model'
    await audit(s, ctx, 'model.export', { tables: chosen.length })
    return {
      fileName: `${displayName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.solution.yaml`,
      yaml: toYaml({
        kind: 'appbuilder/solution', packageVersion: PACKAGE_VERSION, exportedOn: s.now(),
        solution: { id: `datamodel_${env}`.slice(0, 64), name: 'DataModel', displayName, publisher: u.user.name, version: typeof b.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(b.version) ? b.version : '1.0.0', description: 'Tables, relationships and reporting settings exported from the data model designer.' },
        apps: [], tables, roles: [], connections: [], files: [],
      }),
    }
  }, { auth: 'maker' })
}

export { HttpError }
