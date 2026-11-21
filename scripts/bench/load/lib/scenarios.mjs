/**
 * What the virtual people of a small manufacturer do (scripts/bench/load). Each scenario is one action of one person
 * (one or more requests, labelled scenario/step), eligible for some roles of the Manufacturing pack. The weights and
 * the nominal request counts are in profiles.mjs (`MIX`); the reasoning is in docs/dev/load-testing.md.
 */
import { performance } from 'node:perf_hooks'
import { uuid } from './util.mjs'

const MIN = 60_000
const HOUR = 3_600_000
const nowIso = (d = 0) => new Date(Date.now() + d).toISOString()
/** a Query v2 datetime literal (query-v2.md: { $datetime: ISO })
 */
const dt = (d) => ({ $datetime: nowIso(d) })
const shiftNow = () => { const h = (new Date().getUTCHours() + 5.5) % 24; return h >= 6 && h < 14 ? 'A' : h >= 14 && h < 22 ? 'B' : 'C' }
const rowsOf = (r) => r.json()?.rows ?? []
const ok409 = (s) => (s >= 200 && s < 300) || s === 409
const q = (p, plan, step, scenario, extra = {}) => p.req('POST', '/query', { body: { plan: { version: 2, ...plan } }, scenario, step, cls: 'read', ...extra })

/** the list screens each role opens first (Query v2 with filters, sorts, exact counts, keyset pages) */
function screensFor(p, org) {
  const role = p.user.role
  if (role === 'Operator') {
    return [
      { table: 'ProductionLog', filter: { and: [{ col: 'Machine', op: 'in', value: p.machines ?? org.machines.slice(0, 2) }, { col: 'LoggedOn', op: 'ge', value: dt(-36 * HOUR) }] }, sort: [{ col: 'LoggedOn', dir: 'desc' }], count: true, page: { size: 20 } },
      { table: 'Machines', select: ['id', 'Code', 'Name', 'Status'], sort: [{ col: 'Code', dir: 'asc' }], page: { size: 50 } },
    ]
  }
  if (role === 'Quality') {
    return [
      { table: 'Inspections', filter: { col: 'InspectedOn', op: 'ge', value: dt(-30 * 24 * HOUR) }, sort: [{ col: 'InspectedOn', dir: 'desc' }], count: true, page: { size: 50 } },
      { table: 'NCRs', filter: { col: 'Status', op: 'ne', value: 'Closed' }, sort: [{ col: 'createdOn', dir: 'desc' }], count: true, page: { size: 50 } },
    ]
  }
  if (role === 'Maintenance') {
    return [
      { table: 'MaintenanceRequests', filter: { col: 'Status', op: 'ne', value: 'Closed' }, sort: [{ col: 'Priority', dir: 'asc' }, { col: 'createdOn', dir: 'desc' }], count: true, page: { size: 50 } },
      { table: 'Downtime', filter: { and: [{ col: 'Reason', op: 'eq', value: 'Breakdown' }, { col: 'StartedOn', op: 'ge', value: dt(-7 * 24 * HOUR) }] }, sort: [{ col: 'StartedOn', dir: 'desc' }], page: { size: 50 } },
    ]
  }
  // supervisors, the plant manager, the administrator: the Supervisor console's Today and Production log tabs
  return [
    { table: 'ProductionLog', filter: { col: 'LoggedOn', op: 'ge', value: dt(-7 * 24 * HOUR) }, sort: [{ col: 'LoggedOn', dir: 'desc' }], count: true, page: { size: 50 } },
    { table: 'Downtime', filter: { col: 'StartedOn', op: 'ge', value: dt(-24 * HOUR) }, sort: [{ col: 'StartedOn', dir: 'desc' }], count: true, page: { size: 50 } },
  ]
}

