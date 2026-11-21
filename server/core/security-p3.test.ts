/**
 * Security re-check of Phase 3 and the hosting phase, unit level (no database): APPBUILDER_OUTBOUND_DENY by address as
 * well as by name (P3-4: the install's own public address by its IP or another name); the seat pass applied by one
 * helper to every context (P3-2) and the pass refusal of flagged routes (P3-3); guards: the note and comment sanitisers
 * against hostile shapes (time and size) and URL schemes, the outbound policy's IPv6 forms.
 * Findings and residual risks: docs/internal/security-review-p3.md.
 */
import dns from 'node:dns'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertOutboundHost, deniedAddresses, guardedLookup } from './net-policy.ts'
import { createPgDb } from '../connectors/postgres/db.ts'
import { createSqlDb } from '../connectors/mysql/db.ts'
import { resolveAllowed, type OutboundPolicy } from './actions/outbound.ts'
import { applyPass, passRefusal, PASS_REQUIRED_MESSAGE } from './licence/seats.ts'
import type { SqlDb, UserContext } from './contracts.ts'
import { generateLicenceKey, loadSigningKey, newInstallId, newNonce } from './licence/answer.ts'
import { createHandler, listen } from '../licence-service/service.ts'
import { hashKey } from '../licence-service/store.ts'
import { CYCLE_MAX_PAGES, CYCLE_MAX_RANGES, CYCLE_MIN_SECONDS, cycleFromHash, tokenFromHash } from '../../src/dashboards/kiosk.ts'
import { parseStartHash, startPlan } from '../../src/runtime/startparams.ts'
import type { CoreServices } from './services.ts'
import { sanitizeNoteHtml, MAX_INPUT } from '../../src/notes/sanitize.ts'
import { sanitizeRichText } from '../../src/platform/system-tables.ts'

/* ------------------------------------------------------------------ P3-4 outbound deny list */

