/**
 * Package H-D: one organisation = one install (spec sections 1 to 6). create (fully rolled back on any failure),
 * list / show / status, suspend / resume (the read-only gate with a reason, or stopped with a notice page), export,
 * delete (typed confirmation, export first, verified removal and a report of what was removed).
 */
import path from 'node:path'
import { agent, appCli, FleetError, installCommand, target, Undo, unitOf, waitHealth, type Ctx } from './core.ts'
import { createInstallDatabase, databaseExists, dropInstallDatabase, roleExists } from './db.ts'
import { licenceKey, licenceOrgCreate, licenceRetire } from './licence.ts'
import { applyQuota, applyUnitLimits, removeQuota } from './limits.ts'
import { limitsOf, orgPaths, sortedOrgs, type OrgRecord } from './model.ts'
import { caddyNotice, caddySite, tmpfilesLine } from './templates.ts'
import { reloadProxy, writeInstanceEnv } from './instance.ts'
import { exportOrg } from './backup.ts'
import { formatBytes, newOrgId, newPassword, newSecretKey, scrub, slugProblem } from './util.ts'

export const MAX_ORGS = 20

function freePort(ctx: Ctx): number {
  const used = new Set(Object.values(ctx.reg.orgs).map((o) => o.port))
  const [a, b] = ctx.reg.config.portRange
  for (let p = a; p <= b; p++) if (!used.has(p) && p !== 5174 && p !== 5433) return p
  throw new FleetError(`No free port in ${a}-${b}.`)
}

export interface CreateInput { slug: string; name: string; adminEmail: string; adminName?: string; plan?: string; seats?: number; printLink?: boolean; healthTimeoutS?: number }
export interface CreateResult { id: string; host: string; url: string; release: string; licenceId: string | null; invitation: 'emailed' | 'printed'; link?: string; ms: number }

