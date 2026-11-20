/**
 * Server commands for hosted installs (H-A, H-C; docs/admin/hosting.md). Run as the install's user, with its
 * environment (APPBUILDER_ENV_FILE, or the installers' service environment file), with the server stopped or running:
 * they talk to the database directly, every change goes to the install audit with source "cli".
 *
 *   appbuilder migrate                                   creates or upgrades the schema, then exits
 *   appbuilder admin invite --email <e> --name <n>       the first (or another) install administrator, without a
 *                         [--print-link]                 password: a one-time invitation (7 days) is emailed with the
 *                                                        locked public URL; --print-link prints the link instead
 *                                                        (a secret: for an operator without a mail relay)
 *   appbuilder read-only on --reason <r> [--message <t>] read-only (suspended | payment | maintenance | licence)
 *   appbuilder read-only off | status
 *   appbuilder hosting-check                             checks the hosting settings; exit 1 with the problems
 *   appbuilder health                                    (with APPBUILDER_SOCKET) asks the server over its socket
 */
import http from 'node:http'
import os from 'node:os'
import { loadConfig } from '../config.ts'
import { createPgDb } from '../../connectors/postgres/db.ts'
import { databaseLogin } from '../update/cli.ts'
import type { CoreServices } from '../services.ts'
import { READ_ONLY_REASONS, configureHosting, hostingSettings, writePathProblems, type ReadOnlyReason } from './settings.ts'
import { readOnlyMessage, setStoredReadOnly, storedReadOnly } from './read-only.ts'

export interface CliIo { out(line: string): void; err(line: string): void }
const stdio: CliIo = { out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(l + '\n') }

export const HOSTING_COMMANDS = new Set(['migrate', 'read-only', 'hosting-check'])

function flags(argv: string[], bool: string[] = []): { args: string[]; o: Record<string, string | true> } {
  const o: Record<string, string | true> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (bool.includes(k)) o[k] = true
      else o[k] = argv[++i] ?? ''
    } else args.push(a)
  }
  return { args, o }
}

const osUser = (): string => {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USER || process.env.USERNAME || 'unknown'
  }
}

/** the server's services without HTTP and without the job worker; connects once (no background retry) */
async function openServices(env: NodeJS.ProcessEnv, io: CliIo): Promise<CoreServices | null> {
  const { createServices } = await import('../services.ts')
  const { createPgDb: pg } = await import('../../connectors/postgres/db.ts')
  const config = loadConfig(env)
  const services = createServices(config, { env, sqlDbFactory: (s, p) => pg(s, p, { max: 2, onError: () => {} }) })
  // the locked public URL and the other settings of THIS environment (links in the invitation)
  configureHosting(services, hostingSettings(env))
  await services.boot()
  if (!services.ready()) {
    io.err(`ERROR: ${services.state.databaseError ?? (services.databaseConfigured() ? 'the database could not be opened.' : 'no database is configured (APPBUILDER_DB_* or seed-config first).')}`)
    await services.close().catch(() => {})
    return null
  }
  return services
}

async function cmdMigrate(env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const services = await openServices(env, io)
  if (!services) return 2
  try {
    const m = services.state.migration
    const failed = (m?.environments ?? []).filter((f) => !f.ok)
    await services.install!.audit({ userId: null, action: 'install.cli_migrate', environmentId: null, details: { from: m?.from ?? null, to: m?.to ?? null, source: 'cli', osUser: osUser(), host: os.hostname() } })
    io.out(m ? (m.from === m.to ? `Schema version ${m.to}: up to date.` : `Schema migrated from version ${m.from} to ${m.to}.`) : 'Schema ready.')
    for (const f of failed) io.err(`ENVIRONMENT ${f.id} NOT AVAILABLE: ${f.error}`)
    return failed.length ? 1 : 0
  } finally {
    await services.close().catch(() => {})
  }
}

