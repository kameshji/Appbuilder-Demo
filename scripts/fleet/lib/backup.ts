/**
 * Package H-F: off-machine backups of every install (spec section 10).
 *
 * Each install is backed up with the PRODUCT's own backup engine (server/core/backup/engine.ts createArchive +
 * verifyArchive, run by agent.ts inside the install's context, as its OS user, from its own release): one install
 * archive, encrypted with a passphrase of its own (HMAC of the fleet's backup master key and the org id) and holding the
 * install's secret key (so a rebuilt server can restore it), verified, kept in the install's fleet-backups folder and
 * copied OFF the machine to the configured target, where the copy is checked again:
 *
 *   { kind: 'path', path }      a mounted folder (another disk, an NFS/SMB mount of another machine)
 *   { kind: 'rclone', remote }  any rclone remote (S3, B2, SFTP...): rclone is run as an external program and must be
 *                               installed and configured by the operator (`rclone config`); nothing is bundled
 *
 * Retention: keepDays (14, DC-14) for nightly and pre-update copies, 30 days for exports. The cluster's roles are
 * dumped nightly too (pg_dumpall --globals-only, sealed with the master key). Restore rebuilds ONE install from its
 * archive with the product's restore command (`appbuilder restore`, one transaction); the monthly restore test restores
 * one install's latest off-machine copy into a scratch database and folder and removes them again.
 */
import path from 'node:path'
import { appCli, FleetError, installCommand, unitOf, waitHealth, type Ctx } from './core.ts'
import { createInstallDatabase, dropInstallDatabase } from './db.ts'
import { orgPaths, sortedOrgs, type BackupEntry, type OrgRecord } from './model.ts'
import { b32, newPassword, orgPassphrase, scrub, sealBlob } from './util.ts'

export const MASTER_KEY = 'backup-master.key'