export async function orgCreate(ctx: Ctx, i: CreateInput): Promise<CreateResult> {
  const t0 = ctx.sys.now()
  const c = ctx.reg.config
  const slug = i.slug.trim().toLowerCase()
  const bad = slugProblem(slug)
  if (bad) throw new FleetError(bad, 64)
  const email = i.adminEmail.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FleetError('--admin-email must be an email address.', 64)
  const name = i.name.trim()
  if (!name || name.length > 200 || /[\r\n]/.test(name)) throw new FleetError('--name must be the organisation\'s name (one line).', 64)
  const host = `${slug}.${c.domain}`
  if (sortedOrgs(ctx.reg).some((o) => o.slug === slug)) throw new FleetError(`${host} exists already.`, 2)
  if (Object.keys(ctx.reg.orgs).length >= MAX_ORGS) throw new FleetError(`The fleet already holds ${MAX_ORGS} organisations, the size this server was planned for (hosting spec DC-11/DC-12).`, 2)
  if (!c.mail && !i.printLink) throw new FleetError('No mail relay is configured for the fleet (abfleet init --mail-host ...), so the invitation cannot be emailed: configure it, or add --print-link (prints the one-time link: treat it as a password).', 2)
  const current = ctx.sys.readLink(ctx.paths.current)
  if (!current) throw new FleetError(`There is no current release (${ctx.paths.current}): abfleet init --release <zip|folder>.`, 2)
  const release = path.basename(current)
  let id = newOrgId()
  while (ctx.reg.orgs[id] || ctx.sys.exists(orgPaths(ctx.paths, id).dir)) id = newOrgId()
  const org: OrgRecord = {
    id, slug, host, name, adminEmail: email, plan: i.plan ?? 'pilot', seats: i.seats ?? 50, state: 'creating', release,
    osUser: `ab-${id}`, db: `${c.prefix}${id}`, createdOn: new Date(ctx.clock()).toISOString(),
    ...(c.listen === 'tcp' ? { port: freePort(ctx) } : {}),
  }
  const op = orgPaths(ctx.paths, id)
  const limits = limitsOf(ctx.reg, org)
  const undo = new Undo()
  const say = ctx.out.say
  let link: string | undefined
  try {
    if ((await ctx.sys.userExists(org.osUser)) || (await roleExists(ctx, org.db)) || (await databaseExists(ctx, org.db))) throw new FleetError(`${org.osUser} or ${org.db} exists already (left from an earlier attempt?): run abfleet doctor.`)
    ctx.reg.orgs[id] = org
    ctx.save()
    undo.push('registry entry', () => { delete ctx.reg.orgs[id]; ctx.save() })
    say(`[1/12] OS user ${org.osUser} (no login shell)`)
    undo.push(`OS user ${org.osUser}`, async () => { if (await ctx.sys.userExists(org.osUser)) await ctx.sys.deleteUser(org.osUser) })
    await ctx.sys.createUser(org.osUser, op.dir)
    say(`[2/12] folder ${op.dir} (root:${org.osUser} 0750; workspace, backups 0700 ${org.osUser})`)
    undo.push(`folder ${op.dir}`, () => ctx.sys.remove(op.dir))
    ctx.sys.mkdir(op.dir, { mode: 0o750, owner: 'root', group: org.osUser })
    for (const d of [op.workspace, op.backups, op.fleetBackups, op.tmp]) ctx.sys.mkdir(d, { mode: 0o700, owner: org.osUser, group: org.osUser })
    ctx.sys.link(path.join(ctx.paths.releases, release), op.app)
    if (c.listen === 'socket') {
      ctx.sys.writeText(op.tmpfilesConf, tmpfilesLine(ctx.paths, id), { mode: 0o644, owner: 'root' })
      undo.push('socket folder', () => { ctx.sys.remove(op.tmpfilesConf); ctx.sys.remove(op.runDir) })
      if (ctx.sys.kind === 'server') await ctx.sys.run('systemd-tmpfiles', ['--create', op.tmpfilesConf])
      else ctx.sys.mkdir(op.runDir, { mode: 0o2750, owner: org.osUser, group: 'caddy' })
    }
    say(`[3/12] database and role ${org.db} (no superuser, CREATEDB, CREATEROLE; CONNECT only to its own database; limit ${limits.dbConnections}; statement_timeout ${limits.statementTimeout})`)
    const password = newPassword()
    ctx.secrets.push(password)
    undo.push(`database and role ${org.db}`, () => dropInstallDatabase(ctx, org.db))
    await createInstallDatabase(ctx, org.db, password, limits)
    say('[4/12] secret key (workspace/.secret-key, 0600)')
    const key = newSecretKey()
    ctx.secrets.push(key)
    ctx.sys.writeText(op.secretKey, key + '\n', { mode: 0o600, owner: org.osUser, group: org.osUser })
    if (c.licence.enabled) {
      say('[5/12] licence registration (licence service)')
      org.licenceId = await licenceOrgCreate(ctx, { name, plan: org.plan, seats: org.seats })
      const lic = org.licenceId
      undo.push(`licence ${lic} (keys revoked, cancelled)`, () => licenceRetire(ctx, lic))
      const k = await licenceKey(ctx, lic, 'issue')
      ctx.sys.writeText(op.licenceKey, k + '\n', { mode: 0o640, owner: 'root', group: org.osUser })
      ctx.save()
    } else say('[5/12] licence: not configured for this fleet (skipped)')
    say('[6/12] instance.env (hosted settings, locked public address)')
    writeInstanceEnv(ctx, org)
    say('[7/12] seed-config (database password sealed into server.json)')
    const seed = await appCli(ctx, org, ['seed-config', '--workspace', op.workspace, '--db-host', c.pg.host, '--db-port', String(c.pg.port), '--db-name', org.db, '--db-user', org.db, '--test'], { input: password + '\n' })
    if (seed.code !== 0) throw new FleetError(`seed-config: ${scrub(seed.stderr || seed.stdout, ctx.secrets).trim()}`)
    say('[8/12] hosting-check')
    const chk = await appCli(ctx, org, ['hosting-check'], { mutates: false })
    if (chk.code !== 0 && !ctx.dry) throw new FleetError(`hosting-check: ${scrub(chk.stderr, ctx.secrets).trim()}`)
    say('[9/12] migrate')
    const mig = await appCli(ctx, org, ['migrate'])
    if (mig.code !== 0) throw new FleetError(`migrate: ${scrub(mig.stderr || mig.stdout, ctx.secrets).trim()}`)
    if (c.mail) {
      say('       mail relay of the fleet saved in the install')
      await agent(ctx, org, ['mail-setup'], { input: JSON.stringify({ ...c.mail, password: ctx.sys.readText(path.join(ctx.paths.secrets, 'mail-password'))?.trim() ?? '', installName: name }) + '\n' })
    }
    say(`[10/12] first administrator ${email} invited (one-time link, 7 days)`)
    const inv = await appCli(ctx, org, ['admin', 'invite', '--email', email, '--name', i.adminName?.trim() || `${name} administrator`, ...(c.mail && !i.printLink ? [] : ['--print-link'])])
    if (inv.code !== 0) throw new FleetError(`admin invite: ${scrub(inv.stderr || inv.stdout, ctx.secrets).trim()}`)
    link = /Invitation link \(one-time, a secret\): (\S+)/.exec(inv.stdout)?.[1]
    if (link) ctx.secrets.push(link)
    say(`[11/12] systemd unit ${unitOf(org)} enabled and started${ctx.sys.kind === 'server' ? '' : ' (local test mode: a child process)'}`)
    undo.push('limits drop-in', () => ctx.sys.remove(op.dropIn))
    await applyUnitLimits(ctx, org, { live: false })
    try {
      say(`       ${await applyQuota(ctx, org)}`)
      undo.push('disk quota', () => removeQuota(ctx, org))
    } catch (e) {
      ctx.out.warn(`       disk quota NOT applied (the size is watched instead): ${e instanceof Error ? e.message : String(e)}`)
    }
    undo.push(`unit ${unitOf(org)}`, async () => { await ctx.sys.unit('stop', unitOf(org)).catch(() => false); await ctx.sys.unit('disable', unitOf(org)).catch(() => false) })
    await ctx.sys.unit('enable', unitOf(org))
    await ctx.sys.unit('start', unitOf(org))
    say(`[12/12] Caddy site ${host}`)
    undo.push(`Caddy site ${host}`, async () => { ctx.sys.remove(op.caddySite); await reloadProxy(ctx).catch(() => {}) })
    ctx.sys.writeText(op.caddySite, caddySite(ctx.paths, c, org), { mode: 0o644, owner: 'root' })
    await reloadProxy(ctx)
    const h = await waitHealth(ctx, org, (i.healthTimeoutS ?? 120) * 1000)
    if (h !== 'ok') throw new FleetError(`${host} did not become healthy (last answer: ${h}).`)
    org.state = 'active'
    ctx.save()
  } catch (e) {
    const why = scrub(e instanceof Error ? e.message : String(e), ctx.secrets)
    ctx.out.warn(`FAILED: ${why}`)
    ctx.out.warn('Removing everything this command created ...')
    const u = await undo.run(ctx.out.warn)
    throw new FleetError(`Creating ${host} failed: ${why}${u.failed.length ? ` NOT fully rolled back: ${u.failed.join('; ')} (abfleet doctor lists what is left)` : ' Everything it created was removed.'}`)
  }
  const res: CreateResult = { id, host, url: `https://${host}`, release, licenceId: org.licenceId ?? null, invitation: link ? 'printed' : 'emailed', ms: ctx.sys.now() - t0 }
  if (link && i.printLink) res.link = link
  return res
}

