/**
 * OpenAPI 3 import for the HTTP connector: an OpenAPI 3.0 / 3.1 document (JSON or YAML, at most 2 MB) becomes custom
 * actions of a connection. Supported subset:
 *
 *  - servers[0].url (suggested base URL; relative server URLs and server variables use their defaults)
 *  - paths with get, post, put, patch, delete, head; operationId (else method + path) as the action id
 *  - parameters in path, query and header (path-level and operation-level, $ref to components.parameters); cookie
 *    parameters are skipped with a warning
 *  - requestBody with application/json (or a +json type): one input `body`; other body types are skipped with a warning
 *  - responses: the first 2xx response with a JSON schema becomes the output schema
 *  - schemas: type (3.0 `nullable` and 3.1 type lists), properties, required, items, enum, format, length and range
 *    limits, simple patterns, default, description, allOf (merged), oneOf / anyOf (anyOf); local $refs
 *    (#/components/...) resolved with cycles cut (a recursive part becomes "any value")
 *  - securitySchemes: apiKey (header or query), http basic, http bearer, oauth2 clientCredentials -> suggested
 *    connection authentication. OAuth authorization code and OpenID Connect are not supported (warning).
 *
 * Not supported: Swagger 2.0 (convert it to OpenAPI 3 first), external $refs, callbacks, links, webhooks, XML,
 * multipart bodies, discriminators (treated as anyOf).
 */
import * as yaml from 'js-yaml'
import type { JsonSchema, JsonType } from './contracts.ts'
import type { CustomHttpAction, HttpActionSpec } from './http.ts'
import { checkSchema } from './schema.ts'

export const OPENAPI_MAX_BYTES = 2 * 1024 * 1024
export const OPENAPI_MAX_ACTIONS = 300

export interface OpenApiImport {
  title: string
  version: string
  baseUrl: string | null
  /** suggested connection authentication (settings without secrets) */
  auth: Record<string, string> | null
  actions: CustomHttpAction[]
  warnings: string[]
}

export class OpenApiError extends Error {}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const

export function parseDocument(text: string): Obj {
  if (Buffer.byteLength(text) > OPENAPI_MAX_BYTES) throw new OpenApiError('The document is larger than 2 MB.')
  let doc: unknown
  const t = text.trim()
  try {
    doc = t.startsWith('{') ? JSON.parse(t) : yaml.load(t, { json: true })
  } catch (e) {
    throw new OpenApiError(`The document is not valid JSON or YAML: ${(e as Error).message.split('\n')[0].slice(0, 200)}`)
  }
  if (!isObj(doc)) throw new OpenApiError('The document is not an OpenAPI object.')
  if (typeof doc.swagger === 'string') throw new OpenApiError('This is a Swagger 2.0 document; only OpenAPI 3 is supported. Convert it first (for example with the Swagger Editor: Edit > Convert to OpenAPI 3).')
  if (typeof doc.openapi !== 'string' || !/^3\./.test(doc.openapi)) throw new OpenApiError('The document has no "openapi: 3.x" version.')
  if (!isObj(doc.paths)) throw new OpenApiError('The document has no paths.')
  return doc
}

function pointer(doc: Obj, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let cur: unknown = doc
  for (const raw of ref.slice(2).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isObj(cur) && !Array.isArray(cur)) return undefined
    cur = (cur as Obj)[part]
  }
  return cur
}

/** follows $ref chains (local only) */
function deref(doc: Obj, v: unknown, warnings: Set<string>, depth = 0): unknown {
  if (depth > 20) return undefined
  if (isObj(v) && typeof v.$ref === 'string') {
    if (!v.$ref.startsWith('#/')) {
      warnings.add(`External references (${v.$ref.slice(0, 80)}) are not followed.`)
      return undefined
    }
    return deref(doc, pointer(doc, v.$ref), warnings, depth + 1)
  }
  return v
}

