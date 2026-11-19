/**
 * services.actions: the connector actions framework (P1 package D; docs/dev/connectors.md "Connector actions").
 *
 * run(env, connection, action, inputs, identity, opts) does, in order:
 *   1. finds the connection (in `env`) and its action (built in to the kind, or a custom action of the connection);
 *   2. validates the inputs against the action's JSON Schema (defaults filled) and the input size cap;
 *   3. protection per connection: circuit breaker (open after 5 failures in a row, 30 s doubling to 5 min, one trial
 *      call when half-open), rate limit (calls per minute) and concurrency cap (calls in flight; a call waits for a slot
 *      for at most 5 s);
 *   4. idempotency: for actions that are not idempotent and have an external side effect, a key (required from flows)
 *      is claimed in ab_action_idempotency; a finished key returns the stored result (`replayed`), a running one answers
 *      `in_progress` (retryable) unless it is older than twice the time limit (the earlier attempt died: taken over);
 *   5. calls the provider with a deadline; the output is capped (1 MB of JSON) and every secret value of the connection is
 *      replaced by "[hidden]" in the output and in error messages;
 *   6. records the call in ab_action_runs (who, what, when, outcome, duration, HTTP status; never inputs, outputs or
 *      secrets) and updates the breaker.
 *
 * `run` does not check the identity's "use" right: a flow or event can only reference a connection that a maker with
 * "use" attached (assertCanUse when it is saved). The routes (actions/routes.ts) check "use" for the Test action form.
 */
import { createHash } from 'node:crypto'
import { HttpError } from '../contracts.ts'
import type { ConnectionRecord, SqlDb, UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import type { ActionConnectionState, ActionDef, ActionError, ActionKindInfo, ActionResult, ActionRunOptions, ActionsService } from './contracts.ts'
import { validate, problemText } from './schema.ts'
import { OutboundError } from './outbound.ts'
import { currentEnvironment, runInEnvironment } from '../env-context.ts'
import { errText, rowUid } from '../util.ts'
import { BUILTIN_SCHEDULES } from '../kernel.ts'
import { JobError } from '../jobs.ts'

export const ACTIONS_RETENTION_JOB = 'actions.retention'
export const MAX_OUTPUT_BYTES = 1024 * 1024
export const DEFAULT_INPUT_BYTES = 1024 * 1024
export const IDEMPOTENCY_HOURS = 24
const FAILURES_TO_OPEN = 5
const OPEN_BASE_MS = 30_000
const OPEN_MAX_MS = 5 * 60_000
const SLOT_WAIT_MS = 5_000

/** what a provider gets for one call */
export interface ProviderCall {
  env: string
  connection: ConnectionRecord
  action: ActionDef & { http?: unknown }
  inputs: Record<string, unknown>
  identity: UserContext | null
  timeoutMs: number
  signal: AbortSignal
  services: CoreServices
  /** per connection, kept across calls (DNS pins, OAuth tokens); dropped when settings or secret change */
  cache: Map<string, unknown>
  /** details for the activity log (no secrets, no payloads): method, host, path, recipients ... */
  note(details: Record<string, unknown>): void
  runId: string
  idempotencyKey?: string
}

export interface ActionProvider {
  kind: string
  label: string
  description: string
  tables: boolean
  builtin(): ActionDef[]
  /** settings and secret problems (create / edit); empty = fine */
  checkSettings(settings: Record<string, string>, secret: string | undefined): string[]
  /** connection test (the Test button) */
  test(c: { connection: ConnectionRecord; services: CoreServices; cache: Map<string, unknown>; env: string }): Promise<{ ok: boolean; message: string }>
  invoke(call: ProviderCall): Promise<unknown>
  /** secret values of the connection (redacted from outputs, errors and logs) */
  secrets(c: ConnectionRecord): string[]
  limits(c: ConnectionRecord): { perMinute: number; maxConcurrent: number; maxTimeoutMs: number; maxInputBytes?: number }
}

interface RuntimeState {
  fp: string
  cache: Map<string, unknown>
  tokens: number
  refilledAt: number
  inFlight: number
  waiters: (() => void)[]
  failures: number
  openUntil: number
  opens: number
  halfOpenTrial: boolean
  lastError: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const q = (id: string) => `"${id}"`
const T = (t: string) => `${q(currentEnvironment().schema)}.${q(t)}`
const ACTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** replaces every secret value (and its URL-encoded and base64 forms) in strings, deep */
export function redactDeep<T>(value: T, secrets: string[]): T {
  const list = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4).flatMap((s) => [s, encodeURIComponent(s), Buffer.from(s).toString('base64')]))].sort((a, b) => b.length - a.length)
  if (!list.length) return value
  const fix = (s: string): string => {
    let out = s
    for (const x of list) if (out.includes(x)) out = out.split(x).join('[hidden]')
    return out
  }
  const walk = (v: unknown, d: number): unknown => {
    if (typeof v === 'string') return fix(v)
    if (d > 40) return v
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1))
    if (isObj(v)) {
      const o: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) o[fix(k)] = walk(x, d + 1)
      return o
    }
    return v
  }
  return walk(value, 0) as T
}

