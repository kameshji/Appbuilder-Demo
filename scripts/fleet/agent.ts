#!/usr/bin/env node
/**
 * The fleet agent: abfleet runs it INSIDE one install's context (as the install's OS user, with its instance.env, with
 * the code of the install's own release in ABFLEET_APP), for what the server has no command for yet (mail-setup,
 * db-reach) and, for releases older than the server commands `status --json`, `backup create` and `admin
 * operator-access` (lib/core.ts installCommand picks), for info, backup and access-open / -close. It only calls the
 * product's own modules (backup engine, identity, notifications, licence seats); it never edits product tables by
 * hand. Its last stdout line is JSON ({ ok, ... }); secrets arrive on standard input, never as arguments.
 *
 *   info                                   schema version, users, seat passes, read-only state, licence last check,
 *                                          database size, last install backup
 *   backup --out <file> [--trigger t] [--note n] [--include-key]
 *                                          one verified install archive (createArchive + verifyArchive); passphrase
 *                                          on stdin (empty line: not encrypted)
 *   mail-setup                             saves the fleet's mail relay in the install (JSON on stdin, password included)
 *   access-open --grant g --email e --name n --reason r --until <iso> --operator o [--print-link]
 *                                          a time-boxed install administrator without a password, a one-time invitation
 *                                          that expires with the grant, audit install.operator_access, the install's
 *                                          administrators told (in-app notification, and email when mail is set up)
 *   access-close --grant g --user <id> --why w --operator o
 *                                          the account disabled, signed out everywhere, tokens revoked, audit
 *                                          install.operator_access_end, administrators told
 *   db-reach <database>                    isolation re-check: tries the install's own role against another database
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CoreServices } from '../../server/core/services.ts'

type SettingsM = typeof import('../../server/core/hosting/settings.ts')
type UpdateCliM = typeof import('../../server/core/update/cli.ts')
type DbM = typeof import('../../server/connectors/postgres/db.ts')
type EngineM = typeof import('../../server/core/backup/engine.ts')
type EnvsM = typeof import('../../server/core/environments.ts')
type MetaM = typeof import('../../server/core/meta-store.ts')
type AuthM = typeof import('../../server/core/auth.ts')
type ConfigM = typeof import('../../server/core/config.ts')
type ServicesM = typeof import('../../server/core/services.ts')
type IdentityM = typeof import('../../server/core/identity/index.ts')
type EnvCtxM = typeof import('../../server/core/env-context.ts')
type SeatsM = typeof import('../../server/core/licence/seats.ts')
type ReadOnlyM = typeof import('../../server/core/hosting/read-only.ts')
type NotificationsM = typeof import('../../server/core/notifications.ts')

const reply = (o: Record<string, unknown>): void => { process.stdout.write('\n' + JSON.stringify(o) + '\n') }
const fail = (e: unknown): never => {
  reply({ ok: false, error: e instanceof Error ? e.message : String(e) })
  process.exit(1)
}

function flags(argv: string[], bool: string[]): { args: string[]; o: Record<string, string | true> } {
  const o: Record<string, string | true> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const k = a.slice(2); if (bool.includes(k)) o[k] = true; else o[k] = argv[++i] ?? '' } else args.push(a)
  }
  return { args, o }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const app = process.env.ABFLEET_APP
if (!app) fail('ABFLEET_APP is not set (the release folder of the install)')
/** local test mode only: a release folder that stands for a source tree */
let code = app!
const marker = path.join(app!, 'fleet-local-code.txt')
if (process.env.ABFLEET_LOCAL === '1' && fs.existsSync(marker)) code = fs.readFileSync(marker, 'utf8').trim()
const imp = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(code, rel)).href)) as T

const settings = await imp<SettingsM>('server/core/hosting/settings.ts')
settings.loadInstanceEnv()
settings.applyHostingDefaults()
const env = process.env

async function withDb<T>(fn: (db: ReturnType<DbM['createPgDb']>) => Promise<T>): Promise<T> {
  const { databaseLogin } = await imp<UpdateCliM>('server/core/update/cli.ts')
  const { createPgDb } = await imp<DbM>('server/connectors/postgres/db.ts')
  const login = databaseLogin(env)
  if (!login) throw new Error('no database login is saved (server.json)')
  const db = createPgDb(login.settings, login.password, { max: 1, onError: () => {} })
  try {
    return await fn(db)
  } finally {
    await db.close().catch(() => {})
  }
}

