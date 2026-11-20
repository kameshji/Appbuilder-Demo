/**
 * The licence answer: the one format the licence service signs and the install's licence client verifies (hosting
 * phase, package H-G; docs/dev/licensing.md). Shared by server/licence-service/** and server/core/licence/**.
 *
 * Wire format of POST /v1/licence/check (the install presents its install key as `Authorization: Bearer abl_...`):
 *
 *   request  { v: 1, licenceId, installId, version, nonce, seats: { full, operator, external } }
 *   answer   { alg: 'ed25519', keyId, payload: <base64 of the UTF-8 JSON of LicencePayload>, signature: <base64> }
 *
 * The signature is Ed25519 over the exact payload bytes (no canonical JSON needed: the client parses only what it
 * verified). Only seat counts travel: no names, emails or other personal data, in either direction.
 *
 * The primitives are Node's own (node:crypto) and the key ids are those of the release keys (update/release.ts
 * keyIdOf): the first 16 hex characters of SHA-256 over the SPKI DER of the public key. The licence key pair is a
 * DIFFERENT key from the release key (licence keygen), so a leaked licence key cannot sign releases and the other way
 * round.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { keyIdOf, publicKeyFromText } from '../update/release.ts'

export const ANSWER_VERSION = 1
/** the grace window: an answer is valid for 72 hours after it was issued (owner decision, master plan 13) */
export const GRACE_MS = 72 * 3600_000
/** a clock earlier than the latest time seen by more than this counts as expired until a fresh answer (spec 7) */
export const CLOCK_TOLERANCE_MS = 5 * 60_000

export type PassKind = 'full' | 'operator' | 'external'
export const PASS_KINDS: readonly PassKind[] = ['full', 'operator', 'external']
export interface SeatCounts { full: number; operator: number; external: number }

export type LicenceKind = 'subscription' | 'lifetime'
/**
 * active: normal. payment: the subscription is unpaid (read-only from readOnlyFrom). suspended / cancelled: by the
 * operator (read-only from readOnlyFrom). duplicate: another install uses this licence and this one is the older
 * (read-only at once). refused: the install key is unknown, revoked or not of this licence (same answer for each, so
 * the service does not tell which keys exist); a refused answer never counts as a valid check.
 */
export type LicenceStatus = 'active' | 'payment' | 'suspended' | 'cancelled' | 'duplicate' | 'refused'
export const LICENCE_STATUSES: readonly LicenceStatus[] = ['active', 'payment', 'suspended', 'cancelled', 'duplicate', 'refused']

export interface CheckRequest {
  v: 1
  licenceId: string
  installId: string
  version: string
  nonce: string
  seats: SeatCounts
}

export interface LicencePayload {
  v: 1
  /** the organisation's licence id (lic_...) the request named; the client refuses an answer for another one */
  licenceId: string
  installId: string
  status: LicenceStatus
  plan: string | null
  kind: LicenceKind | null
  /** licensed seats per pass kind (null for a refused answer) */
  seats: SeatCounts | null
  /** subscription: paid until (ISO); lifetime: null ("never" for use) */
  paidUntil: string | null
  /** lifetime: updates included until (ISO; DC-15); subscription: null */
  maintenanceUntil: string | null
  /** days of notice before read-only for payment / suspended / cancelled */
  noticeDays: number
  /** payment / suspended / cancelled / duplicate: from when the install is read-only (ISO); null otherwise */
  readOnlyFrom: string | null
  /** one line for administrators (no personal data) */
  message: string
  issuedAt: string
  /** issuedAt + GRACE_MS */
  validUntil: string
  serverTime: string
  /** the request's nonce, echoed: an answer to another request (a replay) is refused */
  nonce: string
}

export interface SignedAnswer { alg: 'ed25519'; keyId: string; payload: string; signature: string }

export const INSTALL_KEY_RE = /^abl_[A-Za-z0-9_-]{40,64}$/
export const LICENCE_ID_RE = /^lic_[a-z0-9]{8,32}$/
export const INSTALL_ID_RE = /^ins_[a-z0-9]{8,40}$/
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/

export const newNonce = (): string => randomBytes(18).toString('base64url')
export const newInstallId = (): string => 'ins_' + randomBytes(12).toString('hex')
export const newLicenceId = (): string => 'lic_' + randomBytes(6).toString('hex')
/** a new install key: shown once to the operator, stored only as its SHA-256 by the service */
export const newInstallKey = (): string => 'abl_' + randomBytes(32).toString('base64url')

const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000 ? (v as number) : NaN)

export function parseSeats(v: unknown): SeatCounts | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const s = { full: count(o.full), operator: count(o.operator), external: count(o.external) }
  return Number.isNaN(s.full) || Number.isNaN(s.operator) || Number.isNaN(s.external) ? null : s
}

