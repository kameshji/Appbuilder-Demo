/**
 * Package H-E: fleet updates (spec section 6 "update", section 11; exit check 3).
 *
 * The release is verified ONCE with the product updater's own primitives (server/core/update/apply.ts preparePackage
 * and packageProblems: every file against SHA256SUMS, the Ed25519 signature against the keys the INSTALLED current
 * release trusts, never keys inside the new package), unpacked as a new shared read-only release
 * /opt/appbuilder/releases/<version>, then installs are switched one by one: ONE canary first, then the rest in batches.
 *
 * Per install, and the rule for schema-changing releases (the product updater rolls back code but not data, because on
 * a single install people may have written after the migration; here the fleet can do better because it controls the
 * whole window):
 *
 *   1. read-only on (reason maintenance) unless it already was: from here until the end nobody writes business data
 *   2. stop; take a pre-update snapshot with the OLD release's engine while the install is stopped (consistent; nothing
 *      can write after it)
 *   3. switch the install's `app` link to the new release (app.previous keeps the old one), run `migrate` of the new
 *      release, start, wait for health, run the smoke check (default: health, /api/v1/status, a refused sign-in)
 *   4. success: read-only off (unless it was read-only before); the install runs the new release
 *   5. failure at any step after the snapshot: stop, put `app` back to the old release, and
 *        - if the database schema version changed, or migrate failed half-way, or the version cannot be read
 *          (`--data-rollback auto`, the default): restore the pre-update snapshot with the old release's
 *          `appbuilder restore --force` (one transaction). Nothing is lost: the install was read-only from step 1, so
 *          the only writes after the snapshot were the failed release's own migration;
 *        - otherwise only the code is rolled back (the data is untouched and still the old schema);
 *      then start the old release, health, read-only off. That install alone is rolled back and reported; the fleet
 *      stops (`--on-failure stop`, default; the canary failing always stops) or continues with the next batch.
 *   `--data-rollback always` restores the snapshot on every failure, `never` never does (then a schema-changed install
 *   whose old release refuses the newer database stays down and is reported: restore it with `abfleet update rollback
 *   <org> --restore-snapshot`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { agent, appCli, codeRoot, FleetError, readOnlyState, releaseDir, target, unitOf, waitHealth, type Ctx } from './core.ts'
import { alert, fleetBackup, restoreOrg } from './backup.ts'
import { orgPaths, sortedOrgs, type OrgRecord, type UpdateRun, type UpdateStep } from './model.ts'
import type { AgentInfo } from './org.ts'
import { b32, scrub } from './util.ts'

type ApplyModule = typeof import('../../../server/core/update/apply.ts')
type ReleaseModule = typeof import('../../../server/core/update/release.ts')

export interface StagedRelease { version: string; commit: string; schemaVersion: number; node: string; dir: string; signature: string; reused: boolean }

export interface UpdateOptions {
  canary?: string
  batch?: number
  onFailure?: 'stop' | 'continue'
  dataRollback?: 'auto' | 'always' | 'never'
  smoke?: string
  allowUnsigned?: boolean
  allowDowngrade?: boolean
  force?: boolean
  healthTimeoutS?: number
  only?: string[]
  /** tests: replaces the verification and unpacking (it needs real files) */
  stage?: (ctx: Ctx, source: string) => Promise<StagedRelease>
}

async function importFrom<T>(root: string, rel: string): Promise<T> {
  const { pathToFileURL } = await import('node:url')
  return (await import(pathToFileURL(path.join(root, rel)).href)) as T
}

export function releaseInfo(ctx: Ctx, version: string): { version: string; commit: string; schemaVersion: number; node: string } | null {
  try {
    const r = JSON.parse(ctx.sys.readText(path.join(releaseDir(ctx, version), 'release.json')) ?? '') as { version: string; commit: string; schemaVersion: number; node: string }
    return r
  } catch {
    return null
  }
}

