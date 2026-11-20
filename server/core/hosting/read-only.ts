/**
 * The read-only state of an install (hosting phase, package H-C; docs/dev/hosting.md, docs/admin/hosting.md).
 *
 * ONE state with a reason, shared by every cause: the operator suspended the install (`abfleet suspend`, or
 * APPBUILDER_READ_ONLY in its environment), it is unpaid, it is in maintenance, or (package H-G) its licence could not be
 * verified for longer than the grace period. Set and cleared by the server command `read-only on|off` (stored in
 * ab.settings `hosting.readOnly`, picked up by a running server within READ_ONLY_REFRESH_MS), by the environment, or
 * by the licence client (gate.setLicence).
 *
 * Enforced in two places only:
 *   - the router (router.ts): every route is classified by READ_ONLY_ALLOWED (non-GET routes that stay usable) and
 *     READ_ONLY_REFUSED_GETS (GET routes that write); every other non-GET route is refused with 503 and the code
 *     `install_read_only` (`licence_read_only` for the licence reason), so a route added later is refused until it is
 *     classified. 503 on purpose: a phone's offline outbox keeps a 5xx item "waiting" and retries it (docs/dev/phone.md),
 *     where a 4xx would mark it rejected.
 *   - the job runner (jobs.ts): while read-only it claims only the job types in JOB_READ_ONLY with 'run', does not
 *     run the scheduler for the other types (their slots are then handled by each schedule's misfire policy on
 *     resume, as after downtime), and does not dispatch the outbox (table events and flows wait). Nothing is dropped:
 *     queued jobs and outbox rows stay and run when the install is writable again.
 */
import os from 'node:os'
import type { ServerResponse } from 'node:http'
import { HttpError } from '../contracts.ts'
import type { ApiErrorCode, SqlDb } from '../contracts.ts'
import { READ_ONLY_REASONS, hostingFor, type ReadOnlyReason } from './settings.ts'
import { errText, log } from '../util.ts'

export const READ_ONLY_KEY = 'hosting.readOnly'
export const READ_ONLY_REFRESH_MS = 5000
export const READ_ONLY_STATUS = 503
export const READ_ONLY_CODE = 'install_read_only'
export const LICENCE_READ_ONLY_CODE = 'licence_read_only'

export interface ReadOnlyState {
  reason: ReadOnlyReason
  /** an optional note from whoever set it (one line) */
  message: string
  since: string
  /** who set it: the environment, the server command, the licence client */
  source: 'env' | 'cli' | 'licence'
}

/** what every refused write says, by reason (the banner shows the same words) */
export const READ_ONLY_TEXT: Record<ReadOnlyReason, string> = {
  suspended: 'This Appbuilder is read-only: it was suspended by its operator.',
  payment: 'This Appbuilder is read-only: the subscription is unpaid.',
  maintenance: 'This Appbuilder is read-only for maintenance.',
  licence: 'This Appbuilder is read-only: its licence could not be verified for more than 3 days.',
}
export const STILL_WORKS = 'You can still sign in, open apps, read data and export it (data export, backups, CSV).'

export function readOnlyMessage(s: ReadOnlyState): string {
  return `${READ_ONLY_TEXT[s.reason]}${s.message ? ` ${s.message}` : ''} ${STILL_WORKS}`
}

export function readOnlyError(s: ReadOnlyState): HttpError {
  const code = (s.reason === 'licence' ? LICENCE_READ_ONLY_CODE : READ_ONLY_CODE) as ApiErrorCode
  return new HttpError(READ_ONLY_STATUS, code, readOnlyMessage(s), undefined, { readOnly: { reason: s.reason, since: s.since } })
}

/* ------------------------------------------------------------------ route classification */

/**
 * Non-GET routes that keep working while read-only (pattern as registered, without /api/v1). Everything else that is
 * not a GET is refused. Groups: signing in and out (and what a person needs to get in: second step, invitation,
 * reset, a forced password change, the CSRF-free reads done with POST); reads that use POST for their query; exports
 * and backups ("export always works"); what an administrator needs to see and leave the state.
 */
