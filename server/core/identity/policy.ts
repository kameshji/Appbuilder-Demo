/**
 * Install-wide sign-in and security policy (Admin console > Sign-in and security), stored as JSON in ab.settings under
 * `identity.policy`, cached in memory (re-read every 30 s, so a second server process follows within half a minute).
 * docs/admin/sign-in-and-identity.md describes every value.
 */
import type { SqlDb } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { setPasswordRules } from '../password.ts'

export type MfaMode = 'off' | 'admins' | 'all'

export interface SecurityPolicy {
  password: {
    /** 8 to 64 */
    minLength: number
    /** refuse passwords on the bundled common-password list */
    checkCommon: boolean
    /** the last N passwords cannot be reused (0 = off, at most 24) */
    historyCount: number
    /** days after which the password must be changed at the next sign-in (0 = never) */
    maxAgeDays: number
  }
  lockout: {
    /** wrong passwords per email and address in windowMinutes before that pair is refused */
    attempts: number
    windowMinutes: number
    /** wrong passwords per email (any address) in an hour from which every attempt is slowed down (1 s, 2 s, ... 5 min) */
    slowDownFrom: number
    /** wrong passwords per email (any address) in an hour that block the email for the rest of the hour */
    blockAt: number
    /** wrong second-step codes in mfaWindowMinutes that lock the second step of the account */
    mfaAttempts: number
    mfaLockMinutes: number
  }
  sessions: {
    /** a session ends after this long without activity (minutes) */
    idleMinutes: number
    /** a session ends this long after sign-in however active it is (hours; 0 = no limit) */
    absoluteHours: number
  }
  mfa: {
    /** install-wide: who must use two-step verification */
    mode: MfaMode
    /** per environment: people who may enter it (admins: its administrators) must use it */
    environments: Record<string, MfaMode>
    /** days after the policy was tightened (or the account was created) before enrolment is forced at sign-in */
    graceDays: number
    /** when the policy was last tightened (ISO; set by the server) */
    since: string | null
    /** "remember this device" lasts this many days (0 = the option is not offered) */
    rememberDays: number
    /** email one-time codes may be used as the second step (needs SMTP) */
    emailCodes: boolean
  }
  /** email the user when their account is signed in on a device it was not signed in on before (needs SMTP) */
  notifyNewDevice: boolean
}

export const DEFAULT_POLICY: SecurityPolicy = {
  password: { minLength: 10, checkCommon: true, historyCount: 0, maxAgeDays: 0 },
  lockout: { attempts: 8, windowMinutes: 15, slowDownFrom: 10, blockAt: 50, mfaAttempts: 10, mfaLockMinutes: 15 },
  sessions: { idleMinutes: 7 * 24 * 60, absoluteHours: 30 * 24 },
  mfa: { mode: 'off', environments: {}, graceDays: 7, since: null, rememberDays: 30, emailCodes: true },
  notifyNewDevice: true,
}

const KEY = 'identity.policy'
const MODES: MfaMode[] = ['off', 'admins', 'all']

