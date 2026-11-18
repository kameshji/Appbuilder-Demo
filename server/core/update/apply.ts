/**
 * The updater (package L): `appbuilder update <release.zip | folder | --staged>`, run by an administrator (root /
 * elevated) on the server. Steps:
 *
 *   1. unpack the package next to the current release (<root>/app.staging, same disk: renames are atomic);
 *   2. check every file against SHA256SUMS and the signature against the keys the INSTALLED release trusts;
 *   3. refuse a downgrade, a release that needs a newer Node.js, or one whose schema is older than the database's;
 *   4. check the running server is healthy (otherwise success could not be judged);
 *   5. stop the service, rename app -> app.previous and app.staging -> app, start the service. The server migrates the
 *      database at start and, when the schema changes, takes its automatic "before a server upgrade" backup first;
 *   6. wait for GET /api/v1/health to answer ok;
 *   7. on failure: stop, put app.previous back, start the old release, and report. The database is NOT restored
 *      automatically: if the new release had already migrated it, the command prints the pre-migration backup and the
 *      restore command (docs/admin/upgrades.md explains why that is a decision for a person).
 *
 * The platform parts (service control, health probe, schema reading, permissions) are injected so the flow is tested
 * with fakes (update.test.ts) and really executed by the Linux end-to-end run.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { InstallInfo } from './layout.ts'
import { checkSignature, compareVersions, nodeSatisfies, readReleaseInfo, readTrustedKeys, verifyTree, type ReleaseInfo, type SignatureStatus, type TreeCheck } from './release.ts'
import { extractZip } from './zip.ts'
import type { HealthStatus, UpdateHistoryEntry } from '../../../src/platform/ops.ts'

export interface ServiceControl {
  stop(): Promise<void>
  start(): Promise<void>
  running(): Promise<boolean>
}

export interface UpdateDeps {
  control: ServiceControl
  /** one GET /api/v1/health: the status, or 'down' when nothing answers */
  probe(): Promise<HealthStatus | 'down'>
  /** the database's schema version (null when it cannot be read) */
  readSchema(): Promise<number | null>
  /** the newest pre-migration backup made since `since` (path), or null */
  findBackup(since: Date): Promise<string | null>
  /** node --version of the Node.js the service runs */
  nodeVersion(): Promise<string>
  /** fixes owners / ACLs of the new app folder (Linux: root-owned, read-only for the service; Windows: inherited) */
  secure(dir: string): Promise<void>
  log(line: string): void
  confirm?(question: string): Promise<boolean>
  sleep?(ms: number): Promise<void>
}

export interface UpdateOptions {
  allowUnsigned?: boolean
  reinstall?: boolean
  allowDowngrade?: boolean
  /** proceed although the running server is not healthy before the update */
  force?: boolean
  yes?: boolean
  healthTimeoutMs?: number
  /** how long the restored previous release gets to answer ok (default 120 s, 30 s when the schema changed) */
  rollbackTimeoutMs?: number
  /** wait between health probes */
  pollMs?: number
}

export interface PreparedPackage {
  dir: string
  info: ReleaseInfo
  check: TreeCheck
  signature: SignatureStatus
  notes: string
}

export type UpdateOutcome =
  | { result: 'updated'; from: string; to: string; message: string }
  | { result: 'unchanged'; message: string }
  | { result: 'refused'; message: string }
  | { result: 'rolled-back'; from: string; to: string; message: string; backup: string | null; schemaChanged: boolean }
  | { result: 'failed'; message: string }

export const APP = 'app'
export const PREVIOUS = 'app.previous'
export const STAGING = 'app.staging'

const label = (r: ReleaseInfo) => `${r.version} (${r.commit.slice(0, 12)})`

/** the folder inside dir that holds release.json (dir itself, or its only sub-folder) */
export function releaseRootIn(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'release.json'))) return dir
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile())
  if (subs.length === 1 && !files.length && fs.existsSync(path.join(dir, subs[0].name, 'release.json'))) return path.join(dir, subs[0].name)
  return null
}

/**
 * Unpacks a release ZIP (or copies a release folder) into target (replaced) and checks it. trustedRoot: the release
 * whose release-keys.json decides which signatures count (the installed one).
 */
export function preparePackage(source: string, target: string, trustedRoot: string): PreparedPackage {
  const src = path.resolve(source)
  if (!fs.existsSync(src)) throw new Error(`${source} does not exist.`)
  fs.rmSync(target, { recursive: true, force: true })
  const unpack = `${target}.unpack`
  fs.rmSync(unpack, { recursive: true, force: true })
  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, unpack, { recursive: true, verbatimSymlinks: true })
  } else {
    extractZip(fs.readFileSync(src), unpack)
  }
  const root = releaseRootIn(unpack)
  if (!root) {
    fs.rmSync(unpack, { recursive: true, force: true })
    throw new Error('This is not an Appbuilder release package (no release.json).')
  }
  fs.renameSync(root, target)
  fs.rmSync(unpack, { recursive: true, force: true })
  const info = readReleaseInfo(target)
  if (!info) throw new Error('The release.json of the package is not readable.')
  const check = verifyTree(target)
  const signature = checkSignature(target, readTrustedKeys(trustedRoot))
  let notes = ''
  try {
    notes = fs.readFileSync(path.join(target, 'RELEASE-NOTES.md'), 'utf8')
  } catch { /* none */ }
  return { dir: target, info, check, signature, notes }
}