/** the server's services without HTTP and without the job worker (as the hosting CLI's own commands open them) */
async function withServices<T>(fn: (s: CoreServices) => Promise<T>): Promise<T> {
  const { loadConfig } = await imp<ConfigM>('server/core/config.ts')
  const { createServices } = await imp<ServicesM>('server/core/services.ts')
  const { createPgDb } = await imp<DbM>('server/connectors/postgres/db.ts')
  const s = createServices(loadConfig(env), { env, sqlDbFactory: (st, pw) => createPgDb(st, pw, { max: 2, onError: () => {} }) })
  settings.configureHosting(s, settings.hostingSettings(env))
  // the in-app notification service (createApp makes it in the server; it writes ab.notifications)
  if (!s.notifications) s.notifications = (await imp<NotificationsM>('server/core/notifications.ts')).createNotificationService({ services: s })
  await s.boot()
  if (!s.ready()) {
    await s.close().catch(() => {})
    throw new Error(`the database could not be opened: ${s.state.databaseError ?? 'not configured'}`)
  }
  try {
    return await fn(s)
  } finally {
    await s.close().catch(() => {})
  }
}

const opt = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null)

async function info(): Promise<void> {
  const ro = await imp<ReadOnlyM>('server/core/hosting/read-only.ts')
  const seats = await imp<SeatsM>('server/core/licence/seats.ts')
  const fromEnv = settings.hostingSettings(env).readOnly
  const r = await withDb(async (db) => {
    const schema = await opt(db.query<{ v: string }>(`SELECT v FROM "ab"."settings" WHERE k = 'schemaVersion'`))
    const users = await opt(db.query<{ a: string; t: string }>(`SELECT count(*) FILTER (WHERE status <> 'disabled' AND kind <> 'service') AS a, count(*) AS t FROM "ab"."users"`))
    const stored = await opt(ro.storedReadOnly(db))
    const lic = await opt(db.query<{ document: { lastCheck?: { at: number; ok: boolean; error: string | null } | null } }>(`SELECT document FROM "ab"."licence" WHERE id = 1`))
    const size = await opt(db.query<{ n: string }>(`SELECT pg_catalog.pg_database_size(pg_catalog.current_database()) AS n`))
    const last = await opt(db.query<{ at: Date | null }>(`SELECT max(created_on) AS at FROM "ab"."backups" WHERE state = 'ok'`))
    const lc = lic?.[0]?.document?.lastCheck ?? null
    return {
      schemaVersion: schema?.[0] ? Number(schema[0].v) : null,
      users: users?.[0] ? { active: Number(users[0].a), total: Number(users[0].t) } : null,
      seats: await opt(seats.seatCounts(db)),
      readOnly: fromEnv ? { reason: fromEnv.reason, since: null, source: 'env' } : stored ? { reason: stored.reason, since: stored.since, source: 'cli' } : null,
      licence: { configured: !!(env.APPBUILDER_LICENCE_URL && env.APPBUILDER_LICENCE_ID), lastCheck: lc ? { at: new Date(lc.at).toISOString(), ok: lc.ok, error: lc.error } : null },
      dbBytes: size?.[0] ? Number(size[0].n) : null,
      lastInstallBackup: last?.[0]?.at ? new Date(last[0].at).toISOString() : null,
    }
  })
  reply({ ok: true, ...r })
}

