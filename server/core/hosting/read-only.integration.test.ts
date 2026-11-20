/**
 * H-C: the read-only state over HTTP and in the job runner, against the sandbox PostgreSQL:
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/hosting
 * EVERY registered route is enumerated and requested while read-only (a route added later is refused until it is
 * classified in hosting/read-only.ts); every registered job type must be classified; exports, reads, sign-in and
 * sign-out work; a phone's offline outbox keeps a refused item waiting and sends it once writable; paused jobs and
 * schedules wait and run on resume.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SKIP_PG, PG_URL } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { runInEnvironment } from '../env-context.ts'
import { setQuiet } from '../util.ts'
import { planBody } from '../testquery.ts'
import {
  JOB_READ_ONLY, LICENCE_READ_ONLY_CODE, READ_ONLY_ALLOWED, READ_ONLY_CODE, READ_ONLY_REFUSED_GETS, readOnlyGateFor, readOnlyRefuses, setStoredReadOnly,
} from './read-only.ts'
import { configureHosting, hostingSettings } from './settings.ts'
// the phone's real offline outbox (browser code, compiled by the client project: loaded by path so the server's
// TypeScript project does not compile it under the server's rules)
const PHONE = '../../../src/phone/offline/'
type SendResult = { ok: true; result: unknown } | { ok: false; status: number; code: string; message: string }
interface SendRequest { item: { table: string }; body: { values?: Record<string, unknown> }; idempotencyKey: string }
interface OutboxLike {
  load(): Promise<void>
  setCodec(c: unknown): Promise<void>
  add(n: Record<string, unknown>): Promise<unknown>
  flush(): Promise<{ sent: number; stopped?: string }>
  list(): { status: string }[]
  count: number
}

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core/hosting read-only integration] ${SKIP_PG}\n`)

const TEST_JOB_PREFIX = 'hosting.test-'

describe.skipIf(!PG_URL)('read-only state (H-C, PostgreSQL)', () => {
  let h: KernelHarness
  let tableId = ''
  const gate = () => readOnlyGateFor(h.app.services)
  const on = async (reason: 'suspended' | 'payment' | 'maintenance' = 'suspended') => {
    await setStoredReadOnly(h.app.services.state.db!, { reason, message: 'Call the office.' })
    gate().invalidate()
  }
  const off = async () => {
    await setStoredReadOnly(h.app.services.state.db!, null)
    gate().invalidate()
  }

  beforeAll(async () => {
    h = await startHarness('ro')
    const t = await h.admin.post('/tables', { displayName: 'Ro items', name: 'RoItems', columns: [{ displayName: 'Title', type: 'text' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    tableId = t.data.id
    expect((await h.admin.post(`/data/${tableId}/rows`, { values: { Title: 'before' } })).status).toBe(200)
  }, 60_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('every route and every job type is classified, and the lists name only things that exist', () => {
    const routes = h.app.router.routes()
    const keys = new Set(routes.map((r) => r.key))
    expect(routes.length).toBeGreaterThan(300)
    expect([...READ_ONLY_ALLOWED].filter((k) => !keys.has(k)), 'allowed routes that do not exist').toEqual([])
    expect([...READ_ONLY_REFUSED_GETS].filter((k) => !keys.has(k)), 'refused GET routes that do not exist').toEqual([])
    expect([...READ_ONLY_ALLOWED].filter((k) => k.startsWith('GET ')), 'GET routes are allowed anyway').toEqual([])
    const types = h.app.services.kernel.jobs.types().map((t) => t.type).filter((t) => !t.startsWith(TEST_JOB_PREFIX))
    expect(types.filter((t) => !JOB_READ_ONLY[t]), 'job types without a read-only classification (hosting/read-only.ts JOB_READ_ONLY)').toEqual([])
    expect(Object.keys(JOB_READ_ONLY).filter((t) => !types.includes(t)), 'classified job types that are not registered').toEqual([])
  })

  it('EVERY registered route while read-only: writes refused with 503 install_read_only, the rest untouched', async () => {
    await on()
    const anon = new Client(h.base)
    const wrong: string[] = []
    let refused = 0
    for (const r of h.app.router.routes()) {
      const path = r.pattern.split('/').map((s) => (s.startsWith(':') ? 'x' : s)).join('/')
      const res = await anon.req(r.method, path, r.method === 'GET' ? undefined : {})
      const isReadOnly = res.status === 503 && res.data?.error?.code === READ_ONLY_CODE
      const shouldRefuse = readOnlyRefuses(r.method, r.key)
      if (isReadOnly !== shouldRefuse) wrong.push(`${r.key}: ${res.status} ${res.data?.error?.code ?? ''}`)
      if (shouldRefuse) refused++
    }
    expect(wrong).toEqual([])
    expect(refused).toBeGreaterThan(200)
    await off()
  }, 120_000)

  it('signed in: writes refused with the reason, reads, export, sign-out and sign-in work', async () => {
    await on()
    const A = h.admin
    const w = await A.post(`/data/${tableId}/rows`, { values: { Title: 'during' } })
    expect(w.status).toBe(503)
    expect(w.data.error.code).toBe(READ_ONLY_CODE)
    expect(w.data.error.message).toMatch(/suspended by its operator\. Call the office\. You can still sign in/)
    expect(w.data.readOnly).toMatchObject({ reason: 'suspended', since: expect.any(String) })
    expect((await A.post('/tables', { displayName: 'No', name: 'NoTable', columns: [] })).status).toBe(503)
    expect((await A.patch(`/tables/${tableId}`, { displayName: 'Renamed' })).status).toBe(503)
    // the banner's source
    const st = await A.get('/install/read-only')
    expect(st.data.readOnly).toMatchObject({ reason: 'suspended', message: 'Call the office.', source: 'cli', text: expect.stringContaining('read-only') })
    // reads: a query and the CSV of the table
    const q = await A.post('/query', planBody(tableId, { count: true }))
    expect(q.status, JSON.stringify(q.data)).toBe(200)
    expect(q.data.count).toBe(1)
    const csv = await A.get(`/tables/${tableId}/csv`)
    expect(csv.status).toBe(200)
    expect(String(csv.data)).toContain('before')
    // the data export (ZIP of CSVs): a ticket, then the download
    const ticket = await A.post('/admin/export-data/ticket', {})
    expect(ticket.status, JSON.stringify(ticket.data)).toBe(200)
    const zip = await fetch(h.base + ticket.data.url, { headers: { Cookie: A.cookie } })
    expect(zip.status).toBe(200)
    expect(zip.headers.get('content-type')).toBe('application/zip')
    // a backup now is not refused by the gate
    const b = await A.post('/backups', { scope: 'install' })
    expect(b.data?.error?.code).not.toBe(READ_ONLY_CODE)
    // sign-out and sign-in
    expect((await A.post('/auth/logout')).status).toBe(200)
    expect(A.cookie).toBe('')
    const login = await A.post('/auth/login', { email: 'ada@example.com', password: 'admin-password-1' })
    expect(login.status, JSON.stringify(login.data)).toBe(200)
    expect(A.cookie).toMatch(/^ab_session=/)
    await off()
    expect((await A.post(`/data/${tableId}/rows`, { values: { Title: 'after' } })).status).toBe(200)
  }, 60_000)

  it('one state, several causes: environment (maintenance), licence (licence_read_only), and the job runner', async () => {
    const A = h.admin
    configureHosting(h.app.services, hostingSettings({ APPBUILDER_READ_ONLY: 'maintenance' }))
    try {
      const r = await A.post(`/data/${tableId}/rows`, { values: { Title: 'x' } })
      expect(r.status).toBe(503)
      expect(r.data.error).toMatchObject({ code: READ_ONLY_CODE, message: expect.stringContaining('for maintenance') })
      expect((await A.get('/install/read-only')).data.readOnly).toMatchObject({ reason: 'maintenance', source: 'env' })
    } finally {
      configureHosting(h.app.services, hostingSettings({}))
    }
    gate().setLicence({ message: 'The licence service was last reached on 1 Nov.' })
    try {
      const r = await A.post(`/data/${tableId}/rows`, { values: { Title: 'x' } })
      expect(r.status).toBe(503)
      expect(r.data.error.code).toBe(LICENCE_READ_ONLY_CODE)
      expect(r.data.error.message).toMatch(/licence could not be verified/)
    } finally {
      gate().setLicence(null)
    }
    expect((await A.get('/install/read-only')).data.readOnly).toBeNull()
  })

  it('a phone\'s offline outbox keeps a refused item waiting and sends it once writable', async () => {
    const { MemoryKV } = await import(PHONE + 'kv.ts')
    const { codecFor, toBase64Url } = await import(PHONE + 'codec.ts')
    const { Outbox } = await import(PHONE + 'outbox.ts')
    const transport = {
      async send(r: SendRequest): Promise<SendResult> {
        const res = await fetch(`${h.base}/api/v1/data/${encodeURIComponent(r.item.table)}/rows`, {
          method: 'POST', headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', 'Idempotency-Key': r.idempotencyKey, Cookie: h.admin.cookie },
          body: JSON.stringify({ values: r.body.values ?? {} }),
        })
        const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; field?: string } } | null
        if (res.ok) return { ok: true, result: data }
        return { ok: false, status: res.status, code: data?.error?.code ?? 'storage', message: data?.error?.message ?? '' }
      },
    }
    const o = new Outbox(new MemoryKV(), transport) as OutboxLike
    await o.load()
    await o.setCodec(await codecFor(toBase64Url(new Uint8Array(32).map((_, i) => i + 7))))
    await on('payment')
    await o.add({ kind: 'create', table: tableId, rowId: 'phone-row-1', environmentId: 'default', values: { Title: 'from the phone' } })
    expect(await o.flush()).toEqual({ sent: 0, stopped: 'server' })
    expect(o.count).toBe(1)
    expect(o.list().map((i) => i.status)).toEqual(['waiting'])
    await off()
    expect(await o.flush()).toEqual({ sent: 1 })
    expect(o.count).toBe(0)
    const q = await h.admin.post('/query', planBody(tableId, { where: { col: 'Title', op: 'eq', value: 'from the phone' }, count: true }))
    expect(q.data.count).toBe(1)
  }, 30_000)

  it('jobs: paused types wait (and their schedules), the ones that run read-only run; all continue on resume', async () => {
    const jobs = h.app.services.kernel.jobs
    let ran = 0
    jobs.register({ type: `${TEST_JOB_PREFIX}write`, description: 'test: a job that would write', async handler() { ran++; return { ok: true } } })
    const ids = await runInEnvironment('default', async () => {
      const sch = await jobs.schedules.create({ name: 'ro test', intervalSeconds: 3600, jobType: `${TEST_JOB_PREFIX}write`, payload: {} }, null)
      await h.q(`UPDATE env_default.ab_schedules SET next_run_at = now() - interval '10 seconds' WHERE id = $1`, [sch.id])
      await on()
      const paused = await jobs.enqueue(`${TEST_JOB_PREFIX}write`, {})
      const runs = await jobs.enqueue('ops.heartbeat', {})
      return { sch: sch.id, paused: paused.id, runs: runs.id }
    })
    await jobs.tick()
    for (let i = 0; i < 50 && (await h.q<{ state: string }>(`SELECT state FROM env_default.ab_jobs WHERE id = $1`, [ids.runs]))[0]?.state !== 'succeeded'; i++) await new Promise((r) => setTimeout(r, 100))
    const state = async (id: string) => (await h.q<{ state: string }>(`SELECT state FROM env_default.ab_jobs WHERE id = $1`, [id]))[0]?.state
    expect(await state(ids.runs)).toBe('succeeded')
    expect(await state(ids.paused)).toBe('queued')
    expect(ran).toBe(0)
    // the schedule of a paused type did not fire: its slot is still due
    expect(await h.q(`SELECT count(*)::int AS n FROM env_default.ab_jobs WHERE type = $1`, [`${TEST_JOB_PREFIX}write`])).toEqual([{ n: 1 }])
    expect((await h.q<{ due: boolean }>(`SELECT next_run_at <= now() AS due FROM env_default.ab_schedules WHERE id = $1`, [ids.sch]))[0].due).toBe(true)
    await off()
    await runInEnvironment('default', () => jobs.schedulerTick())
    await jobs.drain({ timeoutMs: 10_000 })
    expect(await state(ids.paused)).toBe('succeeded')
    // the missed slot ran once (misfire run_once), as after downtime
    expect(ran).toBe(2)
  }, 30_000)
})
