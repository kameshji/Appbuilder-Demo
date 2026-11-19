/**
 * Offline recovery of administrator access (identity/admin-cli.ts): `appbuilder admin list | reset-password | reset-mfa |
 * make-install-admin`, against a running server's database; refuses without the workspace's secret key; audited with
 * source "cli" and the OS user.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/identity/admin-cli
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { runAdminCli } from './admin-cli.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[admin cli] ${SKIP_PG}\n`)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('appbuilder admin (recovery CLI)', () => {
  let h: KernelHarness
  const run = async (argv: string[], env: NodeJS.ProcessEnv = { APPBUILDER_WORKSPACE: h.tmp }) => {
    const out: string[] = []
    const err: string[] = []
    const code = await runAdminCli(argv, { env, io: { out: (l) => out.push(l), err: (l) => err.push(l) } })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  beforeAll(async () => {
    h = await startHarness('admincli')
    const u = await h.admin.post('/users', { name: 'Bea Backup', email: 'bea@example.com', roleIds: ['role_maker'], password: 'some-password-1' })
    expect(u.status).toBe(200)
  }, 120000)
  afterAll(async () => { await h?.close() }, 60000)

  it('refuses without the workspace secret key or a database login', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-nokey-'))
    try {
      const r = await run(['list'], { APPBUILDER_WORKSPACE: empty })
      expect(r.code).toBe(77)
      expect(r.err).toMatch(/REFUSED: Cannot read the workspace's secret key/)
      // the refusal does not create a key
      expect(fs.existsSync(path.join(empty, '.secret-key'))).toBe(false)
      fs.copyFileSync(path.join(h.tmp, '.secret-key'), path.join(empty, '.secret-key'))
      expect((await run(['list'], { APPBUILDER_WORKSPACE: empty })).err).toMatch(/no database login/)
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
    expect((await run(['bogus'])).code).toBe(64)
    expect((await run(['reset-password'])).code).toBe(64)
  })

  it('list shows the administrators', async () => {
    const r = await run(['list'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toMatch(/ada@example\.com\s+Ada\s+install administrator/)
    expect(r.out).not.toMatch(/bea@example\.com/)
  })

  it('reset-password prints a 15-minute one-time code that signs the person back in (the running server accepts it)', async () => {
    const r = await run(['reset-password', 'ADA@example.com'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).not.toMatch(/admin-password-1/)
    const code = /reset code for ada@example\.com: ([A-Z0-9-]+)/.exec(r.out)?.[1]
    expect(code).toBeTruthy()
    const tok = await h.q<any>(`SELECT expires_on, created_on FROM ab.auth_tokens WHERE kind = 'reset' AND used_on IS NULL`)
    expect(tok).toHaveLength(1)
    expect(new Date(tok[0].expires_on).getTime() - new Date(tok[0].created_on).getTime()).toBeLessThanOrEqual(15 * 60_000 + 1000)
    const anon = new Client(h.base)
    const reset = await anon.post('/auth/password/reset', { email: 'ada@example.com', code, password: 'a-brand-new-password-9' })
    expect(reset.status, JSON.stringify(reset.data)).toBe(200)
    expect((await anon.post('/auth/password/reset', { email: 'ada@example.com', code, password: 'another-password-77' })).status).toBe(422)
    const signin = await new Client(h.base).post('/auth/login', { email: 'ada@example.com', password: 'a-brand-new-password-9' })
    expect(signin.status).toBe(200)
    const audit = await h.q<any>(`SELECT action, details FROM ab.audit WHERE action = 'install.cli_reset_code'`)
    expect(audit[0].details).toMatchObject({ source: 'cli', email: 'ada@example.com' })
    expect(audit[0].details.osUser).toBeTruthy()
  })

  it('reset-mfa removes two-step verification and ends sessions; make-install-admin promotes', async () => {
    const ada = (await h.q<any>(`SELECT id FROM ab.users WHERE email = 'ada@example.com'`))[0].id
    await h.q(`INSERT INTO ab.user_mfa (user_id, totp_secret_sealed, totp_enabled_on, modified_on) VALUES ($1, 'x', now(), now()) ON CONFLICT DO NOTHING`, [ada]).catch(async () => {
      const cols = (await h.q<any>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'ab' AND table_name = 'user_mfa'`)).map((c) => c.column_name)
      throw new Error(`user_mfa columns: ${cols.join(', ')}`)
    })
    const r = await run(['reset-mfa', 'ada@example.com'])
    expect(r.code, r.err).toBe(0)
    expect(await h.q(`SELECT 1 FROM ab.user_mfa WHERE user_id = $1`, [ada])).toHaveLength(0)
    expect(await h.q(`SELECT 1 FROM ab.sessions WHERE user_id = $1`, [ada])).toHaveLength(0)
    await h.q(`UPDATE ab.users SET status = 'disabled' WHERE email = 'bea@example.com'`)
    const m = await run(['make-install-admin', 'bea@example.com'])
    expect(m.code, m.err).toBe(0)
    expect((await h.q<any>(`SELECT is_install_admin, status FROM ab.users WHERE email = 'bea@example.com'`))[0]).toEqual({ is_install_admin: true, status: 'active' })
    expect((await run(['list'])).out).toMatch(/bea@example\.com/)
    const actions = (await h.q<any>(`SELECT action FROM ab.audit WHERE action LIKE 'install.cli_%' ORDER BY at`)).map((x) => x.action)
    expect(actions).toEqual(['install.cli_reset_code', 'install.cli_mfa_reset', 'install.cli_make_admin'])
    expect((await run(['reset-password', 'nobody@example.com'])).code).toBe(1)
  })
})