const RETRYABLE_UPSTREAM = (status?: number) => status === 429 || status === 408 || (status !== undefined && status >= 500)

export function toActionError(e: unknown): ActionError {
  if (e instanceof OutboundError) return { code: e.code, message: e.message, retryable: e.retryable, ...(e.status !== undefined ? { status: e.status } : {}) }
  if (e instanceof HttpError) {
    const code = e.status === 404 ? 'not_found' : e.status === 403 ? 'denied' : e.status === 422 || e.status === 400 ? 'invalid_input' : e.status === 409 ? 'not_configured' : e.status === 429 ? 'rate_limited' : e.status === 503 ? 'unavailable' : 'internal'
    return { code, message: e.message, retryable: e.status === 429 || e.status === 503 }
  }
  if (e instanceof JobError) return { code: 'internal', message: e.message, retryable: e.retry !== false }
  return { code: 'internal', message: 'The action failed unexpectedly.', retryable: true }
}

export interface CustomActionRecord {
  id: string
  connectionId: string
  def: ActionDef & { http: unknown }
  createdBy: string | null
  createdOn: string
  modifiedOn: string
}

export type ActionsServiceImpl = ActionsService & {
  register(p: ActionProvider): void
  provider(kind: string): ActionProvider | undefined
  custom: {
    list(connectionId: string): Promise<CustomActionRecord[]>
    get(connectionId: string, actionId: string): Promise<CustomActionRecord | null>
    put(connectionId: string, def: ActionDef & { http: unknown }, by: string | null): Promise<CustomActionRecord>
    remove(connectionId: string, actionId: string): Promise<boolean>
    removeAll(connectionId: string): Promise<void>
  }
  access: {
    list(connectionId: string): Promise<{ principalKind: 'role' | 'user'; principalId: string; level: 'use' | 'manage'; grantedBy: string | null; grantedOn: string }[]>
    set(connectionId: string, grants: { principalKind: 'role' | 'user'; principalId: string; level: 'use' | 'manage' }[], by: string | null): Promise<void>
  }
  activity(connectionId: string, o: { limit: number; before?: string; userId?: string }): Promise<Record<string, unknown>[]>
  resetCircuit(env: string, connectionId: string): void
  /** the connection was edited or deleted: drop pins, tokens and the breaker state */
  forget(env: string, connectionId: string): void
  test(env: string, connectionId: string): Promise<{ ok: boolean; message: string }>
  /** tests: the per-connection cache (DNS pins, OAuth token) */
  cacheOf(env: string, connectionId: string): Map<string, unknown>
}

