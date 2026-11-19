/**
 * Unit tests of connector actions (P1 package D) without a database: JSON Schema validation, templates, the outbound
 * policy against local fake HTTP servers (allow-list, redirects, private addresses, DNS rebinding through the lookup hook,
 * timeouts, response size, TLS verification), the HTTP provider (auth modes, OAuth 2.0 client credentials caching and
 * refresh, custom actions, secrets never in outputs), webhook signatures, OpenAPI import (two real public documents:
 * testdata/petstore3.openapi.json, the Swagger Petstore OpenAPI 3.0 sample, and testdata/uspto.openapi.yaml, the USPTO
 * example of the OpenAPI Initiative; both Apache License 2.0, fetched 18 Nov 2026) and digest scheduling.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { validate, checkSchema, inferSchema } from './schema.ts'
import { renderJson, renderPath, renderText } from './template.ts'
import { OutboundError, allowListProblem, hostAllowed, safeRequest, setLookupForTests, type OutboundPolicy } from './outbound.ts'
import { createHttpProvider, checkCustomAction, checkHttpSettings } from './http.ts'
import { redactDeep } from './service.ts'
import { importOpenApi, OpenApiError } from './openapi.ts'
import { parseSignatureHeader, signPayload, verifySignature } from './webhooks.ts'
import { digestDue, effectiveChannels, defaultPolicy, inQuietHours, latestDigestSlot, parsePolicy, quietEnd, signToken, verifyToken } from '../notifications-delivery.ts'
import { parseNotificationSettings } from '../../../src/platform/live-protocol.ts'
import { toCsv, scheduleCron, parseSchedule } from '../reports.ts'
import { selfSignedCert } from '../identity/fake-smtp.ts'
import type { ConnectionRecord } from '../contracts.ts'
import type { ProviderCall } from './service.ts'

/* ------------------------------------------------------------------ helpers */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
async function server(h: Handler): Promise<{ port: number; close(): Promise<void>; hits: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] }> {
  const hits: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = []
  const s = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      hits.push({ method: req.method!, url: req.url!, headers: req.headers, body: b })
      h(req, res, b)
    })
  })
  await new Promise<void>((r) => s.listen(0, r))
  return { port: (s.address() as AddressInfo).port, hits, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()) }) }
}
const json = (res: http.ServerResponse, status: number, v: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...extra })
  res.end(JSON.stringify(v))
}
const policy = (o: Partial<OutboundPolicy> = {}): OutboundPolicy => ({ allowedHosts: ['127.0.0.1'], allowPrivate: true, maxRedirects: 3, maxResponseBytes: 1024 * 1024, timeoutMs: 5000, verifyTls: true, pins: new Map(), ...o })
const conn = (settings: Record<string, string>, secret?: Record<string, unknown>): ConnectionRecord => ({ id: 'conn_t', name: 'Test API', connector: 'http', status: 'connected', settings: { allowPrivateNetwork: 'true', ...settings }, ...(secret ? { secret: JSON.stringify(secret) } : {}) })
function call(c: ConnectionRecord, actionId: string, inputs: Record<string, unknown>, cache = new Map<string, unknown>(), action?: unknown): ProviderCall {
  const p = createHttpProvider()
  const def = (action ?? p.builtin().find((a) => a.id === actionId)) as ProviderCall['action']
  return { env: 'default', connection: c, action: def, inputs, identity: null, timeoutMs: 5000, signal: new AbortController().signal, services: {} as ProviderCall['services'], cache, note: () => {}, runId: 'run_t' }
}

/* ------------------------------------------------------------------ schema */

