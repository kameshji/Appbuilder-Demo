/**
 * Phase 0 security re-check (package M; docs/internal/security-review-p0.md) against the sandbox PostgreSQL: attacks on
 * the surface Phase 0 added — environment selection, Query v2 plans and cursors, hidden-column inference, collaboration
 * links and mentions, system-table writes, the explainer, outbound hosts, API keys on admin routes, request sizes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { Client, startHarness } from './kernel-testkit.ts'
import type { KernelHarness } from './kernel-testkit.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { hashPassword } from './password.ts'
import type { UserRecord } from './contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[security-p0] ${SKIP_PG}\n`)

const PW = 'member-password-1'

describe.skipIf(!PG_URL)(PG_URL ? 'phase 0 security re-check (PostgreSQL)' : `phase 0 security re-check ${SKIP_PG}`, { timeout: 120_000 }, () => {
  let h: KernelHarness
  let ann: Client
  let ben: Client
  let deal: { id: string; name: string; source: string }
  let customer: { id: string; name: string }
  let otherEnv = ''
  let annRow = ''
  let benRow = ''
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })

  const addUser = async (id: string, email: string, roleIds: string[]): Promise<Client> => {
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id, name: id.slice(5).replace(/^./, (c) => c.toUpperCase()), email, roleIds, status: 'active', passwordHash: '' } as UserRecord))
    await h.q('UPDATE ab.users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), id])
    await h.q('INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ($1, $2, false, now()) ON CONFLICT DO NOTHING', ['default', id])
    h.app.services.security.invalidate('all')
    const c = new Client(h.base)
    expect((await c.post('/auth/login', { email, password: PW })).status).toBe(200)
    return c
  }

  beforeAll(async () => {
    h = await startHarness('secp0', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    const c = await h.admin.post('/tables', { displayName: 'Customer', columns: [{ displayName: 'Name', type: 'text' }, { displayName: 'Secret', type: 'text' }] })
    customer = c.data
    const d = await h.admin.post('/tables', { displayName: 'Deal', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Margin', type: 'number' }, { displayName: 'Customer', type: 'lookup', lookupTable: 'Customer' }] })
    deal = d.data
    const role = await h.admin.post('/roles', { name: 'Sales', apps: 'all', privileges: [
      { table: deal.id, create: true, read: 'own', update: 'own', delete: 'own', columns: { Margin: 'none' } },
      { table: customer.id, create: false, read: 'all', update: 'none', delete: 'none', columns: { Secret: 'none' } },
    ] })
    ann = await addUser('user_ann', 'ann@example.com', [role.data.id])
    ben = await addUser('user_ben', 'ben@example.com', [role.data.id])
    const cu = await h.admin.post(`/data/${customer.id}/rows`, { values: { Name: 'Acme', Secret: 'pays late' } })
    annRow = (await ann.post(`/data/${deal.id}/rows`, { values: { Title: 'Ann deal', Customer: cu.data.row.id } })).data.row.id
    benRow = (await ben.post(`/data/${deal.id}/rows`, { values: { Title: 'Ben deal', Customer: cu.data.row.id } })).data.row.id
    await h.admin.patch(`/data/${deal.id}/rows/${annRow}`, { values: { Margin: 42 } })
    const env = await h.admin.post('/environments', { name: 'Private env', type: 'sandbox' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    otherEnv = env.data.id
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('environment selection: a header or ?env= naming an environment without access is refused, never answered from another one', async () => {
    const hdr = await ann.req('GET', '/workspace')
    expect(hdr.status).toBe(200)
    ann.env = otherEnv
    try {
      expect([403, 404]).toContain((await ann.get('/workspace')).status)
      expect([403, 404]).toContain((await ann.post('/query', { plan: { version: 2, table: 'Deal' } })).status)
    } finally {
      ann.env = undefined
    }
    expect([403, 404]).toContain((await ann.get(`/workspace?env=${otherEnv}`)).status)
    // the schema name is never taken from the client: a made-up id is not an environment
    ann.env = 'default"; DROP SCHEMA env_default; --'
    try {
      expect([400, 403, 404, 422]).toContain((await ann.get('/workspace')).status)
    } finally {
      ann.env = undefined
    }
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'env_default'`))[0].n).toBe(1)
  })

  it('Query v2 plans: crafted identifiers, operators, cursors and oversized plans are 422, never SQL errors', async () => {
    const bad: unknown[] = [
      { version: 2, table: 'Deal', select: ['Title"; DROP TABLE x; --'] },
      { version: 2, table: 'Deal', filter: { col: 'Title', op: 'ilike; DROP', value: 'x' } },
      { version: 2, table: 'Deal', sort: [{ col: 'Title', dir: 'asc; DROP' }] },
      { version: 2, table: 'Deal', page: { size: 10, cursor: 'eyJrIjpbIicpOyBEUk9QIFRBQkxFIHg7IC0tIl19' } },
      { version: 2, table: 'Deal', page: { size: 10, cursor: 'not base64 at all !!!' } },
      { version: 2, table: 'Deal', page: { size: 100000 } },
      { version: 2, table: 'Deal', filter: { col: 'Title', op: 'in', value: Array.from({ length: 50_000 }, (_, i) => `v${i}`) } },
      { version: 2, table: 'Deal', aggregate: { groupBy: ['Title'], measures: [{ name: 'x"y', fn: 'count' }] } },
    ]
    for (const plan of bad) {
      const r = await ann.post('/query', { plan })
      expect([400, 413, 422], `${JSON.stringify(plan).slice(0, 120)} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`).toContain(r.status)
    }
    // deeply nested conditions: refused quickly, no stack overflow (500)
    let cond: unknown = { col: 'Title', op: 'eq', value: 'x' }
    for (let i = 0; i < 3000; i++) cond = { not: cond }
    const t0 = Date.now()
    const deep = await ann.post('/query', { plan: { version: 2, table: 'Deal', filter: cond } })
    expect([400, 413, 422]).toContain(deep.status)
    expect(Date.now() - t0).toBeLessThan(5000)
    // a cursor from another plan is refused
    const p1 = await ann.post('/query', { plan: { version: 2, table: 'Deal', sort: [{ col: 'Title', dir: 'asc' }], page: { size: 1 } } })
    expect(p1.status).toBe(200)
    if (p1.data.nextCursor) {
      const other = await ann.post('/query', { plan: { version: 2, table: 'Deal', sort: [{ col: 'createdOn', dir: 'desc' }], page: { size: 1, cursor: p1.data.nextCursor } } })
      expect(other.status).toBe(422)
    }
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.${deal.source}`))[0].n).toBe(2)
  })

  it('hidden columns cannot be inferred: filter, sort, search, group, aggregate, lookup paths all refuse them', async () => {
    const plans = [
      { version: 2, table: 'Deal', filter: { col: 'Margin', op: 'gt', value: 10 } },
      { version: 2, table: 'Deal', sort: [{ col: 'Margin', dir: 'desc' }] },
      { version: 2, table: 'Deal', search: { text: '4', columns: ['Margin'] } },
      { version: 2, table: 'Deal', aggregate: { groupBy: ['Margin'], measures: [{ name: 'n', fn: 'count' }] } },
      { version: 2, table: 'Deal', aggregate: { groupBy: [], measures: [{ name: 's', fn: 'sum', col: 'Margin' }] } },
      { version: 2, table: 'Deal', aggregate: { groupBy: [], measures: [{ name: 'n', fn: 'count', filter: { col: 'Margin', op: 'gt', value: 40 } }] } },
      { version: 2, table: 'Deal', filter: { col: 'Customer.Secret', op: 'eq', value: 'pays late' } },
    ]
    for (const plan of plans) {
      const r = await ann.post('/query', { plan })
      expect([403, 422], `${JSON.stringify(plan)} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`).toContain(r.status)
    }
    // rows: Ann sees her own deal only, also through counts and groups
    const n = await ann.post('/query', { plan: { version: 2, table: 'Deal', count: true, page: { size: 0 } } })
    expect(n.data.count).toBe(1)
    const g = await ann.post('/query', { plan: { version: 2, table: 'Deal', aggregate: { groupBy: ['Customer'], measures: [{ name: 'n', fn: 'count' }] } } })
    expect(g.data.rows.map((r: { n: number }) => r.n)).toEqual([1])
    // the v1 query route too
    expect([403, 422]).toContain((await ann.post(`/data/${deal.id}/query`, { where: { col: 'Margin', op: 'gt', value: 10 } })).status)
  })

  it('collaboration: no comment, follow or tag about a record the user cannot read; mentions of non-readers notify nobody', async () => {
    const spoof = await ann.post('/data/Comments/rows', { values: { Body: 'peek', regardingTable: deal.id, regardingId: benRow } })
    expect([403, 404, 422]).toContain(spoof.status)
    const spoof2 = await ann.post('/data/Comments/rows', { values: { Body: 'x', regardingTable: 'tbl_nope', regardingId: 'nope' } })
    expect([403, 404, 422]).toContain(spoof2.status)
    expect([403, 404, 422]).toContain((await ann.post('/collab/follow', { table: deal.id, row: benRow, follow: true })).status)
    expect([403, 404, 422]).toContain((await ann.get(`/collab/timeline?table=${deal.id}&row=${benRow}`)).status)
    // Ann mentions Ben on her own deal, which Ben cannot read: the comment is refused, Ben gets nothing
    const body = 'Margin is <span data-mention="user_ben">@Ben</span> 42, secret stuff'
    const c = await ann.post('/data/Comments/rows', { values: { Body: body, regardingTable: deal.id, regardingId: annRow } })
    expect(c.status, JSON.stringify(c.data)).toBe(422)
    await drain()
    const notes = await h.q<{ title: string; body: string | null }>(`SELECT title, body FROM ab.notifications WHERE user_id = 'user_ben'`)
    expect(notes.filter((x) => `${x.title} ${x.body ?? ''}`.includes('secret'))).toEqual([])
    // stored rich text is sanitised: no script, no event handlers, no javascript: links
    const x = await ann.post('/data/Comments/rows', { values: { Body: '<img src=x onerror=alert(1)><a href="javascript:alert(1)">l</a><script>alert(1)</script><b onclick="x">b</b>', regardingTable: deal.id, regardingId: annRow } })
    expect(x.status).toBe(200)
    const stored = (await h.q<{ Body: string }>(`SELECT "Body" FROM env_default.sys_comments WHERE id = $1`, [x.data.row.id]))[0].Body
    expect(stored).not.toMatch(/<img|onerror|javascript:|<script|onclick/i)
  })

  it('system tables: projections and logs cannot be written; Users does not leak admin-only columns', async () => {
    for (const t of ['Users', 'Roles', 'AuditEntries', 'SignInLog', 'JobRuns', 'Notifications']) {
      const r = await ann.post(`/data/${t}/rows`, { values: { FullName: 'x', Name: 'x', Title: 'x' } })
      expect([403, 404, 422], `${t}: ${r.status}`).toContain(r.status)
    }
    const u = await ann.post('/query', { plan: { version: 2, table: 'Users', select: ['FullName', 'EmployeeCode'] } })
    expect([403, 422]).toContain(u.status)
    expect((await ann.get(`/security/explain?table=${deal.id}&row=${annRow}&user=user_ben`)).status).toBe(403)
  })

  it('outbound hosts: link-local, metadata and unspecified targets are refused for connections and the SMTP relay', async () => {
    for (const host of ['169.254.169.254', 'metadata.google.internal', '0.0.0.0', '[fe80::1]', '::ffff:169.254.169.254']) {
      const r = await h.admin.post('/connections', { name: `c ${host}`, connector: 'postgres', settings: { host, database: 'x', user: 'x' }, secret: 'x' })
      expect(r.status, `${host}: ${JSON.stringify(r.data)}`).toBe(422)
    }
    const smtp = await h.admin.req('PUT', '/identity/email', { host: '169.254.169.254', port: 25, security: 'none', fromAddress: 'a@example.com', fromName: 'A' })
    expect(smtp.status, JSON.stringify(smtp.data)).toBe(422)
    expect(smtp.data.error.message).toMatch(/link-local/)
  })

  it('request sizes: an oversized JSON body is refused before it is parsed', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024)
    const r = await ann.post(`/data/${deal.id}/import`, { csv: `Title\n${big}` })
    expect(r.status).toBe(413)
  })
})