export const READ_ONLY_ALLOWED: ReadonlySet<string> = new Set([
  // sign-in and sign-out, and what a person needs to get in: the second step (and setting it up when the policy
  // requires it), a recent sign-in for exports, an invitation, a forgotten or forced password, the environment to read in
  'POST /auth/login', 'POST /auth/login/verify', 'POST /auth/login/email-code', 'POST /auth/logout', 'POST /auth/reauth',
  'POST /auth/invitation/check', 'POST /auth/invitation/accept',
  'POST /auth/password/forgot', 'POST /auth/password/reset', 'POST /auth/password/reset/check', 'POST /auth/password',
  'POST /auth/mfa/totp/start', 'POST /auth/mfa/totp/confirm', 'POST /auth/mfa/email/start', 'POST /auth/mfa/email/confirm', 'POST /auth/mfa/recovery-codes',
  'POST /environments/:id/select',
  // signing out elsewhere (own sessions; an administrator ending someone's sessions) and wiping a lost device
  'DELETE /auth/sessions/:id', 'POST /auth/sessions/revoke-others', 'DELETE /users/:id/sessions', 'DELETE /users/:id/sessions/:sid', 'POST /offline/wipe',
  // account recovery by an install administrator (a one-time reset code; removing a lost second step)
  'POST /users/:id/reset-code', 'POST /users/:id/mfa/reset',
  // reads sent as POST: a query plan, dashboard tiles (also a kiosk's), attachment details, a report preview, an
  // approval link before answering it, a chat record card, the device's offline key
  'POST /query', 'POST /dashboards/query', 'POST /dashboards/kiosk/query', 'POST /attachments/resolve', 'POST /reports/preview',
  'POST /approvals/links/inspect', 'POST /chat/cards/resolve', 'POST /offline/key',
  // export always works: the data export (ZIP of CSVs), backups (make one now, download, verify, look inside), a chat
  // conversation's export; CSV downloads are GET routes
  'POST /admin/export-data/ticket', 'POST /backups', 'POST /backups/:id/download-ticket', 'POST /backups/:id/verify',
  'POST /backups/:id/browse', 'POST /backups/:id/contents', 'POST /chat/admin/channels/:id/export',
  // consent: one-click unsubscribe links in emails keep working
  'POST /notifications/unsubscribe', 'POST /dashboards/snapshots/unsubscribe',
  // support: the diagnostics bundle
  'POST /admin/diagnostics',
])

/** GET routes that write business data or start work (none today; a later one is added here and refused) */
export const READ_ONLY_REFUSED_GETS: ReadonlySet<string> = new Set([])

/** null: allowed while read-only; otherwise the route key that is refused */
export function readOnlyRefuses(method: string, key: string): boolean {
  const m = method === 'HEAD' ? 'GET' : method
  if (m === 'GET') return READ_ONLY_REFUSED_GETS.has(key)
  return !READ_ONLY_ALLOWED.has(key)
}

/* ------------------------------------------------------------------ job classification */

/**
 * Every registered job type and what it does while read-only. 'run': keeps running (sign-in mail, backups, the
 * install's own housekeeping that writes no business data, notifications about the state); 'pause': is not claimed
 * (queued jobs wait, their schedules are not run). A job type that is not listed pauses (a test lists every
 * registered type and fails until a new one is classified).
 */