describe('JSON Schema subset', () => {
  const s = {
    type: 'object' as const, required: ['name'], additionalProperties: false,
    properties: {
      name: { type: 'string' as const, minLength: 1, maxLength: 5 },
      qty: { type: 'integer' as const, minimum: 1, default: 1 },
      email: { type: 'string' as const, format: 'email' },
      tags: { type: 'array' as const, items: { type: 'string' as const }, maxItems: 2 },
      kind: { enum: ['a', 'b'] },
      when: { type: 'string' as const, format: 'date' },
    },
  }
  it('accepts valid values and fills defaults without mutating', () => {
    const input = { name: 'x' }
    const r = validate(s, input)
    expect(r.ok).toBe(true)
    expect(r.ok && r.value).toEqual({ name: 'x', qty: 1 })
    expect(input).toEqual({ name: 'x' })
  })
  it('reports every problem with its path', () => {
    const r = validate(s, { name: '', qty: 1.5, email: 'nope', tags: ['a', 2, 'c'], kind: 'z', extra: 1, when: '2026-02-30' })
    expect(r.ok).toBe(false)
    const paths = !r.ok ? r.problems.map((p) => p.path) : []
    expect(paths).toEqual(expect.arrayContaining(['name', 'qty', 'email', 'tags', 'tags[1]', 'kind', 'extra', 'when']))
    expect(validate(s, {}).ok).toBe(false)
  })
  it('anyOf, null types, __proto__ keys', () => {
    expect(validate({ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, ['a']).ok).toBe(true)
    expect(validate({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true).ok).toBe(false)
    expect(validate({ type: ['string', 'null'] }, null).ok).toBe(true)
    const evil = JSON.parse('{"__proto__": {"admin": true}}')
    expect(validate({ type: 'object', properties: {} }, evil).ok).toBe(false)
  })
  it('checkSchema refuses dangerous or malformed maker schemas', () => {
    expect(checkSchema({ type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' } } })).toHaveLength(1)
    expect(checkSchema({ type: 'strng' })[0]).toMatch(/not a known type/)
    expect(checkSchema({ type: 'string', pattern: '(' })[0]).toMatch(/not a valid/)
    expect(checkSchema({ type: 'object', properties: { ok: { type: 'string', pattern: '^[A-Z]{2}\\d{4}$' } } })).toEqual([])
  })
  it('infers a schema from a sample', () => {
    expect(inferSchema({ id: 1, name: 'x', tags: ['a'], ok: true })).toEqual({ type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' } } })
  })
})

/* ------------------------------------------------------------------ templates */

describe('templates', () => {
  it('encodes path values as one segment and refuses traversal', () => {
    expect(renderPath('/orders/{{id}}/lines/{{n}}', { id: 'a/b?c', n: 3 })).toBe('/orders/a%2Fb%3Fc/lines/3')
    expect(() => renderPath('/x/{{id}}', { id: '..' })).toThrow(/may not be/)
    expect(() => renderPath('/x/{{id}}', {})).toThrow(/no "id"/)
  })
  it('keeps types for exact JSON placeholders and refuses line breaks in headers', () => {
    expect(renderJson({ a: '{{n}}', b: 'n={{n}}', c: ['{{o}}'] }, { n: 5, o: { x: 1 } })).toEqual({ a: 5, b: 'n=5', c: [{ x: 1 }] })
    expect(() => renderText('{{v}}', { v: 'a\r\nX-Evil: 1' }, 'Header', { header: true })).toThrow(/line breaks/)
    expect(renderText('{{a.b}}', { a: { b: 'deep' } })).toBe('deep')
    expect(() => renderText('{{__proto__.x}}', {})).toThrow()
  })
})

/* ------------------------------------------------------------------ outbound policy */

describe('outbound policy', () => {
  afterEach(() => setLookupForTests(null))

  it('host allow-list matching and entry checks', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true)
    expect(hostAllowed('API.example.com.', ['api.example.com'])).toBe(true)
    expect(hostAllowed('evil-api.example.com', ['api.example.com'])).toBe(false)
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true)
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false)
    expect(hostAllowed('example.com.evil.net', ['*.example.com'])).toBe(false)
    expect(allowListProblem('*')).toMatch(/cannot be/)
    expect(allowListProblem('https://x.com/a')).toMatch(/host name only/)
    expect(allowListProblem('*.com')).toMatch(/too broad/)
    expect(allowListProblem('api.example.com')).toBeNull()
  })

  it('calls an allowed host and refuses other hosts, schemes and credentials in URLs', async () => {
    const s = await server((_q, res) => json(res, 200, { ok: true }))
    try {
      const r = await safeRequest({ method: 'GET', url: `http://127.0.0.1:${s.port}/x` }, policy())
      expect(r.status).toBe(200)
      await expect(safeRequest({ method: 'GET', url: `http://localhost:${s.port}/x` }, policy())).rejects.toMatchObject({ code: 'blocked' })
      await expect(safeRequest({ method: 'GET', url: 'file:///etc/passwd' }, policy())).rejects.toMatchObject({ code: 'blocked' })
      await expect(safeRequest({ method: 'GET', url: `http://u:p@127.0.0.1:${s.port}/` }, policy())).rejects.toMatchObject({ code: 'blocked' })
    } finally {
      await s.close()
    }
  })

  it('refuses private and loopback addresses unless the connection allows them; metadata always', async () => {
    const s = await server((_q, res) => json(res, 200, {}))
    try {
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${s.port}/` }, policy({ allowPrivate: false }))).rejects.toThrow(/private networks/)
      await expect(safeRequest({ method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' }, policy({ allowedHosts: ['169.254.169.254'] }))).rejects.toMatchObject({ code: 'blocked' })
      await expect(safeRequest({ method: 'GET', url: 'http://metadata.google.internal/' }, policy({ allowedHosts: ['metadata.google.internal'] }))).rejects.toMatchObject({ code: 'blocked' })
      // APPBUILDER_OUTBOUND_PRIVATE=deny wins over the connection's opt-in
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${s.port}/` }, policy({ env: { APPBUILDER_OUTBOUND_PRIVATE: 'deny' } }))).rejects.toMatchObject({ code: 'blocked' })
    } finally {
      await s.close()
    }
  })

  it('redirects: re-checked at every hop (allow-list, private addresses), sensitive headers dropped across hosts, limit', async () => {
    let target = ''
    const b = await server((req, res) => json(res, 200, { auth: req.headers.authorization ?? null, key: req.headers['x-api-key'] ?? null }))
    const a = await server((req, res) => {
      if (req.url === '/to-private') { res.writeHead(302, { location: 'http://10.0.0.5/admin' }); return res.end() }
      if (req.url === '/to-other') { res.writeHead(307, { location: target }); return res.end() }
      if (req.url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end() }
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end() }
      json(res, 200, {})
    })
    try {
      target = `http://localhost:${b.port}/landing`
      // not on the allow-list
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${a.port}/to-private` }, policy())).rejects.toThrow(/redirected to 10.0.0.5/)
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${a.port}/to-file` }, policy())).rejects.toMatchObject({ code: 'blocked' })
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${a.port}/loop` }, policy())).rejects.toThrow(/Too many redirects/)
      // a private redirect target on the allow-list is still refused when the connection does not allow private networks
      setLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }])
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${a.port}/to-private` }, policy({ allowedHosts: ['127.0.0.1', '10.0.0.5'], allowPrivate: false }))).rejects.toMatchObject({ code: 'blocked' })
      setLookupForTests(null)
      // allowed other host: Authorization and the API key header are not forwarded
      const r = await safeRequest({ method: 'GET', url: `http://127.0.0.1:${a.port}/to-other`, headers: { authorization: 'Bearer s3cret', 'x-api-key': 'k3y' } }, policy({ allowedHosts: ['127.0.0.1', 'localhost'], sensitiveHeaders: ['x-api-key'] }))
      expect(JSON.parse(r.body.toString())).toEqual({ auth: null, key: null })
      expect(r.redirects).toBe(1)
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('DNS rebinding: a name answering with a refused address is blocked, and the socket uses the pinned answer', async () => {
    const s = await server((_q, res) => json(res, 200, { ok: true }))
    try {
      // the host is on the allow-list, but resolves to loopback while the connection does not allow private networks
      setLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }])
      await expect(safeRequest({ method: 'GET', url: `http://api.rebind.test:${s.port}/` }, policy({ allowedHosts: ['api.rebind.test'], allowPrivate: false }))).rejects.toThrow(/resolved to a loopback/)
      // any refused address in the answer refuses the name (public first, metadata second)
      setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }])
      await expect(safeRequest({ method: 'GET', url: `http://api.rebind.test:${s.port}/` }, policy({ allowedHosts: ['api.rebind.test'] }))).rejects.toThrow(/link-local/)
      // first answer allowed and pinned; the attacker's DNS then switches to the metadata address: the next call (within
      // the pin time) still goes to the checked address, the name is not resolved again; a fresh pin re-checks and refuses
      let lookups = 0
      setLookupForTests(async () => (++lookups === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]))
      const pins = new Map()
      const p = policy({ allowedHosts: ['api.rebind.test'], pins })
      expect((await safeRequest({ method: 'GET', url: `http://api.rebind.test:${s.port}/a` }, p)).status).toBe(200)
      expect((await safeRequest({ method: 'GET', url: `http://api.rebind.test:${s.port}/b` }, p)).status).toBe(200)
      expect(lookups).toBe(1)
      // the name does not exist in real DNS: the request reached the server only through the pinned address
      expect(s.hits.map((h) => h.headers.host)).toEqual([`api.rebind.test:${s.port}`, `api.rebind.test:${s.port}`])
      pins.clear()
      await expect(safeRequest({ method: 'GET', url: `http://api.rebind.test:${s.port}/c` }, p)).rejects.toMatchObject({ code: 'blocked' })
    } finally {
      await s.close()
    }
  })

  it('timeouts, response size (also unpacked) and TLS verification', async () => {
    const big = Buffer.alloc(300 * 1024, 'a')
    const s = await server((req, res) => {
      if (req.url === '/slow') return setTimeout(() => json(res, 200, {}), 2000)
      if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(big) }
      if (req.url === '/chunked') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write(big); return res.end() }
      if (req.url === '/bomb') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024))) }
      json(res, 200, {})
    })
    try {
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${s.port}/slow` }, policy({ timeoutMs: 300 }))).rejects.toMatchObject({ code: 'timeout', retryable: true })
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${s.port}/big` }, policy({ maxResponseBytes: 100 * 1024 }))).rejects.toMatchObject({ code: 'too_large' })
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${s.port}/chunked` }, policy({ maxResponseBytes: 100 * 1024 }))).rejects.toMatchObject({ code: 'too_large' })
      await expect(safeRequest({ method: 'GET', url: `http://127.0.0.1:${s.port}/bomb` }, policy({ maxResponseBytes: 1024 * 1024 }))).rejects.toMatchObject({ code: 'too_large' })
    } finally {
      await s.close()
    }
    const cert = selfSignedCert()
    if (!cert) return
    const t = https.createServer({ key: cert.key, cert: cert.cert }, (_q, res) => json(res, 200, { tls: true }))
    await new Promise<void>((r) => t.listen(0, r))
    const port = (t.address() as AddressInfo).port
    try {
      await expect(safeRequest({ method: 'GET', url: `https://127.0.0.1:${port}/` }, policy())).rejects.toThrow(/certificate/)
      expect((await safeRequest({ method: 'GET', url: `https://127.0.0.1:${port}/` }, policy({ verifyTls: false }))).status).toBe(200)
      expect((await safeRequest({ method: 'GET', url: `https://127.0.0.1:${port}/` }, policy({ ca: cert.cert }))).status).toBe(200)
    } finally {
      t.closeAllConnections()
      await new Promise<void>((r) => t.close(() => r()))
    }
  })
})