/** verifies and unpacks a release package into releases/<version> (shared, root-owned, read-only) */
export async function stageRelease(ctx: Ctx, source: string, o: { allowUnsigned?: boolean; allowDowngrade?: boolean; trustSelf?: boolean } = {}): Promise<StagedRelease> {
  const currentLink = ctx.sys.readLink(ctx.paths.current)
  // trust anchors: the release-keys.json of the INSTALLED current release (for the very first release, the package's
  // own after the installer checked its SHA256SUMS: there is nothing installed to trust yet)
  const trustRoot = currentLink && !o.trustSelf ? currentLink : null
  // the verifying code: the installed release's (local test mode: the source tree it points to)
  const ownCode = path.join(source, 'server', 'core', 'update', 'apply.ts')
  const codeFrom = trustRoot ? codeRoot(ctx, trustRoot) : ctx.sys.exists(ownCode) ? source : path.resolve(ctx.paths.tool, '..', '..')
  const apply = await importFrom<ApplyModule>(codeFrom, 'server/core/update/apply.ts')
  const rel = await importFrom<ReleaseModule>(codeFrom, 'server/core/update/release.ts')
  ctx.sys.mkdir(ctx.paths.releases, { mode: 0o755, owner: 'root' })
  // next to the releases (same file system: the rename into place is atomic)
  const stage = path.join(ctx.paths.releases, `.staging-${b32(6)}`)
  // preparePackage writes only into its staging folder (also in --dry-run, which still verifies)
  let p: ReturnType<ApplyModule['preparePackage']>
  try {
    p = apply.preparePackage(source, stage, trustRoot ?? stage)
  } catch (e) {
    ctx.sys.remove(stage)
    throw new FleetError(`The release is refused: ${e instanceof Error ? e.message : String(e)}`, 2)
  }
  try {
    const trusted = rel.readTrustedKeys(trustRoot ?? stage)
    const problems = apply.packageProblems(p, trusted.length, { allowUnsigned: o.allowUnsigned })
    if (problems.length) throw new FleetError(`The release is refused: ${problems.join(' ')}`, 2)
    if (ctx.paths.mode === 'server' && ctx.sys.exists(path.join(stage, 'fleet-local-code.txt'))) throw new FleetError('This package is a local test package (fleet-local-code.txt): refused on a server.', 2)
    const current = currentLink ? releaseInfo(ctx, path.basename(currentLink)) : null
    if (current && rel.compareVersions(p.info.version, current.version) < 0 && !o.allowDowngrade) throw new FleetError(`The release ${p.info.version} is older than the current ${current.version}: downgrades are refused (restore backups instead).`, 2)
    const nodeV = (await ctx.sys.run(ctx.paths.node, ['--version'], { mutates: false })).stdout.trim() || process.version
    if (!rel.nodeSatisfies(p.info.node, nodeV)) throw new FleetError(`The release needs Node.js ${p.info.node}; the fleet runs ${nodeV}: run the fleet installer of the new release first (it updates Node.js).`, 2)
    const dst = releaseDir(ctx, p.info.version)
    const sig = p.signature.state === 'valid' ? `valid (key ${p.signature.keyId})` : p.signature.state
    if (ctx.sys.exists(dst)) {
      const have = releaseInfo(ctx, p.info.version)
      const check = rel.verifyTree(dst)
      if (have?.commit !== p.info.commit || !check.ok) throw new FleetError(`${dst} exists and is another or a damaged build of ${p.info.version}: remove it first (no install may use it).`, 2)
      ctx.sys.remove(stage)
      return { version: p.info.version, commit: p.info.commit, schemaVersion: p.info.schemaVersion, node: p.info.node, dir: dst, signature: sig, reused: true }
    }
    ctx.sys.mkdir(ctx.paths.releases, { mode: 0o755, owner: 'root' })
    ctx.sys.rename(stage, dst)
    ctx.sys.secureTree(dst)
    return { version: p.info.version, commit: p.info.commit, schemaVersion: p.info.schemaVersion, node: p.info.node, dir: dst, signature: sig, reused: false }
  } finally {
    // preparePackage wrote the staging folder itself (also in --dry-run): it is removed the same way
    fs.rmSync(stage, { recursive: true, force: true })
    fs.rmSync(`${stage}.unpack`, { recursive: true, force: true })
  }
}

/** the default smoke check after an update: health, the status route, a refused sign-in (database and identity work) */
async function smoke(ctx: Ctx, org: OrgRecord, script?: string): Promise<string | null> {
  if (ctx.dry) return null
  if (script) {
    const t = target(ctx, org)
    const r = await ctx.sys.run(ctx.paths.node, [script], {
      env: { ...(ctx.paths.mode === 'local' ? { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } : {}), ABFLEET_ORG: org.id, ABFLEET_HOST: org.host, ABFLEET_SLUG: org.slug, ...(t.socket ? { ABFLEET_SOCKET: t.socket } : { ABFLEET_PORT: String(t.port) }) },
      mutates: false, timeoutMs: 300_000,
    })
    return r.code === 0 ? null : `smoke script exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(-300)}`
  }
  const t = target(ctx, org)
  const st = await ctx.sys.request(t, 'GET', '/api/v1/status')
  if (st.status !== 200) return `GET /api/v1/status answered ${st.status}`
  const login = await ctx.sys.request(t, 'POST', '/api/v1/auth/login', { body: JSON.stringify({ email: 'smoke-check@abfleet.invalid', password: 'not-a-password-1' }) })
  if (login.status >= 500 || login.status === 0) return `a refused sign-in answered ${login.status} (expected 400/401)`
  return null
}

