/**
 * The server commands the fleet tool runs in an install (docs/admin/hosting.md "Server commands for operators"):
 * status --json, backup create, admin operator-access open|close; against the sandbox PostgreSQL, in process.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/hosting/fleet-commands
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PG_URL, SKIP_PG, createDatabase, dropDatabase, pgQuery, pgServer, testDatabaseName } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { runHostingCli } from './cli.ts'
import { runStatusCli } from './status-cli.ts'
import { runBackupCreateCli } from '../backup/create-cli.ts'
import { openArchive, verifyArchive } from '../backup/engine.ts'
import { runOperatorAccessCli } from '../identity/operator-access-cli.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core/hosting fleet commands] ${SKIP_PG}\n`)

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')) as Record<string, unknown> }
}

describe.skipIf(!PG_URL)('fleet server commands (PostgreSQL)', () => {
  const dbName = testDatabaseName('flcmd')
  let tmp = ''
  let env: NodeJS.ProcessEnv = {}
  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => pgQuery<T>(dbName, sql, p)

  beforeAll(async () => {
    await createDatabase(dbName)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-flcmd-'))
    env = {
      APPBUILDER_WORKSPACE: path.join(tmp, 'workspace'), APPBUILDER_DB_HOST: pgServer!.host, APPBUILDER_DB_PORT: String(pgServer!.port),
      APPBUILDER_DB_NAME: dbName, APPBUILDER_DB_USER: pgServer!.user, APPBUILDER_DB_PASSWORD: pgServer!.password,
      APPBUILDER_PUBLIC_URL: 'https://acme.apps.example.test', APPBUILDER_SETUP: 'closed',
    }
    const m = capture()
    expect(await runHostingCli(['migrate'], { env, io: m.io }), m.text()).toBe(0)
    const inv = capture()
    expect(await runHostingCli(['invite', '--email', 'ada@example.com', '--name', 'Ada Admin', '--print-link'], { env, io: inv.io }), inv.text()).toBe(0)
  }, 60_000)

  afterAll(async () => {
    await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 30_000)

  it('status --json: schema, users, read-only, licence, size, last backup; usage and missing login', async () => {
    const c = capture()
    expect(await runStatusCli(['--json'], { env, io: c.io }), c.text()).toBe(0)
    const s = c.json()
    expect(s).toMatchObject({ ok: true, schemaVersion: expect.any(Number), users: { active: 1, total: 1 }, readOnly: null, licence: { configured: false, lastCheck: null }, lastInstallBackup: null })
    expect(s.dbBytes).toBeGreaterThan(0)
    expect(c.out).toHaveLength(1)
    // read-only from the environment is reported as such
    const ro = capture()
    expect(await runStatusCli(['--json'], { env: { ...env, APPBUILDER_READ_ONLY: 'maintenance' }, io: ro.io })).toBe(0)
    expect(ro.json().readOnly).toMatchObject({ reason: 'maintenance', source: 'env' })
    // stored read-only (the read-only command) as well
    expect(await runHostingCli(['read-only', 'on', '--reason', 'suspended'], { env, io: capture().io })).toBe(0)
    const st = capture()
    expect(await runStatusCli(['--json'], { env, io: st.io })).toBe(0)
    expect(st.json().readOnly).toMatchObject({ reason: 'suspended', source: 'cli' })
    expect(await runHostingCli(['read-only', 'off'], { env, io: capture().io })).toBe(0)
    // human output, usage, no login
    const h = capture()
    expect(await runStatusCli([], { env, io: h.io })).toBe(0)
    expect(h.out.join('\n')).toMatch(/Users: 1 active of 1/)
    expect(await runStatusCli(['--nope'], { env, io: capture().io })).toBe(64)
    const none = capture()
    expect(await runStatusCli(['--json'], { env: { APPBUILDER_WORKSPACE: path.join(tmp, 'empty-ws') }, io: none.io })).toBe(2)
    expect(none.json()).toMatchObject({ ok: false, error: expect.stringMatching(/no database login/) })
  }, 30_000)

  it('backup create: a verified encrypted archive with the key, audited, not in the install\'s backup list', async () => {
    const out = path.join(tmp, 'fleet-backups', 'acme-nightly.abbak')
    const c = capture()
    const pass = 'fleet passphrase 123'
    expect(await runBackupCreateCli(['--out', out, '--include-key', '--passphrase-stdin', '--trigger', 'pre-upgrade', '--note', 'test', '--json'], { env, io: c.io, stdin: async () => pass }), c.text()).toBe(0)
    const r = c.json()
    expect(r).toMatchObject({ ok: true, file: out, encrypted: true, includesKey: true, environments: expect.any(Number), schemaVersion: expect.any(Number) })
    expect(fs.statSync(out).size).toBe(r.bytes)
    const a = await openArchive(out, pass)
    try {
      expect(a.manifest.includesKey).toBe(true)
      expect(a.manifest.trigger).toBe('pre-upgrade')
      expect((await verifyArchive(a)).ok).toBe(true)
    } finally {
      await a.close()
    }
    await expect(openArchive(out, 'wrong passphrase!!')).rejects.toThrow()
    expect(await q(`SELECT 1 FROM ab.backups`)).toEqual([])
    const audit = await q<{ details: Record<string, unknown> }>(`SELECT details FROM ab.audit WHERE action = 'install.cli_backup'`)
    expect(audit[0].details).toMatchObject({ file: out, encrypted: true, includesKey: true, trigger: 'pre-upgrade', source: 'cli' })
    expect(JSON.stringify(audit)).not.toContain(pass)
    // an existing file is never overwritten; the key needs a passphrase; usage
    const again = capture()
    expect(await runBackupCreateCli(['--out', out, '--json'], { env, io: again.io })).toBe(1)
    expect(again.json().error).toMatch(/exists already/)
    expect(await runBackupCreateCli(['--out', path.join(tmp, 'k.abbak'), '--include-key'], { env, io: capture().io })).toBe(64)
    expect(fs.existsSync(path.join(tmp, 'k.abbak'))).toBe(false)
    expect(await runBackupCreateCli([], { env, io: capture().io })).toBe(64)
    expect(await runBackupCreateCli(['--out', path.join(tmp, 'x.abbak'), '--trigger', 'schedule'], { env, io: capture().io })).toBe(64)
    // a plain archive from a passphrase file's empty first line is not encrypted
    const pf = path.join(tmp, 'pp.txt')
    fs.writeFileSync(pf, '\n')
    const plain = path.join(tmp, 'plain.abbak')
    expect(await runBackupCreateCli(['--out', plain, '--passphrase-file', pf], { env, io: capture().io })).toBe(0)
    const b = await openArchive(plain, null)
    await b.close()
    // status now reports no INSTALL backup (the command does not register one)
    const s = capture()
    await runStatusCli(['--json'], { env, io: s.io })
    expect(s.json().lastInstallBackup).toBeNull()
  }, 60_000)

  it('admin operator-access open and close: a time-boxed administrator, audited, the other administrators told', async () => {
    const until = new Date(Date.now() + 30 * 60_000).toISOString()
    const tooLong = new Date(Date.now() + 5 * 3_600_000).toISOString()
    const refused = capture()
    expect(await runOperatorAccessCli(['open', '--grant', 'gabc', '--email', 'ops+gabc@example.test', '--reason', 'check a ticket', '--until', tooLong, '--json'], { env, io: refused.io })).toBe(1)
    expect(refused.json().error).toMatch(/4 hours/)
    expect(await runOperatorAccessCli(['open', '--grant', 'gabc', '--email', 'nope', '--reason', 'x', '--until', until], { env, io: capture().io })).toBe(64)
    const c = capture()
    expect(await runOperatorAccessCli(['open', '--grant', 'gabc', '--email', 'Ops+gabc@example.test', '--name', 'Operator access (ci)', '--reason', 'check ticket 42', '--until', until, '--operator', 'ci', '--print-link', '--json'], { env, io: c.io }), c.text()).toBe(0)
    const r = c.json()
    expect(r).toMatchObject({ ok: true, userId: expect.any(String), emailed: false, notified: 1, link: expect.stringMatching(/^https:\/\/acme\.apps\.example\.test\/#invite=/) })
    const u = await q<{ email: string; is_install_admin: boolean; status: string; password_hash: string | null }>(`SELECT email, is_install_admin, status, password_hash FROM ab.users WHERE id = $1`, [r.userId])
    expect(u).toEqual([{ email: 'ops+gabc@example.test', is_install_admin: true, status: 'active', password_hash: null }])
    const open = await q<{ details: Record<string, unknown> }>(`SELECT details FROM ab.audit WHERE action = 'install.operator_access'`)
    expect(open[0].details).toMatchObject({ grant: 'gabc', email: 'ops+gabc@example.test', reason: 'check ticket 42', operator: 'ci', source: 'cli' })
    expect(JSON.stringify(open)).not.toContain(String(r.link).split('=')[1])
    const notes = await q<{ title: string }>(`SELECT n.title FROM ab.notifications n JOIN ab.users u ON u.id = n.user_id WHERE u.email = 'ada@example.com'`)
    expect(notes.map((n) => n.title)).toContain('Operator access to this Appbuilder')
    // the same address twice: refused
    expect(await runOperatorAccessCli(['open', '--grant', 'gdef', '--email', 'ops+gabc@example.test', '--reason', 'again please', '--until', until], { env, io: capture().io })).toBe(1)
    // close
    const cl = capture()
    expect(await runOperatorAccessCli(['close', '--user', String(r.userId), '--grant', 'gabc', '--why', 'expired', '--operator', 'timer', '--json'], { env, io: cl.io }), cl.text()).toBe(0)
    expect(cl.json()).toMatchObject({ ok: true, disabled: true, notified: 1 })
    expect((await q<{ status: string }>(`SELECT status FROM ab.users WHERE id = $1`, [r.userId]))[0].status).toBe('disabled')
    const end = await q<{ details: Record<string, unknown> }>(`SELECT details FROM ab.audit WHERE action = 'install.operator_access_end'`)
    expect(end[0].details).toMatchObject({ grant: 'gabc', userId: r.userId, why: 'expired', operator: 'timer' })
    // closing an unknown account is not an error (a sweep after a restore), and is audited
    const gone = capture()
    expect(await runOperatorAccessCli(['close', '--user', 'user_nobody', '--json'], { env, io: gone.io })).toBe(0)
    expect(gone.json()).toMatchObject({ ok: true, disabled: false, notified: 0 })
    expect(await runOperatorAccessCli(['frobnicate'], { env, io: capture().io })).toBe(64)
  }, 60_000)
})
