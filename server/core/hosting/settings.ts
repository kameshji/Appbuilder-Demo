/**
 * Server settings for many installs on one machine (hosting phase, package H-A; docs/admin/hosting.md,
 * docs/dev/hosting.md). Every setting is opt-in: with none of these variables set an install behaves exactly as before.
 *
 *   APPBUILDER_ENV_FILE=<file>        per-instance environment file (KEY=value lines), loaded by server/main.ts before
 *                                     anything else, for the server and for every command; values already set win
 *   APPBUILDER_HOSTED=1               the hosted profile: the defaults below switch to the hosted values (each one can
 *                                     still be set on its own), and APPBUILDER_OUTBOUND_PRIVATE is forced to deny
 *   APPBUILDER_SOCKET=<path>          listen on this Unix domain socket instead of APPBUILDER_HOST:PORT
 *   APPBUILDER_SOCKET_MODE=660        its permission bits (octal; default 660: the install user and the proxy's group)
 *   APPBUILDER_PUBLIC_URL=<url>       the locked public address: every generated link starts with it, the Admin
 *                                     console's "Public address" cannot change it; https: also turns on the __Host-
 *                                     cookie prefix
 *   APPBUILDER_SETUP=closed           /api/v1/setup/* answers 404 (first-run setup is done with `migrate` and
 *                                     `admin invite`); default closed when hosted
 *   APPBUILDER_DB_POOL=<n>            system database pool size (default 10; hosted 6)
 *   APPBUILDER_JOBS_POLL_MS=<ms>      job worker polling fallback (default 1000; hosted 5000: DC-18)
 *   APPBUILDER_INSTANCE_DIR=<dir>     the one folder this install may write to: the workspace, logs, backups and the
 *                                     setup-code file must be inside it, or the server refuses to start
 *   APPBUILDER_READ_ONLY=1|<reason>   the install is read-only (reason suspended, payment, maintenance or licence;
 *                                     1 = suspended) with APPBUILDER_READ_ONLY_MESSAGE as an optional note
 *   APPBUILDER_SHUTDOWN_MS=<ms>       how long a stopping server waits for requests and jobs (default 5000; hosted 15000)
 *
 * In one process there is one install, so the settings come from process.env. Tests that run several apps in one
 * process attach their own with configureHosting(services, hostingSettings(env)).
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseEnvFile } from '../update/layout.ts'

export type ReadOnlyReason = 'suspended' | 'payment' | 'maintenance' | 'licence'
export const READ_ONLY_REASONS: readonly ReadOnlyReason[] = ['suspended', 'payment', 'maintenance', 'licence']

/** spec "Connections for 20 installs": pool 6 per hosted install, 10 on-premises */
export const DEFAULT_DB_POOL = 10
export const HOSTED_DB_POOL = 6
/** spec DC-18: 5 s polling in hosted installs (LISTEN/NOTIFY still wakes work at once) */
export const DEFAULT_JOBS_POLL_MS = 1000
export const HOSTED_JOBS_POLL_MS = 5000
/**
 * today's 5 s on-premises (unchanged); hosted 15 s, longer than the job worker's stop grace (10 s,
 * APPBUILDER_JOBS_STOP_GRACE_MS) so unfinished jobs are released for the next start instead of waiting for the reaper
 */
export const DEFAULT_SHUTDOWN_MS = 5000
export const HOSTED_SHUTDOWN_MS = 15_000

export interface HostingSettings {
  hosted: boolean
  socket: string | null
  socketMode: number
  /** origin (and path, without a trailing slash), e.g. https://acme.apps.example.com; null when not locked */
  publicUrl: string | null
  /** __Host- cookie names: the locked public URL is https */
  hostCookies: boolean
  setupClosed: boolean
  dbPool: number
  jobsPollMs: number
  instanceDir: string | null
  readOnly: { reason: ReadOnlyReason; message: string } | null
  shutdownMs: number
  /** configuration mistakes (the server refuses to start with any; `hosting-check` prints them) */
  problems: string[]
}

const on = (v: string | undefined): boolean => v === '1' || v === 'true' || v === 'yes'

/** "https://Acme.example.com/" -> "https://acme.example.com"; null when empty; throws on anything but http(s) */
export function normalisePublicUrl(raw: string | undefined): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error(`APPBUILDER_PUBLIC_URL "${s}" is not a web address such as https://acme.apps.example.com.`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('APPBUILDER_PUBLIC_URL must start with https:// (or http:// on a private network).')
  if (u.username || u.password || u.search || u.hash) throw new Error('APPBUILDER_PUBLIC_URL must not contain a user name, password, query or fragment.')
  return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''))
}

