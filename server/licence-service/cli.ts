/**
 * The licence service's operator CLI (package H-G; docs/admin/licensing.md "Operating the licence service").
 *
 *   node server/licence-service/main.ts <command>     (or: node server/main.ts licence-service <command>)
 *
 *   serve                                   the HTTP service (APPBUILDER_LICENCE_HOST 127.0.0.1, _PORT 7090; TLS with
 *                                           APPBUILDER_LICENCE_TLS_CERT / _TLS_KEY, else behind Caddy)
 *   migrate                                 creates the schema
 *   keygen --out <dir>                      a new Ed25519 signing key pair (passphrase from
 *          [--passphrase-file <f>]          APPBUILDER_LICENCE_KEY_PASSPHRASE or the file); refuses a folder inside the
 *                                           repository (except the git-ignored .sandbox for tests)
 *   org create --name <n> [--plan p] [--kind subscription|lifetime] [--full n] [--operator n] [--external n]
 *              [--paid-until YYYY-MM-DD] [--notice-days n] [--maintenance-until YYYY-MM-DD]
 *   org list | org show <org>               (org = licence id or name); show lists installs, keys and last check-ins
 *   key issue <org> | key rotate <org> | key revoke <org> [--key <key id>]
 *   plan set <org> <plan>
 *   seats set <org> [--full n] [--operator n] [--external n]
 *   payment record <org> --paid-until YYYY-MM-DD --reference <invoice or transfer reference>
 *   suspend <org> [--notice-days n] [--message <text>] | resume <org> | cancel <org> [--notice-days n]
 *   checkins <org> [--limit n]
 *   install release <org> <install id>     an install that no longer exists (stops the duplicate flag)
 *   audit [--limit n]
 *
 * Every command that reads or changes an organisation is written to lic.audit (OS user, command, organisation,
 * result). Install keys are printed once and stored as SHA-256 only. Nothing here prints a signing key.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { generateLicenceKey, loadSigningKey, newInstallKey, newLicenceId } from '../core/licence/answer.ts'
import { trustedKeyEntry } from '../core/update/release.ts'
import { createPublicKey } from 'node:crypto'
import type { SqlDb } from '../core/contracts.ts'
import { audit, getOrg, hashKey, migrate, openDb, orgOf, tables } from './store.ts'
import { createHandler, listen } from './service.ts'

export interface Io { out(s: string): void; err(s: string): void }
const stdio: Io = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function flags(argv: string[]): { args: string[]; o: Record<string, string> } {
  const o: Record<string, string> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i] ?? ''
    else args.push(argv[i])
  }
  return { args, o }
}

class UsageError extends Error {}
const intOpt = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new UsageError(`--${name} is a whole number (0 or more).`)
  return n
}
const dateOpt = (v: string | undefined, name: string): Date | undefined => {
  if (v === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new UsageError(`--${name} is a date YYYY-MM-DD.`)
  // the whole day counts: paid until 2026-12-31 means until the end of that day (UTC)
  return new Date(Date.parse(v) + 86_400_000 - 1)
}
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-')

export const USAGE = `Usage: licence-service <serve | migrate | keygen | org | key | plan | seats | payment | suspend | resume | cancel | checkins | install | audit> ...
See docs/admin/licensing.md.`

export function passphrase(env: NodeJS.ProcessEnv, file?: string): string {
  if (file) return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '')
  if (env.APPBUILDER_LICENCE_KEY_PASSPHRASE_FILE) return fs.readFileSync(env.APPBUILDER_LICENCE_KEY_PASSPHRASE_FILE, 'utf8').replace(/\r?\n$/, '')
  if (env.APPBUILDER_LICENCE_KEY_PASSPHRASE) return env.APPBUILDER_LICENCE_KEY_PASSPHRASE
  throw new UsageError('Give the signing key passphrase: --passphrase-file <file>, APPBUILDER_LICENCE_KEY_PASSPHRASE_FILE or APPBUILDER_LICENCE_KEY_PASSPHRASE.')
}

/** `keygen`: outside the repository (the git-ignored .sandbox folder is allowed for tests) */
export function keygen(out: string, pass: string, io: Io = stdio): { keyFile: string; pubFile: string; id: string } {
  const dir = path.resolve(out)
  const inRepo = dir === repoRoot || dir.startsWith(repoRoot + path.sep)
  const inSandbox = dir.startsWith(path.join(repoRoot, '.sandbox') + path.sep)
  if (inRepo && !inSandbox) throw new UsageError('Choose a folder outside the repository: the private key must never be committed.')
  const k = generateLicenceKey(pass)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const keyFile = path.join(dir, `appbuilder-licence-${k.id}.key`)
  const pubFile = path.join(dir, `appbuilder-licence-${k.id}.pub`)
  fs.writeFileSync(keyFile, k.privatePem, { mode: 0o600, flag: 'wx' })
  fs.writeFileSync(pubFile, k.publicPem, { mode: 0o644, flag: 'wx' })
  const entry = trustedKeyEntry(createPublicKey(k.publicPem), `Appbuilder licence key ${new Date().toISOString().slice(0, 10)}`)
  io.out(`Private key: ${keyFile}\nPublic key:  ${pubFile}\nKey id:      ${k.id}\n\nFor releases: add this entry to "keys" in server/core/licence/licence-keys.json and commit it (public key only).\nFor a test or evaluation install: APPBUILDER_LICENCE_PUBLIC_KEY_FILE=${pubFile}\n${JSON.stringify(entry, null, 2)}`)
  return { keyFile, pubFile, id: k.id }
}

