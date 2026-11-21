/** Files of one install that several commands rewrite: its env file, and the proxy reload after a site change. */
import { FleetError, type Ctx } from './core.ts'
import { limitsOf, orgPaths, type OrgRecord } from './model.ts'
import { instanceEnv } from './templates.ts'

/** writes the instance env file from the registry (create, limits apply, secrets rotate) */
export function writeInstanceEnv(ctx: Ctx, org: OrgRecord): void {
  const op = orgPaths(ctx.paths, org.id)
  const licensed = !!org.licenceId && (ctx.dry || ctx.sys.exists(op.licenceKey))
  ctx.sys.writeText(op.env, instanceEnv({ paths: ctx.paths, config: ctx.reg.config, org, limits: limitsOf(ctx.reg, org), licensed }), { mode: 0o640, owner: 'root', group: org.osUser })
}

export async function reloadProxy(ctx: Ctx): Promise<void> {
  if (ctx.sys.kind === 'server') {
    const v = await ctx.sys.run('caddy', ['validate', '--config', ctx.paths.caddyfile, '--adapter', 'caddyfile'], { mutates: false, timeoutMs: 60_000 })
    if (v.code !== 0 && !ctx.dry) throw new FleetError(`caddy validate: ${v.stderr.trim().split('\n').slice(-3).join(' ')}`)
  }
  await ctx.sys.unit('reload', 'caddy')
}