async function cmdInvite(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const { o } = flags(argv, ['print-link'])
  const email = typeof o.email === 'string' ? o.email.trim().toLowerCase() : ''
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 255) : ''
  if (!email || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    io.err('Usage: appbuilder admin invite --email <address> --name <full name> [--print-link]')
    return 64
  }
  const services = await openServices(env, io)
  if (!services) return 2
  try {
    const { identity, INVITE_TTL_MS } = await import('../identity/index.ts')
    const { ensureBuiltinRoles, ROLE_ADMIN } = await import('../auth.ts')
    const { DEFAULT_ENVIRONMENT_ID } = await import('../env-context.ts')
    const idn = identity(services)
    const brand = await idn.mail.brand()
    const mailReady = await idn.mail.configured()
    if (!o['print-link'] && !mailReady) {
      io.err('REFUSED: email is not set up in this install, so the invitation cannot be sent. Set up the relay first, or use --print-link (prints the one-time link: treat it as a password).')
      return 2
    }
    if (!brand.publicUrl) {
      io.err('REFUSED: the install has no public address (APPBUILDER_PUBLIC_URL), so the invitation link would have none.')
      return 2
    }
    if (await services.meta.users.byEmail(email)) {
      io.err(`REFUSED: there is already an account with the email ${email} (use "admin make-install-admin" or "admin reset-password").`)
      return 1
    }
    const first = (await services.meta.users.count()) === 0
    await ensureBuiltinRoles(services)
    const id = services.uid('user')
    // like /setup/admin, without a password: the person chooses it when accepting the invitation
    await services.meta.users.insert({ id, name, email, roleIds: [ROLE_ADMIN], status: 'active', passwordHash: null, isInstallAdmin: true, lastEnvironmentId: DEFAULT_ENVIRONMENT_ID })
    services.security.invalidate()
    const t = await idn.createToken('invite', id, { ttlMs: INVITE_TTL_MS, createdBy: null, data: { via: 'cli' } })
    const link = `${brand.publicUrl}/#invite=${t.raw}`
    if (mailReady) await idn.mail.sendTemplate('invitation', email, { name, email, link, days: INVITE_TTL_MS / 86_400_000, invitedBy: brand.installName }, id)
    if (first) services.markSetupComplete()
    const details = { id, email, first, expiresOn: t.expiresOn.toISOString(), emailed: mailReady, source: 'cli', osUser: osUser(), host: os.hostname() }
    await services.install!.audit({ userId: null, action: 'install.cli_admin_invite', environmentId: null, details })
    await services.meta.audit({ userId: null, action: 'user.create', details: { id, email, roleIds: [ROLE_ADMIN], status: 'active', via: 'cli' } }).catch(() => {})
    io.out(`${first ? 'First install administrator' : 'Install administrator'} ${email} created without a password; invitation valid until ${t.expiresOn.toISOString().slice(0, 16).replace('T', ' ')} UTC.`)
    if (mailReady) io.out(`The invitation email is queued (it is sent by the server's job worker${first ? '' : ', within seconds while the server runs'}).`)
    if (o['print-link']) io.out(`Invitation link (one-time, a secret): ${link}`)
    return 0
  } finally {
    await services.close().catch(() => {})
  }
}

async function withDb<T>(env: NodeJS.ProcessEnv, io: CliIo, fn: (db: ReturnType<typeof createPgDb>) => Promise<T>): Promise<T | null> {
  const login = databaseLogin(env)
  if (!login) {
    io.err('ERROR: no database login is saved (APPBUILDER_DB_* or server.json).')
    return null
  }
  const db = createPgDb(login.settings, login.password, { max: 1, onError: () => {} })
  try {
    return await fn(db)
  } finally {
    await db.close().catch(() => {})
  }
}