export function createActionsService(services: CoreServices): ActionsServiceImpl {
  const providers = new Map<string, ActionProvider>()
  const states = new Map<string, RuntimeState>()

  const db = (): SqlDb => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  const fingerprint = (c: ConnectionRecord) => createHash('sha256').update(JSON.stringify([c.connector, c.settings ?? {}, c.secret ?? null])).digest('hex')

  function stateOf(env: string, c: ConnectionRecord): RuntimeState {
    const key = `${env}:${c.id}`
    const fp = fingerprint(c)
    let s = states.get(key)
    if (!s || s.fp !== fp) {
      const lim = providers.get(c.connector)?.limits(c)
      s = { fp, cache: new Map(), tokens: lim?.perMinute ?? 60, refilledAt: Date.now(), inFlight: 0, waiters: [], failures: s?.failures ?? 0, openUntil: s?.openUntil ?? 0, opens: s?.opens ?? 0, halfOpenTrial: false, lastError: s?.lastError ?? null }
      states.set(key, s)
    }
    return s
  }

  async function connection(connectionId: string): Promise<ConnectionRecord> {
    const rec = await services.meta.connections.get(connectionId)
    if (!rec) throw new HttpError(404, 'not-found', `Connection "${connectionId}" does not exist.`)
    return rec
  }

  /* ---------------------------------------------------------------- custom actions */

  const toCustom = (r: Record<string, unknown>): CustomActionRecord => ({
    id: String(r.id), connectionId: String(r.connection_id), def: r.def as CustomActionRecord['def'], createdBy: r.created_by ? String(r.created_by) : null,
    createdOn: new Date(r.created_on as string).toISOString(), modifiedOn: new Date(r.modified_on as string).toISOString(),
  })
  const custom: ActionsServiceImpl['custom'] = {
    async list(connectionId) {
      return (await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_custom_actions')} WHERE connection_id = $1 ORDER BY lower(action_id)`, [connectionId])).map(toCustom)
    },
    async get(connectionId, actionId) {
      const r = await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_custom_actions')} WHERE connection_id = $1 AND lower(action_id) = lower($2)`, [connectionId, actionId])
      return r[0] ? toCustom(r[0]) : null
    },
    async put(connectionId, def, by) {
      if (!ACTION_ID.test(def.id)) throw new HttpError(422, 'invalid', 'An action id starts with a letter and has letters, digits, _ and - only (at most 64).', 'id')
      const now = new Date()
      const existing = await custom.get(connectionId, def.id)
      const stored = { ...def, origin: 'custom' as const }
      if (existing) {
        await db().exec(`UPDATE ${T('ab_custom_actions')} SET def = $2::jsonb, action_id = $3, modified_on = $4 WHERE id = $1`, [existing.id, JSON.stringify(stored), def.id, now])
      } else {
        await db().exec(`INSERT INTO ${T('ab_custom_actions')} (id, connection_id, action_id, def, created_by, created_on, modified_on) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)`, [`act_${rowUid().replace(/-/g, '').slice(-16)}`, connectionId, def.id, JSON.stringify(stored), by, now])
      }
      return (await custom.get(connectionId, def.id))!
    },
    async remove(connectionId, actionId) {
      const r = await db().exec(`DELETE FROM ${T('ab_custom_actions')} WHERE connection_id = $1 AND lower(action_id) = lower($2)`, [connectionId, actionId])
      return r.affectedRows > 0
    },
    async removeAll(connectionId) {
      await db().exec(`DELETE FROM ${T('ab_custom_actions')} WHERE connection_id = $1`, [connectionId])
      await db().exec(`DELETE FROM ${T('ab_connection_access')} WHERE connection_id = $1`, [connectionId])
    },
  }

  /* ---------------------------------------------------------------- access */

  const access: ActionsServiceImpl['access'] = {
    async list(connectionId) {
      const rows = await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_connection_access')} WHERE connection_id = $1 ORDER BY principal_kind, principal_id`, [connectionId])
      return rows.map((r) => ({ principalKind: r.principal_kind as 'role' | 'user', principalId: String(r.principal_id), level: r.level as 'use' | 'manage', grantedBy: r.granted_by ? String(r.granted_by) : null, grantedOn: new Date(r.granted_on as string).toISOString() }))
    },
    async set(connectionId, grants, by) {
      const now = new Date()
      await db().tx(async (tx) => {
        await tx.exec(`DELETE FROM ${T('ab_connection_access')} WHERE connection_id = $1`, [connectionId])
        for (const g of grants) {
          await tx.exec(`INSERT INTO ${T('ab_connection_access')} (connection_id, principal_kind, principal_id, level, granted_by, granted_on) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [connectionId, g.principalKind, g.principalId, g.level, by, now])
        }
      })
    },
  }

  async function level(user: UserContext, connectionId: string): Promise<'manage' | 'use' | null> {
    if (user.privileges.isAdmin) return 'manage'
    const rows = await db().query<{ level: string }>(
      `SELECT level FROM ${T('ab_connection_access')} WHERE connection_id = $1 AND ((principal_kind = 'user' AND principal_id = $2) OR (principal_kind = 'role' AND principal_id = ANY($3::text[])))`,
      [connectionId, user.user.id, user.roles.map((r) => r.id)],
    )
    if (rows.some((r) => r.level === 'manage')) return 'manage'
    return rows.length ? 'use' : null
  }

  /* ---------------------------------------------------------------- protection */

  function refill(s: RuntimeState, perMinute: number): void {
    const now = Date.now()
    const add = ((now - s.refilledAt) / 60_000) * perMinute
    if (add > 0) {
      s.tokens = Math.min(perMinute, s.tokens + add)
      s.refilledAt = now
    }
  }

  async function acquireSlot(s: RuntimeState, max: number, signal: AbortSignal): Promise<() => void> {
    const release = () => {
      s.inFlight--
      const next = s.waiters.shift()
      next?.()
    }
    if (s.inFlight < max) {
      s.inFlight++
      return release
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        const i = s.waiters.indexOf(go)
        if (i >= 0) s.waiters.splice(i, 1)
        reject(new OutboundError('rate_limited', `This connection already has ${max} calls running; try again shortly.`, true))
      }, SLOT_WAIT_MS)
      const go = () => {
        clearTimeout(t)
        if (signal.aborted) return reject(new OutboundError('timeout', 'The call was cancelled.', true))
        s.inFlight++
        resolve()
      }
      s.waiters.push(go)
    })
    return release
  }

  function breakerCountsFailure(err: ActionError): boolean {
    return err.code === 'network' || err.code === 'timeout' || (err.code === 'upstream' && RETRYABLE_UPSTREAM(err.status)) || (err.code === 'rate_limited' && err.status === 429)
  }

  function onSuccess(s: RuntimeState): void {
    s.failures = 0
    s.opens = 0
    s.openUntil = 0
    s.halfOpenTrial = false
  }
  function onFailure(s: RuntimeState, err: ActionError): void {
    s.lastError = err.message.slice(0, 300)
    if (!breakerCountsFailure(err)) {
      s.halfOpenTrial = false
      return
    }
    s.failures++
    if (s.halfOpenTrial || s.failures >= FAILURES_TO_OPEN) {
      s.opens++
      s.openUntil = Date.now() + Math.min(OPEN_MAX_MS, OPEN_BASE_MS * 2 ** Math.max(0, s.opens - 1))
    }
    s.halfOpenTrial = false
  }

  /* ---------------------------------------------------------------- idempotency */

  const keyHash = (env: string, conn: string, action: string, key: string) => createHash('sha256').update(`${env}\u0000${conn}\u0000${action}\u0000${key}`).digest('hex')

  async function claim(hash: string, conn: string, action: string, staleMs: number): Promise<{ replay?: ActionResult; busy?: boolean }> {
    const now = new Date()
    const expires = new Date(now.getTime() + IDEMPOTENCY_HOURS * 3600_000)
    const ins = await db().query<{ key_hash: string }>(
      `INSERT INTO ${T('ab_action_idempotency')} (key_hash, connection_id, action_id, state, created_on, expires_on) VALUES ($1, $2, $3, 'running', $4, $5)
       ON CONFLICT (key_hash) DO UPDATE SET state = 'running', created_on = EXCLUDED.created_on, expires_on = EXCLUDED.expires_on, result = NULL
         WHERE ${T('ab_action_idempotency')}.expires_on < $4 OR (${T('ab_action_idempotency')}.state = 'running' AND ${T('ab_action_idempotency')}.created_on < $6)
       RETURNING key_hash`,
      [hash, conn, action, now, expires, new Date(now.getTime() - staleMs)],
    )
    if (ins.length) return {}
    const row = (await db().query<{ state: string; result: unknown }>(`SELECT state, result FROM ${T('ab_action_idempotency')} WHERE key_hash = $1`, [hash]))[0]
    if (row?.state === 'done' && isObj(row.result)) {
      const r = row.result as ActionResult
      return { replay: r.ok ? { ...r, replayed: true } : r }
    }
    return { busy: true }
  }

  /* ---------------------------------------------------------------- run */

  async function logRun(e: { id: string; connectionId: string; actionId: string; userId: string | null; source?: string; correlationId?: string; result: ActionResult; durationMs: number; details: Record<string, unknown> }, secrets: string[]): Promise<void> {
    const r = e.result
    const message = r.ok ? null : redactDeep(r.error.message, secrets).slice(0, 500)
    try {
      await db().exec(
        `INSERT INTO ${T('ab_action_runs')} (id, at, connection_id, action_id, user_id, source, correlation_id, status, error_code, message, http_status, duration_ms, replayed, details)
         VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
        [e.id, e.connectionId, e.actionId, e.userId, e.source ?? null, e.correlationId ?? null, r.ok ? 'ok' : 'failed', r.ok ? null : r.error.code, message,
          (e.details.httpStatus as number | undefined) ?? (r.ok ? null : (r.error.status ?? null)), Math.round(e.durationMs), !!(r.ok && r.replayed), JSON.stringify(redactDeep(e.details, secrets))],
      )
    } catch (err) {
      services.env.log('warn', `action run log write failed: ${errText(err)}`)
    }
  }

  async function findAction(rec: ConnectionRecord, actionId: string): Promise<ActionDef & { http?: unknown }> {
    const p = providers.get(rec.connector)
    if (!p) throw new HttpError(404, 'not-found', `The connection "${rec.name}" offers no actions.`)
    const b = p.builtin().find((a) => a.id.toLowerCase() === actionId.toLowerCase())
    if (b) return b
    const c = await custom.get(rec.id, actionId)
    if (c) return { ...c.def, origin: 'custom' }
    throw new HttpError(404, 'not-found', `The connection "${rec.name}" has no action "${actionId}".`)
  }

  async function runInner(env: string, connectionId: string, actionId: string, inputs: unknown, identity: UserContext | null, opts: ActionRunOptions): Promise<ActionResult> {
    const t0 = Date.now()
    const runId = `run_${rowUid().replace(/-/g, '').slice(-20)}`
    let rec: ConnectionRecord | null = null
    let def: (ActionDef & { http?: unknown }) | null = null
    const details: Record<string, unknown> = {}
    let secrets: string[] = []
    const finish = async (result: ActionResult, s?: RuntimeState): Promise<ActionResult> => {
      const durationMs = Date.now() - t0
      const out: ActionResult = result.ok ? { ...result, output: redactDeep(result.output, secrets), runId, durationMs } : { ...result, error: { ...result.error, message: redactDeep(result.error.message, secrets) }, runId, durationMs }
      if (s && !out.ok && out.error.code !== 'circuit_open' && out.error.code !== 'invalid_input') onFailure(s, out.error)
      if (rec) await logRun({ id: runId, connectionId: rec.id, actionId: def?.id ?? actionId, userId: identity?.user.id ?? null, source: opts.source, correlationId: opts.correlationId, result: out, durationMs, details }, secrets)
      return out
    }
    try {
      rec = await connection(connectionId)
    } catch (e) {
      return { ok: false, error: toActionError(e), runId }
    }
    const p = providers.get(rec.connector)
    if (!p) return finish({ ok: false, error: { code: 'not_found', message: `The connection "${rec.name}" offers no actions.`, retryable: false } })
    secrets = p.secrets(rec)
    try {
      def = await findAction(rec, actionId)
    } catch (e) {
      return finish({ ok: false, error: toActionError(e) })
    }
    const lim = p.limits(rec)
    // inputs
    let size = 0
    try {
      size = Buffer.byteLength(JSON.stringify(inputs ?? {}))
    } catch {
      return finish({ ok: false, error: { code: 'invalid_input', message: 'The inputs are not plain JSON.', retryable: false } })
    }
    if (size > (lim.maxInputBytes ?? DEFAULT_INPUT_BYTES)) return finish({ ok: false, error: { code: 'too_large', message: `The inputs are too large (at most ${Math.round((lim.maxInputBytes ?? DEFAULT_INPUT_BYTES) / 1024)} KB).`, retryable: false } })
    const v = validate(def.inputs, inputs ?? {})
    if (!v.ok) return finish({ ok: false, error: { code: 'invalid_input', message: problemText(v.problems), retryable: false } })
    const s = stateOf(env, rec)
    // breaker
    const now = Date.now()
    if (s.openUntil > now) {
      return finish({ ok: false, error: { code: 'circuit_open', message: `Calls to "${rec.name}" are paused after ${s.failures} failures in a row; the next try is allowed at ${new Date(s.openUntil).toISOString()}. Last error: ${s.lastError ?? 'unknown'}`, retryable: true } })
    }
    if (s.openUntil && s.openUntil <= now) {
      if (s.halfOpenTrial) return finish({ ok: false, error: { code: 'circuit_open', message: `A trial call to "${rec.name}" is running after repeated failures; try again shortly.`, retryable: true } })
      s.halfOpenTrial = true
    }
    // rate
    refill(s, lim.perMinute)
    if (s.tokens < 1) {
      s.halfOpenTrial = false
      return finish({ ok: false, error: { code: 'rate_limited', message: `"${rec.name}" allows ${lim.perMinute} calls a minute; try again shortly.`, retryable: true } })
    }
    s.tokens -= 1
    // idempotency
    const timeoutMs = Math.max(100, Math.min(opts.timeoutMs ?? def.timeoutMs, def.timeoutMs, lim.maxTimeoutMs))
    let hash: string | null = null
    if (opts.idempotencyKey && !def.idempotent && def.sideEffect === 'external') {
      if (typeof opts.idempotencyKey !== 'string' || opts.idempotencyKey.length > 300) return finish({ ok: false, error: { code: 'invalid_input', message: 'The idempotency key must be text of at most 300 characters.', retryable: false } })
      hash = keyHash(env, rec.id, def.id, opts.idempotencyKey)
      const c = await claim(hash, rec.id, def.id, timeoutMs * 2 + 10_000)
      if (c.replay) {
        s.halfOpenTrial = false
        details.replayed = true
        return finish(c.replay)
      }
      if (c.busy) {
        s.halfOpenTrial = false
        return finish({ ok: false, error: { code: 'in_progress', message: 'The same call (same idempotency key) is running right now.', retryable: true } })
      }
    }
    const ac = new AbortController()
    const onOuter = () => ac.abort()
    opts.signal?.addEventListener('abort', onOuter, { once: true })
    let release: (() => void) | null = null
    let result: ActionResult
    try {
      release = await acquireSlot(s, lim.maxConcurrent, ac.signal)
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const output = await Promise.race([
          p.invoke({ env, connection: rec, action: def, inputs: v.value as Record<string, unknown>, identity, timeoutMs, signal: ac.signal, services, cache: s.cache, note: (d) => Object.assign(details, d), runId, idempotencyKey: opts.idempotencyKey }),
          new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(new OutboundError('timeout', `The action did not finish within ${Math.round(timeoutMs / 100) / 10} s.`, true)), { once: true })),
        ])
        let outSize = 0
        try {
          outSize = Buffer.byteLength(JSON.stringify(output ?? null))
        } catch {
          throw new OutboundError('internal', 'The action returned something that is not JSON.')
        }
        if (outSize > MAX_OUTPUT_BYTES) throw new OutboundError('too_large', `The action's output is larger than ${MAX_OUTPUT_BYTES / 1024} KB.`)
        result = { ok: true, output: output ?? null }
      } finally {
        clearTimeout(timer)
      }
    } catch (e) {
      result = { ok: false, error: toActionError(e) }
    } finally {
      release?.()
      opts.signal?.removeEventListener('abort', onOuter)
    }
    if (result.ok) onSuccess(s)
    if (hash) {
      try {
        if (result.ok || !result.error.retryable) {
          const stored = result.ok ? { ok: true, output: redactDeep(result.output, secrets) } : { ok: false, error: { ...result.error, message: redactDeep(result.error.message, secrets) } }
          await db().exec(`UPDATE ${T('ab_action_idempotency')} SET state = 'done', result = $2::jsonb WHERE key_hash = $1`, [hash, JSON.stringify(stored)])
        } else {
          await db().exec(`DELETE FROM ${T('ab_action_idempotency')} WHERE key_hash = $1`, [hash])
        }
      } catch (e) {
        services.env.log('warn', `idempotency store failed: ${errText(e)}`)
      }
    }
    return finish(result, s)
  }

  const svc: ActionsServiceImpl = {
    register(p) {
      providers.set(p.kind, p)
    },
    provider: (kind) => providers.get(kind),
    kinds(): ActionKindInfo[] {
      return [...providers.values()].map((p) => ({ kind: p.kind, label: p.label, description: p.description, tables: p.tables, actions: p.builtin() }))
    },
    async list(kindOrConnectionId) {
      const p = providers.get(kindOrConnectionId)
      if (p) return p.builtin()
      const rec = await connection(kindOrConnectionId)
      const prov = providers.get(rec.connector)
      if (!prov) return []
      return [...prov.builtin(), ...(await custom.list(rec.id)).map((c) => ({ ...c.def, origin: 'custom' as const }))]
    },
    async describe(connectionId, actionId) {
      return findAction(await connection(connectionId), actionId)
    },
    run(env, connectionId, actionId, inputs, identity, opts = {}) {
      return runInEnvironment(env, () => runInner(env, connectionId, actionId, inputs, identity, opts))
    },
    async canUse(user, connectionId) {
      return (await level(user, connectionId)) !== null
    },
    async canManage(user, connectionId) {
      return (await level(user, connectionId)) === 'manage'
    },
    async assertCanUse(user, connectionId) {
      const rec = await services.meta.connections.get(connectionId)
      if (!rec) throw new HttpError(404, 'not-found', `Connection "${connectionId}" does not exist.`)
      if (!(await level(user, connectionId))) throw new HttpError(403, 'denied', `You may not use the connection "${rec.name}". An administrator can give you "use" access on the connection's Access tab.`)
    },
    state(env, connectionId) {
      const s = states.get(`${env}:${connectionId}`)
      const now = Date.now()
      const circuit: ActionConnectionState['circuit'] = !s || !s.openUntil ? 'closed' : s.openUntil > now ? 'open' : 'half-open'
      return {
        circuit, failures: s?.failures ?? 0, retryAt: s && s.openUntil ? new Date(s.openUntil).toISOString() : null, inFlight: s?.inFlight ?? 0,
        // the limits come from the connection's settings (routes fill them in with connectionLimits)
        maxConcurrent: 0, perMinute: 0, lastError: s?.lastError ?? null,
      }
    },
    custom,
    access,
    async activity(connectionId, o) {
      const params: unknown[] = [connectionId, Math.max(1, Math.min(200, o.limit))]
      let where = 'connection_id = $1'
      if (o.before) {
        params.push(new Date(o.before))
        where += ` AND at < $${params.length}`
      }
      if (o.userId) {
        params.push(o.userId)
        where += ` AND user_id = $${params.length}`
      }
      const rows = await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_action_runs')} WHERE ${where} ORDER BY at DESC, id DESC LIMIT $2`, params)
      return rows.map((r) => ({
        id: r.id, at: new Date(r.at as string).toISOString(), actionId: r.action_id, userId: r.user_id, source: r.source, correlationId: r.correlation_id, status: r.status,
        errorCode: r.error_code, message: r.message, httpStatus: r.http_status, durationMs: r.duration_ms, replayed: r.replayed, details: r.details,
      }))
    },
    resetCircuit(env, connectionId) {
      const s = states.get(`${env}:${connectionId}`)
      if (s) onSuccess(s)
    },
    forget(env, connectionId) {
      states.delete(`${env}:${connectionId}`)
    },
    async test(env, connectionId) {
      return runInEnvironment(env, async () => {
        const rec = await connection(connectionId)
        const p = providers.get(rec.connector)
        if (!p) return { ok: false, message: 'This connection offers no actions.' }
        const s = stateOf(env, rec)
        try {
          const r = await p.test({ connection: rec, services, cache: s.cache, env })
          return { ok: r.ok, message: redactDeep(r.message, p.secrets(rec)) }
        } catch (e) {
          return { ok: false, message: redactDeep(toActionError(e).message, p.secrets(rec)) }
        }
      })
    },
    cacheOf(env, connectionId) {
      for (const [k, s] of states) if (k === `${env}:${connectionId}`) return s.cache
      return new Map()
    },
  }
  // retention: run log 90 days, expired idempotency keys, webhook replay marks older than a day
  services.kernel.jobs.register<{ days: number }>({
    type: ACTIONS_RETENTION_JOB,
    schedule: 'custom',
    description: 'Deletes connector action activity older than the configured number of days, expired idempotency keys and old webhook replay marks.',
    parse(raw) {
      const d = Number(isObj(raw) ? raw.days : 90)
      if (!Number.isInteger(d) || d < 7 || d > 3650) throw new JobError('days must be a whole number between 7 and 3650', { retry: false })
      return { days: d }
    },
    async handler(p) {
      const cut = new Date(Date.now() - p.days * 86400_000)
      const a = await db().exec(`DELETE FROM ${T('ab_action_runs')} WHERE at < $1`, [cut])
      const b = await db().exec(`DELETE FROM ${T('ab_action_idempotency')} WHERE expires_on < now()`)
      const c = await db().exec(`DELETE FROM ${T('ab_webhook_replays')} WHERE seen_on < now() - interval '1 day'`)
      const r = await db().exec(`DELETE FROM ${T('ab_report_runs')} WHERE started_on < $1`, [new Date(Date.now() - 400 * 86400_000)])
      return { runs: a.affectedRows, keys: b.affectedRows, replays: c.affectedRows, reportRuns: r.affectedRows }
    },
  })
  if (!BUILTIN_SCHEDULES.some((b) => b.id === 'sched_actions_retention')) {
    BUILTIN_SCHEDULES.push({ id: 'sched_actions_retention', name: 'Connector activity retention', description: 'Deletes connector action activity older than the configured number of days (default 90), expired idempotency keys and old webhook replay marks.', cron: '23 4 * * *', jobType: ACTIONS_RETENTION_JOB, payload: { days: 90 }, enabled: true })
  }
  return svc
}

/** the limits as the UI shows them */
export function connectionLimits(svc: ActionsServiceImpl, rec: ConnectionRecord): { perMinute: number; maxConcurrent: number; maxTimeoutMs: number } | null {
  const p = svc.provider(rec.connector)
  return p ? p.limits(rec) : null
}
