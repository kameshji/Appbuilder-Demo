/**
 * Local test mode (`abfleet --local --root <folder>`): the same commands, on this PC or a CI runner, WITHOUT systemd,
 * OS users, Caddy or root. Installs run as plain child processes of this user on TCP ports of 127.0.0.1 (5360-5397),
 * against a throwaway PostgreSQL cluster (scripts/exit-check/h-fleet.mjs starts one the way the isolation harness
 * does); everything stays below the root folder (.sandbox/fleet/...). What it cannot show is listed in
 * docs/dev/testing.md "Fleet checks": OS users and file permissions, systemd limits, the template unit, Caddy, TLS.
 *
 *   OS users       recorded in <root>/etc/local-users.json (nothing is created)
 *   file owners    ignored (modes are set where the file system has them)
 *   units          appbuilder@<id>: `node <release code>/server/main.ts` with the instance env; appbuilder-licence:
 *                  the licence service; caddy and timers: nothing (recorded)
 *   PostgreSQL     the cluster's superuser over TCP (node-postgres), pg_dumpall from the sandbox binaries
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { FleetPaths } from './model.ts'
import { duSync, httpProbe, httpRequest, sha256Sync, spawnCollect, SystemError, type FileInfo, type RunOptions, type System, type Target, type UnitAction } from './system.ts'
import { parseEnvText } from './util.ts'

export interface LocalPg { host: string; port: number; user: string; password: string }

const WIN = process.platform === 'win32'
const FORBIDDEN_PORTS = new Set([5174, 5433])

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export class LocalSystem implements System {
  readonly kind = 'local' as const
  readonly dry = false
  readonly notes: string[] = []
  private o: { paths: FleetPaths; pg: LocalPg; pgBin: string | (() => string) }
  constructor(o: { paths: FleetPaths; pg: LocalPg; pgBin: string | (() => string) }) {
    this.o = o
    if (FORBIDDEN_PORTS.has(o.pg.port)) throw new SystemError(`port ${o.pg.port} is not a sandbox port`, 'pg')
  }

  facts() { return { os: process.platform, distro: 'local-test-mode', systemd: false, arch: process.arch } }

  exists(p: string) { try { fs.lstatSync(p); return true } catch { return false } }
  readText(p: string) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
  list(p: string) { try { return fs.readdirSync(p).sort() } catch { return [] } }
  stat(p: string): FileInfo | null {
    try { const s = fs.lstatSync(p); return { isDir: s.isDirectory(), isLink: s.isSymbolicLink(), mode: s.mode & 0o7777, size: s.size } } catch { return null }
  }
  writeText(p: string, text: string, o: { mode: number }) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.abfleet-${process.pid}.tmp`
    fs.writeFileSync(tmp, text, { mode: o.mode })
    fs.renameSync(tmp, p)
  }
  mkdir(p: string, o: { mode: number }) { fs.mkdirSync(p, { recursive: true, mode: o.mode }); try { fs.chmodSync(p, o.mode & 0o777) } catch { /* not POSIX */ } }
  remove(p: string) {
    try { if (fs.lstatSync(p).isSymbolicLink()) { fs.unlinkSync(p); return } } catch { return }
    // links (junctions on Windows) inside are unlinked first, never followed into their target
    const unlinkLinks = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name)
        if (e.isSymbolicLink()) fs.unlinkSync(q)
        else if (e.isDirectory()) unlinkLinks(q)
      }
    }
    try { if (fs.lstatSync(p).isDirectory()) unlinkLinks(p) } catch { /* gone */ }
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  link(target: string, p: string) {
    try { if (fs.lstatSync(p)) fs.unlinkSync(p) } catch { /* none */ }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.symlinkSync(target, p, WIN ? 'junction' : 'dir')
  }
  readLink(p: string) {
    try { return fs.readlinkSync(p).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '') } catch { return null }
  }
  copyFile(src: string, dst: string, o: { mode: number }) {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    try { fs.chmodSync(dst, o.mode) } catch { /* not POSIX */ }
  }
  rename(src: string, dst: string) { fs.renameSync(src, dst) }
  secureTree() { /* no owners in local test mode */ }
  du(p: string) { return duSync(p) }
  sha256(p: string) { return sha256Sync(p) }

  /* ---------------------------------------------------------------- recorded OS users */
  private usersFile() { return path.join(this.o.paths.etc, 'local-users.json') }
  private users(): string[] { try { return JSON.parse(fs.readFileSync(this.usersFile(), 'utf8')) as string[] } catch { return [] } }
  async userExists(name: string) { return this.users().includes(name) }
  async createUser(name: string) { fs.mkdirSync(this.o.paths.etc, { recursive: true }); fs.writeFileSync(this.usersFile(), JSON.stringify([...new Set([...this.users(), name])])) }
  async deleteUser(name: string) { fs.writeFileSync(this.usersFile(), JSON.stringify(this.users().filter((u) => u !== name))) }

  /* ---------------------------------------------------------------- units as child processes */
  private enabledFile() { return path.join(this.o.paths.etc, 'local-enabled.json') }
  private enabled(): string[] { try { return JSON.parse(fs.readFileSync(this.enabledFile(), 'utf8')) as string[] } catch { return [] } }
  private pidFile(name: string) { return path.join(this.o.paths.run, `${name.replace(/[@.]/g, '_')}.pid`) }
  private pid(name: string): number | null {
    const v = Number(this.readText(this.pidFile(name))?.trim())
    return v > 0 && alive(v) ? v : null
  }

  private spawnUnit(name: string): void {
    const p = this.o.paths
    const base: Record<string, string> = {}
    for (const k of ['PATH', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) if (process.env[k]) base[k] = process.env[k]!
    let main: string
    let env: Record<string, string>
    let cwd: string
    let log: string
    const inst = /^appbuilder@(o[a-z2-7]{8})$/.exec(name)
    if (inst) {
      const dir = path.join(p.instances, inst[1])
      const envFile = path.join(dir, 'instance.env')
      const vars = parseEnvText(this.readText(envFile) ?? '')
      if (vars.PORT && FORBIDDEN_PORTS.has(Number(vars.PORT))) throw new SystemError(`port ${vars.PORT} is not a sandbox port`, 'unit')
      const app = path.join(dir, 'app')
      const code = this.readText(path.join(app, 'fleet-local-code.txt'))?.trim() ?? app
      main = path.join(code, 'server', 'main.ts')
      env = { ...base, ...vars, APPBUILDER_ENV_FILE: envFile, HOME: dir, USERPROFILE: dir, TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp') }
      cwd = dir
      log = path.join(dir, 'service.log')
    } else if (name === 'appbuilder-licence') {
      const vars = parseEnvText(this.readText(path.join(p.licenceDir, 'licence.env')) ?? '')
      const code = this.readText(path.join(p.current, 'fleet-local-code.txt'))?.trim() ?? p.current
      main = path.join(code, 'server', 'licence-service', 'main.ts')
      env = { ...base, ...vars, TEMP: p.staging, TMP: p.staging }
      cwd = p.licenceDir
      log = path.join(p.licenceDir, 'service.log')
    } else return
    fs.mkdirSync(p.run, { recursive: true })
    const fd = fs.openSync(log, 'a')
    const c = spawn(p.node, [main, ...(name === 'appbuilder-licence' ? ['serve'] : [])], { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
    fs.closeSync(fd)
    c.unref()
    fs.writeFileSync(this.pidFile(name), String(c.pid))
  }

  private async stopUnit(name: string): Promise<void> {
    const pid = this.pid(name)
    if (!pid) { fs.rmSync(this.pidFile(name), { force: true }); return }
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    for (let i = 0; i < 100 && alive(pid); i++) await this.sleep(200)
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    for (let i = 0; i < 25 && alive(pid); i++) await this.sleep(200)
    fs.rmSync(this.pidFile(name), { force: true })
  }

  async unit(action: UnitAction, name?: string): Promise<boolean> {
    const n = (name ?? '').replace(/\.service$/, '')
    const managed = /^appbuilder@o[a-z2-7]{8}$/.test(n) || n === 'appbuilder-licence'
    switch (action) {
      case 'daemon-reload': return true
      case 'is-active': return managed && this.pid(n) !== null
      case 'is-enabled': return this.enabled().includes(n)
      case 'enable': fs.mkdirSync(this.o.paths.etc, { recursive: true }); fs.writeFileSync(this.enabledFile(), JSON.stringify([...new Set([...this.enabled(), n])])); return true
      case 'disable': fs.writeFileSync(this.enabledFile(), JSON.stringify(this.enabled().filter((x) => x !== n))); return true
      case 'reload': if (n === 'caddy') this.notes.push('caddy reload (no Caddy in local test mode)'); return true
      case 'start': if (managed && !this.pid(n)) this.spawnUnit(n); return true
      case 'stop': if (managed) await this.stopUnit(n); return true
      case 'restart': if (managed) { await this.stopUnit(n); this.spawnUnit(n) } return true
    }
    return false
  }

  /** every process this local fleet started (pid files below its root): the harness's cleanup */
  async stopAll(): Promise<number> {
    let n = 0
    for (const f of this.list(this.o.paths.run).filter((x) => x.endsWith('.pid'))) {
      const name = f.replace(/\.pid$/, '').replace(/^appbuilder_o/, 'appbuilder@o')
      if (this.pid(name)) { await this.stopUnit(name); n++ }
      fs.rmSync(path.join(this.o.paths.run, f), { force: true })
    }
    return n
  }

  /* ---------------------------------------------------------------- PostgreSQL */
  private async client(db: string) {
    const pg = (await import('pg')).default
    const c = new pg.Client({ host: this.o.pg.host, port: this.o.pg.port, user: this.o.pg.user, password: this.o.pg.password, database: db, connectionTimeoutMillis: 10_000 })
    c.on('error', () => {})
    await c.connect()
    return c
  }
  async query(db: string, sql: string) {
    const c = await this.client(db)
    try {
      const r = await c.query({ text: sql, rowMode: 'array' })
      const rows = (Array.isArray(r) ? r[r.length - 1] : r).rows as unknown[][]
      return rows.map((row) => row.map((v) => (v === null ? '' : v === true ? 't' : v === false ? 'f' : v instanceof Date ? v.toISOString() : String(v))))
    } catch (e) {
      throw new SystemError(`SQL (${db}): ${(e as Error).message}`, 'sql')
    } finally {
      await c.end().catch(() => {})
    }
  }
  async exec(db: string, sql: string) { await this.query(db, sql) }
  async dumpGlobals() {
    const exe = path.join(typeof this.o.pgBin === 'function' ? this.o.pgBin() : this.o.pgBin, `pg_dumpall${WIN ? '.exe' : ''}`)
    const r = await spawnCollect(exe, ['--globals-only', '-h', this.o.pg.host, '-p', String(this.o.pg.port), '-U', this.o.pg.user, '--no-password'], { env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', PGPASSWORD: this.o.pg.password } })
    if (r.code !== 0) throw new SystemError(`pg_dumpall: ${r.stderr.trim()}`, 'sql')
    return r.stdout
  }

  /* ---------------------------------------------------------------- programs, HTTP */
  run(cmd: string, args: string[], o: RunOptions = {}) {
    const env = { ...(o.env ?? {}) }
    if (!env.PATH && process.env.PATH) env.PATH = process.env.PATH
    if (WIN && !env.SystemRoot && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    return spawnCollect(cmd, args, { ...o, env })
  }
  which(cmd: string) {
    const exts = WIN ? ['.exe', '.cmd', ''] : ['']
    for (const d of (process.env.PATH ?? '').split(path.delimiter)) for (const e of exts) { const f = path.join(d, cmd + e); if (d && fs.existsSync(f)) return f }
    return null
  }
  probe(t: Target, timeoutMs?: number) { return httpProbe(t, timeoutMs) }
  request(t: Target, method: string, p: string, o?: { headers?: Record<string, string>; body?: string; timeoutMs?: number }) { return httpRequest(t, method, p, o) }
  sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)) }
  now() { return Date.now() }
}
