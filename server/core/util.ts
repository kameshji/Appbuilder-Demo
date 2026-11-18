/** Small shared helpers for the server core. */
import { randomBytes, randomUUID } from 'node:crypto'

export function uid(prefix?: string): string {
  if (!prefix) return randomUUID()
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

export const nowIso = (): string => new Date().toISOString()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** DATETIME values from the driver (Date, or "YYYY-MM-DD hh:mm:ss[.fff]" in UTC) -> ISO string */
export function toIso(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) {
    const d = new Date(s.replace(' ', 'T') + 'Z')
    return Number.isNaN(d.getTime()) ? s : d.toISOString()
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

/** ISO text / Date -> Date for DATETIME(3) parameters (stored as UTC by the driver). */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export type LogLevel = 'info' | 'warn' | 'error'

let quiet = false
/** tests silence the console */
export function setQuiet(q: boolean): void {
  quiet = q
}

export function log(level: LogLevel, msg: string): void {
  if (quiet && level !== 'error') return
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/** error -> loggable text without the stack of SQL parameters (never log secrets) */
export function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    return `${code ? `[${String(code)}] ` : ''}${e.message}`
  }
  return String(e)
}

export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/* ------------------------------------------------------------------ row ids */

let lastMs = 0
let seq = 0

/**
 * Row id: a UUIDv7 (RFC 9562) — 48-bit Unix ms time, then a 12-bit counter, then random bits. Monotonic within this
 * process (the counter orders ids created in the same millisecond), so `ORDER BY createdOn, id` is insertion order.
 */
export function rowUid(now = Date.now()): string {
  if (now > lastMs) {
    lastMs = now
    seq = 0
  } else {
    seq++
    if (seq > 0xfff) {
      lastMs++
      seq = 0
    }
  }
  const b = randomBytes(16)
  const ms = lastMs
  b[0] = Math.floor(ms / 2 ** 40) & 0xff
  b[1] = Math.floor(ms / 2 ** 32) & 0xff
  b[2] = (ms >>> 24) & 0xff
  b[3] = (ms >>> 16) & 0xff
  b[4] = (ms >>> 8) & 0xff
  b[5] = ms & 0xff
  b[6] = 0x70 | ((seq >>> 8) & 0x0f)
  b[7] = seq & 0xff
  b[8] = 0x80 | (b[8] & 0x3f)
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
