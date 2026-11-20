/**
 * Dashboards, second wave, over HTTP against the sandbox PostgreSQL (APPBUILDER_TEST_DB) and a fake SMTP server:
 *  - view tokens: shown once, hashed, the token's "view as" identity's row and column security, every refusal (wrong,
 *    malformed, revoked, expired, another dashboard, plans sent by the client, the general API, a disabled identity, an
 *    identity that cannot open the dashboard, another environment), rate limits, a locked environment still viewing, audit;
 *  - scheduled snapshots: each recipient computed as that recipient, a PDF attached, people who cannot open the dashboard
 *    skipped with the reason in the run log, recipient rules, unsubscribe, cleanup with the dashboard;
 *  - solutions: export, plan (new / changed / removed, missing tables, unknown roles), deploy into another environment,
 *    upgrade in place, a locked production accepting deploys only, a failing import leaving nothing behind;
 *  - environment copies take dashboards and settings, never tokens or snapshots; the schema 11 -> 12 step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { hashPassword } from '../password.ts'
import type { UserRecord } from '../contracts.ts'
import { ROLE_ADMIN } from '../auth.ts'
import { startFakeSmtp, type FakeSmtp } from '../identity/fake-smtp.ts'
import type { RoleDef, TableDef } from '../../../src/platform/contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[dashboards wave 2 integration] ${SKIP_PG}\n`)

const PW = 'member-password-1'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const sys = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
] as const

const dashDef = (title: string, table = 'DshOrders') => ({
  version: 1, title, range: 'all',
  filters: [{ id: 'region', label: 'Region', column: 'Region', options: ['West', 'East'] }],
  tiles: [
    { id: 'n', title: 'Orders', kind: 'kpi', layout: { x: 0, y: 0, w: 3, h: 3 }, query: { table, measures: [{ id: 'N', fn: 'count' }] } },
    { id: 'by', title: 'By region', kind: 'bar', crossFilter: true, layout: { x: 3, y: 0, w: 9, h: 3 }, query: { table, groupBy: ['Region'], measures: [{ id: 'S', fn: 'sum', col: 'Amount' }] } },
    { id: 'sec', title: 'Secret kinds', kind: 'kpi', layout: { x: 0, y: 3, w: 12, h: 3 }, query: { table, measures: [{ id: 'D', fn: 'countDistinct', col: 'Secret' }] } },
  ],
})

describe.skipIf(!PG_URL)(PG_URL ? 'dashboards wave 2 (PostgreSQL)' : `dashboards wave 2 ${SKIP_PG}`, { timeout: 240_000 }, () => {
  let h: KernelHarness
  let smtp: FakeSmtp
  let rita: Client, walt: Client, nora: Client, mia: Client, adam: Client
  let dashId = ''
  let saId = ''
  const made: { Region: string; Amount: number; by: 'A' | 'rita' }[] = []
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })
  const mailsTo = (to: string, subject?: RegExp) => smtp.inbox.filter((m) => m.to.includes(to) && (!subject || subject.test(m.subject)))
  async function waitMail(to: string, n: number, subject?: RegExp) {
    const end = Date.now() + 30_000
    while (mailsTo(to, subject).length < n) {
      if (Date.now() > end) throw new Error(`no mail #${n} to ${to}; inbox: ${smtp.inbox.map((m) => `${m.to}:${m.subject}`).join(', ')}`)
      await drain()
      await sleep(50)
    }
    return mailsTo(to, subject)[n - 1]!
  }
  /** a client that sends only the view token (no cookie, no CSRF header) */
  const kiosk = async (token: string, method: 'GET' | 'POST', p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${h.base}/api/v1${p}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, data: (type.includes('json') ? await res.json() : await res.text()) as any, headers: res.headers }
  }
  const addUser = async (id: string, email: string, roleIds: string[]): Promise<Client> => {
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id, name: id.replace('user_', '').replace(/^./, (c) => c.toUpperCase()), email, roleIds, status: 'active', passwordHash: '' } as UserRecord))
    await h.q('UPDATE ab.users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), id])
    await h.q('INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING', ['default', id, roleIds.includes(ROLE_ADMIN)]).catch(() => undefined)
    h.app.services.security.invalidate('all')
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: PW })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }

  const orders: TableDef = {
    id: 'tbl_orders_dw2', name: 'DshOrders', displayName: 'Dsh orders', primaryColumn: 'Title', createdOn: new Date().toISOString(), modifiedOn: new Date().toISOString(),
    connectionId: 'conn_default', source: 't_orders_dw2', managed: true,
    columns: [...sys.map((c) => ({ ...c })), { name: 'Title', displayName: 'Title', type: 'text', required: true }, { name: 'Region', displayName: 'Region', type: 'text' },
      { name: 'Amount', displayName: 'Amount', type: 'currency' }, { name: 'Secret', displayName: 'Secret', type: 'text' }],
  } as TableDef

  beforeAll(async () => {
    smtp = await startFakeSmtp()
    h = await startHarness('dshw2', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    const mail = await h.admin.req('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.com', installName: 'Acme Apps', publicUrl: 'https://apps.example.com' })
    expect(mail.status, JSON.stringify(mail.data)).toBe(200)
    const meta = h.app.services.meta
    await runInEnvironment('default', async () => {
      await meta.tables.upsert(orders)
      await (await h.app.services.connections.get('conn_default')).createTable(orders)
      const roles: RoleDef[] = [
        { id: 'role_rep_dw2', name: 'Rep', apps: 'all', privileges: [{ table: orders.id, create: true, read: 'own', update: 'own', delete: 'own', columns: { Secret: 'none' } }] },
        { id: 'role_west_dw2', name: 'West', apps: [], privileges: [{ table: orders.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ column: 'Region', op: 'eq', value: 'West' }] }] },
        { id: 'role_kiosk_dw2', name: 'Kiosk', apps: [], privileges: [{ table: orders.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ column: 'Region', op: 'eq', value: 'West' }] }] },
        { id: 'role_other_dw2', name: 'Other', apps: [], privileges: [] },
        { id: 'role_maker_dw2', name: 'Dash makers', isMaker: true, apps: 'all', privileges: [{ table: orders.id, create: true, read: 'all', update: 'all', delete: 'all' }] } as RoleDef,
      ]
      for (const r of roles) await meta.roles.upsert(r)
    })
    rita = await addUser('user_rita_dw2', 'rita@example.com', ['role_rep_dw2'])
    walt = await addUser('user_walt_dw2', 'walt@example.com', ['role_west_dw2'])
    nora = await addUser('user_nora_dw2', 'nora@example.com', ['role_other_dw2'])
    mia = await addUser('user_mia_dw2', 'mia@example.com', ['role_maker_dw2'])
    adam = await addUser('user_adam_dw2', 'adam@example.com', [ROLE_ADMIN])
    const regions = ['West', 'East', 'West', 'North']
    for (let i = 0; i < 16; i++) {
      const by = i % 4 === 0 ? 'rita' : 'A'
      const v = { Title: `Order ${i}`, Region: regions[i % 4]!, Amount: 100 + i, ...(by === 'A' ? { Secret: `s${i % 3}` } : {}) }
      const r = await (by === 'rita' ? rita : h.admin).post('/data/DshOrders/rows', { values: v })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      made.push({ Region: v.Region, Amount: v.Amount, by })
    }
    const sa = await h.admin.post('/identity/service-accounts', { name: 'Hall screen', environmentId: 'default', roleIds: ['role_kiosk_dw2'] })
    expect(sa.status, JSON.stringify(sa.data)).toBe(200)
    saId = sa.data.id
    const d = await h.admin.post('/dashboards', { def: dashDef('Order board'), roles: ['role_rep_dw2', 'role_kiosk_dw2'] })
    expect(d.status, JSON.stringify(d.data)).toBe(200)
    dashId = d.data.id
  }, 240_000)

  afterAll(async () => {
    await h?.close()
    await smtp?.close()
  }, 60_000)

  /* ---------------------------------------------------------------- view tokens */

  let creatorToken = ''
  let serviceToken = ''

  it('owners and administrators create tokens; the secret is shown once and stored only as a hash; audited', async () => {
    expect((await rita.post(`/dashboards/${dashId}/tokens`, { label: 'Mine' })).status).toBe(403)
    expect((await nora.post(`/dashboards/${dashId}/tokens`, { label: 'x' })).status).toBe(404)
    expect((await h.admin.post(`/dashboards/${dashId}/tokens`, {})).status).toBe(422)
    const c = await h.admin.post(`/dashboards/${dashId}/tokens`, { label: 'Office TV' })
    expect(c.status, JSON.stringify(c.data)).toBe(200)
    expect(c.data).toMatchObject({ label: 'Office TV', status: 'active', viewAs: { kind: 'creator' }, expiresOn: null })
    expect(c.data.warnings.join(' ')).toMatch(/administrator you see every row/)
    creatorToken = c.data.token
    // a service account: administrators only, and it must be able to open the dashboard
    const mine = await mia.post('/dashboards', { def: dashDef('Mia board') })
    expect((await mia.post(`/dashboards/${mine.data.id}/tokens`, { label: 'x', viewAs: { serviceAccount: saId } })).status).toBe(403)
    expect((await h.admin.post(`/dashboards/${mine.data.id}/tokens`, { label: 'x', viewAs: { serviceAccount: saId } })).status).toBe(422)
    expect((await h.admin.post(`/dashboards/${dashId}/tokens`, { label: 'x', viewAs: { serviceAccount: 'user_rita_dw2' } })).status).toBe(422)
    const s = await h.admin.post(`/dashboards/${dashId}/tokens`, { label: 'Hall screen', viewAs: { serviceAccount: saId }, expiresOn: new Date(Date.now() + 86_400_000).toISOString() })
    expect(s.status, JSON.stringify(s.data)).toBe(200)
    expect(s.data.viewAs).toMatchObject({ kind: 'service', userId: saId, name: 'Hall screen' })
    serviceToken = s.data.token
    // the list never carries the secret or its hash; the database holds only the hash
    const list = await h.admin.get(`/dashboards/${dashId}/tokens`)
    expect(list.data.items).toHaveLength(2)
    const text = JSON.stringify(list.data)
    expect(text).not.toContain(serviceToken.split('.')[3])
    expect(text).not.toMatch(/secret|hash/i)
    const rows = await h.q<{ secret_hash: string }>('SELECT secret_hash FROM env_default.ab_dashboard_tokens')
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.secret_hash))).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(serviceToken.split('.')[3])
    const audit = await h.q<{ action: string; details: unknown }>(`SELECT action, details FROM env_default.ab_audit WHERE action LIKE 'dashboard.token.%' ORDER BY id`)
    expect(audit.map((a) => a.action)).toEqual(['dashboard.token.create', 'dashboard.token.create', 'dashboard.token.run_as_service'])
    expect(JSON.stringify(audit)).not.toContain(serviceToken.split('.')[3])
    expect(JSON.stringify(audit)).not.toContain(creatorToken.split('.')[3])
  })

  it('a token reads its dashboard and runs its tiles as the "view as" identity (row and column security)', async () => {
    const g = await kiosk(serviceToken, 'GET', '/dashboards/kiosk')
    expect(g.status, JSON.stringify(g.data)).toBe(200)
    expect(g.data).toMatchObject({ dashboard: { id: dashId, name: 'Order board' }, token: { label: 'Hall screen', viewAs: 'service' }, environmentId: 'default' })
    expect(g.data.settings.timeZone).toBe('Asia/Kolkata')
    const q = await kiosk(serviceToken, 'POST', '/dashboards/kiosk/query', {})
    expect(q.status, JSON.stringify(q.data)).toBe(200)
    const by = Object.fromEntries(q.data.results.map((r: any) => [r.id, r]))
    const west = made.filter((m) => m.Region === 'West')
    expect(by['n:main'].rows[0].N).toBe(west.length)
    expect(by['n:main'].filtered).toBe(true)
    // the same as Walt (same row rule) sees through the general endpoint
    const walts = await walt.post('/dashboards/query', { queries: [{ id: 'x', plan: { version: 2, table: 'DshOrders', aggregate: { groupBy: [], measures: [{ name: 'N', fn: 'count' }] } } }] })
    expect(walts.data.results[0].rows[0].N).toBe(west.length)
    // the creator token shows what the administrator sees
    const all = await kiosk(creatorToken, 'POST', '/dashboards/kiosk/query', { filters: { region: 'East' } })
    const n = all.data.results.find((r: any) => r.id === 'n:main')
    expect(n.rows[0].N).toBe(made.filter((m) => m.Region === 'East').length)
    expect(n.filtered).toBeFalsy()
    // a cross-filter from the tile that allows it
    const cr = await kiosk(creatorToken, 'POST', '/dashboards/kiosk/query', { cross: { tileId: 'by', column: 'Region', value: 'North' } })
    expect(cr.data.results.find((r: any) => r.id === 'n:main').rows[0].N).toBe(made.filter((m) => m.Region === 'North').length)
  })

  it('refuses: wrong, malformed, other dashboards, client plans, bad choices, the general API, another environment', async () => {
    const forged = serviceToken.slice(0, -4) + (serviceToken.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    for (const t of [forged, 'abv.default.ZZZZZZZZ.' + 'a'.repeat(43), 'garbage', '']) {
      const r = await kiosk(t, 'GET', '/dashboards/kiosk')
      expect(r.status, t).toBe(401)
      expect(JSON.stringify(r.data)).not.toContain(serviceToken)
    }
    const other = (await h.admin.get('/dashboards')).data.items.find((x: any) => x.id !== dashId).id
    expect((await kiosk(serviceToken, 'POST', '/dashboards/kiosk/query', { dashboardId: other })).status).toBe(404)
    expect((await kiosk(serviceToken, 'POST', '/dashboards/kiosk/query', { queries: [{ id: 'q', plan: { version: 2, table: 'ab_users', aggregate: { groupBy: [], measures: [{ name: 'N', fn: 'count' }] } } }] })).status).toBe(422)
    expect((await kiosk(serviceToken, 'POST', '/dashboards/kiosk/query', { plan: { version: 2, table: 'Users' } })).status).toBe(422)
    expect((await kiosk(serviceToken, 'POST', '/dashboards/kiosk/query', { filters: { region: 'Mars' } })).status).toBe(422)
    expect((await kiosk(serviceToken, 'POST', '/dashboards/kiosk/query', { filters: { Secret: 's1' } })).status).toBe(422)
    expect((await kiosk(serviceToken, 'POST', '/dashboards/kiosk/query', { cross: { tileId: 'n', column: 'Secret', value: 's1' } })).status).toBe(422)
    // the token is not a session or an API key anywhere else
    for (const [m, p, b] of [['POST', '/dashboards/query', { queries: [{ id: 'q', plan: { version: 2, table: 'DshOrders' } }] }], ['POST', '/data/DshOrders/rows', { values: { Title: 'via token' } }], ['GET', '/auth/session', undefined], ['GET', `/dashboards/${dashId}`, undefined], ['GET', `/dashboards/${dashId}/tokens`, undefined]] as const) {
      expect((await kiosk(serviceToken, m, p, b)).status, p).toBe(401)
    }
    // another environment named by the request
    expect((await kiosk(serviceToken, 'GET', '/dashboards/kiosk', undefined, { 'X-Appbuilder-Environment': 'other_env' })).status).toBe(403)
  })

  it('revoked and expired tokens stop at once; revoking is audited', async () => {
    const t = await h.admin.post(`/dashboards/${dashId}/tokens`, { label: 'Temporary' })
    expect((await kiosk(t.data.token, 'GET', '/dashboards/kiosk')).status).toBe(200)
    expect((await rita.del(`/dashboards/${dashId}/tokens/${t.data.id}`)).status).toBe(403)
    expect((await h.admin.del(`/dashboards/${dashId}/tokens/${t.data.id}`)).status).toBe(200)
    expect((await kiosk(t.data.token, 'GET', '/dashboards/kiosk')).status).toBe(401)
    expect((await kiosk(t.data.token, 'POST', '/dashboards/kiosk/query', {})).status).toBe(401)
    expect((await h.admin.get(`/dashboards/${dashId}/tokens`)).data.items.find((x: any) => x.id === t.data.id).status).toBe('revoked')
    expect((await h.q(`SELECT 1 FROM env_default.ab_audit WHERE action = 'dashboard.token.revoke' AND details->>'id' = $1`, [t.data.id])).length).toBe(1)
    const e = await h.admin.post(`/dashboards/${dashId}/tokens`, { label: 'Expiring' })
    expect((await kiosk(e.data.token, 'GET', '/dashboards/kiosk')).status).toBe(200)
    await h.q(`UPDATE env_default.ab_dashboard_tokens SET expires_on = now() - interval '1 second' WHERE id = $1`, [e.data.id])
    expect((await kiosk(e.data.token, 'GET', '/dashboards/kiosk')).status).toBe(401)
    expect((await h.admin.post(`/dashboards/${dashId}/tokens`, { label: 'Past', expiresOn: '2020-01-01T00:00:00Z' })).status).toBe(422)
  })

  it('a disabled identity stops its tokens (service account and person); an identity that loses the dashboard too', async () => {
    const at = await adam.post(`/dashboards/${dashId}/tokens`, { label: 'Adam TV' })
    expect(at.status, JSON.stringify(at.data)).toBe(200)
    expect((await kiosk(at.data.token, 'GET', '/dashboards/kiosk')).status).toBe(200)
    await runInEnvironment('default', () => h.app.services.meta.users.update('user_adam_dw2', { status: 'disabled' }))
    expect((await kiosk(at.data.token, 'POST', '/dashboards/kiosk/query', {})).status).toBe(401)
    expect((await h.admin.req('PATCH', `/identity/service-accounts/${saId}`, { status: 'disabled' })).status).toBe(200)
    expect((await kiosk(serviceToken, 'GET', '/dashboards/kiosk')).status).toBe(401)
    expect((await h.admin.req('PATCH', `/identity/service-accounts/${saId}`, { status: 'active' })).status).toBe(200)
    expect((await kiosk(serviceToken, 'GET', '/dashboards/kiosk')).status).toBe(200)
    // the dashboard no longer lists the service account's role: its token stops
    expect((await h.admin.req('PATCH', `/dashboards/${dashId}`, { roles: ['role_rep_dw2'] })).status).toBe(200)
    expect((await kiosk(serviceToken, 'GET', '/dashboards/kiosk')).status).toBe(403)
    expect((await h.admin.req('PATCH', `/dashboards/${dashId}`, { roles: ['role_rep_dw2', 'role_kiosk_dw2'] })).status).toBe(200)
    expect((await kiosk(serviceToken, 'GET', '/dashboards/kiosk')).status).toBe(200)
  })

  it('a locked production environment still shows token dashboards (and tokens can still be revoked)', async () => {
    expect((await h.admin.req('PATCH', '/environments/default', { locked: true })).status).toBe(200)
    try {
      expect((await h.admin.req('PATCH', `/dashboards/${dashId}`, { name: 'x' })).status).toBe(403)
      expect((await kiosk(serviceToken, 'GET', '/dashboards/kiosk')).status).toBe(200)
      const q = await kiosk(serviceToken, 'POST', '/dashboards/kiosk/query', {})
      expect(q.status).toBe(200)
      expect(q.data.results.find((r: any) => r.id === 'n:main').ok).toBe(true)
    } finally {
      expect((await h.admin.req('PATCH', '/environments/default', { locked: false })).status).toBe(200)
    }
  })

  it('rate-limits each token', async () => {
    const t = await h.admin.post(`/dashboards/${dashId}/tokens`, { label: 'Busy' })
    let limited: any = null
    for (let i = 0; i < 130 && !limited; i++) {
      const r = await kiosk(t.data.token, 'GET', '/dashboards/kiosk')
      if (r.status === 429) limited = r
      else expect(r.status).toBe(200)
    }
    expect(limited, 'no 429 after 130 requests').toBeTruthy()
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // other tokens are not affected
    expect((await kiosk(serviceToken, 'GET', '/dashboards/kiosk')).status).toBe(200)
    await h.admin.del(`/dashboards/${dashId}/tokens/${t.data.id}`)
  })

  /* ---------------------------------------------------------------- snapshots */

  it('snapshots: every recipient gets the dashboard computed as themselves; people who cannot open it get nothing', async () => {
    // recipient rules: someone who is not a maker subscribes only themselves
    expect((await rita.post(`/dashboards/${dashId}/snapshots`, { schedule: { frequency: 'manual' }, recipients: { userIds: ['user_walt_dw2'], teamIds: [] } })).status).toBe(403)
    expect((await walt.post(`/dashboards/${dashId}/snapshots`, { schedule: { frequency: 'manual' } })).status).toBe(404)
    expect((await h.admin.post(`/dashboards/${dashId}/snapshots`, { schedule: { frequency: 'manual' }, filters: { region: 'Mars' } })).status).toBe(422)
    const s = await h.admin.post(`/dashboards/${dashId}/snapshots`, { name: 'Daily orders', schedule: { frequency: 'manual' }, recipients: { userIds: ['user_rita_dw2', 'user_walt_dw2', 'user_nora_dw2', 'user_mia_dw2'], teamIds: [] } })
    expect(s.status, JSON.stringify(s.data)).toBe(200)
    const before = smtp.inbox.length
    expect((await h.admin.post(`/dashboards/snapshots/${s.data.id}/run`)).status).toBe(200)
    const toRita = await waitMail('rita@example.com', 1, /Order board/)
    const toMia = await waitMail('mia@example.com', 1, /Order board/)
    for (const m of [toRita, toMia]) {
      expect(m.attachments).toHaveLength(1)
      expect(m.attachments[0]!.contentType).toBe('application/pdf')
      expect(m.attachments[0]!.content.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(m.html).toContain('https://apps.example.com/#u-dashboards?d=')
    }
    // computed as the recipient: Rita may not see the Secret column, so that tile fails in her copy only
    expect(toRita.html).toMatch(/1 tile could not be shown: Secret kinds/)
    expect(toMia.html).not.toMatch(/could not be shown/)
    await drain()
    expect(smtp.inbox.slice(before).filter((m) => m.to.includes('walt@example.com') || m.to.includes('nora@example.com'))).toHaveLength(0)
    const runs = (await h.admin.get(`/dashboards/snapshots/${s.data.id}/runs`)).data.items
    expect(runs[0]).toMatchObject({ status: 'succeeded', message: '2 sent, 2 skipped, 0 failed' })
    const rec = Object.fromEntries((runs[0].recipients as any[]).map((r) => [r.userId, r]))
    expect(rec.user_walt_dw2).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/cannot open the dashboard/) })
    expect(rec.user_nora_dw2).toMatchObject({ status: 'skipped' })
    expect(rec.user_rita_dw2).toMatchObject({ status: 'sent' })
    // a recipient sees only their own line and may run only their own copy
    const ritaRuns = (await rita.get(`/dashboards/snapshots/${s.data.id}/runs`)).data.items
    expect(ritaRuns[0].recipients.map((r: any) => r.userId)).toEqual(['user_rita_dw2'])
    expect((await rita.req('PATCH', `/dashboards/snapshots/${s.data.id}`, { name: 'x' })).status).toBe(403)
    // unsubscribe from the email's signed link (no sign-in)
    const link = /https:\/\/apps\.example\.com(\/api\/v1\/dashboards\/snapshots\/unsubscribe\?t=[^"&<\s]+)/.exec(toRita.html)![1]!
    const page = await fetch(h.base + link.replace(/&amp;/g, '&'))
    expect(page.status).toBe(200)
    const t = new URL('http://x' + link).searchParams.get('t')!
    const un = await fetch(`${h.base}/api/v1/dashboards/snapshots/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `t=${encodeURIComponent(t)}` })
    expect(un.status).toBe(200)
    const tampered = await fetch(`${h.base}/api/v1/dashboards/snapshots/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `t=${encodeURIComponent(t.slice(0, -2) + 'xx')}` })
    expect(tampered.status).toBe(400)
    expect((await h.admin.post(`/dashboards/snapshots/${s.data.id}/run`)).status).toBe(200)
    await waitMail('mia@example.com', 2, /Order board/)
    expect(mailsTo('rita@example.com', /Order board/)).toHaveLength(1)
    const audit = (await h.q<{ action: string }>(`SELECT action FROM env_default.ab_audit WHERE action LIKE 'dashboard.snapshot.%' ORDER BY id`)).map((a) => a.action)
    expect(audit).toEqual(expect.arrayContaining(['dashboard.snapshot.create', 'dashboard.snapshot.run']))
  })

  it('a scheduled snapshot has a schedule; deleting the dashboard removes its snapshots, schedules and tokens', async () => {
    const d = await h.admin.post('/dashboards', { def: dashDef('Short-lived') })
    const s = await h.admin.post(`/dashboards/${d.data.id}/snapshots`, { schedule: { frequency: 'daily', time: '07:30', timeZone: 'Asia/Kolkata' } })
    expect(s.status, JSON.stringify(s.data)).toBe(200)
    expect(s.data.scheduleText).toMatch(/Asia\/Kolkata/)
    expect(s.data.nextRunAt).toBeTruthy()
    const sid = (await h.q<{ schedule_id: string }>('SELECT schedule_id FROM env_default.ab_dashboard_snapshots WHERE id = $1', [s.data.id]))[0]!.schedule_id
    expect((await h.q('SELECT 1 FROM env_default.ab_schedules WHERE id = $1', [sid])).length).toBe(1)
    await h.admin.post(`/dashboards/${d.data.id}/tokens`, { label: 'gone soon' })
    expect((await h.admin.del(`/dashboards/${d.data.id}`)).status).toBe(200)
    expect((await h.q('SELECT 1 FROM env_default.ab_schedules WHERE id = $1', [sid])).length).toBe(0)
    expect((await h.q('SELECT 1 FROM env_default.ab_dashboard_snapshots WHERE dashboard_id = $1', [d.data.id])).length).toBe(0)
    expect((await h.q('SELECT 1 FROM env_default.ab_dashboard_tokens WHERE dashboard_id = $1', [d.data.id])).length).toBe(0)
  })

  /* ---------------------------------------------------------------- solutions and environment copies */

  it('solutions: dashboards travel, the plan says what changes, deploys upgrade in place, a locked production accepts deploys only', async () => {
    const A = h.admin
    const ghost = await A.post('/dashboards', { def: dashDef('Ghost tables', 'NoSuchTable') })
    const sol = await A.post('/solutions', { displayName: 'Order dashboards' })
    for (const [kind, id] of [['table', orders.id], ['role', 'role_rep_dw2'], ['dashboard', dashId], ['dashboard', ghost.data.id]]) {
      const r = await A.post(`/solutions/${sol.data.id}/components`, { kind, id })
      expect(r.status, `${kind} ${JSON.stringify(r.data)}`).toBe(200)
    }
    expect((await A.post(`/solutions/${sol.data.id}/components`, { kind: 'dashboard', id: 'dsh_nope' })).status).toBe(404)
    const pkgYaml = (await A.get(`/solutions/${sol.data.id}/package`)).data.yaml as string
    const doc = yaml.load(pkgYaml) as any
    expect(doc.dashboards.map((x: any) => x.name).sort()).toEqual(['Ghost tables', 'Order board'])
    expect(doc.dashboards.find((x: any) => x.id === dashId).roles).toEqual([{ id: 'role_rep_dw2', name: 'Rep' }, { id: 'role_kiosk_dw2', name: 'Kiosk' }])
    expect(pkgYaml).not.toMatch(/abv\.|ab_dashboard_tokens|snapshot/i)
    const env = await A.post('/environments', { name: 'Dash prod', type: 'production' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const target = env.data.id as string
    const T = new Client(h.base)
    T.cookie = A.cookie
    T.env = target
    const plan = (await A.post(`/solutions/${sol.data.id}/deploy`, { target, plan: true })).data
    expect(plan.items.filter((i: any) => i.kind === 'dashboard').map((i: any) => [i.name, i.change]).sort()).toEqual([['Ghost tables', 'new'], ['Order board', 'new']])
    const warn = plan.warnings.join(' ')
    expect(warn).toMatch(/"Ghost tables" reads the table NoSuchTable, which is not here/)
    expect(warn).toMatch(/viewer role "Kiosk", which is not here/)
    expect(warn).not.toMatch(/"Order board" reads/)
    const dep = await A.post(`/solutions/${sol.data.id}/deploy`, { target })
    expect(dep.status, JSON.stringify(dep.data)).toBe(200)
    const there = await T.get(`/dashboards/${dashId}`)
    expect(there.status, JSON.stringify(there.data)).toBe(200)
    expect(there.data).toMatchObject({ name: 'Order board', roles: ['role_rep_dw2'] })
    expect(there.data.def.tiles.map((t: any) => t.id)).toEqual(['n', 'by', 'sec'])
    // the tiles run there (the table came with the solution)
    const q = await T.post('/dashboards/query', { queries: [{ id: 'n', plan: { version: 2, table: 'DshOrders', aggregate: { groupBy: [], measures: [{ name: 'N', fn: 'count' }] } } }] })
    expect(q.data.results[0].ok, JSON.stringify(q.data)).toBe(true)
    // unchanged when deployed again; changed after an edit at the source
    const again = (await A.post(`/solutions/${sol.data.id}/deploy`, { target, plan: true })).data
    expect(again.items.find((i: any) => i.kind === 'dashboard' && i.id === dashId).change).toBe('unchanged')
    // lock the target: direct edits are refused, deploys still upgrade
    expect((await T.req('PATCH', `/environments/${target}`, { locked: true })).status).toBe(200)
    expect((await T.req('PATCH', `/dashboards/${dashId}`, { name: 'Edited there' })).status).toBe(403)
    expect((await T.post('/dashboards', { def: dashDef('Direct') })).status).toBe(403)
    expect((await A.req('PATCH', `/dashboards/${dashId}`, { name: 'Order board v2' })).status).toBe(200)
    await A.req('PATCH', `/solutions/${sol.data.id}`, { version: '1.1.0' })
    const up = (await A.post(`/solutions/${sol.data.id}/deploy`, { target, plan: true })).data
    expect(up.mode).toBe('upgrade')
    expect(up.items.find((i: any) => i.kind === 'dashboard' && i.id === dashId)).toMatchObject({ change: 'changed' })
    const upd = await A.post(`/solutions/${sol.data.id}/deploy`, { target, confirm: up.token, proceedWithoutBackup: true })
    expect(upd.status, JSON.stringify(upd.data)).toBe(200)
    expect((await T.get(`/dashboards/${dashId}`)).data).toMatchObject({ name: 'Order board v2', ownerId: there.data.ownerId })
    // removed from the solution: the upgrade removes it there (with its tokens)
    await h.q(`INSERT INTO "env_${target}".ab_dashboard_tokens (id, dashboard_id, label, prefix, secret_hash, view_as, view_as_kind, created_by, created_on) VALUES ('dvt_t1', $1, 'x', 'Prefix01', 'h', 'u', 'creator', 'u', now())`, [ghost.data.id])
    await A.del(`/solutions/${sol.data.id}/components/dashboard/${ghost.data.id}`)
    const rm = (await A.post(`/solutions/${sol.data.id}/deploy`, { target, plan: true })).data
    expect(rm.items.find((i: any) => i.kind === 'dashboard' && i.id === ghost.data.id)).toMatchObject({ change: 'removed' })
    expect((await A.post(`/solutions/${sol.data.id}/deploy`, { target, confirm: rm.token, proceedWithoutBackup: true })).status).toBe(200)
    expect((await T.get(`/dashboards/${ghost.data.id}`)).status).toBe(404)
    expect((await h.q(`SELECT 1 FROM "env_${target}".ab_dashboard_tokens WHERE dashboard_id = $1`, [ghost.data.id])).length).toBe(0)
    expect((await T.req('PATCH', `/environments/${target}`, { locked: false })).status).toBe(200)

    // a failing import leaves nothing behind: a new table and a good dashboard are applied before a bad one fails
    const bad = yaml.load(pkgYaml) as any
    bad.solution.id = 'sol_dsh_fail'
    bad.solution.name = 'DashFail'
    bad.solution.displayName = 'Dash fail'
    const t0 = JSON.parse(JSON.stringify(bad.tables[0]))
    t0.schema.id = 'tbl_dsh_fail'
    t0.schema.name = 'DshFail'
    t0.schema.displayName = 'Dsh fail'
    bad.tables = [t0]
    bad.roles = []
    bad.dashboards = [
      { id: 'dsh_fail_ok', name: 'Fine', def: dashDef('Fine', 'DshFail'), roles: [] },
      { id: 'dsh_fail_bad', name: 'Broken', def: dashDef('Broken\u0000title', 'DshFail'), roles: [] },
    ]
    const r = await T.post('/solutions/import', { yaml: JSON.stringify(bad) })
    // refused by PostgreSQL while the dashboards are written (jsonb has no NUL), i.e. after the table and the first dashboard
    expect(r.status, JSON.stringify(r.data)).toBe(422)
    expect(r.data.error.message).toMatch(/does not fit/)
    expect((await T.get('/dashboards/dsh_fail_ok')).status).toBe(404)
    expect((await h.q(`SELECT 1 FROM "env_${target}".ab_tables WHERE id = 'tbl_dsh_fail'`)).length).toBe(0)
    expect((await h.q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`"env_${target}"."t_dshfail"`]))[0]).toEqual({ ok: false })
    expect((await h.q(`SELECT 1 FROM "env_${target}".ab_solutions WHERE id = 'sol_dsh_fail'`)).length).toBe(0)
  })

  it('environment copies take dashboards and their settings, never tokens or snapshots', async () => {
    expect((await h.admin.req('PUT', '/dashboards/settings', { settings: { fiscalYearStart: 1 } })).status).toBe(200)
    const env = await h.admin.post('/environments', { name: 'Dash copy', type: 'sandbox', copyFrom: 'default' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const C = new Client(h.base)
    C.cookie = h.admin.cookie
    C.env = env.data.id
    const list = (await C.get('/dashboards')).data.items
    expect(list.find((x: any) => x.id === dashId)).toMatchObject({ name: 'Order board v2', roles: ['role_rep_dw2', 'role_kiosk_dw2'] })
    expect((await C.get('/dashboards/settings')).data.settings.fiscalYearStart).toBe(1)
    const schema = `env_${env.data.id}`
    for (const t of ['ab_dashboard_tokens', 'ab_dashboard_snapshots', 'ab_dashboard_snapshot_runs']) {
      expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema}"."${t}"`))[0]!.n, t).toBe(0)
    }
    // a token of Default does not open the copy's dashboard (another environment)
    expect((await kiosk(serviceToken, 'GET', '/dashboards/kiosk', undefined, { 'X-Appbuilder-Environment': env.data.id })).status).toBe(403)
  })

  it('schema 11 -> 12: the token and snapshot tables appear, dashboards are kept', async () => {
    const before = (await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.ab_dashboards'))[0]!.n
    await h.q('DROP TABLE env_default.ab_dashboard_tokens, env_default.ab_dashboard_snapshots, env_default.ab_dashboard_snapshot_runs')
    await h.q(`UPDATE ab.environments SET schema_version = 11 WHERE id = 'default'`)
    const { migrateEnvironmentSchema, SCHEMA_VERSION } = await import('../meta-store.ts')
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(12)
    expect(await migrateEnvironmentSchema(h.app.services.state.db!, { id: 'default', schema: 'env_default' })).toEqual({ from: 11, to: SCHEMA_VERSION })
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name IN ('ab_dashboard_tokens', 'ab_dashboard_snapshots', 'ab_dashboard_snapshot_runs')`))[0]!.n).toBe(3)
    expect((await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.ab_dashboards'))[0]!.n).toBe(before)
    // the old tokens went with the dropped table: they no longer open anything
    expect((await kiosk(serviceToken, 'GET', '/dashboards/kiosk')).status).toBe(401)
  })

  it('too many invalid tokens from one address are throttled (last: it blocks this address for minutes)', async () => {
    let last = 0
    for (let i = 0; i < 32; i++) last = (await kiosk(`abv.default.Wrong${String(i).padStart(3, '0')}.${'b'.repeat(43)}`, 'GET', '/dashboards/kiosk')).status
    expect(last).toBe(429)
  })
})
