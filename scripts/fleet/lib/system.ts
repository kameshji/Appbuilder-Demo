/**
 * The ONE place where the fleet tool touches the machine. Every command is written against `System`, so its plan and
 * its rollback are unit-tested with the recording fake (lib/fake.ts), run for real on this PC in local test mode
 * (lib/local.ts: installs as child processes on TCP ports, a throwaway PostgreSQL) and on a Linux server here
 * (`ServerSystem`: systemctl, useradd, chown, psql through runuser, caddy, rclone).
 *
 * `withDryRun` wraps any System: reads pass through, every change is printed as "would ..." and not done.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'

export type Health = 'ok' | 'starting' | 'degraded' | 'down'

export interface RunOptions {
  /** run as this OS user (server: runuser -u <user> --) */
  user?: string
  /** the whole environment of the program (PATH is added when missing) */
  env?: Record<string, string>
  /** written to standard input (never logged) */
  input?: string
  cwd?: string
  timeoutMs?: number
  /** false: the program only reads (it runs in --dry-run too) */
  mutates?: boolean
}

export interface RunResult { code: number; stdout: string; stderr: string }

export interface Target { host: string; socket?: string; port?: number }

export interface FileInfo { isDir: boolean; isLink: boolean; mode: number; size: number; owner?: string; group?: string }

export type UnitAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable' | 'is-active' | 'is-enabled' | 'daemon-reload'

export interface System {
  readonly kind: 'server' | 'local' | 'fake'
  readonly dry: boolean
  /** OS facts for init/doctor */
  facts(): { os: string; distro: string; systemd: boolean; arch: string }
  /* files (absolute paths) */
  exists(p: string): boolean
  readText(p: string): string | null
  list(p: string): string[]
  stat(p: string): FileInfo | null
  writeText(p: string, text: string, o: { mode: number; owner?: string; group?: string }): void
  mkdir(p: string, o: { mode: number; owner?: string; group?: string }): void
  /** recursive, no error when missing */
  remove(p: string): void
  /** p becomes a link to target (replaced atomically when it exists) */
  link(target: string, p: string): void
  readLink(p: string): string | null
  copyFile(src: string, dst: string, o: { mode: number; owner?: string; group?: string }): void
  rename(src: string, dst: string): void
  /** owner and modes of a whole tree (a release: root, read-only for everyone else) */
  secureTree(p: string): void
  /** bytes used under p */
  du(p: string): number
  /** SHA-256 of a file (hex), null when it cannot be read */
  sha256(p: string): string | null
  /* OS accounts */
  userExists(name: string): Promise<boolean>
  createUser(name: string, home: string): Promise<void>
  deleteUser(name: string): Promise<void>
  /* services */
  unit(action: UnitAction, name?: string): Promise<boolean>
  /* PostgreSQL as its superuser */
  query(db: string, sql: string): Promise<string[][]>
  exec(db: string, sql: string): Promise<void>
  /** pg_dumpall --globals-only (roles with their password verifiers: handle as a secret) */
  dumpGlobals(): Promise<string>
  /* programs */
  run(cmd: string, args: string[], o?: RunOptions): Promise<RunResult>
  which(cmd: string): string | null
  /* HTTP to an install */
  probe(t: Target, timeoutMs?: number): Promise<Health>
  request(t: Target, method: string, p: string, o?: { headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>
  sleep(ms: number): Promise<void>
  now(): number
}

export class SystemError extends Error {
  readonly step: string
  constructor(message: string, step: string) { super(message); this.step = step }
}

/* ------------------------------------------------------------------ shared HTTP helpers */

export function httpRequest(t: Target, method: string, p: string, o: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { host: t.host, 'x-appbuilder': '1', ...(o.headers ?? {}) }
    if (o.body !== undefined) { headers['content-type'] ??= 'application/json'; headers['content-length'] = String(Buffer.byteLength(o.body)) }
    const req = http.request({ ...(t.socket ? { socketPath: t.socket } : { host: '127.0.0.1', port: t.port }), method, path: p, headers, timeout: o.timeoutMs ?? 10_000, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => { if (chunks.length < 2048) chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
      res.on('error', () => resolve({ status: 0, body: '', headers: {} }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ status: 0, body: `network: ${e.code ?? e.message}`, headers: {} }))
    if (o.body !== undefined) req.write(o.body)
    req.end()
  })
}

export async function httpProbe(t: Target, timeoutMs = 3000): Promise<Health> {
  const r = await httpRequest(t, 'GET', '/api/v1/health', { timeoutMs })
  if (!r.status) return 'down'
  try {
    const s = (JSON.parse(r.body) as { status?: string }).status
    return s === 'ok' || s === 'starting' || s === 'degraded' ? s : 'down'
  } catch {
    return 'down'
  }
}

/** spawns a program (argument array, never a shell) and collects its output */
export function spawnCollect(cmd: string, args: string[], o: RunOptions & { env: Record<string, string> }): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const c = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const finish = (code: number) => { if (!done) { done = true; clearTimeout(t); resolve({ code, stdout, stderr }) } }
    const t = setTimeout(() => { stderr += `\n(timed out after ${Math.round((o.timeoutMs ?? 600_000) / 1000)} s)`; try { c.kill('SIGKILL') } catch { /* gone */ } }, o.timeoutMs ?? 600_000)
    c.stdout.on('data', (d: Buffer) => { if (stdout.length < 4_000_000) stdout += d.toString('utf8') })
    c.stderr.on('data', (d: Buffer) => { if (stderr.length < 4_000_000) stderr += d.toString('utf8') })
    c.on('error', (e) => { stderr += String(e.message); finish(127) })
    c.on('close', (code) => finish(code ?? 1))
    c.stdin.on('error', () => {})
    c.stdin.end(o.input ?? '')
  })
}

