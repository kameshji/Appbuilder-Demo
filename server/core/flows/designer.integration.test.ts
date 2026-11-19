/**
 * The server side of the flow designer (P1 package B) on PostgreSQL: the draft of a flow (saved, read, discarded,
 * cleared by publishing; only editors; new connection references need "use" access), the schedule preview, the
 * catalogue's approvals flag, and every template of the "New flow" gallery created through the API.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/flows/designer
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { guessParams, instantiate, type FlowTemplate } from '../../../src/flows/designer/templateKit.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core/flows designer] ${SKIP_PG}\n`)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('flow designer API (PostgreSQL)', () => {
  let h: KernelHarness
  const A = () => h.admin
  const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
  let maker: Client

  beforeAll(async () => {
    h = await startHarness('flowsdesigner')
    for (const t of [
      { displayName: 'Purchase requests', name: 'PurchaseRequests', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Requester', type: 'text' }, { displayName: 'Manager', type: 'text' }, { displayName: 'Status', type: 'text' }, { displayName: 'Due', type: 'date' }] },
      { displayName: 'Archive', name: 'Archive', columns: [{ displayName: 'Name', type: 'text' }] },
    ]) expect((await A().post('/tables', t)).status).toBe(200)
    const u = await A().post('/users', { name: 'Mia Maker', email: 'mia@example.com', roleIds: ['role_maker'], password: 'some-password-1' })
    expect(u.status).toBe(200)
    await h.app.services.meta.users.update(u.data.id, { mustChangePassword: false })
    maker = new Client(h.base)
    expect((await maker.post('/auth/login', { email: 'mia@example.com', password: 'some-password-1' })).status).toBe(200)
  }, 180000)

  afterAll(async () => { await h?.close() }, 60000)

  it('a draft is kept apart from the published version; publishing clears it; discard drops it', async () => {
    const r = await A().post('/flows', { name: 'Drafty', settings, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'a', name: 'A', kind: 'compose', value: '1' }] })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const id = r.data.flow.id
    expect((await A().get(`/flows/${id}/draft`)).data).toEqual({ draft: null })
    // a draft may hold problems (it is not validated); the published version does not change
    const doc = { ...r.data.flow, steps: [...r.data.flow.steps, { id: 'b', name: 'B', kind: 'compose', value: 'Steps.Nope.Output', futureField: { x: 1 } }] }
    const d = await A().req('PUT', `/flows/${id}/draft`, { flow: doc, connections: {}, baseVersion: 1 })
    expect(d.status, JSON.stringify(d.data)).toBe(200)
    expect(d.data.draft.doc.steps).toHaveLength(2)
    expect(d.data.draft.doc.steps[1].futureField).toEqual({ x: 1 })
    expect(d.data.draft.baseVersion).toBe(1)
    expect(d.data.draft.savedByName).toBeTruthy()
    expect((await A().get(`/flows/${id}`)).data.flow.steps).toHaveLength(1)
    // the runtime never sees the draft: a run uses the published steps
    expect((await A().get(`/flows/${id}/draft`)).data.draft.doc.steps).toHaveLength(2)
    // publishing with the problem is refused, the draft stays
    const bad = await A().req('PUT', `/flows/${id}`, { ...doc })
    expect(bad.status).toBe(422)
    expect((await A().get(`/flows/${id}/draft`)).data.draft).not.toBeNull()
    // fixed and published: a new version, the draft is gone
    const okDoc = { ...doc, steps: [doc.steps[0], { ...doc.steps[1], value: 'Steps.A.Output + 1' }] }
    expect((await A().req('PUT', `/flows/${id}/draft`, { flow: okDoc, connections: {} })).status).toBe(200)
    const pub = await A().req('PUT', `/flows/${id}`, okDoc)
    expect(pub.status, JSON.stringify(pub.data)).toBe(200)
    expect(pub.data.flow.version).toBe(2)
    expect(pub.data.flow.steps[1].futureField).toEqual({ x: 1 })
    expect((await A().get(`/flows/${id}/draft`)).data).toEqual({ draft: null })
    // discard
    expect((await A().req('PUT', `/flows/${id}/draft`, { flow: okDoc })).status).toBe(200)
    expect((await A().del(`/flows/${id}/draft`)).status).toBe(200)
    expect((await A().get(`/flows/${id}/draft`)).data).toEqual({ draft: null })
    // only editors: another maker can neither read nor write the admin's draft
    expect((await A().req('PUT', `/flows/${id}/draft`, { flow: okDoc })).status).toBe(200)
    expect((await maker.get(`/flows/${id}/draft`)).data).toEqual({ draft: null })
    expect((await maker.req('PUT', `/flows/${id}/draft`, { flow: okDoc })).status).toBe(403)
    expect((await maker.del(`/flows/${id}/draft`)).status).toBe(403)
    expect((await A().req('PUT', `/flows/${id}/draft`, {})).status).toBe(422)
  })

  it('a draft that attaches a connection the maker may not use is refused with the reason', async () => {
    const r = await maker.post('/flows', { name: 'Mia flow', settings, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [] })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const list = (await A().get('/workspace')).data.connections as any[]
    const target = list.find((c: any) => c.id !== 'conn_files') ?? list[0]
    const d = await maker.req('PUT', `/flows/${r.data.flow.id}/draft`, { flow: r.data.flow, connections: { api: target.id } })
    expect(d.status).toBe(403)
    expect(JSON.stringify(d.data)).toMatch(/use|administrator/i)
    expect((await maker.req('PUT', `/flows/${r.data.flow.id}/draft`, { flow: r.data.flow, connections: {} })).status).toBe(200)
  })

  it('schedule preview: the next five runs in the time zone, or the reason the cron is wrong', async () => {
    const p = await A().post('/flows/schedule-preview', { cron: '30 8 * * 1-5', timeZone: 'Asia/Kolkata' })
    expect(p.status).toBe(200)
    expect(p.data.next).toHaveLength(5)
    for (const n of p.data.next) {
      const local = new Date(new Date(n).getTime() + 330 * 60_000)
      expect([local.getUTCHours(), local.getUTCMinutes()]).toEqual([8, 30])
      expect([0, 6]).not.toContain(local.getUTCDay())
    }
    expect((await A().post('/flows/schedule-preview', { cron: '61 * * * *', timeZone: 'UTC' })).data.error).toBeTruthy()
    expect((await A().post('/flows/schedule-preview', { cron: '0 8 * * *', timeZone: 'Mars/Base' })).data.error).toBeTruthy()
    expect((await A().post('/flows/schedule-preview', { everyMinutes: 15, timeZone: 'UTC' })).data.next).toHaveLength(5)
  })

  it('the catalogue says whether approvals are available', async () => {
    const c = await A().get('/flows/catalog')
    expect(typeof c.data.approvals).toBe('boolean')
    expect(c.data.steps.length).toBeGreaterThan(15)
  })

  it('every gallery template creates a valid flow through the API', async () => {
    const dir = path.resolve(import.meta.dirname, '../../../src/flows/templates')
    const tlist = (await A().get('/workspace')).data.tables
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const t: FlowTemplate = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (t.params.some((p) => p.type === 'connection')) continue // needs an HTTP connection; covered by templates.test.ts
      const values = guessParams(t, tlist.filter((x: any) => !x.system), { ...(t.params.some((p) => p.name === 'target') ? { target: 'Archive', table: 'PurchaseRequests' } : {}) })
      const def = instantiate(t, values)
      const r = await A().post('/flows', { ...def, name: `${def.name} ${t.id}` })
      expect(r.status, `${t.id}: ${JSON.stringify(r.data).slice(0, 400)}`).toBe(200)
      expect(r.data.flow.enabled).toBe(false)
    }
  })
})
