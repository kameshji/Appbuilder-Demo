/**
 * Package L over HTTP against the sandbox PostgreSQL: public and detailed health, server logs, usage, the diagnostics
 * bundle (no secrets), staged updates, the setup code file, setup refused through a local reverse proxy.
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/core/diagnostics
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PG_URL, SKIP_PG, dropDatabase, pgServer, testDatabaseName } from '../testdb.ts'
import { createApp } from '../app.ts'
import type { AppServer } from '../app.ts'
import { setQuiet, log } from '../util.ts'
import { startFileLogging, stopFileLogging } from './logger.ts'
import { readZip, writeZip } from '../update/zip.ts'
import { writeSums } from '../update/release.ts'

setQuiet(true)
const conn = pgServer
const dbName = testDatabaseName('ops')

class Client {
  cookie = ''
  base: string
  constructor(base: string) {
    this.base = base
  }
  async req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { 'X-Appbuilder': '1', ...headers }
    if (this.cookie) h.Cookie = this.cookie
    let payload: BodyInit | undefined
    if (Buffer.isBuffer(body)) { payload = new Uint8Array(body); h['Content-Type'] = 'application/octet-stream' }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json' }
    const res = await fetch(this.base + p, { method, headers: h, body: payload })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    const buf = Buffer.from(await res.arrayBuffer())
    let data: any = null
    try { data = JSON.parse(buf.toString('utf8')) } catch { data = null }
    return { status: res.status, data, buf, headers: res.headers }
  }
}

describe.skipIf(!PG_URL)(PG_URL ? 'operations endpoints (PostgreSQL)' : `operations endpoints (PostgreSQL) ${SKIP_PG}`, () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let base = ''
  let A: Client
  const codeFile = () => path.join(tmp, 'setup-code.txt')

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ops-'))
    startFileLogging(tmp, { APPBUILDER_LOG_DIR: path.join(tmp, 'logs') })
    app = await createApp({ env: { APPBUILDER_SETUP_CODE_FILE: path.join(tmp, 'setup-code.txt') }, config: { workspaceDir: tmp }, printSetupCode: true })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    A = new Client(base)
  }, 60000)

  afterAll(async () => {
    stopFileLogging()
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('before setup: health is "starting", the setup code is in the file, setup through a proxy is refused', async () => {
    const h = await A.req('GET', '/api/v1/health')
    expect(h.status).toBe(503)
    expect(h.data).toEqual({ status: 'starting' })
    const code = app.services.setupCode.current()!
    expect(fs.readFileSync(codeFile(), 'utf8')).toContain(`${code.slice(0, 4)}-${code.slice(4)}`)
    if (process.platform !== 'win32') expect(fs.statSync(codeFile()).mode & 0o077).toBe(0)
    // a local reverse proxy (Caddy) connects from 127.0.0.1 but adds X-Forwarded-For: not "this computer"
    const viaProxy = await A.req('POST', '/api/v1/setup/database', { setupCode: code, host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true }, { 'X-Forwarded-For': '203.0.113.9' })
    expect(viaProxy.status).toBe(403)
    expect((await A.req('POST', '/api/v1/setup/database', { setupCode: code, host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })).status).toBe(200)
    expect((await A.req('POST', '/api/v1/setup/admin', { setupCode: app.services.setupCode.current(), name: 'Ada', email: 'ada@example.test', password: 'admin-password-1' })).status).toBe(200)
    // the code was rotated and its file removed once the administrator exists
    expect(fs.existsSync(codeFile())).toBe(false)
  }, 60000)

  it('public health: ok, nothing else; detailed health for install administrators only', async () => {
    const h = await new Client(base).req('GET', '/api/v1/health')
    expect(h.status).toBe(200)
    expect(h.data).toEqual({ status: 'ok' })
    expect(h.headers.get('cache-control')).toBe('no-store')
    expect((await new Client(base).req('GET', '/api/v1/admin/health')).status).toBe(401)
    const d = await A.req('GET', '/api/v1/admin/health')
    expect(d.status).toBe(200)
    expect(d.data.status).toBe('ok')
    expect(d.data.database).toMatchObject({ configured: true, reachable: true })
    expect(d.data.versions.schema.database).toBe(d.data.versions.schema.server)
    expect(Math.abs(d.data.clock.skewMs)).toBeLessThan(5000)
    expect(d.data.environments.map((e: { id: string }) => e.id)).toContain('default')
    expect(d.data.jobs).toMatchObject({ dead: 0 })
    const keys = d.data.checks.map((c: { key: string }) => c.key)
    expect(keys).toEqual(expect.arrayContaining(['database', 'clock', 'environments', 'backups', 'jobs', 'mail', 'disk:workspace']))
    expect(d.data.checks.find((c: { key: string }) => c.key === 'mail').status).toBe('warn')
    expect(d.data.logs.dir).toBe(path.join(tmp, 'logs'))
  })

  it('health alerts (P1-E): settings, immediate alerts once per condition, daily summary, heartbeat through the outbound policy', async () => {
    expect((await new Client(base).req('GET', '/api/v1/admin/health-alerts')).status).toBe(401)
    // a heartbeat receiver on this computer (an uptime monitor in the local network)
    const pings: string[] = []
    const mon = http.createServer((req, res) => { pings.push(String(req.url)); res.writeHead(200).end('OK') })
    await new Promise<void>((r) => mon.listen(0, '127.0.0.1', r))
    const monUrl = `http://127.0.0.1:${(mon.address() as AddressInfo).port}/ping/secret-check-id`
    try {
      expect((await A.req('PUT', '/api/v1/admin/health-alerts', { heartbeat: { enabled: true } })).status).toBe(422) // no address yet
      expect((await A.req('PUT', '/api/v1/admin/health-alerts', { heartbeat: { url: 'http://169.254.169.254/latest' } })).status).toBe(422)
      expect((await A.req('PUT', '/api/v1/admin/health-alerts', { heartbeat: { url: monUrl, everyMinutes: 7 } })).status).toBe(422)
      const r = await A.req('PUT', '/api/v1/admin/health-alerts', { email: { enabled: true, dailyTime: '06:45', timeZone: 'Asia/Kolkata' }, heartbeat: { url: monUrl, enabled: true, everyMinutes: 5 } })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      expect(r.data.settings.heartbeat).toMatchObject({ enabled: true, hasUrl: true, everyMinutes: 5 })
      expect(JSON.stringify(r.data)).not.toContain('secret-check-id')
      // a private address needs the administrator's tick
      const blocked = await A.req('POST', '/api/v1/admin/health-alerts/test', { what: 'heartbeat' })
      expect(blocked.data.sent).toBe(false)
      expect(pings.length).toBe(0)
      await A.req('PUT', '/api/v1/admin/health-alerts', { heartbeat: { allowPrivateNetwork: true } })
      const ok = await A.req('POST', '/api/v1/admin/health-alerts/test', { what: 'heartbeat' })
      expect(ok.data, JSON.stringify(ok.data)).toMatchObject({ sent: true, message: 'HTTP 200' })
      expect(pings).toEqual(['/ping/secret-check-id'])
      // schedules exist in the Default environment
      const sched = await app.services.kernel.jobs.schedules.get('sched_health_daily')
      expect(sched).toMatchObject({ enabled: true, cron: '45 6 * * *', timeZone: 'Asia/Kolkata' })
      // the audit entry says the address changed, never what it is
      const audit = await app.services.state.db!.query<{ details: unknown }>(`SELECT details FROM ab.audit WHERE action = 'install.health_alerts'`)
      expect(JSON.stringify(audit)).not.toContain('secret-check-id')
      // immediate alerts: a failed flow run in Default -> one alert to the install administrators, not repeated
      await app.services.state.db!.exec(`INSERT INTO env_default.ab_flow_runs (id, flow_id, flow_name, flow_version, owner_id, state, mode, trigger_kind, trigger_key, run_as_kind, correlation_id, created_on, finished_on)
        SELECT 'run_healthtest', 'flow_x', 'Broken flow', 1, id, 'failed', 'normal', 'manual', 'manual:healthtest', 'owner', 'c1', now(), now() FROM ab.users LIMIT 1`).catch((e) => { throw e })
      const w1 = await app.services.healthAlerts.watch()
      expect(w1.sent.some((k) => k.startsWith('flows:default:'))).toBe(true)
      const w2 = await app.services.healthAlerts.watch()
      expect(w2.sent).toEqual([])
      const admin = await app.services.meta.users.byEmail('ada@example.test')
      const n = await app.services.state.db!.query<{ title: string; kind: string }>(`SELECT title, kind FROM ab.notifications WHERE user_id = $1 AND kind = 'health'`, [admin!.id])
      expect(n.map((x) => x.title)).toEqual(['Flows are failing in Default'])
      const d = await A.req('POST', '/api/v1/admin/health-alerts/test', { what: 'daily' })
      expect(d.data.sent).toBe(true)
      const n2 = await app.services.state.db!.query<{ title: string; body: string }>(`SELECT title, body FROM ab.notifications WHERE user_id = $1 AND kind = 'health' AND title LIKE 'Daily health%'`, [admin!.id])
      expect(n2.length).toBe(1)
      expect(n2[0].body).toMatch(/Flows in Default: 1 failed run/)
      await app.services.state.db!.exec(`DELETE FROM env_default.ab_flow_runs WHERE id = 'run_healthtest'`)
      await A.req('PUT', '/api/v1/admin/health-alerts', { email: { enabled: false }, heartbeat: { enabled: false, url: '' } })
    } finally {
      await new Promise<void>((r) => mon.close(() => r()))
    }
  }, 60000)

  it('a non-administrator gets 403 on every operations route', async () => {
    const created = await A.req('POST', '/api/v1/users', { name: 'Bob', email: 'bob@example.test', password: 'bob-password-12', roleIds: [] })
    expect(created.status).toBeLessThan(300)
    const B = new Client(base)
    const login = await B.req('POST', '/api/v1/auth/login', { email: 'bob@example.test', password: 'bob-password-12' })
    expect(login.status).toBe(200)
    for (const [m, p] of [['GET', '/api/v1/admin/health'], ['GET', '/api/v1/admin/logs'], ['GET', '/api/v1/admin/usage'], ['POST', '/api/v1/admin/diagnostics'], ['GET', '/api/v1/admin/updates'], ['DELETE', '/api/v1/admin/updates/staged'], ['PUT', '/api/v1/admin/logs/settings']]) {
      const r = await B.req(m, p, m === 'PUT' ? { level: 'warn' } : undefined)
      expect([403, 409], `${m} ${p}`).toContain(r.status)
    }
  })

  it('server logs: filter, level setting, download', async () => {
    log('warn', 'ops-test warning line password=should-not-leak')
    log('info', 'ops-test info line')
    const all = await A.req('GET', '/api/v1/admin/logs?q=ops-test')
    expect(all.status).toBe(200)
    expect(all.data.enabled).toBe(true)
    expect(all.data.items.map((e: { m: string }) => e.m)).toEqual(['ops-test info line', 'ops-test warning line password=should-not-leak'])
    expect((await A.req('GET', '/api/v1/admin/logs?q=ops-test&level=warn')).data.items).toHaveLength(1)
    // requests carry ids into the log: a failed request's error line
    expect((await A.req('PUT', '/api/v1/admin/logs/settings', { level: 'loud' })).status).toBe(400)
    expect((await A.req('PUT', '/api/v1/admin/logs/settings', { level: 'warn' })).data).toEqual({ level: 'warn' })
    log('info', 'ops-test hidden at warn')
    expect((await A.req('GET', '/api/v1/admin/logs?q=hidden')).data.items).toHaveLength(0)
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'ops.json'), 'utf8')).logLevel).toBe('warn')
    await A.req('PUT', '/api/v1/admin/logs/settings', { level: 'info' })
    const dl = await A.req('GET', '/api/v1/admin/logs/download')
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-disposition')).toMatch(/attachment; filename="appbuilder-log-/)
    const text = dl.buf.toString('utf8')
    expect(text).toContain('ops-test warning line')
    expect(text).not.toContain('should-not-leak')
  })

  it('usage: users, storage, tables with row counts, jobs', async () => {
    const r = await A.req('GET', '/api/v1/admin/usage')
    expect(r.status).toBe(200)
    expect(r.data.users).toMatchObject({ total: 2, active: 2, disabled: 0 })
    expect(r.data.users.signedIn.day).toBeGreaterThanOrEqual(1)
    expect(r.data.storage.databaseBytes).toBeGreaterThan(0)
    const def = r.data.environments.find((e: { id: string }) => e.id === 'default')
    const contacts = def.tables.find((t: { name: string }) => t.name === 't_contacts')
    expect(contacts).toMatchObject({ system: false, approximate: false })
    expect(contacts.rows).toBeGreaterThan(0)
    expect(def.tables.some((t: { system: boolean }) => t.system)).toBe(true)
    expect(def.jobs).toMatchObject({ dead: 0 })
  }, 30_000) // counts every table: seconds on a busy Windows machine

  it('diagnostics bundle: a ZIP with health, schema, errors and logs, and no secret', async () => {
    const r = await A.req('POST', '/api/v1/admin/diagnostics')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/zip')
    const entries = readZip(r.buf)
    const names = entries.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['README.txt', 'config.json', 'health.json', 'schema.json', 'recent-errors.json', 'versions.json', 'logs/appbuilder.log']))
    const all = entries.map((e) => e.data.toString('utf8')).join('\n')
    expect(all).not.toContain(conn!.password)
    expect(all).not.toContain(fs.readFileSync(path.join(tmp, '.secret-key'), 'utf8').trim())
    expect(all).not.toContain('should-not-leak')
    expect(all).not.toContain('ada@example.test')
    expect(JSON.parse(entries.find((e) => e.name === 'schema.json')!.data.toString()).environments[0]).toMatchObject({ id: 'default', state: 'ready' })
    const audit = await A.req('GET', '/api/v1/install/audit?action=diagnostics.bundle')
    if (audit.status === 200) expect(JSON.stringify(audit.data)).toContain('diagnostics.bundle')
  })

  it('updates: shows the current release, stages an uploaded package with its notes, refuses a tampered one', async () => {
    const info = await A.req('GET', '/api/v1/admin/updates')
    expect(info.status).toBe(200)
    expect(info.data).toMatchObject({ installed: false, staged: null, applyCommand: null })
    expect(info.data.current.schemaVersion).toBeGreaterThan(0)

    const rel = path.join(tmp, 'pkg', 'appbuilder-9.9.9')
    fs.mkdirSync(path.join(rel, 'server'), { recursive: true })
    fs.writeFileSync(path.join(rel, 'release.json'), JSON.stringify({ name: 'appbuilder', version: '9.9.9', commit: 'abc123', built: '2026-11-18T00:00:00Z', schemaVersion: info.data.current.schemaVersion, node: '>=22.18' }))
    fs.writeFileSync(path.join(rel, 'server', 'main.ts'), 'x\n')
    fs.writeFileSync(path.join(rel, 'RELEASE-NOTES.md'), '# 9.9.9\n- Better things\n')
    writeSums(rel)
    const zipOf = () => writeZip(['release.json', 'server/main.ts', 'RELEASE-NOTES.md', 'SHA256SUMS'].map((f) => ({ name: `appbuilder-9.9.9/${f}`, data: fs.readFileSync(path.join(rel, f)) })))
    const up = await A.req('POST', '/api/v1/admin/updates/upload', zipOf())
    expect(up.status).toBe(200)
    expect(up.data).toMatchObject({ version: '9.9.9', checksums: 'ok', signature: { state: 'unsigned' }, applicable: true, problems: [] })
    expect(up.data.releaseNotes).toContain('Better things')
    expect((await A.req('GET', '/api/v1/admin/updates')).data.staged.version).toBe('9.9.9')

    fs.appendFileSync(path.join(rel, 'server', 'main.ts'), 'tampered\n')
    const bad = await A.req('POST', '/api/v1/admin/updates/upload', zipOf())
    expect(bad.status).toBe(200)
    expect(bad.data).toMatchObject({ checksums: 'failed', applicable: false })
    expect(bad.data.problems[0]).toMatch(/checksum/)
    expect((await A.req('POST', '/api/v1/admin/updates/upload', Buffer.from('not a zip'))).status).toBe(422)
    expect((await A.req('DELETE', '/api/v1/admin/updates/staged')).status).toBe(200)
    expect((await A.req('GET', '/api/v1/admin/updates')).data.staged).toBeNull()
  })
})