async function issueKey(db: SqlDb, orgId: string): Promise<{ id: string; key: string }> {
  const key = newInstallKey()
  const id = 'key_' + randomBytes(5).toString('hex')
  await db.exec(`INSERT INTO ${tables.keys} (id, org_id, key_hash, created_on) VALUES ($1, $2, $3, $4)`, [id, orgId, hashKey(key), new Date()])
  return { id, key }
}

async function needOrg(db: SqlDb, ref: string | undefined) {
  if (!ref) throw new UsageError('Name the organisation (licence id or name).')
  const o = await getOrg(db, ref)
  if (!o) throw new UsageError(`No organisation "${ref}".`)
  return o
}

/** the commands that need the database; returns the organisation id for the audit */
async function run(db: SqlDb, argv: string[], io: Io): Promise<{ org: string | null; details: unknown }> {
  const [group, sub] = argv
  const { args, o } = flags(argv.slice(group === 'org' || group === 'key' || group === 'plan' || group === 'seats' || group === 'payment' || group === 'install' ? 2 : 1))
  const now = new Date()
  switch (group) {
    case 'org': {
      if (sub === 'create') {
        const name = (o.name ?? '').trim()
        if (!name || name.length > 120) throw new UsageError('--name is required (at most 120 characters).')
        const kind = o.kind ?? 'subscription'
        if (kind !== 'subscription' && kind !== 'lifetime') throw new UsageError('--kind is subscription or lifetime.')
        const id = newLicenceId()
        const paid = kind === 'subscription' ? (dateOpt(o['paid-until'], 'paid-until') ?? new Date(now.getTime() + 30 * 86_400_000)) : null
        await db.exec(
          `INSERT INTO ${tables.org} (id, name, plan, kind, state, state_since, seats_full, seats_operator, seats_external, paid_until, notice_days, maintenance_until, created_on)
           VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $5)`,
          [id, name, (o.plan ?? 'standard').slice(0, 60), kind, now, intOpt(o.full, 'full') ?? 5, intOpt(o.operator, 'operator') ?? 20, intOpt(o.external, 'external') ?? 0, paid, intOpt(o['notice-days'], 'notice-days') ?? 14, kind === 'lifetime' ? (dateOpt(o['maintenance-until'], 'maintenance-until') ?? null) : null],
        )
        io.out(`Organisation ${name}: licence id ${id} (${kind}${paid ? `, paid until ${day(paid)}` : ''}). Next: key issue ${id}`)
        return { org: id, details: { name, kind, plan: o.plan ?? 'standard' } }
      }
      if (sub === 'list') {
        const rows = (await db.query<Record<string, unknown>>(`SELECT * FROM ${tables.org} ORDER BY created_on`)).map(orgOf)
        const last = new Map((await db.query<{ org_id: string; at: Date }>(`SELECT org_id, max(last_seen) AS at FROM ${tables.installs} GROUP BY org_id`)).map((r) => [r.org_id, r.at]))
        io.out('licence id         name                      kind          state      plan        seats f/o/e   paid until   last check')
        for (const r of rows) io.out(`${r.id.padEnd(18)} ${r.name.slice(0, 25).padEnd(25)} ${r.kind.padEnd(13)} ${r.state.padEnd(10)} ${r.plan.slice(0, 11).padEnd(11)} ${`${r.seats.full}/${r.seats.operator}/${r.seats.external}`.padEnd(13)} ${day(r.paidUntil).padEnd(12)} ${last.get(r.id)?.toISOString() ?? 'never'}${r.duplicateSince ? '  DUPLICATE INSTALLS' : ''}`)
        return { org: null, details: { count: rows.length } }
      }
      if (sub === 'show') {
        const r = await needOrg(db, args[0])
        io.out(JSON.stringify({ ...r, paidUntil: r.paidUntil?.toISOString() ?? null }, null, 2))
        const keys = await db.query<{ id: string; created_on: Date; revoked_on: Date | null }>(`SELECT id, created_on, revoked_on FROM ${tables.keys} WHERE org_id = $1 ORDER BY created_on`, [r.id])
        io.out('install keys:')
        for (const k of keys) io.out(`  ${k.id}  issued ${k.created_on.toISOString()}  ${k.revoked_on ? `revoked ${k.revoked_on.toISOString()}` : 'active'}`)
        const ins = await db.query<{ install_id: string; first_seen: Date; last_seen: Date; version: string; seats: unknown; released: boolean }>(`SELECT * FROM ${tables.installs} WHERE org_id = $1 ORDER BY first_seen`, [r.id])
        io.out('installs:')
        for (const i of ins) io.out(`  ${i.install_id}  first ${i.first_seen.toISOString()}  last ${i.last_seen.toISOString()}  ${i.version}  seats ${JSON.stringify(i.seats)}${i.released ? '  released' : ''}`)
        if (r.duplicateSince) io.out(`DUPLICATE: two installs have alternated on this licence since ${r.duplicateSince.toISOString()}; after 7 days the older one is answered "duplicate".`)
        await printCheckins(db, r.id, 10, io)
        return { org: r.id, details: null }
      }
      throw new UsageError('org create | list | show <org>')
    }
    case 'key': {
      const r = await needOrg(db, args[0])
      if (sub === 'issue' || sub === 'rotate') {
        let revoked = 0
        if (sub === 'rotate') revoked = (await db.exec(`UPDATE ${tables.keys} SET revoked_on = $2 WHERE org_id = $1 AND revoked_on IS NULL`, [r.id, now])).affectedRows
        const k = await issueKey(db, r.id)
        io.out(`Install key ${k.id} for ${r.name} (shown once; store it in the install's environment as APPBUILDER_LICENCE_KEY or a file named by APPBUILDER_LICENCE_KEY_FILE):\n${k.key}\nAPPBUILDER_LICENCE_ID=${r.id}${revoked ? `\n${revoked} earlier key(s) revoked.` : ''}`)
        return { org: r.id, details: { keyId: k.id, revoked } }
      }
      if (sub === 'revoke') {
        const n = o.key
          ? (await db.exec(`UPDATE ${tables.keys} SET revoked_on = $3 WHERE org_id = $1 AND id = $2 AND revoked_on IS NULL`, [r.id, o.key, now])).affectedRows
          : (await db.exec(`UPDATE ${tables.keys} SET revoked_on = $2 WHERE org_id = $1 AND revoked_on IS NULL`, [r.id, now])).affectedRows
        io.out(`${n} key(s) revoked for ${r.name}. Installs using them get "refused" and become read-only when their last valid answer runs out (at most 72 hours).`)
        return { org: r.id, details: { revoked: n, key: o.key ?? 'all' } }
      }
      throw new UsageError('key issue | rotate | revoke <org> [--key <id>]')
    }
    case 'plan': {
      if (sub !== 'set') throw new UsageError('plan set <org> <plan>')
      const r = await needOrg(db, args[0])
      const plan = (args[1] ?? '').trim()
      if (!plan || plan.length > 60) throw new UsageError('Name the plan (at most 60 characters).')
      await db.exec(`UPDATE ${tables.org} SET plan = $2 WHERE id = $1`, [r.id, plan])
      io.out(`${r.name}: plan ${plan}.`)
      return { org: r.id, details: { from: r.plan, to: plan } }
    }
    case 'seats': {
      if (sub !== 'set') throw new UsageError('seats set <org> [--full n] [--operator n] [--external n]')
      const r = await needOrg(db, args[0])
      const s = { full: intOpt(o.full, 'full') ?? r.seats.full, operator: intOpt(o.operator, 'operator') ?? r.seats.operator, external: intOpt(o.external, 'external') ?? r.seats.external }
      await db.exec(`UPDATE ${tables.org} SET seats_full = $2, seats_operator = $3, seats_external = $4 WHERE id = $1`, [r.id, s.full, s.operator, s.external])
      io.out(`${r.name}: seats Full ${s.full}, Operator ${s.operator}, External ${s.external}.`)
      return { org: r.id, details: { from: r.seats, to: s } }
    }
    case 'payment': {
      if (sub !== 'record') throw new UsageError('payment record <org> --paid-until YYYY-MM-DD --reference <text>')
      const r = await needOrg(db, args[0])
      const until = dateOpt(o['paid-until'], 'paid-until')
      const ref = (o.reference ?? '').trim()
      if (!until || !ref) throw new UsageError('--paid-until and --reference are required.')
      await db.tx(async (tx) => {
        await tx.exec(`INSERT INTO ${tables.payments} (org_id, recorded_on, paid_until, reference) VALUES ($1, $2, $3, $4)`, [r.id, now, until, ref.slice(0, 200)])
        await tx.exec(`UPDATE ${tables.org} SET paid_until = $2 WHERE id = $1`, [r.id, until])
      })
      io.out(`${r.name}: paid until ${day(until)} (${ref}).`)
      return { org: r.id, details: { paidUntil: day(until), reference: ref.slice(0, 200), was: day(r.paidUntil) } }
    }
    case 'suspend': case 'cancel': {
      const r = await needOrg(db, args[0])
      const notice = intOpt(o['notice-days'], 'notice-days') ?? 0
      const state = group === 'suspend' ? 'suspended' : 'cancelled'
      await db.exec(`UPDATE ${tables.org} SET state = $2, state_since = $3, state_notice_days = $4, state_message = $5 WHERE id = $1`, [r.id, state, now, notice, o.message ? o.message.replace(/[\r\n]+/g, ' ').slice(0, 200) : null])
      io.out(`${r.name}: ${state}; its installs become read-only ${notice ? `in ${notice} day(s)` : 'at their next check'} (sign-in and export keep working).`)
      return { org: r.id, details: { state, noticeDays: notice } }
    }
    case 'resume': {
      const r = await needOrg(db, args[0])
      await db.exec(`UPDATE ${tables.org} SET state = 'active', state_since = $2, state_notice_days = 0, state_message = NULL WHERE id = $1`, [r.id, now])
      io.out(`${r.name}: active again; its installs are writable at their next check (or "Check now" in Admin console > Licences).`)
      return { org: r.id, details: { was: r.state } }
    }
    case 'checkins': {
      const r = await needOrg(db, args[0])
      await printCheckins(db, r.id, intOpt(o.limit, 'limit') ?? 20, io)
      return { org: r.id, details: null }
    }
    case 'install': {
      if (sub !== 'release') throw new UsageError('install release <org> <install id>')
      const r = await needOrg(db, args[0])
      const n = (await db.exec(`UPDATE ${tables.installs} SET released = true WHERE org_id = $1 AND install_id = $2`, [r.id, args[1] ?? ''])).affectedRows
      if (!n) throw new UsageError(`No install ${args[1] ?? ''} on ${r.name}.`)
      await db.exec(`UPDATE ${tables.org} SET duplicate_since = NULL WHERE id = $1`, [r.id])
      io.out(`${r.name}: install ${args[1]} released (no longer counted for duplicates; it is counted again if it checks in).`)
      return { org: r.id, details: { install: args[1] } }
    }
    case 'audit': {
      const rows = await db.query<{ at: Date; os_user: string; command: string; org_id: string | null; ok: boolean }>(`SELECT at, os_user, command, org_id, ok FROM ${tables.audit} ORDER BY id DESC LIMIT $1`, [intOpt(o.limit, 'limit') ?? 30])
      for (const a of rows) io.out(`${a.at.toISOString()}  ${a.ok ? 'ok    ' : 'FAILED'}  ${a.os_user}  ${a.command}${a.org_id ? `  ${a.org_id}` : ''}`)
      return { org: null, details: null }
    }
    default:
      throw new UsageError(USAGE)
  }
}

