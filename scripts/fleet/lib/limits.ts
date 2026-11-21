/**
 * Package H-I: per-install resource limits (spec section 4). systemd (a drop-in per install, also applied to a running
 * install with `systemctl set-property --runtime`), PostgreSQL (role and database connection limit, statement and
 * idle-in-transaction timeouts), the Node.js heap (instance.env, at the next restart) and the disk:
 *
 *   - XFS mounted with prjquota / pquota: an XFS project quota on /srv/appbuilder/<id> (xfs_quota)
 *   - ext4 mounted with prjquota (and the project feature): a project quota (chattr +P, setquota -P)
 *   - anything else: no enforcement; `abfleet status` warns at 80 % (PostgreSQL has no per-database quota at all, so
 *     the database size is always only watched)
 *
 * Defaults are the spec's (MemoryHigh 1G, MemoryMax 1.5G, CPUQuota 200 %, TasksMax 256, 12 connections, 60 s, 25 GB).
 * They are estimates from the spike's measurements on a developer PC, not from a load test.
 */
import { FleetError, unitOf, type Ctx } from './core.ts'
import { roleSettingsSql, sqlSteps } from './db.ts'
import { DEFAULT_LIMITS, limitsOf, orgPaths, type Limits, type OrgRecord } from './model.ts'
import { limitsDropIn, runtimeProperties } from './templates.ts'
import { writeInstanceEnv } from './instance.ts'
import { parseSize } from './util.ts'

export function validateLimits(l: Partial<Limits>): string[] {
  const p: string[] = []
  for (const k of ['memoryHigh', 'memoryMax', 'diskQuota'] as const) if (l[k] !== undefined && parseSize(l[k]!) === null) p.push(`${k} must be a size such as 1536M or 1.5G`)
  if (l.memoryHigh && l.memoryMax && parseSize(l.memoryHigh)! > parseSize(l.memoryMax)!) p.push('memoryHigh must not be above memoryMax')
  if (l.cpuQuota !== undefined && !/^\d{1,4}%$/.test(l.cpuQuota)) p.push('cpuQuota must be a percentage such as 200%')
  for (const k of ['cpuWeight', 'tasksMax', 'nofile', 'heapMb', 'dbConnections'] as const) if (l[k] !== undefined && (!Number.isInteger(l[k]) || (l[k] as number) < 1)) p.push(`${k} must be a positive whole number`)
  if (l.dbConnections !== undefined && l.dbConnections < 8) p.push('dbConnections below 8 leaves no room for the pool (6), the job worker and a backup')
  for (const k of ['statementTimeout', 'idleInTransactionTimeout'] as const) if (l[k] !== undefined && !/^\d+(ms|s|min|h)$/.test(l[k]!)) p.push(`${k} must be a PostgreSQL duration such as 60s or 5min`)
  if (l.heapMb && l.memoryMax && l.heapMb * 1024 * 1024 > parseSize(l.memoryMax)!) p.push('heapMb must stay below memoryMax')
  return p
}

/** the drop-in, and the running cgroup when live */
export async function applyUnitLimits(ctx: Ctx, org: OrgRecord, o: { live: boolean }): Promise<string[]> {
  const l = limitsOf(ctx.reg, org)
  const op = orgPaths(ctx.paths, org.id)
  const notes: string[] = []
  ctx.sys.mkdir(op.dropIn, { mode: 0o755, owner: 'root' })
  ctx.sys.writeText(op.limitsConf, limitsDropIn(l), { mode: 0o644, owner: 'root' })
  if (ctx.sys.kind === 'local') { notes.push('systemd limits written but not enforced (local test mode: no systemd)'); return notes }
  await ctx.sys.unit('daemon-reload')
  if (o.live && (await ctx.sys.unit('is-active', unitOf(org)))) {
    const r = await ctx.sys.run('systemctl', ['set-property', '--runtime', unitOf(org), ...runtimeProperties(l)])
    notes.push(r.code === 0 ? 'applied to the running install' : `not applied live (${r.stderr.trim()}): at the next restart`)
  }
  return notes
}

export async function applyDbLimits(ctx: Ctx, org: OrgRecord): Promise<void> {
  await sqlSteps(ctx, 'postgres', roleSettingsSql(org.db, limitsOf(ctx.reg, org)))
}

async function mountOf(ctx: Ctx): Promise<{ fstype: string; options: string; target: string } | null> {
  if (ctx.sys.kind === 'local') return null
  const r = await ctx.sys.run('findmnt', ['-n', '-o', 'FSTYPE,OPTIONS,TARGET', '--target', ctx.paths.instances], { mutates: false })
  const m = /^(\S+)\s+(\S+)\s+(\S+)/.exec(r.stdout.trim())
  return m ? { fstype: m[1], options: m[2], target: m[3] } : null
}

export function quotaModeFor(m: { fstype: string; options: string } | null): 'xfs' | 'ext4' | 'watch' {
  if (!m) return 'watch'
  const opts = m.options.split(',')
  if (m.fstype === 'xfs' && (opts.includes('prjquota') || opts.includes('pquota'))) return 'xfs'
  if (m.fstype === 'ext4' && opts.includes('prjquota')) return 'ext4'
  return 'watch'
}

function nextProject(ctx: Ctx): number {
  const used = new Set(Object.values(ctx.reg.orgs).map((o) => o.quotaProject).filter(Boolean))
  let n = 7001
  while (used.has(n)) n++
  return n
}

