/**
 * Server calls of the licence and seat passes (hosting phase, H-G / H-H; server/core/licence/index.ts). Server mode
 * only; administrators read, install administrators check and assign.
 */
import { idCall } from './identityApi'

export type PassKind = 'full' | 'operator' | 'external'
export interface SeatCounts { full: number; operator: number; external: number }
export interface SeatState {
  inUse: SeatCounts
  licensed: SeatCounts | null
  over: Partial<Record<PassKind, { since: string; blockedFrom: string; blocked: boolean; by: number }>>
}
export interface LicenceView {
  configured: boolean
  mode: 'unlicensed' | 'ok' | 'warning' | 'read-only'
  readOnly: { reason: 'licence' | 'payment' | 'suspended'; message: string; since: string } | null
  readOnlyAt: string | null
  warnings: string[]
  problems: string[]
  licence: {
    licenceId: string; status: string; plan: string | null; kind: 'subscription' | 'lifetime' | null; seats: SeatCounts | null
    paidUntil: string | null; maintenanceUntil: string | null; issuedAt: string; validUntil: string; receivedAt: string; message: string
  } | null
  lastCheck: { at: string; ok: boolean; error: string | null } | null
  installId: string | null
  clockBack: boolean
  keySource: 'built-in' | 'setting'
}
export interface LicenceState { licence: LicenceView; seats: SeatState | null; overSeatGraceDays?: number }

export const PASS_LABELS: Record<PassKind, string> = { full: 'Full user', operator: 'Operator', external: 'External' }

export const fetchLicence = () => idCall<LicenceState>('GET', '/install/licence')
export const checkLicenceNow = () => idCall<LicenceState>('POST', '/install/licence/check', {})
export const fetchPasses = () => idCall<{ passes: Record<string, PassKind>; assignable: PassKind[]; seats: SeatState | null }>('GET', '/install/licence/passes')
export const assignPasses = (userIds: string[], pass: PassKind) => idCall<{ changed: string[]; unchanged: string[]; seats: SeatState | null }>('PUT', '/install/licence/passes', { userIds, pass })
