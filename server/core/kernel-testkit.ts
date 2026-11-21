/**
 * Test helpers for the event and job kernel suites (not used at run time): a server on a fresh PostgreSQL database
 * with an administrator signed in, an HTTP client, and direct SQL.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { dropDatabase, pgQuery, pgServer, testDatabaseName, withPg } from './testdb.ts'
import { createApp } from './app.ts'
import type { AppServer } from './app.ts'

export class Client {
  cookie = ''
  base: string
  env?: string
  constructor(base: string) {
    this.base = base
  }
  async req(method: string, p: string, body?: unknown) {
    const headers: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    if (this.env) headers['X-Appbuilder-Environment'] = this.env
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(this.base + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    const type = res.headers.get('content-type') ?? ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, data: (type.includes('json') ? await res.json() : await res.text()) as any }
  }
  get = (p: string) => this.req('GET', p)
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  patch = (p: string, b: unknown) => this.req('PATCH', p, b)
  del = (p: string) => this.req('DELETE', p)
}

export interface KernelHarness {
  app: AppServer
  admin: Client
  dbName: string
  tmp: string
  base: string
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

/** a server on a new database, setup done, Ada (administrator) signed in. jobs: start the worker (default false) */
export async function startHarness(suite: string, o: { jobs?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<KernelHarness> {
  const conn = pgServer!
  const dbName = testDatabaseName(suite)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ab-${suite}-`))
  const app = await createApp({ env: o.env ?? {}, config: { workspaceDir: tmp }, printSetupCode: false, jobs: o.jobs ?? false })
  const server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const admin = new Client(base)
  const setup = await admin.post('/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn.host, port: conn.port, database: dbName, user: conn.user, password: conn.password, createDatabase: true })
  if (setup.status !== 200) throw new Error(`setup failed: ${JSON.stringify(setup.data)}`)
  const ad = await admin.post('/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })
  if (ad.status !== 200) throw new Error(`admin failed: ${JSON.stringify(ad.data)}`)
  return {
    app, admin, dbName, tmp, base,
    q: (sql, params = []) => pgQuery(dbName, sql, params),
    async close() {
      const trace = process.env.APPBUILDER_TEST_CLOSE_TRACE
      let t0 = Date.now()
      let pending = 'server.close'
      const step = (name: string) => {
        if (trace) fs.appendFileSync(trace, `${suite} ${name} ${Date.now() - t0}ms\n`)
        t0 = Date.now()
        pending = name === 'server.close' ? 'app.close' : 'dropDatabase'
      }
      const watch = trace ? setTimeout(() => {
        server.getConnections((_e, n) => fs.appendFileSync(trace, `${suite} STUCK in ${pending} after 15s; open http connections ${n}; ${JSON.stringify(process.getActiveResourcesInfo())}\n`))
        void withPg((c) => c.query(`SELECT pid, backend_type, application_name, state, wait_event_type, wait_event, left(query, 120) AS query FROM pg_stat_activity WHERE datname = $1 OR query ILIKE '%DROP DATABASE%' OR query ILIKE '%CREATE DATABASE%'`, [dbName]))
          .then((r) => fs.appendFileSync(trace, `${suite} pg_stat_activity: ${JSON.stringify(r.rows)}\n`), (e) => fs.appendFileSync(trace, `${suite} pg_stat_activity failed: ${String(e)}\n`))
      }, 15_000) : null
      watch?.unref()
      // keep-alive sockets of the test clients (and a request a test left running) must not hold the close
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() })
      step('server.close')
      await app.close()
      step('app.close')
      await dropDatabase(dbName)
      step('dropDatabase')
      if (watch) clearTimeout(watch)
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}