export const SCENARIOS = {
  /** open an app: its list screens' queries, as the run view sends them when the app opens */
  async open_app(p, org) {
    const screens = screensFor(p, org)
    const rs = await Promise.all(screens.map((s, k) => q(p, s, `screen${k + 1}`, 'open_app')))
    p.lastList = { plan: screens[0], cursor: rs[0].json()?.nextCursor ?? null }
  },
  /** scroll to the next page (keyset cursor) or search the list */
  async next_page(p, org, ctx, g) {
    const last = p.lastList
    if (last?.cursor && g.chance(0.6)) { await q(p, { ...last.plan, count: false, page: { size: last.plan.page?.size ?? 50, cursor: last.cursor } }, 'cursor', 'next_page'); return }
    const role = p.user.role
    const table = role === 'Quality' ? 'Inspections' : role === 'Maintenance' ? 'MaintenanceRequests' : 'ProductionLog'
    const col = table === 'Inspections' ? 'Batch' : table === 'MaintenanceRequests' ? 'Problem' : 'Machine'
    await q(p, { table, search: { text: table === 'ProductionLog' ? g.pick(org.machines).slice(-2) : 'LOT-1', columns: [col] }, sort: [{ col: 'createdOn', dir: 'desc' }], page: { size: 50 } }, 'search', 'next_page')
  },
  /** open a record: the row and its related list */
  async record_view(p, org, ctx, g) {
    if (p.user.role === 'Quality' && org.inspectionIds.length) {
      const id = g.pick(org.inspectionIds)
      await Promise.all([
        q(p, { table: 'Inspections', filter: { col: 'id', op: 'eq', value: id } }, 'row', 'record_view'),
        q(p, { table: 'InspectionDefects', filter: { col: 'Inspection', op: 'eq', value: id } }, 'related', 'record_view'),
      ])
      return
    }
    const m = g.pick(p.machines ?? org.machines)
    await Promise.all([
      q(p, { table: 'Machines', filter: { col: 'Code', op: 'eq', value: m } }, 'row', 'record_view'),
      q(p, { table: p.user.role === 'Operator' ? 'ProductionLog' : 'Downtime', filter: { col: 'Machine', op: 'eq', value: m }, sort: [{ col: 'createdOn', dir: 'desc' }], page: { size: 10 } }, 'related', 'record_view'),
    ])
  },
  /** the phone's Shop floor: log production (client row id, Idempotency-Key as the offline outbox sends), a photo sometimes, a lost answer retried sometimes */
  async phone_log(p, org, ctx, g, o = {}) {
    const id = uuid()
    const key = `${id}.1`
    const values = { id, LoggedOn: nowIso(), Shift: shiftNow(), Machine: g.pick(p.machines ?? org.machines), Good: g.int(400, 1100), Scrap: g.int(0, 30), Rework: 0, RunMin: g.int(380, 450) }
    const scenario = o.scenario ?? 'phone_log'
    ctx.live.noteWrite(org, id)
    const r = await p.req('POST', `/data/ProductionLog/rows`, { body: { values }, headers: { 'idempotency-key': key }, scenario, step: 'create', cls: 'write', ua: ctx.phoneUa })
    if (r.status !== 200) return
    ctx.integrity.created.push({ org: org.inst.key, table: 'ProductionLog', id })
    if (g.chance(ctx.cfg.replayP)) {
      // the outbox resends an item whose answer was lost: same key, same body: the first answer, nothing written
      const again = await p.req('POST', `/data/ProductionLog/rows`, { body: { values }, headers: { 'idempotency-key': key }, scenario, step: 'replay', cls: 'write', ua: ctx.phoneUa })
      ctx.integrity.replays++
      if (again.status === 200 && again.json()?.row?.id !== id) ctx.integrity.replayMismatch.push({ org: org.inst.key, id, got: again.json()?.row?.id })
    }
    if (g.chance(ctx.cfg.photoP)) {
      await p.req('POST', `/attachments?table=ProductionLog&column=Photo&rowId=${id}&name=machine.png`, { body: ctx.photo, contentType: 'image/png', headers: { 'idempotency-key': `${uuid()}.1` }, scenario, step: 'photo', cls: 'write', ua: ctx.phoneUa })
    }
  },
  /** a stoppage from the phone; breakdowns raise a maintenance request and route it (flows per row change) */
  async downtime(p, org, ctx, g) {
    const breakdown = g.chance(0.25)
    const st = Date.now() - g.int(5, 40) * MIN
    await p.req('POST', '/data/Downtime/rows', { body: { values: { id: uuid(), StartedOn: new Date(st).toISOString(), ...(breakdown ? {} : { EndedOn: new Date(st + g.int(3, 30) * MIN).toISOString() }), Machine: g.pick(p.machines ?? org.machines), Reason: breakdown ? 'Breakdown' : g.pick(['Changeover', 'No material', 'Other']), Shift: shiftNow(), Notes: breakdown ? 'Ram does not return' : '' } }, headers: { 'idempotency-key': `${uuid()}.1` }, scenario: 'downtime', step: breakdown ? 'breakdown' : 'stoppage', cls: 'write', ua: ctx.phoneUa })
    if (breakdown) ctx.integrity.breakdowns++
  },
  /** the Inspection phone app: result, a photo, defects when it fails (a failed one raises an NCR by flow) */
  async inspection(p, org, ctx, g) {
    const pl = g.pick(org.inspectionPlans)
    const fail = g.chance(0.1)
    const mid = (Number(pl.Min) + Number(pl.Max)) / 2
    const r = await p.req('POST', '/data/Inspections/rows', { body: { values: { id: uuid(), Plan: pl.id, Machine: g.pick(org.machines), Batch: `LOT-${Date.now() % 100000}`, Stage: 'In-process', InspectedOn: nowIso(), Measured: fail ? Number(pl.Max) + 0.04 : mid, SampleSize: 5, Result: 'Pass' } }, headers: { 'idempotency-key': `${uuid()}.1` }, scenario: 'inspection', step: 'create', cls: 'write', ua: ctx.phoneUa })
    if (r.status !== 200) return
    const row = r.json()?.row
    org.inspectionIds.push(row.id)
    await p.req('POST', `/attachments?table=Inspections&column=Photos&rowId=${row.id}&name=part.png`, { body: ctx.photo, contentType: 'image/png', headers: { 'idempotency-key': `${uuid()}.1` }, scenario: 'inspection', step: 'photo', cls: 'write', ua: ctx.phoneUa })
    if (row.Result === 'Fail') {
      ctx.integrity.failedInspections++
      await p.req('POST', '/data/InspectionDefects/rows', { body: { values: { Inspection: row.id, Defect: 'Hole oversize', Severity: 'Major', Qty: g.int(1, 5), Action: 'Hold the lot' } }, scenario: 'inspection', step: 'defect', cls: 'write' })
    }
  },
  /** the Quality desk: an open NCR gets its disposition and is sent for approval (the approval flow) */
  async ncr_send(p, org, ctx, g) {
    const r = await q(p, { table: 'NCRs', select: ['id', 'modifiedOn', 'Status'], filter: { col: 'Status', op: 'eq', value: 'Open' }, sort: [{ col: 'createdOn', dir: 'asc' }], page: { size: 10 } }, 'list', 'ncr_send')
    const list = rowsOf(r)
    if (!list.length) return
    const n = g.pick(list)
    await p.req('PATCH', `/data/NCRs/rows/${n.id}`, { body: { changes: { Disposition: g.pick(['Rework', 'Scrap', 'Sort 100%']), RootCause: 'Punch worn', Status: 'Awaiting approval' }, ifModifiedOn: n.modifiedOn }, scenario: 'ncr_send', step: 'send', cls: 'write', ok: ok409 })
    ctx.integrity.ncrSent++
  },
  /** an approver answers the first pending approval (NCR disposition) */
  async ncr_approve(p, org, ctx) {
    const r = await p.req('GET', '/approvals?view=toApprove&status=pending&limit=10', { scenario: 'ncr_approve', step: 'list', cls: 'read' })
    const items = r.json()?.items ?? r.json()?.requests ?? []
    if (!items.length) return
    const a = items[0]
    const res = await p.req('POST', `/approvals/${a.id}/respond`, { body: { response: 'Approve', comment: 'OK to rework' }, scenario: 'ncr_approve', step: 'respond', cls: 'write', ok: ok409 })
    if (res.status === 200) ctx.integrity.approved++
  },
  /** a dashboard page: every tile in one batch (POST /dashboards/query, up to 40 plans a request) */
  async dashboard(p, org, ctx, g) {
    const key = p.user.role === 'Supervisor' ? 'ShiftBoard' : p.user.role === 'Quality' ? 'QualityMaintenance' : g.pick(['PlantOverview', 'ShiftBoard'])
    const all = org.batches[key] ?? []
    for (let k = 0; k < all.length; k += 40) {
      const r = await p.req('POST', '/dashboards/query', { body: { queries: all.slice(k, k + 40) }, scenario: 'dashboard', step: key, cls: 'read' })
      const res = r.json()?.results ?? []
      for (const x of res) { ctx.dash.total++; if (x.cached) ctx.dash.cached++; if (!x.ok) ctx.dash.failed.set(`${key}/${x.id}: ${x.error?.code ?? ''} ${String(x.error?.message ?? '').slice(0, 80)}`, (ctx.dash.failed.get(`${key}/${x.id}`) ?? 0) + 1) }
    }
  },
  /** print a record (the inspection report) and open the PDF */
  async print(p, org, ctx, g) {
    if (!org.inspectionIds.length || !org.print.Inspection) return
    const r = await p.req('POST', '/print/generate', { body: { template: org.print.Inspection, recordId: g.pick(org.inspectionIds.slice(-200)) }, scenario: 'print', step: 'generate', cls: 'job' })
    const f = r.json()?.file
    const url = f?.url ?? (f?.token ? `/print/files/${f.token}` : null)
    if (url) await p.req('GET', url.replace(/^\/api\/v1/, ''), { scenario: 'print', step: 'download', cls: 'read' })
  },
  /** a chat message to the plant channel: delivered live to every member's open sockets */
  async chat(p, org, ctx) {
    const token = `lt${ctx.live.chatSeq++}x`
    ctx.live.noteChat(org, token, p)
    const r = await p.req('POST', `/chat/conversations/${org.channel}/messages`, { body: { body: `<p>${token} Line 2 is waiting for coils</p>`, clientId: `ld-${token}` }, scenario: 'chat', step: 'send', cls: 'write', ok: (s) => s === 200 || s === 429 })
    if (r.status !== 200) ctx.live.unnoteChat(token, r.status)
  },
  /** a task for a colleague with a reminder in a minute or two (the reminders job fires during the run) */
  async task(p, org, ctx, g) {
    const to = g.pick(org.people)
    const remind = Date.now() + g.int(60, 120) * 1000
    const r = await p.req('POST', '/data/Activities/rows', { body: { values: { Subject: `Check die ${g.int(1, 99)}`, Type: 'Task', AssignedTo: to.user.id, ReminderOn: new Date(remind).toISOString(), DueOn: nowIso(24 * HOUR) } }, scenario: 'task', step: 'create', cls: 'write' })
    if (r.status === 200) ctx.integrity.tasks.push({ org: org.inst.key, id: r.json()?.row?.id, to: to.user.id, remind })
  },
  /** the bell and My tasks */
  async inbox(p) {
    await Promise.all([
      p.req('GET', '/notifications?limit=20', { scenario: 'inbox', step: 'notifications', cls: 'read' }),
      p.req('GET', '/collab/my-tasks', { scenario: 'inbox', step: 'my_tasks', cls: 'read' }),
    ])
  },
  /** a new device or a new morning: sign in again, then the session check the shell makes */
  async sign_in(p) {
    const r = await p.signIn({ scenario: 'sign_in', fresh: true })
    if (r.status === 200) await Promise.all([p.req('GET', '/auth/session', { scenario: 'sign_in', step: 'session', cls: 'read' }), p.req('GET', '/workspace', { scenario: 'sign_in', step: 'workspace', cls: 'read' })])
  },
}