export function masterKey(ctx: Ctx): string {
  const k = ctx.sys.readText(path.join(ctx.paths.secrets, MASTER_KEY))?.trim()
  if (!k || !/^[0-9a-f]{64}$/.test(k)) {
    if (ctx.dry) return '0'.repeat(64)
    throw new FleetError(`The fleet's backup master key is missing (${path.join(ctx.paths.secrets, MASTER_KEY)}): run abfleet init. Keep a copy of it OFF the machine: without it no fleet backup can be opened.`)
  }
  return k
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

export interface AgentBackup { ok: true; file: string; bytes: number; sha256: string; manifestSha256: string; rows: number | null; schemaVersion: number; environments: number }

/**
 * One verified install archive made by the product's engine inside the install's context. kind 'export' uses the
 * given passphrase (or none) and no key; every other kind the org's own passphrase and the key.
 */
export async function fleetBackup(ctx: Ctx, org: OrgRecord, kind: BackupEntry['kind'], o: { release?: string; passphrase?: string | null; includeKey?: boolean; offsite?: boolean } = {}): Promise<BackupEntry> {
  const op = orgPaths(ctx.paths, org.id)
  const file = path.join(op.fleetBackups, `${org.slug}-${kind}-${stamp(ctx.clock())}.abbak`)
  const pass = kind === 'export' ? (o.passphrase ?? null) : orgPassphrase(masterKey(ctx), org.id)
  if (pass) ctx.secrets.push(pass)
  const includeKey = kind === 'export' ? !!o.includeKey && !!pass : true
  ctx.out.say(`  ${org.host}: ${kind} backup with the install's own engine${pass ? ', encrypted' : ''}${includeKey ? ', with its key' : ''} ...`)
  const trigger = kind === 'pre-update' ? 'pre-upgrade' : 'manual'
  const keyFlag = includeKey ? ['--include-key'] : []
  // the release's `appbuilder backup create` (passphrase on standard input), or the agent for an older release
  const r = await installCommand<AgentBackup>(ctx, org, 'backup-create',
    ['backup', 'create', '--out', file, '--trigger', trigger, '--note', `abfleet ${kind}`, '--passphrase-stdin', ...keyFlag, '--json'],
    ['backup', '--out', file, '--trigger', trigger, '--note', `abfleet ${kind}`, ...keyFlag],
    { input: `${pass ?? ''}\n`, release: o.release })
  const entry: BackupEntry = { org: org.id, host: org.host, at: new Date(ctx.clock()).toISOString(), file: ctx.dry ? file : r.file, bytes: r.bytes ?? 0, sha256: r.sha256 ?? '', kind, offsite: null, verified: !ctx.dry }
  if (o.offsite !== false && ctx.reg.config.backup.target) entry.offsite = await copyOffsite(ctx, org, entry.file, entry.sha256)
  ctx.reg.backups.push(entry)
  return entry
}

/** copies a file off the machine and checks the copy; returns where it is */
export async function copyOffsite(ctx: Ctx, org: OrgRecord | null, file: string, sha256: string): Promise<string> {
  const t = ctx.reg.config.backup.target
  if (!t) throw new FleetError('No off-machine target is configured (abfleet init --backup-target <folder|rclone:remote:path>).')
  const sub = org ? org.id : '_fleet'
  const name = path.basename(file)
  if (t.kind === 'path') {
    const dir = path.join(t.path, sub)
    const dst = path.join(dir, name)
    ctx.sys.mkdir(dir, { mode: 0o700, owner: 'root' })
    ctx.sys.copyFile(file, dst, { mode: 0o600, owner: 'root' })
    if (!ctx.dry) {
      const got = ctx.sys.sha256(dst)
      if (got !== sha256) throw new FleetError(`The off-machine copy ${dst} does not match (sha256 ${got ?? 'unreadable'}).`)
    }
    return dst
  }
  const rclone = ctx.sys.which('rclone')
  if (!rclone && !ctx.dry) throw new FleetError('The backup target is an rclone remote, but rclone is not installed (apt install rclone, then rclone config).')
  const remote = `${t.remote.replace(/\/+$/, '')}/${sub}/${name}`
  const cp = await ctx.sys.run(rclone ?? 'rclone', ['copyto', file, remote, '--checksum'], { timeoutMs: 3_600_000 })
  if (cp.code !== 0) throw new FleetError(`rclone copyto ${remote}: ${cp.stderr.trim().slice(-400)}`)
  if (!ctx.dry) {
    const h = await ctx.sys.run(rclone!, ['hashsum', 'sha256', remote], { mutates: false, timeoutMs: 600_000 })
    const got = /^([0-9a-f]{64})\s/m.exec(h.stdout)?.[1]
    if (got && got !== sha256) throw new FleetError(`The off-machine copy ${remote} does not match (sha256 ${got}).`)
    if (!got) {
      // a remote without SHA-256 hashes: the size at least (rclone's own transfer check covered the content)
      const ls = await ctx.sys.run(rclone!, ['lsjson', remote], { mutates: false })
      if (ls.code !== 0 || !/"Size":\s*\d+/.test(ls.stdout)) throw new FleetError(`The off-machine copy ${remote} cannot be listed: ${ls.stderr.trim().slice(-300)}`)
    }
  }
  return remote
}

async function removeOffsite(ctx: Ctx, where: string): Promise<void> {
  const t = ctx.reg.config.backup.target
  if (!t) return
  if (t.kind === 'path') { ctx.sys.remove(where); return }
  const rclone = ctx.sys.which('rclone') ?? 'rclone'
  await ctx.sys.run(rclone, ['deletefile', where])
}

/** brings an off-machine copy back next to the install (restore test, restore from the target) */
async function fetchOffsite(ctx: Ctx, org: OrgRecord, e: BackupEntry, dst: string): Promise<void> {
  const t = ctx.reg.config.backup.target
  if (!t || !e.offsite) throw new FleetError(`The backup ${path.basename(e.file)} has no off-machine copy.`)
  if (t.kind === 'path') ctx.sys.copyFile(e.offsite, dst, { mode: 0o600, owner: org.osUser, group: org.osUser })
  else {
    const r = await ctx.sys.run(ctx.sys.which('rclone') ?? 'rclone', ['copyto', e.offsite, dst], { timeoutMs: 3_600_000 })
    if (r.code !== 0) throw new FleetError(`rclone copyto (fetch): ${r.stderr.trim().slice(-300)}`)
    ctx.sys.mkdir(path.dirname(dst), { mode: 0o700, owner: org.osUser, group: org.osUser })
  }
  if (!ctx.dry && ctx.sys.sha256(dst) !== e.sha256) throw new FleetError(`The copy fetched from ${e.offsite} does not match its recorded sha256.`)
}

export function alert(ctx: Ctx, kind: string, message: string, org?: OrgRecord): void {
  ctx.reg.alerts.push({ at: new Date(ctx.clock()).toISOString(), kind, ...(org ? { org: org.id } : {}), message })
  ctx.out.warn(`ALERT (${kind})${org ? ` ${org.host}` : ''}: ${message}`)
}

export interface BackupRunResult { ok: string[]; failed: { org: string; error: string }[]; globals: string | null; pruned: number }

/** backup run [<org> | --all]: nightly backups (the timer runs --all --scheduled) */
export async function backupRun(ctx: Ctx, orgs: OrgRecord[], o: { globals?: boolean } = {}): Promise<BackupRunResult> {
  const res: BackupRunResult = { ok: [], failed: [], globals: null, pruned: 0 }
  if (!ctx.reg.config.backup.target) ctx.out.warn('No off-machine target is configured: the backups stay on this server only (abfleet init --backup-target ...).')
  for (const org of orgs) {
    if (org.state === 'creating' || org.state === 'failed') continue
    try {
      const e = await fleetBackup(ctx, org, 'nightly')
      org.lastBackup = { at: e.at, ok: true, file: e.file, sha256: e.sha256, offsite: !!e.offsite }
      res.ok.push(org.host)
    } catch (err) {
      const error = scrub(err instanceof Error ? err.message : String(err), ctx.secrets)
      org.lastBackup = { at: new Date(ctx.clock()).toISOString(), ok: false, error }
      res.failed.push({ org: org.host, error })
      alert(ctx, 'backup', error, org)
    }
    ctx.save()
  }
  if (o.globals !== false) {
    try {
      res.globals = await globalsDump(ctx)
    } catch (err) {
      alert(ctx, 'backup', `the roles dump (pg_dumpall --globals-only) failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  res.pruned = await prune(ctx)
  ctx.save()
  return res
}

/** the cluster's roles (for rebuilding the server), sealed with the master key */
async function globalsDump(ctx: Ctx): Promise<string | null> {
  const text = await ctx.sys.dumpGlobals()
  if (ctx.dry) return null
  const dir = path.join(ctx.paths.state, 'globals')
  ctx.sys.mkdir(dir, { mode: 0o700, owner: 'root' })
  const file = path.join(dir, `globals-${stamp(ctx.clock())}.sql.sealed`)
  ctx.sys.writeText(file, sealBlob(masterKey(ctx), 'globals', Buffer.from(text, 'utf8')).toString('base64') + '\n', { mode: 0o600, owner: 'root' })
  const sha = ctx.sys.sha256(file) ?? ''
  const entry: BackupEntry = { org: '_fleet', host: '-', at: new Date(ctx.clock()).toISOString(), file, bytes: ctx.sys.stat(file)?.size ?? 0, sha256: sha, kind: 'globals', offsite: null, verified: true }
  if (ctx.reg.config.backup.target) entry.offsite = await copyOffsite(ctx, null, file, sha)
  ctx.reg.backups.push(entry)
  return file
}

/** removes copies older than the retention, on this server and at the target */
export async function prune(ctx: Ctx): Promise<number> {
  const now = ctx.clock()
  const keep = ctx.reg.config.backup.keepDays * 86_400_000
  const keepExport = 30 * 86_400_000
  let n = 0
  const kept: BackupEntry[] = []
  for (const e of ctx.reg.backups) {
    const age = now - Date.parse(e.at)
    const old = e.kind === 'export' ? age > keepExport : age > keep
    // the newest good backup of an install is never pruned
    const newest = e.kind === 'nightly' && !ctx.reg.backups.some((x) => x.org === e.org && x.kind === 'nightly' && Date.parse(x.at) > Date.parse(e.at))
    if (old && !newest) {
      ctx.sys.remove(e.file)
      if (e.offsite) await removeOffsite(ctx, e.offsite).catch((err) => ctx.out.warn(`could not remove ${e.offsite}: ${String(err)}`))
      n++
    } else kept.push(e)
  }
  ctx.reg.backups = kept
  return n
}

export interface BackupStatusRow { org: string; host: string; state: string; last: string | null; ok: boolean | null; ageHours: number | null; offsite: boolean; copies: number; problem: string | null }

export function backupStatus(ctx: Ctx): BackupStatusRow[] {
  const now = ctx.clock()
  return sortedOrgs(ctx.reg).map((o) => {
    const copies = ctx.reg.backups.filter((b) => b.org === o.id && b.kind === 'nightly')
    const last = o.lastBackup ?? null
    const ageHours = last ? Math.round((now - Date.parse(last.at)) / 3_600_000) : null
    const problem = !last ? 'never backed up' : !last.ok ? `last backup failed: ${last.error ?? ''}` : ageHours! > 36 ? `last good backup ${ageHours} hours ago` : !last.offsite && ctx.reg.config.backup.target ? 'no off-machine copy' : null
    return { org: o.id, host: o.host, state: o.state, last: last?.at ?? null, ok: last?.ok ?? null, ageHours, offsite: !!last?.offsite, copies: copies.length, problem }
  })
}

function latest(ctx: Ctx, org: OrgRecord, kinds: BackupEntry['kind'][] = ['nightly', 'pre-update', 'pre-restore']): BackupEntry | null {
  return ctx.reg.backups.filter((b) => b.org === org.id && kinds.includes(b.kind) && b.verified).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
}

/** a passphrase file the install's user can read, for one command; removed by the caller */
function passFile(ctx: Ctx, org: OrgRecord, pass: string): string {
  const f = path.join(orgPaths(ctx.paths, org.id).tmp, `pp-${b32(8)}`)
  ctx.sys.writeText(f, pass + '\n', { mode: 0o600, owner: org.osUser, group: org.osUser })
  return f
}

export interface RestoreTestResult { org: string; host: string; backup: string; ok: boolean; tables: number; rows: number; error?: string; scratch: string }

/** the monthly restore test: one install's latest OFF-MACHINE copy into a scratch database and folder, then removed */
export async function restoreTest(ctx: Ctx, org: OrgRecord): Promise<RestoreTestResult> {
  const e = latest(ctx, org, ['nightly'])
  if (!e) throw new FleetError(`${org.host} has no verified nightly backup to test.`)
  const op = orgPaths(ctx.paths, org.id)
  const id = b32(8)
  const scratch = `${ctx.reg.config.prefix}rt_${id}`
  const dir = path.join(op.tmp, `restore-test-${id}`)
  const archive = e.offsite ? path.join(dir, path.basename(e.file)) : e.file
  const pw = newPassword()
  ctx.secrets.push(pw)
  const res: RestoreTestResult = { org: org.id, host: org.host, backup: path.basename(e.file), ok: false, tables: 0, rows: 0, scratch }
  let pf: string | null = null
  try {
    ctx.sys.mkdir(dir, { mode: 0o700, owner: org.osUser, group: org.osUser })
    ctx.sys.mkdir(path.join(dir, 'workspace'), { mode: 0o700, owner: org.osUser, group: org.osUser })
    if (e.offsite) {
      ctx.out.say(`  fetching the off-machine copy ${e.offsite} ...`)
      await fetchOffsite(ctx, org, e, archive)
    } else ctx.out.warn('  this backup has no off-machine copy: testing the copy on this server')
    await createInstallDatabase(ctx, scratch, pw, { ...ctx.reg.config.limits, statementTimeout: '0' })
    pf = passFile(ctx, org, orgPassphrase(masterKey(ctx), org.id))
    const c = ctx.reg.config.pg
    const r = await appCli(ctx, org, ['restore', archive, '--workspace', path.join(dir, 'workspace'), '--db-host', c.host, '--db-port', String(c.port), '--db-name', scratch, '--db-user', scratch, '--passphrase-file', pf, '--yes'], { env: { APPBUILDER_DB_PASSWORD: pw, APPBUILDER_SECRET_KEY: '' }, timeoutMs: 3_600_000 })
    const outText = scrub(r.stdout + r.stderr, ctx.secrets)
    for (const m of outText.matchAll(/^\s+\S+: (\d+) tables, ([\d,]+) rows/gm)) { res.tables += Number(m[1]); res.rows += Number(m[2].replace(/,/g, '')) }
    if (r.code !== 0 && !ctx.dry) throw new FleetError(`restore into the scratch database failed: ${outText.trim().split('\n').slice(-3).join(' ')}`)
    res.ok = true
  } catch (err) {
    res.error = scrub(err instanceof Error ? err.message : String(err), ctx.secrets)
  } finally {
    if (pf) ctx.sys.remove(pf)
    await dropInstallDatabase(ctx, scratch).catch((err) => ctx.out.warn(`could not drop ${scratch}: ${String(err)}`))
    ctx.sys.remove(dir)
  }
  org.lastRestoreTest = { at: new Date(ctx.clock()).toISOString(), ok: res.ok, ...(res.error ? { error: res.error } : {}) }
  if (!res.ok) alert(ctx, 'restore-test', res.error ?? 'failed', org)
  ctx.save()
  return res
}

export interface RestoreResult { org: string; host: string; from: string; safety: string | null; healthy: boolean; output: string }

/**
 * Rebuilds ONE install from an archive (its latest backup by default): stop it, keep a safety backup of what is there,
 * `appbuilder restore --force` (one transaction; a failure leaves the database as it was), start, health. No other
 * install is stopped, read or written.
 */
export async function restoreOrg(ctx: Ctx, org: OrgRecord, o: { file?: string; fromOffsite?: boolean; skipSafety?: boolean } = {}): Promise<RestoreResult> {
  const op = orgPaths(ctx.paths, org.id)
  let archive = o.file ?? null
  let fetched: string | null = null
  const e = archive ? null : latest(ctx, org)
  if (!archive) {
    if (!e) throw new FleetError(`${org.host} has no fleet backup to restore (give the archive file).`, 2)
    archive = e.file
    if (o.fromOffsite || !ctx.sys.exists(e.file)) {
      fetched = path.join(op.tmp, `restore-${b32(6)}-${path.basename(e.file)}`)
      await fetchOffsite(ctx, org, e, fetched)
      archive = fetched
    }
  }
  const wasRunning = await ctx.sys.unit('is-active', unitOf(org))
  ctx.out.say(`  stopping ${org.host} ...`)
  await ctx.sys.unit('stop', unitOf(org))
  let safety: string | null = null
  if (!o.skipSafety) {
    const s = await fleetBackup(ctx, org, 'pre-restore', { offsite: false })
    safety = s.file
  }
  const pf = passFile(ctx, org, orgPassphrase(masterKey(ctx), org.id))
  let output = ''
  try {
    ctx.out.say(`  restoring ${path.basename(archive)} into ${org.host} (one transaction) ...`)
    const r = await appCli(ctx, org, ['restore', archive, '--force', '--yes', '--passphrase-file', pf], { timeoutMs: 3_600_000 })
    output = scrub(r.stdout + r.stderr, ctx.secrets)
    if (r.code !== 0 && !ctx.dry) throw new FleetError(`restore failed (the database is unchanged; the install is started again): ${output.trim().split('\n').slice(-3).join(' ')}`)
  } finally {
    ctx.sys.remove(pf)
    if (fetched) ctx.sys.remove(fetched)
    if (wasRunning || org.state === 'active' || org.state === 'suspended') {
      await ctx.sys.unit('start', unitOf(org))
    }
  }
  const h = org.state === 'stopped' ? 'down' : await waitHealth(ctx, org, ctx.reg.config.update.healthTimeoutS * 1000)
  ctx.save()
  return { org: org.id, host: org.host, from: archive, safety, healthy: h === 'ok' || org.state === 'stopped', output }
}

/** export for the customer: a verified archive with a checksum file, in the exports folder (and off the machine) */
export async function exportOrg(ctx: Ctx, org: OrgRecord, o: { passphrase?: string | null; includeKey?: boolean; out?: string }): Promise<{ file: string; sha256: string; bytes: number; offsite: string | null; encrypted: boolean }> {
  const e = await fleetBackup(ctx, org, 'export', { passphrase: o.passphrase ?? null, includeKey: o.includeKey, offsite: false })
  const dst = o.out ?? path.join(ctx.paths.exports, path.basename(e.file))
  ctx.sys.mkdir(path.dirname(dst), { mode: 0o700, owner: 'root' })
  ctx.sys.copyFile(e.file, dst, { mode: 0o600, owner: 'root' })
  ctx.sys.remove(e.file)
  ctx.sys.writeText(`${dst}.sha256`, `${e.sha256}  ${path.basename(dst)}\n`, { mode: 0o600, owner: 'root' })
  if (!ctx.dry && ctx.sys.sha256(dst) !== e.sha256) throw new FleetError(`The export ${dst} does not match its checksum after the copy.`)
  e.file = dst
  if (ctx.reg.config.backup.target) e.offsite = await copyOffsite(ctx, org, dst, e.sha256)
  ctx.save()
  return { file: dst, sha256: e.sha256, bytes: e.bytes, offsite: e.offsite, encrypted: !!o.passphrase }
}

