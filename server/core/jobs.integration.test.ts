/**
 * Guarantees of the job queue, schedules, outbox ordering, recursion guard, time budget, concurrency of formula and
 * rollup columns, environment isolation, post-commit attachment deletion, and a 10,000-job load check (PostgreSQL):
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/jobs
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { setQuiet } from './util.ts'
import { currentEnvironment, runInEnvironment } from './env-context.ts'
import { startHarness, type KernelHarness } from './kernel-testkit.ts'
import { JobError, backoffDelay, createJobQueue } from './jobs.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core jobs integration] ${SKIP_PG}\n`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('backoff', () => {
  it('is exponential, capped, with jitter between 50 % and 100 %', () => {
    const p = { kind: 'exponential' as const, baseMs: 1000, maxMs: 10_000 }
    expect(backoffDelay(1, p, () => 1)).toBe(1000)
    expect(backoffDelay(3, p, () => 1)).toBe(4000)
    expect(backoffDelay(10, p, () => 1)).toBe(10_000)
    expect(backoffDelay(3, p, () => 0)).toBe(2000)
    expect(backoffDelay(5, { kind: 'fixed', baseMs: 300, maxMs: 300 }, () => 1)).toBe(300)
  })
})

describe.skipIf(!PG_URL)('job queue and kernel guarantees (PostgreSQL)', () => {
  let h: KernelHarness
  const k = () => h.app.services.kernel
  const A = () => h.admin
  const inDefault = <T>(fn: () => Promise<T>) => runInEnvironment('default', fn)
  const drain = () => k().drain({ timeoutMs: 120_000 })
  const job = async (id: string) => (await h.q<Record<string, any>>('SELECT * FROM env_default.ab_jobs WHERE id = $1', [id]))[0]

  beforeAll(async () => {
    h = await startHarness('jobs')
    const fast = { kind: 'exponential' as const, baseMs: 5, maxMs: 20 }
    const tries = new Map<string, number>()
    k().jobs.register<{ failTimes: number; key: string }>({
      type: 'test.flaky', description: 'fails failTimes times, then succeeds', maxAttempts: 4, backoff: fast,
      handler: async (p) => {
        const n = (tries.get(p.key) ?? 0) + 1
        tries.set(p.key, n)
        if (n <= p.failTimes) throw new Error(`attempt ${n} failed`)
        return { attempts: n }
      },
    })
    k().jobs.register<{ x: number }>({ type: 'test.permanent', description: 'permanent failure', backoff: fast, handler: async () => { throw new JobError('bad input', { retry: false }) } })
    k().jobs.register<Record<string, unknown>>({ type: 'test.where', description: 'records its environment and identity', eventAllowed: true, handler: async (_p, ctx) => ({ env: currentEnvironment().id, user: ctx.user?.user.email ?? 'system' }) })
    k().jobs.register<Record<string, unknown>>({ type: 'test.noop', description: 'does nothing', concurrency: 8, handler: async () => null })
  }, 120000)

  afterAll(async () => { await h?.close() }, 60000)

  it('retries with backoff, then succeeds; dead-letters after maxAttempts; permanent errors die at once', async () => {
    const ok = await inDefault(() => k().jobs.enqueue('test.flaky', { failTimes: 2, key: 'a' }))
    const dead = await inDefault(() => k().jobs.enqueue('test.flaky', { failTimes: 10, key: 'b' }))
    const perm = await inDefault(() => k().jobs.enqueue('test.permanent', { x: 1 }))
    await drain()
    expect(await job(ok.id)).toMatchObject({ state: 'succeeded', attempts: 3, result: { attempts: 3 } })
    expect(await job(dead.id)).toMatchObject({ state: 'dead', attempts: 4 })
    expect((await job(dead.id)).error.message).toBe('attempt 4 failed')
    expect(await job(perm.id)).toMatchObject({ state: 'dead', attempts: 1 })
    expect((await job(perm.id)).error.permanent).toBe(true)
    // an administrator retries a dead job from the Jobs page
    const r = await A().post(`/admin/jobs/${dead.id}/retry`)
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.state).toBe('queued')
    const c = await A().post(`/admin/jobs/${dead.id}/cancel`)
    expect(c.data.state).toBe('cancelled')
    const audit = await h.q<{ action: string }>("SELECT action FROM env_default.ab_audit WHERE action LIKE 'job.%' ORDER BY id")
    expect(audit.map((a) => a.action)).toEqual(['job.retry', 'job.cancel'])
  }, 60000)

  it('idempotency keys enqueue once', async () => {
    const a = await inDefault(() => k().jobs.enqueue('test.noop', {}, { idempotencyKey: 'once' }))
    const b = await inDefault(() => k().jobs.enqueue('test.noop', {}, { idempotencyKey: 'once' }))
    expect(a.created).toBe(true)
    expect(b).toEqual({ id: a.id, created: false })
  })

  it('crash recovery: a job whose worker stopped heartbeating is taken back and run again', async () => {
    const j = await inDefault(() => k().jobs.enqueue('test.flaky', { failTimes: 0, key: 'crash' }))
    // another worker claimed it and died: running, locked by a ghost, heartbeat long ago
    await h.q(`UPDATE env_default.ab_jobs SET state = 'running', locked_by = 'ghost:1', attempts = 1, heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [j.id])
    expect(await inDefault(() => k().jobs.reap())).toBe(1)
    const back = await job(j.id)
    expect(back.state).toBe('failed')
    expect(back.error.message).toMatch(/stopped responding/)
    await drain()
    expect(await job(j.id)).toMatchObject({ state: 'succeeded', attempts: 2 })
  }, 60000)

  it('schedules enqueue each slot exactly once, also across a restart; misfires skip or run once', async () => {
    const s = await A().post('/admin/schedules', { name: 'Every minute', cron: '* * * * *', jobType: 'test.noop', payload: {} })
    expect(s.status, JSON.stringify(s.data)).toBe(200)
    const slot = new Date(Math.floor(Date.now() / 60000) * 60000)
    await h.q('UPDATE env_default.ab_schedules SET next_run_at = $2 WHERE id = $1', [s.data.id, slot])
    expect(await inDefault(() => k().jobs.schedulerTick())).toBe(1)
    // a restart that lost the advance of next_run_at: a second worker (new queue) sees the same slot again
    await h.q('UPDATE env_default.ab_schedules SET next_run_at = $2 WHERE id = $1', [s.data.id, slot])
    const other = createJobQueue({ db: () => h.app.services.state.db, listenSettings: () => null, environments: async () => [{ id: 'default', schema: 'env_default' }], identity: async () => null, log: () => {} }, { workerId: 'restart' })
    other.register({ type: 'test.noop', description: '', handler: async () => null })
    expect(await inDefault(() => other.schedulerTick())).toBe(0)
    const jobs = await h.q<{ n: number }>("SELECT count(*)::int AS n FROM env_default.ab_jobs WHERE idempotency_key = $1", [`sched:${s.data.id}:${slot.toISOString()}`])
    expect(jobs[0].n).toBe(1)
    // misfire: a slot an hour late; skip -> no job, next slot after now
    await A().patch(`/admin/schedules/${s.data.id}`, { misfire: 'skip' })
    const late = new Date(Date.now() - 3600_000)
    await h.q('UPDATE env_default.ab_schedules SET next_run_at = $2 WHERE id = $1', [s.data.id, late])
    expect(await inDefault(() => k().jobs.schedulerTick())).toBe(0)
    const after = (await h.q<{ next_run_at: Date }>('SELECT next_run_at FROM env_default.ab_schedules WHERE id = $1', [s.data.id]))[0]
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now())
    // run_once: one job for the missed slots
    await A().patch(`/admin/schedules/${s.data.id}`, { misfire: 'run_once' })
    await h.q('UPDATE env_default.ab_schedules SET next_run_at = $2 WHERE id = $1', [s.data.id, late])
    expect(await inDefault(() => k().jobs.schedulerTick())).toBe(1)
    // run now and disable
    expect((await A().post(`/admin/schedules/${s.data.id}/run`)).status).toBe(200)
    const off = await A().patch(`/admin/schedules/${s.data.id}`, { enabled: false })
    expect(off.data).toMatchObject({ enabled: false })
    expect(off.data.nextRunAt).toBeUndefined()
    const list = (await A().get('/admin/schedules')).data.items
    // the backup schedules (package J) are managed on the Backups page; they live in Default's schedules too
    expect(list.filter((x: any) => x.builtIn && !x.jobType.startsWith('backup.')).map((x: any) => x.jobType).sort()).toEqual(['attachments.sweep', 'audit.retention', 'collab.orphan-sweep', 'outbox.retention', 'rollup.reconcile'])
    expect((await A().post('/admin/schedules', { name: 'bad', cron: '61 * * * *', jobType: 'test.noop' })).status).toBe(422)
  }, 60000)

  it('jobs run inside their environment and as their identity; queues are isolated per environment', async () => {
    const e = await A().post('/environments', { name: 'Jobs test', type: 'sandbox' })
    expect(e.status, JSON.stringify(e.data)).toBe(200)
    const envId = e.data.id as string
    const inOther = await runInEnvironment(envId, () => k().jobs.enqueue('test.where', {}))
    const asUser = await inDefault(async () => {
      const u = (await h.app.services.meta.users.byEmail('ada@example.com'))!
      return k().jobs.enqueue('test.where', {}, { runAs: { userId: u.id } })
    })
    // the default environment's queue does not hold the other environment's job
    expect((await A().get('/admin/jobs?type=test.where')).data.items.map((j: any) => j.id)).toEqual([asUser.id])
    await drain()
    const other = (await h.q<{ result: unknown; state: string }>(`SELECT state, result FROM env_${envId}.ab_jobs WHERE id = $1`, [inOther.id]))[0]
    expect(other).toEqual({ state: 'succeeded', result: { env: envId, user: 'system' } })
    expect((await job(asUser.id)).result).toEqual({ env: 'default', user: 'ada@example.com' })
  }, 120000)

  it('outbox ids of a table follow commit order: a later writer waits for the earlier one to commit', async () => {
    const t = await A().post('/tables', { displayName: 'Ordered', name: 'Ordered', columns: [{ displayName: 'N', type: 'number' }] })
    const t2 = await A().post('/tables', { displayName: 'Other', name: 'OtherT', columns: [{ displayName: 'N', type: 'number' }] })
    const db = h.app.services.state.db!
    const ob = k().outbox
    let aId = 0
    let bId = 0
    let cId = 0
    const order: string[] = []
    const a = inDefault(() => db.tx(async () => {
      aId = await ob.write({ tableId: t.data.id, op: 'insert', rowId: 'a' })
      await sleep(400)
      order.push('a commits')
    }))
    await sleep(50)
    const b = inDefault(() => db.tx(async () => { bId = await ob.write({ tableId: t.data.id, op: 'insert', rowId: 'b' }) }).then(() => order.push('b commits')))
    // another table is not held up
    const c = inDefault(() => db.tx(async () => { cId = await ob.write({ tableId: t2.data.id, op: 'insert', rowId: 'c' }) }).then(() => order.push('c commits')))
    await Promise.all([a, b, c])
    expect(order).toEqual(['c commits', 'a commits', 'b commits'])
    expect(bId).toBeGreaterThan(aId)
    expect(cId).toBeGreaterThan(0)
    // subscribers get committed rows in id order per table
    const seen: number[] = []
    const off = ob.subscribe((e) => { if (e.tableId === t.data.id) seen.push(e.id) })
    for (let i = 0; i < 20; i++) await A().post('/data/Ordered/rows', { values: { N: i } })
    await drain()
    off()
    expect(seen.length).toBe(22) // the two rows written above, then the 20 inserts
    expect([...seen].sort((x, y) => x - y)).toEqual(seen)
  }, 60000)

  it('recursion guard: an after-event that changes its own row runs once; ping-pong between tables stops at the depth cap', async () => {
    const p = await A().post('/tables', { displayName: 'Ping', name: 'Ping', columns: [{ displayName: 'N', type: 'number' }, { displayName: 'Peer', type: 'text' }] })
    const q = await A().post('/tables', { displayName: 'Pong', name: 'Pong', columns: [{ displayName: 'N', type: 'number' }, { displayName: 'Peer', type: 'text' }] })
    const self = await A().post(`/tables/${p.data.id}/events`, { name: 'Count up', timing: 'after', operations: ['create', 'update'], actions: 'Patch(Ping, LookUp(Ping, id = New.id), {N: New.N + 1})' })
    expect(self.status, JSON.stringify(self.data)).toBe(200)
    const row = (await A().post('/data/Ping/rows', { values: { N: 0 } })).data.row.id
    await drain()
    const n = (await A().post('/data/Ping/query', { where: { col: 'id', op: 'eq', value: row } })).data.rows[0].N
    expect(n).toBe(1)
    const runs = (await A().get(`/tables/${p.data.id}/event-runs`)).data.items
    expect(runs.some((r: any) => r.status === 'skipped' && /loop guard/.test(r.message))).toBe(true)
    await A().del(`/tables/${p.data.id}/events/${self.data.event.id}`)
    // ping-pong: each table's event creates a row in the other one
    await A().post(`/tables/${p.data.id}/events`, { name: 'To pong', timing: 'after', operations: ['create'], actions: 'Collect(Pong, {N: New.N + 1})' })
    await A().post(`/tables/${q.data.id}/events`, { name: 'To ping', timing: 'after', operations: ['create'], actions: 'Collect(Ping, {N: New.N + 1})' })
    await A().post('/data/Ping/rows', { values: { N: 100 } })
    await drain()
    const pings = await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.t_ping WHERE "N" >= 100')
    const pongs = await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.t_pong WHERE "N" >= 100')
    // depth 0 (the person's row) .. depth cap 8: nine rows in all, then the chain stops and says why
    expect(pings[0].n + pongs[0].n).toBe(9)
    const skipped = await h.q<{ message: string }>("SELECT message FROM env_default.ab_event_runs WHERE status = 'skipped' AND message LIKE '%deep%'")
    expect(skipped.length).toBe(1)
  }, 120000)

  it('time budget: before-events that run too long refuse the write with a clear message', async () => {
    const t = await A().post('/tables', { displayName: 'Slow', name: 'Slow', columns: [{ displayName: 'N', type: 'number' }] })
    await A().post(`/tables/${t.data.id}/events`, { name: 'Heavy', timing: 'before', actions: 'SetField({N: CountRows(Filter(Sequence(90000), Value > 0))})' })
    const prev = process.env.APPBUILDER_EVENT_BUDGET_MS
    process.env.APPBUILDER_EVENT_BUDGET_MS = '10'
    try {
      const r = await A().post('/data/Slow/rows', { values: { N: 1 } })
      expect(r.status).toBe(422)
      expect(r.data.error.message).toMatch(/longer than/)
    } finally {
      if (prev === undefined) delete process.env.APPBUILDER_EVENT_BUDGET_MS
      else process.env.APPBUILDER_EVENT_BUDGET_MS = prev
    }
    expect((await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.t_slow'))[0].n).toBe(0)
    const ok = await A().post('/data/Slow/rows', { values: { N: 1 } })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    expect(ok.data.row.N).toBe(90000)
  }, 60000)

  it('formula and rollup columns stay correct under many parallel writers', async () => {
    const o = await A().post('/tables', { displayName: 'Baskets', name: 'Baskets', columns: [{ displayName: 'Name', type: 'text' }] })
    const l = await A().post('/tables', { displayName: 'Basket items', name: 'BasketItems', columns: [{ displayName: 'Qty', type: 'number' }, { displayName: 'Price', type: 'decimal' }, { displayName: 'Basket', name: 'Basket', type: 'lookup', lookupTable: 'Baskets' }] })
    expect((await A().post(`/tables/${l.data.id}/columns`, { displayName: 'Amount', name: 'Amount', type: 'decimal', computed: { kind: 'formula', formula: 'Qty * Price' } })).status).toBe(200)
    expect((await A().post(`/tables/${o.data.id}/columns`, { displayName: 'Total', name: 'Total', type: 'decimal', computed: { kind: 'rollup', table: 'BasketItems', via: 'Basket', fn: 'sum', column: 'Amount' } })).status).toBe(200)
    expect((await A().post(`/tables/${o.data.id}/columns`, { displayName: 'Items', name: 'Items', type: 'number', computed: { kind: 'rollup', table: 'BasketItems', via: 'Basket', fn: 'count' } })).status).toBe(200)
    const baskets: string[] = []
    for (let i = 0; i < 4; i++) baskets.push((await A().post('/data/Baskets/rows', { values: { Name: `B${i}` } })).data.row.id)
    // the worker runs while 16 writers insert, update (qty, price, basket) and delete concurrently
    h.app.services.kernel.start()
    const items: string[] = []
    const writer = async (w: number) => {
      for (let i = 0; i < 25; i++) {
        const r = await A().post('/data/BasketItems/rows', { values: { Qty: (w + i) % 7 + 1, Price: ((w * 3 + i) % 5) + 0.5, Basket: baskets[(w + i) % 4] } })
        if (r.status !== 200) throw new Error(JSON.stringify(r.data))
        items.push(r.data.row.id)
        const pick = items[(w * 31 + i * 7) % items.length]
        const op = (w + i) % 4
        if (op === 0) await A().patch(`/data/BasketItems/rows/${pick}`, { changes: { Qty: i % 9 + 1 } })
        else if (op === 1) await A().patch(`/data/BasketItems/rows/${pick}`, { changes: { Price: (i % 3) + 1.25 } })
        else if (op === 2) await A().patch(`/data/BasketItems/rows/${pick}`, { changes: { Basket: baskets[i % 4] } })
        else if (i % 5 === 0) await A().post('/data/BasketItems/delete', { ids: [pick] })
      }
    }
    await Promise.all(Array.from({ length: 16 }, (_, w) => writer(w)))
    await h.app.services.kernel.stop()
    await drain()
    const bad = await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.t_basketitems WHERE "Amount" IS DISTINCT FROM "Qty" * "Price"')
    expect(bad[0].n).toBe(0)
    const totals = await h.q<{ id: string; total: string; items: number; want_total: string; want_items: number }>(
      `SELECT b.id, b."Total"::text AS total, b."Items"::int AS items,
              COALESCE((SELECT sum(i."Amount") FROM env_default.t_basketitems i WHERE i."Basket" = b.id), 0)::text AS want_total,
              (SELECT count(*)::int FROM env_default.t_basketitems i WHERE i."Basket" = b.id) AS want_items
       FROM env_default.t_baskets b`)
    expect(totals.length).toBe(4)
    for (const t of totals) {
      expect(Number(t.total)).toBeCloseTo(Number(t.want_total), 6)
      expect(t.items).toBe(t.want_items)
    }
    expect(totals.reduce((s, t) => s + t.items, 0)).toBeGreaterThan(300)
  }, 300000)

  it('attachment files of a deleted table go only after the change commits', async () => {
    const t = await A().post('/tables', { displayName: 'Docs', name: 'Docs', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'File', type: 'file' }] })
    const row = (await A().post('/data/Docs/rows', { values: { Title: 'x' } })).data.row.id
    const up = await fetch(`${h.base}/api/v1/attachments?table=Docs&column=File&rowId=${row}&name=a.txt`, { method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: A().cookie, 'Content-Type': 'text/plain' }, body: 'hello' })
    expect(up.status).toBe(200)
    const key = (await h.q<{ k: string }>('SELECT storage_key AS k FROM env_default.ab_attachments'))[0].k
    const fs = await import('node:fs')
    const path = await import('node:path')
    const file = path.join(h.tmp, 'env', 'default', 'attachments', key.slice(0, 2), key)
    expect(fs.existsSync(file)).toBe(true)
    // a table delete that fails after the attachments were removed: everything rolls back, the file stays
    const hooks = k().hooks
    const real = hooks.deleteFilesAfterCommit
    hooks.deleteFilesAfterCommit = async (keys) => { await real(keys); throw new Error('boom after the file deletion was queued') }
    try {
      expect((await A().del(`/tables/${t.data.id}`)).status).toBe(500)
    } finally {
      hooks.deleteFilesAfterCommit = real
    }
    await drain()
    expect(fs.existsSync(file)).toBe(true)
    expect((await h.q('SELECT 1 FROM env_default.ab_attachments')).length).toBe(1)
    expect((await A().del(`/tables/${t.data.id}`)).status).toBe(200)
    expect(fs.existsSync(file)).toBe(true) // still there until the job runs
    await drain()
    expect(fs.existsSync(file)).toBe(false)
  }, 60000)

  it('load: 10,000 jobs enqueued and processed by the worker', async () => {
    const before = Number((await h.q<{ n: number }>("SELECT count(*)::int AS n FROM env_default.ab_jobs WHERE type = 'test.noop' AND state = 'succeeded'"))[0].n)
    const t0 = Date.now()
    await h.q(`INSERT INTO env_default.ab_jobs (id, type, payload, state, priority, run_at, max_attempts, created_on, modified_on)
               SELECT 'load-' || g, 'test.noop', '{}'::jsonb, 'queued', 0, now(), 3, now(), now() FROM generate_series(1, 10000) g`)
    const enqMs = Date.now() - t0
    const t1 = Date.now()
    h.app.services.kernel.start()
    for (;;) {
      const left = Number((await h.q<{ n: number }>("SELECT count(*)::int AS n FROM env_default.ab_jobs WHERE id LIKE 'load-%' AND state <> 'succeeded'"))[0].n)
      if (!left) break
      if (Date.now() - t1 > 240_000) throw new Error(`${left} jobs still left`)
      await sleep(200)
    }
    const ms = Date.now() - t1
    await h.app.services.kernel.stop()
    const after = Number((await h.q<{ n: number }>("SELECT count(*)::int AS n FROM env_default.ab_jobs WHERE type = 'test.noop' AND state = 'succeeded'"))[0].n)
    expect(after - before).toBe(10000)
    process.stdout.write(`\n[load] 10,000 jobs: inserted in ${enqMs} ms, processed in ${ms} ms = ${Math.round(10000 / (ms / 1000))} jobs/s (worker concurrency ${k().jobs.metrics ? (await inDefault(() => k().jobs.metrics())).worker.concurrency : '?'})\n`)
    const m = await A().get('/admin/jobs/metrics')
    expect(m.status).toBe(200)
    expect(m.data.states.succeeded).toBeGreaterThanOrEqual(10000)
  }, 300000)
})