/** who does what (roles of the pack; Admin is the install administrator) */
export const ELIGIBLE = {
  open_app: null, next_page: ['Supervisor', 'Quality', 'Maintenance', 'PlantManager', 'Admin'], record_view: null,
  phone_log: ['Operator'], downtime: ['Operator'], inspection: ['Quality'], ncr_send: ['Quality'], ncr_approve: ['Quality', 'PlantManager'],
  dashboard: ['Supervisor', 'PlantManager', 'Admin', 'Quality'], print: ['Quality', 'Supervisor', 'PlantManager'], chat: null,
  task: ['Supervisor', 'Quality', 'Maintenance', 'PlantManager', 'Admin'], inbox: null, sign_in: null,
}

/** background work of an organisation: the scheduled report and the pack's daily PDF, run by hand */
export async function backgroundJob(org, kind) {
  const a = org.admin
  if (kind === 'report' && org.reportId) return a.req('POST', `/reports/${org.reportId}/run`, { body: {}, scenario: 'background', step: 'report_run', cls: 'job' })
  if (kind === 'daily_pdf' && org.dailyOeeSchedule) return a.req('POST', `/admin/schedules/${org.dailyOeeSchedule}/run`, { body: {}, scenario: 'background', step: 'daily_oee_run', cls: 'job' })
  return null
}