async function printCheckins(db: SqlDb, orgId: string, limit: number, io: Io): Promise<void> {
  const rows = await db.query<{ at: Date; install_id: string; version: string; seats: unknown; outcome: string }>(`SELECT at, install_id, version, seats, outcome FROM ${tables.checkins} WHERE org_id = $1 ORDER BY at DESC LIMIT $2`, [orgId, limit])
  io.out('last check-ins:')
  if (!rows.length) io.out('  none')
  for (const c of rows) io.out(`  ${c.at.toISOString()}  ${c.install_id}  ${c.version}  ${c.outcome}  seats ${JSON.stringify(c.seats)}`)
}

/** the command line; resolves the exit code (serve resolves when the server stops) */
export async function runLicenceCli(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = stdio): Promise<number> {
  const cmd = argv[0]
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') {
      io.out(USAGE)
      return cmd ? 0 : 2
    }
    if (cmd === 'keygen') {
      const { o } = flags(argv.slice(1))
      if (!o.out) throw new UsageError('keygen --out <folder outside the repository> [--passphrase-file <file>]')
      keygen(o.out, passphrase(env, o['passphrase-file']), io)
      return 0
    }
    if (cmd === 'serve') return await serve(env, io)
    const db = openDb(env)
    try {
      await migrate(db)
      if (cmd === 'migrate') {
        io.out('The licence service schema is up to date.')
        await audit(db, 'migrate', null, true, null)
        return 0
      }
      const label = argv.slice(0, cmd === 'org' || cmd === 'key' || cmd === 'plan' || cmd === 'seats' || cmd === 'payment' || cmd === 'install' ? 2 : 1).join(' ')
      try {
        const r = await run(db, argv, io)
        await audit(db, label, r.org, true, r.details)
        return 0
      } catch (e) {
        await audit(db, label, null, false, { error: e instanceof Error ? e.message.slice(0, 300) : String(e) }).catch(() => {})
        throw e
      }
    } finally {
      await db.close()
    }
  } catch (e) {
    io.err(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
    return e instanceof UsageError ? 2 : 1
  }
}

