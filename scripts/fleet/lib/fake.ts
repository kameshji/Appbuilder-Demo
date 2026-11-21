/**
 * The recording fake of `System` for unit tests (scripts/fleet/test/*.test.ts): an in-memory file system, users,
 * PostgreSQL roles and databases, units, and a log of every call in order (`calls`). `failOn` makes one call throw,
 * so each command's rollback is tested at every step; `handler` answers programs (the install's CLI, the agent, the
 * licence CLI) the way they answer for real.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { FileInfo, Health, RunOptions, RunResult, System, Target, UnitAction } from './system.ts'

type Node = { mode: number; owner?: string; group?: string }

export type Handler = (cmd: string, args: string[], o: RunOptions, fake: FakeSystem) => RunResult | undefined

export class FakeSystem implements System {
  readonly kind = 'fake' as const
  readonly dry = false
  calls: string[] = []
  files = new Map<string, Node & { text: string }>()
  dirs = new Map<string, Node>()
  links = new Map<string, string>()
  users = new Set<string>()
  roles = new Set<string>()
  dbs = new Set<string>(['postgres', 'template1'])
  publicConnect = new Set<string>(['postgres', 'template1'])
  active = new Set<string>()
  enabled = new Set<string>()
  clock = Date.parse('2026-11-21T10:00:00Z')
  failOn: ((call: string) => boolean) | null = null
  handler: Handler | null = null
  probeFor: (t: Target) => Health = () => 'ok'
  facts() { return { os: 'linux', distro: 'ubuntu:24.04', systemd: true, arch: 'x64' } }

  private rec(call: string): void {
    this.calls.push(call)
    if (this.failOn?.(call)) throw new Error(`injected failure at: ${call}`)
  }
  private under(p: string, root: string): boolean { return p === root || p.startsWith(root + path.sep) || p.startsWith(root + '/') }
  private resolve(p: string): string {
    for (const [l, t] of this.links) if (this.under(p, l) && p !== l) return t + p.slice(l.length)
    return p
  }

  exists(p: string) { const r = this.resolve(p); return this.files.has(r) || this.dirs.has(r) || this.links.has(p) }
  readText(p: string) { return this.files.get(this.resolve(p))?.text ?? null }
  list(p: string) {
    const out = new Set<string>()
    for (const k of [...this.files.keys(), ...this.dirs.keys(), ...this.links.keys()]) if (this.under(k, p) && k !== p) out.add(k.slice(p.length + 1).split(/[\\/]/)[0])
    return [...out].sort()
  }
  stat(p: string): FileInfo | null {
    if (this.links.has(p)) return { isDir: false, isLink: true, mode: 0o777, size: 0 }
    const r = this.resolve(p)
    const f = this.files.get(r)
    if (f) return { isDir: false, isLink: false, mode: f.mode, size: Buffer.byteLength(f.text), owner: f.owner ?? 'root', group: f.group ?? f.owner ?? 'root' }
    const d = this.dirs.get(r)
    return d ? { isDir: true, isLink: false, mode: d.mode, size: 0, owner: d.owner ?? 'root', group: d.group ?? d.owner ?? 'root' } : null
  }
  writeText(p: string, text: string, o: Node) { this.rec(`write ${p} ${o.mode.toString(8)} ${o.owner ?? 'root'}:${o.group ?? o.owner ?? 'root'}`); this.files.set(this.resolve(p), { text, ...o }) }
  mkdir(p: string, o: Node) { this.rec(`mkdir ${p} ${o.mode.toString(8)} ${o.owner ?? 'root'}:${o.group ?? o.owner ?? 'root'}`); this.dirs.set(p, o) }
  remove(p: string) {
    this.rec(`remove ${p}`)
    for (const m of [this.files, this.dirs, this.links] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (this.under(k, p)) m.delete(k)
  }
  link(target: string, p: string) { this.rec(`link ${p} -> ${target}`); this.links.set(p, target) }
  readLink(p: string) { return this.links.get(p) ?? null }
  copyFile(src: string, dst: string, o: Node) {
    this.rec(`copy ${src} ${dst}`)
    const f = this.files.get(this.resolve(src))
    if (!f) throw new Error(`ENOENT ${src}`)
    this.files.set(this.resolve(dst), { ...f, ...o })
  }
  rename(src: string, dst: string) {
    this.rec(`rename ${src} ${dst}`)
    for (const m of [this.files, this.dirs] as Map<string, unknown>[]) for (const [k, v] of [...m.entries()]) if (this.under(k, src)) { m.delete(k); m.set(dst + k.slice(src.length), v) }
  }
  secureTree(p: string) { this.rec(`secure ${p}`) }
  du(p: string) { let n = 0; for (const [k, f] of this.files) if (this.under(k, p)) n += Buffer.byteLength(f.text); return n }
  sha256(p: string) { const f = this.files.get(this.resolve(p)); return f ? createHash('sha256').update(f.text).digest('hex') : null }

  async userExists(n: string) { return this.users.has(n) }
  async createUser(n: string, home: string) { this.rec(`useradd ${n} ${home}`); this.users.add(n) }
  async deleteUser(n: string) { this.rec(`userdel ${n}`); this.users.delete(n) }

  async unit(action: UnitAction, name?: string) {
    const n = (name ?? '').replace(/\.service$/, '')
    if (action === 'is-active') return this.active.has(n)
    if (action === 'is-enabled') return this.enabled.has(n)
    this.rec(`systemctl ${action}${n ? ` ${n}` : ''}`)
    if (action === 'start' || action === 'restart') this.active.add(n)
    if (action === 'stop') this.active.delete(n)
    if (action === 'enable') this.enabled.add(n)
    if (action === 'disable') this.enabled.delete(n)
    return true
  }

  async query(db: string, sql: string): Promise<string[][]> {
    const q = sql.replace(/\s+/g, ' ')
    let m: RegExpExecArray | null
    if ((m = /FROM pg_catalog\.pg_roles WHERE rolname = '([^']+)'$/.exec(q)) && /^SELECT 1/.test(q)) return this.roles.has(m[1]) ? [['1']] : []
    if ((m = /FROM pg_catalog\.pg_database WHERE datname = '([^']+)'$/.exec(q))) return this.dbs.has(m[1]) ? [['1']] : []
    if ((m = /has_database_privilege\('public', '([^']+)', 'CONNECT'\)/.exec(q)) && !/JOIN/.test(q)) return [[this.publicConnect.has(m[1]) ? 't' : 'f']]
    if (/^SHOW max_connections/.test(q)) return [['300']]
    if ((m = /rolpassword FROM pg_catalog\.pg_authid WHERE rolname = '([^']+)'/.exec(q))) return this.roles.has(m[1]) ? [['SCRAM-SHA-256$4096:old$old:old']] : []
    if ((m = /JOIN pg_catalog\.pg_database d ON d\.datname = r\.rolname WHERE r\.rolname = '([^']+)'/.exec(q))) return this.roles.has(m[1]) && this.dbs.has(m[1]) ? [['f', 'f', 'f', 'f', 'f', '12', '12', this.publicConnect.has(m[1]) ? 't' : 'f', 't', 'statement_timeout=60s,idle_in_transaction_session_timeout=5min']] : []
    if ((m = /rolconnlimit, coalesce\(array_to_string\(r\.rolconfig, ', '\), ''\) FROM pg_catalog\.pg_roles r WHERE r\.rolname = '([^']+)'/.exec(q))) return this.roles.has(m[1]) ? [['12', 'statement_timeout=60s']] : []
    if ((m = /LIKE '%([a-z0-9]+)%'/.exec(q))) return [...this.dbs, ...this.roles].filter((x) => x.includes(m![1])).map((x) => [x])
    if ((m = /LIKE '([^']+?)o%'/.exec(q))) { const pre = m[1].replace(/\\_/g, '_'); return [...new Set([...this.dbs, ...this.roles])].filter((x) => x.startsWith(pre + 'o')).map((x) => [x]) }
    if (/^SELECT 1$/.test(q)) return [['1']]
    void db
    return []
  }
  async exec(db: string, sql: string) {
    const q = sql.replace(/\s+/g, ' ')
    this.rec(`sql ${db}: ${q.replace(/PASSWORD '[^']*'/, "PASSWORD '***'").slice(0, 200)}`)
    let m: RegExpExecArray | null
    if ((m = /^CREATE ROLE "([^"]+)"/.exec(q))) { if (this.roles.has(m[1])) throw new Error(`role "${m[1]}" already exists`); this.roles.add(m[1]) }
    if ((m = /^CREATE DATABASE "([^"]+)"/.exec(q))) { if (this.dbs.has(m[1])) throw new Error(`database "${m[1]}" already exists`); this.dbs.add(m[1]); this.publicConnect.add(m[1]) }
    if ((m = /^DROP DATABASE IF EXISTS "([^"]+)"/.exec(q))) { this.dbs.delete(m[1]); this.publicConnect.delete(m[1]) }
    if ((m = /^DROP ROLE IF EXISTS "([^"]+)"/.exec(q))) this.roles.delete(m[1])
    if ((m = /^REVOKE (ALL|CONNECT) ON DATABASE "([^"]+)" FROM PUBLIC/.exec(q))) this.publicConnect.delete(m[2])
  }
  async dumpGlobals() { this.calls.push('pg_dumpall --globals-only'); return 'CREATE ROLE x;\n' }

  async run(cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
    const shown = args.map((a) => (a.includes(path.sep) || a.includes('/') ? path.basename(a) : a)).join(' ')
    this.rec(`run${o.user ? `[${o.user}]` : ''} ${path.basename(cmd)} ${shown}`)
    return this.handler?.(cmd, args, o, this) ?? { code: 0, stdout: '', stderr: '' }
  }
  which(cmd: string) { return `/usr/bin/${cmd}` }
  async probe(t: Target) { return this.probeFor(t) }
  async request(t: Target, method: string, p: string) {
    void method
    if (this.probeFor(t) === 'down') return { status: 0, body: '', headers: {} }
    return { status: p.includes('/auth/login') ? 401 : 200, body: '{}', headers: {} }
  }
  async sleep(ms: number) { this.clock += ms }
  now() { return this.clock }
}

/** answers of the install CLI, the agent and the licence CLI as they look for real (enough for the flows) */
export function realisticHandler(state: { schema: number; failMigrate?: Set<string>; schemaAfterMigrate?: number } = { schema: 14 }): Handler {
  const schemaOf = new Map<string, number>()
  return (cmd, args, o, fake) => {
    const user = o.user ?? 'root'
    const script = path.basename(args[0] ?? '')
    const sub = args.slice(1)
    if (script === 'agent.ts') {
      const c = sub[0]
      if (c === 'info') return { code: 0, stdout: JSON.stringify({ ok: true, schemaVersion: schemaOf.get(user) ?? state.schema, users: { active: 1, total: 1 }, seats: { full: 1, operator: 0, external: 0 }, readOnly: null, licence: { configured: false, lastCheck: null }, lastInstallBackup: null, dbBytes: 15_000_000 }), stderr: '' }
      if (c === 'backup') {
        const out = sub[sub.indexOf('--out') + 1]
        fake.files.set(out, { text: `archive of ${user} at ${fake.clock}`, mode: 0o600, owner: user })
        return { code: 0, stdout: JSON.stringify({ ok: true, file: out, bytes: 100, sha256: fake.sha256(out), manifestSha256: 'm', rows: 10, schemaVersion: state.schema, environments: 1 }), stderr: '' }
      }
      if (c === 'access-open') return { code: 0, stdout: JSON.stringify({ ok: true, userId: 'user_op1', emailed: false, notified: 1, ...(sub.includes('--print-link') ? { link: 'https://x/#invite=tok' } : {}) }), stderr: '' }
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' }
    }
    if (script === 'main.ts' && path.basename(path.dirname(args[0])) === 'server') {
      const c = sub[0]
      // the server commands of releases that have them (core.ts installCommand): the same answers as the agent's
      if (c === 'status') return { code: 0, stdout: JSON.stringify({ ok: true, version: '0.8.0', schemaVersion: schemaOf.get(user) ?? state.schema, users: { active: 1, total: 1 }, seats: { full: 1, operator: 0, external: 0 }, readOnly: null, licence: { configured: false, lastCheck: null }, lastInstallBackup: null, dbBytes: 15_000_000 }), stderr: '' }
      if (c === 'backup' && sub[1] === 'create') {
        const out = sub[sub.indexOf('--out') + 1]
        fake.files.set(out, { text: `archive of ${user} at ${fake.clock}`, mode: 0o600, owner: user })
        return { code: 0, stdout: JSON.stringify({ ok: true, file: out, bytes: 100, sha256: fake.sha256(out), manifestSha256: 'm', rows: 10, schemaVersion: state.schema, environments: 1, encrypted: true, includesKey: sub.includes('--include-key') }), stderr: '' }
      }
      if (c === 'admin' && sub[1] === 'operator-access') {
        if (sub[2] === 'open') return { code: 0, stdout: JSON.stringify({ ok: true, userId: 'user_op1', emailed: false, notified: 1, ...(sub.includes('--print-link') ? { link: 'https://x/#invite=tok' } : {}) }), stderr: '' }
        return { code: 0, stdout: JSON.stringify({ ok: true, disabled: true, notified: 1 }), stderr: '' }
      }
      if (c === 'admin' && sub[1] === 'invite') return { code: 0, stdout: `First install administrator x created.\n${sub.includes('--print-link') ? 'Invitation link (one-time, a secret): https://acme.example.test/#invite=SECRETTOKEN\n' : ''}`, stderr: '' }
      if (c === 'seed-config') { fake.files.set(path.join(sub[sub.indexOf('--workspace') + 1], 'server.json'), { text: `{"defaultConnection":{"passwordSealed":"v1:${fake.clock}"}}`, mode: 0o600, owner: user }); return { code: 0, stdout: 'Wrote server.json', stderr: '' } }
      if (c === 'read-only' && sub[1] === 'status') return { code: 0, stdout: 'writable', stderr: '' }
      if (c === 'migrate') {
        if (state.failMigrate?.has(user)) { if (state.schemaAfterMigrate) schemaOf.set(user, state.schemaAfterMigrate); return { code: 1, stdout: '', stderr: 'ENVIRONMENT default NOT AVAILABLE: boom' } }
        if (state.schemaAfterMigrate) schemaOf.set(user, state.schemaAfterMigrate)
        return { code: 0, stdout: 'Schema ready.', stderr: '' }
      }
      if (c === 'restore') { schemaOf.delete(user); return { code: 0, stdout: '  ab: 40 tables, 100 rows\n  done in 1.0 s', stderr: '' } }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (script === 'main.ts' && args[0].includes('licence-service')) {
      const c = sub.slice(0, 2).join(' ')
      if (c === 'org create') return { code: 0, stdout: 'Organisation X: licence id lic_abc123def456 (subscription). Next: key issue lic_abc123def456', stderr: '' }
      if (c === 'key issue' || c === 'key rotate') return { code: 0, stdout: 'Install key k1 for X (shown once):\nabl_SECRETKEYVALUE123\nAPPBUILDER_LICENCE_ID=lic_abc123def456', stderr: '' }
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    void cmd
    return undefined
  }
}