function positiveInt(v: string | undefined, min: number, max: number, name: string, problems: string[]): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number between ${min} and ${max} (it is "${v}").`)
    return undefined
  }
  return n
}

export function hostingSettings(env: NodeJS.ProcessEnv = process.env): HostingSettings {
  const problems: string[] = []
  const hosted = on(env.APPBUILDER_HOSTED)
  let publicUrl: string | null = null
  try {
    publicUrl = normalisePublicUrl(env.APPBUILDER_PUBLIC_URL)
  } catch (e) {
    problems.push((e as Error).message)
  }
  if (hosted && !publicUrl) problems.push('A hosted install needs APPBUILDER_PUBLIC_URL (its https:// address).')
  const socket = env.APPBUILDER_SOCKET?.trim() || null
  if (socket && !path.isAbsolute(socket) && !socket.startsWith('\\\\')) problems.push('APPBUILDER_SOCKET must be an absolute path.')
  let socketMode = 0o660
  if (env.APPBUILDER_SOCKET_MODE) {
    const m = /^[0-7]{3}$/.test(env.APPBUILDER_SOCKET_MODE) ? parseInt(env.APPBUILDER_SOCKET_MODE, 8) : NaN
    if (Number.isNaN(m) || (m & 0o007) !== 0) problems.push('APPBUILDER_SOCKET_MODE is three octal digits without rights for others, for example 660.')
    else socketMode = m
  }
  const setup = (env.APPBUILDER_SETUP ?? '').trim().toLowerCase()
  if (setup && setup !== 'closed' && setup !== 'open') problems.push('APPBUILDER_SETUP is "closed" or "open".')
  const setupClosed = setup === 'closed' || (hosted && setup !== 'open')
  const dbPool = positiveInt(env.APPBUILDER_DB_POOL, 2, 100, 'APPBUILDER_DB_POOL', problems) ?? (hosted ? HOSTED_DB_POOL : DEFAULT_DB_POOL)
  // read exactly as jobs.ts reads it (an unusable value is ignored there, so it is not a start-up problem here)
  const poll = Number(env.APPBUILDER_JOBS_POLL_MS)
  const jobsPollMs = env.APPBUILDER_JOBS_POLL_MS && Number.isFinite(poll) && poll >= 20 ? poll : hosted ? HOSTED_JOBS_POLL_MS : DEFAULT_JOBS_POLL_MS
  const shutdownMs = positiveInt(env.APPBUILDER_SHUTDOWN_MS, 1000, 600_000, 'APPBUILDER_SHUTDOWN_MS', problems) ?? (hosted ? HOSTED_SHUTDOWN_MS : DEFAULT_SHUTDOWN_MS)
  const instanceDir = env.APPBUILDER_INSTANCE_DIR?.trim() ? path.resolve(env.APPBUILDER_INSTANCE_DIR.trim()) : null
  let readOnly: HostingSettings['readOnly'] = null
  const ro = (env.APPBUILDER_READ_ONLY ?? '').trim().toLowerCase()
  if (ro && ro !== '0' && ro !== 'false' && ro !== 'off') {
    const reason = ro === '1' || ro === 'true' || ro === 'on' ? 'suspended' : (READ_ONLY_REASONS as readonly string[]).includes(ro) ? (ro as ReadOnlyReason) : null
    if (!reason) problems.push(`APPBUILDER_READ_ONLY is 1 or one of ${READ_ONLY_REASONS.join(', ')} (it is "${ro}").`)
    else readOnly = { reason, message: String(env.APPBUILDER_READ_ONLY_MESSAGE ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300) }
  }
  if (hosted && env.APPBUILDER_OUTBOUND_PRIVATE && env.APPBUILDER_OUTBOUND_PRIVATE !== 'deny') {
    problems.push('A hosted install always runs with APPBUILDER_OUTBOUND_PRIVATE=deny; remove the other value.')
  }
  return {
    hosted, socket, socketMode, publicUrl, hostCookies: !!publicUrl && publicUrl.startsWith('https://'),
    setupClosed, dbPool, jobsPollMs, instanceDir, readOnly, shutdownMs, problems,
  }
}

/** child inside parent (or equal), on resolved paths */
export function isInside(child: string, parent: string): boolean {
  const r = path.relative(path.resolve(parent), path.resolve(child))
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

/**
 * "nothing in a hosted install writes outside its own folder": with APPBUILDER_INSTANCE_DIR set, every folder the server
 * writes to by configuration must be inside it. (Administrators' own folder settings, such as a backup folder typed in
 * the Admin console, are checked where they are saved; see docs/dev/hosting.md.)
 */
export function writePathProblems(s: HostingSettings, paths: { workspaceDir: string; env?: NodeJS.ProcessEnv }): string[] {
  if (!s.instanceDir) return []
  const env = paths.env ?? process.env
  const out: string[] = []
  const check = (what: string, p: string | undefined | null) => {
    if (p && !isInside(p, s.instanceDir!)) out.push(`${what} (${path.resolve(p)}) is outside APPBUILDER_INSTANCE_DIR (${s.instanceDir}).`)
  }
  check('The workspace', paths.workspaceDir)
  check('APPBUILDER_LOG_DIR', env.APPBUILDER_LOG_DIR)
  check('APPBUILDER_BACKUP_DIR', env.APPBUILDER_BACKUP_DIR)
  check('APPBUILDER_SETUP_CODE_FILE', env.APPBUILDER_SETUP_CODE_FILE)
  return out
}

/**
 * The per-instance environment file (APPBUILDER_ENV_FILE): loaded into env before anything reads it; values already
 * set win (as the installers' loadInstallEnv). Returns the file read, or null.
 */
export function loadInstanceEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.APPBUILDER_ENV_FILE?.trim()
  if (!file) return null
  const text = fs.readFileSync(file, 'utf8')
  for (const [k, v] of Object.entries(parseEnvFile(text))) if (env[k] === undefined) env[k] = v
  return file
}

/**
 * The hosted profile's effect on settings other modules read from the environment themselves (jobs.ts polling,
 * net-policy.ts and actions/outbound.ts, config.ts cookies and host names). Only with APPBUILDER_HOSTED=1 or a locked
 * public URL; on-premises installs are untouched.
 */
export function applyHostingDefaults(env: NodeJS.ProcessEnv = process.env): string[] {
  const s = hostingSettings(env)
  const notes: string[] = []
  if (s.hosted) {
    // another explicit value is a problem (hostingSettings): the server refuses to start rather than guess
    if (env.APPBUILDER_OUTBOUND_PRIVATE === undefined || env.APPBUILDER_OUTBOUND_PRIVATE === '') {
      env.APPBUILDER_OUTBOUND_PRIVATE = 'deny'
      notes.push('APPBUILDER_OUTBOUND_PRIVATE=deny (hosted)')
    }
    if (env.APPBUILDER_JOBS_POLL_MS === undefined) env.APPBUILDER_JOBS_POLL_MS = String(HOSTED_JOBS_POLL_MS)
    if (env.APPBUILDER_TRUST_PROXY === undefined) env.APPBUILDER_TRUST_PROXY = '1'
    // a connector, database connection or flow aimed at this install's own public address would hairpin through the
    // proxy: refused (spec threat model row 3)
    if (s.publicUrl) {
      const own = new URL(s.publicUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
      const deny = (env.APPBUILDER_OUTBOUND_DENY ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
      if (!deny.includes(own)) env.APPBUILDER_OUTBOUND_DENY = [...deny, own].join(',')
    }
  }
  if (s.publicUrl) {
    const host = new URL(s.publicUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const list = (env.APPBUILDER_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
    if (!list.includes(host)) env.APPBUILDER_ALLOWED_HOSTS = [...list, host].join(',')
    if (s.hostCookies && env.APPBUILDER_SECURE_COOKIE === undefined) env.APPBUILDER_SECURE_COOKIE = '1'
  }
  return notes
}

/* ------------------------------------------------------------------ per services (tests run several apps) */

const attached = new WeakMap<object, HostingSettings>()
let fromProcess: { key: string; value: HostingSettings } | null = null

const ENV_KEYS = ['APPBUILDER_HOSTED', 'APPBUILDER_SOCKET', 'APPBUILDER_SOCKET_MODE', 'APPBUILDER_PUBLIC_URL', 'APPBUILDER_SETUP', 'APPBUILDER_DB_POOL',
  'APPBUILDER_JOBS_POLL_MS', 'APPBUILDER_INSTANCE_DIR', 'APPBUILDER_READ_ONLY', 'APPBUILDER_READ_ONLY_MESSAGE', 'APPBUILDER_SHUTDOWN_MS', 'APPBUILDER_OUTBOUND_PRIVATE']

/** the settings of the install these services belong to: attached ones, else process.env (re-read when it changes) */
export function hostingFor(services: object | null | undefined): HostingSettings {
  const a = services ? attached.get(services) : undefined
  if (a) return a
  const key = ENV_KEYS.map((k) => process.env[k] ?? '').join('\u0000')
  if (!fromProcess || fromProcess.key !== key) fromProcess = { key, value: hostingSettings(process.env) }
  return fromProcess.value
}

/** tests (and createApp callers with their own env): attach settings to one app's services */
export function configureHosting(services: object, s: HostingSettings): void {
  attached.set(services, s)
}

/** the locked public address of this install, or null (identity/mail.ts brand(): every generated link) */
export function lockedPublicUrl(services: object | null | undefined): string | null {
  return hostingFor(services).publicUrl
}