async function schemaOf(ctx: Ctx, org: OrgRecord, release?: string): Promise<number | null> {
  try {
    return (await agent<AgentInfo>(ctx, org, ['info'], { release, mutates: false, timeoutMs: 120_000 })).schemaVersion
  } catch {
    return null
  }
}

/** one install: the steps and the rule in the header */
export async function updateOne(ctx: Ctx, org: OrgRecord, rel: StagedRelease, o: UpdateOptions): Promise<UpdateStep> {
  const t0 = ctx.sys.now()
  const from = org.release
  const step = (result: UpdateStep['result'], message: string, extra: Partial<UpdateStep> = {}): UpdateStep => ({ org: org.id, host: org.host, result, from, to: rel.version, message, ms: ctx.sys.now() - t0, ...extra })
  const say = (m: string) => ctx.out.say(`  ${org.host}: ${m}`)
  if (from === rel.version) return step('skipped', 'already on this release')
  if (org.state === 'stopped' || org.state === 'creating' || org.state === 'failed') return step('skipped', `${org.state}: not updated (resume it, then run the update again)`)
  const before = await ctx.sys.probe(target(ctx, org), 3000)
  if (before !== 'ok' && !o.force && !ctx.dry) return step('skipped', `not healthy before the update (${before}); fix it first or use --force`)
  const op = orgPaths(ctx.paths, org.id)
  const ro = await readOnlyState(ctx, org)
  const wasReadOnly = ro.readOnly && !ctx.dry
  if (!wasReadOnly) {
    const r = await appCli(ctx, org, ['read-only', 'on', '--reason', 'maintenance', '--message', `Updating to ${rel.version}: back in a few minutes.`])
    if (r.code !== 0) return step('failed', `read-only on: ${r.stderr.trim()}`)
  }
  const writable = async () => { if (!wasReadOnly) await appCli(ctx, org, ['read-only', 'off']) }
  const schemaBefore = await schemaOf(ctx, org)
  say(`stopping (schema ${schemaBefore ?? '?'}) ...`)
  await ctx.sys.unit('stop', unitOf(org))
  let snapshot: string
  try {
    snapshot = (await fleetBackup(ctx, org, 'pre-update', { offsite: false })).file
  } catch (e) {
    await ctx.sys.unit('start', unitOf(org)).catch(() => false)
    await waitHealth(ctx, org, 120_000)
    await writable()
    return step('failed', `the pre-update snapshot failed, nothing was changed and ${from} runs again: ${e instanceof Error ? e.message : String(e)}`)
  }
  say(`snapshot ${path.basename(snapshot)}; switching to ${rel.version} ...`)
  ctx.sys.link(releaseDir(ctx, from), op.previous)
  ctx.sys.link(releaseDir(ctx, rel.version), op.app)
  let why: string | null = null
  let migrateFailed = false
  const mig = await appCli(ctx, org, ['migrate'], { timeoutMs: 1_800_000 })
  if (mig.code !== 0) { migrateFailed = true; why = `migrate failed: ${scrub(mig.stderr || mig.stdout, ctx.secrets).trim().split('\n').slice(-2).join(' ')}` }
  if (!why) {
    await ctx.sys.unit('start', unitOf(org))
    const h = await waitHealth(ctx, org, (o.healthTimeoutS ?? ctx.reg.config.update.healthTimeoutS) * 1000)
    if (h !== 'ok') why = `not healthy after the switch (last answer: ${h})`
  }
  if (!why) why = await smoke(ctx, org, o.smoke)
  if (!why) {
    await writable()
    org.previousRelease = from
    org.release = rel.version
    org.lastUpdate = { at: new Date(ctx.clock()).toISOString(), from, to: rel.version, result: 'updated', message: 'updated' }
    ctx.save()
    say(`updated to ${rel.version}`)
    return step('updated', `${from} -> ${rel.version}`)
  }
  // ---------------------------------------------------------------- roll this install back alone
  say(`FAILED (${why}); rolling back to ${from} ...`)
  await ctx.sys.unit('stop', unitOf(org)).catch(() => false)
  const schemaAfter = await schemaOf(ctx, org, from)
  const changed = migrateFailed || schemaAfter === null || schemaBefore === null || schemaAfter !== schemaBefore
  const policy = o.dataRollback ?? 'auto'
  const restore = policy === 'always' || (policy === 'auto' && changed)
  ctx.sys.link(releaseDir(ctx, from), op.app)
  if (org.previousRelease && ctx.sys.exists(releaseDir(ctx, org.previousRelease))) ctx.sys.link(releaseDir(ctx, org.previousRelease), op.previous)
  else ctx.sys.remove(op.previous)
  let healthy = false
  let restoreNote = ''
  if (restore) {
    say(`restoring the pre-update snapshot (${changed ? `schema ${schemaBefore ?? '?'} -> ${schemaAfter ?? '?'}${migrateFailed ? ', migrate failed' : ''}` : '--data-rollback always'}) ...`)
    try {
      const r = await restoreOrg(ctx, { ...org, state: 'active' }, { file: snapshot, skipSafety: true })
      healthy = r.healthy
      restoreNote = ' The database was restored from the pre-update snapshot (the install was read-only since the snapshot: no one\'s work is lost).'
    } catch (e) {
      restoreNote = ` RESTORING THE SNAPSHOT FAILED: ${e instanceof Error ? e.message : String(e)}`
      await ctx.sys.unit('start', unitOf(org)).catch(() => false)
      healthy = (await waitHealth(ctx, org, 120_000)) === 'ok'
    }
  } else {
    await ctx.sys.unit('start', unitOf(org)).catch(() => false)
    healthy = (await waitHealth(ctx, org, 120_000)) === 'ok'
    restoreNote = changed ? ' The schema had changed but --data-rollback never was given: the database was NOT restored.' : ' Only the code was rolled back (the database schema had not changed).'
  }
  if (healthy) await writable()
  const message = `${why}; ${from} was put back${healthy ? ' and is healthy' : ' but is NOT healthy'}.${restoreNote}`
  org.lastUpdate = { at: new Date(ctx.clock()).toISOString(), from, to: rel.version, result: healthy ? 'rolled-back' : 'failed', message }
  ctx.save()
  alert(ctx, 'update', message, org)
  return step(healthy ? 'rolled-back' : 'failed', message, { dataRestored: restore && restoreNote.includes('restored from') })
}

