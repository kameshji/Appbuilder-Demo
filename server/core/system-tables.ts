/**
 * Core data model on the server (P0 package N, docs/dev/core-data-model.md): creates and upgrades the system tables of
 * an environment schema, idempotently, inside the caller's transaction.
 *
 *  - projections: PostgreSQL VIEWs in the environment schema over schema `ab` (users, departments, teams, notifications,
 *    the sign-in log) and over the environment's own metadata tables (roles, role assignments, shares, audit, jobs,
 *    event runs). Dropped and created again on every run (they hold no data), so a changed definition or a table that
 *    appeared (package I's sign-in log) is picked up at the next start. Only safe columns are selected: password hashes,
 *    MFA secrets, session data and install flags never reach a view.
 *  - real tables: created from their TableDef with the platform's own DDL (sql.ts createTableSql: same types and
 *    indexes as any table), completed with ADD COLUMN IF NOT EXISTS when a later version adds a platform column;
 *    custom columns a maker added stay (they are in the stored definition).
 *  - ab_tables: one registration per system table (stable ids sys_*), the stored definition merged with the platform
 *    columns. A maker's table that already used a system table's name keeps it; the system table is then registered
 *    as Sys<Name> (and the migration summary says so).
 *  - seeds: reference data once per environment (marker rows in ab_counters `sys.seed.<table>`), so a deleted currency
 *    does not come back at the next start.
 *  - the attachment store is registered in Attachment links (one row per attachment, by migration and then kept in step
 *    by attachments.ts).
 */