/* ------------------------------------------------------------------ list / show / status */

export interface AgentInfo {
  ok: true
  schemaVersion: number | null
  users: { active: number; total: number } | null
  seats: { full: number; operator: number; external: number } | null
  readOnly: { reason: string; since: string | null; source: string } | null
  licence: { configured: boolean; lastCheck: { at: string; ok: boolean; error: string | null } | null } | null
  lastInstallBackup: string | null
  dbBytes: number | null
}

export interface OrgStatus {
  id: string
  host: string
  name: string
  state: string
  release: string
  health: string
  unitActive: boolean
  readOnly: string | null
  users: number | null
  seats: string | null
  seatsLicensed: number
  disk: number
  dbBytes: number | null
  lastBackup: string | null
  lastBackupOk: boolean | null
  lastLicenceCheck: string | null
  problems: string[]
}

export function orgList(ctx: Ctx): { id: string; host: string; name: string; state: string; release: string; plan: string; seats: number; createdOn: string }[] {
  return sortedOrgs(ctx.reg).map((o) => ({ id: o.id, host: o.host, name: o.name, state: o.state, release: o.release, plan: o.plan, seats: o.seats, createdOn: o.createdOn }))
}

export async function orgStatus(ctx: Ctx, org: OrgRecord, o: { deep?: boolean } = { deep: true }): Promise<OrgStatus> {
  const op = orgPaths(ctx.paths, org.id)
  const problems: string[] = []
  const unitActive = await ctx.sys.unit('is-active', unitOf(org)).catch(() => false)
  const health = unitActive ? await ctx.sys.probe(target(ctx, org), 3000) : 'down'
  if (org.state === 'active' || org.state === 'suspended') {
    if (!unitActive) problems.push('the service is not running')
    else if (health !== 'ok') problems.push(`health ${health}`)
  }
  let info: AgentInfo | null = null
  if (o.deep !== false) {
    try {
      info = await installCommand<AgentInfo>(ctx, org, 'status', ['status', '--json'], ['info'], { mutates: false, timeoutMs: 60_000 })
    } catch (e) {
      problems.push(`details unavailable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const disk = ctx.sys.du(op.dir)
  const quota = limitsOf(ctx.reg, org).diskQuota
  const q = /^(\d+)G$/i.exec(quota)
  if (q && disk > Number(q[1]) * 1024 ** 3 * 0.8) problems.push(`folder at ${formatBytes(disk)}, over 80 % of its ${quota} quota`)
  const seats = info?.seats ? `${info.seats.full}/${info.seats.operator}/${info.seats.external}` : null
  if (info?.seats && info.seats.full + info.seats.operator > org.seats) problems.push(`${info.seats.full + info.seats.operator} seats in use, ${org.seats} licensed`)
  if (info?.licence?.configured && info.licence.lastCheck && !info.licence.lastCheck.ok) problems.push(`licence check failing: ${info.licence.lastCheck.error ?? ''}`)
  if (org.lastBackup && !org.lastBackup.ok) problems.push('the last backup failed')
  if (!org.lastBackup && Date.parse(org.createdOn) < ctx.clock() - 36 * 3_600_000) problems.push('never backed up')
  return {
    id: org.id, host: org.host, name: org.name, state: org.state, release: org.release, health, unitActive,
    readOnly: info?.readOnly ? info.readOnly.reason : null, users: info?.users?.active ?? null, seats, seatsLicensed: org.seats,
    disk, dbBytes: info?.dbBytes ?? null, lastBackup: org.lastBackup?.at ?? null, lastBackupOk: org.lastBackup?.ok ?? null,
    lastLicenceCheck: info?.licence?.lastCheck ? `${info.licence.lastCheck.at}${info.licence.lastCheck.ok ? '' : ' (failed)'}` : null,
    problems,
  }
}

/** the registry record without anything secret (there is nothing secret in it) */
export function orgShow(ctx: Ctx, org: OrgRecord) {
  const op = orgPaths(ctx.paths, org.id)
  return { ...org, limits: limitsOf(ctx.reg, org), paths: { folder: op.dir, env: op.env, workspace: op.workspace, socket: ctx.reg.config.listen === 'socket' ? op.socket : null, caddySite: op.caddySite }, grants: ctx.reg.grants.filter((g) => g.org === org.id).slice(-10), backups: ctx.reg.backups.filter((b) => b.org === org.id).slice(-10) }
}

/* ------------------------------------------------------------------ suspend / resume */

export async function orgSuspend(ctx: Ctx, org: OrgRecord, o: { reason: string; stop?: boolean }): Promise<{ host: string; state: string }> {
  const reason = o.reason.trim()
  if (!reason) throw new FleetError('--reason is needed (one line, shown to the organisation\'s people).', 64)
  if (org.state === 'creating' || org.state === 'failed') throw new FleetError(`${org.host} is ${org.state}.`, 2)
  const r = await appCli(ctx, org, ['read-only', 'on', '--reason', 'suspended', '--message', reason.slice(0, 300)])
  if (r.code !== 0) throw new FleetError(`read-only on: ${r.stderr.trim()}`)
  ctx.out.say(`  ${org.host}: read-only (suspended); a running server applies it within 5 seconds. Sign-in, reading and export keep working.`)
  org.state = 'suspended'
  org.suspendReason = reason
  if (o.stop) {
    await ctx.sys.unit('stop', unitOf(org))
    await ctx.sys.unit('disable', unitOf(org))
    ctx.sys.writeText(orgPaths(ctx.paths, org.id).caddySite, caddyNotice(ctx.reg.config, org), { mode: 0o644, owner: 'root' })
    await reloadProxy(ctx)
    org.state = 'stopped'
    ctx.out.say(`  ${org.host}: stopped; Caddy answers with a notice page (503).`)
  }
  ctx.save()
  return { host: org.host, state: org.state }
}

export async function orgResume(ctx: Ctx, org: OrgRecord): Promise<{ host: string; state: string; health: string }> {
  if (org.state !== 'suspended' && org.state !== 'stopped') throw new FleetError(`${org.host} is ${org.state}, not suspended.`, 2)
  const r = await appCli(ctx, org, ['read-only', 'off'])
  if (r.code !== 0) throw new FleetError(`read-only off: ${r.stderr.trim()}`)
  let health = 'ok'
  if (org.state === 'stopped') {
    ctx.sys.writeText(orgPaths(ctx.paths, org.id).caddySite, caddySite(ctx.paths, ctx.reg.config, org), { mode: 0o644, owner: 'root' })
    await ctx.sys.unit('enable', unitOf(org))
    await ctx.sys.unit('start', unitOf(org))
    await reloadProxy(ctx)
    health = await waitHealth(ctx, org, 120_000)
    if (health !== 'ok') throw new FleetError(`${org.host} was started but is not healthy (${health}).`)
  }
  org.state = 'active'
  delete org.suspendReason
  ctx.save()
  return { host: org.host, state: org.state, health }
}

/* ------------------------------------------------------------------ delete */

export interface DeleteReport { host: string; id: string; export: string | null; removed: string[]; remaining: string[]; kept: string[] }

export async function orgDelete(ctx: Ctx, org: OrgRecord, o: { confirm: string; noExport?: boolean; purgeOffsite?: boolean }): Promise<DeleteReport> {
  if (o.confirm !== org.host) throw new FleetError(`Type the full host name to confirm: --confirm ${org.host}`, 64)
  const op = orgPaths(ctx.paths, org.id)
  const rep: DeleteReport = { host: org.host, id: org.id, export: null, removed: [], remaining: [], kept: [] }
  const step = async (what: string, fn: () => Promise<unknown> | unknown) => {
    try { await fn(); rep.removed.push(what) } catch (e) { rep.remaining.push(`${what}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  if (!o.noExport) {
    ctx.out.say(`  exporting ${org.host} first (verified archive, kept 30 days) ...`)
    try {
      const ex = await exportOrg(ctx, org, {})
      rep.export = ex.file
      rep.kept.push(`export ${ex.file}${ex.offsite ? ` (off the machine: ${ex.offsite})` : ''}, removed by retention after 30 days`)
    } catch (e) {
      throw new FleetError(`The export before deleting failed, so nothing was deleted: ${e instanceof Error ? e.message : String(e)} (--no-export deletes without one).`, 2)
    }
  }
  await step(`service ${unitOf(org)}`, async () => { await ctx.sys.unit('stop', unitOf(org)); await ctx.sys.unit('disable', unitOf(org)).catch(() => false) })
  await step(`Caddy site ${org.host}`, async () => { ctx.sys.remove(op.caddySite); await reloadProxy(ctx) })
  for (const g of ctx.reg.grants.filter((x) => x.org === org.id && x.state === 'active')) { g.state = 'ended'; g.endedOn = new Date(ctx.clock()).toISOString(); g.endReason = 'organisation deleted' }
  if (org.licenceId) {
    const lic = org.licenceId
    await step(`licence ${lic}: install keys revoked, cancelled`, () => licenceRetire(ctx, lic))
  }
  await step(`database and role ${org.db}`, () => dropInstallDatabase(ctx, org.db))
  await step('disk quota', () => removeQuota(ctx, org))
  await step(`folder ${op.dir} (workspace, backups, logs, licence key)`, () => ctx.sys.remove(op.dir))
  await step(`socket folder ${op.runDir}`, () => { ctx.sys.remove(op.tmpfilesConf); ctx.sys.remove(op.runDir) })
  await step(`unit drop-ins ${op.dropIn}`, async () => { ctx.sys.remove(op.dropIn); if (ctx.sys.kind === 'server') await ctx.sys.unit('daemon-reload') })
  await step(`OS user ${org.osUser}`, async () => { if (await ctx.sys.userExists(org.osUser)) await ctx.sys.deleteUser(org.osUser) })
  // the fleet's backups of the install: local copies go now; off-machine copies at the end of their retention (DC-14)
  const mine = ctx.reg.backups.filter((b) => b.org === org.id && b.kind !== 'export')
  for (const b of mine) {
    if (o.purgeOffsite && b.offsite) await step(`off-machine copy ${b.offsite}`, async () => { if (ctx.reg.config.backup.target?.kind === 'path') ctx.sys.remove(b.offsite!); else await ctx.sys.run(ctx.sys.which('rclone') ?? 'rclone', ['deletefile', b.offsite!]) })
    else if (b.offsite) rep.kept.push(`off-machine backup ${b.offsite} until ${new Date(Date.parse(b.at) + ctx.reg.config.backup.keepDays * 86_400_000).toISOString().slice(0, 10)} (retention, DC-14)`)
  }
  ctx.reg.backups = ctx.reg.backups.filter((b) => b.org !== org.id || b.kind === 'export' || (!o.purgeOffsite && !!b.offsite))
  delete ctx.reg.orgs[org.id]
  rep.removed.push('registry entry')
  ctx.save()
  rep.remaining.push(...(await scanFor(ctx, org)))
  rep.kept.push('the operator audit keeps the lines about this organisation (it is append-only by design)')
  return rep
}

/** what is still on the machine for an organisation id (delete's verification; also doctor) */
export async function scanFor(ctx: Ctx, org: OrgRecord): Promise<string[]> {
  if (ctx.dry) return []
  const op = orgPaths(ctx.paths, org.id)
  const left: string[] = []
  if (await databaseExists(ctx, org.db)) left.push(`database ${org.db}`)
  if (await roleExists(ctx, org.db)) left.push(`role ${org.db}`)
  const other = await ctx.sys.query('postgres', `SELECT datname FROM pg_catalog.pg_database WHERE datname LIKE '%${org.id}%' UNION ALL SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE '%${org.id}%'`)
  for (const r of other) if (r[0] !== org.db) left.push(`database object ${r[0]}`)
  if (await ctx.sys.userExists(org.osUser)) left.push(`OS user ${org.osUser}`)
  for (const p of [op.dir, op.runDir, op.caddySite, op.dropIn, op.tmpfilesConf]) if (ctx.sys.exists(p)) left.push(`file ${p}`)
  if (await ctx.sys.unit('is-active', unitOf(org)).catch(() => false)) left.push(`running service ${unitOf(org)}`)
  if (await ctx.sys.unit('is-enabled', unitOf(org)).catch(() => false)) left.push(`enabled service ${unitOf(org)}`)
  for (const f of ctx.sys.list(ctx.paths.caddySites)) if (ctx.sys.readText(path.join(ctx.paths.caddySites, f))?.includes(org.host)) left.push(`Caddy site ${f} names ${org.host}`)
  if (ctx.reg.orgs[org.id]) left.push('registry entry')
  for (const b of ctx.reg.backups.filter((x) => x.org === org.id && x.kind !== 'export' && ctx.sys.exists(x.file))) left.push(`local backup ${b.file}`)
  return left
}