async function backup(o: Record<string, string | true>): Promise<void> {
  const out = typeof o.out === 'string' ? path.resolve(o.out) : ''
  if (!out) throw new Error('--out is needed')
  const pass = (await readStdin()).split(/\r?\n/)[0] ?? ''
  const engine = await imp<EngineM>('server/core/backup/engine.ts')
  const { environmentDirs } = await imp<EnvsM>('server/core/environments.ts')
  const { SCHEMA_VERSION } = await imp<MetaM>('server/core/meta-store.ts')
  const { serverVersion } = await imp<AuthM>('server/core/auth.ts')
  const { databaseLogin } = await imp<UpdateCliM>('server/core/update/cli.ts')
  const { loadConfig } = await imp<ConfigM>('server/core/config.ts')
  const login = databaseLogin(env)
  if (!login) throw new Error('no database login is saved (server.json)')
  const ws = loadConfig(env).workspaceDir
  let key: string | null = null
  if (o['include-key']) {
    key = (env.APPBUILDER_SECRET_KEY || fs.readFileSync(path.join(ws, '.secret-key'), 'utf8')).trim()
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('the install key is not 64 hex characters')
  }
  const sources = await withDb((db) => db.query<{ id: string; name: string; type: string; schema_name: string; schema_version: number | null; locked: boolean | null; description: string | null }>(
    `SELECT id, name, type, schema_name, schema_version, locked, description FROM "ab"."environments" WHERE state = 'ready' ORDER BY id`))
  const id = `fl${Date.now().toString(36)}`
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
  const res = await engine.createArchive({ settings: login.settings, password: login.password }, {
    id, kind: 'install', file: out, method: 'auto', pgBin: env.APPBUILDER_PG_BIN || null, passphrase: pass || null, secretKey: key,
    environments: sources.map((e) => ({ id: e.id, name: e.name, type: e.type, schema: e.schema_name, schemaVersion: Number(e.schema_version) || SCHEMA_VERSION, locked: !!e.locked, ...(e.description ? { description: e.description } : {}) })),
    trigger: (typeof o.trigger === 'string' ? o.trigger : 'manual') as Parameters<EngineM['createArchive']>[1]['trigger'],
    note: typeof o.note === 'string' ? o.note.slice(0, 300) : 'abfleet', createdBy: null, appVersion: serverVersion(), schemaVersion: SCHEMA_VERSION,
    dirs: (eid) => environmentDirs(ws, eid),
  })
  const a = await engine.openArchive(out, pass || null)
  let v
  try {
    v = await engine.verifyArchive(a, { expectedManifestSha256: res.manifestSha256 })
  } finally {
    await a.close()
  }
  if (!v.ok) { fs.rmSync(out, { force: true }); throw new Error(`verification failed: ${v.errors.slice(0, 3).join(' ')}`) }
  reply({ ok: true, file: out, bytes: res.bytes, sha256: res.sha256, manifestSha256: res.manifestSha256, rows: v.rows, schemaVersion: SCHEMA_VERSION, environments: sources.length })
}

async function mailSetup(): Promise<void> {
  const b = JSON.parse((await readStdin()).trim()) as Record<string, unknown>
  await withServices(async (s) => {
    const { identity } = await imp<IdentityM>('server/core/identity/index.ts')
    await identity(s).mail.saveSettings({ host: b.host, port: b.port, security: b.security, username: b.username, password: b.password, fromAddress: b.fromAddress, fromName: b.fromName, installName: b.installName })
    await s.install!.audit({ userId: null, action: 'install.mail_relay_set', environmentId: null, details: { host: b.host, source: 'abfleet', osUser: os.userInfo().username } })
  })
  reply({ ok: true })
}

async function installAdmins(s: CoreServices, except: string | null): Promise<{ id: string; email: string }[]> {
  const rows = await s.state.db!.query<{ id: string; email: string }>(`SELECT id, email FROM "ab"."users" WHERE is_install_admin AND status <> 'disabled' AND kind <> 'service'`)
  return rows.filter((r) => r.id !== except)
}

async function tell(s: CoreServices, except: string | null, title: string, body: string): Promise<{ notified: number; emailed: number }> {
  const { identity } = await imp<IdentityM>('server/core/identity/index.ts')
  const admins = await installAdmins(s, except)
  let notified = 0
  let emailed = 0
  if (admins.length && s.notifications) {
    const r = await s.notifications.notify({ userIds: admins.map((a) => a.id) }, { kind: 'system', title, body, link: '#admin-users', source: 'system', environmentId: null })
    notified = r.delivered.length
  }
  const idn = identity(s)
  if (admins.length && (await idn.mail.configured())) {
    await idn.mail.send({ to: admins.map((a) => a.email), template: 'operator_access', subject: title, text: `${body}\n\nThis message was sent by Appbuilder because the service operator used its operator access procedure.` })
    emailed = admins.length
  }
  return { notified, emailed }
}