const SCALAR_KEYS = ['description', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'enum', 'default', 'title'] as const

function convertSchema(doc: Obj, raw: unknown, warnings: Set<string>, seen: string[] = [], depth = 0): JsonSchema {
  if (depth > 10) return {}
  if (isObj(raw) && typeof raw.$ref === 'string') {
    if (seen.includes(raw.$ref)) return { description: 'recursive structure' }
    return convertSchema(doc, deref(doc, raw, warnings), warnings, [...seen, raw.$ref], depth + 1)
  }
  if (!isObj(raw)) return {}
  const out: JsonSchema = {}
  if (Array.isArray(raw.allOf)) {
    const merged: JsonSchema = { type: 'object', properties: {}, required: [] }
    for (const part of raw.allOf) {
      const c = convertSchema(doc, part, warnings, seen, depth + 1)
      Object.assign(merged.properties!, c.properties ?? {})
      merged.required!.push(...(c.required ?? []))
      if (c.description && !merged.description) merged.description = c.description
    }
    if (!merged.required!.length) delete merged.required
    return merged
  }
  const alts = Array.isArray(raw.oneOf) ? raw.oneOf : Array.isArray(raw.anyOf) ? raw.anyOf : null
  if (alts) {
    out.anyOf = alts.slice(0, 10).map((a) => convertSchema(doc, a, warnings, seen, depth + 1))
    if (typeof raw.description === 'string') out.description = raw.description
    return out
  }
  let types: string[] = Array.isArray(raw.type) ? raw.type.map(String) : typeof raw.type === 'string' ? [raw.type] : []
  if (raw.nullable === true && types.length) types = [...types, 'null']
  const known = types.filter((t) => ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(t)) as JsonType[]
  if (known.length === 1) out.type = known[0]
  else if (known.length > 1) out.type = known
  for (const k of SCALAR_KEYS) if (raw[k] !== undefined) (out as Record<string, unknown>)[k] = raw[k]
  if (typeof out.description === 'string') out.description = out.description.slice(0, 500)
  if (isObj(raw.properties)) {
    out.properties = {}
    for (const [k, v] of Object.entries(raw.properties).slice(0, 100)) {
      const pv = deref(doc, v, warnings)
      if (isObj(pv) && pv.readOnly === true && depth === 0) continue
      out.properties[k] = convertSchema(doc, v, warnings, seen, depth + 1)
    }
    if (!out.type) out.type = 'object'
  }
  if (Array.isArray(raw.required)) out.required = raw.required.filter((r): r is string => typeof r === 'string' && !!out.properties?.[r])
  if (raw.items !== undefined) out.items = convertSchema(doc, raw.items, warnings, seen, depth + 1)
  if (raw.additionalProperties === false) out.additionalProperties = false
  else if (isObj(raw.additionalProperties)) out.additionalProperties = convertSchema(doc, raw.additionalProperties, warnings, seen, depth + 1)
  if (out.pattern && checkSchema({ pattern: out.pattern }).length) {
    warnings.add('Some patterns were too complex and were left out.')
    delete out.pattern
  }
  return out
}