import type { SqlDb } from './contracts.ts'
import type { ColumnDef, TableDef } from '../../src/platform/contracts.ts'
import {
  DEFAULT_SETTINGS, INDIA_STATES, REGARDING, SYS, SYSTEM_TABLES, UNITS, isSystemTableId, seedId, systemTableDef,
} from '../../src/platform/system-tables.ts'
import type { SystemTableSpec } from '../../src/platform/system-tables.ts'
import { COUNTRIES, CURRENCIES } from '../../src/platform/system-reference-data.ts'
import { columnSql, createTableSql, indexName, quoteId } from '../connectors/postgres/sql.ts'
import type { Dialect } from '../connectors/postgres/sql.ts'

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`
const A = (t: string): string => `"ab".${q(t)}`

/* ------------------------------------------------------------------ views */

/** SELECT of a projection; every view lists the system columns first (id, createdOn, modifiedOn, createdBy, owner) */
function viewSql(spec: SystemTableSpec, schema: string, envId: string, has: (t: string) => boolean): string {
  const S = (t: string): string => `${q(schema)}.${q(t)}`
  const env = lit(envId)
  const ts = (e: string) => `(${e})::timestamptz(3)`
  const vc = (e: string) => `(${e})::varchar(255)`
  switch (spec.id) {
    case SYS.users:
      return `SELECT u.id AS "id", ${ts('u.created_on')} AS "createdOn", ${ts('u.created_on')} AS "modifiedOn", NULL::text AS "createdBy", u.id AS "owner",
        ${vc('u.name')} AS "FullName", ${vc('u.email')} AS "Email", u.department_id AS "Department", u.manager_id AS "Manager",
        ${vc('u.job_title')} AS "JobTitle", ${vc('u.phone')} AS "Phone", ${vc('u.employee_code')} AS "EmployeeCode", ${vc('u.status')} AS "Status"
        FROM ${A('users')} u
        WHERE u.is_install_admin OR EXISTS (SELECT 1 FROM ${A('environment_access')} a WHERE a.environment_id = ${env} AND a.user_id = u.id)`
    case SYS.departments:
      return `SELECT d.id AS "id", ${ts('d.created_on')} AS "createdOn", ${ts('d.created_on')} AS "modifiedOn", NULL::text AS "createdBy", NULL::text AS "owner",
        ${vc('d.code')} AS "Code", ${vc('d.name')} AS "Name", d.parent_id AS "Parent", d.description AS "Description"
        FROM ${A('departments')} d`
    case SYS.teams:
      return `SELECT t.id AS "id", ${ts('t.created_on')} AS "createdOn", ${ts('t.created_on')} AS "modifiedOn", NULL::text AS "createdBy", NULL::text AS "owner",
        ${vc('t.code')} AS "Code", ${vc('t.name')} AS "Name", t.description AS "Description"
        FROM ${A('teams')} t WHERE t.environment_id IS NULL OR t.environment_id = ${env}`
    case SYS.teamMembers:
      return `SELECT (m.team_id || ':' || m.user_id) AS "id", ${ts('t.created_on')} AS "createdOn", ${ts('t.created_on')} AS "modifiedOn", NULL::text AS "createdBy", m.user_id AS "owner",
        m.team_id AS "Team", m.user_id AS "User"
        FROM ${A('team_members')} m JOIN ${A('teams')} t ON t.id = m.team_id WHERE t.environment_id IS NULL OR t.environment_id = ${env}`
    case SYS.roles:
      return `SELECT r.id AS "id", NULL::timestamptz(3) AS "createdOn", NULL::timestamptz(3) AS "modifiedOn", NULL::text AS "createdBy", NULL::text AS "owner",
        ${vc('r.name')} AS "Name", r.description AS "Description", r.is_admin AS "IsAdmin", r.is_maker AS "IsMaker"
        FROM ${S('ab_roles')} r`
    case SYS.roleAssignments:
      return `SELECT (ur.user_id || ':' || ur.role_id) AS "id", NULL::timestamptz(3) AS "createdOn", NULL::timestamptz(3) AS "modifiedOn", NULL::text AS "createdBy", ur.user_id AS "owner",
        ur.user_id AS "User", ur.role_id AS "Role"
        FROM ${S('ab_user_roles')} ur`
    case SYS.shares:
      return `SELECT md5(s.table_id || ':' || s.row_id || ':' || s.principal_type || ':' || s.principal_id) AS "id", ${ts('s.shared_on')} AS "createdOn", ${ts('s.shared_on')} AS "modifiedOn",
        s.shared_by AS "createdBy", s.shared_by AS "owner",
        ${vc('s.table_id')} AS "regardingTable", ${vc('s.row_id')} AS "regardingId", ${vc('s.principal_type')} AS "PrincipalType", ${vc('s.principal_id')} AS "Principal",
        ${vc('s.access')} AS "Access", s.shared_by AS "SharedBy"
        FROM ${S('ab_shares')} s`
    case SYS.notifications:
      return `SELECT n.id AS "id", ${ts('n.created_on')} AS "createdOn", ${ts('COALESCE(n.read_on, n.created_on)')} AS "modifiedOn", n.sender_id AS "createdBy", n.user_id AS "owner",
        ${vc('n.kind')} AS "Kind", ${vc('n.title')} AS "Title", n.body AS "Body", ${vc('n.link')} AS "Link", ${vc('n.source')} AS "Source", n.sender_id AS "Sender",
        ${vc('n.sender_name')} AS "SenderName", (n.read_on IS NOT NULL) AS "IsRead", ${ts('n.read_on')} AS "ReadOn"
        FROM ${A('notifications')} n WHERE n.environment_id IS NULL OR n.environment_id = ${env}`
    case SYS.auditEntries:
      return `SELECT a.id::text AS "id", ${ts('a.at')} AS "createdOn", ${ts('a.at')} AS "modifiedOn", a.user_id AS "createdBy", a.user_id AS "owner",
        ${vc('a.action')} AS "Action", a.user_id AS "User", ${vc('a.table_id')} AS "TableId", ${vc('a.row_id')} AS "RowId", a.details::text AS "Details"
        FROM ${S('ab_audit')} a`
    case SYS.signInLog:
      // package I's sign-in log when it exists (install-wide: rows of users who may enter this environment)
      if (has('ab.signin_log')) {
        return `SELECT l.id::text AS "id", ${ts('l.at')} AS "createdOn", ${ts('l.at')} AS "modifiedOn", l.user_id AS "createdBy", l.user_id AS "owner",
          l.user_id AS "User", ${vc('l.email')} AS "Email", ${vc('l.outcome')} AS "Outcome", ${vc('l.method')} AS "Method", ${vc('l.ip')} AS "IpAddress", ${vc('l.user_agent')} AS "UserAgent"
          FROM ${A('signin_log')} l
          WHERE l.user_id IS NULL OR EXISTS (SELECT 1 FROM ${A('environment_access')} a WHERE a.environment_id = ${env} AND a.user_id = l.user_id)
             OR EXISTS (SELECT 1 FROM ${A('users')} u WHERE u.id = l.user_id AND u.is_install_admin)`
      }
      return `SELECT NULL::text AS "id", NULL::timestamptz(3) AS "createdOn", NULL::timestamptz(3) AS "modifiedOn", NULL::text AS "createdBy", NULL::text AS "owner",
        NULL::text AS "User", NULL::varchar(255) AS "Email", NULL::varchar(255) AS "Outcome", NULL::varchar(255) AS "Method", NULL::varchar(255) AS "IpAddress", NULL::varchar(255) AS "UserAgent"
        WHERE false`
    case SYS.jobRuns:
      return `SELECT j.id AS "id", ${ts('j.created_on')} AS "createdOn", ${ts('j.modified_on')} AS "modifiedOn", j.created_by AS "createdBy", j.created_by AS "owner",
        ${vc('j.type')} AS "JobType", ${vc('j.state')} AS "State", j.attempts::bigint AS "Attempts", ${ts('j.run_at')} AS "RunAt", ${ts('j.finished_on')} AS "FinishedOn",
        ${vc('j.run_as')} AS "RunAs", j.error::text AS "Error"
        FROM ${S('ab_jobs')} j`
    case SYS.eventRuns:
      return `SELECT r.id::text AS "id", ${ts('r.at')} AS "createdOn", ${ts('r.at')} AS "modifiedOn", NULL::text AS "createdBy", NULL::text AS "owner",
        ${vc('r.event_id')} AS "EventId", ${vc('r.table_id')} AS "TableId", ${vc('r.row_id')} AS "RowId", ${vc('r.timing')} AS "Phase", ${vc('r.status')} AS "Outcome",
        r.duration_ms::bigint AS "DurationMs", r.message AS "Message"
        FROM ${S('ab_event_runs')} r`
  }
  throw new Error(`no view for ${spec.id}`)
}

/* ------------------------------------------------------------------ provisioning */

export interface ProvisionResult { created: string[]; renamed: string[]; seeded: string[]; linkedAttachments: number }

async function dialectOf(db: SqlDb, schema: string): Promise<Dialect> {
  const r = await db.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_collation WHERE collname = 'und-x-icu') AS ok")
  return { schema, icu: !!r[0]?.ok }
}

/** indexes beyond the column ones: the timeline index, unique pairs, my-tasks */
function extraIndexes(d: Dialect, def: TableDef, spec: SystemTableSpec): string[] {
  const t = `${q(d.schema)}.${q(spec.source)}`
  const out: string[] = []
  if (spec.regarding) {
    // timeline: rows about one record, newest first (regardingId values are lowercase row ids, compared exactly)
    out.push(`CREATE INDEX IF NOT EXISTS ${quoteId(indexName(spec.source, 'index', 'timeline'))} ON ${t} ("regardingId", "createdOn" DESC, "id" DESC)`)
  }
  // unique pairs (uniqueTogether) come from createTableSql (package K's composite unique indexes)
  if (spec.id === SYS.activities) {
    out.push(`CREATE INDEX IF NOT EXISTS ${quoteId(indexName(spec.source, 'index', 'mytasks'))} ON ${t} ("AssignedTo", "Status", "DueOn")`)
    out.push(`CREATE INDEX IF NOT EXISTS ${quoteId(indexName(spec.source, 'index', 'myteamtasks'))} ON ${t} ("AssignedTeam", "Status", "DueOn") WHERE "AssignedTeam" IS NOT NULL`)
  }
  if (spec.id === SYS.mentions) out.push(`CREATE INDEX IF NOT EXISTS ${quoteId(indexName(spec.source, 'index', 'inbox'))} ON ${t} ("MentionedUser", "createdOn" DESC)`)
  void def
  return out
}

async function exists(db: SqlDb, qualified: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [qualified])
  return !!r[0]?.ok
}

async function relkind(db: SqlDb, schema: string, name: string): Promise<string | null> {
  const r = await db.query<{ k: string }>('SELECT c.relkind::text AS k FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2', [schema, name])
  return r[0]?.k ?? null
}

/**
 * Creates or completes every system table of one environment schema and registers it in ab_tables. Idempotent; run it
 * inside the environment's migration transaction (meta-store.ts) and when an environment is created or copied.
 */
export async function provisionSystemTables(db: SqlDb, schema: string, envId: string): Promise<ProvisionResult> {
  const out: ProvisionResult = { created: [], renamed: [], seeded: [], linkedAttachments: 0 }
  const d = await dialectOf(db, schema)
  const S = (t: string): string => `${q(schema)}.${q(t)}`
  const now = new Date()
  const stored = new Map<string, { name: string; def: TableDef }>()
  const names = new Map<string, string>() // lower(name) -> id
  for (const r of await db.query<{ id: string; name: string; def: unknown }>(`SELECT id, name, def FROM ${S('ab_tables')}`)) {
    const def = (typeof r.def === 'string' ? JSON.parse(r.def) : r.def) as TableDef
    stored.set(r.id, { name: r.name, def })
    names.set(r.name.toLowerCase(), r.id)
  }
  const relations = new Set<string>()
  for (const t of ['ab.signin_log']) if (await exists(db, t)) relations.add(t)
  const has = (t: string) => relations.has(t)

  for (const spec of SYSTEM_TABLES) {
    const prev = stored.get(spec.id)
    let name = prev?.name ?? spec.name
    if (!prev) {
      // a maker's table already uses the name: the system table takes Sys<Name>
      let candidate = spec.name
      for (let i = 1; names.has(candidate.toLowerCase()) && names.get(candidate.toLowerCase()) !== spec.id; i++) candidate = i === 1 ? `Sys${spec.name}` : `Sys${spec.name}${i}`
      if (candidate !== spec.name) out.renamed.push(`${spec.name} -> ${candidate}`)
      name = candidate
      names.set(name.toLowerCase(), spec.id)
    }
    const def = systemTableDef(spec, now.toISOString(), prev?.def ?? null, name)
    if (spec.kind === 'projection') {
      const kind = await relkind(db, schema, spec.source)
      if (kind && kind !== 'v') throw new Error(`${schema}.${spec.source} exists and is not a view; rename it before upgrading`)
      await db.exec(`DROP VIEW IF EXISTS ${S(spec.source)}`)
      await db.exec(`CREATE VIEW ${S(spec.source)} AS ${viewSql(spec, schema, envId, has)}`)
    } else if (!(await exists(db, `${q(schema)}.${q(spec.source)}`))) {
      for (const stmt of createTableSql(d, def)) await db.exec(stmt)
      out.created.push(spec.name)
    } else {
      // a newer platform version may add columns: add the missing ones (the maker's custom columns are already there)
      const have = new Set((await db.query<{ c: string }>('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [schema, spec.source])).map((r) => r.c))
      for (const c of def.columns) if (!have.has(c.name)) await db.exec(`ALTER TABLE ${S(spec.source)} ADD COLUMN IF NOT EXISTS ${columnSql(c as ColumnDef)}`)
      for (const stmt of createTableSql(d, def).slice(1)) await db.exec(stmt)
    }
    if (spec.kind !== 'projection') for (const stmt of extraIndexes(d, def, spec)) await db.exec(stmt)
    const json = JSON.stringify(def)
    await db.exec(
      `INSERT INTO ${S('ab_tables')} (id, name, connection_id, source, def, created_on, modified_on) VALUES ($1, $2, 'conn_default', $3, $4::jsonb, $5, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, connection_id = EXCLUDED.connection_id, source = EXCLUDED.source, def = EXCLUDED.def`,
      [spec.id, name, spec.source, json, now],
    )
  }
  // system tables never take role privileges (their policy is built in): stale rows from a copy are removed
  await db.exec(`DELETE FROM ${S('ab_role_tables')} WHERE table_id = ANY($1::text[])`, [SYSTEM_TABLES.map((t) => t.id)])

  out.seeded = await seedReferenceData(db, schema, now)
  out.linkedAttachments = await linkAttachments(db, schema)
  await ownerLookupsOnce(db, schema)
  return out
}

/* ------------------------------------------------------------------ seeds */

async function markerSet(db: SqlDb, schema: string, key: string): Promise<boolean> {
  const r = await db.query<{ k: string }>(`INSERT INTO ${q(schema)}."ab_counters" (k, v) VALUES ($1, 1) ON CONFLICT (k) DO NOTHING RETURNING k`, [key])
  return r.length === 1
}

async function insertRows(db: SqlDb, schema: string, table: string, cols: string[], rows: unknown[][], now: Date): Promise<void> {
  const all = ['id', 'createdOn', 'modifiedOn', ...cols]
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const params: unknown[] = []
    const tuples = chunk.map((r) => {
      const vals = [r[0], now, now, ...r.slice(1)]
      return `(${vals.map((v) => {
        params.push(v)
        return `$${params.length}`
      }).join(', ')})`
    })
    await db.exec(`INSERT INTO ${q(schema)}.${q(table)} (${all.map(q).join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT ("id") DO NOTHING`, params)
  }
}

/** reference data, once per environment (a marker per table in ab_counters) */
async function seedReferenceData(db: SqlDb, schema: string, now: Date): Promise<string[]> {
  const done: string[] = []
  const seed = async (spec: string, fn: () => Promise<void>) => {
    if (await markerSet(db, schema, `sys.seed.${spec}`)) {
      await fn()
      done.push(spec)
    }
  }
  await seed(SYS.currencies, () => insertRows(db, schema, SYS.currencies, ['Code', 'Name', 'Symbol', 'DecimalPlaces', 'ExchangeRate', 'IsDefault', 'IsActive'],
    CURRENCIES.map(([c, n, s, dp]) => [seedId(`currency:${c}`), c, n, s, dp, c === 'INR' ? 1 : null, c === 'INR', true]), now))
  await seed(SYS.units, () => insertRows(db, schema, SYS.units, ['Code', 'Name', 'Dimension', 'Factor', 'IsBase'],
    UNITS.map(([c, n, dim, f, base]) => [seedId(`unit:${c}`), c, n, dim, f, base]), now))
  await seed(SYS.countries, () => insertRows(db, schema, SYS.countries, ['Code', 'Name'], COUNTRIES.map(([c, n]) => [seedId(`country:${c}`), c, n]), now))
  await seed(SYS.states, () => insertRows(db, schema, SYS.states, ['Country', 'CountryCode', 'Code', 'Name', 'Kind', 'GstStateCode', 'IsActive'],
    INDIA_STATES.map(([code, n, kind, active]) => [seedId(`state:IN:${code}`), seedId('country:IN'), 'IN', code, n, kind, code, active]), now))
  await seed(SYS.calendars, () => insertRows(db, schema, SYS.calendars, ['Name', 'TimeZone', 'WorkingDays', 'WorkStart', 'WorkEnd', 'IsDefault', 'Description'],
    [[seedId('calendar:standard'), 'Standard', 'Asia/Kolkata', 'Mon,Tue,Wed,Thu,Fri,Sat', '09:30', '18:00', true, 'Monday to Saturday. Add holidays in Holidays.']], now))
  await seed(SYS.settings, () => insertRows(db, schema, SYS.settings, ['Key', 'Value', 'Description'], DEFAULT_SETTINGS.map(([k, v, desc]) => [seedId(`setting:${k}`), k, v, desc]), now))
  return done
}

/** every attachment of the store gets its Attachment links row (existing attachment cells keep working as before) */
export async function linkAttachments(db: SqlDb, schema: string): Promise<number> {
  const S = (t: string): string => `${q(schema)}.${q(t)}`
  const r = await db.exec(
    `INSERT INTO ${S(SYS.attachmentLinks)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Attachment", "ColumnName", "FileName", "Mime", "SizeBytes", "${REGARDING.table}", "${REGARDING.id}")
     SELECT (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-5' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12)), a.created_on, a.created_on, a.created_by, a.created_by,
            a.id, a.col, left(a.file_name, 255), left(a.mime, 255), a.size_bytes, a.table_id, lower(a.row_id)
       FROM (SELECT md5('attachment:' || id) AS h, * FROM ${S('ab_attachments')}) a
      WHERE NOT EXISTS (SELECT 1 FROM ${S(SYS.attachmentLinks)} l WHERE l."Attachment" = a.id)`,
  )
  return r.affectedRows
}

/** version 7: createdBy and owner of every table become lookups to Users in the stored definitions (once) */
async function ownerLookupsOnce(db: SqlDb, schema: string): Promise<void> {
  if (!(await markerSet(db, schema, 'sys.migrate.ownerLookups'))) return
  const S = (t: string): string => `${q(schema)}.${q(t)}`
  for (const r of await db.query<{ id: string; def: unknown }>(`SELECT id, def FROM ${S('ab_tables')}`)) {
    if (isSystemTableId(r.id)) continue
    const def = (typeof r.def === 'string' ? JSON.parse(r.def) : r.def) as TableDef
    let changed = false
    for (const c of def.columns) {
      if ((c.name === 'createdBy' || c.name === 'owner') && c.system && c.type !== 'lookup') {
        c.type = 'lookup'
        c.lookupTable = 'Users'
        changed = true
      }
    }
    if (changed) await db.exec(`UPDATE ${S('ab_tables')} SET def = $1::jsonb WHERE id = $2`, [JSON.stringify(def), r.id])
  }
}

/* ------------------------------------------------------------------ environment copy */

/** real system tables (not projections) whose rows an environment copy "with data" takes along */
export const COPYABLE_SYSTEM_TABLES = SYSTEM_TABLES.filter((t) => t.kind !== 'projection').map((t) => t.source)

/** copies the rows of the real system tables (after both schemas were provisioned); reference seeds are replaced */
export async function copySystemData(db: SqlDb, from: string, to: string): Promise<void> {
  for (const t of COPYABLE_SYSTEM_TABLES) {
    if (!(await exists(db, `${q(from)}.${q(t)}`))) continue
    const cols = (await db.query<{ c: string }>(
      `SELECT a.column_name AS c FROM information_schema.columns a JOIN information_schema.columns b ON b.column_name = a.column_name AND b.table_schema = $2 AND b.table_name = a.table_name
        WHERE a.table_schema = $1 AND a.table_name = $3 ORDER BY a.ordinal_position`, [from, to, t])).map((r) => r.c)
    if (!cols.length) continue
    await db.exec(`DELETE FROM ${q(to)}.${q(t)}`)
    const list = cols.map(q).join(', ')
    await db.exec(`INSERT INTO ${q(to)}.${q(t)} (${list}) SELECT ${list} FROM ${q(from)}.${q(t)}`)
  }
}

/**
 * Drops the system views (projections) of one environment schema, or of every one. Migrations run this before their
 * steps, so a step may change or drop a table a view reads (PostgreSQL refuses that while a view depends on it);
 * provisionSystemTables creates the views again at the end of every environment's migration.
 */
export async function dropSystemViews(db: SqlDb, schema?: string): Promise<void> {
  const rows = await db.query<{ s: string; v: string }>(
    `SELECT schemaname AS s, viewname AS v FROM pg_catalog.pg_views WHERE viewname LIKE 'sys\\_%' AND ${schema ? 'schemaname = $1' : "schemaname LIKE 'env\\_%'"}`,
    schema ? [schema] : [],
  )
  for (const r of rows) await db.exec(`DROP VIEW IF EXISTS ${q(r.s)}.${q(r.v)}`)
}
