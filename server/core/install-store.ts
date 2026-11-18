/**
 * InstallStore over schema `ab` (docs/dev/schema.md): the environment registry, who may enter which environment, and the
 * install-level audit log. Nothing here depends on the current environment.
 */
import type { AuditFilter, EnvironmentAccessRecord, InstallStore, SqlDb } from './contracts.ts'
import { INSTALL_SCHEMA } from './env-context.ts'
import { toEnvironment } from './meta-store.ts'
import { toDate, toIso } from './util.ts'

type Row = Record<string, unknown>
const q = (id: string): string => `"${id}"`
const A = (t: string): string => `${q(INSTALL_SCHEMA)}.${q(t)}`
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const optStr = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))

function auditDetails(details: unknown): string | null {
  if (details === undefined) return null
  let text: string | null
  try {
    text = JSON.stringify(details) ?? null
  } catch {
    text = null
  }
  if (text) text = text.replace(/(?<!\\)\\u0000/g, '')
  if (text && text.length > 60000) text = JSON.stringify(text.slice(0, 60000))
  return text
}

function toAccess(r: Row): EnvironmentAccessRecord {
  const out: EnvironmentAccessRecord = { environmentId: str(r.environment_id), userId: str(r.user_id), isEnvAdmin: r.is_env_admin === true, grantedOn: toIso(r.granted_on) }
  const by = optStr(r.granted_by)
  if (by) out.grantedBy = by
  return out
}

export function createInstallStore(db: SqlDb): InstallStore {
  return {
    environments: {
      async list() {
        return (await db.query<Row>(`SELECT * FROM ${A('environments')} ORDER BY built_in DESC, lower(name) COLLATE "C", id`)).map(toEnvironment)
      },
      async get(id) {
        const rows = await db.query<Row>(`SELECT * FROM ${A('environments')} WHERE id = $1`, [id])
        return rows.length ? toEnvironment(rows[0]) : null
      },
      async insert(e) {
        await db.exec(
          `INSERT INTO ${A('environments')} (id, name, schema_name, type, built_in, created_on, description, created_by, state, schema_version, locked, last_error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [e.id, e.name, e.schema, e.type, !!e.builtIn, toDate(e.createdOn) ?? new Date(), e.description ?? null, e.createdBy ?? null, e.state, e.schemaVersion ?? 0, !!e.locked, e.lastError ?? null],
        )
      },
      async update(id, patch) {
        const sets: string[] = []
        const params: unknown[] = []
        const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`) }
        if (patch.name !== undefined) set('name', patch.name)
        if (patch.description !== undefined) set('description', patch.description || null)
        if (patch.type !== undefined) set('type', patch.type)
        if (patch.state !== undefined) set('state', patch.state)
        if (patch.locked !== undefined) set('locked', !!patch.locked)
        if (patch.lastError !== undefined) set('last_error', patch.lastError || null)
        if (patch.schemaVersion !== undefined) set('schema_version', patch.schemaVersion)
        if (!sets.length) return
        await db.exec(`UPDATE ${A('environments')} SET ${sets.join(', ')} WHERE id = $${params.length + 1}`, [...params, id])
      },
      async remove(id) {
        await db.tx(async (tx) => {
          await tx.exec(`DELETE FROM ${A('environment_access')} WHERE environment_id = $1`, [id])
          await tx.exec(`UPDATE ${A('users')} SET last_environment_id = NULL WHERE last_environment_id = $1`, [id])
          await tx.exec(`DELETE FROM ${A('environments')} WHERE id = $1`, [id])
        })
      },
    },

    access: {
      async list() {
        return (await db.query<Row>(`SELECT * FROM ${A('environment_access')} ORDER BY environment_id, user_id`)).map(toAccess)
      },
      async forEnvironment(id) {
        return (await db.query<Row>(`SELECT * FROM ${A('environment_access')} WHERE environment_id = $1 ORDER BY user_id`, [id])).map(toAccess)
      },
      async grant(environmentId, userId, by) {
        await db.exec(
          `INSERT INTO ${A('environment_access')} (environment_id, user_id, is_env_admin, granted_on, granted_by) VALUES ($1, $2, false, $3, $4) ON CONFLICT DO NOTHING`,
          [environmentId, userId, new Date(), by],
        )
      },
      async revoke(environmentId, userId) {
        await db.exec(`DELETE FROM ${A('environment_access')} WHERE environment_id = $1 AND user_id = $2`, [environmentId, userId])
      },
    },

    async activeInstallAdmins() {
      const rows = await db.query<Row>(`SELECT count(*)::int AS n FROM ${A('users')} WHERE is_install_admin AND status <> 'disabled'`)
      return Number(rows[0]?.n) || 0
    },

    async audit(entry) {
      await db.exec(
        `INSERT INTO ${A('audit')} (at, user_id, action, environment_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [new Date(), entry.userId ?? null, entry.action.slice(0, 64), entry.environmentId ?? null, auditDetails(entry.details)],
      )
    },

    async auditPage(f: AuditFilter & { environmentId?: string }) {
      const where: string[] = []
      const params: unknown[] = []
      const add = (sql: (p: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)) }
      if (f.action) {
        if (f.action.endsWith('.')) add((p) => `starts_with(action, ${p})`, f.action)
        else add((p) => `action = ${p}`, f.action)
      }
      if (f.userId) add((p) => `user_id = ${p}`, f.userId)
      if (f.environmentId) add((p) => `environment_id = ${p}`, f.environmentId)
      const from = toDate(f.from)
      if (from) add((p) => `at >= ${p}`, from)
      const to = toDate(f.to)
      if (to) add((p) => `at < ${p}`, to)
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = Number((await db.query<Row>(`SELECT count(*)::int AS n FROM ${A('audit')} ${w}`, params))[0]?.n) || 0
      const limit = Math.max(1, Math.min(500, Math.floor(f.limit)))
      const offset = Math.max(0, Math.floor(f.offset))
      const rows = await db.query<Row>(
        `SELECT id, at, user_id, action, environment_id, details FROM ${A('audit')} ${w} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      )
      return {
        total,
        items: rows.map((r) => ({
          id: Number(r.id), at: toIso(r.at), userId: optStr(r.user_id) ?? null, action: str(r.action),
          tableId: null, rowId: null, environmentId: optStr(r.environment_id) ?? null,
          details: r.details === null || r.details === undefined ? null : typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
        })),
      }
    },

    async auditActions() {
      return (await db.query<Row>(`SELECT action FROM ${A('audit')} GROUP BY action ORDER BY action COLLATE "C"`)).map((r) => str(r.action))
    },

    async schemaSizes(schema) {
      // data tables only (the platform's own ab_* tables are not "tables" to the admin). Rows: the planner's estimate or
      // the statistics collector's live count, whichever is larger (a table never analysed has reltuples -1)
      const rows = await db.query<Row>(
        `SELECT count(*) FILTER (WHERE c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'ab\\_%')::int AS tables,
                COALESCE(sum(GREATEST(c.reltuples, COALESCE(st.n_live_tup, 0), 0)) FILTER (WHERE c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'ab\\_%'), 0)::bigint AS rows,
                COALESCE(sum(pg_total_relation_size(c.oid)) FILTER (WHERE c.relkind IN ('r', 'p', 'm')), 0)::bigint AS bytes
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_stat_user_tables st ON st.relid = c.oid
         WHERE n.nspname = $1`,
        [schema],
      )
      return { tables: Number(rows[0]?.tables) || 0, rowEstimate: Number(rows[0]?.rows) || 0, databaseBytes: Number(rows[0]?.bytes) || 0 }
    },
  }
}
