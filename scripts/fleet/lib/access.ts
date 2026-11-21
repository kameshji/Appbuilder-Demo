/**
 * Package H-J: operator access (spec section 8) and secrets rotation (exit check 10).
 *
 * Operator access is VISIBLE and TIME-BOXED: `access grant <org> --reason --minutes` (at most 240) creates, through the
 * install's own code (agent.ts access-open, as the install's OS user), an install administrator account without a
 * password named "Operator access (<operator>)" for <accessEmail local part>+<grant id>@<domain>, with a one-time
 * invitation that expires with the grant; writes `install.operator_access` to the INSTALL's audit log and the grant to
 * the operator audit; and tells the organisation's install administrators at once (an in-app notification and, when
 * the install has a mail relay, an email) who, why and until when. At expiry (the sweep timer every 5 minutes, and the
 * start of every abfleet command) or on `access revoke`, the account is disabled, its sessions and remembered devices
 * end, its open tokens are revoked, `install.operator_access_end` is audited and the administrators are told.
 *
 * Root on the server can read everything regardless (stated to customers in the terms); this makes the product-level
 * access visible, not impossible.
 */
import path from 'node:path'
import { appCli, FleetError, installCommand, unitOf, waitHealth, type Ctx } from './core.ts'
import { roleVerifier, restoreVerifier, setRolePassword } from './db.ts'
import { licenceKey } from './licence.ts'
import { orgPaths, type Grant, type OrgRecord } from './model.ts'
import type { AgentInfo } from './org.ts'
import { b32, newPassword, scrub } from './util.ts'

export const MAX_ACCESS_MINUTES = 240

function accessAddress(ctx: Ctx, grantId: string): string | null {
  const a = ctx.reg.config.accessEmail ?? ctx.reg.config.operatorEmail
  if (!a) return null
  const [local, domain] = a.split('@')
  return `${local.split('+')[0]}+${grantId}@${domain}`
}

export interface GrantResult { grant: Grant; link?: string; emailed: boolean; notified: number }

export async function accessGrant(ctx: Ctx, org: OrgRecord, o: { reason: string; minutes: number; printLink?: boolean }): Promise<GrantResult> {
  const reason = o.reason.trim().replace(/[\r\n]+/g, ' ')
  if (reason.length < 5) throw new FleetError('--reason must say why (at least a few words; the organisation\'s administrators read it).', 64)
  if (!Number.isInteger(o.minutes) || o.minutes < 1 || o.minutes > MAX_ACCESS_MINUTES) throw new FleetError(`--minutes must be 1 to ${MAX_ACCESS_MINUTES} (spec section 8: at most 4 hours).`, 64)
  if (org.state !== 'active' && org.state !== 'suspended') throw new FleetError(`${org.host} is ${org.state}: no access can be granted.`, 2)
  const id = `g${b32(8)}`
  const email = accessAddress(ctx, id) ?? `operator+${id}@${org.host}.invalid`
  if (!accessAddress(ctx, id) && !o.printLink) throw new FleetError('No operator address is configured (abfleet init --access-email), so the one-time link cannot be emailed to you: add --print-link.', 2)
  const until = new Date(ctx.clock() + o.minutes * 60_000).toISOString()
  const common = ['--grant', id, '--email', email, '--name', `Operator access (${ctx.who})`, '--reason', reason, '--until', until, '--operator', ctx.who, ...(o.printLink ? ['--print-link'] : [])]
  const r = await installCommand<{ userId: string; link?: string; emailed: boolean; notified: number }>(ctx, org, 'operator-access',
    ['admin', 'operator-access', 'open', ...common, '--json'], ['access-open', ...common])
  const grant: Grant = { id, org: org.id, reason, by: ctx.who, createdOn: new Date(ctx.clock()).toISOString(), until, userId: r.userId ?? 'dry-run', email, state: 'active' }
  ctx.reg.grants.push(grant)
  ctx.save()
  if (r.link) ctx.secrets.push(r.link)
  return { grant, ...(o.printLink && r.link ? { link: r.link } : {}), emailed: !!r.emailed, notified: r.notified ?? 0 }
}

async function close(ctx: Ctx, g: Grant, why: 'expired' | 'revoked' | 'organisation deleted'): Promise<void> {
  const org = ctx.reg.orgs[g.org]
  const common = ['--grant', g.id, '--user', g.userId, '--why', why, '--operator', ctx.who]
  if (org) await installCommand(ctx, org, 'operator-access', ['admin', 'operator-access', 'close', ...common, '--json'], ['access-close', ...common])
  g.state = 'ended'
  g.endedOn = new Date(ctx.clock()).toISOString()
  g.endedBy = ctx.who
  g.endReason = why
  ctx.save()
}

export async function accessRevoke(ctx: Ctx, key: string): Promise<Grant[]> {
  const gs = ctx.reg.grants.filter((g) => g.state === 'active' && (g.id === key || g.org === key || ctx.reg.orgs[g.org]?.slug === key || ctx.reg.orgs[g.org]?.host === key))
  if (!gs.length) throw new FleetError(`No active operator access for ${key}.`, 2)
  for (const g of gs) await close(ctx, g, 'revoked')
  return gs
}

