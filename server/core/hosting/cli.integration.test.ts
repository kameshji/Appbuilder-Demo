/**
 * H-A / H-C server commands against the sandbox PostgreSQL (in process): migrate, admin invite, read-only on/off/status
 * (with a server running on the same database), hosting-check. Every change is audited with source "cli".
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/hosting
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PG_URL, SKIP_PG, createDatabase, dropDatabase, pgQuery, pgServer, testDatabaseName } from '../testdb.ts'
import { createApp, type AppServer } from '../app.ts'
import { Client } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runHostingCli } from './cli.ts'
import { readOnlyGateFor } from './read-only.ts'
import { configureHosting, hostingSettings } from './settings.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core/hosting cli integration] ${SKIP_PG}\n`)

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err, text: () => [...out, ...err].join('\n') }
}

describe.skipIf(!PG_URL)('hosting server commands (PostgreSQL)', () => {
  const dbName = testDatabaseName('hacli')
  let tmp = ''
  let env: NodeJS.ProcessEnv = {}
  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => pgQuery<T>(dbName, sql, p)

  beforeAll(async () => {
    await createDatabase(dbName)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hacli-'))
    env = {
      APPBUILDER_WORKSPACE: path.join(tmp, 'workspace'), APPBUILDER_DB_HOST: pgServer!.host, APPBUILDER_DB_PORT: String(pgServer!.port),
      APPBUILDER_DB_NAME: dbName, APPBUILDER_DB_USER: pgServer!.user, APPBUILDER_DB_PASSWORD: pgServer!.password,
      APPBUILDER_PUBLIC_URL: 'https://acme.apps.example.test', APPBUILDER_SETUP: 'closed',
    }
  }, 30_000)

  afterAll(async () => {
    await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 30_000)

  it('migrate creates the schema on an empty database, then reports it up to date', async () => {
    const c = capture()
    expect(await runHostingCli(['migrate'], { env, io: c.io }), c.text()).toBe(0)
    expect(c.out.join('\n')).toMatch(/Schema (migrated from version 0 to \d+|version \d+)/)
    const again = capture()
    expect(await runHostingCli(['migrate'], { env, io: again.io })).toBe(0)
    expect(again.out.join('\n')).toMatch(/up to date/)
    const audit = await q<{ details: Record<string, unknown> }>(`SELECT details FROM ab.audit WHERE action = 'install.cli_migrate' ORDER BY id`)
    expect(audit).toHaveLength(2)
    expect(audit[0].details).toMatchObject({ source: 'cli', osUser: expect.any(String) })
  }, 30_000)

  it('admin invite: the first install administrator without a password, a one-time link at the locked URL', async () => {
    const bad = capture()
    expect(await runHostingCli(['invite', '--email', 'nope'], { env, io: bad.io })).toBe(64)
    // no mail relay in this install: refused unless the operator asks for the link
    const noMail = capture()
    expect(await runHostingCli(['invite', '--email', 'ada@example.com', '--name', 'Ada Admin'], { env, io: noMail.io })).toBe(2)
    expect(noMail.err.join('\n')).toMatch(/--print-link/)
    expect(await q(`SELECT 1 FROM ab.users`)).toEqual([])
    const c = capture()
    expect(await runHostingCli(['invite', '--email', 'Ada@Example.com', '--name', 'Ada Admin', '--print-link'], { env, io: c.io }), c.text()).toBe(0)
    const link = /Invitation link \(one-time, a secret\): (\S+)/.exec(c.out.join('\n'))?.[1] ?? ''
    expect(link).toMatch(/^https:\/\/acme\.apps\.example\.test\/#invite=[\w-]{20,}$/)
    const u = await q<{ email: string; password_hash: string | null; is_install_admin: boolean; status: string }>(`SELECT email, password_hash, is_install_admin, status FROM ab.users`)
    expect(u).toEqual([{ email: 'ada@example.com', password_hash: null, is_install_admin: true, status: 'active' }])
    expect(JSON.parse(fs.readFileSync(path.join(env.APPBUILDER_WORKSPACE!, 'server.json'), 'utf8')).setupComplete).toBe(true)
    const audit = await q<{ details: Record<string, unknown> }>(`SELECT details FROM ab.audit WHERE action = 'install.cli_admin_invite'`)
    expect(audit[0].details).toMatchObject({ email: 'ada@example.com', first: true, emailed: false, source: 'cli' })
    expect(JSON.stringify(audit)).not.toContain(link.split('=')[1])
    // the same email again: refused
    const dup = capture()
    expect(await runHostingCli(['invite', '--email', 'ada@example.com', '--name', 'Ada', '--print-link'], { env, io: dup.io })).toBe(1)

    // the server (setup over HTTP closed) and the invitation: the administrator chooses a password and is signed in
    const app = await createApp({ env, printSetupCode: false, jobs: false })
    // in one process with other suites the settings are attached (the server process reads them from its environment);
    // plain http here, so not the https public URL (its __Host- cookies are proven by main.integration.test.ts)
    configureHosting(app.services, hostingSettings({ APPBUILDER_SETUP: 'closed' }))
    const server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const A = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      expect((await A.post('/setup/admin', { name: 'Eve', email: 'eve@example.com', password: 'eve-password-123' })).status).toBe(404)
      const token = decodeURIComponent(link.split('#invite=')[1])
      const acc = await A.post('/auth/invitation/accept', { token, password: 'a-long-password-1' })
      expect(acc.status, JSON.stringify(acc.data)).toBe(200)
      expect((await A.get('/auth/session')).status).toBe(200)
      // single use
      expect((await new Client(A.base).post('/auth/invitation/accept', { token, password: 'a-long-password-2' })).status).toBe(422)
      await readOnlyWhileRunning(app, A)
      await lockedPublicUrl(app, A)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      await app.close()
    }
  }, 60_000)

  /** the command works with the server running: the server applies it (within 5 s; invalidated here) */
  async function readOnlyWhileRunning(app: AppServer, A: Client) {
    const usage = capture()
    expect(await runHostingCli(['read-only', 'on', '--reason', 'later'], { env, io: usage.io })).toBe(64)
    const on = capture()
    expect(await runHostingCli(['read-only', 'on', '--reason', 'payment', '--message', 'Invoice 2026-11 is open.'], { env, io: on.io }), on.text()).toBe(0)
    expect(on.out.join('\n')).toMatch(/subscription is unpaid\. Invoice 2026-11 is open\./)
    const st = capture()
    expect(await runHostingCli(['read-only', 'status'], { env, io: st.io })).toBe(3)
    expect(st.out.join('\n')).toMatch(/read-only \(payment\)/)
    readOnlyGateFor(app.services).invalidate()
    const t = await A.post('/tables', { displayName: 'T', name: 'T1', columns: [] })
    expect(t.status).toBe(503)
    expect(t.data.error.code).toBe('install_read_only')
    const off = capture()
    expect(await runHostingCli(['read-only', 'off'], { env, io: off.io })).toBe(0)
    readOnlyGateFor(app.services).invalidate()
    expect((await A.post('/tables', { displayName: 'T', name: 'T1', columns: [] })).status).toBe(200)
    const st2 = capture()
    expect(await runHostingCli(['read-only', 'status'], { env, io: st2.io })).toBe(0)
    expect(st2.out).toEqual(['writable'])
    const audit = await q<{ action: string; details: Record<string, unknown> }>(`SELECT action, details FROM ab.audit WHERE action LIKE 'install.read_only_%' ORDER BY id`)
    expect(audit.map((a) => a.action)).toEqual(['install.read_only_on', 'install.read_only_off'])
    expect(audit[0].details).toMatchObject({ reason: 'payment', source: 'cli' })
  }

  /** APPBUILDER_PUBLIC_URL is locked: the Admin console's "Public address" cannot change it; every link uses it */
  async function lockedPublicUrl(app: AppServer, A: Client) {
    configureHosting(app.services, hostingSettings({ APPBUILDER_SETUP: 'closed', APPBUILDER_PUBLIC_URL: 'http://acme.apps.example.test' }))
    const smtp = { host: '127.0.0.1', port: 2525, security: 'none', fromAddress: 'apps@example.com', installName: 'Acme' }
    const other = await A.req('PUT', '/identity/email', { ...smtp, publicUrl: 'https://evil.example.com' })
    expect(other.status).toBe(422)
    expect(other.data.error).toMatchObject({ field: 'publicUrl', message: expect.stringContaining('set by the operator') })
    const saved = await A.req('PUT', '/identity/email', smtp)
    expect(saved.status, JSON.stringify(saved.data)).toBe(200)
    const got = await A.get('/identity/email')
    expect(got.data.settings).toMatchObject({ publicUrl: 'http://acme.apps.example.test', publicUrlLocked: true })
    const { identity } = await import('../identity/index.ts')
    expect((await identity(app.services).mail.brand()).publicUrl).toBe('http://acme.apps.example.test')
    // the stored value is the locked one, so links stay right even if the lock is lifted later
    const stored = await q<{ v: string }>(`SELECT v FROM ab.settings WHERE k = 'identity.smtp'`)
    expect(JSON.parse(stored[0].v).publicUrl).toBe('http://acme.apps.example.test')
  }

  it('hosting-check lists the settings and their problems', async () => {
    const ok = capture()
    expect(await runHostingCli(['hosting-check'], { env: { ...env, APPBUILDER_INSTANCE_DIR: tmp }, io: ok.io }), ok.text()).toBe(0)
    expect(ok.out.join('\n')).toMatch(/public URL\s+https:\/\/acme\.apps\.example\.test \(cookies with the __Host- prefix\)/)
    const bad = capture()
    expect(await runHostingCli(['hosting-check'], { env: { ...env, APPBUILDER_HOSTED: '1', APPBUILDER_OUTBOUND_PRIVATE: 'allow', APPBUILDER_INSTANCE_DIR: path.join(tmp, 'other') }, io: bad.io })).toBe(1)
    expect(bad.err).toEqual([expect.stringContaining('OUTBOUND_PRIVATE=deny'), expect.stringContaining('The workspace')])
  })
})
