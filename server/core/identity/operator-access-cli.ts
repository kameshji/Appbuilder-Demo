/**
 * `appbuilder admin operator-access open|close`: the install's half of the hosting operator access procedure (hosting
 * spec section 8; docs/admin/fleet-operations.md "Operator access"). Run as the install's OS user with its environment
 * by `abfleet access grant | revoke | sweep`, or by hand on a single install.
 *
 *   open --grant <id> --email <e> --reason <r> --until <iso> [--name <n>] [--operator <who>] [--print-link] [--json]
 *        an install administrator WITHOUT a password and a one-time invitation that expires at --until (at most 4 hours
 *        from now); audit install.operator_access; every other install administrator is told at once (in-app
 *        notification, and email when the install has a mail relay)
 *   close --user <id> [--grant <id>] [--why expired|revoked|...] [--operator <who>] [--json]
 *        the account disabled, signed out everywhere, its open tokens revoked; audit install.operator_access_end; the
 *        administrators are told
 *
 * Exit 0 done; 1 refused or failed; 2 the database cannot be opened; 64 usage. With --json: one JSON document on
 * stdout ({ ok, userId, emailed, notified [, link] } / { ok, disabled, notified }). The link is printed only with
 * --print-link (it is a secret). Like `admin invite` it opens the server's services in this process (no job worker).
 */
import os from 'node:os'
import { loadConfig } from '../config.ts'
import type { CoreServices } from '../services.ts'
import type { CliIo } from '../hosting/cli.ts'
import { configureHosting, hostingSettings } from '../hosting/settings.ts'

const stdio: CliIo = { out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(l + '\n') }
export const MAX_OPERATOR_ACCESS_MS = 4 * 3_600_000

function flags(argv: string[], bool: string[]): { args: string[]; o: Record<string, string | true> } {
  const o: Record<string, string | true> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const k = a.slice(2); if (bool.includes(k)) o[k] = true; else o[k] = argv[++i] ?? '' } else args.push(a)
  }
  return { args, o }
}

const osUser = (): string => { try { return os.userInfo().username } catch { return process.env.USER || 'unknown' } }

class Refused extends Error {}

async function withServices<T>(env: NodeJS.ProcessEnv, fn: (s: CoreServices) => Promise<T>): Promise<T> {
  const { createServices } = await import('../services.ts')
  const { createPgDb } = await import('../../connectors/postgres/db.ts')
  const s = createServices(loadConfig(env), { env, sqlDbFactory: (st, pw) => createPgDb(st, pw, { max: 2, onError: () => {} }) })
  configureHosting(s, hostingSettings(env))
  // the in-app notification service (createApp makes it in the server; it writes ab.notifications)
  if (!s.notifications) s.notifications = (await import('../notifications.ts')).createNotificationService({ services: s })
  await s.boot()
  if (!s.ready()) {
    await s.close().catch(() => {})
    throw Object.assign(new Error(`the database could not be opened: ${s.state.databaseError ?? 'not configured'}`), { exitCode: 2 })
  }
  try {
    return await fn(s)
  } finally {
    await s.close().catch(() => {})
  }
}