function int(v: unknown, field: string, min: number, max: number, def: number): number {
  if (v === undefined) return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(422, 'invalid', `${field} must be a whole number from ${min} to ${max}.`, field)
  return n
}
const flag = (v: unknown, def: boolean): boolean => (v === undefined ? def : v === true)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** validates a (partial) policy from the API on top of the current one; throws 422 with the field */
export function mergePolicy(cur: SecurityPolicy, raw: unknown): SecurityPolicy {
  if (!isObj(raw)) throw new HttpError(422, 'invalid', 'The policy must be an object.')
  const p = isObj(raw.password) ? raw.password : {}
  const l = isObj(raw.lockout) ? raw.lockout : {}
  const s = isObj(raw.sessions) ? raw.sessions : {}
  const m = isObj(raw.mfa) ? raw.mfa : {}
  const mode = (v: unknown, field: string, def: MfaMode): MfaMode => {
    if (v === undefined) return def
    if (!MODES.includes(v as MfaMode)) throw new HttpError(422, 'invalid', `${field} must be off, admins or all.`, field)
    return v as MfaMode
  }
  let environments = cur.mfa.environments
  if (m.environments !== undefined) {
    if (!isObj(m.environments)) throw new HttpError(422, 'invalid', 'mfa.environments must map environment ids to off, admins or all.', 'mfa.environments')
    environments = {}
    for (const [k, v] of Object.entries(m.environments)) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) throw new HttpError(422, 'invalid', `"${k}" is not an environment id.`, 'mfa.environments')
      const md = mode(v, `mfa.environments.${k}`, 'off')
      if (md !== 'off') environments[k] = md
    }
  }
  return {
    password: {
      minLength: int(p.minLength, 'password.minLength', 8, 64, cur.password.minLength),
      checkCommon: flag(p.checkCommon, cur.password.checkCommon),
      historyCount: int(p.historyCount, 'password.historyCount', 0, 24, cur.password.historyCount),
      maxAgeDays: int(p.maxAgeDays, 'password.maxAgeDays', 0, 3650, cur.password.maxAgeDays),
    },
    lockout: {
      attempts: int(l.attempts, 'lockout.attempts', 3, 100, cur.lockout.attempts),
      windowMinutes: int(l.windowMinutes, 'lockout.windowMinutes', 1, 1440, cur.lockout.windowMinutes),
      slowDownFrom: int(l.slowDownFrom, 'lockout.slowDownFrom', 3, 1000, cur.lockout.slowDownFrom),
      blockAt: int(l.blockAt, 'lockout.blockAt', 5, 10000, cur.lockout.blockAt),
      mfaAttempts: int(l.mfaAttempts, 'lockout.mfaAttempts', 3, 100, cur.lockout.mfaAttempts),
      mfaLockMinutes: int(l.mfaLockMinutes, 'lockout.mfaLockMinutes', 1, 1440, cur.lockout.mfaLockMinutes),
    },
    sessions: {
      idleMinutes: int(s.idleMinutes, 'sessions.idleMinutes', 5, 90 * 24 * 60, cur.sessions.idleMinutes),
      absoluteHours: int(s.absoluteHours, 'sessions.absoluteHours', 0, 365 * 24, cur.sessions.absoluteHours),
    },
    mfa: {
      mode: mode(m.mode, 'mfa.mode', cur.mfa.mode),
      environments,
      graceDays: int(m.graceDays, 'mfa.graceDays', 0, 90, cur.mfa.graceDays),
      since: cur.mfa.since,
      rememberDays: int(m.rememberDays, 'mfa.rememberDays', 0, 90, cur.mfa.rememberDays),
      emailCodes: flag(m.emailCodes, cur.mfa.emailCodes),
    },
    notifyNewDevice: flag(raw.notifyNewDevice, cur.notifyNewDevice),
  }
}

const rank = (m: MfaMode): number => MODES.indexOf(m)
/** true when `next` asks more people for two-step verification than `prev` (the grace period starts again) */
export function tightened(prev: SecurityPolicy, next: SecurityPolicy): boolean {
  if (rank(next.mfa.mode) > rank(prev.mfa.mode)) return true
  for (const [env, m] of Object.entries(next.mfa.environments)) if (rank(m) > rank(prev.mfa.environments[env] ?? 'off')) return true
  return false
}

/** stored JSON -> policy (unknown or broken values fall back to the defaults) */
export function parseStoredPolicy(text: string | null | undefined): SecurityPolicy {
  if (!text) return structuredClone(DEFAULT_POLICY)
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const merged = mergePolicy(DEFAULT_POLICY, raw)
    const since = isObj(raw.mfa) && typeof raw.mfa.since === 'string' ? raw.mfa.since : null
    return { ...merged, mfa: { ...merged.mfa, since } }
  } catch {
    return structuredClone(DEFAULT_POLICY)
  }
}

export interface PolicyStore {
  get(): Promise<SecurityPolicy>
  /** the cached value (defaults before the first read) */
  cached(): SecurityPolicy
  save(p: SecurityPolicy): Promise<void>
}

export function createPolicyStore(db: () => SqlDb | null, ttlMs = 30_000): PolicyStore {
  let value: SecurityPolicy = structuredClone(DEFAULT_POLICY)
  let readAt = 0
  const apply = (p: SecurityPolicy) => {
    value = p
    readAt = Date.now()
    setPasswordRules({ minLength: p.password.minLength, checkCommon: p.password.checkCommon })
  }
  return {
    async get() {
      if (Date.now() - readAt < ttlMs) return value
      const d = db()
      if (!d) return value
      const rows = await d.query<{ v: string | null }>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [KEY])
      apply(parseStoredPolicy(rows[0]?.v))
      return value
    },
    cached: () => value,
    async save(p) {
      const d = db()
      if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
      await d.exec(`INSERT INTO "ab"."settings" (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [KEY, JSON.stringify(p)])
      apply(p)
    },
  }
}
