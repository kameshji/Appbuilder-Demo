/**
 * Core data model performance (P0 package N): 1,000,000 collaboration rows (600,000 comments, 400,000 activities) about
 * 100,000 records in 50 tables; timeline of one record, "my tasks", and the generic Comments query of a user whose
 * read scope is "own" on every table (the polymorphic regarding predicate with 50 branches). Median of 5 runs.
 *
 *   APPBUILDER_BENCH=1 APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/core-data-model-scale.integration.test.ts
 *
 * Results are written to the console (docs/dev/core-data-model.md quotes them). Skipped without APPBUILDER_BENCH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL } from './testdb.ts'
import { Client, startHarness } from './kernel-testkit.ts'
import type { KernelHarness } from './kernel-testkit.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { hashPassword } from './password.ts'
import type { UserRecord } from './contracts.ts'

setQuiet(true)
const RUN = !!PG_URL && process.env.APPBUILDER_BENCH === '1'
const SCALE = Number(process.env.APPBUILDER_BENCH_SCALE ?? 1) || 1
const TABLES = 50
const ROWS = Math.round(2000 * SCALE)
const COMMENTS = Math.round(600_000 * SCALE)
const ACTIVITIES = Math.round(400_000 * SCALE)

describe.skipIf(!RUN)('core data model at scale (PostgreSQL)', () => {
  let h: KernelHarness
  let bo: Client
  const tableIds: string[] = []
  let boRecord = ''
  const median = async (fn: () => Promise<unknown>, n = 5): Promise<number> => {
    const t: number[] = []
    for (let i = 0; i < n; i++) {
      const s = performance.now()
      await fn()
      t.push(performance.now() - s)
    }
    t.sort((a, b) => a - b)
    return Math.round(t[Math.floor(n / 2)]! * 10) / 10
  }

  beforeAll(async () => {
    h = await startHarness('cdmbench')
    const privileges: unknown[] = []
    for (let i = 0; i < TABLES; i++) {
      const r = await h.admin.post('/tables', { displayName: `Bench ${i}`, columns: [{ displayName: 'Title', type: 'text' }] })
      tableIds.push(r.data.id)
      privileges.push({ table: r.data.id, create: true, read: 'own', update: 'own', delete: 'own' })
    }
    const role = await h.admin.post('/roles', { name: 'Own everywhere', apps: 'all', privileges })
    await runInEnvironment('default', async () => {
      await h.app.services.meta.users.insert({ id: 'user_bo', name: 'Bo', email: 'bo@example.com', roleIds: [role.data.id], status: 'active', passwordHash: await hashPassword('member-password-1') } as UserRecord)
    })
    h.app.services.security.invalidate('all')
    bo = new Client(h.base)
    expect((await bo.post('/auth/login', { email: 'bo@example.com', password: 'member-password-1' })).status).toBe(200)
    // 100,000 records, 1 in 20 owned by Bo
    const src = new Map((await h.q<{ id: string; source: string }>('SELECT id, source FROM env_default.ab_tables')).map((r) => [r.id, r.source]))
    for (const id of tableIds) {
      await h.q(`INSERT INTO env_default.${src.get(id)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Title")
        SELECT gen_random_uuid()::text, now() - make_interval(secs => g), now(), CASE WHEN g % 20 = 0 THEN 'user_bo' ELSE 'user_x' END, CASE WHEN g % 20 = 0 THEN 'user_bo' ELSE 'user_x' END, 'row ' || g
        FROM generate_series(1, ${ROWS}) g`)
    }
    // collaboration rows about random records (through a numbered copy of the record list)
    await h.q(`CREATE TABLE public.bench_recs AS SELECT row_number() OVER () AS n, t, id, owner FROM (${tableIds.map((t) => `SELECT '${t}'::text AS t, id, owner FROM env_default.${src.get(t)}`).join(' UNION ALL ')}) v`)
    const recs = await h.q<{ t: string; id: string; owner: string }>('SELECT t, id, owner FROM public.bench_recs ORDER BY n')
    await h.q(`INSERT INTO env_default.sys_comments ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Body", "regardingTable", "regardingId")
      SELECT gen_random_uuid()::text, now() - make_interval(secs => g), now(), 'user_x', 'user_x', 'comment ' || g, r.t, r.id
      FROM generate_series(1, ${COMMENTS}) g JOIN public.bench_recs r ON r.n = 1 + (g::bigint * 7919) % ${recs.length}`)
    await h.q(`INSERT INTO env_default.sys_activities ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Type", "Subject", "Status", "DueOn", "AssignedTo", "regardingTable", "regardingId")
      SELECT gen_random_uuid()::text, now() - make_interval(secs => g), now(), 'user_x', 'user_x', 'Task', 'task ' || g, CASE WHEN g % 3 = 0 THEN 'Done' ELSE 'Open' END,
             now() + make_interval(days => g % 60), CASE WHEN g % 1000 = 0 THEN 'user_bo' ELSE 'user_x' END, r.t, r.id
      FROM generate_series(1, ${ACTIVITIES}) g JOIN public.bench_recs r ON r.n = 1 + (g::bigint * 104729) % ${recs.length}`)
    await h.q('DROP TABLE public.bench_recs')
    await h.q('ANALYZE env_default.sys_comments; ANALYZE env_default.sys_activities')
    boRecord = recs.find((r) => r.owner === 'user_bo')!.id
  }, 900_000)

  afterAll(async () => {
    await h?.close()
  }, 120_000)

  it('timeline, my tasks and the generic predicate stay fast at a million rows', async () => {
    const tl = await bo.get(`/collab/timeline?row=${boRecord}&limit=30`)
    expect(tl.status, JSON.stringify(tl.data)).toBe(200)
    const timeline = await median(() => bo.get(`/collab/timeline?row=${boRecord}&limit=30`))
    const timelineAdmin = await median(() => h.admin.get(`/collab/timeline?row=${boRecord}&limit=30`))
    const tasks = await median(() => bo.get('/collab/my-tasks'))
    const mine = (await bo.get('/collab/my-tasks')).data.items.length
    const plan = { version: 2, table: 'Comments', sort: [{ col: 'createdOn', dir: 'desc' }], page: { size: 50 }, count: true }
    const generic = await median(() => bo.post('/query', { plan }))
    const g = (await bo.post('/query', { plan })).data
    const byRecord = await median(() => bo.post('/query', { plan: { version: 2, table: 'Comments', filter: { col: 'regardingId', op: 'eq', value: boRecord }, page: { size: 50 } } }))
    const adminGeneric = await median(() => h.admin.post('/query', { plan }))
    const report = { rows: COMMENTS + ACTIVITIES, tables: TABLES, records: TABLES * ROWS, timeline, timelineAdmin, tasks, myTasks: mine, generic, genericVisible: g.count, byRecord, adminGeneric }
    process.stdout.write(`\n[core-data-model bench] ${JSON.stringify(report)}\n`)
    if (process.env.APPBUILDER_BENCH_EXPLAIN === '1') {
      const { buildSelect } = await import('../connectors/postgres/sql.ts')
      await runInEnvironment('default', async () => {
        const ctx = await h.app.services.security.forUser((await h.app.services.meta.users.get('user_bo'))!)
        for (const id of ['sys_comments']) {
          const def = (await h.app.services.meta.tables.get(id))!
          const where = id === 'sys_activities'
            ? { and: [ctx.rowPredicate(def, 'read'), { col: 'AssignedTo', op: 'eq', value: 'user_bo' }, { col: 'Status', op: 'in', value: ['Open', 'In progress'] }] }
            : ctx.rowPredicate(def, 'read')
          const st = buildSelect({ schema: 'env_default', icu: true }, def, { where: where as never, select: ['id'], top: 50, orderBy: [{ col: 'createdOn', desc: true }] } as never)
          const plan = await h.q<Record<string, string>>(`EXPLAIN ANALYZE ${st.sql}`, st.params)
          process.stdout.write(`\n--- ${id}\n${plan.map((r) => r['QUERY PLAN']).join('\n').replace(/OR \(\(\("regardingTable"[^\n]*?SubPlan \d+\)\)/g, '').slice(0, 6000)}\n`)
        }
      })
    }
    expect(timeline).toBeLessThan(500)
    expect(tasks).toBeLessThan(1000)
  }, 600_000)
})
