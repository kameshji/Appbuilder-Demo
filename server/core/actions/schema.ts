/**
 * A small JSON Schema validator for action inputs and outputs (the subset listed on `JsonSchema` in contracts.ts) and a
 * checker for schemas that makers write (custom actions, OpenAPI imports). No dependency: ajv would work (MIT) but
 * compiles schemas to code with `new Function`, and the subset here is all actions need.
 *
 * validate(): returns the value with defaults applied (objects are copied, never mutated) or the list of problems, each
 * with a path such as `body.items[2].qty`. Integers are numbers without a fraction. Formats: email, uri (http/https),
 * date (YYYY-MM-DD), date-time (ISO 8601 with zone). Patterns from makers are checked by checkSchema() (length, no
 * nested quantifiers) and run only on strings that are at most 10,000 characters long.
 */
import type { JsonSchema, JsonType } from './contracts.ts'

export interface SchemaProblem { path: string; message: string }

const MAX_DEPTH = 32
const MAX_PATTERN_INPUT = 10_000
const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i

const typeOf = (v: unknown): JsonType => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v as JsonType
}
const typeMatches = (t: JsonType, v: unknown): boolean => {
  const actual = typeOf(v)
  if (t === 'number') return actual === 'number' || actual === 'integer'
  return t === actual
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const at = (path: string, key: string | number): string => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key)
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const label = (path: string): string => (path ? `"${path}"` : 'The value')

const patternCache = new Map<string, RegExp | null>()
function compiled(p: string): RegExp | null {
  if (!patternCache.has(p)) {
    let re: RegExp | null = null
    try {
      re = new RegExp(p, 'u')
    } catch {
      re = null
    }
    if (patternCache.size > 500) patternCache.clear()
    patternCache.set(p, re)
  }
  return patternCache.get(p)!
}

function checkFormat(format: string, s: string): boolean {
  switch (format) {
    case 'email': return s.length <= 254 && EMAIL.test(s)
    case 'date': { const t = Date.parse(s + 'T00:00:00Z'); return DATE.test(s) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s }
    case 'date-time': return DATETIME.test(s) && !Number.isNaN(Date.parse(s))
    case 'uri': try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
    default: return true
  }
}

function walk(schema: JsonSchema, value: unknown, path: string, out: SchemaProblem[], depth: number, defaults: boolean): unknown {
  if (depth > MAX_DEPTH) {
    out.push({ path, message: `${label(path)} is nested too deeply.` })
    return value
  }
  if (schema.anyOf?.length) {
    for (const alt of schema.anyOf) {
      const sub: SchemaProblem[] = []
      const v = walk(alt, value, path, sub, depth + 1, defaults)
      if (!sub.length) return v
    }
    out.push({ path, message: `${label(path)} does not match any of the allowed forms.` })
    return value
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    out.push({ path, message: `${label(path)} must be ${JSON.stringify(schema.const)}.` })
    return value
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    out.push({ path, message: `${label(path)} must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(', ').slice(0, 300)}.` })
    return value
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => typeMatches(t, value))) {
      out.push({ path, message: `${label(path)} must be ${types.map((t) => (t === 'integer' ? 'a whole number' : t === 'array' ? 'a list' : t === 'object' ? 'an object' : t === 'null' ? 'empty' : `a ${t}`)).join(' or ')}.` })
      return value
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) out.push({ path, message: schema.minLength === 1 ? `${label(path)} must not be empty.` : `${label(path)} must be at least ${schema.minLength} characters long.` })
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) out.push({ path, message: `${label(path)} must be at most ${schema.maxLength} characters long.` })
    if (schema.format && !checkFormat(schema.format, value)) out.push({ path, message: `${label(path)} is not a valid ${schema.format === 'uri' ? 'web address' : schema.format}.` })
    if (schema.pattern) {
      const re = compiled(schema.pattern)
      if (!re) out.push({ path, message: `${label(path)} has an invalid pattern in its schema.` })
      else if (value.length > MAX_PATTERN_INPUT || !re.test(value)) out.push({ path, message: `${label(path)} does not have the expected form.` })
    }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push({ path, message: `${label(path)} must be a finite number.` })
    if (schema.minimum !== undefined && value < schema.minimum) out.push({ path, message: `${label(path)} must be at least ${schema.minimum}.` })
    if (schema.maximum !== undefined && value > schema.maximum) out.push({ path, message: `${label(path)} must be at most ${schema.maximum}.` })
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) out.push({ path, message: `${label(path)} must be more than ${schema.exclusiveMinimum}.` })
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) out.push({ path, message: `${label(path)} must be less than ${schema.exclusiveMaximum}.` })
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push({ path, message: `${label(path)} needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}.` })
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push({ path, message: `${label(path)} may have at most ${schema.maxItems} items.` })
    if (schema.items) return value.map((v, i) => walk(schema.items!, v, at(path, i), out, depth + 1, defaults))
    return value
  }
  if (isObj(value) && (schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    const props = schema.properties ?? {}
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        out.push({ path: at(path, k), message: `"${k}" is not allowed as a name.` })
        continue
      }
      const ps = props[k]
      if (ps) result[k] = walk(ps, v, at(path, k), out, depth + 1, defaults)
      else if (schema.additionalProperties === false) out.push({ path: at(path, k), message: `${label(at(path, k))} is not an input of this action.` })
      else if (isObj(schema.additionalProperties)) result[k] = walk(schema.additionalProperties, v, at(path, k), out, depth + 1, defaults)
      else result[k] = v
    }
    if (defaults) {
      for (const [k, ps] of Object.entries(props)) {
        if (result[k] === undefined && ps.default !== undefined) result[k] = structuredClone(ps.default)
      }
    }
    for (const r of schema.required ?? []) {
      if (result[r] === undefined || result[r] === null) out.push({ path: at(path, r), message: `${label(at(path, r))} is required.` })
    }
    return result
  }
  return value
}