export async function applyQuota(ctx: Ctx, org: OrgRecord): Promise<string> {
  const m = await mountOf(ctx)
  const mode = quotaModeFor(m)
  org.quotaMode = mode
  if (mode === 'watch') return `disk: no project quota on this filesystem (${m ? `${m.fstype} ${m.options.includes('quota') ? '' : 'without prjquota'}`.trim() : 'local test mode'}); the folder size is watched by abfleet status (warning at 80 % of ${limitsOf(ctx.reg, org).diskQuota})`
  org.quotaProject ??= nextProject(ctx)
  const dir = orgPaths(ctx.paths, org.id).dir
  const kb = Math.round(parseSize(limitsOf(ctx.reg, org).diskQuota)! / 1024)
  const run = async (cmd: string, args: string[]) => {
    const r = await ctx.sys.run(cmd, args)
    if (r.code !== 0) throw new FleetError(`${cmd} ${args.join(' ')}: ${r.stderr.trim()}`)
  }
  if (mode === 'xfs') {
    await run('xfs_quota', ['-x', '-c', `project -s -p ${dir} ${org.quotaProject}`, m!.target])
    await run('xfs_quota', ['-x', '-c', `limit -p bhard=${kb}k ${org.quotaProject}`, m!.target])
  } else {
    await run('chattr', ['-R', '+P', '-p', String(org.quotaProject), dir])
    await run('setquota', ['-P', String(org.quotaProject), '0', String(kb), '0', '0', m!.target])
  }
  return `disk: ${mode} project quota ${org.quotaProject}, ${limitsOf(ctx.reg, org).diskQuota} hard limit`
}

export async function removeQuota(ctx: Ctx, org: OrgRecord): Promise<void> {
  if (!org.quotaProject || !org.quotaMode || org.quotaMode === 'watch') return
  const m = await mountOf(ctx)
  if (!m) return
  if (org.quotaMode === 'xfs') await ctx.sys.run('xfs_quota', ['-x', '-c', `limit -p bhard=0 ${org.quotaProject}`, m.target])
  else await ctx.sys.run('setquota', ['-P', String(org.quotaProject), '0', '0', '0', '0', m.target])
}

export interface LimitsApplied { host: string; limits: Limits; notes: string[] }

/** limits apply [<org> | --all] [--memory-max ...]: changes stored per install, then applied everywhere */
export async function limitsApply(ctx: Ctx, orgs: OrgRecord[], change: Partial<Limits>, o: { restart?: boolean } = {}): Promise<LimitsApplied[]> {
  const bad = validateLimits({ ...DEFAULT_LIMITS, ...change })
  if (bad.length) throw new FleetError(bad.join('; '), 64)
  const out: LimitsApplied[] = []
  for (const org of orgs) {
    if (Object.keys(change).length) org.limits = { ...(org.limits ?? {}), ...change }
    const bad2 = validateLimits(limitsOf(ctx.reg, org))
    if (bad2.length) throw new FleetError(`${org.host}: ${bad2.join('; ')}`, 64)
    const notes = await applyUnitLimits(ctx, org, { live: true })
    await applyDbLimits(ctx, org)
    notes.push(`PostgreSQL: CONNECTION LIMIT ${limitsOf(ctx.reg, org).dbConnections} (role and database), statement_timeout ${limitsOf(ctx.reg, org).statementTimeout}, idle_in_transaction_session_timeout ${limitsOf(ctx.reg, org).idleInTransactionTimeout} (new sessions)`)
    writeInstanceEnv(ctx, org)
    notes.push(`Node.js heap ${limitsOf(ctx.reg, org).heapMb} MB (instance.env)${o.restart ? '' : ', at the next restart'}`)
    try {
      notes.push(await applyQuota(ctx, org))
    } catch (e) {
      notes.push(`disk quota NOT applied: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (o.restart && org.state === 'active') await ctx.sys.unit('restart', unitOf(org))
    out.push({ host: org.host, limits: limitsOf(ctx.reg, org), notes })
    ctx.save()
  }
  return out
}

export interface LimitsShown { host: string; configured: Limits; systemd: Record<string, string> | null; postgres: { connLimit: string; settings: string } | null; disk: { bytes: number; mode: string } }

export async function limitsShow(ctx: Ctx, orgs: OrgRecord[]): Promise<LimitsShown[]> {
  const out: LimitsShown[] = []
  for (const org of orgs) {
    let systemd: Record<string, string> | null = null
    if (ctx.sys.kind === 'server') {
      const r = await ctx.sys.run('systemctl', ['show', unitOf(org), '-p', 'MemoryHigh', '-p', 'MemoryMax', '-p', 'MemoryCurrent', '-p', 'CPUQuotaPerSecUSec', '-p', 'CPUWeight', '-p', 'TasksMax', '-p', 'TasksCurrent', '-p', 'LimitNOFILE', '-p', 'NRestarts'], { mutates: false })
      systemd = Object.fromEntries(r.stdout.trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    }
    const pg = (await ctx.sys.query('postgres', `SELECT r.rolconnlimit, coalesce(array_to_string(r.rolconfig, ', '), '') FROM pg_catalog.pg_roles r WHERE r.rolname = '${org.db.replace(/'/g, "''")}'`))[0]
    out.push({ host: org.host, configured: limitsOf(ctx.reg, org), systemd, postgres: pg ? { connLimit: pg[0], settings: pg[1] } : null, disk: { bytes: ctx.sys.du(orgPaths(ctx.paths, org.id).dir), mode: org.quotaMode ?? 'watch' } })
  }
  return out
}
