/**
 * Server calls of identity basics (P0 package I): second sign-in step, password reset, invitations, email change,
 * two-step verification, sessions, sign-in log, policy, email relay, service accounts and API keys.
 * Same conventions as serverApi.ts (same-origin cookie session, CSRF header on writes). Server-only: demo mode has no
 * sign-in, so callers check `mode === 'server'` first.
 */
import { PlatformError, type Session } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import { toError } from './serverApi'

export async function idCall<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { [CSRF_HEADER]: '1', ...environmentHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) {
    const copy = res.clone()
    const err = await toError(res)
    try {
      const b = (await copy.json()) as { error?: { field?: string }; mfa?: unknown }
      if (b?.error?.field) Object.assign(err, { field: b.error.field })
      if (b?.mfa) Object.assign(err, { mfa: b.mfa })
    } catch { /* not JSON */ }
    throw err
  }
  return (await res.json()) as T
}

/* ------------------------------------------------------------------ anonymous */

export interface IdentityInfo { email: boolean; emailCodes: boolean; passwordMinLength: number; rememberDays: number }
export const identityInfo = () => idCall<IdentityInfo>('GET', '/auth/identity-info')

export type SecondStepMethod = 'totp' | 'recovery_code' | 'email_code'
export interface MfaChallenge { methods: SecondStepMethod[]; rememberDays: number }

/** the second step of a password sign-in that answered mfa_required */
export const verifySecondStep = (code: string, method: SecondStepMethod, remember: boolean) => idCall<Session>('POST', '/auth/login/verify', { code, method, remember })
export const sendSignInCode = () => idCall<{ ok: true; sentTo: string }>('POST', '/auth/login/email-code', {})

export const forgotPassword = (email: string) => idCall<{ ok: true; email: boolean; message: string }>('POST', '/auth/password/forgot', { email })
export const checkResetToken = (token: string) => idCall<{ ok: true; email: string; expiresOn: string }>('POST', '/auth/password/reset/check', { token })
export const resetPassword = (input: { token?: string; email?: string; code?: string; password: string }) => idCall<{ ok: true }>('POST', '/auth/password/reset', input)
export const checkInvitation = (token: string) => idCall<{ ok: true; email: string; name: string; expiresOn: string }>('POST', '/auth/invitation/check', { token })
export const acceptInvitation = (token: string, password: string) => idCall<Session>('POST', '/auth/invitation/accept', { token, password })
export const confirmEmail = (token: string) => idCall<{ ok: true; email: string }>('POST', '/auth/email/confirm', { token })

/* ------------------------------------------------------------------ own account */

export interface SecurityState {
  mfa: { totp: { enabledOn: string } | null; email: boolean; recovery: { total: number; remaining: number; createdOn: string | null } | null }
  required: { enrolBy: string | null } | null
  emailConfigured: boolean
  emailCodesAvailable: boolean
  rememberDays: number
  devices: { id: string; device: string; ip: string | null; createdOn: string; lastUsedOn: string | null; expiresOn: string }[]
  pendingEmail: string | null
  passwordChangedOn: string | null
  reauthUntil: string | null
}
export const securityState = () => idCall<SecurityState>('GET', '/auth/security')
export const reauthenticate = (input: { password?: string; code?: string }) => idCall<{ ok: true; until: string }>('POST', '/auth/reauth', input)
export const changeEmail = (email: string) => idCall<{ ok: true; sentTo: string }>('POST', '/auth/email/change', { email })

export interface TotpStart { secret: string; uri: string; qrSvg: string; issuer: string; account: string }
export const startTotp = () => idCall<TotpStart>('POST', '/auth/mfa/totp/start', {})
export const confirmTotp = (code: string) => idCall<{ ok: true; recoveryCodes: string[] | null }>('POST', '/auth/mfa/totp/confirm', { code })
export const disableTotp = () => idCall<{ ok: true }>('DELETE', '/auth/mfa/totp')
export const startEmailCodes = () => idCall<{ ok: true; sentTo: string }>('POST', '/auth/mfa/email/start', {})
export const confirmEmailCodes = (code: string) => idCall<{ ok: true; recoveryCodes: string[] | null }>('POST', '/auth/mfa/email/confirm', { code })
export const disableEmailCodes = () => idCall<{ ok: true }>('DELETE', '/auth/mfa/email')
export const newRecoveryCodes = () => idCall<{ ok: true; recoveryCodes: string[] }>('POST', '/auth/mfa/recovery-codes', {})

export interface SessionEntry { id: string; device: string; userAgent: string | null; ip: string | null; createdOn: string; lastSeen: string; expiresOn: string; mfa: boolean; current: boolean }
export const mySessions = () => idCall<{ items: SessionEntry[] }>('GET', '/auth/sessions')
export const endMySession = (id: string) => idCall<{ ok: true }>('DELETE', `/auth/sessions/${encodeURIComponent(id)}`)
export const endOtherSessions = () => idCall<{ ok: true; ended: number }>('POST', '/auth/sessions/revoke-others', {})
export const forgetDevice = (id?: string) => idCall<{ ok: true }>('DELETE', id ? `/auth/devices/${encodeURIComponent(id)}` : '/auth/devices')

export interface SignInEntry { id: number; at: string; userId: string | null; email: string | null; outcome: 'success' | 'failure'; reason: string; method: string; ip: string | null; device: string; sessionId: string | null; newDevice: boolean }
export const mySignIns = () => idCall<{ items: SignInEntry[] }>('GET', '/auth/signins')

/* ------------------------------------------------------------------ administrators */