/** problems that forbid applying the package (empty: may be applied) */
export function packageProblems(p: PreparedPackage, trustedCount: number, o: { allowUnsigned?: boolean } = {}): string[] {
  const out: string[] = []
  if (!p.check.ok) {
    const parts = [
      p.check.missing.length ? `${p.check.missing.length} missing (${p.check.missing.slice(0, 3).join(', ')})` : '',
      p.check.changed.length ? `${p.check.changed.length} changed (${p.check.changed.slice(0, 3).join(', ')})` : '',
      p.check.extra.length ? `${p.check.extra.length} not listed (${p.check.extra.slice(0, 3).join(', ')})` : '',
    ].filter(Boolean)
    out.push(`The package does not match its checksum list: ${parts.join('; ')}.`)
  }
  const s = p.signature
  if (s.state === 'invalid') out.push(`The signature is not valid: ${s.reason}`)
  else if (s.state === 'untrusted' && !o.allowUnsigned) out.push(`The package is signed with key ${s.keyId}, which this install does not trust.`)
  else if (s.state === 'unsigned' && trustedCount > 0 && !o.allowUnsigned) out.push('The package is not signed, and this install only accepts signed releases (use --allow-unsigned only for a build you made yourself).')
  return out
}

export async function waitHealthy(deps: UpdateDeps, timeoutMs: number, pollMs: number): Promise<{ ok: boolean; last: HealthStatus | 'down' }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const until = Date.now() + timeoutMs
  let last: HealthStatus | 'down' = 'down'
  let notRunning = 0
  const started = Date.now()
  for (;;) {
    last = await deps.probe().catch(() => 'down' as const)
    if (last === 'ok') return { ok: true, last }
    // a service that keeps not running after a grace period has crashed (the wrapper may be restarting it)
    if (Date.now() - started > 20_000) {
      notRunning = (await deps.control.running().catch(() => false)) ? 0 : notRunning + 1
      if (notRunning >= 3) return { ok: false, last }
    }
    if (Date.now() >= until) return { ok: false, last }
    await sleep(pollMs)
  }
}

export function readHistory(file: string): UpdateHistoryEntry[] {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as UpdateHistoryEntry[]
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function appendHistory(file: string, e: UpdateHistoryEntry): void {
  const all = [e, ...readHistory(file)].slice(0, 50)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o644 })
  fs.renameSync(tmp, file)
}