describe('FINDING P3-4: APPBUILDER_OUTBOUND_DENY refuses the listed hosts by their addresses, not only by the name typed', () => {
  // the hosted profile adds the install's own public host; it resolves to the server's public address
  const env = { APPBUILDER_OUTBOUND_DENY: 'apps.example.com,198.51.100.9', APPBUILDER_OUTBOUND_PRIVATE: 'deny' } as NodeJS.ProcessEnv
  const dnsTable: Record<string, string[]> = {
    'apps.example.com': ['203.0.113.7'],
    'alias.example.net': ['203.0.113.7'], // a name the maker controls, pointing at the install
    'other.example.org': ['192.0.2.44'],
    'v6.example.net': ['::ffff:198.51.100.9'],
  }
  const lookup = async (h: string) => {
    const a = dnsTable[h.toLowerCase()]
    if (!a) throw new Error('ENOTFOUND')
    return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  const policy = (): OutboundPolicy => ({ allowedHosts: ['*'], allowPrivate: false, maxRedirects: 0, maxResponseBytes: 1000, timeoutMs: 1000, verifyTls: true, lookup, env } as OutboundPolicy)

  it('database, SMTP and OAuth hosts (assertOutboundHost)', async () => {
    await expect(assertOutboundHost('apps.example.com', 'Connection', { env, lookup })).rejects.toThrow(/refused addresses/)
    await expect(assertOutboundHost('alias.example.net', 'Connection', { env, lookup })).rejects.toThrow(/resolves to an address on this server's list/)
    await expect(assertOutboundHost('203.0.113.7', 'Connection', { env, lookup })).rejects.toThrow(/is an address on this server's list/)
    await expect(assertOutboundHost('[::ffff:203.0.113.7]', 'Connection', { env, lookup })).rejects.toThrow(/list of refused addresses/)
    await expect(assertOutboundHost('v6.example.net', 'Connection', { env, lookup })).rejects.toThrow(/list of refused addresses/)
    expect(await assertOutboundHost('other.example.org', 'Connection', { env, lookup })).toEqual(['192.0.2.44'])
  })

  it('HTTP connections and flows (resolveAllowed, the address they then connect to)', async () => {
    await expect(resolveAllowed('alias.example.net', policy())).rejects.toThrow(/list of refused addresses/)
    await expect(resolveAllowed('203.0.113.7', policy())).rejects.toThrow(/list of refused addresses/)
    await expect(resolveAllowed('198.51.100.9', policy())).rejects.toThrow(/refused addresses/)
    expect((await resolveAllowed('other.example.org', policy())).address).toBe('192.0.2.44')
  })

  it('the list\'s addresses: IP entries as written, names resolved, wildcards left to the name check', async () => {
    const a = await deniedAddresses({ APPBUILDER_OUTBOUND_DENY: '*.example.com, apps.example.com , [2001:db8::1], 198.51.100.9.' } as NodeJS.ProcessEnv, lookup)
    expect([...a].sort()).toEqual(['198.51.100.9', '2001:db8:0:0:0:0:0:1', '203.0.113.7'])
    expect((await deniedAddresses({} as NodeJS.ProcessEnv, lookup)).size).toBe(0)
  })
})

/* ------------------------------------------------------------------ P3-6 DNS rebinding of database hosts */

/**
 * A rebinding DNS server, as the system resolver sees it: the first answer for the name is a public address, every later
 * one 127.0.0.1, where a canary listener counts connections. It is both the policy's injected resolver and the process's
 * `dns.lookup` (what a driver uses when it resolves a name itself), with one shared sequence.
 */
describe('FINDING P3-6: a database driver never connects to a second DNS answer (pg and mysql2, injected resolver)', () => {
  const HOST = 'db.rebind.test'
  const env = { APPBUILDER_OUTBOUND_PRIVATE: 'deny' } as NodeJS.ProcessEnv
  let canary: net.Server
  let port = 0
  let hits = 0
  let n = 0
  const answer = () => (++n === 1 ? '192.0.2.10' : '127.0.0.1')
  const policyLookup = async () => [{ address: answer(), family: 4 }]
  const realLookup = dns.lookup
  beforeAll(async () => {
    canary = net.createServer((s) => { hits++; s.destroy() })
    await new Promise<void>((r) => canary.listen(0, '127.0.0.1', r))
    port = (canary.address() as net.AddressInfo).port
    ;(dns as { lookup: unknown }).lookup = (h: string, o: unknown, cb?: unknown) => {
      if (String(h).toLowerCase() !== HOST) return (realLookup as (...a: unknown[]) => void)(h, o, cb)
      const done = (typeof o === 'function' ? o : cb) as (...a: unknown[]) => void
      const a = answer()
      if (o && typeof o === 'object' && (o as { all?: boolean }).all) done(null, [{ address: a, family: 4 }])
      else done(null, a, 4)
    }
  })
  afterAll(async () => {
    ;(dns as { lookup: unknown }).lookup = realLookup
    await new Promise<void>((r) => canary.close(() => r()))
  })

  it('the guarded lookup hands out the checked address once, then resolves and checks again', async () => {
    let k = 0
    const seq = async () => [{ address: ++k === 1 ? '203.0.113.20' : '127.0.0.1' }]
    const first = await assertOutboundHost(HOST, 'Connection', { env, lookup: seq })
    const look = guardedLookup(HOST, 'Connection', { first, env, lookup: seq })
    const call = (all: boolean) => new Promise<unknown>((resolve, reject) => look(HOST, { all }, (e, a) => (e ? reject(e) : resolve(a))))
    expect(await call(false)).toBe('203.0.113.20')
    await expect(call(true)).rejects.toThrow(/loopback/)
    // a name that stops resolving fails the connection (the driver never falls back to the system resolver)
    const none = guardedLookup(HOST, 'Connection', { env, lookup: async () => { throw new Error('ENOTFOUND') } })
    await expect(new Promise((resolve, reject) => none(HOST, {}, (e, a) => (e ? reject(e) : resolve(a))))).rejects.toMatchObject({ code: 'ENOTFOUND' })
  })

  for (const driver of ['pg', 'mysql2'] as const) {
    it(`${driver}: the first physical connection goes to the checked address, a later one is re-checked; 127.0.0.1 is never reached`, async () => {
      n = 0
      hits = 0
      // the connection manager's check (answer 1: public)
      const first = await assertOutboundHost(HOST, 'Connection', { env, lookup: policyLookup })
      expect(first).toEqual(['192.0.2.10'])
      const lookup = guardedLookup(HOST, 'Connection', { first, env, lookup: policyLookup })
      const settings = { host: HOST, port, database: 'appdb', user: 'app' }
      const db = driver === 'pg'
        ? createPgDb(settings, 'pw-123', { lookup, connectTimeoutMs: 1500, max: 2, onError: () => {} })
        : createSqlDb(settings, 'pw-123', { lookup, connectTimeoutMs: 1500 })
      try {
        // 1st connection: to 192.0.2.10 (documentation range: unreachable, times out); the driver did not ask DNS again
        await expect(db.query('SELECT 1')).rejects.toBeTruthy()
        // 2nd connection: re-resolved (answer: 127.0.0.1) and refused by the policy before connecting
        await expect(db.query('SELECT 1')).rejects.toThrow(/loopback/)
        expect(hits).toBe(0)
      } finally {
        await db.close().catch(() => {})
      }
    }, 30_000)
  }
})

/* ------------------------------------------------------------------ the licence service (second pass, area 6) */

describe('the licence service: rate limits per address and per key, one path for unknown and revoked keys, check-ins', () => {
  const PASS = 'test-passphrase-only'
  const k = generateLicenceKey(PASS)
  const key = loadSigningKey(k.privatePem, PASS)
  const LIC = 'lic_abcdefgh12'
  const unknownKey = 'abl_' + 'u'.repeat(43)
  const revokedKey = 'abl_' + 'r'.repeat(43)
  /** a database that knows one revoked key; records every statement */
  const fakeDb = () => {
    const calls: { sql: string; params: unknown[] }[] = []
    const db = {
      dialect: 'postgres',
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params })
        if (/FROM .*install_keys/.test(sql)) return params[0] === hashKey(revokedKey) ? [{ org_id: LIC, revoked_on: new Date() }] : []
        return []
      },
      async exec(sql: string, params: unknown[] = []) { calls.push({ sql, params }); return { affectedRows: 1 } },
      async tx<T>(fn: (d: unknown) => Promise<T>) { return fn(db) },
      async serverVersion() { return 'fake' },
      async close() {},
    }
    return { db: db as unknown as SqlDb, calls }
  }
  const start = async (o: { db: SqlDb; trustProxy?: boolean }) => {
    const server = await listen(createHandler({ db: o.db, key, clock: () => 1_800_000_000_000, ratePerMinute: 30, keyRatePerMinute: 10, trustProxy: o.trustProxy }), { host: '127.0.0.1', port: 0 })
    return { server, base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` }
  }
  const body = (seats: unknown = { full: 1, operator: 0, external: 0 }) => JSON.stringify({ v: 1, licenceId: LIC, installId: newInstallId(), version: '0.8.0', nonce: newNonce(), seats })
  const post = (base: string, auth: string | null, extra: Record<string, string> = {}, b = body()) => fetch(`${base}/v1/licence/check`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...extra }, body: b })

  it('per key: the 11th check of one key in a minute is refused (from any address); per address: the 31st', async () => {
    const { db } = fakeDb()
    const { server, base } = await start({ db, trustProxy: true })
    try {
      const st: number[] = []
      for (let i = 0; i < 11; i++) st.push((await post(base, unknownKey, { 'X-Forwarded-For': `198.51.100.${i}` })).status)
      expect(st.slice(0, 10).every((s) => s === 200)).toBe(true)
      expect(st[10]).toBe(429)
      // behind the proxy the LAST X-Forwarded-For entry is the client: a forged first entry does not reset the address limit
      const sts: number[] = []
      for (let i = 0; i < 31; i++) sts.push((await post(base, 'abl_' + String(i).padStart(43, 'k'), { 'X-Forwarded-For': `203.0.113.${i}, 192.0.2.77` })).status)
      expect(sts.slice(0, 30).every((s) => s === 200)).toBe(true)
      expect(sts[30]).toBe(429)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('an unknown and a revoked key take the same statements and get the same answer; the check-in holds no address and no person', async () => {
    const run = async (auth: string) => {
      const f = fakeDb()
      const { server, base } = await start({ db: f.db })
      try {
        const res = await post(base, auth)
        const a = await res.json() as { payload: string }
        return { status: res.status, sql: f.calls.map((c) => c.sql.replace(/\s+/g, ' ')), payload: JSON.parse(Buffer.from(a.payload, 'base64').toString('utf8')), calls: f.calls }
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    }
    const u = await run(unknownKey)
    const r = await run(revokedKey)
    expect(u.status).toBe(200)
    expect(r.sql).toEqual(u.sql)
    expect({ ...r.payload, nonce: 0, installId: 0 }).toEqual({ ...u.payload, nonce: 0, installId: 0 })
    expect(u.payload.status).toBe('refused')
    const checkin = u.calls.find((c) => /INSERT INTO .*checkins/.test(c.sql))!
    expect(checkin.params.map((p) => (p instanceof Date ? 'date' : p))).toEqual(['date', null, expect.stringMatching(/^ins_/), '0.8.0', JSON.stringify({ full: 1, operator: 0, external: 0 }), 'refused'])
  })

  it('a request that carries anything else than counts, ids of the expected shape and a version is refused before any statement', async () => {
    const f = fakeDb()
    const { server, base } = await start({ db: f.db })
    try {
      // an extra member of the counts is dropped, not stored
      expect((await post(base, unknownKey, {}, body({ full: 1, operator: 0, external: 0, email: 'ada@example.com' }))).status).toBe(200)
      expect(JSON.stringify(f.calls)).not.toContain('ada@example.com')
      f.calls.length = 0
      const hostile = [
        { seats: { full: 'x', operator: 0, external: 0 } }, { seats: { full: -1, operator: 0, external: 0 } },
        { licenceId: "lic_abc' OR '1'='1" }, { installId: 'ins_1; DROP TABLE checkins' }, { version: '0.8.0\nX-Header: 1' },
      ]
      for (const h of hostile) {
        const b = JSON.stringify({ ...JSON.parse(body()), ...h })
        expect((await post(base, unknownKey, {}, b)).status, JSON.stringify(h)).toBe(400)
      }
      expect(f.calls).toEqual([])
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

/* ------------------------------------------------------------------ client parameters (second pass, area 7) */

describe('client parameters: kiosk cycling and start addresses are data, clamped and never widened', () => {
  it('kiosk: only the server\'s range presets, bounded seconds and pages; the token is one exact shape', () => {
    const h = (q: string) => `#u-kiosk?t=abv.default.ABCDEFGH.${'x'.repeat(43)}&${q}`
    expect(cycleFromHash(h('every=-5&ranges=__proto__,constructor,today,last7,today&pages=1e9'))).toEqual({ every: CYCLE_MIN_SECONDS, ranges: ['today', 'last7'], pages: CYCLE_MAX_PAGES })
    expect(cycleFromHash(h('every=-1e309&ranges=today,last7'))?.every).toBe(30)
    expect(cycleFromHash(h('every=NaN&ranges=today,last7'))?.every).toBe(30)
    expect(cycleFromHash(h(`ranges=${Array(50).fill('today,last7').join(',')}`))?.ranges.length).toBeLessThanOrEqual(CYCLE_MAX_RANGES)
    expect(tokenFromHash('#u-kiosk?t=abv.default.ABCDEFGH.short')).toBeNull()
    expect(tokenFromHash(`#u-kiosk?t=${encodeURIComponent('abv.x.ABCDEFGH.' + 'y'.repeat(43) + '"><img>')}`)).toBeNull()
    // a second t parameter does not replace the first
    expect(tokenFromHash(`#u-kiosk?t=abv.a.ABCDEFGH.${'1'.repeat(43)}&t=abv.b.ABCDEFGH.${'2'.repeat(43)}`)).toContain('abv.a.')
  })

  it('start addresses: an app id is a plain id, the screen is matched by name or id among the app\'s own screens', () => {
    expect(parseStartHash('#u-../../admin?screen=x')).toBeNull()
    expect(parseStartHash('#u-kiosk?screen=x')).toBeNull()
    const screens = [{ id: 'scr_1', name: 'Home' }, { id: 'scr_2', name: 'Detail' }]
    const p = startPlan('#u-app_1?screen=%3Cimg%20src%3Dx%3E&Machine=%27%3B--', 'app_1', screens, 'scr_1', true)
    expect(p).toEqual({ restart: false, open: null, unknown: '<img src=x>' })
    expect(startPlan('#u-other?screen=Detail', 'app_1', screens, 'scr_1', true).open).toBeNull()
    expect(parseStartHash('#u-app_1?Machine=%27%3B--')?.params).toEqual([['Machine', "';--"]])
  })
})

