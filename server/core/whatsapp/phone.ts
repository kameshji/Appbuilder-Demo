/**
 * Phone numbers for WhatsApp: normalised to E.164 (`+<country code><number>`, at most 15 digits) with the connection's
 * default country calling code for numbers written without one, and masked for anyone who is not an administrator.
 *
 * Rules (pure, no number-plan database): spaces, dashes, dots, brackets and a "tel:" prefix are removed; `+` or `00` means
 * the number already has its country code; otherwise a single trunk `0` is dropped and the default country code is put in
 * front. The result must have 8 to 15 digits and must not start with 0. Numbers are not checked against a country's
 * numbering plan: Meta answers "invalid number" for those (mapped to a plain message).
 */

export class PhoneError extends Error {}

/** a calling code setting: 1 to 3 digits, no leading zero (India: 91) */
export function validCountryCode(code: string | undefined): boolean {
  return !!code && /^[1-9]\d{0,2}$/.test(code)
}

export function normalizePhone(input: unknown, defaultCountryCode: string | undefined): string {
  if (typeof input !== 'string' && typeof input !== 'number') throw new PhoneError('A phone number is required.')
  let s = String(input).trim().replace(/^tel:/i, '')
  if (!s) throw new PhoneError('A phone number is required.')
  if (s.length > 40) throw new PhoneError('The phone number is too long.')
  if (/[^0-9+\s().\-/]/.test(s)) throw new PhoneError('A phone number has digits only (with an optional + and the country code).')
  // P2 security re-check (finding P2-9): "+44 (0)20 ..." / "+91 (0) 98..." writes the trunk prefix in brackets; it is not
  // dialled after the country code. Kept, it made a second number for the same phone, so an opt-in recorded in that
  // form survived the person's STOP (recorded for the number Meta reports).
  if (/^\s*(\+|00)/.test(s)) s = s.replace(/\(\s*0\s*\)/g, '')
  s = s.replace(/[\s().\-/]/g, '')
  let digits: string
  if (s.startsWith('+')) digits = s.slice(1)
  else if (s.startsWith('00')) digits = s.slice(2)
  else {
    if (!validCountryCode(defaultCountryCode)) throw new PhoneError('Write the number with its country code (for example +91 ...): the connection has no default country code.')
    digits = defaultCountryCode + (s.startsWith('0') ? s.slice(1) : s)
  }
  if (!/^\d+$/.test(digits)) throw new PhoneError('A phone number has digits only (with an optional + and the country code).')
  if (digits.startsWith('0')) throw new PhoneError('The country code of a phone number does not start with 0.')
  if (digits.length < 8 || digits.length > 15) throw new PhoneError('A phone number with its country code has 8 to 15 digits.')
  return `+${digits}`
}

/** "+919876543210" -> "+91 •••••••210": the country code and the last three digits */
export function maskPhone(e164: string): string {
  const d = e164.replace(/^\+/, '')
  if (d.length < 6) return '•••'
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : d.slice(0, 1)
  return `+${cc} ${'•'.repeat(Math.max(3, d.length - cc.length - 3))}${d.slice(-3)}`
}

/** the form Meta's API takes in `to` (digits, no +) */
export const graphNumber = (e164: string): string => e164.replace(/^\+/, '')