const P = (why: string) => ({ mode: 'pause' as const, why })
const R = (why: string) => ({ mode: 'run' as const, why })
export const JOB_READ_ONLY: Readonly<Record<string, { mode: 'run' | 'pause'; why: string }>> = {
  // run: sign-in email, backups (export always works), health
  'mail.send': R('sign-in emails (reset links, second-step codes, invitations) must keep arriving; emails queued before the state are sent too (nothing is written)'),
  'backup.run': R('export always works: scheduled and manual backups go on (with their off-site copy and retention)'),
  'backup.restore-test': R('the weekly restore test checks backups in temporary schemas it drops again; no business data changes'),
  'backup.health': R('backup retention and the "backups out of date" warning'),
  'ops.health_watch': R('health alerts to install administrators'),
  'ops.health_daily': R('the daily health summary'),
  'ops.heartbeat': R('the uptime monitor ping (nothing is written)'),
  // pause: everything that writes data, sends on behalf of apps or deletes by retention
  'table-event.after': P('table events write data; they run when writable again'),
  'rollup.recompute': P('writes rollup columns'),
  'rollup.reconcile': P('writes rollup columns'),
  'formula.backfill': P('writes formula columns'),
  'index.sync': P('changes the database structure'),
  'attachments.delete-files': P('deletes files of changes made before the state; done on resume'),
  'attachments.sweep': P('deletes files'),
  'outbox.retention': P('retention sweep (deletes rows); catches up on resume'),
  'audit.retention': P('retention sweep of the audit log'),
  'identity.signin-log.retention': P('retention sweep of the sign-in log'),
  'identity.mail-log.retention': P('retention sweep of the email log'),
  'collab.notify': P('notifications of comments, mentions and task assignments (they write notifications)'),
  'notes.notify': P('notifications of shared notes and mentions in them (they write notifications)'),
  'collab.orphan-sweep': P('deletes collaboration rows'),
  'tasks.reminders': P('task reminders: sent (once each) when writable again'),
  'tasks.digest': P('the daily task digest: the next one after resume'),
  'data.recycle-purge': P('deletes rows for good'),
  'flow.advance': P('flow steps write data and call connectors; runs continue on resume'),
  'flow.resume': P('resumes waiting flow steps on resume'),
  'flow.timeout': P('ends overdue flow runs on resume'),
  'flow.schedule': P('scheduled flows: missed slots follow each schedule\'s misfire policy on resume'),
  'flow.retention': P('retention sweep of flow runs'),
  'flow.digest': P('the flow failure summary'),
  'model.summary.refresh': P('writes summary tables'),
  'actions.retention': P('retention sweep of connector activity'),
  'notifications.digest': P('notification digests and emails held back by quiet hours: sent on resume'),
  'notifications.delivery-retention': P('retention sweep of the delivery log'),
  'whatsapp.notify': P('WhatsApp sends: queued, sent on resume (each is checked again at sending time)'),
  'whatsapp.retention': P('retention sweep of the WhatsApp log'),
  'report.run': P('scheduled report emails: missed slots follow the misfire policy on resume'),
  'approval.notify': P('approval request notifications and reminders: sent on resume'),
  'approval.decided': P('after-decision notifications and approvalDecided flows: on resume'),
  'approval.retention': P('retention sweep of decided approvals'),
  'print.bulk': P('generates documents (writes files)'),
  'print.sweep': P('deletes generated documents'),
  'dashboard.snapshot': P('dashboard snapshot emails: missed slots follow the misfire policy on resume'),
  'chat.retention': P('retention sweep of chat messages'),
}

export function jobRunsWhenReadOnly(type: string): boolean {
  return JOB_READ_ONLY[type]?.mode === 'run'
}

/* ------------------------------------------------------------------ the gate */

export interface ReadOnlyGate {
  /** the current state (cached for READ_ONLY_REFRESH_MS; null = writable) */
  state(): Promise<ReadOnlyState | null>
  /** the last known state without waiting (job runner; refreshes in the background when old) */
  peek(): ReadOnlyState | null
  /** throws the read-only error for a route that is refused while read-only */
  check(method: string, key: string, res?: ServerResponse): Promise<void>
  /** the licence client (H-G): its own reason; null clears it */
  setLicence(s: { message?: string; since?: string } | null): void
  /** forget the cache (after the server command changed the setting in this process, tests) */
  invalidate(): void
}

interface GateDeps {
  db(): SqlDb | null
  env?: () => ReadOnlyState | null
  now?: () => number
}

export function parseStoredState(v: string | null | undefined): ReadOnlyState | null {
  if (!v) return null
  try {
    const o = JSON.parse(v) as Partial<ReadOnlyState>
    if (!o || !(READ_ONLY_REASONS as readonly string[]).includes(String(o.reason))) return null
    return { reason: o.reason as ReadOnlyReason, message: String(o.message ?? '').slice(0, 300), since: String(o.since ?? ''), source: 'cli' }
  } catch {
    return null
  }
}

