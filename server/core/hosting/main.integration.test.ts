/**
 * H-A end to end: `node server/main.ts` started as a hosted install (its own process, database and folder), first-run
 * setup by the server commands, then over HTTP the way the proxy talks to it: health, the closed setup route, the
 * invitation, __Host- cookies, the Host check, read-only set by the command while it runs, and a clean stop.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/hosting/main
 * Two listeners: TCP on 127.0.0.1:5271 (every platform) and a Unix domain socket (Linux and macOS: skipped on Windows,
 * where Node's listen(path) makes a named pipe instead).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PG_URL, SKIP_PG, dropDatabase, pgServer } from '../testdb.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MAIN = path.join(root, 'server', 'main.ts')
const HOST = 'acme.apps.example.test'
const WIN = process.platform === 'win32'
if (!PG_URL) process.stderr.write(`[server/core/hosting main integration] ${SKIP_PG}\n`)
if (WIN) process.stderr.write('[server/core/hosting main integration] the Unix socket listener is skipped on Windows (CI on Linux runs it)\n')

interface Target { socketPath?: string; port?: number }
interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; json: () => any }

/** a request the way Caddy sends it: the canonical Host, X-Forwarded-For/-Proto, no X-Forwarded-Host */
function call(t: Target, method: string, p: string, o: { body?: unknown; cookie?: string; host?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body)
    const req = http.request({
      ...(t.socketPath ? { socketPath: t.socketPath } : { host: '127.0.0.1', port: t.port }), method, path: `/api/v1${p}`,
      headers: {
        host: o.host ?? HOST, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', 'x-appbuilder': '1',
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}),
      },
      timeout: 10_000,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

function run(env: NodeJS.ProcessEnv, args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [MAIN, ...args], { env, cwd: root, encoding: 'utf8', timeout: 60_000 })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<void> {
  const until = Date.now() + ms
  for (;;) {
    if (await fn().catch(() => false)) return
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 200))
  }
}

