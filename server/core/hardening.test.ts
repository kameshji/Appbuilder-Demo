/**
 * Regression tests for the hardening fixes that need no database: loopback-only setup routes, configured host list,
 * setup code, CSP hashes of inline scripts, Secure cookie, forced password change gate, CSV formula escaping,
 * per-email login backoff, boot retry backoff, audit diffs of roles.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { cookieIsSecure, createRouter, htmlCsp, isLoopbackAddress, originProblem, sessionCookie } from './router.ts'
import type { Services, UserContext } from './contracts.ts'
import { cspForHtmlFile, inlineScriptHashes, serveStatic } from './static.ts'
import { SETUP_CODE_LENGTH, newSetupCode, retryDelayMs } from './services.ts'
import { allowedHostList } from './config.ts'
import { csvExportText, csvSafeText } from './values.ts'
import { EMAIL_DELAY_FROM, EMAIL_LIMIT, EMAIL_MAX_DELAY_MS, EmailBackoff } from './auth.ts'
import { roleDiff } from '../routes/meta/security.ts'
import { csvSafeFile } from '../routes/meta/files.ts'
import { setQuiet } from './util.ts'

setQuiet(true)

const reqWith = (headers: Record<string, string>, socket: Record<string, unknown> = {}) => ({ headers, socket }) as unknown as http.IncomingMessage

describe('loopback-only routes (setup) and the host list', () => {
  it('isLoopbackAddress looks at the TCP peer address only', () => {
    for (const a of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) expect(isLoopbackAddress(a), a).toBe(true)
    for (const a of ['192.168.1.5', '10.0.0.1', '::ffff:192.168.1.5', 'fe80::1', '', undefined, null, '128.0.0.1', '1127.0.0.1']) expect(isLoopbackAddress(a as string), String(a)).toBe(false)
  })

  it('the Host / Origin guard compares against the configured host list', () => {
    expect(allowedHostList('0.0.0.0')).toEqual(['localhost', '127.0.0.1', '::1'])
    expect(allowedHostList('192.168.1.20', ' App.Example.org , [fe80::1]')).toEqual(['localhost', '127.0.0.1', '::1', '192.168.1.20', 'app.example.org', 'fe80::1'])
    const allowed = allowedHostList('192.168.1.20')
    expect(originProblem(reqWith({ host: '192.168.1.20:5174' }), false, allowed)).toBeNull()
    expect(originProblem(reqWith({ host: 'evil.example:5174' }), false, allowed)).toMatch(/configured host/)
    expect(originProblem(reqWith({ host: '192.168.1.20:5174', origin: 'http://192.168.1.20:5174' }), false, allowed)).toBeNull()
    expect(originProblem(reqWith({ host: '192.168.1.20:5174', origin: 'http://localhost:5174' }), false, allowed)).toMatch(/Cross-origin/)
    // default list: loopback names only
    expect(originProblem(reqWith({ host: '192.168.1.20:5174' }))).not.toBeNull()
  })

  describe('over a real socket', () => {
    let server: http.Server
    let port = 0
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address
    beforeAll(async () => {
      const router = createRouter({ ready: () => false } as unknown as Services)
      router.add('POST', '/setup/thing', () => ({ ok: true }), { auth: 'none', loopbackOnly: true })
      router.add('GET', '/open', () => ({ ok: true }), { auth: 'none' })
      server = http.createServer((req, res) => void router.handle(req, res))
      await new Promise<void>((r) => server.listen(0, '0.0.0.0', r))
      port = (server.address() as AddressInfo).port
    })
    afterAll(() => new Promise<void>((r) => server.close(() => r())))

    const send = (host: string, p: string, method = 'POST') => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host, port, path: p, method, headers: { Host: `localhost:${port}`, 'X-Appbuilder': '1', 'Content-Type': 'application/json' } }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end(method === 'GET' ? undefined : '{}')
    })

    it('a loopback client reaches the setup route', async () => {
      expect((await send('127.0.0.1', '/api/v1/setup/thing')).status).toBe(200)
    })

    it.skipIf(!lan)('a LAN client sending "Host: localhost" is refused (headers are not proof of locality)', async () => {
      const r = await send(lan!, '/api/v1/setup/thing')
      expect(r.status).toBe(403)
      expect(JSON.parse(r.body).error.message).toMatch(/computer that runs Appbuilder/)
      // other routes keep working for that client (it did send an allowed Host)
      expect((await send(lan!, '/api/v1/open', 'GET')).status).toBe(200)
    })
  })
})

describe('setup code', () => {
  it('is 8 characters from an unambiguous alphabet, random', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newSetupCode()))
    expect(codes.size).toBeGreaterThan(195)
    for (const c of codes) {
      expect(c).toHaveLength(SETUP_CODE_LENGTH)
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/)
    }
  })
})

describe('Content-Security-Policy for the single-file HTML', () => {
  const html = `<!doctype html><html><head><script type="module" crossorigin>console.log("a")</script>
    <script src="/x.js"></script><script>window.y = 1</script><script type="application/json">{"x":1}</script>
    <style>body{}</style></head><body><div id="root"></div></body></html>`

  it('hashes exactly the inline executable scripts', () => {
    const h = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64')
    expect(inlineScriptHashes(html).sort()).toEqual([h('console.log("a")'), h('window.y = 1')].sort())
  })

  it('script-src lists the hashes and never unsafe-inline; style-src keeps unsafe-inline', () => {
    const csp = htmlCsp(['abc='])
    const script = csp.split(';').find((d) => d.trim().startsWith('script-src'))!
    expect(script).toContain("'sha256-abc='")
    expect(script).not.toContain('unsafe-inline')
    expect(csp).toMatch(/style-src 'self' 'unsafe-inline'/)
    expect(csp).toContain("object-src 'none'")
  })

  it('serveStatic sends the hash-based CSP and recomputes it when the file changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-csp-'))
    const file = path.join(dir, 'index.html')
    fs.writeFileSync(file, html)
    const server = http.createServer((req, res) => serveStatic(dir, req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const csp1 = (await fetch(base + '/')).headers.get('content-security-policy')!
      for (const hash of inlineScriptHashes(html)) expect(csp1).toContain(`'sha256-${hash}'`)
      expect(csp1).not.toMatch(/script-src[^;]*unsafe-inline/)
      const next = html.replace('window.y = 1', 'window.y = 2')
      fs.writeFileSync(file, next)
      const t = new Date(Date.now() + 5000)
      fs.utimesSync(file, t, t)
      const csp2 = (await fetch(base + '/tables')).headers.get('content-security-policy')!
      expect(csp2).not.toBe(csp1)
      expect(csp2).toContain(`'sha256-${createHash('sha256').update('window.y = 2').digest('base64')}'`)
      // cache: same stat, same answer
      expect(cspForHtmlFile(file, fs.statSync(file))).toBe(csp2)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Secure session cookie', () => {
  it('plain HTTP: not Secure unless configured', () => {
    expect(cookieIsSecure(reqWith({}))).toBe(false)
    expect(sessionCookie(reqWith({}), 'tok')).not.toContain('Secure')
    expect(sessionCookie(reqWith({}), 'tok', undefined, { secureCookie: true })).toMatch(/; Secure$/)
    expect(sessionCookie(reqWith({}), null, undefined, { secureCookie: true })).toMatch(/Max-Age=0; Secure$/)
  })
  it('behind a trusted proxy: Secure when X-Forwarded-Proto is https', () => {
    expect(cookieIsSecure(reqWith({ 'x-forwarded-proto': 'https' }), { trustProxy: true })).toBe(true)
    expect(cookieIsSecure(reqWith({ 'x-forwarded-proto': 'https, http' }), { trustProxy: true })).toBe(true)
    expect(cookieIsSecure(reqWith({ 'x-forwarded-proto': 'http' }), { trustProxy: true })).toBe(false)
    // the header is ignored unless the proxy is trusted
    expect(cookieIsSecure(reqWith({ 'x-forwarded-proto': 'https' }))).toBe(false)
    expect(cookieIsSecure(reqWith({}, { encrypted: true }))).toBe(true)
  })
})

describe('forced password change gate (router)', () => {
  let server: http.Server
  let base = ''
  beforeAll(async () => {
    const router = createRouter({ ready: () => true } as unknown as Services)
    const user = { user: { id: 'u1', name: 'U', email: 'u@x.test', roleIds: [], mustChangePassword: true }, privileges: { isAdmin: true, isMaker: true, tables: {}, apps: 'all' } } as unknown as UserContext
    router.setSessionResolver(async () => user)
    router.add('GET', '/workspace', () => ({ ok: 1 }), { auth: 'user' })
    router.add('GET', '/admin-only', () => ({ ok: 1 }), { auth: 'admin' })
    router.add('GET', '/auth/session', () => ({ ok: 1 }), { auth: 'user', allowPendingPasswordChange: true })
    server = http.createServer((req, res) => void router.handle(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('every route except the allowed ones answers 403 password_change_required', async () => {
    for (const p of ['/api/v1/workspace', '/api/v1/admin-only']) {
      const r = await fetch(base + p)
      expect(r.status).toBe(403)
      expect((await r.json()).error.code).toBe('password_change_required')
    }
    expect((await fetch(base + '/api/v1/auth/session')).status).toBe(200)
  })
})

describe('CSV formula injection guard', () => {
  it('prefixes text that starts with = + - @ tab or CR; numbers stay numbers', () => {
    expect(csvSafeText('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`)
    expect(csvSafeText('+1+2')).toBe(`'+1+2`)
    expect(csvSafeText('-2+3')).toBe(`'-2+3`)
    expect(csvSafeText('@SUM(A1)')).toBe(`'@SUM(A1)`)
    expect(csvSafeText('\tx')).toBe(`'\tx`)
    expect(csvSafeText('\rx')).toBe(`'\rx`)
    expect(csvSafeText('plain')).toBe('plain')
    expect(csvSafeText('a=b')).toBe('a=b')
    expect(csvSafeText('-5')).toBe('-5')
    expect(csvSafeText('+1.5e3')).toBe('+1.5e3')
    expect(csvExportText(-5)).toBe('-5')
    expect(csvExportText(true)).toBe('true')
    expect(csvExportText(null)).toBe('')
    expect(csvExportText('=1+1')).toBe(`'=1+1`)
  })
  it('a whole CSV data file keeps its layout', () => {
    const file = '﻿id,Name,N\r\n1,=cmd|x,-3\r\n2,"a,b",@x\r\n'
    expect(csvSafeFile(file)).toBe(`﻿id,Name,N\r\n1,'=cmd|x,-3\r\n2,"a,b",'@x\r\n`)
  })
})

describe('per-email login backoff', () => {
  it('free below the threshold, then exponential waits, then a block', () => {
    const b = new EmailBackoff()
    const t0 = 1_000_000_000
    for (let i = 0; i < EMAIL_DELAY_FROM - 1; i++) b.fail('a@x', t0 + i)
    expect(b.waitMs('a@x', t0 + 100)).toBe(0)
    b.fail('a@x', t0 + 100) // the 10th failure
    expect(b.waitMs('a@x', t0 + 100)).toBe(1000)
    expect(b.waitMs('a@x', t0 + 1100)).toBe(0)
    b.fail('a@x', t0 + 1100)
    expect(b.waitMs('a@x', t0 + 1100)).toBe(2000)
    b.fail('a@x', t0 + 3100)
    expect(b.waitMs('a@x', t0 + 3100)).toBe(4000)
    // other emails are not affected
    expect(b.waitMs('b@x', t0 + 3100)).toBe(0)
    // capped delay, then a block at the limit
    let t = t0 + 10000
    for (let i = 12; i < EMAIL_LIMIT; i++) b.fail('a@x', (t += 1)) // 12 failures so far
    expect(b.waitMs('a@x', t)).toBeGreaterThan(EMAIL_MAX_DELAY_MS) // blocked until the oldest failure ages out
    b.reset('a@x')
    expect(b.waitMs('a@x', t)).toBe(0)
  })
})

describe('boot retry backoff', () => {
  it('1 s doubling, capped at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })
})

describe('audit diff of roles', () => {
  it('reports changed fields and per-table privileges, before and after', () => {
    const before = { id: 'r', name: 'Sales', privileges: [{ table: 't1', create: false, read: 'all' as const, update: 'none' as const, delete: 'none' as const }], apps: 'all' as const }
    const after = { ...before, name: 'Sales team', isMaker: true, privileges: [{ ...before.privileges[0], update: 'own' as const }, { table: 't2', create: true, read: 'all' as const, update: 'all' as const, delete: 'all' as const }] }
    const d = roleDiff(before, after)
    expect(d.name).toEqual({ before: 'Sales', after: 'Sales team' })
    expect(d.isMaker).toEqual({ before: false, after: true })
    expect(d['privileges.t1'].before).toMatchObject({ update: 'none' })
    expect(d['privileges.t1'].after).toMatchObject({ update: 'own' })
    expect(d['privileges.t2']).toEqual({ before: null, after: after.privileges[1] })
    expect(d.apps).toBeUndefined()
  })
})