/* ------------------------------------------------------------------ HTTP provider */

describe('HTTP connector', () => {
  let api: Awaited<ReturnType<typeof server>>
  let tokens = 0
  let expireNext = false
  beforeAll(async () => {
    api = await server((req, res, body) => {
      const u = new URL(req.url!, 'http://x')
      if (u.pathname === '/oauth/token') {
        tokens++
        const f = new URLSearchParams(body)
        const basic = req.headers.authorization === `Basic ${Buffer.from('cid:csecret').toString('base64')}`
        if (!(basic || (f.get('client_id') === 'cid' && f.get('client_secret') === 'csecret')) || f.get('grant_type') !== 'client_credentials') return json(res, 401, { error: 'invalid_client' })
        return json(res, 200, { access_token: `tok${tokens}`, token_type: 'Bearer', expires_in: 3600 })
      }
      if (u.pathname === '/protected') {
        if (expireNext && req.headers.authorization === 'Bearer tok1') { expireNext = false; return json(res, 401, { error: 'expired' }) }
        return json(res, 200, { auth: req.headers.authorization ?? null })
      }
      if (u.pathname === '/echo') return json(res, 200, { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body })
      if (u.pathname.startsWith('/v1/orders/')) return json(res, 200, { data: { id: decodeURIComponent(u.pathname.slice(11)), lines: [{ sku: 'A' }] } })
      if (u.pathname === '/fail') return json(res, 503, { error: 'down' })
      json(res, 404, { error: 'nope' })
    })
  })
  afterAll(() => api.close())

  const base = () => `http://127.0.0.1:${api.port}`

  it('settings checks: base URL, allow-list, auth fields', () => {
    expect(checkHttpSettings({ baseUrl: 'ftp://x' }, undefined).join(' ')).toMatch(/https:\/\//)
    expect(checkHttpSettings({ baseUrl: 'https://api.x.com', allowedHosts: 'other.com' }, undefined).join(' ')).toMatch(/must be on the list/)
    expect(checkHttpSettings({ baseUrl: 'https://api.x.com', authMode: 'apiKey' }, undefined).join(' ')).toMatch(/name of the API key/)
    expect(checkHttpSettings({ baseUrl: 'https://api.x.com', authMode: 'oauth2cc', clientId: 'a', tokenUrl: 'https://login.y.com/t' }, undefined).join(' ')).toMatch(/token URL/)
    expect(checkHttpSettings({ baseUrl: 'https://api.x.com' }, undefined)).toEqual([])
  })

  it('API key in a header or the query, basic, bearer, secret headers', async () => {
    const p = createHttpProvider()
    const run = async (c: ConnectionRecord) => (await p.invoke(call(c, 'request', { method: 'GET', path: '/echo' }))) as { body: { headers: Record<string, string>; query: Record<string, string> }; url: string }
    let r = await run(conn({ baseUrl: base(), authMode: 'apiKey', apiKeyName: 'X-Api-Key' }, { apiKey: 'K-123456' }))
    expect(r.body.headers['x-api-key']).toBe('K-123456')
    r = await run(conn({ baseUrl: base(), authMode: 'apiKey', apiKeyIn: 'query', apiKeyName: 'key' }, { apiKey: 'Q-123456' }))
    expect(r.body.query.key).toBe('Q-123456')
    expect(r.url).not.toContain('Q-123456')
    r = await run(conn({ baseUrl: base(), authMode: 'basic', username: 'ann' }, { password: 'pw-123456' }))
    expect(r.body.headers.authorization).toBe(`Basic ${Buffer.from('ann:pw-123456').toString('base64')}`)
    r = await run(conn({ baseUrl: base(), authMode: 'bearer' }, { token: 'T-123456', headers: { 'X-Tenant-Secret': 'S-123456' } }))
    expect(r.body.headers.authorization).toBe('Bearer T-123456')
    expect(r.body.headers['x-tenant-secret']).toBe('S-123456')
    // the service redacts every secret value from outputs (the echo shows them)
    const c = conn({ baseUrl: base(), authMode: 'bearer' }, { token: 'T-123456', headers: { 'X-Tenant-Secret': 'S-123456' } })
    expect(JSON.stringify(redactDeep(r, p.secrets(c)))).not.toMatch(/T-123456|S-123456/)
  })

  it('OAuth 2.0 client credentials: token cached, refreshed once on 401, client auth in body or basic', async () => {
    const p = createHttpProvider()
    const cache = new Map<string, unknown>()
    const c = conn({ baseUrl: base(), authMode: 'oauth2cc', tokenUrl: `${base()}/oauth/token`, clientId: 'cid' }, { clientSecret: 'csecret' })
    tokens = 0
    await p.invoke(call(c, 'request', { path: '/protected' }, cache))
    const r = (await p.invoke(call(c, 'request', { path: '/protected' }, cache))) as { body: { auth: string } }
    expect(r.body.auth).toBe('Bearer tok1')
    expect(tokens).toBe(1)
    expireNext = true
    const r2 = (await p.invoke(call(c, 'request', { path: '/protected' }, cache))) as { body: { auth: string } }
    expect(r2.body.auth).toBe('Bearer tok2')
    expect(tokens).toBe(2)
    const cb = conn({ baseUrl: base(), authMode: 'oauth2cc', tokenUrl: `${base()}/oauth/token`, clientId: 'cid', clientAuth: 'basic' }, { clientSecret: 'csecret' })
    expect(((await p.invoke(call(cb, 'request', { path: '/protected' }))) as { body: { auth: string } }).body.auth).toMatch(/^Bearer tok/)
    const bad = conn({ baseUrl: base(), authMode: 'oauth2cc', tokenUrl: `${base()}/oauth/token`, clientId: 'cid' }, { clientSecret: 'wrong' })
    await expect(p.invoke(call(bad, 'request', { path: '/protected' }))).rejects.toMatchObject({ code: 'not_configured' })
  })

  it('request: query, headers, JSON / form / text bodies, path values, expected status, forbidden headers', async () => {
    const p = createHttpProvider()
    const c = conn({ baseUrl: `${base()}/` })
    const r = (await p.invoke(call(c, 'request', { method: 'POST', path: '/echo', query: { a: 1, b: ['x', 'y'] }, headers: { 'X-Trace': 't1' }, body: { n: 1 } }))) as { body: { query: Record<string, string>; headers: Record<string, string>; body: string } }
    expect(r.body.query).toEqual({ a: '1', b: 'y' })
    expect(r.body.headers['x-trace']).toBe('t1')
    expect(JSON.parse(r.body.body)).toEqual({ n: 1 })
    const f = (await p.invoke(call(c, 'request', { method: 'POST', path: '/echo', bodyType: 'form', body: { a: 'b c' } }))) as { body: { body: string; headers: Record<string, string> } }
    expect(f.body.body).toBe('a=b+c')
    expect(f.body.headers['content-type']).toBe('application/x-www-form-urlencoded')
    const o = (await p.invoke(call(conn({ baseUrl: `${base()}/v1` }), 'request', { path: '/orders/{{id}}', pathParams: { id: 'A/7' } }))) as { body: { data: { id: string } } }
    expect(o.body.data.id).toBe('A/7')
    await expect(p.invoke(call(c, 'request', { path: '/fail' }))).rejects.toMatchObject({ code: 'upstream', status: 503, retryable: true })
    await expect(p.invoke(call(c, 'request', { path: '/nothing' }))).rejects.toMatchObject({ code: 'upstream', status: 404, retryable: false })
    expect(((await p.invoke(call(c, 'request', { path: '/nothing', expectStatus: [404] }))) as { status: number }).status).toBe(404)
    await expect(p.invoke(call(c, 'request', { path: '/echo', headers: { Host: 'evil' } }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(p.invoke(call(conn({ baseUrl: `${base()}/v1` }), 'request', { path: '/../../oauth/token' }))).rejects.toMatchObject({ code: 'invalid_input' })
    // an absolute address must be on the allow-list
    await expect(p.invoke(call(c, 'request', { path: 'http://example.org/' }))).rejects.toMatchObject({ code: 'blocked' })
  })

  it('custom actions: path template, query/header params, body fields, output path', async () => {
    const p = createHttpProvider()
    const { def, problems } = checkCustomAction({
      id: 'getOrder', title: 'Get order', inputs: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, expand: { type: 'boolean' } } },
      http: { method: 'GET', path: '/orders/{{id}}', params: [{ name: 'expand', in: 'query', input: 'expand' }], outputPath: 'data' },
    })
    expect(problems).toEqual([])
    expect(def.idempotent).toBe(true)
    expect(def.sideEffect).toBe('none')
    const out = await p.invoke(call(conn({ baseUrl: `${base()}/v1` }), 'getOrder', { id: '42' }, new Map(), def))
    expect(out).toEqual({ id: '42', lines: [{ sku: 'A' }] })
    const post = checkCustomAction({ id: 'createThing', inputs: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' } } }, http: { method: 'POST', path: '/echo', bodyFields: ['name', 'qty'], headers: { 'X-Name': '{{name}}' } } })
    expect(post.def.sideEffect).toBe('external')
    expect(post.def.idempotent).toBe(false)
    const r = (await p.invoke(call(conn({ baseUrl: base() }), 'createThing', { name: 'n1', qty: 2 }, new Map(), post.def))) as { body: string; headers: Record<string, string> }
    expect(JSON.parse(r.body)).toEqual({ name: 'n1', qty: 2 })
    expect(r.headers['x-name']).toBe('n1')
    expect(checkCustomAction({ id: 'x', http: { method: 'GET', path: '/a/{{missing}}' } }).problems.join(' ')).toMatch(/not an input/)
    expect(checkCustomAction({ id: 'request', http: { method: 'GET', path: '/' } }).problems.join(' ')).toMatch(/built-in/)
    expect(checkCustomAction({ id: 'h', http: { method: 'GET', path: '/', headers: { 'Content-Length': '1' } } }).problems.join(' ')).toMatch(/cannot be set/)
  })
})

/* ------------------------------------------------------------------ webhook signatures */

describe('webhook signatures', () => {
  const secret = 'whsec_test'
  const body = Buffer.from('{"a":1}')
  it('verifies HMAC-SHA256 over "<t>.<body>" within the tolerance', () => {
    const now = 1_800_000_000_000
    const t = now / 1000
    const sig = signPayload(secret, t, body)
    expect(verifySignature(secret, `t=${t},v1=${sig}`, body, 300, now).ok).toBe(true)
    expect(verifySignature(secret, `t=${t},v1=${'0'.repeat(64)},v1=${sig}`, body, 300, now).ok).toBe(true)
    expect(verifySignature(secret, `t=${t},v1=${sig}`, Buffer.from('{"a":2}'), 300, now)).toMatchObject({ ok: false, reason: /does not match/ })
    expect(verifySignature('other', `t=${t},v1=${sig}`, body, 300, now).ok).toBe(false)
    expect(verifySignature(secret, `t=${t - 301},v1=${signPayload(secret, t - 301, body)}`, body, 300, now)).toMatchObject({ ok: false, reason: /tolerance/ })
    expect(verifySignature(secret, undefined, body, 300, now)).toMatchObject({ ok: false, reason: /missing/ })
    expect(verifySignature(secret, 'v1=abc', body, 300, now)).toMatchObject({ ok: false, reason: /malformed/ })
    expect(parseSignatureHeader('t=1, v1=' + 'a'.repeat(64))).toEqual({ t: 1, v1: ['a'.repeat(64)] })
  })
})

/* ------------------------------------------------------------------ OpenAPI import */

describe('OpenAPI 3 import', () => {
  const dir = path.join(import.meta.dirname, 'testdata')
  it('Swagger Petstore (OpenAPI 3.0, JSON): operations, parameters, bodies, security', () => {
    const r = importOpenApi(fs.readFileSync(path.join(dir, 'petstore3.openapi.json'), 'utf8'), { source: 'https://petstore3.swagger.io/api/v3/openapi.json' })
    expect(r.title).toBe('Swagger Petstore - OpenAPI 3.0')
    expect(r.baseUrl).toBe('https://petstore3.swagger.io/api/v3')
    expect(r.auth).toEqual({ authMode: 'apiKey', apiKeyIn: 'header', apiKeyName: 'api_key' })
    expect(r.actions.length).toBe(19)
    const get = r.actions.find((a) => a.id === 'getPetById')!
    expect(get.http).toEqual({ method: 'GET', path: '/pet/{{petId}}' })
    expect(get.inputs.required).toEqual(['petId'])
    expect(get.inputs.properties!.petId.type).toBe('integer')
    expect(get.outputs.properties!.name.type).toBe('string')
    expect(get.sideEffect).toBe('none')
    const add = r.actions.find((a) => a.id === 'addPet')!
    expect(add.http.bodyInput).toBe('body')
    expect(add.inputs.properties!.body.required).toEqual(['name', 'photoUrls'])
    expect(add.inputs.properties!.body.properties!.category.properties!.name.type).toBe('string')
    expect(add.idempotent).toBe(false)
    const del = r.actions.find((a) => a.id === 'deletePet')!
    expect(del.http.params).toEqual([{ name: 'api_key', in: 'header', input: 'api_key' }])
    expect(r.actions.find((a) => a.id === 'findPetsByStatus')!.inputs.properties!.status.enum).toEqual(['available', 'pending', 'sold'])
    expect(r.warnings.join(' ')).toMatch(/only JSON request bodies/)
    expect(r.warnings.join(' ')).toMatch(/petstore_auth/)
    // every imported action passes the custom action check
    for (const a of r.actions) expect(checkCustomAction(a).problems, a.id).toEqual([])
  })
  it('USPTO data set API (OpenAPI 3.0, YAML): server variables, path parameters', () => {
    const r = importOpenApi(fs.readFileSync(path.join(dir, 'uspto.openapi.yaml'), 'utf8'))
    expect(r.baseUrl).toBe('https://developer.uspto.gov/ds-api')
    expect(r.actions.map((a) => a.id)).toEqual(['list-data-sets', 'list-searchable-fields', 'perform-search'])
    expect(r.actions[1].http.path).toBe('/{{dataset}}/{{version}}/fields')
  })
  it('refuses Swagger 2.0, non-OpenAPI and huge documents; cuts recursive schemas', () => {
    expect(() => importOpenApi('{"swagger":"2.0","paths":{}}')).toThrow(OpenApiError)
    expect(() => importOpenApi('a: [')).toThrow(/not valid JSON or YAML/)
    expect(() => importOpenApi('x'.repeat(3 * 1024 * 1024))).toThrow(/2 MB/)
    const doc = { openapi: '3.1.0', info: { title: 't' }, paths: { '/n/{id}': { get: { operationId: 'node', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } } }, components: { schemas: { Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' }, v: { type: ['string', 'null'] } } } } } }
    const r = importOpenApi(JSON.stringify(doc))
    expect(r.actions[0].outputs.properties!.child.description).toBe('recursive structure')
    expect(r.actions[0].outputs.properties!.v.type).toEqual(['string', 'null'])
  })
})

/* ------------------------------------------------------------------ notification channels and digests */

describe('notification delivery rules', () => {
  const prefs = (o: Record<string, unknown> = {}) => parseNotificationSettings({ kinds: {}, ...o })
  it('administrator defaults, user choices and locks', () => {
    const p = parsePolicy({ kinds: { approval: { email: 'immediate', lock: true }, flow: { email: 'digest' } } })
    expect(effectiveChannels(p, prefs({ email: { approval: 'off' } }), 'approval')).toMatchObject({ email: 'immediate', locked: true })
    expect(effectiveChannels(p, prefs(), 'flow')).toMatchObject({ email: 'digest', locked: false })
    expect(effectiveChannels(p, prefs({ email: { flow: 'off' } }), 'flow').email).toBe('off')
    expect(effectiveChannels(p, prefs({ kinds: { app: false } }), 'app')).toMatchObject({ inApp: false, email: 'off' })
    expect(effectiveChannels(defaultPolicy(), prefs(), 'approval').email).toBe('immediate')
    expect(parsePolicy({ logoUrl: 'http://insecure/logo.png' }).logoUrl).toBe('')
  })
  it('quiet hours in the user\'s time zone, and when they end', () => {
    const s = prefs({ dnd: { start: '22:00', end: '07:00' }, timeZone: 'Asia/Kolkata' })
    // 18:00 UTC = 23:30 in Kolkata
    expect(inQuietHours(s, new Date('2026-11-18T18:00:00Z'))).toBe(true)
    expect(inQuietHours(s, new Date('2026-11-18T06:00:00Z'))).toBe(false)
    expect(quietEnd(s, new Date('2026-11-18T18:00:00Z')).toISOString()).toBe('2026-11-19T01:30:00.000Z')
    expect(inQuietHours(prefs({ dnd: { start: '22:00', end: '07:00' }, quietEmail: false }), new Date('2026-11-18T23:00:00Z'))).toBe(false)
  })
  it('digest slots: daily at a local time, hourly, never twice for a slot, not for items newer than the slot', () => {
    const daily = prefs({ digest: { frequency: 'daily', time: '08:00' }, timeZone: 'Europe/Berlin' })
    const now = new Date('2026-11-18T09:30:00Z') // 10:30 in Berlin
    expect(latestDigestSlot(daily, now).toISOString()).toBe('2026-11-18T07:00:00.000Z')
    expect(digestDue(daily, null, new Date('2026-11-18T06:00:00Z'), now)).toBe(true)
    expect(digestDue(daily, new Date('2026-11-18T07:00:30Z'), new Date('2026-11-18T06:00:00Z'), now)).toBe(false)
    expect(digestDue(daily, null, new Date('2026-11-18T08:00:00Z'), now)).toBe(false) // arrived after today's slot
    expect(digestDue(daily, null, null, now)).toBe(false)
    const hourly = prefs({ digest: { frequency: 'hourly', time: '08:00' } })
    expect(digestDue(hourly, new Date('2026-11-18T08:59:00Z'), new Date('2026-11-18T08:59:30Z'), new Date('2026-11-18T09:00:10Z'))).toBe(true)
    expect(digestDue(hourly, new Date('2026-11-18T09:00:05Z'), new Date('2026-11-18T08:59:30Z'), new Date('2026-11-18T09:10:00Z'))).toBe(false)
    const quiet = prefs({ digest: { frequency: 'hourly', time: '08:00' }, dnd: { start: '00:00', end: '23:59' } })
    expect(digestDue(quiet, null, new Date('2026-11-18T08:00:00Z'), new Date('2026-11-18T09:10:00Z'))).toBe(false)
  })
  it('signed unsubscribe tokens', () => {
    const key = Buffer.alloc(32, 7)
    const t = signToken(key, { u: 'u1', k: 'flow' })
    expect(verifyToken(key, t)).toEqual({ u: 'u1', k: 'flow' })
    const [b, m] = t.split('.')
    expect(verifyToken(key, `${Buffer.from(JSON.stringify({ u: 'u2', k: 'flow' })).toString('base64url')}.${m}`)).toBeNull()
    expect(verifyToken(Buffer.alloc(32, 8), t)).toBeNull()
    expect(verifyToken(key, b)).toBeNull()
  })
})

describe('scheduled report helpers', () => {
  it('CSV with the formula injection guard', () => {
    const csv = toCsv([{ name: 'a', label: 'A' }, { name: 'b', label: '=B' }], [{ a: '=HYPERLINK("x")', b: -5 }, { a: 'x,"y"', b: '@cmd' }])
    expect(csv).toBe('﻿A,\'=B\r\n"\'=HYPERLINK(""x"")",-5\r\n"x,""y""",\'@cmd\r\n')
  })
  it('schedules', () => {
    expect(scheduleCron(parseSchedule({ frequency: 'daily', time: '07:30', timeZone: 'Asia/Kolkata' }))).toBe('30 7 * * *')
    expect(scheduleCron(parseSchedule({ frequency: 'weekdays', time: '08:00' }))).toBe('0 8 * * 1-5')
    expect(scheduleCron(parseSchedule({ frequency: 'weekly', time: '08:00', weekday: 1 }))).toBe('0 8 * * 1')
    expect(scheduleCron(parseSchedule({ frequency: 'monthly', time: '06:15', day: 1 }))).toBe('15 6 1 * *')
    expect(scheduleCron(parseSchedule({ frequency: 'manual' }))).toBeNull()
    expect(() => parseSchedule({ frequency: 'daily', timeZone: 'Mars/Base' })).toThrow()
  })
})

describe('errors', () => {
  it('OutboundError carries code and retryability', () => {
    const e = new OutboundError('timeout', 'x', true)
    expect(e).toMatchObject({ code: 'timeout', retryable: true })
  })
})