export async function applyUpdate(info: InstallInfo, source: string, deps: UpdateDeps, o: UpdateOptions = {}, historyFile?: string): Promise<UpdateOutcome> {
  const root = info.root
  const appDir = path.join(root, APP)
  const prevDir = path.join(root, PREVIOUS)
  const stageDir = path.join(root, STAGING)
  const log = deps.log
  const current = readReleaseInfo(appDir)
  if (!current) return { result: 'refused', message: `${appDir} does not hold an installed release (release.json missing).` }

  log(`Installed: Appbuilder ${label(current)}, schema ${current.schemaVersion}`)
  log(`Checking the package ${source} ...`)
  let p: PreparedPackage
  try {
    p = preparePackage(source, stageDir, appDir)
  } catch (e) {
    return { result: 'refused', message: e instanceof Error ? e.message : String(e) }
  }
  const cleanup = () => fs.rmSync(stageDir, { recursive: true, force: true })
  const trusted = readTrustedKeys(appDir)
  log(`Package:   Appbuilder ${label(p.info)}, schema ${p.info.schemaVersion}, built ${p.info.built}`)
  log(`Checksums: ${p.check.ok ? `all ${p.check.files} files match` : 'MISMATCH'}`)
  log(`Signature: ${p.signature.state === 'valid' ? `valid (key ${p.signature.keyId}${p.signature.comment ? `, ${p.signature.comment}` : ''})` : p.signature.state}`)
  const problems = packageProblems(p, trusted.length, o)
  if (problems.length) {
    cleanup()
    return { result: 'refused', message: problems.join(' ') }
  }
  if (p.signature.state !== 'valid') log('WARNING: this package is not signed by a key this install trusts. Only continue with a build you made yourself.')

  const cmp = compareVersions(p.info.version, current.version)
  if (cmp === 0 && p.info.commit === current.commit && !o.reinstall) {
    cleanup()
    return { result: 'unchanged', message: `Appbuilder ${label(current)} is already installed (use --reinstall to install it again).` }
  }
  if (cmp < 0 && !o.allowDowngrade) {
    cleanup()
    return { result: 'refused', message: `The package (${p.info.version}) is older than the installed release (${current.version}). Downgrades are refused; restore a backup instead (docs/admin/upgrades.md).` }
  }
  const nodeV = await deps.nodeVersion().catch(() => '')
  if (!nodeV || !nodeSatisfies(p.info.node, nodeV)) {
    cleanup()
    return { result: 'refused', message: `The package needs Node.js ${p.info.node}; the service runs ${nodeV || 'an unknown version'}. Run the installer of the new release instead: it updates Node.js too.` }
  }
  const schemaBefore = await deps.readSchema().catch(() => null)
  if (schemaBefore !== null && p.info.schemaVersion < schemaBefore) {
    cleanup()
    return { result: 'refused', message: `The database is at schema version ${schemaBefore}, the package only knows version ${p.info.schemaVersion}: it could not use this database.` }
  }
  const migrates = schemaBefore !== null && p.info.schemaVersion > schemaBefore
  log(migrates
    ? `The database will be upgraded from schema ${schemaBefore} to ${p.info.schemaVersion}; the server takes an install backup first ("Before a server upgrade").`
    : schemaBefore === null ? 'The database schema version could not be read; the server migrates it at start if needed.' : 'No database schema change.')

  const before = await deps.probe().catch(() => 'down' as const)
  if (before !== 'ok' && !o.force) {
    cleanup()
    return { result: 'refused', message: `The running server is not healthy (${before}), so the update could not tell whether the new release works. Fix that first, or use --force.` }
  }

  if (!o.yes && deps.confirm && !(await deps.confirm(`Stop Appbuilder, install ${label(p.info)} and start it again?`))) {
    cleanup()
    return { result: 'refused', message: 'Cancelled.' }
  }

  const startedAt = new Date()
  log('Stopping the service ...')
  await deps.control.stop()
  log('Switching the app folder ...')
  fs.rmSync(prevDir, { recursive: true, force: true })
  fs.renameSync(appDir, prevDir)
  try {
    fs.renameSync(stageDir, appDir)
  } catch (e) {
    fs.renameSync(prevDir, appDir)
    await deps.control.start().catch(() => {})
    return { result: 'failed', message: `Could not move the new release into place (${e instanceof Error ? e.message : String(e)}); the previous release was started again.` }
  }
  await deps.secure(appDir)
  log('Starting the service (the server migrates the database at start) ...')
  await deps.control.start()
  const waited = await waitHealthy(deps, o.healthTimeoutMs ?? 600_000, o.pollMs ?? 2000)
  if (waited.ok) {
    const message = `Updated from ${label(current)} to ${label(p.info)}. The previous release is kept in ${prevDir}.`
    log(message)
    if (historyFile) appendHistory(historyFile, { at: new Date().toISOString(), from: current.version, to: p.info.version, result: 'updated', message, backup: migrates ? await deps.findBackup(startedAt).catch(() => null) : null })
    return { result: 'updated', from: current.version, to: p.info.version, message }
  }

  // roll back the app folder
  log(`The new release did not become healthy (last answer: ${waited.last}). Rolling back the app folder ...`)
  await deps.control.stop().catch(() => {})
  const schemaAfter = await deps.readSchema().catch(() => null)
  const schemaChanged = schemaBefore !== null && schemaAfter !== null && schemaAfter > schemaBefore
  const failedDir = path.join(root, 'app.failed')
  fs.rmSync(failedDir, { recursive: true, force: true })
  fs.renameSync(appDir, failedDir)
  fs.renameSync(prevDir, appDir)
  await deps.control.start().catch(() => {})
  // the old release refuses a database the new one migrated: no point waiting long for it then
  const after = await waitHealthy(deps, o.rollbackTimeoutMs ?? (schemaChanged ? 30_000 : 120_000), o.pollMs ?? 2000)
  const backup = schemaChanged ? await deps.findBackup(startedAt).catch(() => null) : null
  let message = `The update to ${label(p.info)} failed its health check; ${label(current)} was put back${after.ok ? ' and is healthy' : ` but is not healthy yet (${after.last})`}. The failed release is in ${failedDir} for inspection; the server log has the reason.`
  if (schemaChanged) {
    message += ` The new release had already upgraded the database to schema ${schemaAfter}, which ${current.version} cannot use. Either fix the cause and run the update again, or restore the database as it was before the update: ${backup ? `appbuilder restore "${backup}" --force` : 'appbuilder restore <the "Before a server upgrade" backup> --force'} (see docs/admin/upgrades.md#roll-back). This is not done automatically because it discards everything written since the migration.`
  }
  log(message)
  if (historyFile) appendHistory(historyFile, { at: new Date().toISOString(), from: current.version, to: p.info.version, result: 'rolled-back', message, backup })
  return { result: 'rolled-back', from: current.version, to: p.info.version, message, backup, schemaChanged }
}