/** a request body as the service accepts it (strict; anything else is a 400) */
export function parseCheckRequest(v: unknown): CheckRequest | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const seats = parseSeats(o.seats)
  if (o.v !== 1 || !seats) return null
  if (typeof o.licenceId !== 'string' || !LICENCE_ID_RE.test(o.licenceId)) return null
  if (typeof o.installId !== 'string' || !INSTALL_ID_RE.test(o.installId)) return null
  if (typeof o.nonce !== 'string' || !NONCE_RE.test(o.nonce)) return null
  if (typeof o.version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(o.version)) return null
  return { v: 1, licenceId: o.licenceId, installId: o.installId, version: o.version, nonce: o.nonce, seats }
}

/* ------------------------------------------------------------------ keys */

/** a new licence signing key pair: private key as encrypted PKCS#8 PEM (AES-256-CBC), public as SPKI PEM */
export function generateLicenceKey(passphrase: string): { privatePem: string; publicPem: string; id: string } {
  if (passphrase.length < 12) throw new Error('Use a passphrase of at least 12 characters for the licence signing key.')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return { privatePem: privateKey, publicPem: publicKey, id: keyIdOf(createPublicKey(publicKey)) }
}

export interface SigningKey { key: KeyObject; keyId: string }

export function loadSigningKey(privatePem: string, passphrase?: string): SigningKey {
  const key = createPrivateKey(passphrase === undefined ? privatePem : { key: privatePem, passphrase })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The licence signing key must be an Ed25519 key.')
  return { key, keyId: keyIdOf(createPublicKey(key)) }
}

export function signAnswer(p: LicencePayload, k: SigningKey): SignedAnswer {
  const bytes = Buffer.from(JSON.stringify(p), 'utf8')
  return { alg: 'ed25519', keyId: k.keyId, payload: bytes.toString('base64'), signature: sign(null, bytes, k.key).toString('base64') }
}

export interface TrustedLicenceKey { id: string; key: KeyObject }

export function trustedLicenceKey(text: string): TrustedLicenceKey {
  const key = publicKeyFromText(text)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Licence public keys must be Ed25519 keys.')
  return { id: keyIdOf(key), key }
}

export type VerifyResult =
  | { ok: true; payload: LicencePayload; keyId: string }
  | { ok: false; reason: 'malformed' | 'untrusted-key' | 'bad-signature' | 'bad-payload' }

/** signature and shape only; the caller checks nonce, ids and times (client.ts acceptAnswer) */
export function verifyAnswer(a: unknown, trusted: readonly TrustedLicenceKey[]): VerifyResult {
  if (!a || typeof a !== 'object') return { ok: false, reason: 'malformed' }
  const s = a as Partial<SignedAnswer>
  if (s.alg !== 'ed25519' || typeof s.keyId !== 'string' || typeof s.payload !== 'string' || typeof s.signature !== 'string') return { ok: false, reason: 'malformed' }
  if (s.payload.length > 16_384 || s.signature.length > 200) return { ok: false, reason: 'malformed' }
  const k = trusted.find((t) => t.id === s.keyId)
  if (!k) return { ok: false, reason: 'untrusted-key' }
  const bytes = Buffer.from(s.payload, 'base64')
  let good = false
  try {
    good = verify(null, bytes, k.key, Buffer.from(s.signature, 'base64'))
  } catch {
    good = false
  }
  if (!good) return { ok: false, reason: 'bad-signature' }
  let p: unknown
  try {
    p = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { ok: false, reason: 'bad-payload' }
  }
  const payload = parsePayload(p)
  return payload ? { ok: true, payload, keyId: k.id } : { ok: false, reason: 'bad-payload' }
}

const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)

function parsePayload(v: unknown): LicencePayload | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.v !== ANSWER_VERSION) return null
  if (typeof o.licenceId !== 'string' || typeof o.installId !== 'string' || typeof o.nonce !== 'string') return null
  if (!(LICENCE_STATUSES as readonly string[]).includes(String(o.status))) return null
  const issuedAt = iso(o.issuedAt), validUntil = iso(o.validUntil), serverTime = iso(o.serverTime)
  if (!issuedAt || !validUntil || !serverTime) return null
  const seats = o.seats === null ? null : parseSeats(o.seats)
  if (o.seats !== null && !seats) return null
  const kind = o.kind === 'subscription' || o.kind === 'lifetime' ? o.kind : null
  return {
    v: 1, licenceId: o.licenceId, installId: o.installId, status: o.status as LicenceStatus,
    plan: typeof o.plan === 'string' ? o.plan.slice(0, 60) : null, kind, seats,
    paidUntil: iso(o.paidUntil), maintenanceUntil: iso(o.maintenanceUntil),
    noticeDays: Number.isInteger(o.noticeDays) ? (o.noticeDays as number) : 0,
    readOnlyFrom: iso(o.readOnlyFrom), message: typeof o.message === 'string' ? o.message.slice(0, 300) : '',
    issuedAt, validUntil, serverTime, nonce: o.nonce,
  }
}

/** for logs: never the whole answer or key (a short fingerprint only) */
export const shortId = (s: string): string => (s.length > 12 ? `${s.slice(0, 8)}...` : s)
