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

/**
 * `caddy validate` runs as root and provisions the local CA (tls internal): without HOME it would write its data to
 * ./caddy of the working folder (/). Root's own data folder keeps that apart from Caddy's (/var/lib/caddy).
 */
export const CADDY_VALIDATE_ENV = { HOME: '/root', XDG_DATA_HOME: '/root/.local/share', XDG_CONFIG_HOME: '/root/.config' }

export async function reloadProxy(ctx: Ctx): Promise<void> {
  if (ctx.sys.kind === 'server') {
    const v = await ctx.sys.run('caddy', ['validate', '--config', ctx.paths.caddyfile, '--adapter', 'caddyfile'], { mutates: false, timeoutMs: 60_000, env: CADDY_VALIDATE_ENV })
    if (v.code !== 0 && !ctx.dry) throw new FleetError(`caddy validate: ${v.stderr.trim().split('\n').slice(-3).join(' ')}`)
  }
  await ctx.sys.unit('reload', 'caddy')
}