/* ------------------------------------------------------------------ guard: stored rich text is sanitised where it is shown */

describe('guard (P3-14): every place the client renders stored HTML runs it through a sanitiser', () => {
  it('no dangerouslySetInnerHTML is fed straight from data', () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx$/.test(e.name) && !/\.test\./.test(e.name)) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+)\}\}/g)) {
            // allowed: a sanitiser call, or a value the module built from a sanitiser (named html / qrSvg, checked by reading)
            if (!/^(sanitizeRichText|sanitizeNoteHtml|markMentions\(sanitizeRichText)\(|^html\s*$|^start\.qrSvg\s*$/.test(m[1].trim())) offenders.push(`${path.relative(root, p)}: ${m[1].trim()}`)
          }
        }
      }
    }
    walk(path.join(root, 'src'))
    expect(offenders).toEqual([])
  })
})

/* ------------------------------------------------------------------ P3-2 / P3-3 seat passes */

describe('FINDING P3-2 / P3-3: the seat pass is one helper applied to every context; flagged routes refuse a non-full pass', () => {
  const services = (pass: string | null) => ({
    state: { db: { query: async () => (pass ? [{ value: { pass } }] : []) } },
  }) as unknown as CoreServices
  const ctx = (id: string, isMaker: boolean): UserContext => {
    const u = {
      user: { id, name: 'U', email: 'u@example.com', roleIds: [], kind: 'person' },
      privileges: { isAdmin: true, isMaker, isInstallAdmin: false, tables: {}, apps: 'all' },
      session() { return { user: this.user, privileges: this.privileges } },
    }
    return u as unknown as UserContext
  }

  it('an Operator loses maker rights (and the session says so); a Full user keeps them; applying twice changes nothing', async () => {
    const op = await applyPass(services('operator'), ctx('u_p3_op', true))
    expect(op.pass).toBe('operator')
    expect(op.privileges.isMaker).toBe(false)
    expect((op.session() as { privileges: { isMaker: boolean } }).privileges.isMaker).toBe(false)
    expect((await applyPass(services('full'), op)).privileges.isMaker).toBe(false)
    const full = await applyPass(services(null), ctx('u_p3_full', true))
    expect(full.pass).toBe('full')
    expect(full.privileges.isMaker).toBe(true)
  })

  it('pass: "full", maker and design routes refuse an Operator, also an administrator; other routes do not', () => {
    const op = { pass: 'operator' } as UserContext
    expect(passRefusal({ auth: 'user', pass: 'full' }, 'POST', op)?.message).toBe(PASS_REQUIRED_MESSAGE)
    expect(passRefusal({ auth: 'user', pass: 'full' }, 'GET', op)?.status).toBe(403)
    expect(passRefusal({ auth: 'user', design: true }, 'POST', op)?.status).toBe(403)
    expect(passRefusal({ auth: 'user' }, 'POST', op)).toBeNull()
    expect(passRefusal({ auth: 'user', pass: 'full' }, 'POST', { pass: 'full' } as UserContext)).toBeNull()
  })
})

