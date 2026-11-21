#!/usr/bin/env node
/**
 * abfleet: the operator tool of a hosted Appbuilder fleet (docs/admin/fleet-operations.md; design:
 * docs/plan/hosting-spec.md sections 1 to 11). Run as root on the fleet server by the release's Node.js:
 *
 *   sudo abfleet <command> [options]           (= /opt/appbuilder/node/bin/node /opt/appbuilder/fleet/abfleet.ts)
 *   node scripts/fleet/abfleet.ts --local --root .sandbox/fleet/dev <command>      local test mode (lib/local.ts)
 *
 * Every command: --dry-run (print what would change, change nothing), --json (one JSON document on stdout, progress
 * on stderr), and one line in the operator audit (who, when, what, result). Secrets (passwords, keys, one-time links)
 * are never printed unless a flag asks (--print-link).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { actor, appendAudit, blankRegistry, FleetError, loadRegistry, saveRegistry, type Ctx, type Output } from './lib/core.ts'
import { defaultConfig, findOrg, localPaths, serverPaths, sortedOrgs, type BackupTarget, type FleetConfig, type FleetPaths, type Limits, type MailRelay, type OrgRecord, type Registry } from './lib/model.ts'
import { ServerSystem, withDryRun, type System } from './lib/system.ts'
import { LocalSystem, type LocalPg } from './lib/local.ts'
import { detectPgBin, resolvePgBin } from './lib/pg.ts'
import { parseArgs, redactArgv, scrub, str, table, formatBytes } from './lib/util.ts'

export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))

const BOOL = ['local', 'json', 'dry-run', 'yes', 'print-link', 'stop', 'all', 'scheduled', 'random', 'no-export', 'purge-offsite', 'licence', 'allow-unsigned', 'allow-downgrade', 'force', 'restore-snapshot', 'from-offsite', 'include-key', 'send', 'restart', 'help']

const USAGE = `abfleet: the Appbuilder fleet tool (one install per organisation on one Linux server)

  init [--domain <d>] [--release <zip|folder>] [--tls acme|internal] [--acme-email <a>] [--operator-email <a>]
       [--access-email <a>] [--backup-target <folder | rclone:<remote>:<path>>] [--licence] [--public-ip <a,b>]
       [--mail-host h --mail-port p --mail-security starttls|tls|none --mail-user u --mail-password-file f
        --mail-from a --mail-from-name n] [--alert-host ... (same options with alert-)] [--pg-bin d] [--pg-port n]
  doctor
  org create <name> --name <organisation> --admin-email <a> [--admin-name n] [--plan p] [--seats n] [--print-link]
  org list | org show <org> | org status [<org>]          (status: health, version, read-only, seats, disk, backups)
  org suspend <org> --reason <text> [--stop] | org resume <org>
  org export <org> [--out <file>] [--passphrase-file <f> [--include-key]]
  org delete <org> --confirm <full host name> [--no-export] [--purge-offsite]
  update <release.zip|folder> [--canary <org>] [--batch 5] [--on-failure stop|continue] [--data-rollback auto|always|never]
         [--smoke <script.mjs>] [--health-timeout <s>] [--only <a,b>] [--allow-unsigned] [--allow-downgrade] [--force]
  update status | update rollback <org> [--restore-snapshot --confirm <host>]
  backup run [<org> | --all] | backup status | backup restore-test [<org> | --random] | backup restore <org> [--file f] [--from-offsite]
  limits apply [<org> | --all] [--memory-high 1G] [--memory-max 1536M] [--cpu-quota 200%] [--cpu-weight 100] [--tasks-max 256]
               [--nofile 8192] [--heap-mb 1024] [--db-connections 12] [--statement-timeout 60s] [--idle-timeout 5min]
               [--disk-quota 25G] [--restart]
  limits show [<org>]
  access grant <org> --reason <text> --minutes <1-240> [--print-link] | access list [--all] | access revoke <grant|org> | access sweep
  secrets rotate <org> --what db|secret-key|licence-key
  summary [--send]        note <org> <text>        alert --unit <unit>

Global: --dry-run  --json  --local --root <folder> (test mode)   <org> = id, name or host name`

/* ------------------------------------------------------------------ context */