export function sha256Sync(p: string): string | null {
  try {
    const h = createHash('sha256')
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024)
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null)
        if (!n) break
        h.update(buf.subarray(0, n))
      }
    } finally {
      fs.closeSync(fd)
    }
    return h.digest('hex')
  } catch {
    return null
  }
}

export function duSync(p: string): number {
  let n = 0
  const walk = (d: string) => {
    let st: fs.Stats
    try { st = fs.lstatSync(d) } catch { return }
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) { for (const x of fs.readdirSync(d)) walk(path.join(d, x)) } else n += st.size
  }
  walk(p)
  return n
}

/* ------------------------------------------------------------------ the Linux server */

const MIN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/** systemd, useradd, chown, psql (as postgres through runuser), caddy: run by abfleet as root */
export class ServerSystem implements System {
  readonly kind = 'server' as const
  readonly dry = false
  private o: { psql: () => string; pgPort: () => number }
  constructor(o: { psql: () => string; pgPort: () => number }) { this.o = o }

  facts() {
    let distro = 'unknown'
    try {
      const t = fs.readFileSync('/etc/os-release', 'utf8')
      distro = `${/^ID=(.*)$/m.exec(t)?.[1]?.replace(/"/g, '') ?? '?'}:${/^VERSION_ID=(.*)$/m.exec(t)?.[1]?.replace(/"/g, '') ?? '?'}`
    } catch { /* not Linux */ }
    return { os: process.platform, distro, systemd: fs.existsSync('/run/systemd/system'), arch: process.arch }
  }