export interface UserIdentityState { mfa: boolean; mfaMethods: string[]; invitation: { createdOn: string; expiresOn: string } | null; invitationExpired: boolean; sessions: number }
export const usersIdentity = () => idCall<{ users: Record<string, UserIdentityState>; emailConfigured: boolean }>('GET', '/identity/users')
export const userSessions = (userId: string) => idCall<{ items: SessionEntry[] }>('GET', `/users/${encodeURIComponent(userId)}/sessions`)
export const endUserSession = (userId: string, sid: string) => idCall<{ ok: true }>('DELETE', `/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sid)}`)
export const endUserSessions = (userId: string) => idCall<{ ok: true }>('DELETE', `/users/${encodeURIComponent(userId)}/sessions`)
export const resetUserMfa = (userId: string) => idCall<{ ok: true }>('POST', `/users/${encodeURIComponent(userId)}/mfa/reset`, {})
export const createResetCode = (userId: string) => idCall<{ code: string; expiresOn: string; email: string }>('POST', `/users/${encodeURIComponent(userId)}/reset-code`, {})
export const inviteUser = (userId: string) => idCall<{ ok: true; expiresOn: string }>('POST', `/users/${encodeURIComponent(userId)}/invite`, {})
export const revokeInvitation = (userId: string) => idCall<{ ok: true }>('DELETE', `/users/${encodeURIComponent(userId)}/invite`)
export const signInLog = (q: { user?: string; outcome?: string; page?: number; pageSize?: number }) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v))
  return idCall<{ items: SignInEntry[]; total: number; page: number; pageSize: number }>('GET', `/identity/signins?${p}`)
}

export type MfaMode = 'off' | 'admins' | 'all'
export interface SecurityPolicy {
  password: { minLength: number; checkCommon: boolean; historyCount: number; maxAgeDays: number }
  lockout: { attempts: number; windowMinutes: number; slowDownFrom: number; blockAt: number; mfaAttempts: number; mfaLockMinutes: number }
  sessions: { idleMinutes: number; absoluteHours: number }
  mfa: { mode: MfaMode; environments: Record<string, MfaMode>; graceDays: number; since: string | null; rememberDays: number; emailCodes: boolean }
  notifyNewDevice: boolean
}
export const getPolicy = () => idCall<{ policy: SecurityPolicy }>('GET', '/identity/policy')
export const savePolicy = (policy: Partial<SecurityPolicy>) => idCall<{ policy: SecurityPolicy }>('PUT', '/identity/policy', { policy })

export interface SmtpSettings {
  host: string; port: number; security: 'starttls' | 'tls' | 'none'; username: string; hasPassword: boolean; verifyCertificate: boolean
  fromAddress: string; fromName: string; replyTo: string; installName: string; publicUrl: string
}
export const getEmailSettings = () => idCall<{ settings: SmtpSettings | null }>('GET', '/identity/email')
export const saveEmailSettings = (s: Partial<SmtpSettings> & { password?: string }) => idCall<{ settings: SmtpSettings }>('PUT', '/identity/email', s)
export const removeEmailSettings = () => idCall<{ ok: true }>('DELETE', '/identity/email')
export const sendTestEmail = (to: string) => idCall<{ ok: true; to: string; response: string }>('POST', '/identity/email/test', { to })
export interface MailLogEntry { id: string; createdOn: string; sentOn: string | null; status: 'queued' | 'sent' | 'retrying' | 'failed'; attempts: number; to: string; subject: string; template: string; lastError: string | null }
export const emailLog = (page = 1, status = '') => idCall<{ items: MailLogEntry[]; total: number; page: number; pageSize: number }>('GET', `/identity/email/log?page=${page}${status ? `&status=${status}` : ''}`)

export interface ApiKey { id: string; name: string; prefix: string; createdOn: string; expiresOn: string | null; lastUsedOn: string | null; lastUsedIp: string | null; revokedOn: string | null; ipAllow: string[]; ratePerMinute: number | null; environmentId: string }
export interface ServiceAccount { id: string; name: string; status: 'active' | 'disabled'; environmentId: string; roleIds: string[]; keys: ApiKey[] }
export const serviceAccounts = () => idCall<{ items: ServiceAccount[] }>('GET', '/identity/service-accounts')
export const createServiceAccount = (input: { name: string; environmentId: string; roleIds: string[] }) => idCall<ServiceAccount>('POST', '/identity/service-accounts', input)
export const updateServiceAccount = (id: string, patch: { name?: string; status?: 'active' | 'disabled'; roleIds?: string[] }) => idCall<ServiceAccount>('PATCH', `/identity/service-accounts/${encodeURIComponent(id)}`, patch)
export const deleteServiceAccount = (id: string) => idCall<{ ok: true }>('DELETE', `/identity/service-accounts/${encodeURIComponent(id)}`)
export const createApiKey = (id: string, input: { name: string; expiresInDays?: number; ipAllow?: string; ratePerMinute?: number }) => idCall<{ key: string; apiKey: ApiKey; defaultRatePerMinute: number }>('POST', `/identity/service-accounts/${encodeURIComponent(id)}/keys`, input)
export const revokeApiKey = (id: string, kid: string) => idCall<{ ok: true }>('DELETE', `/identity/service-accounts/${encodeURIComponent(id)}/keys/${encodeURIComponent(kid)}`)

/** the hash part of a link from an email: #reset=..., #invite=..., #confirm-email=... */
export function linkFromHash(hash = typeof location !== 'undefined' ? location.hash : ''): { kind: 'reset' | 'invite' | 'confirm-email'; token: string } | null {
  const m = /^#(reset|invite|confirm-email)=([A-Za-z0-9_-]{16,200})$/.exec(hash)
  return m ? { kind: m[1] as 'reset' | 'invite' | 'confirm-email', token: m[2] } : null
}
