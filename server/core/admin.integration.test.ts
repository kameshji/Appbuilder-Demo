/**
 * Admin console endpoints over HTTP against the sandbox PostgreSQL (the SQL of the audit viewer, the environment
 * facts and the admin details of /status):
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/core/admin
 * Creates a fresh database `appbuilder_test_adm_<random>` and drops it after.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PG_URL, SKIP_PG, dropDatabase, pgServer, testDatabaseName } from './testdb.ts'
import { createApp } from './app.ts'
import type { AppServer } from './app.ts'
import { setQuiet } from './util.ts'

setQuiet(true)

const URL_ENV = PG_URL
const conn = pgServer
const dbName = testDatabaseName('adm')
const SKIP = SKIP_PG

class Client {
  cookie = ''
  base: string
  constructor(base: string) {
    this.base = base
  }
  async req(method: string, p: string, body?: unknown) {
    const headers: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    return { status: res.status, data: (await res.json()) as any }
  }
}

describe.skipIf(!URL_ENV)(URL_ENV ? 'admin console endpoints (PostgreSQL)' : `admin console endpoints (PostgreSQL) ${SKIP}`, () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let A: Client
  let base = ''

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-adm-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    A = new Client(base)
    const code = () => app.services.setupCode.current() ?? ''
    expect((await A.req('POST', '/api/v1/setup/database', { setupCode: code(), host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })).status).toBe(200)
    expect((await A.req('POST', '/api/v1/setup/admin', { setupCode: code(), name: 'Ada', email: 'ada@example.test', password: 'admin-password-1' })).status).toBe(200)
  }, 60000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('status: versions for administrators only', async () => {
    const st = await A.req('GET', '/api/v1/status')
    expect(st.data.server).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+/), node: process.version, schemaVersion: expect.any(Number) })
    expect(st.data.server.database).toMatch(/\d/)
    expect((await new Client(base).req('GET', '/api/v1/status')).data.server).toBeUndefined()
  })

  it('environments: Default with the set-up date and, for admins, the database', async () => {
    const r = await A.req('GET', '/api/v1/environments')
    expect(r.status).toBe(200)
    expect(r.data.items).toHaveLength(1)
    const env = r.data.items[0]
    expect(env).toMatchObject({ id: 'default', name: 'Default', type: 'production', builtIn: true })
    expect(Date.now() - new Date(env.createdOn).getTime()).toBeLessThan(10 * 60 * 1000)
    expect(env.details.database).toContain(dbName)
  })

  it('profile name change, a new user signs in, and the audit viewer filters in SQL', async () => {
    expect((await A.req('PATCH', '/api/v1/auth/profile', { name: 'Ada Lovelace' })).data.name).toBe('Ada Lovelace')
    const u = await A.req('POST', '/api/v1/users', { name: 'Olu', email: 'olu@example.test', roleIds: ['role_viewer'], password: 'temporary-pass-1' })
    expect(u.status).toBe(200)
    const O = new Client(base)
    expect((await O.req('POST', '/api/v1/auth/login', { email: 'olu@example.test', password: 'temporary-pass-1' })).status).toBe(200)
    expect((await O.req('PATCH', '/api/v1/auth/profile', { name: 'Olu B' })).status).toBe(403) // must change the admin-set password first
    expect((await O.req('GET', '/api/v1/audit')).status).toBe(403)
    for (let i = 0; i < 7; i++) await new Client(base).req('POST', '/api/v1/auth/login', { email: `nobody${i}@example.test`, password: 'wrong-password-x' })

    const all = await A.req('GET', '/api/v1/audit?pageSize=200')
    expect(all.status, JSON.stringify(all.data)).toBe(200)
    expect(all.data.total).toBe(all.data.items.length)
    const ids = all.data.items.map((e: { id: number }) => e.id)
    expect([...ids].sort((a, b) => b - a)).toEqual(ids)
    expect(all.data.actions).toEqual(expect.arrayContaining(['auth.login', 'auth.login_failed', 'setup.admin', 'user.create', 'user.profile']))

    const prof = await A.req('GET', '/api/v1/audit?action=user.profile')
    expect(prof.data.total).toBe(1)
    expect(prof.data.items[0]).toMatchObject({ userName: 'Ada Lovelace', userEmail: 'ada@example.test', details: { changes: { name: { before: 'Ada', after: 'Ada Lovelace' } } } })
    const failed = await A.req('GET', '/api/v1/audit?action=auth.login_failed&pageSize=3&page=2')
    expect(failed.data).toMatchObject({ total: 7, page: 2, pageSize: 3 })
    expect(failed.data.items).toHaveLength(3)
    expect(failed.data.items[0].details.email).toBe('nobody3@example.test')
    const authAll = await A.req('GET', '/api/v1/audit?action=auth.&pageSize=200')
    expect(authAll.data.items.every((e: { action: string }) => e.action.startsWith('auth.'))).toBe(true)
    expect(authAll.data.total).toBe(8) // 7 failed sign-ins + Olu (Ada signed in through setup.admin)
    // "_" in a prefix is literal, not a LIKE wildcard
    expect((await A.req('GET', '/api/v1/audit?action=a_th.')).data.total).toBe(0)
    const olu = await A.req('GET', `/api/v1/audit?user=${u.data.id}`)
    expect(olu.data.items.map((e: { action: string }) => e.action)).toEqual(['auth.login'])
    const today = new Date().toISOString().slice(0, 10)
    expect((await A.req('GET', `/api/v1/audit?from=${today}&pageSize=1`)).data.total).toBe(all.data.total)
    expect((await A.req('GET', `/api/v1/audit?to=${today}`)).data.total).toBe(0)
  }, 60000)
})