  exists(p: string) { try { fs.lstatSync(p); return true } catch { return false } }
  readText(p: string) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
  list(p: string) { try { return fs.readdirSync(p).sort() } catch { return [] } }
  stat(p: string): FileInfo | null {
    try {
      const s = fs.lstatSync(p)
      const r = execFileSync('stat', ['-c', '%U:%G', p], { encoding: 'utf8' }).trim().split(':')
      return { isDir: s.isDirectory(), isLink: s.isSymbolicLink(), mode: s.mode & 0o7777, size: s.size, owner: r[0], group: r[1] }
    } catch { return null }
  }
  private own(p: string, owner?: string, group?: string, recursive = false) {
    if (!owner && !group) return
    execFileSync('chown', [...(recursive ? ['-R'] : []), '-h', `${owner ?? 'root'}:${group ?? owner ?? 'root'}`, p])
  }
  writeText(p: string, text: string, o: { mode: number; owner?: string; group?: string }) {
    const tmp = `${p}.abfleet-${process.pid}.tmp`
    fs.writeFileSync(tmp, text, { mode: o.mode })
    fs.chmodSync(tmp, o.mode)
    this.own(tmp, o.owner, o.group)
    fs.renameSync(tmp, p)
  }
  mkdir(p: string, o: { mode: number; owner?: string; group?: string }) {
    fs.mkdirSync(p, { recursive: true })
    fs.chmodSync(p, o.mode)
    this.own(p, o.owner, o.group)
  }
  remove(p: string) { fs.rmSync(p, { recursive: true, force: true }) }
  link(target: string, p: string) {
    const tmp = `${p}.abfleet-${process.pid}.lnk`
    fs.rmSync(tmp, { force: true })
    fs.symlinkSync(target, tmp)
    fs.renameSync(tmp, p)
  }
  readLink(p: string) { try { return fs.readlinkSync(p) } catch { return null } }
  copyFile(src: string, dst: string, o: { mode: number; owner?: string; group?: string }) {
    const tmp = `${dst}.abfleet-${process.pid}.tmp`
    fs.copyFileSync(src, tmp)
    fs.chmodSync(tmp, o.mode)
    this.own(tmp, o.owner, o.group)
    fs.renameSync(tmp, dst)
  }
  rename(src: string, dst: string) { fs.renameSync(src, dst) }
  secureTree(p: string) {
    execFileSync('chown', ['-R', 'root:root', p])
    execFileSync('chmod', ['-R', 'u=rwX,go=rX', p])
  }
  du(p: string) { return duSync(p) }
  sha256(p: string) { return sha256Sync(p) }

  async userExists(name: string) { return (await this.run('id', ['-u', name], { mutates: false })).code === 0 }
  async createUser(name: string, home: string) {
    const r = await this.run('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', name])
    if (r.code !== 0) throw new SystemError(`useradd ${name}: ${r.stderr.trim()}`, 'user')
  }
  async deleteUser(name: string) {
    const r = await this.run('userdel', [name])
    if (r.code !== 0 && r.code !== 6) throw new SystemError(`userdel ${name}: ${r.stderr.trim()}`, 'user')
    if ((await this.run('getent', ['group', name], { mutates: false })).code === 0) await this.run('groupdel', [name])
  }

  async unit(action: UnitAction, name?: string) {
    const args = action === 'daemon-reload' ? ['daemon-reload'] : action === 'is-active' || action === 'is-enabled' ? [action, '--quiet', name!] : [action, name!]
    const r = await this.run('systemctl', args, { mutates: action !== 'is-active' && action !== 'is-enabled', timeoutMs: 180_000 })
    if (r.code !== 0 && action !== 'is-active' && action !== 'is-enabled' && !(action === 'stop' && /not loaded/.test(r.stderr))) {
      throw new SystemError(`systemctl ${args.join(' ')}: ${r.stderr.trim() || `exit ${r.code}`}`, 'unit')
    }
    return r.code === 0
  }

  private psqlArgs(db: string) { return ['-u', 'postgres', '--', this.o.psql(), '-X', '-q', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-p', String(this.o.pgPort()), '-d', db] }
  async query(db: string, sql: string) {
    const r = await this.run('runuser', this.psqlArgs(db), { input: sql, mutates: false })
    if (r.code !== 0) throw new SystemError(`psql (${db}): ${r.stderr.trim()}`, 'sql')
    return r.stdout.split('\n').filter((l) => l.length).map((l) => l.split('\t'))
  }
  async exec(db: string, sql: string) {
    const r = await this.run('runuser', this.psqlArgs(db), { input: sql })
    if (r.code !== 0) throw new SystemError(`psql (${db}): ${r.stderr.trim()}`, 'sql')
  }
  async dumpGlobals() {
    const r = await this.run('runuser', ['-u', 'postgres', '--', path.join(path.dirname(this.o.psql()), 'pg_dumpall'), '--globals-only', '-p', String(this.o.pgPort())], { mutates: false })
    if (r.code !== 0) throw new SystemError(`pg_dumpall: ${r.stderr.trim()}`, 'sql')
    return r.stdout
  }

  run(cmd: string, args: string[], o: RunOptions = {}) {
    const env = { PATH: MIN_PATH, LANG: 'C.UTF-8', ...(o.env ?? {}) }
    if (o.user && o.user !== 'root') return spawnCollect('runuser', ['-u', o.user, '--', cmd, ...args], { ...o, env, cwd: o.cwd ?? '/' })
    return spawnCollect(cmd, args, { ...o, env, cwd: o.cwd ?? '/' })
  }
  which(cmd: string) {
    for (const d of MIN_PATH.split(':')) { const f = path.join(d, cmd); if (fs.existsSync(f)) return f }
    return null
  }
  probe(t: Target, timeoutMs?: number) { return httpProbe(t, timeoutMs) }
  request(t: Target, method: string, p: string, o?: { headers?: Record<string, string>; body?: string; timeoutMs?: number }) { return httpRequest(t, method, p, o) }
  sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)) }
  now() { return Date.now() }
}