/** validates (and fills defaults); problems are empty when the value fits */
export function validate(schema: JsonSchema, value: unknown, o: { defaults?: boolean } = {}): { ok: true; value: unknown } | { ok: false; problems: SchemaProblem[] } {
  const problems: SchemaProblem[] = []
  const v = walk(schema, value === undefined && schema.type === 'object' ? {} : value, '', problems, 0, o.defaults !== false)
  return problems.length ? { ok: false, problems } : { ok: true, value: v }
}

/** "a, b and 2 more problems" for messages */
export function problemText(problems: SchemaProblem[], max = 3): string {
  const shown = problems.slice(0, max).map((p) => p.message)
  const rest = problems.length - shown.length
  return shown.join(' ') + (rest > 0 ? ` (and ${rest} more problem${rest === 1 ? '' : 's'})` : '')
}

/* ------------------------------------------------------------------ schemas from makers */

const KNOWN_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])
/** a quantified group that itself contains a quantifier: (a+)+, (\w*)*, (x{1,9})+ ... (catastrophic backtracking) */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/

/**
 * A schema a maker wrote (or an OpenAPI import produced): plain JSON, at most 64 KB, 12 levels, 300 properties in all,
 * known types, valid and simple patterns. Returns problems (empty = fine).
 */
export function checkSchema(schema: unknown, path = 'schema'): string[] {
  const problems: string[] = []
  let size = 0
  try {
    size = JSON.stringify(schema ?? null).length
  } catch {
    return [`${path} is not plain JSON.`]
  }
  if (size > 64 * 1024) return [`${path} is too large (at most 64 KB).`]
  let props = 0
  const visit = (s: unknown, p: string, depth: number) => {
    if (problems.length > 20) return
    if (!isObj(s)) {
      problems.push(`${p} must be an object.`)
      return
    }
    if (depth > 12) {
      problems.push(`${p} is nested too deeply.`)
      return
    }
    const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]
    for (const t of types) if (typeof t !== 'string' || !KNOWN_TYPES.has(t)) problems.push(`${p}.type "${String(t)}" is not a known type.`)
    if (s.pattern !== undefined) {
      if (typeof s.pattern !== 'string' || s.pattern.length > 200) problems.push(`${p}.pattern must be text of at most 200 characters.`)
      else if (!compiled(s.pattern)) problems.push(`${p}.pattern is not a valid regular expression.`)
      else if (NESTED_QUANTIFIER.test(s.pattern) || /\\[1-9]/.test(s.pattern)) problems.push(`${p}.pattern is too complex (nested repetition or back-references).`)
    }
    for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
      if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k]))) problems.push(`${p}.${k} must be a number.`)
    }
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string'))) problems.push(`${p}.required must be a list of names.`)
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length > 500)) problems.push(`${p}.enum must be a list (at most 500 values).`)
    if (s.properties !== undefined) {
      if (!isObj(s.properties)) problems.push(`${p}.properties must be an object.`)
      else for (const [k, v] of Object.entries(s.properties)) {
        if (++props > 300) {
          problems.push(`${path} has too many properties (at most 300).`)
          return
        }
        if (k === '__proto__' || k === 'constructor' || k === 'prototype' || !k || k.length > 100) problems.push(`${p}.properties: "${k.slice(0, 40)}" is not allowed as a name.`)
        visit(v, `${p}.properties.${k}`, depth + 1)
      }
    }
    if (s.items !== undefined) visit(s.items, `${p}.items`, depth + 1)
    if (isObj(s.additionalProperties)) visit(s.additionalProperties, `${p}.additionalProperties`, depth + 1)
    if (Array.isArray(s.anyOf)) s.anyOf.slice(0, 20).forEach((a, i) => visit(a, `${p}.anyOf[${i}]`, depth + 1))
  }
  visit(schema, path, 0)
  return problems
}

/** a schema that describes a sample value (custom actions: "paste a sample response") */
export function inferSchema(sample: unknown, depth = 0): JsonSchema {
  if (depth > 8) return {}
  const t = typeOf(sample)
  if (t === 'null') return {}
  if (t === 'array') {
    const arr = sample as unknown[]
    return arr.length ? { type: 'array', items: inferSchema(arr[0], depth + 1) } : { type: 'array' }
  }
  if (t === 'object') {
    const properties: Record<string, JsonSchema> = {}
    for (const [k, v] of Object.entries(sample as Record<string, unknown>).slice(0, 100)) properties[k] = inferSchema(v, depth + 1)
    return { type: 'object', properties }
  }
  return { type: t === 'integer' ? 'number' : t }
}