/** update <release.zip>: verify once, canary, then batches */
export async function fleetUpdate(ctx: Ctx, source: string, o: UpdateOptions): Promise<UpdateRun> {
  const rel = await (o.stage ?? ((c: Ctx, s: string) => stageRelease(c, s, o)))(ctx, source)
  ctx.out.say(`Release ${rel.version} (${rel.commit.slice(0, 12)}), schema ${rel.schemaVersion}, signature ${rel.signature}${rel.reused ? ', already unpacked' : `, unpacked to ${rel.dir}`}`)
  let orgs = sortedOrgs(ctx.reg).filter((x) => x.state === 'active' || x.state === 'suspended')
  if (o.only?.length) orgs = orgs.filter((x) => o.only!.some((k) => k === x.id || k === x.slug || k === x.host))
  const canary = o.canary ? orgs.find((x) => x.id === o.canary || x.slug === o.canary || x.host === o.canary) : orgs.find((x) => x.release !== rel.version)
  if (o.canary && !canary) throw new FleetError(`The canary ${o.canary} is not an active organisation.`, 64)
  const run: UpdateRun = { id: `u${b32(6)}`, at: new Date(ctx.clock()).toISOString(), by: ctx.who, release: rel.version, from: [...new Set(orgs.map((x) => x.release))], canary: canary?.id ?? null, result: 'running', steps: [] }
  ctx.reg.updates.push(run)
  ctx.save()
  const rest = orgs.filter((x) => x !== canary)
  const batch = Math.max(1, o.batch ?? ctx.reg.config.update.batch)
  const finish = (r: UpdateRun['result']) => {
    run.result = r
    for (const x of rest) if (!run.steps.some((s) => s.org === x.id)) run.steps.push({ org: x.id, host: x.host, result: 'not-run', from: x.release, to: rel.version, message: 'not attempted (the update stopped)' })
    ctx.save()
    return run
  }
  if (canary) {
    ctx.out.say(`Canary: ${canary.host}`)
    const s = await updateOne(ctx, canary, rel, o)
    run.steps.push(s)
    ctx.save()
    if (s.result === 'rolled-back' || s.result === 'failed') {
      ctx.out.warn(`The canary failed: the rest of the fleet was not touched. ${s.message}`)
      return finish('stopped')
    }
  }
  for (let i = 0; i < rest.length; i += batch) {
    const group = rest.slice(i, i + batch)
    ctx.out.say(`Batch ${Math.floor(i / batch) + 1}: ${group.map((x) => x.host).join(', ')}`)
    const steps = await Promise.all(group.map((x) => updateOne(ctx, x, rel, o)))
    run.steps.push(...steps)
    ctx.save()
    if (steps.some((s) => s.result === 'rolled-back' || s.result === 'failed') && (o.onFailure ?? 'stop') === 'stop') {
      ctx.out.warn('An install failed in this batch: stopping (--on-failure continue goes on with the next batch).')
      return finish('stopped')
    }
  }
  // new installs start on the new release once at least one install runs it
  if (run.steps.some((s) => s.result === 'updated') || !orgs.length) {
    ctx.sys.link(rel.dir, ctx.paths.current)
    if (ctx.reg.config.licence.enabled) await ctx.sys.unit('restart', 'appbuilder-licence').catch((e) => ctx.out.warn(`licence service restart: ${String(e)}`))
  }
  return finish('completed')
}