export function createReadOnlyGate(deps: GateDeps): ReadOnlyGate {
  const now = deps.now ?? Date.now
  let stored: ReadOnlyState | null = null
  let readAt = 0
  let inflight: Promise<void> | null = null
  let licence: ReadOnlyState | null = null
  let warned = false

  async function refresh(): Promise<void> {
    const db = deps.db()
    if (!db) {
      readAt = now()
      return
    }
    try {
      const rows = await db.query<{ v: string | null }>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [READ_ONLY_KEY])
      stored = parseStoredState(rows[0]?.v)
      warned = false
    } catch (e) {
      // keep the last known state (an unreachable database refuses writes by itself)
      if (!warned) log('warn', `read-only state could not be read: ${errText(e)}`)
      warned = true
    }
    readAt = now()
  }
  const kick = (): Promise<void> => {
    if (!inflight) inflight = refresh().finally(() => { inflight = null })
    return inflight
  }
  const combine = (): ReadOnlyState | null => deps.env?.() ?? stored ?? licence

  return {
    async state() {
      if (now() - readAt >= READ_ONLY_REFRESH_MS) await kick()
      return combine()
    },
    peek() {
      if (now() - readAt >= READ_ONLY_REFRESH_MS) void kick()
      return combine()
    },
    async check(method, key, res) {
      if (!readOnlyRefuses(method, key)) return
      const s = await this.state()
      if (!s) return
      res?.setHeader('Retry-After', '300')
      throw readOnlyError(s)
    },
    setLicence(s) {
      licence = s ? { reason: 'licence', message: String(s.message ?? '').slice(0, 300), since: s.since ?? new Date(now()).toISOString(), source: 'licence' } : null
    },
    invalidate() {
      readAt = 0
    },
  }
}

const gates = new WeakMap<object, ReadOnlyGate>()

/** the gate of these services (one per install; created on first use) */
export function readOnlyGateFor(services: { state?: { db: SqlDb | null } } & object): ReadOnlyGate {
  let g = gates.get(services)
  if (!g) {
    const since = new Date().toISOString()
    g = createReadOnlyGate({
      db: () => services.state?.db ?? null,
      env: () => {
        const r = hostingFor(services).readOnly
        return r ? { reason: r.reason, message: r.message, since, source: 'env' } : null
      },
    })
    gates.set(services, g)
  }
  return g
}

/* ------------------------------------------------------------------ the setting (server command) */

const osUser = (): string => {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USER || process.env.USERNAME || 'unknown'
  }
}

/** `read-only on`: stores the state and writes the install audit (source cli); the running server sees it within 5 s */
export async function setStoredReadOnly(db: SqlDb, s: { reason: ReadOnlyReason; message?: string } | null): Promise<ReadOnlyState | null> {
  const prev = parseStoredState((await db.query<{ v: string | null }>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [READ_ONLY_KEY]))[0]?.v)
  const next: ReadOnlyState | null = s ? { reason: s.reason, message: String(s.message ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300), since: prev?.reason === s.reason ? prev.since : new Date().toISOString(), source: 'cli' } : null
  await db.tx(async (tx) => {
    if (next) await tx.exec(`INSERT INTO "ab"."settings" (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [READ_ONLY_KEY, JSON.stringify({ reason: next.reason, message: next.message, since: next.since })])
    else await tx.exec(`DELETE FROM "ab"."settings" WHERE k = $1`, [READ_ONLY_KEY])
    await tx.exec(`INSERT INTO "ab"."audit" (at, user_id, action, environment_id, details) VALUES ($1, NULL, $2, NULL, $3::jsonb)`, [
      new Date(), next ? 'install.read_only_on' : 'install.read_only_off',
      JSON.stringify({ ...(next ? { reason: next.reason, message: next.message } : { was: prev?.reason ?? null }), source: 'cli', osUser: osUser(), host: os.hostname() }),
    ])
  })
  return next
}

export async function storedReadOnly(db: SqlDb): Promise<ReadOnlyState | null> {
  return parseStoredState((await db.query<{ v: string | null }>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [READ_ONLY_KEY]))[0]?.v)
}
