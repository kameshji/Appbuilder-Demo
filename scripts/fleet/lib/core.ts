/**
 * The context every command gets: the system adapter, paths, the registry (read once, saved explicitly), output,
 * the operator audit, and the helpers to run an install's own commands (`appbuilder <cmd>` of its release, as its OS
 * user, with its environment) and the fleet agent (agent.ts, inside an install's context).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyRegistry, orgPaths, type FleetPaths, type OrgRecord, type Registry } from './model.ts'
import type { Health, RunResult, System, Target } from './system.ts'
import { scrub } from './util.ts'

export class FleetError extends Error {
  /** exit codes: 1 failed, 2 refused (nothing changed), 64 usage, 69 not supported, 75 busy */
  readonly code: number
  constructor(message: string, code = 1) { super(message); this.code = code }
}

export interface Output {
  /** progress lines (stderr with --json, stdout otherwise) */
  say(line: string): void
  warn(line: string): void
}

export interface Ctx {
  sys: System
  paths: FleetPaths
  reg: Registry
  out: Output
  json: boolean
  dry: boolean
  /** the operator (sudo user) */
  who: string
  /** secrets that must never reach output or logs (filled as they are made) */
  secrets: string[]
  save(): void
  /** local test mode: a clock offset for time-travel tests of expiry (sweep --at) */
  clock(): number
}

export function actor(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ABFLEET_ACTOR) return env.ABFLEET_ACTOR
  if (env.SUDO_USER) return env.SUDO_USER
  try { return os.userInfo().username } catch { return env.USER || env.USERNAME || 'unknown' }
}

/* ------------------------------------------------------------------ registry */

export function loadRegistry(sys: System, p: FleetPaths): Registry | null {
  const t = sys.readText(p.registry)
  if (!t) return null
  const r = JSON.parse(t) as Registry
  if (r.version !== 1) throw new FleetError(`${p.registry} has version ${String(r.version)}; this abfleet knows version 1.`)
  r.grants ??= []
  r.updates ??= []
  r.backups ??= []
  r.alerts ??= []
  return r
}

export function saveRegistry(sys: System, p: FleetPaths, r: Registry): void {
  r.updates = r.updates.slice(-50)
  r.backups = r.backups.slice(-5000)
  r.alerts = r.alerts.slice(-500)
  sys.writeText(p.registry, JSON.stringify(r, null, 2) + '\n', { mode: 0o600, owner: 'root' })
}

export function blankRegistry(sys: System, config: Registry['config']): Registry {
  return emptyRegistry(config, sys.now())
}

/* ------------------------------------------------------------------ the operator audit */

export interface AuditEntry { at: string; who: string; host: string; mode: string; command: string[]; org?: string; dryRun: boolean; result: 'ok' | 'failed' | 'refused'; message: string; ms: number }

/** appended, never rewritten (the server sets chattr +a on the file at init) */
export function appendAudit(sys: System, p: FleetPaths, e: AuditEntry): void {
  const line = JSON.stringify(e) + '\n'
  if (sys.kind === 'fake') { sys.writeText(p.audit, (sys.readText(p.audit) ?? '') + line, { mode: 0o600 }); return }
  // appendFileSync: the one write that bypasses the adapter on purpose (an audit entry is written in --dry-run too)
  fs.mkdirSync(path.dirname(p.audit), { recursive: true, mode: 0o700 })
  fs.appendFileSync(p.audit, line, { mode: 0o600 })
}

/* ------------------------------------------------------------------ installs */

export function target(ctx: Ctx, org: OrgRecord): Target {
  return ctx.reg.config.listen === 'socket' ? { host: org.host, socket: orgPaths(ctx.paths, org.id).socket } : { host: org.host, port: org.port }
}

/** local test mode: a release folder can name the source tree it stands for (never honoured on a server) */
export function codeRoot(ctx: Ctx, releaseDir: string): string {
  if (ctx.paths.mode === 'local') {
    const marker = ctx.sys.readText(path.join(releaseDir, 'fleet-local-code.txt'))
    if (marker) return marker.trim()
  }
  return releaseDir
}

export function releaseDir(ctx: Ctx, version: string): string {
  return path.join(ctx.paths.releases, version)
}