/** the deliberately heavy tenant: a bulk import, a 500-page PDF, a large export; returns what each took */
export async function heavyWork(org, ctx, o, log) {
  const out = []
  const op = org.people.find((p) => p.user.role === 'Operator')
  const pm = org.people.find((p) => p.user.role === 'PlantManager')
  const t = (label, f) => (async () => { const a = performance.now(); let r; try { r = await f() } catch (e) { r = { status: 0, error: e.message } } out.push({ what: label, ms: Math.round(performance.now() - a), status: r?.status, detail: r?.detail ?? (r?.error ? String(r.error).slice(0, 200) : '') }) })()
  const { toCsv } = await import('./seed.mjs')
  const rows = Array.from({ length: o.heavyImportRows }, (_, k) => ({ LoggedOn: new Date(Date.now() - (k % 1440) * MIN).toISOString(), Shift: ['A', 'B', 'C'][k % 3], Machine: org.machines[k % org.machines.length], Good: 500 + (k % 400), Scrap: k % 20, Rework: 0, RunMin: 400 + (k % 50), Notes: 'bulk' }))
  const csv = toCsv(['LoggedOn', 'Shift', 'Machine', 'Good', 'Scrap', 'Rework', 'RunMin', 'Notes'], rows)
  const jobs = [
    t(`bulk import of ${o.heavyImportRows} production rows (${Math.round(csv.length / 1024)} KB CSV)`, async () => { const r = await op.req('POST', '/data/ProductionLog/import', { body: { csv, mode: 'append' }, scenario: 'heavy', step: 'bulk_import', cls: 'heavy', timeout: 900_000 }); return { status: r.status, detail: r.status === 200 ? `${r.json()?.imported} imported` : r.buf.toString().slice(0, 200) } }),
    t(`merged PDF of ${Math.min(o.heavyPdfRecords, org.inspectionIds.length)} inspection reports`, async () => {
      const ids = org.inspectionIds.slice(0, o.heavyPdfRecords)
      const r = await pm.req('POST', '/print/bulk', { body: { template: org.print.Inspection, recordIds: ids, mode: 'merged' }, scenario: 'heavy', step: 'bulk_pdf_start', cls: 'heavy' })
      const id = r.json()?.runId ?? r.json()?.run?.id ?? r.json()?.id
      if (!id) return { status: r.status, detail: r.buf.toString().slice(0, 200) }
      for (let k = 0; k < 900; k++) {
        await new Promise((res) => setTimeout(res, 1000))
        const s = await pm.req('GET', `/print/runs/${id}`, { scenario: 'heavy', step: 'bulk_pdf_poll', cls: 'heavy', record: false })
        const st = s.json()?.run
        if (st && !['queued', 'running'].includes(st.status ?? st.state)) return { status: s.status, detail: `${st.status ?? st.state}, ${st.pages ?? st.result?.pages ?? '?'} pages, ${JSON.stringify(st.warnings ?? st.result?.warnings ?? []).slice(0, 80)}` }
      }
      return { status: 0, detail: 'still running after 15 minutes' }
    }),
    t('large export (CSV of the whole production log)', async () => { const r = await org.admin.req('GET', `/tables/${org.ids.ProductionLog}/csv`, { scenario: 'heavy', step: 'export_csv', cls: 'heavy', timeout: 900_000 }); return { status: r.status, detail: `${Math.round(r.buf.length / 1024)} KB` } }),
  ]
  await Promise.all(jobs)
  log?.(`heavy tenant ${org.inst.key}: ${out.map((x) => `${x.what}: ${x.ms} ms (${x.status}; ${x.detail})`).join(' | ')}`)
  return out
}
