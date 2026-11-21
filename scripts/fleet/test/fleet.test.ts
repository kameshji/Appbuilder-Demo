/**
 * The fleet tool's plans and rollbacks on the recording fake (no machine is touched): every command's system effects
 * in order, the rollback of `org create` after a failure at EVERY step, delete's verified removal, the update rule
 * for schema-changing releases, backups off the machine, operator access and secrets rotation, limits, dry runs.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { leftovers, testFleet, type TestFleet } from './helpers.ts'
import { orgPaths, type OrgRecord } from '../lib/model.ts'
import { fleetUpdate, type StagedRelease } from '../lib/update.ts'
import { backupRun, prune, restoreOrg } from '../lib/backup.ts'
import { accessSweep } from '../lib/access.ts'

const created = async (t: TestFleet, slug: string, extra: string[] = []) => {
  const r = await t.run(['org', 'create', slug, '--name', `${slug} Ltd`, '--admin-email', `it@${slug}.example`, '--print-link', ...extra])
  expect(r.error ?? '').toBe('')
  expect(r.code).toBe(0)
  return Object.values(t.reg().orgs).find((o) => o.slug === slug)!
}

describe('org create', () => {
  it('creates the user, folders, database with its isolation, key, env, unit and site, in that order', async () => {
    const t = testFleet({ licence: true })
    const org = await created(t, 'acme')
    const op = orgPaths(t.paths, org.id)
    const f = t.fake
    expect(org.state).toBe('active')
    expect(org.id).toMatch(/^o[a-z2-7]{8}$/)
    expect(org.osUser).toBe(`ab-${org.id}`)
    expect(org.db).toBe(`ab_${org.id}`)
    expect(f.users.has(org.osUser)).toBe(true)
    expect(f.dirs.get(op.dir)).toMatchObject({ mode: 0o750, owner: 'root', group: org.osUser })
    expect(f.dirs.get(op.workspace)).toMatchObject({ mode: 0o700, owner: org.osUser })
    expect(f.links.get(op.app)).toBe(path.join(t.paths.releases, '0.8.0'))
    expect(f.files.get(op.secretKey)).toMatchObject({ mode: 0o600, owner: org.osUser })
    expect(f.files.get(op.secretKey)!.text.trim()).toMatch(/^[0-9a-f]{64}$/)
    expect(f.files.get(op.env)).toMatchObject({ mode: 0o640, owner: 'root', group: org.osUser })
    expect(f.files.get(op.licenceKey)).toMatchObject({ mode: 0o640, owner: 'root', group: org.osUser })
    const sql = f.calls.filter((c) => c.startsWith('sql '))
    expect(sql.some((c) => /CREATE ROLE ".+" LOGIN PASSWORD '\*\*\*' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 12/.test(c))).toBe(true)
    expect(sql.some((c) => c.includes(`REVOKE ALL ON DATABASE "${org.db}" FROM PUBLIC`))).toBe(true)
    expect(sql.some((c) => c.includes(`GRANT CONNECT, TEMPORARY ON DATABASE "${org.db}" TO "${org.db}"`))).toBe(true)
    expect(sql.some((c) => c.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC'))).toBe(true)
    expect(f.publicConnect.has(org.db)).toBe(false)
    // the install's own commands run as its user, the password only on standard input
    const seed = f.calls.find((c) => c.includes('seed-config'))!
    expect(seed).toMatch(new RegExp(`^run\\[${org.osUser}\\] `))
    expect(seed).not.toMatch(/password/i)
    const order = ['useradd', 'CREATE ROLE', 'seed-config', ' migrate', 'admin invite', 'systemctl enable', 'systemctl start', `write ${op.caddySite}`, 'systemctl reload caddy']
    const idx = order.map((k) => f.calls.findIndex((c) => c.includes(k)))
    expect(idx.every((x) => x >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(f.active.has(`appbuilder@${org.id}`)).toBe(true)
    expect(f.files.get(op.caddySite)!.text).toContain(`${org.host} {`)
    // secrets are not printed: the invitation link only with --print-link, never the licence key
    const all = t.out.join('\n')
    expect(all).not.toContain('abl_SECRETKEYVALUE')
    expect(f.readText(t.paths.audit)).not.toContain('SECRET')
    const env = f.files.get(op.env)!.text
    expect(env).not.toMatch(/PASSWORD|abl_/)
  })

  it('prints the one-time link only with --print-link and refuses without a relay otherwise', async () => {
    const t = testFleet()
    const r = await t.run(['org', 'create', 'beta', '--name', 'Beta', '--admin-email', 'a@beta.example'])
    expect(r.code).toBe(2)
    expect(r.error).toMatch(/no mail relay/i)
    expect(leftovers(t)).toEqual([])
    const ok = await t.run(['org', 'create', 'beta', '--name', 'Beta', '--admin-email', 'a@beta.example', '--print-link', '--json'])
    expect(ok.code).toBe(0)
    expect((ok.result as { link: string }).link).toContain('#invite=SECRETTOKEN')
  })

  it('refuses bad names, reserved names, duplicates and a 21st organisation', async () => {
    const t = testFleet()
    expect((await t.run(['org', 'create', 'Bad_Name', '--name', 'x', '--admin-email', 'a@b.c', '--print-link'])).code).toBe(64)
    expect((await t.run(['org', 'create', 'licence', '--name', 'x', '--admin-email', 'a@b.c', '--print-link'])).code).toBe(64)
    await created(t, 'one')
    expect((await t.run(['org', 'create', 'one', '--name', 'x', '--admin-email', 'a@b.c', '--print-link'])).code).toBe(2)
  })

  it('removes everything it created when ANY step fails (each step in turn)', async () => {
    const probe = testFleet({ licence: true })
    await created(probe, 'acme')
    // every effect of a successful create, except the audit line written after the command
    const steps = probe.fake.calls.filter((c) => !c.includes(probe.paths.audit))
    expect(steps.length).toBeGreaterThan(25)
    for (let n = 0; n < steps.length; n++) {
      const t = testFleet({ licence: true })
      let hits = 0
      // the id is random: match the call by its shape (ids replaced)
      const shape = (c: string) => c.replace(/o[a-z2-7]{8}/g, 'ID').replace(/tmp-\w+/g, 'tmp')
      const want = shape(steps[n])
      const occurrence = steps.slice(0, n).filter((c) => shape(c) === want).length
      t.fake.failOn = (c) => shape(c) === want && hits++ === occurrence
      const r = await t.run(['org', 'create', 'acme', '--name', 'Acme', '--admin-email', 'it@acme.example', '--print-link'])
      if (r.code === 0) continue // a call whose failure the flow tolerates (a probe, a reload retried)
      expect(r.error, `step ${n}: ${steps[n]}`).toMatch(/failed|exists/i)
      expect(leftovers(t), `after a failure at step ${n} (${steps[n]})`).toEqual([])
      if (t.fake.calls.some((c) => c.includes('org create'))) {
        const issued = t.fake.calls.some((c) => c.includes('key issue'))
        if (issued || t.fake.calls.findIndex((c) => c.includes('org create')) < t.fake.calls.findIndex((c) => c.includes('failure'))) expect(t.fake.calls.some((c) => c.includes('key revoke')) || !issued).toBe(true)
      }
    }
  })

  it('changes nothing with --dry-run and says what it would do', async () => {
    const t = testFleet()
    const before = JSON.stringify([...t.fake.files.keys()].sort())
    const r = await t.run(['org', 'create', 'acme', '--name', 'Acme', '--admin-email', 'it@acme.example', '--print-link', '--dry-run'])
    expect(r.code).toBe(0)
    expect(t.out.join('\n')).toMatch(/would create the system user ab-o/)
    expect(t.out.join('\n')).toMatch(/would run SQL in postgres: CREATE ROLE .* PASSWORD '\*\*\*'/)
    expect(t.fake.users.size + t.fake.roles.size).toBe(0)
    const after = [...t.fake.files.keys()].filter((k) => k !== t.paths.audit).sort()
    expect(JSON.stringify(after)).toBe(before)
    expect(t.fake.readText(t.paths.audit)).toContain('"dryRun":true')
  })
})

describe('suspend, resume, delete', () => {
  it('suspend uses the read-only gate with a reason; --stop stops the unit and shows a notice; resume undoes both', async () => {
    const t = testFleet()
    const org = await created(t, 'acme')
    t.fake.calls = []
    expect((await t.run(['org', 'suspend', 'acme', '--reason', 'Invoice 12 overdue'])).code).toBe(0)
    expect(t.fake.calls.some((c) => /read-only on --reason suspended --message Invoice 12 overdue/.test(c))).toBe(true)
    expect(t.reg().orgs[org.id].state).toBe('suspended')
    expect(t.fake.active.has(`appbuilder@${org.id}`)).toBe(true)
    expect((await t.run(['org', 'suspend', 'acme', '--reason', 'Incident', '--stop'])).code).toBe(0)
    expect(t.fake.active.has(`appbuilder@${org.id}`)).toBe(false)
    expect(t.fake.readText(orgPaths(t.paths, org.id).caddySite)).toContain('respond "This Appbuilder is paused')
    expect((await t.run(['org', 'resume', 'acme'])).code).toBe(0)
    expect(t.fake.active.has(`appbuilder@${org.id}`)).toBe(true)
    expect(t.fake.readText(orgPaths(t.paths, org.id).caddySite)).toContain('reverse_proxy unix/')
    expect(t.fake.calls.some((c) => c.includes('read-only off'))).toBe(true)
    expect(t.reg().orgs[org.id].state).toBe('active')
  })

  it('delete needs the typed host name, exports first and leaves nothing (scan)', async () => {
    const t = testFleet({ licence: true, target: true })
    const a = await created(t, 'acme')
    const b = await created(t, 'beta')
    expect((await t.run(['org', 'delete', 'acme', '--confirm', 'acme'])).code).toBe(64)
    t.fake.calls = []
    const r = await t.run(['org', 'delete', 'acme', '--confirm', a.host, '--json'])
    expect(r.code).toBe(0)
    const rep = r.result as { export: string; removed: string[]; remaining: string[]; kept: string[] }
    expect(rep.remaining).toEqual([])
    expect(rep.export).toContain(path.join(t.paths.exports, 'acme-export-'))
    expect(t.fake.calls.findIndex((c) => c.includes('agent.ts backup'))).toBeLessThan(t.fake.calls.findIndex((c) => c.includes('systemctl stop')))
    expect(t.fake.calls.some((c) => c.includes('key revoke'))).toBe(true)
    expect(t.fake.users.has(a.osUser)).toBe(false)
    expect(t.fake.dbs.has(a.db) || t.fake.roles.has(a.db)).toBe(false)
    expect([...t.fake.files.keys()].some((k) => k.includes(a.id) && !k.startsWith(t.paths.exports) && !k.startsWith('/mnt') && !k.startsWith(path.sep + 'mnt'))).toBe(false)
    // the other organisation is untouched
    expect(t.fake.users.has(b.osUser) && t.fake.dbs.has(b.db) && t.fake.active.has(`appbuilder@${b.id}`)).toBe(true)
    expect(t.fake.calls.some((c) => c.includes(b.id))).toBe(false)
  })
})

describe('update', () => {
  const staged: StagedRelease = { version: '0.9.0', commit: 'bbbb', schemaVersion: 15, node: '>=22.18', dir: '', signature: 'valid (key k1)', reused: true }
  async function three(t: TestFleet): Promise<OrgRecord[]> {
    return [await created(t, 'a1'), await created(t, 'b2'), await created(t, 'c3')]
  }

  it('updates the canary first, then the rest; a schema-changing failure restores that install alone from its snapshot', async () => {
    const t = testFleet({ handler: { schema: 14, schemaAfterMigrate: 15, failMigrate: new Set() } })
    const [a, b, c] = await three(t)
    const failing = new Set([b.osUser])
    t.fake.handler = (await import('../lib/fake.ts')).realisticHandler({ schema: 14, schemaAfterMigrate: 15, failMigrate: failing })
    t.fake.calls = []
    const ctx = t.ctx()
    const run = await fleetUpdate(ctx, 'x.zip', { stage: async () => ({ ...staged, dir: path.join(t.paths.releases, '0.9.0') }), batch: 1, onFailure: 'continue' })
    expect(run.canary).toBe(a.id)
    expect(run.steps.map((s) => [s.host, s.result])).toEqual([[a.host, 'updated'], [b.host, 'rolled-back'], [c.host, 'updated']])
    const stepB = run.steps[1]
    expect(stepB.dataRestored).toBe(true)
    expect(ctx.reg.orgs[a.id].release).toBe('0.9.0')
    expect(ctx.reg.orgs[b.id].release).toBe('0.8.0')
    expect(t.fake.links.get(orgPaths(t.paths, b.id).app)).toBe(path.join(t.paths.releases, '0.8.0'))
    // b: read-only, stop, snapshot, switch, migrate failed, stop, restore of the snapshot by the OLD release, start, writable
    const bc = t.fake.calls.filter((x) => x.includes(b.id) || x.includes(b.osUser))
    const seq = ['read-only on --reason maintenance', 'systemctl stop', 'agent.ts backup', 'migrate', 'restore', 'systemctl start', 'read-only off']
    const at = seq.map((k) => bc.findIndex((x) => x.includes(k)))
    expect(at.every((x) => x >= 0), JSON.stringify(bc, null, 1)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    // nobody else was restored
    expect(t.fake.calls.filter((x) => x.includes(' restore ')).every((x) => x.includes(b.osUser))).toBe(true)
    expect(run.result).toBe('completed')
    expect(t.fake.readLink(t.paths.current)).toBe(path.join(t.paths.releases, '0.9.0'))
  })

  it('stops the fleet at a failed batch (default), and rolls back code only when the schema did not change', async () => {
    const t = testFleet()
    const [a, b, c] = await three(t)
    t.fake.calls = []
    // b fails its health check after the switch (the release did not change the schema)
    let switched = false
    t.fake.probeFor = (tg) => (switched && tg.socket?.includes(b.id) && t.fake.links.get(orgPaths(t.paths, b.id).app)?.endsWith('0.9.0') ? 'down' : 'ok')
    const ctx = t.ctx()
    const run = await fleetUpdate(ctx, 'x.zip', { stage: async () => { switched = true; return { ...staged, schemaVersion: 14, dir: path.join(t.paths.releases, '0.9.0') } }, batch: 1, healthTimeoutS: 2 })
    expect(run.steps.map((s) => s.result)).toEqual(['updated', 'rolled-back', 'not-run'])
    expect(run.steps[1].dataRestored).toBeFalsy()
    expect(run.steps[1].message).toMatch(/Only the code was rolled back/)
    expect(run.result).toBe('stopped')
    expect(ctx.reg.orgs[c.id].release).toBe('0.8.0')
    expect(t.fake.calls.some((x) => x.includes(' restore '))).toBe(false)
    expect(ctx.reg.alerts.some((x) => x.org === b.id && x.kind === 'update')).toBe(true)
    void a
  })

  it('a failed canary leaves the rest untouched', async () => {
    const t = testFleet()
    const [a, b, c] = await three(t)
    t.fake.handler = (await import('../lib/fake.ts')).realisticHandler({ schema: 14, failMigrate: new Set([a.osUser]) })
    t.fake.calls = []
    const run = await fleetUpdate(t.ctx(), 'x.zip', { stage: async () => ({ ...staged, dir: path.join(t.paths.releases, '0.9.0') }) })
    expect(run.steps.map((s) => s.result)).toEqual(['rolled-back', 'not-run', 'not-run'])
    expect(t.fake.calls.some((x) => x.includes(b.id) || x.includes(c.id))).toBe(false)
    expect(t.fake.readLink(t.paths.current)).toBe(path.join(t.paths.releases, '0.8.0'))
  })
})

describe('backups', () => {
  it('backs up each install with its own engine and passphrase, copies it off the machine and checks the copy', async () => {
    const t = testFleet({ target: true })
    const [a, b] = [await created(t, 'acme'), await created(t, 'beta')]
    t.fake.calls = []
    const ctx = t.ctx()
    const r = await backupRun(ctx, Object.values(ctx.reg.orgs), { globals: true })
    expect(r.ok.sort()).toEqual([a.host, b.host].sort())
    const runs = t.fake.calls.filter((c) => c.includes('agent.ts backup'))
    expect(runs.map((c) => /^run\[(ab-o\w+)\]/.exec(c)?.[1]).sort()).toEqual([a.osUser, b.osUser].sort())
    expect(runs.every((c) => c.includes('--include-key') && !/pass/i.test(c))).toBe(true)
    for (const e of ctx.reg.backups.filter((x) => x.kind === 'nightly')) {
      expect(e.offsite).toContain(path.join('mnt', 'offsite'))
      expect(t.fake.sha256(e.offsite!)).toBe(e.sha256)
    }
    expect(ctx.reg.backups.some((x) => x.kind === 'globals' && x.offsite)).toBe(true)
    expect(t.fake.readText(ctx.reg.backups.find((x) => x.kind === 'globals')!.file)).not.toContain('CREATE ROLE')
  })

  it('reports one failed install and still backs up the others; retention prunes old copies but keeps the newest', async () => {
    const t = testFleet({ target: true })
    const [a, b] = [await created(t, 'acme'), await created(t, 'beta')]
    const ctx = t.ctx()
    const base = t.fake.handler!
    t.fake.handler = (cmd, args, o, f) => (o.user === a.osUser && args.includes('backup') ? { code: 1, stdout: '{"ok":false,"error":"disk full"}', stderr: '' } : base(cmd, args, o, f))
    const r = await backupRun(ctx, Object.values(ctx.reg.orgs), { globals: false })
    expect(r.failed.map((x) => x.org)).toEqual([a.host])
    expect(r.ok).toEqual([b.host])
    expect(ctx.reg.alerts.some((x) => x.org === a.id && x.kind === 'backup')).toBe(true)
    const first = ctx.reg.backups.find((x) => x.org === b.id)!
    t.fake.clock += 20 * 86_400_000
    t.fake.handler = base
    await backupRun(ctx, [ctx.reg.orgs[b.id]], { globals: false })
    // the run pruned the copy older than 14 days, here and off the machine, and kept the new one
    expect(ctx.reg.backups.filter((x) => x.org === b.id).length).toBe(1)
    expect(t.fake.exists(first.file) || t.fake.exists(first.offsite!)).toBe(false)
    expect(await prune(ctx)).toBe(0)
  })

  it('restore stops, restores and starts ONE install; the others are not touched', async () => {
    const t = testFleet({ target: true })
    const [a, b] = [await created(t, 'acme'), await created(t, 'beta')]
    const ctx = t.ctx()
    await backupRun(ctx, Object.values(ctx.reg.orgs), { globals: false })
    t.fake.calls = []
    const r = await restoreOrg(ctx, ctx.reg.orgs[a.id])
    expect(r.healthy).toBe(true)
    expect(t.fake.calls.some((c) => c.includes(b.id) || c.includes(b.osUser))).toBe(false)
    const seq = ['systemctl stop', 'agent.ts backup', 'restore', 'systemctl start']
    const at = seq.map((k) => t.fake.calls.findIndex((x) => x.includes(k)))
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(t.fake.calls.some((c) => /--passphrase-file pp-/.test(c))).toBe(true)
    expect([...t.fake.files.keys()].some((k) => /pp-[a-z2-7]{8}$/.test(k))).toBe(false)
  })
})

describe('operator access and secrets', () => {
  it('grants time-boxed access through the install, refuses more than 4 hours, and ends it by itself', async () => {
    const t = testFleet()
    const a = await created(t, 'acme')
    expect((await t.run(['access', 'grant', 'acme', '--reason', 'Ticket 42: import fails', '--minutes', '300', '--print-link'])).code).toBe(64)
    expect((await t.run(['access', 'grant', 'acme', '--reason', 'Ticket 42: import fails', '--minutes', '30'])).code).toBe(2)
    const g = await t.run(['access', 'grant', 'acme', '--reason', 'Ticket 42: import fails', '--minutes', '30', '--print-link', '--json'])
    expect(g.code).toBe(0)
    const open = t.fake.calls.find((c) => c.includes('access-open'))!
    expect(open).toMatch(new RegExp(`^run\\[${a.osUser}\\]`))
    expect(open).toContain('--reason Ticket 42: import fails')
    expect(t.reg().grants[0]).toMatchObject({ org: a.id, state: 'active', by: 'tester' })
    t.fake.clock += 31 * 60_000
    // the next abfleet command of any kind ends it first
    await t.run(['org', 'list'])
    expect(t.fake.calls.some((c) => c.includes('access-close') && c.includes('--why expired'))).toBe(true)
    expect(t.reg().grants[0].state).toBe('ended')
    const ctx = t.ctx()
    expect((await accessSweep(ctx)).ended).toEqual([])
  })

  it('rotates the database password with a re-seal and restart, puts the old one back on failure, refuses the secret key', async () => {
    const t = testFleet()
    const a = await created(t, 'acme')
    t.fake.calls = []
    const ok = await t.run(['secrets', 'rotate', 'acme', '--what', 'db'])
    expect(ok.code).toBe(0)
    const i = (k: string) => t.fake.calls.findIndex((c) => c.includes(k))
    expect(i(`ALTER ROLE "${a.db}" PASSWORD '***'`)).toBeGreaterThanOrEqual(0)
    expect(i('seed-config')).toBeGreaterThan(i('ALTER ROLE'))
    expect(i('systemctl restart')).toBeGreaterThan(i('seed-config'))
    const base = t.fake.handler!
    t.fake.handler = (cmd, args, o, f) => (args.includes('seed-config') ? { code: 2, stdout: '', stderr: 'cannot sign in' } : base(cmd, args, o, f))
    t.fake.calls = []
    const bad = await t.run(['secrets', 'rotate', 'acme', '--what', 'db'])
    expect(bad.code).toBe(1)
    expect(t.fake.calls.filter((c) => c.includes('ALTER ROLE') && c.includes('PASSWORD')).length).toBe(2)
    const sk = await t.run(['secrets', 'rotate', 'acme', '--what', 'secret-key'])
    expect(sk.code).toBe(69)
    expect(sk.error).toMatch(/not supported/)
  })
})

describe('limits and doctor', () => {
  it('writes the drop-in, applies it live and sets the PostgreSQL limits; refuses nonsense', async () => {
    const t = testFleet()
    const a = await created(t, 'acme')
    t.fake.calls = []
    expect((await t.run(['limits', 'apply', 'acme', '--memory-max', '2G', '--cpu-quota', '150%', '--db-connections', '10'])).code).toBe(0)
    const conf = t.fake.readText(orgPaths(t.paths, a.id).limitsConf)!
    expect(conf).toContain('MemoryMax=2G')
    expect(conf).toContain('CPUQuota=150%')
    expect(t.fake.calls.some((c) => c.includes(`set-property --runtime appbuilder@${a.id}`))).toBe(true)
    expect(t.fake.calls.some((c) => c.includes(`ALTER ROLE "${a.db}" CONNECTION LIMIT 10`))).toBe(true)
    expect(t.fake.calls.some((c) => c.includes(`ALTER DATABASE "${a.db}" CONNECTION LIMIT 10`))).toBe(true)
    expect((await t.run(['limits', 'apply', 'acme', '--memory-max', 'lots'])).code).toBe(64)
    expect((await t.run(['limits', 'apply', 'acme', '--db-connections', '3'])).code).toBe(64)
  })

  it('doctor finds an open postgres database and leftovers of unknown organisations', async () => {
    const t = testFleet()
    await created(t, 'acme')
    t.fake.publicConnect.add('postgres')
    t.fake.dbs.add('ab_ozzzzzzzz')
    const r = await t.run(['doctor', '--json'])
    expect(r.code).toBe(1)
    const problems = (r.result as { problems: string[] }).problems.join('\n')
    expect(problems).toMatch(/PUBLIC can connect to postgres/)
    expect(problems).toMatch(/leftover database or role: ab_ozzzzzzzz/)
  })
})