/* ------------------------------------------------------------------ --dry-run */

/** reads pass through; every change is reported through `say` and not done */
export function withDryRun(sys: System, say: (line: string) => void): System {
  const would = (s: string) => say(`  would ${s}`)
  const mode = (m: number) => m.toString(8).padStart(4, '0')
  const d: System = {
    kind: sys.kind,
    dry: true,
    facts: () => sys.facts(),
    exists: (p) => sys.exists(p),
    readText: (p) => sys.readText(p),
    list: (p) => sys.list(p),
    stat: (p) => sys.stat(p),
    writeText: (p, text, o) => would(`write ${p} (${mode(o.mode)} ${o.owner ?? 'root'}:${o.group ?? o.owner ?? 'root'}, ${Buffer.byteLength(text)} bytes)`),
    mkdir: (p, o) => would(`create folder ${p} (${mode(o.mode)} ${o.owner ?? 'root'}:${o.group ?? o.owner ?? 'root'})`),
    remove: (p) => would(`remove ${p}`),
    link: (t, p) => would(`link ${p} -> ${t}`),
    readLink: (p) => sys.readLink(p),
    copyFile: (s, t) => would(`copy ${s} to ${t}`),
    rename: (s, t) => would(`rename ${s} to ${t}`),
    secureTree: (p) => would(`make ${p} owned by root and read-only for others`),
    du: (p) => sys.du(p),
    sha256: (p) => sys.sha256(p),
    userExists: (n) => sys.userExists(n),
    createUser: async (n, h) => would(`create the system user ${n} (home ${h}, no login)`),
    deleteUser: async (n) => would(`delete the user ${n}`),
    unit: async (a, n) => {
      if (a === 'is-active' || a === 'is-enabled') return sys.unit(a, n)
      would(`systemctl ${a}${n ? ` ${n}` : ''}`)
      return true
    },
    query: (db, sql) => sys.query(db, sql).catch(() => []),
    exec: async (db, sql) => would(`run SQL in ${db}: ${sql.replace(/\s+/g, ' ').replace(/PASSWORD '[^']*'/g, "PASSWORD '***'").slice(0, 240)}`),
    dumpGlobals: async () => '',
    run: async (cmd, args, o = {}) => {
      if (o.mutates === false) return sys.run(cmd, args, o)
      would(`run ${o.user ? `as ${o.user}: ` : ''}${path.basename(cmd)} ${args.join(' ')}`)
      return { code: 0, stdout: '', stderr: '' }
    },
    which: (c) => sys.which(c),
    probe: (t, ms) => sys.probe(t, ms),
    request: (t, m, p, o) => sys.request(t, m, p, o),
    sleep: async () => {},
    now: () => sys.now(),
  }
  return d
}