/** ends every grant whose time is up; returns them (errors are reported and retried next time) */
export async function accessSweep(ctx: Ctx, at?: number): Promise<{ ended: Grant[]; failed: string[] }> {
  const now = at ?? ctx.clock()
  const ended: Grant[] = []
  const failed: string[] = []
  for (const g of ctx.reg.grants.filter((x) => x.state === 'active' && Date.parse(x.until) <= now)) {
    try {
      await close(ctx, g, 'expired')
      ended.push(g)
    } catch (e) {
      failed.push(`${g.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { ended, failed }
}

export function accessList(ctx: Ctx, all = false): (Grant & { host: string; minutesLeft: number | null })[] {
  return ctx.reg.grants.filter((g) => all || g.state === 'active').map((g) => ({ ...g, host: ctx.reg.orgs[g.org]?.host ?? `(deleted ${g.org})`, minutesLeft: g.state === 'active' ? Math.max(0, Math.round((Date.parse(g.until) - ctx.clock()) / 60_000)) : null }))
}

/* ------------------------------------------------------------------ secrets rotation */

export type Rotatable = 'db' | 'secret-key' | 'licence-key'

export interface RotateResult { host: string; what: Rotatable; ok: boolean; message: string }

/**
 * db: a new role password (only its SCRAM verifier reaches PostgreSQL), sealed again into server.json by the install's
 *     own seed-config, restart, health, db-check; on any failure the old verifier and the old server.json are put back.
 * licence-key: the licence service rotates the install key (the old one is revoked at once), the key file is
 *     replaced, restart, health, a fresh licence check is waited for.
 * secret-key: NOT supported by the product: every value sealed with the key (server.json's database password,
 *     connection passwords, the mail password, two-step verification secrets, webhook secrets, the saved backup
 *     passphrase) would have to be re-sealed by the server itself, and there is no `rekey` command. Refused.
 */
export async function secretsRotate(ctx: Ctx, org: OrgRecord, what: Rotatable): Promise<RotateResult> {
  const op = orgPaths(ctx.paths, org.id)
  if (what === 'secret-key') {
    throw new FleetError('Rotating the secret key is not supported by this release: every value sealed with it (the database password in server.json, connection passwords, the mail password, two-step verification secrets, webhook secrets, the saved backup passphrase) must be re-sealed by the server, and the server has no "rekey" command yet. Nothing was changed. (Proposed: `appbuilder rekey --new-key-file <f>`, run with the install stopped, re-sealing every value in one transaction.)', 69)
  }
  const restart = async () => {
    await ctx.sys.unit('restart', unitOf(org))
    return (await waitHealth(ctx, org, 180_000)) === 'ok'
  }
  if (what === 'db') {
    const oldVerifier = await roleVerifier(ctx, org.db)
    const oldJson = ctx.sys.readText(op.serverJson)
    if ((!oldVerifier || !oldJson) && !ctx.dry) throw new FleetError(`${org.host}: cannot read the current role verifier or server.json, nothing was changed.`)
    const pw = newPassword()
    ctx.secrets.push(pw)
    const back = async (why: string): Promise<never> => {
      if (oldVerifier) await restoreVerifier(ctx, org.db, oldVerifier).catch(() => {})
      if (oldJson) ctx.sys.writeText(op.serverJson, oldJson, { mode: 0o600, owner: org.osUser, group: org.osUser })
      await restart().catch(() => false)
      throw new FleetError(`${org.host}: rotating the database password failed (${why}); the old password was put back.`)
    }
    await setRolePassword(ctx, org.db, pw)
    const c = ctx.reg.config.pg
    const seed = await appCli(ctx, org, ['seed-config', '--workspace', op.workspace, '--db-host', c.host, '--db-port', String(c.port), '--db-name', org.db, '--db-user', org.db, '--test'], { input: pw + '\n' })
    if (seed.code !== 0) return back(`seed-config: ${scrub(seed.stderr, ctx.secrets).trim()}`)
    if (!(await restart())) return back('not healthy after the restart')
    const chk = await appCli(ctx, org, ['db-check'], { mutates: false })
    if (chk.code !== 0 && !ctx.dry) return back('db-check failed')
    return { host: org.host, what, ok: true, message: 'new database password: role verifier changed, sealed again in server.json, restarted, healthy, db-check ok' }
  }
  // licence-key
  if (!org.licenceId) throw new FleetError(`${org.host} has no licence registration.`, 2)
  const oldKey = ctx.sys.readText(op.licenceKey)
  if (oldKey) ctx.secrets.push(oldKey.trim())
  const key = await licenceKey(ctx, org.licenceId, 'rotate')
  ctx.sys.writeText(op.licenceKey, key + '\n', { mode: 0o640, owner: 'root', group: org.osUser })
  const startedAt = ctx.clock()
  if (!(await restart())) throw new FleetError(`${org.host}: the new licence key is in place but the install is not healthy after the restart.`)
  if (ctx.dry) return { host: org.host, what, ok: true, message: 'dry run' }
  for (let i = 0; i < 30; i++) {
    const info = await installCommand<AgentInfo>(ctx, org, 'status', ['status', '--json'], ['info'], { mutates: false }).catch(() => null)
    const lc = info?.licence?.lastCheck
    if (lc && Date.parse(lc.at) >= startedAt - 5000) {
      if (lc.ok) return { host: org.host, what, ok: true, message: `new install key in ${path.basename(op.licenceKey)} (old key revoked by the licence service), restarted, licence check ok at ${lc.at}` }
      throw new FleetError(`${org.host}: the licence check with the new key failed: ${lc.error ?? 'unknown'} (the install keeps working on its last answer for up to 72 hours).`)
    }
    await ctx.sys.sleep(2000)
  }
  throw new FleetError(`${org.host}: no licence check was recorded within 60 s of the restart.`)
}
