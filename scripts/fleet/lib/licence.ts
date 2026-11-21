/**
 * The licence service's own CLI (docs/admin/licensing.md "Operating the licence service"), run by abfleet as root with
 * the service's environment file. Install keys are read from its output once and go straight into the install's key
 * file: never to the screen, the audit or the registry.
 */
import path from 'node:path'
import { codeRoot, FleetError, type Ctx } from './core.ts'
import { parseEnvText } from './util.ts'

export const licenceEnvFile = (ctx: Ctx) => path.join(ctx.paths.licenceDir, 'licence.env')

export async function licenceCli(ctx: Ctx, args: string[], o: { mutates?: boolean } = {}): Promise<string> {
  const envText = ctx.sys.readText(licenceEnvFile(ctx))
  if (!envText && !ctx.dry) throw new FleetError(`The licence service is not set up (${licenceEnvFile(ctx)} is missing): abfleet init --licence.`)
  const env: Record<string, string> = { ...parseEnvText(envText ?? '') }
  if (ctx.paths.mode === 'local') for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k]!
  const main = path.join(codeRoot(ctx, ctx.paths.current), 'server', 'licence-service', 'main.ts')
  const r = await ctx.sys.run(ctx.paths.node, [main, ...args], { env, mutates: o.mutates, timeoutMs: 120_000 })
  if (ctx.dry && o.mutates !== false) return ''
  if (r.code !== 0) throw new FleetError(`licence-service ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.stdout).replace(/abl_\S+/g, 'abl_***').trim().slice(-600)}`)
  return r.stdout
}

/** a customer organisation in the licence service; returns its licence id */
export async function licenceOrgCreate(ctx: Ctx, o: { name: string; plan: string; seats: number }): Promise<string> {
  const out = await licenceCli(ctx, ['org', 'create', '--name', o.name, '--plan', o.plan, '--full', String(o.seats), '--operator', '0'])
  if (ctx.dry) return 'lic_dryrun0000'
  const id = /licence id (lic_[a-z0-9]+)/.exec(out)?.[1]
  if (!id) throw new FleetError('licence-service org create printed no licence id')
  return id
}

/** issues (or rotates) an install key; the key is returned to the caller only */
export async function licenceKey(ctx: Ctx, licenceId: string, how: 'issue' | 'rotate'): Promise<string> {
  const out = await licenceCli(ctx, ['key', how, licenceId])
  if (ctx.dry) return 'abl_dryrun'
  const key = /^(abl_\S+)$/m.exec(out)?.[1]
  if (!key) throw new FleetError(`licence-service key ${how} printed no key`)
  ctx.secrets.push(key)
  return key
}

/**
 * An organisation that leaves: its keys revoked and its licence cancelled (the licence CLI has no delete; the
 * organisation's row stays in the licence service as a record).
 */
export async function licenceRetire(ctx: Ctx, licenceId: string): Promise<void> {
  await licenceCli(ctx, ['key', 'revoke', licenceId])
  await licenceCli(ctx, ['cancel', licenceId, '--notice-days', '0'])
}

/** org show: install ids, keys (ids only) and last check-ins */
export async function licenceShow(ctx: Ctx, licenceId: string): Promise<string> {
  return licenceCli(ctx, ['org', 'show', licenceId], { mutates: false })
}
