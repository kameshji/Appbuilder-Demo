/**
 * H-A settings, __Host- cookies and the outbound policy of a hosted install (no database).
 *   npx vitest run server/core/hosting
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_DB_POOL, DEFAULT_JOBS_POLL_MS, DEFAULT_SHUTDOWN_MS, HOSTED_DB_POOL, HOSTED_JOBS_POLL_MS, HOSTED_SHUTDOWN_MS,
  applyHostingDefaults, configureHosting, hostingFor, hostingSettings, loadInstanceEnv, lockedPublicUrl, normalisePublicUrl, writePathProblems,
} from './settings.ts'
import { adaptCookiesIn, adaptCookiesOut, hostCookie } from './cookies.ts'
import { assertOutboundHost, deniedByList, hostProblem } from '../net-policy.ts'
import { OutboundError, resolveAllowed, safeRequest, type OutboundPolicy } from '../actions/outbound.ts'
import { sendSmtp } from '../identity/smtp.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('hosting settings (H-A)', () => {
  it('nothing set: today\'s on-premises behaviour, no problems', () => {
    const s = hostingSettings({})
    expect(s).toMatchObject({ hosted: false, socket: null, publicUrl: null, hostCookies: false, setupClosed: false, dbPool: DEFAULT_DB_POOL, jobsPollMs: DEFAULT_JOBS_POLL_MS, instanceDir: null, readOnly: null, shutdownMs: DEFAULT_SHUTDOWN_MS, problems: [] })
    expect(DEFAULT_DB_POOL).toBe(10)
    expect(DEFAULT_SHUTDOWN_MS).toBe(5000)
    // and the defaults touch nothing on-premises
    const env: NodeJS.ProcessEnv = { PORT: '5174' }
    expect(applyHostingDefaults(env)).toEqual([])
    expect(env).toEqual({ PORT: '5174' })
  })

  it('the hosted profile uses the spec\'s numbers (pool 6, polling 5 s) and closes setup over HTTP', () => {
    const s = hostingSettings({ APPBUILDER_HOSTED: '1', APPBUILDER_PUBLIC_URL: 'https://Acme.Apps.example.com/', APPBUILDER_SOCKET: '/run/appbuilder/o1/http.sock' })
    expect(s).toMatchObject({ hosted: true, publicUrl: 'https://acme.apps.example.com', hostCookies: true, setupClosed: true, dbPool: HOSTED_DB_POOL, jobsPollMs: HOSTED_JOBS_POLL_MS, shutdownMs: HOSTED_SHUTDOWN_MS, socketMode: 0o660, problems: [] })
    expect([HOSTED_DB_POOL, HOSTED_JOBS_POLL_MS]).toEqual([6, 5000])
    // each one can still be set on its own
    expect(hostingSettings({ APPBUILDER_HOSTED: '1', APPBUILDER_PUBLIC_URL: 'https://a.example.com', APPBUILDER_DB_POOL: '8', APPBUILDER_JOBS_POLL_MS: '2000', APPBUILDER_SETUP: 'open' })).toMatchObject({ dbPool: 8, jobsPollMs: 2000, setupClosed: false })
    // on-premises can opt into single options
    expect(hostingSettings({ APPBUILDER_SETUP: 'closed', APPBUILDER_DB_POOL: '4' })).toMatchObject({ hosted: false, setupClosed: true, dbPool: 4 })
  })

  it('applies the hosted defaults other modules read from the environment', () => {
    const env: NodeJS.ProcessEnv = { APPBUILDER_HOSTED: '1', APPBUILDER_PUBLIC_URL: 'https://acme.apps.example.com', APPBUILDER_ALLOWED_HOSTS: 'other.example.com' }
    applyHostingDefaults(env)
    expect(env).toMatchObject({
      APPBUILDER_OUTBOUND_PRIVATE: 'deny', APPBUILDER_JOBS_POLL_MS: '5000', APPBUILDER_TRUST_PROXY: '1', APPBUILDER_SECURE_COOKIE: '1',
      APPBUILDER_ALLOWED_HOSTS: 'other.example.com,acme.apps.example.com', APPBUILDER_OUTBOUND_DENY: 'acme.apps.example.com',
    })
    // idempotent
    applyHostingDefaults(env)
    expect(env.APPBUILDER_ALLOWED_HOSTS).toBe('other.example.com,acme.apps.example.com')
    expect(env.APPBUILDER_OUTBOUND_DENY).toBe('acme.apps.example.com')
  })

  it('refuses unusable settings (the server does not start with any)', () => {
    const p = (env: NodeJS.ProcessEnv) => hostingSettings(env).problems
    expect(p({ APPBUILDER_HOSTED: '1' })).toEqual([expect.stringContaining('APPBUILDER_PUBLIC_URL')])
    expect(p({ APPBUILDER_HOSTED: '1', APPBUILDER_PUBLIC_URL: 'https://a.example.com', APPBUILDER_OUTBOUND_PRIVATE: 'allow' })).toEqual([expect.stringContaining('OUTBOUND_PRIVATE=deny')])
    expect(p({ APPBUILDER_PUBLIC_URL: 'ftp://a.example.com' })).toHaveLength(1)
    expect(p({ APPBUILDER_PUBLIC_URL: 'https://u:p@a.example.com' })).toHaveLength(1)
    expect(p({ APPBUILDER_DB_POOL: '1' })).toHaveLength(1)
    expect(p({ APPBUILDER_SOCKET: 'relative.sock' })).toHaveLength(1)
    expect(p({ APPBUILDER_SOCKET_MODE: '666' })).toHaveLength(1)
    expect(p({ APPBUILDER_READ_ONLY: 'nonsense' })).toHaveLength(1)
    expect(p({ APPBUILDER_SETUP: 'maybe' })).toHaveLength(1)
    // a bad polling value is ignored by jobs.ts (today), so it is not a start-up problem
    expect(hostingSettings({ APPBUILDER_JOBS_POLL_MS: 'x' })).toMatchObject({ jobsPollMs: 1000, problems: [] })
    expect(normalisePublicUrl('https://a.example.com/apps/')).toBe('https://a.example.com/apps')
  })

  it('read-only from the environment: 1 is "suspended", or a named reason', () => {
    expect(hostingSettings({ APPBUILDER_READ_ONLY: '1' }).readOnly).toEqual({ reason: 'suspended', message: '' })
    expect(hostingSettings({ APPBUILDER_READ_ONLY: 'payment', APPBUILDER_READ_ONLY_MESSAGE: 'Invoice 12\nis open' }).readOnly).toEqual({ reason: 'payment', message: 'Invoice 12 is open' })
    expect(hostingSettings({ APPBUILDER_READ_ONLY: '0' }).readOnly).toBeNull()
  })

  it('nothing outside the instance folder: workspace, logs, backups and the setup-code file', () => {
    const inst = path.join(os.tmpdir(), 'ab-ha-inst')
    const s = hostingSettings({ APPBUILDER_INSTANCE_DIR: inst })
    expect(writePathProblems(s, { workspaceDir: path.join(inst, 'workspace'), env: { APPBUILDER_BACKUP_DIR: path.join(inst, 'backups') } })).toEqual([])
    const bad = writePathProblems(s, { workspaceDir: path.join(inst, '..', 'elsewhere'), env: { APPBUILDER_LOG_DIR: path.join(os.tmpdir(), 'logs'), APPBUILDER_SETUP_CODE_FILE: path.join(inst, 'x') } })
    expect(bad).toHaveLength(2)
    expect(writePathProblems(hostingSettings({}), { workspaceDir: '/anywhere' })).toEqual([])
  })

  it('the per-instance environment file is loaded, values already set win', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ha-env-'))
    try {
      const f = path.join(dir, 'instance.env')
      fs.writeFileSync(f, '# instance\nPORT=7101\nAPPBUILDER_PUBLIC_URL="https://o1.example.com"\nAPPBUILDER_WORKSPACE=/srv/appbuilder/o1/workspace\n')
      const env: NodeJS.ProcessEnv = { APPBUILDER_ENV_FILE: f, PORT: '7000' }
      expect(loadInstanceEnv(env)).toBe(f)
      expect(env).toMatchObject({ PORT: '7000', APPBUILDER_PUBLIC_URL: 'https://o1.example.com', APPBUILDER_WORKSPACE: '/srv/appbuilder/o1/workspace' })
      expect(loadInstanceEnv({})).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('settings per services object (tests), else process.env', () => {
    const svc = {}
    expect(lockedPublicUrl(svc)).toBe(hostingSettings(process.env).publicUrl)
    configureHosting(svc, hostingSettings({ APPBUILDER_PUBLIC_URL: 'https://b.example.com' }))
    expect(lockedPublicUrl(svc)).toBe('https://b.example.com')
    expect(hostingFor(svc).hostCookies).toBe(true)
  })
})

describe('__Host- cookies (H-A)', () => {
  it('renames, forces Secure and Path=/, drops Domain', () => {
    expect(hostCookie('ab_session=abc; HttpOnly; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT')).toBe('__Host-ab_session=abc; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/; Secure')
    expect(hostCookie('ab_td=x; Domain=example.com; Path=/a; Secure; Max-Age=10')).toBe('__Host-ab_td=x; Max-Age=10; Path=/; Secure')
    expect(hostCookie('other=1; Path=/')).toBe('other=1; Path=/')
  })

  it('in: only __Host- cookies are read (plain and tossed ones are ignored); out: renamed, old ones cleared', async () => {
    const seen: (string | undefined)[] = []
    const server = http.createServer((req, res) => {
      adaptCookiesOut(req, res)
      seen.push(req.headers.cookie)
      res.setHeader('Set-Cookie', ['ab_session=new; HttpOnly; SameSite=Strict; Path=/'])
      // headers given to writeHead itself are adapted as well
      res.writeHead(200, { 'Set-Cookie': 'ab_mfa=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const res = await fetch(base, { headers: { Cookie: 'ab_session=tossed-or-old; __Host-ab_session=mine; theme=dark; __Host-ab_td=dev' } })
      expect(seen[0]).toBe('ab_session=mine; theme=dark; ab_td=dev')
      expect(res.headers.getSetCookie()).toEqual([
        '__Host-ab_session=new; HttpOnly; SameSite=Strict; Path=/; Secure',
        '__Host-ab_mfa=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/; Secure',
        'ab_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      ])
      // only a plain (pre-switch) cookie: the request is anonymous, the old cookie is cleared
      const old = await fetch(base, { headers: { Cookie: 'ab_session=old' } })
      expect(seen[1]).toBeUndefined()
      expect(old.headers.getSetCookie()).toContain('ab_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('adaptCookiesIn is idempotent (router and upgrade handler may both call it)', () => {
    const req = { headers: { cookie: '__Host-ab_session=a; ab_dev=b' } } as unknown as http.IncomingMessage
    expect(adaptCookiesIn(req)).toEqual(['ab_dev'])
    expect(adaptCookiesIn(req)).toEqual(['ab_dev'])
    expect(req.headers.cookie).toBe('ab_session=a')
  })
})

describe('outbound policy of a hosted install: APPBUILDER_OUTBOUND_PRIVATE=deny everywhere (H-A)', () => {
  const deny = { APPBUILDER_OUTBOUND_PRIVATE: 'deny' }
  const prev = process.env.APPBUILDER_OUTBOUND_PRIVATE
  afterEach(() => {
    if (prev === undefined) delete process.env.APPBUILDER_OUTBOUND_PRIVATE
    else process.env.APPBUILDER_OUTBOUND_PRIVATE = prev
  })

  it('literal checks (database connections, the SMTP relay, the heartbeat URL, OAuth token URLs) refuse loopback and private', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '::1', '[::ffff:127.0.0.1]', 'fd00::1']) expect(hostProblem(h, deny), h).not.toBeNull()
    // on-premises default: allowed (unchanged)
    expect(hostProblem('10.1.2.3', {})).toBeNull()
    expect(hostProblem('db.internal.example', deny)).toBeNull()
  })

  it('names that resolve to private addresses are refused after DNS (database connections, SMTP, OAuth)', async () => {
    const lookup = async () => [{ address: '10.0.0.7' }]
    await expect(assertOutboundHost('db.internal.example', 'Connection', { env: deny, lookup })).rejects.toThrow(/private address/)
    await expect(assertOutboundHost('db.internal.example', 'Connection', { env: {}, lookup })).resolves.toEqual(['10.0.0.7'])
  })

  it('HTTP connectors, webhooks, flows and the heartbeat: deny wins over a connection\'s own "allow private network"', async () => {
    let hits = 0
    const server = http.createServer((_req, res) => { hits++; res.end('{}') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const port = (server.address() as AddressInfo).port
      const p = (env: NodeJS.ProcessEnv): OutboundPolicy => ({ allowedHosts: ['127.0.0.1'], allowPrivate: true, maxRedirects: 0, maxResponseBytes: 1024, timeoutMs: 5000, verifyTls: true, env })
      await expect(resolveAllowed('127.0.0.1', p(deny))).rejects.toBeInstanceOf(OutboundError)
      await expect(safeRequest({ url: `http://127.0.0.1:${port}/`, method: 'GET' }, p(deny))).rejects.toMatchObject({ code: 'blocked' })
      expect(hits).toBe(0)
      // the opt-in is real without deny: the same request reaches the server
      const ok = await safeRequest({ url: `http://127.0.0.1:${port}/`, method: 'GET' }, p({}))
      expect(ok.status).toBe(200)
      expect(hits).toBe(1)
      // a public name that resolves to loopback (rebinding) is refused too
      await expect(resolveAllowed('api.rebind.test', { ...p(deny), lookup: async () => [{ address: '127.0.0.1', family: 4 }] })).rejects.toMatchObject({ code: 'blocked' })
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('the SMTP relay connects only after the check (process environment)', async () => {
    process.env.APPBUILDER_OUTBOUND_PRIVATE = 'deny'
    await expect(sendSmtp({ host: '127.0.0.1', port: 25, security: 'none', verifyCertificate: true, timeoutMs: 2000 }, { from: { address: 'a@example.com' }, to: 'b@example.com', subject: 's', text: 't' })).rejects.toThrow(/loopback/)
  })

  it('APPBUILDER_OUTBOUND_DENY: the install\'s own public host and its siblings are refused by every check', async () => {
    const env = { APPBUILDER_OUTBOUND_DENY: 'acme.apps.example.com,*.apps.example.com' }
    expect(deniedByList('ACME.apps.example.com.', env)).toBe(true)
    expect(deniedByList('other.apps.example.com', env)).toBe(true)
    expect(deniedByList('apps.example.com', env)).toBe(false)
    expect(hostProblem('b.apps.example.com', env)).toMatch(/APPBUILDER_OUTBOUND_DENY/)
    const p: OutboundPolicy = { allowedHosts: ['*.example.com'], allowPrivate: false, maxRedirects: 0, maxResponseBytes: 1024, timeoutMs: 1000, verifyTls: true, env, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }
    await expect(resolveAllowed('b.apps.example.com', p)).rejects.toMatchObject({ code: 'blocked' })
    await expect(resolveAllowed('www.example.com', p)).resolves.toMatchObject({ address: '93.184.216.34' })
  })

  it('every server file that opens a connection is known and goes through the policy (a new one fails until reviewed)', () => {
    // file -> why its connections are safe in a hosted install
    const KNOWN: Record<string, string> = {
      'server/main.ts': 'the system database pool and the stale-socket probe of its own socket',
      'server/connectors/postgres/db.ts': 'driver pool: hosts are checked by hostProblem (connector validity) and assertOutboundHost (saving a connection)',
      'server/connectors/postgres/index.ts': 'the same, per connection',
      'server/connectors/mysql/db.ts': 'the same, per connection',
      'server/connectors/gsheets/index.ts': 'fixed Google API hosts',
      'server/core/jobs.ts': 'the LISTEN connection to the system database',
      'server/core/services.ts': 'the system database',
      'server/core/backup/engine.ts': 'the system database',
      'server/core/backup/cli.ts': 'the system database (restore command)',
      'server/core/update/cli.ts': 'the system database and the own health endpoint (commands)',
      'server/core/identity/admin-cli.ts': 'the system database (recovery commands)',
      'server/core/hosting/cli.ts': 'the system database and the own socket (hosting commands)',
      'server/core/identity/smtp.ts': 'connects to the address assertOutboundHost returned',
      'server/core/pwa.ts': 'service worker source for the browser (same origin)',
      // H-G: set by the operator in the install's environment, never typed in the product; https only (http for 127.0.0.1)
      'server/core/licence/client.ts': 'the licence check to APPBUILDER_LICENCE_URL (operator setting, https, no redirects)',
      'server/licence-service/store.ts': 'the licence service process: its own database (APPBUILDER_LICENCE_DB_URL)',
      'server/core/kernel-testkit.ts': 'tests only', 'server/core/testdb.ts': 'tests only', 'server/core/print/print-testkit.ts': 'tests only',
    }
    const re = /\bnet\.connect\(|\btls\.connect\(|\bhttps?\.request\(|new pg\.(Client|Pool)\(|createPgDb\(|createPool\(|\.env\.fetch\(|(?<![.\w])fetch\(/
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|mts|mjs)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && re.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(root, p).split(path.sep).join('/'))
      }
    }
    walk(path.join(root, 'server'))
    expect(found.filter((f) => !KNOWN[f]), 'review these for the outbound policy, then add them to KNOWN').toEqual([])
    // the HTTP client of connectors checks every hop
    expect(fs.readFileSync(path.join(root, 'server/core/actions/outbound.ts'), 'utf8')).toMatch(/for \(let hop = 0; ; hop\+\+\)[\s\S]*await resolveAllowed\(url\.hostname, p\)/)
    expect(fs.readFileSync(path.join(root, 'server/core/identity/smtp.ts'), 'utf8')).toContain("assertOutboundHost(s.host, 'SMTP relay')")
  })
})