async function serve(env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const keyFile = env.APPBUILDER_LICENCE_SIGNING_KEY
  if (!keyFile) throw new UsageError('Set APPBUILDER_LICENCE_SIGNING_KEY to the private key file made by "keygen" (and its passphrase: APPBUILDER_LICENCE_KEY_PASSPHRASE_FILE).')
  const key = loadSigningKey(fs.readFileSync(keyFile, 'utf8'), passphrase(env))
  const db = openDb(env, 6)
  await migrate(db)
  const host = env.APPBUILDER_LICENCE_HOST || '127.0.0.1'
  const port = Number(env.APPBUILDER_LICENCE_PORT || 7090)
  const handler = createHandler({
    db, key, ratePerMinute: Number(env.APPBUILDER_LICENCE_RATE_PER_MIN) || 30, trustProxy: env.APPBUILDER_LICENCE_TRUST_PROXY === '1',
    log: (level, msg) => (level === 'info' ? io.out : io.err)(`[${level}] ${msg}`),
  })
  const server = await listen(handler, { host, port, tlsCert: env.APPBUILDER_LICENCE_TLS_CERT || null, tlsKey: env.APPBUILDER_LICENCE_TLS_KEY || null })
  io.out(`Appbuilder licence service listening on ${env.APPBUILDER_LICENCE_TLS_CERT ? 'https' : 'http'}://${host}:${port} (signing key ${key.keyId})`)
  return new Promise((resolve) => {
    const stop = () => {
      server.close()
      server.closeIdleConnections()
      void db.close().finally(() => resolve(0))
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