/** the environment an install's commands run with (what the unit gives the server) */
export function installEnv(ctx: Ctx, org: OrgRecord, extra: Record<string, string> = {}): Record<string, string> {
  const op = orgPaths(ctx.paths, org.id)
  const env: Record<string, string> = { APPBUILDER_ENV_FILE: op.env, HOME: op.dir, ...extra }
  if (ctx.paths.mode === 'local') {
    for (const k of ['PATH', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) if (process.env[k]) env[k] = process.env[k]!
    Object.assign(env, { TEMP: op.tmp, TMP: op.tmp, TMPDIR: op.tmp, USERPROFILE: op.dir, NODE_OPTIONS: '', ABFLEET_LOCAL: '1' })
  }
  return env
}

/**
 * `appbuilder <args>` of a release (default: the install's own `app` link) as the install's OS user. Output is
 * scrubbed of one-time links and keys before anyone sees it, unless `raw` (the caller keeps it to itself).
 */
export async function appCli(ctx: Ctx, org: OrgRecord, args: string[], o: { release?: string; input?: string; mutates?: boolean; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
  const app = o.release ? releaseDir(ctx, o.release) : orgPaths(ctx.paths, org.id).app
  const main = path.join(codeRoot(ctx, app), 'server', 'main.ts')
  return ctx.sys.run(ctx.paths.node, [main, ...args], { user: org.osUser, env: installEnv(ctx, org, o.env), input: o.input, cwd: orgPaths(ctx.paths, org.id).dir, mutates: o.mutates, timeoutMs: o.timeoutMs ?? 300_000 })
}

/** the fleet agent inside an install's context; its last stdout line is JSON */
export async function agent<T>(ctx: Ctx, org: OrgRecord, args: string[], o: { release?: string; input?: string; mutates?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const app = o.release ? releaseDir(ctx, o.release) : orgPaths(ctx.paths, org.id).app
  const r = await ctx.sys.run(ctx.paths.node, [path.join(ctx.paths.tool, 'agent.ts'), ...args], {
    user: org.osUser, env: installEnv(ctx, org, { ABFLEET_APP: app }), input: o.input, cwd: orgPaths(ctx.paths, org.id).dir, mutates: o.mutates, timeoutMs: o.timeoutMs ?? 900_000,
  })
  if (ctx.dry && o.mutates !== false) return {} as T
  const last = r.stdout.trim().split('\n').pop() ?? ''
  let parsed: { ok?: boolean; error?: string } & Record<string, unknown>
  try {
    parsed = JSON.parse(last) as typeof parsed
  } catch {
    throw new FleetError(`agent ${args[0]} (${org.host}) failed: ${scrub((r.stderr || r.stdout).trim().slice(-800), ctx.secrets) || `exit ${r.code}`}`)
  }
  if (r.code !== 0 || parsed.ok === false) throw new FleetError(`agent ${args[0]} (${org.host}): ${scrub(String(parsed.error ?? `exit ${r.code}`), ctx.secrets)}`)
  return parsed as T
}

export async function waitHealth(ctx: Ctx, org: OrgRecord, timeoutMs: number): Promise<Health> {
  if (ctx.dry) return 'ok'
  const until = ctx.sys.now() + timeoutMs
  let last: Health = 'down'
  for (;;) {
    last = await ctx.sys.probe(target(ctx, org), 3000)
    if (last === 'ok') return last
    if (ctx.sys.now() >= until) return last
    await ctx.sys.sleep(500)
  }
}

export const unitOf = (org: OrgRecord) => `appbuilder@${org.id}`

/** read-only state as `appbuilder read-only status` reports it (exit 3 = read-only) */
export async function readOnlyState(ctx: Ctx, org: OrgRecord): Promise<{ readOnly: boolean; text: string }> {
  const r = await appCli(ctx, org, ['read-only', 'status'], { mutates: false, timeoutMs: 60_000 })
  return { readOnly: r.code === 3, text: r.stdout.trim() || r.stderr.trim() }
}

/** a rollback stack: each step registers how to undo itself; undo runs in reverse and reports every failure */
export class Undo {
  private steps: { what: string; fn: () => Promise<void> | void }[] = []
  push(what: string, fn: () => Promise<void> | void): void { this.steps.push({ what, fn }) }
  get size(): number { return this.steps.length }
  async run(say: (l: string) => void): Promise<{ undone: string[]; failed: string[] }> {
    const undone: string[] = []
    const failed: string[] = []
    for (const s of this.steps.reverse()) {
      try {
        await s.fn()
        undone.push(s.what)
        say(`  undone: ${s.what}`)
      } catch (e) {
        failed.push(`${s.what}: ${e instanceof Error ? e.message : String(e)}`)
        say(`  COULD NOT UNDO: ${s.what}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.steps = []
    return { undone, failed }
  }
}

/** a fresh registry when none exists yet (commands other than init refuse) */
export function requireRegistry(ctx: { reg: Registry | null; paths: FleetPaths }): Registry {
  if (!ctx.reg) throw new FleetError(`No fleet here (${ctx.paths.registry} is missing): run abfleet init first.`, 2)
  return ctx.reg
}