async function tellAdmins(s: CoreServices, except: string | null, title: string, body: string): Promise<{ notified: number; emailed: number }> {
  const { identity } = await import('./index.ts')
  const admins = (await s.state.db!.query<{ id: string; email: string }>(`SELECT id, email FROM "ab"."users" WHERE is_install_admin AND status <> 'disabled' AND kind <> 'service'`)).filter((r) => r.id !== except)
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

export async function operatorAccessOpen(env: NodeJS.ProcessEnv, i: { grant: string; email: string; name?: string; reason: string; until: Date; operator?: string; printLink?: boolean }) {
  const ttl = i.until.getTime() - Date.now()
  if (ttl <= 0 || ttl > MAX_OPERATOR_ACCESS_MS + 60_000) throw new Refused('the access window must end within 4 hours from now')
  const name = (i.name ?? '').slice(0, 200) || 'Operator access'
  const operator = i.operator || osUser()
  return withServices(env, async (sv) => {
    const { identity } = await import('./index.ts')
    const { ensureBuiltinRoles, ROLE_ADMIN } = await import('../auth.ts')
    const { DEFAULT_ENVIRONMENT_ID } = await import('../env-context.ts')
    const idn = identity(sv)
    const brand = await idn.mail.brand()
    if (!brand.publicUrl) throw new Refused('the install has no public address (APPBUILDER_PUBLIC_URL)')
    if (await sv.meta.users.byEmail(i.email)) throw new Refused(`there is already an account ${i.email}`)
    await ensureBuiltinRoles(sv)
    const id = sv.uid('user')
    await sv.meta.users.insert({ id, name, email: i.email, roleIds: [ROLE_ADMIN], status: 'active', passwordHash: null, isInstallAdmin: true, lastEnvironmentId: DEFAULT_ENVIRONMENT_ID })
    sv.security.invalidate()
    const t = await idn.createToken('invite', id, { ttlMs: ttl, createdBy: null, data: { via: 'operator-access', grant: i.grant } })
    const link = `${brand.publicUrl}/#invite=${t.raw}`
    const mail = await idn.mail.configured()
    if (mail) await idn.mail.sendTemplate('invitation', i.email, { name, email: i.email, link, days: 1, invitedBy: 'the service operator' }, id)
    const details = { grant: i.grant, userId: id, email: i.email, reason: i.reason, until: i.until.toISOString(), operator, source: 'cli', osUser: osUser(), host: os.hostname() }
    await sv.install!.audit({ userId: null, action: 'install.operator_access', environmentId: null, details })
    await sv.meta.audit({ userId: null, action: 'user.create', details: { id, email: i.email, roleIds: [ROLE_ADMIN], status: 'active', via: 'operator access' } }).catch(() => {})
    const told = await tellAdmins(sv, id, 'Operator access to this Appbuilder', `The service operator (${operator}) has install administrator access until ${i.until.toISOString().slice(0, 16).replace('T', ' ')} UTC. Reason: ${i.reason}. The account "${name}" (${i.email}) is disabled automatically at that time. This is recorded in the audit log (install.operator_access).`)
    return { ok: true as const, userId: id, expiresOn: t.expiresOn.toISOString(), emailed: mail, notified: told.notified + told.emailed, ...(i.printLink ? { link } : {}) }
  })
}

export async function operatorAccessClose(env: NodeJS.ProcessEnv, i: { user: string; grant?: string; why?: string; operator?: string }) {
  const operator = i.operator || osUser()
  const why = i.why || 'revoked'
  return withServices(env, async (sv) => {
    const { identity } = await import('./index.ts')
    const idn = identity(sv)
    const u = await sv.meta.users.get(i.user).catch(() => null)
    if (u) {
      await sv.meta.users.update(i.user, { status: 'disabled' })
      await idn.signOutEverywhere(i.user)
      await idn.revokeTokens(i.user, ['invite', 'reset', 'email_change', 'mfa_pending', 'email_code', 'email_setup'])
      sv.security.invalidate()
    }
    await sv.install!.audit({ userId: null, action: 'install.operator_access_end', environmentId: null, details: { grant: i.grant ?? null, userId: i.user, why, operator, source: 'cli', osUser: osUser() } })
    const text = why === 'expired' ? 'its time ran out' : `it was ${why} by ${operator}`
    const told = u ? await tellAdmins(sv, i.user, 'Operator access ended', `The operator access account "${u.name}" (${u.email}) was disabled and signed out: ${text}. Recorded in the audit log (install.operator_access_end).`) : { notified: 0, emailed: 0 }
    return { ok: true as const, disabled: !!u, notified: told.notified + told.emailed }
  })
}

const USAGE = `Usage: appbuilder admin operator-access open --grant <id> --email <e> --reason <text> --until <iso time> [--name <n>] [--operator <who>] [--print-link] [--json]
       appbuilder admin operator-access close --user <id> [--grant <id>] [--why <expired|revoked|...>] [--operator <who>] [--json]`

/** argv: what follows "admin operator-access" */
export async function runOperatorAccessCli(argv: string[], o: { env?: NodeJS.ProcessEnv; io?: CliIo } = {}): Promise<number> {
  const env = o.env ?? process.env
  const io = o.io ?? stdio
  const { args, o: f } = flags(argv, ['print-link', 'json'])
  const json = f.json === true
  const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string).replace(/[\r\n]+/g, ' ').trim() : '')
  const done = (r: Record<string, unknown>) => {
    if (json) io.out(JSON.stringify(r))
    else if ('userId' in r) {
      io.out(`Operator access account ${String(r.userId)} created; the invitation expires ${String(r.expiresOn)}; ${String(r.notified)} administrator notice(s).`)
      if (r.link) io.out(`Invitation link (one-time, a secret): ${String(r.link)}`)
    } else io.out(`${r.disabled ? 'The account was disabled and signed out' : 'No such account (nothing to disable)'}; the end of the access is audited; ${String(r.notified)} administrator notice(s).`)
    return 0
  }
  const bad = (code: number, error: string) => {
    if (json) io.out(JSON.stringify({ ok: false, error }))
    else io.err(code === 64 ? error : `${code === 1 ? 'REFUSED' : 'ERROR'}: ${error}`)
    return code
  }
  try {
    if (args[0] === 'open' && args.length === 1) {
      const email = str('email').toLowerCase()
      const until = new Date(str('until'))
      if (!str('grant') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || str('reason').length < 5 || Number.isNaN(until.getTime())) return bad(64, USAGE)
      return done(await operatorAccessOpen(env, { grant: str('grant'), email, name: str('name'), reason: str('reason').slice(0, 500), until, operator: str('operator'), printLink: f['print-link'] === true }))
    }
    if (args[0] === 'close' && args.length === 1) {
      if (!str('user')) return bad(64, USAGE)
      return done(await operatorAccessClose(env, { user: str('user'), grant: str('grant') || undefined, why: str('why') || undefined, operator: str('operator') }))
    }
    return bad(64, USAGE)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return bad(e instanceof Refused ? 1 : (e as { exitCode?: number }).exitCode ?? 1, msg)
  }
}