export interface Env {
  /** an injected system (tests: the fake) */
  system?: System
  paths?: FleetPaths
  env?: NodeJS.ProcessEnv
  stdout?: (s: string) => void
  stderr?: (s: string) => void
}

function localPg(p: FleetPaths): LocalPg | null {
  try { return JSON.parse(fs.readFileSync(path.join(p.secrets, 'local-pg.json'), 'utf8')) as LocalPg } catch { return null }
}

function makeSystem(p: FleetPaths, holder: { reg: Registry | null }, o: Record<string, string | true>): System {
  if (p.mode === 'local') {
    let pg = localPg(p)
    const url = str(o['pg-url'])
    if (url) {
      const u = new URL(url)
      pg = { host: u.hostname, port: Number(u.port) || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
      fs.mkdirSync(p.secrets, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(p.secrets, 'local-pg.json'), JSON.stringify(pg), { mode: 0o600 })
    }
    if (!pg) throw new FleetError('Local test mode needs the throwaway PostgreSQL: abfleet --local --root <folder> init --pg-url postgres://<superuser>:<pw>@127.0.0.1:<port>/postgres', 64)
    return new LocalSystem({ paths: p, pg, pgBin: () => holder.reg?.config.pgBin || str(o['pg-bin']) || '' })
  }
  // one source of truth for the PostgreSQL tools: lib/pg.ts (--pg-bin, then the registry, then detection)
  let detected: string | null = null
  const pgBin = () => resolvePgBin(str(o['pg-bin']), holder.reg?.config.pgBin, () => (detected ??= detectPgBin()))
  return new ServerSystem({ psql: () => path.join(pgBin() || '/usr/bin', 'psql'), pgPort: () => holder.reg?.config.pg.port ?? (Number(o['pg-port']) || 5432) })
}

const READ_ONLY = new Set(['doctor', 'org list', 'org show', 'org status', 'status', 'update status', 'backup status', 'limits show', 'access list', 'summary', 'help'])

function commandKey(args: string[]): string {
  const [a, b] = args
  if (['org', 'backup', 'limits', 'access', 'secrets'].includes(a)) return `${a} ${b ?? ''}`.trim()
  if (a === 'update' && (b === 'status' || b === 'rollback')) return `update ${b}`
  return a ?? 'help'
}

/* ------------------------------------------------------------------ command handlers */

type Handler = (ctx: Ctx, args: string[], o: Record<string, string | true>) => Promise<unknown>

function need(v: string | true | undefined, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new FleetError(`${what} is needed (abfleet help).`, 64)
  return v.trim()
}

function orgArg(ctx: Ctx, key: string | undefined): OrgRecord {
  if (!key) throw new FleetError('Which organisation? (its name, host name or id)', 64)
  const org = findOrg(ctx.reg, key)
  if (!org) throw new FleetError(`There is no organisation ${key} (abfleet org list).`, 2)
  return org
}

function orgsArg(ctx: Ctx, key: string | undefined, all: boolean): OrgRecord[] {
  if (all || !key) return sortedOrgs(ctx.reg)
  return [orgArg(ctx, key)]
}

function relay(o: Record<string, string | true>, pre: string): MailRelay | null {
  const host = str(o[`${pre}-host`])
  if (!host) return null
  return {
    host, port: Number(o[`${pre}-port`]) || 587, security: (str(o[`${pre}-security`]) ?? 'starttls') as MailRelay['security'],
    username: str(o[`${pre}-user`]) ?? '', fromAddress: need(o[`${pre}-from`], `--${pre}-from`), fromName: str(o[`${pre}-from-name`]) ?? 'Appbuilder',
  }
}

function backupTarget(v: string | undefined): BackupTarget | undefined {
  if (!v) return undefined
  if (v.startsWith('rclone:')) return { kind: 'rclone', remote: v.slice('rclone:'.length) }
  return { kind: 'path', path: path.resolve(v) }
}

const LIMIT_FLAGS: Record<string, keyof Limits> = {
  'memory-high': 'memoryHigh', 'memory-max': 'memoryMax', 'cpu-quota': 'cpuQuota', 'cpu-weight': 'cpuWeight', 'tasks-max': 'tasksMax', nofile: 'nofile',
  'heap-mb': 'heapMb', 'db-connections': 'dbConnections', 'statement-timeout': 'statementTimeout', 'idle-timeout': 'idleInTransactionTimeout', 'disk-quota': 'diskQuota',
}
const NUMERIC: (keyof Limits)[] = ['cpuWeight', 'tasksMax', 'nofile', 'heapMb', 'dbConnections']

const handlers: Record<string, Handler> = {
  async init(ctx, _a, o) {
    const { fleetInit } = await import('./lib/init.ts')
    const config: Partial<FleetConfig> = {}
    if (str(o.domain)) config.domain = str(o.domain)!.toLowerCase()
    if (str(o.tls)) config.tls = str(o.tls) === 'internal' ? 'internal' : 'acme'
    if (str(o['acme-email'])) config.acmeEmail = str(o['acme-email'])!
    if (str(o['operator-email'])) config.operatorEmail = str(o['operator-email'])!
    if (str(o['access-email'])) config.accessEmail = str(o['access-email'])!
    if (str(o['pg-bin'])) config.pgBin = path.resolve(str(o['pg-bin'])!)
    if (str(o['pg-port'])) config.pg = { ...ctx.reg.config.pg, port: Number(o['pg-port']) }
    if (ctx.paths.mode === 'local') { const pg = localPg(ctx.paths); if (pg) config.pg = { host: pg.host, port: pg.port } }
    if (str(o['public-ip'])) config.outboundDenyExtra = str(o['public-ip'])!.split(',').map((x) => x.trim()).filter(Boolean)
    const bt = backupTarget(str(o['backup-target']))
    if (bt) config.backup = { ...ctx.reg.config.backup, target: bt }
    const m = relay(o, 'mail')
    if (m) config.mail = m
    const a = relay(o, 'alert')
    if (a) config.alertRelay = a
    if (str(o['licence-port'])) config.licence = { ...ctx.reg.config.licence, port: Number(o['licence-port']) }
    if (str(o['port-range'])) { const [x, y] = str(o['port-range'])!.split('-').map(Number); config.portRange = [x, y] }
    return fleetInit(ctx, { release: str(o.release), config, licence: o.licence === true, allowUnsigned: o['allow-unsigned'] === true, mailPasswordFile: str(o['mail-password-file']), alertPasswordFile: str(o['alert-password-file']) })
  },
  async doctor(ctx) {
    const { fleetDoctor } = await import('./lib/init.ts')
    const r = await fleetDoctor(ctx)
    if (r.problems.length) process.exitCode = 1
    return r
  },
  async 'org create'(ctx, a, o) {
    const { orgCreate } = await import('./lib/org.ts')
    return orgCreate(ctx, { slug: need(a[2], 'The organisation\'s short name (it becomes <name>.<domain>)'), name: need(o.name, '--name'), adminEmail: need(o['admin-email'], '--admin-email'), adminName: str(o['admin-name']), plan: str(o.plan), seats: o.seats ? Number(o.seats) : undefined, printLink: o['print-link'] === true })
  },
  async 'org list'(ctx) { return (await import('./lib/org.ts')).orgList(ctx) },
  async 'org show'(ctx, a) { return (await import('./lib/org.ts')).orgShow(ctx, orgArg(ctx, a[2])) },
  async 'org status'(ctx, a) {
    const { orgStatus } = await import('./lib/org.ts')
    const list = orgsArg(ctx, a[2], false)
    const out = []
    for (let i = 0; i < list.length; i += 5) out.push(...(await Promise.all(list.slice(i, i + 5).map((x) => orgStatus(ctx, x)))))
    return out
  },
  async status(ctx, a) { return handlers['org status'](ctx, ['org', 'status', ...a.slice(1)], {}) },
  async 'org suspend'(ctx, a, o) { return (await import('./lib/org.ts')).orgSuspend(ctx, orgArg(ctx, a[2]), { reason: need(o.reason, '--reason'), stop: o.stop === true }) },
  async 'org resume'(ctx, a) { return (await import('./lib/org.ts')).orgResume(ctx, orgArg(ctx, a[2])) },
  async 'org export'(ctx, a, o) {
    const { exportOrg } = await import('./lib/backup.ts')
    const pf = str(o['passphrase-file'])
    const pass = pf ? ctx.sys.readText(pf)?.split(/\r?\n/)[0] ?? null : null
    if (pf && (!pass || pass.length < 10)) throw new FleetError('The passphrase file must hold a passphrase of at least 10 characters.', 64)
    return exportOrg(ctx, orgArg(ctx, a[2]), { passphrase: pass, includeKey: o['include-key'] === true, out: str(o.out) ? path.resolve(str(o.out)!) : undefined })
  },
  async 'org delete'(ctx, a, o) {
    const { orgDelete } = await import('./lib/org.ts')
    const org = orgArg(ctx, a[2])
    const r = await orgDelete(ctx, org, { confirm: str(o.confirm) ?? '', noExport: o['no-export'] === true, purgeOffsite: o['purge-offsite'] === true })
    if (r.remaining.length) process.exitCode = 1
    return r
  },
  async update(ctx, a, o) {
    const { fleetUpdate } = await import('./lib/update.ts')
    const run = await fleetUpdate(ctx, path.resolve(need(a[1], 'The release package (zip or folder)')), {
      canary: str(o.canary), batch: o.batch ? Number(o.batch) : undefined, onFailure: str(o['on-failure']) === 'continue' ? 'continue' : 'stop',
      dataRollback: (['auto', 'always', 'never'].includes(str(o['data-rollback']) ?? '') ? str(o['data-rollback']) : 'auto') as 'auto' | 'always' | 'never',
      smoke: str(o.smoke) ? path.resolve(str(o.smoke)!) : undefined, allowUnsigned: o['allow-unsigned'] === true, allowDowngrade: o['allow-downgrade'] === true,
      force: o.force === true, healthTimeoutS: o['health-timeout'] ? Number(o['health-timeout']) : undefined, only: str(o.only)?.split(',').map((x) => x.trim()),
    })
    if (run.result !== 'completed' || run.steps.some((s) => s.result === 'rolled-back' || s.result === 'failed')) process.exitCode = 1
    return run
  },
  async 'update status'(ctx) { return (await import('./lib/update.ts')).updateStatus(ctx) },
  async 'update rollback'(ctx, a, o) { return (await import('./lib/update.ts')).updateRollback(ctx, orgArg(ctx, a[2]), { restoreSnapshot: o['restore-snapshot'] === true, confirm: str(o.confirm) }) },
  async 'backup run'(ctx, a, o) {
    const { backupRun } = await import('./lib/backup.ts')
    if (!a[2] && o.all !== true) throw new FleetError('backup run <org> or backup run --all', 64)
    const r = await backupRun(ctx, orgsArg(ctx, a[2], o.all === true), { globals: o.all === true })
    if (r.failed.length) {
      process.exitCode = 1
      const { mailOperator } = await import('./lib/summary.ts')
      if (o.scheduled === true) await mailOperator(ctx, `Appbuilder fleet: ${r.failed.length} backup(s) failed`, r.failed.map((f) => `- ${f.org}: ${f.error}`).join('\n'))
    }
    return r
  },
  async 'backup status'(ctx) { return (await import('./lib/backup.ts')).backupStatus(ctx) },
  async 'backup restore-test'(ctx, a, o) {
    const { restoreTest } = await import('./lib/backup.ts')
    const pool = sortedOrgs(ctx.reg).filter((x) => x.state !== 'creating' && ctx.reg.backups.some((b) => b.org === x.id && b.kind === 'nightly'))
    const org = a[2] ? orgArg(ctx, a[2]) : pool[Math.floor(Math.random() * pool.length)]
    if (!org) throw new FleetError('No install has a nightly backup to test yet.', 2)
    void o
    const r = await restoreTest(ctx, org)
    if (!r.ok) {
      process.exitCode = 1
      const { mailOperator } = await import('./lib/summary.ts')
      await mailOperator(ctx, `Appbuilder fleet: the restore test of ${org.host} failed`, r.error ?? '')
    }
    return r
  },
  async 'backup restore'(ctx, a, o) {
    const { restoreOrg } = await import('./lib/backup.ts')
    const r = await restoreOrg(ctx, orgArg(ctx, a[2]), { file: str(o.file) ? path.resolve(str(o.file)!) : undefined, fromOffsite: o['from-offsite'] === true })
    if (!r.healthy) process.exitCode = 1
    return r
  },
  async 'limits apply'(ctx, a, o) {
    const { limitsApply } = await import('./lib/limits.ts')
    const change: Partial<Limits> = {}
    for (const [flag, key] of Object.entries(LIMIT_FLAGS)) {
      const v = str(o[flag])
      if (v !== undefined) (change as Record<string, unknown>)[key] = NUMERIC.includes(key) ? Number(v) : v
    }
    if (!a[2] && o.all !== true) throw new FleetError('limits apply <org> or limits apply --all', 64)
    return limitsApply(ctx, orgsArg(ctx, a[2], o.all === true), change, { restart: o.restart === true })
  },
  async 'limits show'(ctx, a) { return (await import('./lib/limits.ts')).limitsShow(ctx, orgsArg(ctx, a[2], !a[2])) },
  async 'access grant'(ctx, a, o) { return (await import('./lib/access.ts')).accessGrant(ctx, orgArg(ctx, a[2]), { reason: need(o.reason, '--reason'), minutes: Number(need(o.minutes, '--minutes')), printLink: o['print-link'] === true }) },
  async 'access list'(ctx, _a, o) { return (await import('./lib/access.ts')).accessList(ctx, o.all === true) },
  async 'access revoke'(ctx, a) { return (await import('./lib/access.ts')).accessRevoke(ctx, need(a[2], 'The grant id or organisation')) },
  async 'access sweep'(ctx, _a, o) {
    const at = str(o.at)
    if (at && ctx.paths.mode !== 'local') throw new FleetError('--at is for local test mode only.', 64)
    return (await import('./lib/access.ts')).accessSweep(ctx, at ? Date.parse(at) : undefined)
  },
  async 'secrets rotate'(ctx, a, o) {
    const what = need(o.what, '--what db|secret-key|licence-key')
    if (!['db', 'secret-key', 'licence-key'].includes(what)) throw new FleetError('--what must be db, secret-key or licence-key.', 64)
    return (await import('./lib/access.ts')).secretsRotate(ctx, orgArg(ctx, a[2]), what as 'db' | 'secret-key' | 'licence-key')
  },
  async summary(ctx, _a, o) {
    const { buildSummary, mailOperator, summaryText } = await import('./lib/summary.ts')
    const s = await buildSummary(ctx)
    const t = summaryText(s, ctx.reg.config.domain)
    return { ...s, text: t.text, mail: o.send === true ? await mailOperator(ctx, t.subject, t.text) : 'not sent (--send)' }
  },
  async alert(ctx, _a, o) {
    const { alert } = await import('./lib/backup.ts')
    const { mailOperator } = await import('./lib/summary.ts')
    const unit = need(o.unit, '--unit')
    const id = /appbuilder@(o[a-z2-7]{8})/.exec(unit)?.[1]
    const org = id ? ctx.reg.orgs[id] : undefined
    const msg = `${unit} failed and systemd gave up restarting it (5 starts in 10 minutes), or it failed to start.`
    alert(ctx, 'service', msg, org)
    ctx.save()
    return { mail: await mailOperator(ctx, `Appbuilder fleet: ${org?.host ?? unit} is down`, `${msg}\nSee: journalctl -u ${unit} -n 100; sudo abfleet doctor`) }
  },
  async note(ctx, a) {
    const org = orgArg(ctx, a[1])
    const text = a.slice(2).join(' ').trim()
    if (!text) throw new FleetError('note <org> <text>', 64)
    return { org: org.host, note: text }
  },
}

/* ------------------------------------------------------------------ human output */

function human(key: string, r: unknown): string {
  const x = r as Record<string, unknown> & unknown[]
  switch (key) {
    case 'org list': return table(['id', 'host', 'state', 'release', 'plan', 'seats', 'created'], (x as unknown as Record<string, unknown>[]).map((o) => [String(o.id), String(o.host), String(o.state), String(o.release), String(o.plan), String(o.seats), String(o.createdOn).slice(0, 10)]))
    case 'org status': case 'status': return table(['host', 'state', 'health', 'release', 'read-only', 'users', 'seats f/o/e', 'disk', 'database', 'last backup', 'licence check', 'problems'], (x as unknown as Record<string, unknown>[]).map((s) => [String(s.host), String(s.state), String(s.health), String(s.release), String(s.readOnly ?? '-'), String(s.users ?? '-'), `${s.seats ?? '-'} of ${s.seatsLicensed}`, formatBytes(s.disk as number), formatBytes(s.dbBytes as number), s.lastBackup ? `${String(s.lastBackup).slice(0, 16)}${s.lastBackupOk ? '' : ' FAILED'}` : 'never', String(s.lastLicenceCheck ?? '-').slice(0, 25), (s.problems as string[]).join('; ') || '-']))
    case 'backup status': return table(['host', 'state', 'last backup', 'ok', 'age h', 'off-site', 'copies', 'problem'], (x as unknown as Record<string, unknown>[]).map((b) => [String(b.host), String(b.state), String(b.last ?? 'never').slice(0, 16), String(b.ok ?? '-'), String(b.ageHours ?? '-'), b.offsite ? 'yes' : 'no', String(b.copies), String(b.problem ?? '-')]))
    case 'doctor': return table(['check', 'ok', 'detail'], ((x as unknown as { checks: { what: string; ok: boolean; detail: string }[] }).checks).map((c) => [c.what, c.ok ? 'ok' : 'PROBLEM', c.detail]))
    case 'access list': return table(['grant', 'host', 'by', 'until', 'left min', 'state', 'reason'], (x as unknown as Record<string, unknown>[]).map((g) => [String(g.id), String(g.host), String(g.by), String(g.until).slice(0, 16), String(g.minutesLeft ?? '-'), String(g.state), String(g.reason)]))
    case 'summary': return String((r as { text: string }).text) + `\n\nmail: ${String((r as { mail: string }).mail)}`
    default: return JSON.stringify(r, null, 2)
  }
}

/* ------------------------------------------------------------------ the run */

/**
 * One changing abfleet command at a time. A held lock is waited for (default 120 s, ABFLEET_LOCK_WAIT_S): the timers
 * (the access sweep every 5 minutes, the nightly backup) take it too, and an operator's command must not fail because
 * a sweep happened to run at that second. A lock whose process is gone is taken over.
 */
function lock(p: FleetPaths, env: NodeJS.ProcessEnv, say: (l: string) => void): () => void {
  fs.mkdirSync(path.dirname(p.lock), { recursive: true })
  const waitMs = Math.max(0, Number(env.ABFLEET_LOCK_WAIT_S ?? 120) || 0) * 1000
  const until = Date.now() + waitMs
  let told = false
  for (;;) {
    try {
      fs.writeFileSync(p.lock, String(process.pid), { flag: 'wx', mode: 0o600 })
      return () => fs.rmSync(p.lock, { force: true })
    } catch {
      let pid = 0
      try { pid = Number(fs.readFileSync(p.lock, 'utf8')) } catch (e) {
        // removed in between: try again (an unreadable lock folder is an error, not a wait)
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' && Date.now() < until) continue
        throw new FleetError(`Could not take the fleet lock ${p.lock}: ${(e as Error).message}`, 75)
      }
      let alive = false
      try { process.kill(pid, 0); alive = true } catch { /* stale */ }
      // an empty file: another command is writing its pid right now (wait); a dead process's lock: take it over
      if (pid && (!alive || pid === process.pid)) { fs.rmSync(p.lock, { force: true }); continue }
      if (Date.now() >= until) throw new FleetError(`Another abfleet command is running (process ${pid}); try again when it is done.`, 75)
      if (!told) { say(`waiting for another abfleet command (process ${pid}) to finish ...`); told = true }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
  }
}

export async function runAbfleet(argv: string[], e: Env = {}): Promise<{ code: number; result: unknown; error?: string }> {
  const t0 = Date.now()
  const env = e.env ?? process.env
  const outW = e.stdout ?? ((s: string) => { process.stdout.write(s + '\n') })
  const errW = e.stderr ?? ((s: string) => { process.stderr.write(s + '\n') })
  const { args, o } = parseArgs(argv, BOOL)
  const json = o.json === true
  const dry = o['dry-run'] === true
  const key = commandKey(args)
  if (o.help || key === 'help' || !handlers[key]) {
    outW(USAGE)
    return { code: o.help || key === 'help' ? 0 : 64, result: null }
  }
  const secrets: string[] = []
  const out: Output = {
    say: (l) => (json ? errW : outW)(scrub(l, secrets)),
    warn: (l) => errW(scrub(l, secrets)),
  }
  const paths = e.paths ?? (o.local === true ? localPaths(path.resolve(str(o.root) ?? path.join(TOOL_DIR, '..', '..', '.sandbox', 'fleet', 'dev')), TOOL_DIR) : serverPaths(TOOL_DIR))
  const holder: { reg: Registry | null } = { reg: null }
  let base: System
  let code = 0
  let result: unknown = null
  let error: string | undefined
  let release = () => {}
  const who = actor(env)
  let orgKey: string | undefined
  try {
    base = e.system ?? makeSystem(paths, holder, o)
    holder.reg = loadRegistry(base, paths)
    if (!holder.reg) {
      if (key !== 'init') throw new FleetError(`No fleet here (${paths.registry} is missing): run abfleet init first.`, 2)
      if (!str(o.domain)) throw new FleetError('init needs --domain <the domain whose sub-domains the organisations get>.', 64)
      holder.reg = blankRegistry(base, defaultConfig(paths.mode, str(o.domain)!.toLowerCase()))
    }
    const sys = dry ? withDryRun(base, out.say) : base
    const ctx: Ctx = {
      sys, paths, reg: holder.reg, out, json, dry, who, secrets,
      save: () => { if (!dry) saveRegistry(base, paths, holder.reg!) },
      clock: () => sys.now(),
    }
    if (key === 'init' && !dry && !base.exists(paths.registry)) { base.mkdir(paths.etc, { mode: 0o755, owner: 'root' }); ctx.save() }
    if (!READ_ONLY.has(key) && !dry && base.kind !== 'fake') release = lock(paths, env, out.warn)
    // expired operator access ends before anything else (the timer does it every 5 minutes too)
    if (key !== 'init' && key !== 'access sweep' && !dry && ctx.reg.grants.some((g) => g.state === 'active' && Date.parse(g.until) <= ctx.clock())) {
      const { accessSweep } = await import('./lib/access.ts')
      const s = await accessSweep(ctx)
      for (const g of s.ended) out.warn(`operator access ${g.id} to ${ctx.reg.orgs[g.org]?.host ?? g.org} ended (expired)`)
      for (const f of s.failed) out.warn(`could not end expired operator access ${f}`)
    }
    orgKey = ['org', 'backup', 'limits', 'access', 'secrets'].includes(args[0]) ? args[2] : args[0] === 'update' && args[1] === 'rollback' ? args[2] : args[0] === 'note' ? args[1] : undefined
    result = await handlers[key](ctx, args, o)
    code = typeof process.exitCode === 'number' ? process.exitCode : 0
    process.exitCode = 0
    if (json) outW(JSON.stringify({ ok: code === 0, command: key, dryRun: dry, result }, null, 2))
    else if (result !== null && result !== undefined) outW(o['print-link'] === true ? human(key, result) : scrub(human(key, result), secrets))
  } catch (err) {
    process.exitCode = 0
    code = err instanceof FleetError ? err.code : 1
    error = scrub(err instanceof Error ? err.message : String(err), secrets)
    if (json) outW(JSON.stringify({ ok: false, command: key, dryRun: dry, error }, null, 2))
    else errW(`${code === 2 || code === 64 ? 'REFUSED' : code === 69 ? 'NOT SUPPORTED' : 'FAILED'}: ${error}`)
    if (!(err instanceof FleetError) && err instanceof Error && env.ABFLEET_DEBUG) errW(err.stack ?? '')
  } finally {
    release()
  }
  try {
    const org = orgKey && holder.reg ? findOrg(holder.reg, orgKey) : null
    appendAudit(e.system ?? (base! as System), paths, {
      at: new Date(t0).toISOString(), who, host: (await import('node:os')).hostname(), mode: paths.mode, command: redactArgv(argv),
      ...(org ? { org: org.id } : orgKey ? { org: orgKey } : {}), dryRun: dry, result: code === 0 ? 'ok' : code === 2 || code === 64 || code === 69 ? 'refused' : 'failed',
      message: (error ?? (key === 'note' ? args.slice(2).join(' ') : 'done')).slice(0, 500), ms: Date.now() - t0,
    })
  } catch (err) {
    errW(`WARNING: the operator audit could not be written: ${err instanceof Error ? err.message : String(err)}`)
    if (code === 0) code = 1
  }
  return { code, result, ...(error ? { error } : {}) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runAbfleet(process.argv.slice(2))
  process.exit(r.code)
}