async function accessOpen(o: Record<string, string | true>): Promise<void> {
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
  const email = s('email').toLowerCase()
  const until = new Date(s('until'))
  if (!email || !s('grant') || !s('reason') || Number.isNaN(until.getTime())) throw new Error('access-open needs --grant, --email, --reason and --until')
  const ttl = until.getTime() - Date.now()
  if (ttl <= 0 || ttl > 4 * 3_600_000 + 60_000) throw new Error('the access window must end within 4 hours')
  await withServices(async (sv) => {
    const { identity } = await imp<IdentityM>('server/core/identity/index.ts')
    const { ensureBuiltinRoles, ROLE_ADMIN } = await imp<AuthM>('server/core/auth.ts')
    const { DEFAULT_ENVIRONMENT_ID } = await imp<EnvCtxM>('server/core/env-context.ts')
    const idn = identity(sv)
    const brand = await idn.mail.brand()
    if (!brand.publicUrl) throw new Error('the install has no public address')
    if (await sv.meta.users.byEmail(email)) throw new Error(`there is already an account ${email}`)
    await ensureBuiltinRoles(sv)
    const id = sv.uid('user')
    await sv.meta.users.insert({ id, name: s('name').slice(0, 200) || 'Operator access', email, roleIds: [ROLE_ADMIN], status: 'active', passwordHash: null, isInstallAdmin: true, lastEnvironmentId: DEFAULT_ENVIRONMENT_ID })
    sv.security.invalidate()
    const t = await idn.createToken('invite', id, { ttlMs: ttl, createdBy: null, data: { via: 'abfleet', grant: s('grant') } })
    const link = `${brand.publicUrl}/#invite=${t.raw}`
    const mail = await idn.mail.configured()
    if (mail) await idn.mail.sendTemplate('invitation', email, { name: s('name'), email, link, days: 1, invitedBy: 'the service operator' }, id)
    const details = { grant: s('grant'), userId: id, email, reason: s('reason'), until: until.toISOString(), operator: s('operator'), source: 'abfleet', osUser: os.userInfo().username, host: os.hostname() }
    await sv.install!.audit({ userId: null, action: 'install.operator_access', environmentId: null, details })
    await sv.meta.audit({ userId: null, action: 'user.create', details: { id, email, roleIds: [ROLE_ADMIN], status: 'active', via: 'abfleet operator access' } }).catch(() => {})
    const t2 = await tell(sv, id, 'Operator access to this Appbuilder', `The service operator (${s('operator')}) has install administrator access until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC. Reason: ${s('reason')}. The account "${s('name')}" (${email}) is disabled automatically at that time. This is recorded in the audit log (install.operator_access).`)
    reply({ ok: true, userId: id, emailed: mail, notified: t2.notified + t2.emailed, ...(o['print-link'] ? { link } : {}) })
  })
}

async function accessClose(o: Record<string, string | true>): Promise<void> {
  const userId = typeof o.user === 'string' ? o.user : ''
  if (!userId) throw new Error('--user is needed')
  await withServices(async (sv) => {
    const { identity } = await imp<IdentityM>('server/core/identity/index.ts')
    const idn = identity(sv)
    const u = await sv.meta.users.get(userId).catch(() => null)
    if (u) {
      await sv.meta.users.update(userId, { status: 'disabled' })
      await idn.signOutEverywhere(userId)
      await idn.revokeTokens(userId, ['invite', 'reset', 'email_change', 'mfa_pending', 'email_code', 'email_setup'])
      sv.security.invalidate()
    }
    await sv.install!.audit({ userId: null, action: 'install.operator_access_end', environmentId: null, details: { grant: o.grant, userId, why: o.why, operator: o.operator, source: 'abfleet', osUser: os.userInfo().username } })
    const why = o.why === 'expired' ? 'its time ran out' : `it was ${String(o.why)} by ${String(o.operator)}`
    const t = u ? await tell(sv, userId, 'Operator access ended', `The operator access account "${u.name}" (${u.email}) was disabled and signed out: ${why}. Recorded in the audit log (install.operator_access_end).`) : { notified: 0, emailed: 0 }
    reply({ ok: true, disabled: !!u, notified: t.notified + t.emailed })
  })
}

async function dbReach(database: string): Promise<void> {
  const { databaseLogin } = await imp<UpdateCliM>('server/core/update/cli.ts')
  const { createPgDb } = await imp<DbM>('server/connectors/postgres/db.ts')
  const login = databaseLogin(env)
  if (!login) throw new Error('no database login is saved (server.json)')
  const db = createPgDb({ ...login.settings, database }, login.password, { max: 1, onError: () => {} })
  try {
    await db.query('SELECT 1')
    reply({ ok: true, connected: true })
  } catch (e) {
    reply({ ok: true, connected: false, code: (e as { code?: string }).code ?? 'error', message: String((e as Error).message ?? e).replace(login.password, '***').slice(0, 200) })
  } finally {
    await db.close().catch(() => {})
  }
}

const [cmd, ...rest] = process.argv.slice(2)
const { args, o } = flags(rest, ['include-key', 'print-link'])
try {
  switch (cmd) {
    case 'info': await info(); break
    case 'backup': await backup(o); break
    case 'mail-setup': await mailSetup(); break
    case 'access-open': await accessOpen(o); break
    case 'access-close': await accessClose(o); break
    case 'db-reach': await dbReach(args[0] ?? ''); break
    default: throw new Error(`unknown agent command ${cmd ?? ''}`)
  }
  process.exit(0)
} catch (e) {
  fail(e)
}
