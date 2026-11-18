/**
 * HOTP (RFC 4226) and TOTP (RFC 6238) with Node's crypto, plus Base32 (RFC 4648) for the shared secret.
 *
 * Parameters used for enrolment (what every authenticator app understands): HMAC-SHA1, 6 digits, 30-second steps,
 * a 20-byte (160-bit) random secret. Verification accepts the current step and one step either side (clock drift of up to
 * 30 seconds) and returns the matched step, so the caller can refuse a step that was already used (replay protection).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6
export const TOTP_SECRET_BYTES = 20
/** steps accepted either side of the current one */
export const TOTP_WINDOW = 1

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/** lenient: ignores case, spaces, dashes and padding; throws on any other character */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('Not a Base32 string.')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export type HmacAlgorithm = 'sha1' | 'sha256' | 'sha512'

/** RFC 4226 HOTP value for a counter */
export function hotp(secret: Buffer, counter: number | bigint, digits = TOTP_DIGITS, algorithm: HmacAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(algorithm, secret).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** the TOTP time step of a moment (milliseconds since the epoch) */
export const totpStep = (nowMs: number, stepSeconds = TOTP_STEP_SECONDS): number => Math.floor(nowMs / 1000 / stepSeconds)

/** RFC 6238 TOTP value at a moment */
export function totp(secret: Buffer, nowMs = Date.now(), o: { digits?: number; algorithm?: HmacAlgorithm; stepSeconds?: number } = {}): string {
  return hotp(secret, totpStep(nowMs, o.stepSeconds), o.digits ?? TOTP_DIGITS, o.algorithm ?? 'sha1')
}

/**
 * Checks a code against the steps around now (constant-time comparison per step). Returns the matched step or null.
 * The caller must store the step and refuse any step that is not newer than the last one accepted (replay).
 */
export function verifyTotp(secret: Buffer, code: string, nowMs = Date.now(), window = TOTP_WINDOW): number | null {
  const given = String(code ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(given)) return null
  const now = totpStep(nowMs)
  let found: number | null = null
  // check every step in the window (no early exit), so timing does not tell which step matched
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(hotp(secret, now + d))
    if (timingSafeEqual(expected, Buffer.from(given)) && found === null) found = now + d
  }
  return found
}

export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES)
}

/** otpauth:// URI (Key Uri Format understood by authenticator apps): issuer and account label */
export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) })
  return `otpauth://totp/${label}?${q.toString()}`
}

/** "ABCD EFGH ..." for typing the key by hand */
export const groupKey = (b32: string): string => b32.replace(/(.{4})/g, '$1 ').trim()