const inputName = (name: string, taken: Set<string>): string => {
  let base = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1').slice(0, 60) || 'value'
  if (base === 'body' || base === '__proto__' || base === 'constructor') base = `${base}_`
  let n = base
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base}_${i}`
  taken.add(n.toLowerCase())
  return n
}

const actionId = (op: Obj, method: string, path: string, taken: Set<string>): string => {
  let base = typeof op.operationId === 'string' && op.operationId.trim() ? op.operationId.trim() : `${method}_${path}`
  base = base.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z]+/, '').replace(/_+$/, '').slice(0, 60) || `${method}_op`
  if (base.toLowerCase() === 'request') base = 'request_op'
  let id = base
  for (let i = 2; taken.has(id.toLowerCase()); i++) id = `${base.slice(0, 58)}_${i}`
  taken.add(id.toLowerCase())
  return id
}

function jsonContent(content: unknown): Obj | null {
  if (!isObj(content)) return null
  for (const [type, v] of Object.entries(content)) if (/^application\/(.+\+)?json\b/i.test(type) && isObj(v)) return v
  return null
}

function baseUrlOf(doc: Obj, source?: string): string | null {
  const s = Array.isArray(doc.servers) ? doc.servers[0] : null
  if (!isObj(s) || typeof s.url !== 'string') return null
  let url = s.url
  if (isObj(s.variables)) for (const [k, v] of Object.entries(s.variables)) if (isObj(v) && v.default !== undefined) url = url.split(`{${k}}`).join(String(v.default))
  try {
    return new URL(url, source).toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function authOf(doc: Obj, warnings: Set<string>): Record<string, string> | null {
  const comps = isObj(doc.components) ? doc.components : {}
  const schemes = isObj(comps.securitySchemes) ? comps.securitySchemes : {}
  // the schemes the document uses globally first, then any
  const order: string[] = []
  for (const req of Array.isArray(doc.security) ? doc.security : []) if (isObj(req)) order.push(...Object.keys(req))
  order.push(...Object.keys(schemes))
  for (const name of [...new Set(order)]) {
    const s = deref(doc, schemes[name], warnings)
    if (!isObj(s)) continue
    if (s.type === 'apiKey' && (s.in === 'header' || s.in === 'query') && typeof s.name === 'string') return { authMode: 'apiKey', apiKeyIn: s.in, apiKeyName: s.name }
    if (s.type === 'http' && String(s.scheme).toLowerCase() === 'basic') return { authMode: 'basic' }
    if (s.type === 'http' && String(s.scheme).toLowerCase() === 'bearer') return { authMode: 'bearer' }
    if (s.type === 'oauth2' && isObj(s.flows) && isObj(s.flows.clientCredentials) && typeof s.flows.clientCredentials.tokenUrl === 'string') {
      const scopes = isObj(s.flows.clientCredentials.scopes) ? Object.keys(s.flows.clientCredentials.scopes).join(' ') : ''
      return { authMode: 'oauth2cc', tokenUrl: s.flows.clientCredentials.tokenUrl, ...(scopes ? { scope: scopes } : {}) }
    }
    if (s.type === 'oauth2' || s.type === 'openIdConnect') warnings.add(`The security scheme "${name}" (${String(s.type)} with user sign-in) is not supported; OAuth 2.0 client credentials, API keys, basic and bearer are.`)
  }
  return null
}

/** the document -> custom actions of an HTTP connection */
export function importOpenApi(text: string, o: { source?: string } = {}): OpenApiImport {
  const doc = parseDocument(text)
  const warnings = new Set<string>()
  const info = isObj(doc.info) ? doc.info : {}
  const ids = new Set<string>()
  const actions: CustomHttpAction[] = []
  let skipped = 0
  for (const [path, rawItem] of Object.entries(doc.paths as Obj)) {
    const item = deref(doc, rawItem, warnings)
    if (!isObj(item) || !path.startsWith('/')) continue
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    for (const method of METHODS) {
      const op = item[method]
      if (!isObj(op)) continue
      if (actions.length >= OPENAPI_MAX_ACTIONS) {
        skipped++
        continue
      }
      const id = actionId(op, method, path, ids)
      const taken = new Set<string>(['body'])
      const props: Record<string, JsonSchema> = {}
      const required: string[] = []
      const params: NonNullable<HttpActionSpec['params']> = []
      let tpl = path
      const all = new Map<string, Obj>()
      for (const p of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const r = deref(doc, p, warnings)
        if (isObj(r) && typeof r.name === 'string' && typeof r.in === 'string') all.set(`${r.in}:${r.name}`, r)
      }
      for (const p of all.values()) {
        const where = String(p.in)
        const name = String(p.name)
        if (where === 'cookie') {
          warnings.add('Cookie parameters are not supported and were left out.')
          continue
        }
        if (!['path', 'query', 'header'].includes(where)) continue
        const input = inputName(name, taken)
        const schema = convertSchema(doc, p.schema ?? jsonContent(p.content)?.schema, warnings)
        if (typeof p.description === 'string' && !schema.description) schema.description = p.description.slice(0, 500)
        props[input] = { ...schema, title: name }
        if (where === 'path') {
          tpl = tpl.split(`{${name}}`).join(`{{${input}}}`)
          required.push(input)
        } else {
          params.push({ name, in: where as 'query' | 'header', input })
          if (p.required === true) required.push(input)
        }
      }
      if (/\{[^{}]+\}/.test(tpl.replace(/\{\{[^{}]+\}\}/g, ''))) {
        warnings.add(`${method.toUpperCase()} ${path}: a path placeholder has no parameter; the operation was skipped.`)
        ids.delete(id.toLowerCase())
        continue
      }
      let bodyInput: string | undefined
      const rb = deref(doc, op.requestBody, warnings)
      if (isObj(rb)) {
        const jc = jsonContent(rb.content)
        if (jc) {
          props.body = { ...convertSchema(doc, jc.schema, warnings), title: 'Body' }
          if (typeof rb.description === 'string' && !props.body.description) props.body.description = rb.description.slice(0, 500)
          bodyInput = 'body'
          if (rb.required === true) required.push('body')
        } else if (isObj(rb.content) && Object.keys(rb.content).length) {
          warnings.add(`${method.toUpperCase()} ${path}: only JSON request bodies are supported (${Object.keys(rb.content).join(', ').slice(0, 80)}); the body was left out.`)
        }
      }
      let outputs: JsonSchema = {}
      const responses = isObj(op.responses) ? op.responses : {}
      for (const code of Object.keys(responses).sort()) {
        if (!/^2(\d\d|XX)$/i.test(code)) continue
        const resp = deref(doc, responses[code], warnings)
        const jc = isObj(resp) ? jsonContent(resp.content) : null
        if (jc?.schema) {
          outputs = convertSchema(doc, jc.schema, warnings)
          break
        }
      }
      const inputs: JsonSchema = { type: 'object', properties: props, additionalProperties: false, ...(required.length ? { required } : {}) }
      const problems = [...checkSchema(inputs, 'inputs'), ...checkSchema(outputs, 'outputs')]
      if (problems.length) {
        warnings.add(`${method.toUpperCase()} ${path}: the schemas are too large or complex (${problems[0]}); the operation was skipped.`)
        ids.delete(id.toLowerCase())
        continue
      }
      const readOnly = method === 'get' || method === 'head'
      const summary = typeof op.summary === 'string' ? op.summary.trim() : ''
      const desc = typeof op.description === 'string' ? op.description.trim() : ''
      actions.push({
        id,
        title: (summary || `${method.toUpperCase()} ${path}`).slice(0, 200),
        description: (desc || summary || `${method.toUpperCase()} ${path}`).slice(0, 2000),
        inputs,
        outputs,
        idempotent: readOnly || method === 'put' || method === 'delete',
        sideEffect: readOnly ? 'none' : 'external',
        timeoutMs: 30_000,
        origin: 'custom',
        http: { method: method.toUpperCase() as HttpActionSpec['method'], path: tpl, ...(params.length ? { params } : {}), ...(bodyInput ? { bodyInput } : {}) },
      })
    }
  }
  if (skipped) warnings.add(`Only the first ${OPENAPI_MAX_ACTIONS} operations were imported (${skipped} more were left out).`)
  return {
    title: typeof info.title === 'string' ? info.title.slice(0, 200) : 'Imported API',
    version: typeof info.version === 'string' ? info.version.slice(0, 50) : '',
    baseUrl: baseUrlOf(doc, o.source),
    auth: authOf(doc, warnings),
    actions,
    warnings: [...warnings],
  }
}
