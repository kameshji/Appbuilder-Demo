/**
 * Values of flows between the formula engine, the database and the API (docs/dev/flows.md "Payloads"):
 *  - stored form (ab_flow_steps.output, ab_flow_runs.variables / trigger): JSON with dates as {"$d": "<ISO>"} so a value
 *    read back is the value the formula produced (a date stays a date);
 *  - plain JSON (API answers, action inputs, webhook bodies): dates as ISO text, single-column tables of Value as lists;
 *  - display form (run detail): secrets redacted, capped at FLOW_LIMITS.displayBytes.
 */
import type { FxRecord, FxValue } from '../../../src/contracts.ts'
import { isRecord } from '../../../src/fx/values.ts'
import { FLOW_LIMITS } from '../../../src/platform/flows.ts'

type J = null | boolean | number | string | J[] | { [k: string]: J }

/** Fx -> stored JSON (dates tagged) */
export function toStored(v: FxValue | undefined): J {
  if (v === undefined || v === null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { $d: v.toISOString() }
  if (Array.isArray(v)) return v.map((x) => toStored(x))
  if (typeof v === 'object') {
    const o: Record<string, J> = {}
    for (const [k, x] of Object.entries(v)) o[k] = toStored(x)
    return o
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null
  return v as J
}

/** stored JSON -> Fx */
export function fromStored(j: unknown): FxValue {
  if (j === null || j === undefined) return null
  if (Array.isArray(j)) return j.map((x) => fromStored(x))
  if (typeof j === 'object') {
    const o = j as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 1 && keys[0] === '$d' && typeof o.$d === 'string') {
      const d = new Date(o.$d)
      return Number.isNaN(d.getTime()) ? null : d
    }
    const out: FxRecord = {}
    for (const k of keys) out[k] = fromStored(o[k])
    return out
  }
  return j as FxValue
}

/** plain JSON (API, webhook body, action output) -> Fx: objects are records, lists of scalars are tables of Value */
export function jsonToFx(j: unknown, depth = 0): FxValue {
  if (depth > 64) return null
  if (j === null || j === undefined) return null
  if (Array.isArray(j)) return j.map((x) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? jsonToFx(x, depth + 1) : { Value: jsonToFx(x, depth + 1) }))
  if (typeof j === 'object') {
    const out: FxRecord = {}
    for (const [k, x] of Object.entries(j as Record<string, unknown>)) if (k !== '__proto__') out[k] = jsonToFx(x, depth + 1)
    return out
  }
  if (typeof j === 'number' || typeof j === 'string' || typeof j === 'boolean') return j
  return String(j)
}

/** Fx -> plain JSON: dates as ISO text, a table whose rows are only {Value} becomes a list, __id is dropped */
export function fxToJson(v: FxValue | undefined, depth = 0): J {
  if (depth > 64 || v === undefined || v === null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (Array.isArray(v)) {
    if (v.every((x) => isRecord(x) && Object.keys(x).filter((k) => k !== '__id').length === 1 && 'Value' in x)) return v.map((x) => fxToJson((x as FxRecord).Value, depth + 1))
    return v.map((x) => fxToJson(x, depth + 1))
  }
  if (typeof v === 'object') {
    const o: Record<string, J> = {}
    for (const [k, x] of Object.entries(v)) if (k !== '__id') o[k] = fxToJson(x, depth + 1)
    return o
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null
  return v as J
}

/** byte size of a stored value (JSON text length; UTF-16 units are close enough for the caps) */
export const sizeOf = (j: unknown): number => (j === undefined ? 0 : (JSON.stringify(j) ?? '').length)

const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|token|x-auth-token|signature|x-signature|x-hub-signature(-256)?)$/i
export const REDACTED = '[redacted]'

/** a deep copy with secret-looking keys replaced (headers, connection settings) */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 64 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? REDACTED : redact(x, depth + 1)
  return out
}

/** what the run detail stores and shows of an input: redacted, then capped */
export function forDisplay(v: unknown, cap: number = FLOW_LIMITS.displayBytes): { value: unknown; truncated: boolean } {
  const r = redact(v)
  const text = JSON.stringify(r ?? null) ?? 'null'
  if (text.length <= cap) return { value: r ?? null, truncated: false }
  return { value: { truncated: true, size: text.length, preview: text.slice(0, Math.min(cap, 4000)) }, truncated: true }
}

/** a short human text of a value (trigger summaries, messages) */
export function shortText(v: unknown, max = 120): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null) ?? ''
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export { isRecord }
