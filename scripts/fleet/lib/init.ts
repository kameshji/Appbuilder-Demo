/**
 * abfleet init (prepare a server once; idempotent: re-running it changes only what differs) and abfleet doctor
 * (verifies all of it, and each install with the server's own `hosting-check`).
 */
import path from 'node:path'
import { appCli, FleetError, unitOf, type Ctx } from './core.ts'
import { checkInstallDatabase, clusterProblems, createInstallDatabase, databaseExists, prepareCluster, roleExists } from './db.ts'
import { licenceCli } from './licence.ts'
import { limitsOf, orgPaths, sortedOrgs, type FleetConfig } from './model.ts'
import { alertUnit, caddyBase, caddyNotice, caddySite, LICENCE_USER, licenceEnv, licenceUnit, limitsDropIn, TIMERS, timerService, timerUnit, UNIT_TEMPLATE, unitTemplate, wrapperScript } from './templates.ts'
import { stageRelease } from './update.ts'
import { MASTER_KEY } from './backup.ts'
import { newPassword, newSecretKey, ORG_ID } from './util.ts'
import { resolvePgBin } from './pg.ts'
import { CADDY_VALIDATE_ENV } from './instance.ts'

/** writes a file only when its content differs; returns whether it changed */
export function ensureFile(ctx: Ctx, p: string, text: string, o: { mode: number; owner?: string; group?: string }, changed: string[]): boolean {
  if (ctx.sys.readText(p) === text) return false
  ctx.sys.writeText(p, text, o)
  changed.push(p)
  return true
}

export interface InitInput {
  release?: string
  config: Partial<FleetConfig>
  licence?: boolean
  allowUnsigned?: boolean
  mailPasswordFile?: string
  alertPasswordFile?: string
}

export interface InitResult { changed: string[]; release: string | null; licence: string; notes: string[] }

