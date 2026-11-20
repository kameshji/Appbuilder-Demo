/**
 * The licence service's database (package H-G; docs/dev/licensing.md "Service"). Its own PostgreSQL database
 * (APPBUILDER_LICENCE_DB_URL), schema `lic`, created by `licence-service migrate` (and at `serve`). Nothing here comes
 * from a product install: an install sends only its licence id, install id, version and seat counts.
 *
 *   lic.organisations  one per customer organisation: licence id, name, plan, kind (subscription | lifetime), state
 *                      (active | suspended | cancelled), seats per pass, paid until, notice days, maintenance until
 *   lic.install_keys   install keys (SHA-256 only; the key is shown once), revoked_on
 *   lic.installs       installs seen per organisation (install id, first / last check, version, seats in use)
 *   lic.checkins       every check: time, install id, version, seat counts, outcome (no address, no person)
 *   lic.payments       payment state recorded by the operator (invoice reference, paid until)
 *   lic.audit          every operator command (who: the OS user, what, which organisation, details)
 */
import { createHash } from 'node:crypto'
import os from 'node:os'
import { createPgDb, type PgDb } from '../connectors/postgres/db.ts'
import type { SqlDb } from '../core/contracts.ts'
import type { LicenceKind, SeatCounts } from '../core/licence/answer.ts'

export const SCHEMA = 'lic'
const T = (t: string) => `"${SCHEMA}"."${t}"`

export const DDL: string[] = [
  `CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`,
  `CREATE TABLE IF NOT EXISTS ${T('organisations')} (
    id text PRIMARY KEY,
    name text NOT NULL,
    plan text NOT NULL DEFAULT 'standard',
    kind text NOT NULL DEFAULT 'subscription' CHECK (kind IN ('subscription', 'lifetime')),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'cancelled')),
    state_since timestamptz NOT NULL,
    state_notice_days integer NOT NULL DEFAULT 0,
    state_message text NULL,
    seats_full integer NOT NULL DEFAULT 0,
    seats_operator integer NOT NULL DEFAULT 0,
    seats_external integer NOT NULL DEFAULT 0,
    paid_until timestamptz NULL,
    notice_days integer NOT NULL DEFAULT 14,
    maintenance_until timestamptz NULL,
    duplicate_since timestamptz NULL,
    created_on timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lic_ux_org_name ON ${T('organisations')} (lower(name))`,
  `CREATE TABLE IF NOT EXISTS ${T('install_keys')} (
    id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES ${T('organisations')} (id),
    key_hash text NOT NULL UNIQUE,
    created_on timestamptz NOT NULL,
    revoked_on timestamptz NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${T('installs')} (
    org_id text NOT NULL REFERENCES ${T('organisations')} (id),
    install_id text NOT NULL,
    first_seen timestamptz NOT NULL,
    last_seen timestamptz NOT NULL,
    version text NOT NULL,
    seats jsonb NOT NULL,
    released boolean NOT NULL DEFAULT false,
    PRIMARY KEY (org_id, install_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ${T('checkins')} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL,
    org_id text NULL,
    install_id text NOT NULL,
    version text NOT NULL,
    seats jsonb NOT NULL,
    outcome text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lic_ix_checkins_org ON ${T('checkins')} (org_id, at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${T('payments')} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id text NOT NULL REFERENCES ${T('organisations')} (id),
    recorded_on timestamptz NOT NULL,
    paid_until timestamptz NULL,
    reference text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${T('audit')} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL,
    os_user text NOT NULL,
    command text NOT NULL,
    org_id text NULL,
    ok boolean NOT NULL,
    details jsonb NULL
  )`,
]

export async function migrate(db: SqlDb): Promise<void> {
  await db.tx(async (tx) => {
    for (const s of DDL) await tx.exec(s)
  })
}

export interface DbUrl { host: string; port: number; database: string; user: string; password: string; ssl: boolean }

export function parseDbUrl(raw: string | undefined): DbUrl {
  if (!raw) throw new Error('Set APPBUILDER_LICENCE_DB_URL=postgres://user:password@host:port/database (the licence service\'s own database).')
  const u = new URL(raw)
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('APPBUILDER_LICENCE_DB_URL must be a postgres:// address.')
  return {
    host: u.hostname, port: Number(u.port) || 5432, database: decodeURIComponent(u.pathname.slice(1)) || 'ab_licence',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: u.searchParams.get('sslmode') === 'require',
  }
}

export function openDb(env: NodeJS.ProcessEnv = process.env, max = 4): PgDb {
  const d = parseDbUrl(env.APPBUILDER_LICENCE_DB_URL)
  return createPgDb({ host: d.host, port: d.port, database: d.database, user: d.user, ssl: d.ssl }, d.password, { max, onError: () => {} })
}

export const hashKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex')

/* ------------------------------------------------------------------ rows */

export interface OrgRow {
  id: string; name: string; plan: string; kind: LicenceKind; state: 'active' | 'suspended' | 'cancelled'
  stateSince: Date; stateNoticeDays: number; stateMessage: string | null
  seats: SeatCounts; paidUntil: Date | null; noticeDays: number; maintenanceUntil: Date | null; duplicateSince: Date | null; createdOn: Date
}

type RawOrg = Record<string, unknown>
const d = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null)

export function orgOf(r: RawOrg): OrgRow {
  return {
    id: String(r.id), name: String(r.name), plan: String(r.plan), kind: r.kind as LicenceKind, state: r.state as OrgRow['state'],
    stateSince: d(r.state_since)!, stateNoticeDays: Number(r.state_notice_days), stateMessage: (r.state_message as string | null) ?? null,
    seats: { full: Number(r.seats_full), operator: Number(r.seats_operator), external: Number(r.seats_external) },
    paidUntil: d(r.paid_until), noticeDays: Number(r.notice_days), maintenanceUntil: d(r.maintenance_until), duplicateSince: d(r.duplicate_since), createdOn: d(r.created_on)!,
  }
}

export async function getOrg(db: SqlDb, idOrName: string): Promise<OrgRow | null> {
  const r = await db.query<RawOrg>(`SELECT * FROM ${T('organisations')} WHERE id = $1 OR lower(name) = lower($1)`, [idOrName])
  return r[0] ? orgOf(r[0]) : null
}

export const tables = { org: T('organisations'), keys: T('install_keys'), installs: T('installs'), checkins: T('checkins'), payments: T('payments'), audit: T('audit') }

export function osUser(): string {
  const sudo = process.env.SUDO_USER
  let me = 'unknown'
  try {
    me = os.userInfo().username
  } catch {
    me = process.env.USER || process.env.USERNAME || 'unknown'
  }
  return sudo ? `${sudo} (via sudo as ${me})` : me
}

export async function audit(db: SqlDb, command: string, orgId: string | null, ok: boolean, details: unknown): Promise<void> {
  await db.exec(`INSERT INTO ${T('audit')} (at, os_user, command, org_id, ok, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [new Date(), osUser(), command, orgId, ok, JSON.stringify(details ?? null)])
}
