/**
 * PostgreSQL preparation of the fleet, EXACTLY as the isolation suite requires (scripts/fleet/testing/fleet.mjs
 * createInstallDatabase / revokeShared; docs/admin/hosting.md "Isolation evidence"): once per cluster PUBLIC loses
 * CONNECT on postgres and template1; per install one role (no superuser, CREATEDB, CREATEROLE, replication, BYPASSRLS;
 * NOINHERIT; connection limit; statement and idle-in-transaction timeouts) owning one database (UTF8, template0,
 * connection limit, PUBLIC revoked, CONNECT and TEMPORARY for the role only), PUBLIC without CREATE on its public
 * schema, pg_trgm created by the superuser. Statements run one by one (CREATE DATABASE refuses a transaction block).
 */
import type { Ctx } from './core.ts'
import type { Limits } from './model.ts'
import { qi, ql, scramVerifier } from './util.ts'

export async function sqlSteps(ctx: Ctx, db: string, statements: string[]): Promise<void> {
  for (const s of statements) await ctx.sys.exec(db, s)
}

export const SHARED_DATABASES = ['postgres', 'template1'] as const

/** once per cluster (abfleet init) */
export async function prepareCluster(ctx: Ctx): Promise<void> {
  await sqlSteps(ctx, 'postgres', SHARED_DATABASES.map((d) => `REVOKE CONNECT ON DATABASE ${qi(d)} FROM PUBLIC`))
}

export async function roleExists(ctx: Ctx, name: string): Promise<boolean> {
  return (await ctx.sys.query('postgres', `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${ql(name)}`)).length > 0
}

export async function databaseExists(ctx: Ctx, name: string): Promise<boolean> {
  return (await ctx.sys.query('postgres', `SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${ql(name)}`)).length > 0
}

export function roleSettingsSql(name: string, l: Pick<Limits, 'dbConnections' | 'statementTimeout' | 'idleInTransactionTimeout'>): string[] {
  return [
    `ALTER ROLE ${qi(name)} CONNECTION LIMIT ${Math.trunc(l.dbConnections)}`,
    `ALTER ROLE ${qi(name)} SET statement_timeout = ${ql(l.statementTimeout)}`,
    `ALTER ROLE ${qi(name)} SET idle_in_transaction_session_timeout = ${ql(l.idleInTransactionTimeout)}`,
    `ALTER DATABASE ${qi(name)} CONNECTION LIMIT ${Math.trunc(l.dbConnections)}`,
  ]
}

/** one install's role and database (name = role = database: an opaque id, catalogue names are visible to every role) */
export async function createInstallDatabase(ctx: Ctx, name: string, password: string, l: Limits): Promise<void> {
  const verifier = scramVerifier(password)
  await sqlSteps(ctx, 'postgres', [
    `CREATE ROLE ${qi(name)} LOGIN PASSWORD ${ql(verifier)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT ${Math.trunc(l.dbConnections)}`,
    `ALTER ROLE ${qi(name)} SET statement_timeout = ${ql(l.statementTimeout)}`,
    `ALTER ROLE ${qi(name)} SET idle_in_transaction_session_timeout = ${ql(l.idleInTransactionTimeout)}`,
    `CREATE DATABASE ${qi(name)} OWNER ${qi(name)} ENCODING 'UTF8' TEMPLATE template0 CONNECTION LIMIT ${Math.trunc(l.dbConnections)}`,
    `REVOKE ALL ON DATABASE ${qi(name)} FROM PUBLIC`,
    `GRANT CONNECT, TEMPORARY ON DATABASE ${qi(name)} TO ${qi(name)}`,
  ])
  await sqlSteps(ctx, name, ['REVOKE CREATE ON SCHEMA public FROM PUBLIC', 'CREATE EXTENSION IF NOT EXISTS pg_trgm'])
}

/** removes a database (sessions ended) and its role; no error when they do not exist */
export async function dropInstallDatabase(ctx: Ctx, name: string): Promise<void> {
  await sqlSteps(ctx, 'postgres', [`DROP DATABASE IF EXISTS ${qi(name)} WITH (FORCE)`, `DROP ROLE IF EXISTS ${qi(name)}`])
}

/** a new password for a role (the verifier only) */
export async function setRolePassword(ctx: Ctx, name: string, password: string): Promise<void> {
  await ctx.sys.exec('postgres', `ALTER ROLE ${qi(name)} PASSWORD ${ql(scramVerifier(password))}`)
}

/** the stored verifier (superuser only), to put a password back when a rotation fails */
export async function roleVerifier(ctx: Ctx, name: string): Promise<string | null> {
  return (await ctx.sys.query('postgres', `SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = ${ql(name)}`))[0]?.[0] ?? null
}

export async function restoreVerifier(ctx: Ctx, name: string, verifier: string): Promise<void> {
  if (!/^SCRAM-SHA-256\$/.test(verifier)) throw new Error('not a SCRAM verifier')
  await ctx.sys.exec('postgres', `ALTER ROLE ${qi(name)} PASSWORD ${ql(verifier)}`)
}

export interface DbCheck { name: string; problems: string[] }

/** what doctor verifies for one install's database and role (the isolation requirements) */
export async function checkInstallDatabase(ctx: Ctx, name: string, l: Limits): Promise<DbCheck> {
  const problems: string[] = []
  const r = await ctx.sys.query('postgres', `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolconnlimit,
      d.datconnlimit, has_database_privilege('public', d.datname, 'CONNECT'), pg_catalog.pg_get_userbyid(d.datdba) = r.rolname,
      coalesce(array_to_string(r.rolconfig, ','), '')
    FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname = r.rolname WHERE r.rolname = ${ql(name)}`)
  const row = r[0]
  if (!row) return { name, problems: ['the database or role is missing'] }
  const t = (v: string | undefined) => v === 't' || v === 'true'
  if (t(row[0]) || t(row[1]) || t(row[2]) || t(row[3]) || t(row[4])) problems.push('the role has a superuser, CREATEDB, CREATEROLE, replication or BYPASSRLS attribute')
  if (Number(row[5]) !== l.dbConnections) problems.push(`role connection limit ${row[5]} (expected ${l.dbConnections})`)
  if (Number(row[6]) !== l.dbConnections) problems.push(`database connection limit ${row[6]} (expected ${l.dbConnections})`)
  if (t(row[7])) problems.push('PUBLIC can connect to the database (REVOKE ALL ... FROM PUBLIC missing)')
  if (!t(row[8])) problems.push('the database is not owned by its role')
  if (!row[9].includes('statement_timeout=')) problems.push('no statement_timeout on the role')
  return { name, problems }
}

export async function clusterProblems(ctx: Ctx): Promise<string[]> {
  const out: string[] = []
  for (const d of SHARED_DATABASES) {
    const r = await ctx.sys.query('postgres', `SELECT has_database_privilege('public', ${ql(d)}, 'CONNECT')`)
    if (r[0]?.[0] === 't' || r[0]?.[0] === 'true') out.push(`PUBLIC can connect to ${d} (REVOKE CONNECT ON DATABASE ${d} FROM PUBLIC)`)
  }
  const mc = Number((await ctx.sys.query('postgres', 'SHOW max_connections'))[0]?.[0] ?? 0)
  const orgs = Object.keys(ctx.reg.orgs).length
  if (mc && mc < 12 * Math.max(orgs, 1) + 20) out.push(`max_connections is ${mc}: ${orgs} installs x 12 + the licence service and tools need more (the fleet installer sets 300)`)
  return out
}
