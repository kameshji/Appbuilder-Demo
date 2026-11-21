/**
 * The daily summary for the operator (spec section 9): exceptions only (failed or old backups, installs that are down,
 * near their limits or failing their licence check, restarts, failed updates and restore tests, open operator access,
 * alerts of the last day). `summary --send` emails it through the fleet's alert relay with the release's own SMTP
 * client (server/core/identity/smtp.ts); `alert` (systemd OnFailure of an install) sends one line at once.
 */
import path from 'node:path'
import { codeRoot, unitOf, type Ctx } from './core.ts'
import { backupStatus } from './backup.ts'
import { orgStatus } from './org.ts'
import { sortedOrgs, type MailRelay } from './model.ts'

type SmtpModule = typeof import('../../../server/core/identity/smtp.ts')

export interface Summary { at: string; exceptions: string[]; ok: number; total: number }

export async function buildSummary(ctx: Ctx): Promise<Summary> {
  const now = ctx.clock()
  const ex: string[] = []
  const orgs = sortedOrgs(ctx.reg)
  let ok = 0
  for (const org of orgs) {
    const s = await orgStatus(ctx, org, { deep: org.state !== 'stopped' })
    const mine = [...s.problems]
    if (ctx.sys.kind === 'server' && org.state !== 'stopped') {
      const r = await ctx.sys.run('systemctl', ['show', unitOf(org), '-p', 'NRestarts', '--value'], { mutates: false })
      const n = Number(r.stdout.trim())
      if (n > 0) mine.push(`restarted ${n} time(s) by systemd since it was started`)
    }
    if (org.lastRestoreTest && !org.lastRestoreTest.ok) mine.push(`restore test failed ${org.lastRestoreTest.at}: ${org.lastRestoreTest.error ?? ''}`)
    if (org.lastUpdate && org.lastUpdate.result !== 'updated' && now - Date.parse(org.lastUpdate.at) < 7 * 86_400_000) mine.push(`update ${org.lastUpdate.to}: ${org.lastUpdate.result}`)
    if (mine.length) ex.push(...mine.map((m) => `${org.host}: ${m}`))
    else ok++
  }
  for (const b of backupStatus(ctx)) if (b.problem && !ex.some((e) => e.startsWith(`${b.host}:`) && e.includes('backup'))) ex.push(`${b.host}: ${b.problem}`)
  const tested = orgs.map((o) => o.lastRestoreTest?.at).filter(Boolean).sort().pop()
  if (orgs.length && (!tested || now - Date.parse(tested) > 35 * 86_400_000)) ex.push(`fleet: no restore test in the last 35 days${tested ? ` (last ${tested})` : ''}`)
  for (const g of ctx.reg.grants.filter((x) => x.state === 'active')) ex.push(`${ctx.reg.orgs[g.org]?.host ?? g.org}: operator access by ${g.by} until ${g.until} (${g.reason})`)
  const last = ctx.reg.updates[ctx.reg.updates.length - 1]
  if (last && last.result !== 'completed' && now - Date.parse(last.at) < 7 * 86_400_000) ex.push(`fleet: the update to ${last.release} on ${last.at.slice(0, 10)} ${last.result}`)
  for (const a of ctx.reg.alerts.filter((x) => now - Date.parse(x.at) < 86_400_000)) ex.push(`alert ${a.at.slice(11, 16)} UTC${a.org ? ` ${ctx.reg.orgs[a.org]?.host ?? a.org}` : ''} (${a.kind}): ${a.message}`)
  return { at: new Date(now).toISOString(), exceptions: [...new Set(ex)], ok, total: orgs.length }
}

export function summaryText(s: Summary, domain: string): { subject: string; text: string } {
  const subject = s.exceptions.length ? `Appbuilder fleet ${domain}: ${s.exceptions.length} exception(s)` : `Appbuilder fleet ${domain}: nothing to report`
  const text = [
    `Appbuilder fleet ${domain}, ${s.at.slice(0, 16).replace('T', ' ')} UTC`,
    `${s.ok} of ${s.total} installs without exceptions.`,
    '',
    ...(s.exceptions.length ? s.exceptions.map((e) => `- ${e}`) : ['Nothing needs attention.']),
    '',
    'Details: sudo abfleet status; sudo abfleet backup status; sudo abfleet doctor',
  ].join('\n')
  return { subject, text }
}

/** sends one message to the operator through the alert relay; returns a note (never throws) */
export async function mailOperator(ctx: Ctx, subject: string, text: string): Promise<string> {
  const relay: MailRelay | null = ctx.reg.config.alertRelay ?? ctx.reg.config.mail
  const to = ctx.reg.config.operatorEmail
  if (!relay || !to) return 'not sent: no operator address or relay (abfleet init --operator-email, --mail-host / --alert-host)'
  if (ctx.dry) return `would send "${subject}" to ${to}`
  try {
    const { pathToFileURL } = await import('node:url')
    const smtp = (await import(pathToFileURL(path.join(codeRoot(ctx, ctx.paths.current), 'server', 'core', 'identity', 'smtp.ts')).href)) as SmtpModule
    const pw = ctx.sys.readText(path.join(ctx.paths.secrets, ctx.reg.config.alertRelay ? 'alert-mail-password' : 'mail-password'))?.trim()
    await smtp.sendSmtp({ host: relay.host, port: relay.port, security: relay.security, ...(relay.username ? { username: relay.username, password: pw ?? '' } : {}) }, { from: { address: relay.fromAddress, name: relay.fromName || 'Appbuilder fleet' }, to, subject, text })
    return `sent to ${to}`
  } catch (e) {
    return `NOT sent: ${e instanceof Error ? e.message : String(e)}`
  }
}