export async function fleetInit(ctx: Ctx, i: InitInput): Promise<InitResult> {
  const p = ctx.paths
  const sys = ctx.sys
  const changed: string[] = []
  const notes: string[] = []
  const say = ctx.out.say
  // ---------------------------------------------------------------- 1. this server
  if (sys.kind === 'server') {
    const f = sys.facts()
    if (f.os !== 'linux') throw new FleetError('The fleet runs on Linux only (Ubuntu 22.04 / 24.04 LTS with systemd).', 2)
    if (!f.systemd) throw new FleetError('systemd is required (the installs run as systemd units).', 2)
    if (typeof process.getuid === 'function' && process.getuid() !== 0 && !ctx.dry) throw new FleetError('Run abfleet as root (sudo abfleet ...).', 77)
    if (!['ubuntu:22.04', 'ubuntu:24.04'].includes(f.distro)) notes.push(`untested distribution ${f.distro} (tested: Ubuntu 22.04 / 24.04)`)
    // the PostgreSQL tools: what the installer passed (--pg-bin), else the registry's, else detected (lib/pg.ts);
    // recorded in the registry now so every later command (and each install's APPBUILDER_PG_BIN) uses the same folder
    const pgBin = resolvePgBin(i.config.pgBin, ctx.reg.config.pgBin)
    if (!pgBin) throw new FleetError('No PostgreSQL client tools found (pg_config --bindir, /usr/lib/postgresql/<major>/bin): run the fleet installer (scripts/fleet/install.sh) or pass --pg-bin <dir>.', 2)
    i.config.pgBin = pgBin
    ctx.reg.config.pgBin = pgBin
    say(`  PostgreSQL client tools: ${pgBin}`)
    for (const [tool, where] of [['psql', path.join(pgBin, 'psql')],['caddy', sys.which('caddy')]] as const) if (!where || !sys.exists(where)) throw new FleetError(`${tool} is not installed (${where ?? 'not on the PATH'}): run the fleet installer (scripts/fleet/install.sh).`, 2)
  }
  const [maj, min] = process.versions.node.split('.').map(Number)
  if (maj < 22 || (maj === 22 && min < 18)) throw new FleetError(`Node.js ${process.version}: 22.18 or newer is needed.`, 2)
  try {
    await sys.query('postgres', 'SELECT 1')
  } catch (e) {
    throw new FleetError(`PostgreSQL does not answer: ${e instanceof Error ? e.message : String(e)}`, 2)
  }
  say('[1/8] server checked')
  // ---------------------------------------------------------------- 2. folders
  const dirs: [string, number, string?, string?][] = [
    [p.releases, 0o755], [p.instances, 0o711], [p.run, 0o755], [p.etc, 0o755], [p.secrets, 0o700], [p.state, 0o700], [p.exports, 0o700],
    [p.staging, 0o700], [p.auditDir, 0o700], [path.dirname(p.caddyfile), 0o755], [p.caddySites, 0o755], [p.systemd, 0o755], [p.tmpfiles, 0o755],
  ]
  for (const [d, mode, owner, group] of dirs) if (!sys.exists(d)) { sys.mkdir(d, { mode, owner: owner ?? 'root', group }); changed.push(d) }
  say('[2/8] folders')
  // ---------------------------------------------------------------- 3. registry and secrets
  Object.assign(ctx.reg.config, i.config)
  ctx.save()
  const mk = path.join(p.secrets, MASTER_KEY)
  if (!sys.exists(mk)) {
    sys.writeText(mk, newSecretKey() + '\n', { mode: 0o600, owner: 'root' })
    changed.push(mk)
    notes.push(`NEW backup master key ${mk}: copy it OFF this server now (a password manager, an encrypted USB key). Without it no fleet backup can be opened after losing the server.`)
  }
  for (const [file, dst] of [[i.mailPasswordFile, 'mail-password'], [i.alertPasswordFile, 'alert-mail-password']] as const) {
    if (!file) continue
    const t = sys.readText(file)
    if (t === null) throw new FleetError(`Cannot read ${file}.`, 64)
    ensureFile(ctx, path.join(p.secrets, dst), t.trim() + '\n', { mode: 0o600, owner: 'root' }, changed)
  }
  say('[3/8] registry and secrets')
  // ---------------------------------------------------------------- 4. the release
  let release: string | null = sys.readLink(p.current) ? path.basename(sys.readLink(p.current)!) : null
  if (i.release) {
    const r = await stageRelease(ctx, i.release, { allowUnsigned: i.allowUnsigned, trustSelf: !release })
    say(`  release ${r.version} (${r.commit.slice(0, 12)}), signature ${r.signature}${r.reused ? ', already in place' : ''}`)
    if (!release) { sys.link(r.dir, p.current); changed.push(p.current); release = r.version }
    else if (release !== r.version) notes.push(`the current release stays ${release}; switch the fleet with: abfleet update ${i.release}`)
  }
  if (!release) throw new FleetError('There is no release yet: abfleet init --release <release.zip | folder>.', 64)
  say(`[4/8] release ${release}`)
  // ---------------------------------------------------------------- 5. PostgreSQL
  await prepareCluster(ctx)
  const cp = await clusterProblems(ctx)
  notes.push(...cp.filter((x) => !x.startsWith('PUBLIC can connect')))
  say('[5/8] PostgreSQL: CONNECT revoked from PUBLIC on postgres and template1')
  // ---------------------------------------------------------------- 6. systemd
  const unitChanged = ensureFile(ctx, path.join(p.systemd, UNIT_TEMPLATE), unitTemplate(p, ctx.reg.config.limits), { mode: 0o644, owner: 'root' }, changed)
  ensureFile(ctx, path.join(p.systemd, 'appbuilder-fleet-alert@.service'), alertUnit(p), { mode: 0o644, owner: 'root' }, changed)
  for (const t of TIMERS) {
    ensureFile(ctx, path.join(p.systemd, `${t.name}.service`), timerService(p, t), { mode: 0o644, owner: 'root' }, changed)
    ensureFile(ctx, path.join(p.systemd, `${t.name}.timer`), timerUnit(t), { mode: 0o644, owner: 'root' }, changed)
  }
  if (sys.kind === 'server') {
    await sys.unit('daemon-reload')
    for (const t of TIMERS) if (!(await sys.unit('is-enabled', `${t.name}.timer`))) await sys.run('systemctl', ['enable', '--now', `${t.name}.timer`])
  }
  if (unitChanged && Object.keys(ctx.reg.orgs).length) notes.push('the unit template changed: installs pick it up at their next restart')
  say('[6/8] systemd template unit, timers')
  // ---------------------------------------------------------------- 7. Caddy
  if (ensureFile(ctx, p.caddyfile, caddyBase(p, ctx.reg.config), { mode: 0o644, owner: 'root' }, changed) && sys.kind === 'server') {
    await sys.run('systemctl', ['enable', 'caddy'])
    const v = await sys.run('caddy', ['validate', '--config', p.caddyfile, '--adapter', 'caddyfile'], { mutates: false, timeoutMs: 60_000, env: CADDY_VALIDATE_ENV })
    if (v.code !== 0 && !ctx.dry) throw new FleetError(`caddy validate: ${v.stderr.trim().split('\n').slice(-3).join(' ')}`)
    await sys.unit('reload', 'caddy').catch(async () => sys.unit('restart', 'caddy'))
  }
  say(`[7/8] Caddy (${ctx.reg.config.tls === 'internal' ? 'local CA' : 'automatic HTTPS'}), catch-all 404`)
  // ---------------------------------------------------------------- 8. licence service
  let licence = 'not set up (abfleet init --licence)'
  if (i.licence || ctx.reg.config.licence.enabled) {
    const c = ctx.reg.config.licence
    if (sys.kind === 'server' && !(await sys.userExists(LICENCE_USER))) { await sys.createUser(LICENCE_USER, p.licenceDir); changed.push(`user ${LICENCE_USER}`) }
    if (!sys.exists(p.licenceDir)) sys.mkdir(p.licenceDir, { mode: 0o750, owner: 'root', group: LICENCE_USER })
    const envFile = path.join(p.licenceDir, 'licence.env')
    const keys = path.join(p.licenceDir, 'keys')
    const pass = path.join(p.licenceDir, 'signing-passphrase')
    if (!sys.exists(envFile) || !(await databaseExists(ctx, c.db))) {
      const pw = newPassword()
      ctx.secrets.push(pw)
      if (await roleExists(ctx, c.db)) await sys.exec('postgres', `DROP DATABASE IF EXISTS "${c.db}" WITH (FORCE)`).then(() => sys.exec('postgres', `DROP ROLE IF EXISTS "${c.db}"`))
      await createInstallDatabase(ctx, c.db, pw, { ...ctx.reg.config.limits, dbConnections: 20 })
      if (!sys.exists(pass)) sys.writeText(pass, newPassword(24) + '\n', { mode: 0o600, owner: LICENCE_USER, group: LICENCE_USER })
      const pg = ctx.reg.config.pg
      sys.writeText(envFile, licenceEnv(ctx.reg.config, `postgres://${c.db}:${encodeURIComponent(pw)}@${pg.host}:${pg.port}/${c.db}`, path.join(keys, 'signing.key'), pass), { mode: 0o640, owner: 'root', group: LICENCE_USER })
      changed.push(envFile)
    }
    if (!sys.exists(path.join(keys, 'signing.key'))) {
      const out = await licenceCli(ctx, ['keygen', '--out', keys, '--passphrase-file', pass])
      const priv = /Private key: (.+)/.exec(out)?.[1]?.trim()
      const pub = /Public key:\s+(.+)/.exec(out)?.[1]?.trim()
      if (!ctx.dry) {
        if (!priv || !pub) throw new FleetError('licence-service keygen printed no key files.')
        sys.copyFile(priv, path.join(keys, 'signing.key'), { mode: 0o600, owner: LICENCE_USER, group: LICENCE_USER })
        sys.copyFile(pub, path.join(keys, 'signing.pub'), { mode: 0o644, owner: 'root' })
        // the installs cannot see /etc/appbuilder (InaccessiblePaths of the unit): a world-readable copy
        if (!sys.exists(p.shared)) sys.mkdir(p.shared, { mode: 0o755, owner: 'root' })
        sys.copyFile(pub, path.join(p.shared, 'licence-signing.pub'), { mode: 0o644, owner: 'root' })
      }
      c.publicKeyFile = path.join(p.shared, 'licence-signing.pub')
      notes.push(`NEW licence signing key in ${keys}: keep a copy off this server. Until its public key is in the release (server/core/licence/licence-keys.json), installs are given APPBUILDER_LICENCE_PUBLIC_KEY_FILE (the Admin console shows that a test key is in use).`)
      changed.push(keys)
    }
    if (sys.kind === 'server' && sys.exists(keys)) await sys.run('chown', ['-R', `${LICENCE_USER}:${LICENCE_USER}`, keys])
    await licenceCli(ctx, ['migrate'])
    ensureFile(ctx, path.join(p.systemd, 'appbuilder-licence.service'), licenceUnit(p), { mode: 0o644, owner: 'root' }, changed)
    if (sys.kind === 'server') await sys.unit('daemon-reload')
    await sys.unit('enable', 'appbuilder-licence')
    await sys.unit('restart', 'appbuilder-licence')
    c.enabled = true
    if (c.url === `https://licence.${ctx.reg.config.domain}` && sys.kind === 'local') c.url = `http://${c.host}:${c.port}`
    ctx.save()
    if (ensureFile(ctx, p.caddyfile, caddyBase(p, ctx.reg.config), { mode: 0o644, owner: 'root' }, changed)) await sys.unit('reload', 'caddy')
    let up = ctx.dry
    for (let k = 0; k < 60 && !up; k++) {
      up = (await sys.request({ host: '127.0.0.1', port: c.port }, 'GET', '/healthz', { timeoutMs: 2000 })).status === 200
      if (!up) await sys.sleep(500)
    }
    if (!up) throw new FleetError('The licence service did not answer on /healthz.')
    licence = `running on ${c.host}:${c.port} (${c.url})`
  }
  say(`[8/8] licence service: ${licence}`)
  if (sys.kind === 'server') {
    ensureFile(ctx, path.join(p.bin, 'abfleet'), wrapperScript(p), { mode: 0o755, owner: 'root' }, changed)
    if (!sys.exists(p.audit)) sys.writeText(p.audit, '', { mode: 0o600, owner: 'root' })
    await sys.run('chattr', ['+a', p.audit]).catch(() => null)
  }
  ctx.save()
  return { changed, release, licence, notes }
}