/* ------------------------------------------------------------------ guards: sanitisers */

describe('guard: the note and comment sanitisers against hostile shapes and schemes', () => {
  it('deep nesting, floods and unclosed constructs finish quickly at the largest accepted input', () => {
    const shapes = [
      '<div>'.repeat(MAX_INPUT / 5), '<b>'.repeat(MAX_INPUT / 3), '<ul><li>'.repeat(MAX_INPUT / 8), '<table><tr><td>'.repeat(MAX_INPUT / 15),
      '<'.repeat(MAX_INPUT), '&#x41;'.repeat(MAX_INPUT / 6), '<script>' + 'a'.repeat(MAX_INPUT - 8), '<!--' + 'a'.repeat(MAX_INPUT - 4),
      '<a ' + 'x=1 '.repeat(MAX_INPUT / 4 - 10) + 'href="https://a">y</a>',
    ]
    for (const s of shapes) {
      const t0 = performance.now()
      sanitizeNoteHtml(s)
      sanitizeRichText(s)
      // generous for a loaded CI machine; the measured times were below 0.2 s
      expect(performance.now() - t0, s.slice(0, 20)).toBeLessThan(5000)
    }
  })

  it('script URLs, entity-encoded schemes, event attributes and mutation-XSS shapes do not survive', () => {
    const corpus = [
      '<a href="javascript:alert(1)">x</a>', '<a href="jav&#x09;ascript:alert(1)">x</a>', '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href=" javascript:alert(1)">x</a>', '<a href="https://x&quot; onmouseover=&quot;alert(1)">q</a>', '<img src=x onerror=alert(1) data-att="att_1">',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', '<p><style><img src=x onerror=alert(1)></style></p>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', '<a/href="javascript:alert(1)">x</a><p/onclick=alert(1)>y',
      '<span data-mention="a" onclick="x">n</span>', '<svg><a xlink:href="javascript:alert(1)">x</a></svg>', '<a href="data:text/html,<script>alert(1)</script>">d</a>',
    ]
    for (const html of corpus) {
      for (const out of [sanitizeNoteHtml(html), sanitizeRichText(html)]) {
        expect(out, html).not.toMatch(/javascript:|data:text|<script|<style|<svg|<math/i)
        // outside quoted attribute values (an encoded quote inside a value stays inside it): no event attribute, no image source
        expect(out.replace(/"[^"]*"/g, '""'), html).not.toMatch(/\son[a-z]+=|<img[^>]*\ssrc=/i)
      }
    }
  })
})
