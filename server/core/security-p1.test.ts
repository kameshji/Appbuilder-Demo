/**
 * Security re-check of Phase 1 (package E), unit level: the outbound HTTP policy against address encodings, userinfo,
 * trailing dots, IDN homographs and header injection; the expression sandbox (prototype pollution, regular expressions
 * with nested repeats, the evaluation budget, huge values); OpenAPI import bombs and remote references.
 * Findings and residual risks: docs/internal/security-review-p1.md.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { safeRequest, setLookupForTests, type OutboundPolicy } from './actions/outbound.ts'
import { classifyAddress } from './net-policy.ts'
import { importOpenApi, OpenApiError, parseDocument } from './actions/openapi.ts'
import { evaluate } from '../../src/fx/index.ts'
import { nestedQuantifier, setRegexGuard } from '../../src/fx/functions/text.ts'
import { setEvaluationBudget } from '../../src/fx/evaluate.ts'
import { jsonToFx, fxToJson } from './flows/values.ts'

const policy = (o: Partial<OutboundPolicy> = {}): OutboundPolicy => ({ allowedHosts: ['127.0.0.1'], allowPrivate: false, maxRedirects: 0, maxResponseBytes: 64 * 1024, timeoutMs: 3000, verifyTls: true, pins: new Map(), ...o })

describe('HTTP connector SSRF (outbound policy)', () => {
  afterEach(() => setLookupForTests(null))

  it('FINDING 1: IPv4 inside IPv6 (mapped in hex, compatible, NAT64, 6to4) is classified as the IPv4 address it carries', () => {
    expect(classifyAddress('::ffff:a9fe:a9fe')).toBe('link-local')
    expect(classifyAddress('[::ffff:169.254.169.254]')).toBe('link-local')
    expect(classifyAddress('::ffff:7f00:1')).toBe('loopback')
    expect(classifyAddress('0:0:0:0:0:ffff:0a00:0001')).toBe('private')
    expect(classifyAddress('::7f00:1')).toBe('loopback')
    expect(classifyAddress('64:ff9b::a9fe:a9fe')).toBe('link-local')
    expect(classifyAddress('2002:a9fe:a9fe::1')).toBe('link-local')
    expect(classifyAddress('2002:0808:0808::1')).toBe('public')
    expect(classifyAddress('::1')).toBe('loopback')
    expect(classifyAddress('::')).toBe('unspecified')
    expect(classifyAddress('2606:4700:4700::1111')).toBe('public')
  })

  it('metadata addresses in every encoding are refused even when the connection allows private networks and lists the host', async () => {
    for (const url of ['http://169.254.169.254/', 'http://2852039166/', 'http://0xa9fea9fe/', 'http://0251.0376.0251.0376/', 'http://169.254.169.254./', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/', 'http://[fe80::1]/', 'http://0.0.0.0/', 'http://[::]/']) {
      const host = new URL(url).hostname
      await expect(safeRequest({ method: 'GET', url }, policy({ allowedHosts: [host.replace(/\.$/, ''), host], allowPrivate: true })), url).rejects.toMatchObject({ code: 'blocked' })
    }
  })
  it('loopback in decimal, octal, hex, short and IPv6 forms is refused without "private networks"', async () => {
    for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://10.1/', 'http://[fd00::1]/']) {
      const host = new URL(url).hostname
      await expect(safeRequest({ method: 'GET', url }, policy({ allowedHosts: [host] })), url).rejects.toMatchObject({ code: 'blocked' })
    }
  })
  it('userinfo@host, fragments, trailing dots and IDN homographs do not get past the allow-list', async () => {
    setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }])
    const p = policy({ allowedHosts: ['api.example.com'] })
    await expect(safeRequest({ method: 'GET', url: 'http://api.example.com@evil.test/' }, p)).rejects.toMatchObject({ code: 'blocked' })
    await expect(safeRequest({ method: 'GET', url: 'http://evil.test/#@api.example.com' }, p)).rejects.toMatchObject({ code: 'blocked' })
    await expect(safeRequest({ method: 'GET', url: 'http://evil.test\\@api.example.com/' }, p)).rejects.toMatchObject({ code: 'blocked' })
    // a Cyrillic "а" in place of the Latin "a": a different host (xn--...)
    await expect(safeRequest({ method: 'GET', url: 'http://аpi.example.com/' }, p)).rejects.toMatchObject({ code: 'blocked' })
    await expect(safeRequest({ method: 'GET', url: 'http://api.example.com.evil.test/' }, p)).rejects.toMatchObject({ code: 'blocked' })
  })
  it('CR/LF in a header value or name never reaches the wire (no header injection or request smuggling)', async () => {
    const hits: string[] = []
    const s = http.createServer((req, res) => { hits.push(JSON.stringify(req.headers)); res.end('{}') })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as AddressInfo).port
    try {
      for (const headers of [{ 'X-A': 'v\r\nX-Injected: 1' }, { 'X-A\r\nX-Injected': '1' }, { 'X-A': 'v\nTransfer-Encoding: chunked' }] as Record<string, string>[]) {
        await expect(safeRequest({ method: 'POST', url: `http://127.0.0.1:${port}/`, headers, body: 'x' }, policy({ allowPrivate: true }))).rejects.toBeTruthy()
      }
      expect(hits.join('')).not.toContain('injected')
    } finally {
      await new Promise((r) => s.close(r))
    }
  })
})

describe('expression sandbox (formulas evaluated on the server)', () => {
  afterEach(() => { setRegexGuard(false); setEvaluationBudget(0) })

  it('prototype pollution: __proto__ in JSON, records and flow values stays data', () => {
    const r = evaluate('=ParseJSON("{""__proto__"": {""polluted"": 1}, ""constructor"": {""prototype"": {""p2"": 1}}}")', {} as never)
    expect(r.ok).toBe(true)
    const v = jsonToFx(JSON.parse('{"__proto__": {"polluted": 1}}'))
    void fxToJson(v)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).p2).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false)
  })
  it('regular expressions with nested repeats are refused on the server (catastrophic backtracking); others still work', () => {
    for (const p of ['(a+)+$', '(\\w*)*', '(x|y+){2,}', '((ab)*c)+', '(.*a){10}']) expect(nestedQuantifier(p), p).toBe(true)
    for (const p of ['a+b*', '(abc)+', '[a-z]+@[a-z]+\\.com', '(\\d{3})-(\\d{4})', '(a+)?', '\\(a+\\)+', '[(a+)]+']) expect(nestedQuantifier(p), p).toBe(false)
    setRegexGuard(true)
    const t0 = Date.now()
    const r = evaluate(`=IsMatch("${'a'.repeat(40)}!", "(a+)+$")`, {} as never)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.ok).toBe(false)
    expect(evaluate('=IsMatch("abc-1234", "[a-z]+-\\d+")', {} as never)).toEqual({ ok: true, value: true })
  })
  it('an evaluation that loops for too long is stopped by the budget; huge strings fail cleanly', () => {
    setEvaluationBudget(300)
    const t0 = Date.now()
    const r = evaluate('=CountRows(ForAll(Sequence(100000), ForAll(Sequence(100000), Value)))', {} as never)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/too much work|too complex/)
    // with the budget on, building billions of characters stops early instead of exhausting the memory
    setEvaluationBudget(30_000)
    const t1 = Date.now()
    const big = evaluate('=Len(Concat(Sequence(100000), Concat(Sequence(100000), "abcdefghij")))', {} as never)
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.error.message).toMatch(/too much data/)
    expect(Date.now() - t1).toBeLessThan(20000)
    const rows = evaluate('=CountRows(ForAll(Sequence(100000), Sequence(100000)))', {} as never)
    expect(rows.ok).toBe(false)
  }, 60000)
})

describe('OpenAPI import', () => {
  it('a YAML alias bomb is refused in milliseconds; remote $ref is never fetched', () => {
    const lines = ['openapi: 3.0.0', 'info: {title: x, version: "1"}', 'components:', '  schemas:', '    L0: &L0 {type: string}']
    for (let i = 1; i <= 9; i++) lines.push(`    L${i}: &L${i} {type: object, properties: {${Array.from({ length: 10 }, (_, k) => `p${k}: *L${i - 1}`).join(', ')}}}`)
    lines.push('paths:', '  /x:', '    post:', '      operationId: boom', '      requestBody: {content: {application/json: {schema: *L9}}}', '      responses: {"200": {description: ok}}')
    const t0 = Date.now()
    expect(() => parseDocument(lines.join('\n'))).toThrow(OpenApiError)
    expect(Date.now() - t0).toBeLessThan(2000)
    // a remote reference is a warning, not a fetch
    const doc = { openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: { '/a': { get: { operationId: 'a', parameters: [{ $ref: 'http://169.254.169.254/latest/meta-data' }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: 'https://evil.test/schema.json' } } } } } } } } }
    const out = importOpenApi(JSON.stringify(doc))
    expect(out.warnings.join(' ')).toMatch(/External references .* are not followed/)
  })
})