export function updateStatus(ctx: Ctx): { last: UpdateRun | null; orgs: { host: string; release: string; previous: string | null; lastUpdate: OrgRecord['lastUpdate'] | null }[]; current: string | null } {
  return {
    last: ctx.reg.updates[ctx.reg.updates.length - 1] ?? null,
    current: ctx.sys.readLink(ctx.paths.current) ? path.basename(ctx.sys.readLink(ctx.paths.current)!) : null,
    orgs: sortedOrgs(ctx.reg).map((x) => ({ host: x.host, release: x.release, previous: x.previousRelease ?? null, lastUpdate: x.lastUpdate ?? null })),
  }
}

/**
 * update rollback <org>: back to its previous release. When the database was migrated by the current release, the
 * previous one cannot use it: --restore-snapshot (with --confirm <host>) restores the pre-update snapshot, which
 * DISCARDS everything written since that update (a safety backup of the current state is taken first).
 */
export async function updateRollback(ctx: Ctx, org: OrgRecord, o: { restoreSnapshot?: boolean; confirm?: string } = {}): Promise<{ host: string; from: string; to: string; restored: boolean; healthy: boolean }> {
  const prev = org.previousRelease
  if (!prev || !ctx.sys.exists(releaseDir(ctx, prev))) throw new FleetError(`${org.host} has no previous release to go back to.`, 2)
  const prevInfo = releaseInfo(ctx, prev)
  const schemaNow = await schemaOf(ctx, org)
  const needsData = schemaNow !== null && prevInfo !== null && schemaNow > prevInfo.schemaVersion
  if (needsData && !o.restoreSnapshot) throw new FleetError(`${org.host}'s database is at schema ${schemaNow}; ${prev} knows ${prevInfo!.schemaVersion}. Going back needs --restore-snapshot --confirm ${org.host}, which discards everything written since the update.`, 2)
  if (o.restoreSnapshot && o.confirm !== org.host) throw new FleetError(`--restore-snapshot discards data: confirm with --confirm ${org.host}`, 64)
  const snap = ctx.reg.backups.filter((b) => b.org === org.id && b.kind === 'pre-update').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  if (o.restoreSnapshot && !snap) throw new FleetError(`${org.host} has no pre-update snapshot.`, 2)
  const op = orgPaths(ctx.paths, org.id)
  const cur = org.release
  await ctx.sys.unit('stop', unitOf(org))
  ctx.sys.link(releaseDir(ctx, prev), op.app)
  ctx.sys.link(releaseDir(ctx, cur), op.previous)
  let healthy: boolean
  if (o.restoreSnapshot) healthy = (await restoreOrg(ctx, org, { file: snap!.file })).healthy
  else {
    await ctx.sys.unit('start', unitOf(org))
    healthy = (await waitHealth(ctx, org, 180_000)) === 'ok'
  }
  org.release = prev
  org.previousRelease = cur
  org.lastUpdate = { at: new Date(ctx.clock()).toISOString(), from: cur, to: prev, result: 'rolled-back', message: `rolled back by ${ctx.who}${o.restoreSnapshot ? ' with the pre-update snapshot' : ''}` }
  ctx.save()
  return { host: org.host, from: cur, to: prev, restored: !!o.restoreSnapshot, healthy }
}
