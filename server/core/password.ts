/**
 * Password hashing: scrypt N=32768 r=8 p=1 keylen 64, 16-byte salt.
 * Stored as "scrypt$32768$8$1$<salt b64>$<hash b64>". Verification is constant time.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { HttpError } from './contracts.ts'

const N = 32768
const R = 8
const P = 1
const KEYLEN = 64
const MAXMEM = 128 * 1024 * 1024
export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 1024

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, N, R, P, KEYLEN)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false
  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  if (expected.length < 16) return false
  const actual = await scryptAsync(password, salt, n, r, p, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

let dummyHash: Promise<string> | null = null
/** burns the same time as a real verification (unknown email: same timing and same answer) */
export async function verifyDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing')
  await verifyPassword(password, await dummyHash)
  return false
}

/** throws HttpError(422) when the password does not meet the policy */
export function checkPasswordPolicy(password: unknown, email?: string, field = 'password'): string {
  if (typeof password !== 'string') throw new HttpError(422, 'invalid', 'Password is required.', field)
  if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(422, 'invalid', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, field)
  if (password.length > MAX_PASSWORD_LENGTH) throw new HttpError(422, 'invalid', 'Password is too long.', field)
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) {
    throw new HttpError(422, 'invalid', 'Password must not be the same as the email address.', field)
  }
  return password
}