/* ------------------------------------------------------------------ doctor */

export interface DoctorResult { problems: string[]; checks: { what: string; ok: boolean; detail: string }[] }

export async function fleetDoctor(ctx: Ctx): Promise<DoctorResult> {
  const p = ctx.paths
  const sys = ctx.sys
  const checks: DoctorResult['checks'] = []
  const check = (what: string, ok: boolean, detail = '') => checks.push({ what, ok, detail })
  for (const x of await clusterProblems(ctx)) check('PostgreSQL cluster', false, x)
  if (!checks.length) check('PostgreSQL cluster', true, 'CONNECT revoked from PUBLIC on postgres and template1; max_connections sufficient')
  check('unit template', sys.readText(path.join(p.systemd, UNIT_TEMPLATE)) === unitTemplate(p, ctx.reg.config.limits), path.join(p.systemd, UNIT_TEMPLATE))
  check('Caddy base config', sys.readText(p.caddyfile) === caddyBase(p, ctx.reg.config), p.caddyfile)
  check('backup master key', !!sys.readText(path.join(p.secrets, MASTER_KEY)), path.join(p.secrets, MASTER_KEY))
  const cur = sys.readLink(p.current)
  check('current release', !!cur && sys.exists(path.join(cur, 'release.json')), cur ?? 'missing')
  const t = ctx.reg.config.backup.target
  check('off-machine backup target', !!t && (t.kind === 'rclone' ? !!sys.which('rclone') : sys.exists(t.path)), t ? (t.kind === 'path' ? t.path : `rclone ${t.remote}${sys.which('rclone') ? '' : ' (rclone NOT installed)'}`) : 'none configured')
  if (sys.kind === 'server') {
    const pgBin = ctx.reg.config.pgBin
    check('PostgreSQL client tools (registry)', !!pgBin && sys.exists(path.join(pgBin, 'psql')) && sys.exists(path.join(pgBin, 'pg_dump')), pgBin || 'not recorded: re-run abfleet init')
    for (const tm of TIMERS) check(`timer ${tm.name}`, await sys.unit('is-enabled', `${tm.name}.timer`), '')
    check('caddy', await sys.unit('is-active', 'caddy'), '')
  }
  if (ctx.reg.config.licence.enabled) {
    const c = ctx.reg.config.licence
    check('licence service', (await sys.request({ host: '127.0.0.1', port: c.port }, 'GET', '/healthz', { timeoutMs: 3000 })).status === 200, `${c.host}:${c.port}`)
  }
  for (const org of sortedOrgs(ctx.reg)) {
    const op = orgPaths(ctx.paths, org.id)
    const pre = `${org.host}:`
    const hc = await appCli(ctx, org, ['hosting-check'], { mutates: false, timeoutMs: 60_000 })
    check(`${pre} hosting-check`, hc.code === 0, hc.code === 0 ? 'no problems' : hc.stderr.trim().split('\n').slice(0, 3).join('; '))
    const running = await sys.unit('is-active', unitOf(org))
    const shouldRun = org.state === 'active' || org.state === 'suspended'
    check(`${pre} service`, running === shouldRun, `${running ? 'running' : 'not running'} (${org.state})`)
    if (running) check(`${pre} health`, (await sys.probe(ctx.reg.config.listen === 'socket' ? { host: org.host, socket: op.socket } : { host: org.host, port: org.port }, 3000)) === 'ok', '')
    const db = await checkInstallDatabase(ctx, org.db, limitsOf(ctx.reg, org))
    check(`${pre} database role`, !db.problems.length, db.problems.join('; ') || 'isolated (REVOKE, no attributes, limits, timeout)')
    const site = sys.readText(op.caddySite)
    check(`${pre} Caddy site`, site === (org.state === 'stopped' ? caddyNotice(ctx.reg.config, org) : caddySite(p, ctx.reg.config, org)), op.caddySite)
    check(`${pre} limits drop-in`, sys.readText(op.limitsConf) === limitsDropIn(limitsOf(ctx.reg, org)), op.limitsConf)
    check(`${pre} release link`, !!sys.readLink(op.app) && sys.exists(path.join(sys.readLink(op.app)!, 'release.json')), sys.readLink(op.app) ?? 'missing')
    if (sys.kind === 'server') {
      const want: [string, string, number][] = [[op.dir, `root:${org.osUser}`, 0o750], [op.env, `root:${org.osUser}`, 0o640], [op.workspace, `${org.osUser}:${org.osUser}`, 0o700], [op.secretKey, `${org.osUser}:${org.osUser}`, 0o600], [op.serverJson, `${org.osUser}:${org.osUser}`, 0o600]]
      for (const [f, own, mode] of want) {
        const s = sys.stat(f)
        check(`${pre} ${path.basename(f)}`, !!s && `${s.owner}:${s.group}` === own && s.mode === mode, s ? `${s.owner}:${s.group} ${s.mode.toString(8)}` : 'missing')
      }
    }
  }
  // leftovers of organisations the registry does not know
  const known = new Set(Object.keys(ctx.reg.orgs))
  for (const d of sys.list(p.instances)) if (ORG_ID.test(d) && !known.has(d)) check('leftover folder', false, path.join(p.instances, d))
  const pre = ctx.reg.config.prefix.replace(/_/g, '\\_')
  for (const r of await sys.query('postgres', `SELECT datname FROM pg_catalog.pg_database WHERE datname LIKE '${pre}o%' UNION SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE '${pre}o%'`)) {
    const id = r[0].slice(ctx.reg.config.prefix.length)
    if (ORG_ID.test(id) && !known.has(id)) check('leftover database or role', false, r[0])
  }
  return { problems: checks.filter((c) => !c.ok).map((c) => `${c.what}: ${c.detail}`), checks }
}