async function cmdReadOnly(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const { args, o } = flags(argv)
  const sub = args[0]
  if (sub === 'on') {
    const reason = String(o.reason ?? '') as ReadOnlyReason
    if (!(READ_ONLY_REASONS as readonly string[]).includes(reason)) {
      io.err(`Usage: appbuilder read-only on --reason ${READ_ONLY_REASONS.join('|')} [--message <one line for the people using it>]`)
      return 64
    }
    const r = await withDb(env, io, (db) => setStoredReadOnly(db, { reason, message: typeof o.message === 'string' ? o.message : '' }))
    if (!r) return 2
    io.out(`Read-only (${r.reason}) since ${r.since}. A running server applies it within 5 seconds.`)
    io.out(`People see: ${readOnlyMessage(r)}`)
    return 0
  }
  if (sub === 'off') {
    const r = await withDb(env, io, async (db) => { await setStoredReadOnly(db, null); return true })
    if (!r) return 2
    io.out('Writable again (a running server applies it within 5 seconds).')
    if (hostingSettings(env).readOnly) io.out('NOTE: APPBUILDER_READ_ONLY is still set in this install\'s environment: remove it and restart for the install to be writable.')
    return 0
  }
  if (sub === 'status') {
    const fromEnv = hostingSettings(env).readOnly
    const r = await withDb(env, io, async (db) => ({ s: await storedReadOnly(db) }))
    if (!r) return 2
    if (fromEnv) io.out(`read-only (${fromEnv.reason}) by APPBUILDER_READ_ONLY in the environment`)
    if (r.s) io.out(`read-only (${r.s.reason}) since ${r.s.since} by the server command${r.s.message ? `: ${r.s.message}` : ''}`)
    if (!fromEnv && !r.s) io.out('writable')
    return fromEnv || r.s ? 3 : 0
  }
  io.err(`Usage: appbuilder read-only on --reason ${READ_ONLY_REASONS.join('|')} [--message <text>] | off | status`)
  return 64
}

function cmdCheck(env: NodeJS.ProcessEnv, io: CliIo): number {
  const s = hostingSettings(env)
  const config = loadConfig(env)
  const problems = [...s.problems, ...writePathProblems(s, { workspaceDir: config.workspaceDir, env })]
  io.out(`hosted profile   ${s.hosted ? 'on' : 'off'}`)
  io.out(`listens on       ${s.socket ? `socket ${s.socket} (mode ${s.socketMode.toString(8)})` : `${config.host}:${config.port}`}`)
  io.out(`public URL       ${s.publicUrl ?? '(not locked)'}${s.hostCookies ? ' (cookies with the __Host- prefix)' : ''}`)
  io.out(`setup over HTTP  ${s.setupClosed ? 'closed' : 'open'}`)
  io.out(`database pool    ${s.dbPool}`)
  io.out(`job polling      ${s.jobsPollMs} ms`)
  io.out(`outbound private ${env.APPBUILDER_OUTBOUND_PRIVATE === 'deny' || s.hosted ? 'deny' : 'allow'}${env.APPBUILDER_OUTBOUND_DENY ? `; refused: ${env.APPBUILDER_OUTBOUND_DENY}` : ''}`)
  io.out(`instance folder  ${s.instanceDir ?? '(not set)'}`)
  io.out(`workspace        ${config.workspaceDir}`)
  io.out(`read-only (env)  ${s.readOnly ? s.readOnly.reason : 'no'}`)
  for (const p of problems) io.err(`PROBLEM: ${p}`)
  return problems.length ? 1 : 0
}

/** GET /api/v1/health over the install's socket (or its port): ok / starting / degraded / down */
export function probeSocketHealth(socketPath: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path: '/api/v1/health', method: 'GET', headers: { host: 'localhost' }, timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c.slice(0, 1000) })
      res.on('end', () => {
        try {
          const s = (JSON.parse(body) as { status?: string }).status
          resolve(s === 'ok' || s === 'starting' || s === 'degraded' ? s : 'down')
        } catch {
          resolve('down')
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve('down'))
    req.end()
  })
}

export async function runHostingCli(argv: string[], o: { env?: NodeJS.ProcessEnv; io?: CliIo } = {}): Promise<number> {
  const env = o.env ?? process.env
  const io = o.io ?? stdio
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case 'migrate': return await cmdMigrate(env, io)
      case 'invite': return await cmdInvite(rest, env, io)
      case 'read-only': return await cmdReadOnly(rest, env, io)
      case 'hosting-check': return cmdCheck(env, io)
      case 'health': {
        const s = hostingSettings(env)
        if (!s.socket) { io.err('APPBUILDER_SOCKET is not set.'); return 64 }
        const h = await probeSocketHealth(s.socket)
        io.out(h)
        return h === 'ok' ? 0 : 1
      }
      default: io.err(`Unknown command ${cmd}`); return 64
    }
  } catch (e) {
    io.err(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