for (const variant of ['tcp', 'socket'] as const) {
  describe.skipIf(!PG_URL || (variant === 'socket' && WIN))(`hosted install process over ${variant} (H-A)`, () => {
    const dbName = `appbuilder_exit_ha_${variant}_${randomBytes(4).toString('hex')}`
    let inst = ''
    let sock = ''
    const target: Target = variant === 'socket' ? {} : { port: 5271 }
    let env: NodeJS.ProcessEnv = {}
    let child: ChildProcess | null = null
    let output = ''
    let link = ''

    beforeAll(async () => {
      // a short folder: a Unix socket path has a limit of about 100 characters
      inst = fs.mkdtempSync(path.join(variant === 'socket' ? '/tmp' : os.tmpdir(), 'abha-'))
      sock = path.join(inst, 'http.sock')
      if (variant === 'socket') target.socketPath = sock
      env = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        APPBUILDER_HOSTED: '1', APPBUILDER_PUBLIC_URL: `https://${HOST}`, APPBUILDER_INSTANCE_DIR: inst,
        APPBUILDER_WORKSPACE: path.join(inst, 'workspace'), APPBUILDER_DB_HOST: pgServer!.host, APPBUILDER_DB_PORT: String(pgServer!.port),
        APPBUILDER_DB_NAME: dbName, APPBUILDER_DB_USER: pgServer!.user, APPBUILDER_DB_PASSWORD: pgServer!.password,
        ...(variant === 'socket' ? { APPBUILDER_SOCKET: sock } : { PORT: '5271', APPBUILDER_HOST: '127.0.0.1' }),
      }
      // first-run setup by the commands, before the server starts (as abfleet create does)
      const m = run(env, ['migrate'])
      expect(m.code, m.out).toBe(0)
      const inv = run(env, ['admin', 'invite', '--email', 'ada@example.com', '--name', 'Ada', '--print-link'])
      expect(inv.code, inv.out).toBe(0)
      link = /#invite=(\S+)/.exec(inv.out)?.[1] ?? ''
      expect(link).not.toBe('')
      child = spawn(process.execPath, [MAIN], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout!.on('data', (c) => { output += String(c) })
      child.stderr!.on('data', (c) => { output += String(c) })
      await waitFor(async () => (await call(target, 'GET', '/health')).status === 200, 45_000).catch((e) => { throw new Error(`${e.message}: ${output}`) })
    }, 120_000)

    afterAll(async () => {
      if (child && child.exitCode === null) child.kill('SIGKILL')
      await dropDatabase(dbName)
      if (inst) fs.rmSync(inst, { recursive: true, force: true })
    }, 60_000)

    it('health for the proxy and the fleet tool: status only, no version', async () => {
      const h = await call(target, 'GET', '/health')
      expect(h.json()).toEqual({ status: 'ok' })
      if (variant === 'socket') expect(fs.statSync(sock).mode & 0o777).toBe(0o660)
      // the command form over the socket / the hosted settings
      if (variant === 'socket') {
        const r = run(env, ['health'])
        expect(r.out.trim()).toBe('ok')
      }
      expect(output).not.toMatch(/Setup code/)
    })

    it('setup over HTTP is closed; another host name is refused', async () => {
      expect((await call(target, 'POST', '/setup/admin', { body: { name: 'Eve', email: 'eve@example.com', password: 'eve-password-123' } })).status).toBe(404)
      expect((await call(target, 'POST', '/setup/database', { body: {} })).status).toBe(404)
      expect((await call(target, 'GET', '/status', { host: 'other.apps.example.test' })).status).toBe(403)
    })

    it('the invitation signs the administrator in with a __Host- session cookie; a plain cookie is not accepted', async () => {
      const acc = await call(target, 'POST', '/auth/invitation/accept', { body: { token: decodeURIComponent(link), password: 'a-long-password-1' } })
      expect(acc.status, acc.body).toBe(200)
      const set = (acc.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-ab_session='))
      expect(set).toBeDefined()
      expect(set).toMatch(/; Path=\/; Secure$/)
      expect(set).not.toMatch(/Domain=/i)
      const value = set!.split(';')[0].slice('__Host-ab_session='.length)
      expect((await call(target, 'GET', '/auth/session', { cookie: `__Host-ab_session=${value}` })).status).toBe(200)
      // the same token without the prefix (an old cookie, or one tossed by a sibling install): anonymous
      expect((await call(target, 'GET', '/auth/session', { cookie: `ab_session=${value}` })).status).toBe(401)
      // writable now, read-only by the command while the server runs, writable again
      const cookie = `__Host-ab_session=${value}`
      const mk = (n: string) => call(target, 'POST', '/tables', { cookie, body: { displayName: n, name: n, columns: [] } })
      expect((await mk('First')).status).toBe(200)
      const ro = run(env, ['read-only', 'on', '--reason', 'suspended'])
      expect(ro.code, ro.out).toBe(0)
      await waitFor(async () => (await mk('Second')).status === 503, 15_000)
      const r = await mk('Third')
      expect(r.json().error.code).toBe('install_read_only')
      expect(r.headers['retry-after']).toBe('300')
      expect((await call(target, 'GET', '/install/read-only', { cookie })).json().readOnly.reason).toBe('suspended')
      expect(run(env, ['read-only', 'off']).code).toBe(0)
      await waitFor(async () => (await mk('Fourth')).status === 200, 15_000)
    }, 60_000)

    it('stops cleanly on SIGTERM (the socket file is removed)', async () => {
      if (WIN) return // Windows has no SIGTERM: kill() ends the process at once
      const exited = new Promise<number | null>((r) => child!.once('exit', (code) => r(code)))
      child!.kill('SIGTERM')
      expect(await exited).toBe(0)
      expect(output).toMatch(/SIGTERM: shutting down/)
      if (variant === 'socket') expect(fs.existsSync(sock)).toBe(false)
    }, 30_000)
  })
}
