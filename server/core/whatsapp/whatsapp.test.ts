/**
 * WhatsApp connector, no database: phone numbers, Meta's webhook signature, keywords, error mapping, template payloads,
 * settings checks (no base address), the HTTP connector refusing Meta's Graph API host, and the Graph client against the
 * fake Graph API (mock-graph.ts) through the real outbound client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { maskPhone, normalizePhone } from './phone.ts'
import { signMeta, verifyMetaSignature } from './webhook.ts'
import { DEFAULT_STOP_KEYWORDS, DEFAULT_START_KEYWORDS, cleanKeywords, matchKeyword } from './store.ts'
import { GRAPH_HOST, graphBase, graphRequest, isReservedGraphHost, mapGraphError, policyFor, setGraphBaseForTests } from './graph.ts'
import { paramText, templatePayload } from './send.ts'
import { checkWhatsappSettings, createWhatsappProvider, listTemplates } from './provider.ts'
import { MOCK_PHONE_NUMBER_ID, MOCK_TOKEN, MOCK_WABA_ID, graphError, startMockGraph, type MockGraph } from './mock-graph.ts'
import { checkHttpSettings, policyOf } from '../actions/http.ts'
import { validate } from '../actions/schema.ts'
import { WHATSAPP_ACTIONS } from './defs.ts'
import type { ConnectionRecord } from '../contracts.ts'

const conn = (settings: Record<string, string> = {}, secret: Record<string, string> = { accessToken: MOCK_TOKEN }): ConnectionRecord => ({
  id: 'conn_wa', name: 'WhatsApp', connector: 'whatsapp', status: 'connected', settings: { phoneNumberId: MOCK_PHONE_NUMBER_ID, businessAccountId: MOCK_WABA_ID, defaultCountryCode: '91', ...settings }, secret: JSON.stringify(secret),
})

describe('phone numbers', () => {
  it('normalises to E.164 with the default country code (not hard-coded)', () => {
    expect(normalizePhone('98765 43210', '91')).toBe('+919876543210')
    expect(normalizePhone('098765-43210', '91')).toBe('+919876543210')
    expect(normalizePhone('+91 (00000) 00000', '91')).toBe('+910000000000')
    expect(normalizePhone('0091 00000 00001', '91')).toBe('+910000000001')
    expect(normalizePhone('+44 20 7946 0000', '91')).toBe('+442079460000')
    expect(normalizePhone('20 7946 0000', '44')).toBe('+442079460000')
    expect(normalizePhone('tel:+15550000000', undefined)).toBe('+15550000000')
    expect(normalizePhone(9876543210, '91')).toBe('+919876543210')
    for (const bad of ['', 'abc', '12345', '+0123456789', '+1234567890123456', '98765 43210 ext 5']) expect(() => normalizePhone(bad, '91'), bad).toThrow()
    expect(() => normalizePhone('98765 43210', undefined)).toThrow(/country code/)
  })
  it('masks a number for non-administrators', () => {
    expect(maskPhone('+919876543210')).toBe('+91 •••••••210')
    expect(maskPhone('+15550000000')).toBe('+1 •••••••000')
    expect(maskPhone('+919876543210')).not.toContain('98765')
  })
})

describe("Meta's webhook signature", () => {
  const secret = 'app-secret-for-unit-tests'
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }))
  it('accepts the HMAC-SHA256 of the raw body, refuses anything else', () => {
    const sig = signMeta(secret, body)
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(verifyMetaSignature(secret, sig, body)).toBe(true)
    expect(verifyMetaSignature(secret, sig.toUpperCase().replace('SHA256', 'sha256'), body)).toBe(true)
    expect(verifyMetaSignature(secret, sig, Buffer.concat([body, Buffer.from(' ')]))).toBe(false)
    expect(verifyMetaSignature('other-secret', sig, body)).toBe(false)
    expect(verifyMetaSignature(secret, undefined, body)).toBe(false)
    expect(verifyMetaSignature(secret, sig.slice(7), body)).toBe(false)
    expect(verifyMetaSignature(secret, 'sha1=' + sig.slice(7), body)).toBe(false)
    expect(verifyMetaSignature('', sig, body)).toBe(false)
  })
})

describe('keywords', () => {
  it('matches the whole message, case-insensitively, with punctuation around it; Hindi included', () => {
    expect(matchKeyword('STOP', DEFAULT_STOP_KEYWORDS)).toBe('STOP')
    expect(matchKeyword('  stop. ', DEFAULT_STOP_KEYWORDS)).toBe('STOP')
    expect(matchKeyword('Stop!', DEFAULT_STOP_KEYWORDS)).toBe('STOP')
    expect(matchKeyword('band karo', DEFAULT_STOP_KEYWORDS)).toBe('BAND KARO')
    expect(matchKeyword('बंद करो', DEFAULT_STOP_KEYWORDS)).toBe('बंद करो')
    expect(matchKeyword('बंद।', DEFAULT_STOP_KEYWORDS)).toBe('बंद')
    expect(matchKeyword('please do not stop sending', DEFAULT_STOP_KEYWORDS)).toBeNull()
    expect(matchKeyword('start', DEFAULT_START_KEYWORDS)).toBe('START')
    expect(cleanKeywords([' halt ', 'HALT', 5, ''], [])).toEqual(['HALT'])
    expect(cleanKeywords('x', ['A'])).toEqual(['A'])
  })
})

describe('Graph API errors in plain English', () => {
  it('maps the documented codes and never echoes request values', () => {
    expect(mapGraphError(401, graphError(190, 'Error validating access token: EAAGsecret'))).toMatchObject({ code: 'not_configured', retryable: false })
    expect(mapGraphError(401, graphError(190, 'Error validating access token: EAAGsecret')).message).not.toContain('EAAG')
    expect(mapGraphError(404, graphError(132001, 'x')).message).toMatch(/does not exist in this language or is not approved/)
    expect(mapGraphError(400, graphError(132000, 'x')).message).toMatch(/number of values/)
    expect(mapGraphError(400, graphError(131050, 'x'))).toMatchObject({ code: 'denied' })
    expect(mapGraphError(400, graphError(131050, 'x')).message).toMatch(/stop receiving marketing/)
    expect(mapGraphError(400, graphError(131026, 'x')).message).toMatch(/cannot receive WhatsApp/)
    expect(mapGraphError(400, graphError(100, 'Invalid parameter +919876543210')).message).not.toContain('9876543210')
    const rl = mapGraphError(429, graphError(130429, 'x'), { 'retry-after': '60' })
    expect(rl).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(rl.message).toMatch(/Try again in 60 s/)
    expect(mapGraphError(400, graphError(80007, 'x'))).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(mapGraphError(503, null)).toMatchObject({ code: 'upstream', retryable: true })
    expect(mapGraphError(400, graphError(131047, 'x')).message).toMatch(/24 hours/)
  })
})

describe('template messages', () => {
  it('builds header, body and button components; formula records { Value } become text', () => {
    expect(paramText({ Value: 42 })).toBe('42')
    expect(templatePayload({ kind: 'template', template: 'order_update', language: 'en', bodyParams: ['Asha', { Value: 'SO-1' }, 3], headerParams: ['Hi'], buttonParams: [{ index: 0, value: 'SO-1' }, { index: 1, subType: 'quick_reply', value: 'STOP' }] })).toEqual({
      name: 'order_update', language: { code: 'en' },
      components: [
        { type: 'header', parameters: [{ type: 'text', text: 'Hi' }] },
        { type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'SO-1' }, { type: 'text', text: '3' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'SO-1' }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'STOP' }] },
      ],
    })
    expect(() => templatePayload({ kind: 'template', template: 't', language: 'en', bodyParams: ['two\nlines'] })).toThrow(/new lines/)
    expect(() => templatePayload({ kind: 'template', template: 't', language: 'en', bodyParams: [''] })).toThrow(/empty/)
  })
  it('the action schemas accept what flows pass and refuse the rest', () => {
    const send = WHATSAPP_ACTIONS.find((a) => a.id === 'sendTemplate')!
    expect(validate(send.inputs, { to: '+910000000000', template: 'order_update', bodyParams: [{ Value: 'A' }, 'B', 3] }).ok).toBe(true)
    expect(validate(send.inputs, { to: '+910000000000', template: 'Order Update' }).ok).toBe(false)
    expect(validate(send.inputs, { to: '+910000000000', template: 'x', baseUrl: 'http://169.254.169.254' }).ok).toBe(false)
    const rec = WHATSAPP_ACTIONS.find((a) => a.id === 'recordOptIn')!
    expect(validate(rec.inputs, { to: '1', status: 'opted_in', source: 'administrator', evidence: 'x'.repeat(20) }).ok).toBe(false)
    expect(validate(rec.inputs, { to: '1', status: 'opted_in', source: 'form', evidence: 'short' }).ok).toBe(false)
  })
})

describe('settings and the fixed base address', () => {
  it('requires ids and a country code; refuses any address setting', () => {
    expect(checkWhatsappSettings({ phoneNumberId: '1', businessAccountId: '2' }, undefined).join(' ')).toMatch(/phone number id.*Business account id.*country calling code/)
    expect(checkWhatsappSettings(conn().settings!, JSON.stringify({ accessToken: 't', appSecret: 's', verifyToken: 'v'.repeat(16) }))).toEqual([])
    expect(checkWhatsappSettings({ ...conn().settings!, baseUrl: 'http://127.0.0.1:1' }, undefined).join(' ')).toMatch(/address of Meta's API is fixed/)
    expect(checkWhatsappSettings({ ...conn().settings!, graphHost: 'evil.example' }, undefined).join(' ')).toMatch(/fixed/)
    expect(checkWhatsappSettings(conn().settings!, JSON.stringify({ accessToken: 't', url: 'x' })).join(' ')).toMatch(/Unknown secret part/)
    expect(checkWhatsappSettings(conn().settings!, JSON.stringify({ verifyToken: 'short' })).join(' ')).toMatch(/16 characters/)
  })
  it('the production policy allows exactly graph.facebook.com and no private networks', () => {
    setGraphBaseForTests(null)
    expect(graphBase()).toBe('https://graph.facebook.com')
    expect(policyFor(new Map(), 1000)).toMatchObject({ allowedHosts: [GRAPH_HOST], allowPrivate: false, maxRedirects: 0, verifyTls: true })
  })
  it('the HTTP connector refuses Meta\'s Graph API host (no way around the opt-in check)', () => {
    expect(isReservedGraphHost('graph.facebook.com')).toBe(true)
    expect(isReservedGraphHost('*.facebook.com')).toBe(true)
    expect(isReservedGraphHost('GRAPH.FACEBOOK.COM.')).toBe(true)
    expect(isReservedGraphHost('api.example.com')).toBe(false)
    expect(checkHttpSettings({ baseUrl: 'https://graph.facebook.com/v21.0' }, undefined).join(' ')).toMatch(/only the WhatsApp connector/)
    expect(checkHttpSettings({ baseUrl: 'https://api.example.com', allowedHosts: 'api.example.com,*.facebook.com' }, undefined).join(' ')).toMatch(/only the WhatsApp connector/)
    // an older connection that already lists it: the host is dropped from its policy
    const p = policyOf({ id: 'c', name: 'c', connector: 'http', status: 'connected', settings: { baseUrl: 'https://graph.facebook.com', allowedHosts: 'graph.facebook.com,api.example.com' } }, new Map())
    expect(p.allowedHosts).toEqual(['api.example.com'])
  })
})

describe('Graph client against the fake Graph API', () => {
  let mock: MockGraph
  beforeAll(async () => {
    mock = await startMockGraph()
    setGraphBaseForTests(mock.url)
  })
  afterAll(async () => {
    setGraphBaseForTests(null)
    await mock.close()
  })
  it('tests the connection, lists templates over pages, maps an expired token', async () => {
    const p = createWhatsappProvider()
    const t = await p.test({ connection: conn(), cache: new Map(), services: {} as never, env: 'default' })
    expect(t.ok).toBe(true)
    expect(t.message).toMatch(/Fake Test Business/)
    expect(t.message).toMatch(/Still missing: the app secret/)
    mock.templates.push(...Array.from({ length: 120 }, (_, i) => ({ name: `bulk_${i}`, language: 'en', status: 'APPROVED' as const, category: 'UTILITY' as const, body: 'Hi {{1}}' })))
    const list = await listTemplates({ connection: conn(), cache: new Map(), timeoutMs: 5000 })
    expect(list.length).toBe(125)
    expect(list.find((x) => x.name === 'order_update' && x.language === 'en')).toMatchObject({ status: 'APPROVED', bodyParams: 3 })
    mock.templates.splice(5)
    const bad = conn({}, { accessToken: 'EAAG-wrong-token-0000' })
    await expect(graphRequest({ connection: bad, cache: new Map(), timeoutMs: 5000 }, 'GET', `/${MOCK_PHONE_NUMBER_ID}`)).rejects.toMatchObject({ code: 'not_configured' })
    expect(p.secrets(conn({}, { accessToken: 'a-token', appSecret: 'a-secret', verifyToken: 'a-verify-token-123' }))).toEqual(['a-token', 'a-secret', 'a-verify-token-123'])
    // every request carried the token in the Authorization header only, never in the address
    expect(mock.requests.every((r) => !r.path.includes('EAAG'))).toBe(true)
  })
})
