/**
 * One organisation's day zero (scripts/bench/load), through the product's own API as its people would do it: the
 * Manufacturing pack installed by the administrator (plan, then install: the common business model comes first), people
 * with the pack's roles (4 to 5 makers and supervisors, the rest operators), a team per supervisor, machines, months of
 * history imported by the people who own it (POST /data/:table/import as each operator, inspector, technician: the rows
 * belong to them, as they would after months of use), open NCRs, tasks, chat channels with history, a scheduled report,
 * then the pack's flows switched on. The one write outside the API: `must_change_password = false` for the people the
 * administrator created (the exit checks do the same), because a person's first sign-in would otherwise force a new
 * password.
 */
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { Person } from './client.mjs'
import { root, rng } from './util.mjs'
import { pool } from './fleet.mjs'

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)

const csvCell = (v) => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const toCsv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n'

/** the people of one organisation: roles in the pack and whether they are makers */
export function composition(U) {
  const sup = Math.max(1, Math.round(U * 0.06))
  const qc = Math.max(1, Math.round(U * 0.06))
  const mt = Math.max(1, Math.round(U * 0.04))
  const list = [{ role: 'PlantManager', maker: true }]
  for (let i = 0; i < sup; i++) list.push({ role: 'Supervisor', maker: i === 0 })
  for (let i = 0; i < qc; i++) list.push({ role: 'Quality', maker: false })
  for (let i = 0; i < mt; i++) list.push({ role: 'Maintenance', maker: false })
  while (list.length < U - 1) list.push({ role: 'Operator', maker: false })
  return list.slice(0, Math.max(0, U - 1))
}

const SHIFTS = [{ code: 'A', h: 6 }, { code: 'B', h: 14 }, { code: 'C', h: 22 }]
const REASONS = ['Changeover', 'No material', 'No operator', 'Planned maintenance', 'Other', 'Breakdown']

async function must(p, method, url, body, what) {
  const r = await p.req(method, url, { body, record: false, timeout: 600_000 })
  if (r.status !== 200) throw new Error(`${p.inst.key} ${what ?? `${method} ${url}`}: ${r.status} ${r.buf.toString('utf8').slice(0, 400)}`)
  return r.json()
}

export async function seedOrg(ctx, inst, o, log) {
  const g = rng(o.seed + inst.i * 7919)
  const admin = new Person(inst, { email: inst.adminEmail, password: inst.adminPassword, ip: `10.${inst.i + 1}.0.1`, name: `Admin ${inst.key}`, role: 'Admin', maker: true }, ctx)
  admin.cookie = inst.adminCookie
  const org = { inst, admin, people: [], machines: [], ids: {} }

  // 1. the pack (Linked, SAMPLE rows on: the inspection plans and lines the scenarios use), business model first
  const plan = await must(admin, 'POST', '/templates/builtin.manufacturing/plan', { mode: 'linked', sample: true }, 'plan the Manufacturing pack')
  if (plan.plan?.problems?.length) throw new Error(`${inst.key} plan problems: ${JSON.stringify(plan.plan.problems).slice(0, 400)}`)
  const ins = await must(admin, 'POST', '/templates/builtin.manufacturing/install', { mode: 'linked', bindings: plan.bindings, sample: true, confirm: plan.plan.token, proceedWithoutBackup: true, ...(plan.plan.systemEvents?.length ? { approveSystem: true } : {}) }, 'install the Manufacturing pack')
  const mfg = ins.install
  org.install = mfg
  const roleId = (k) => mfg.created.roles.find((x) => x.key === k).id
  org.print = Object.fromEntries(mfg.created.printTemplates.map((p) => [p.key, p.id]))
  org.dashboards = Object.fromEntries(mfg.created.dashboards.map((d) => [d.key, d.id]))
  org.flowIds = mfg.created.flows.map((f) => f.id)
  org.flowsByKey = Object.fromEntries(mfg.created.flows.map((f) => [f.key, f.id]))
  if (o.crm) {
    const p2 = await admin.req('POST', '/templates/builtin.crm/plan', { body: { mode: 'linked', sample: true }, record: false, timeout: 600_000 })
    const pj = p2.json()
    if (p2.status === 200 && !pj?.plan?.problems?.length) {
      const r2 = await admin.req('POST', '/templates/builtin.crm/install', { body: { mode: 'linked', bindings: pj.bindings, sample: true, confirm: pj.plan.token, proceedWithoutBackup: true, ...(pj.plan.systemEvents?.length ? { approveSystem: true } : {}) }, record: false, timeout: 600_000 })
      org.crm = r2.status === 200 ? 'installed' : `install ${r2.status}`
    } else org.crm = `plan ${p2.status} ${JSON.stringify(pj?.plan?.problems ?? '').slice(0, 120)}`
  }

  // tables: ids and source names
  const tlist = (await must(admin, 'GET', '/workspace')).tables
  const t = (name) => tlist.find((x) => x.name === name)
  for (const n of ['ProductionLog', 'Downtime', 'Inspections', 'InspectionDefects', 'NCRs', 'MaintenanceRequests', 'Machines', 'InspectionPlans', 'Activities', 'ShiftHandovers', 'PMTasks']) {
    const x = t(n)
    if (!x && n !== 'Activities') throw new Error(`${inst.key}: no table ${n} after the install (${tlist.map((y) => y.name).join(', ').slice(0, 300)})`)
    if (x) org.ids[n] = x.id
  }

  // 2. people
  const comp = composition(o.users)
  const db = await ctx.cluster.admin(inst.dbName)
  try {
    const made = await pool(comp, 4, async (c, k) => {
      const email = `${c.role.toLowerCase()}${k + 1}@${inst.key}.example.test`
      const password = `Ld-${randomBytes(12).toString('base64url')}-7`
      const u = await must(admin, 'POST', '/users', { name: `${c.role} ${k + 1} ${inst.key}`, email, password, roleIds: [roleId(c.role), ...(c.maker ? ['role_maker'] : [])] }, `create ${email}`)
      return { id: u.id ?? u.user?.id, email, password, role: c.role, maker: c.maker, name: `${c.role} ${k + 1}`, ip: `10.${inst.i + 1}.${1 + Math.floor((k + 2) / 250)}.${(k + 2) % 250 + 1}` }
    })
    await db.query(`UPDATE ab.users SET must_change_password = false WHERE email LIKE $1`, [`%@${inst.key}.example.test`])
    org.people = [admin, ...made.map((u) => new Person(inst, u, ctx))]
  } finally { await db.end() }
  admin.user.id = inst.adminId
  const of = (role) => org.people.filter((p) => p.user.role === role)
  const pm = of('PlantManager')[0]
  // the inspectors' manager (the NCR fallback approver), one team per supervisor with its share of operators
  for (const q of of('Quality')) await must(admin, 'PATCH', `/users/${q.user.id}`, { managerId: pm.user.id })
  const ops = of('Operator')
  const sups = of('Supervisor')
  for (const [k, s] of sups.entries()) {
    const members = ops.filter((_, j) => j % sups.length === k)
    await must(admin, 'POST', '/teams', { name: `Shift team ${k + 1}`, code: `TEAM${k + 1}`, memberIds: [s.user.id, ...members.map((m) => m.user.id)] })
  }
  await pool(org.people.slice(1), 6, async (p) => { const r = await p.signIn({ record: false }); if (r.status !== 200) throw new Error(`${inst.key} sign-in ${p.user.email}: ${r.status} ${r.buf.toString().slice(0, 200)}`) })

  // 3. machines (the plant's own beside the SAMPLE ones)
  const M = o.machines
  const machines = Array.from({ length: M }, (_, k) => ({ Code: `M-${String(k + 1).padStart(2, '0')}`, Name: `Press ${k + 1}`, IdealCycleSec: 20 + (k % 5) * 4, Status: 'Running' }))
  await must(admin, 'POST', '/data/Machines/import', { csv: toCsv(['Code', 'Name', 'IdealCycleSec', 'Status'], machines), mode: 'append' })
  org.machines = machines.map((m) => m.Code)
  ops.forEach((p, k) => { p.machines = org.machines.filter((_, j) => j % Math.max(1, ops.length) === k % Math.max(1, ops.length)); if (!p.machines.length) p.machines = [org.machines[k % M]] })
  const plans = (await must(admin, 'POST', '/query', { plan: { version: 2, table: 'InspectionPlans', select: ['id', 'Name', 'Min', 'Max'] } })).rows
  org.inspectionPlans = plans.filter((x) => x.Min !== null && x.Max !== null)

  // 4. history: months of production, stoppages, inspections, requests, NCRs, tasks (owned by the people who wrote them)
  const days = o.seedDays * (o.heavy && inst.i === 0 ? o.heavySeedFactor : 1)
  const now = Date.now()
  const dayMs = 86_400_000
  const logRows = new Map(ops.map((p) => [p, []]))
  const downRows = new Map(ops.map((p) => [p, []]))
  for (let d = days; d >= 1; d--) {
    const day = new Date(now - d * dayMs)
    if (day.getUTCDay() === 0) continue // Sundays off
    for (const [mi, m] of org.machines.entries()) {
      for (const s of SHIFTS) {
        const p = ops[(mi + s.h) % ops.length]
        const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), s.h) - 5.5 * 3600_000
        const stop = g.int(0, 60)
        const good = g.int(600, 1100)
        logRows.get(p).push({ LoggedOn: new Date(start + 7.5 * 3600_000).toISOString(), Shift: s.code, Machine: m, Good: good, Scrap: g.int(0, 40), Rework: 0, RunMin: 450 - stop, Notes: g.chance(0.1) ? 'Tool change' : '' })
        if (stop > 15 && g.chance(0.5)) {
          const st = start + g.int(30, 400) * 60_000
          downRows.get(p).push({ StartedOn: new Date(st).toISOString(), EndedOn: new Date(st + stop * 60_000).toISOString(), Machine: m, Reason: REASONS[g.int(0, REASONS.length - 2)], Shift: s.code, Notes: '' })
        }
      }
    }
  }
  const counts = { ProductionLog: 0, Downtime: 0, Inspections: 0, NCRs: 0, MaintenanceRequests: 0, Activities: 0, chat: 0 }
  const chunked = async (p, table, cols, rows) => {
    for (let k = 0; k < rows.length; k += o.importChunk) {
      const part = rows.slice(k, k + o.importChunk)
      const r = await p.req('POST', `/data/${table}/import`, { body: { csv: toCsv(cols, part), mode: 'append' }, record: false, timeout: 600_000 })
      if (r.status !== 200) throw new Error(`${inst.key} import ${table} as ${p.user.email}: ${r.status} ${r.buf.toString('utf8').slice(0, 300)}`)
      counts[table] += part.length
    }
  }
  await pool(ops, 3, async (p) => {
    await chunked(p, 'ProductionLog', ['LoggedOn', 'Shift', 'Machine', 'Good', 'Scrap', 'Rework', 'RunMin', 'Notes'], logRows.get(p))
    await chunked(p, 'Downtime', ['StartedOn', 'EndedOn', 'Machine', 'Reason', 'Shift', 'Notes'], downRows.get(p))
  })
  const qcs = of('Quality')
  const perDay = o.inspectionsPerDay
  const insp = new Map(qcs.map((p) => [p, []]))
  for (let d = days; d >= 1; d--) {
    for (let k = 0; k < perDay; k++) {
      const p = qcs[(d + k) % qcs.length]
      const pl = g.pick(org.inspectionPlans)
      const fail = g.chance(0.04)
      const mid = (Number(pl.Min) + Number(pl.Max)) / 2
      insp.get(p).push({ Plan: pl.id, Machine: g.pick(org.machines), Batch: `LOT-${d}-${k}`, Stage: 'In-process', InspectedOn: new Date(now - d * dayMs + k * 3600_000).toISOString(), Measured: fail ? Number(pl.Max) + 0.05 : Math.round(mid * 1000) / 1000, SampleSize: 5, Result: fail ? 'Fail' : 'Pass', Notes: '' })
    }
  }
  await pool(qcs, 2, async (p) => chunked(p, 'Inspections', ['Plan', 'Machine', 'Batch', 'Stage', 'InspectedOn', 'Measured', 'SampleSize', 'Result', 'Notes'], insp.get(p)))
  // open NCRs for the "send for approval" scenario (raised by the inspectors)
  for (const p of qcs) {
    const rows = Array.from({ length: o.openNcrs }, (_, k) => ({ Batch: `LOT-NCR-${p.user.id.slice(0, 4)}-${k}`, Defect: `Hole oversize ${k}`, Quantity: g.int(5, 200), Status: 'Open', DueDate: new Date(now + 7 * dayMs).toISOString().slice(0, 10) }))
    await chunked(p, 'NCRs', ['Batch', 'Defect', 'Quantity', 'Status', 'DueDate'], rows)
  }
  for (const p of of('Maintenance')) {
    const rows = Array.from({ length: Math.round(days / 2) }, (_, k) => ({ Machine: g.pick(org.machines), Problem: `Hydraulic leak ${k}`, Kind: 'Repair', Priority: g.pick(['High', 'Medium', 'Low']), Status: k % 5 ? 'Closed' : 'Open', Cause: k % 5 ? 'Seal worn' : '', ActionTaken: k % 5 ? 'Seal replaced' : '' }))
    await chunked(p, 'MaintenanceRequests', ['Machine', 'Problem', 'Kind', 'Priority', 'Status', 'Cause', 'ActionTaken'], rows)
  }
  if (org.ids.Activities) {
    await pool(org.people.filter((p) => p.user.role !== 'Operator').slice(0, 6), 3, async (p) => {
      const rows = Array.from({ length: o.tasksPerPerson }, (_, k) => ({ Subject: `Follow up ${k}`, Type: 'Task', AssignedTo: g.pick(org.people).user.id, DueOn: new Date(now + g.int(-10, 20) * dayMs).toISOString(), Status: k % 3 ? 'Done' : 'Open' }))
      await chunked(p, 'Activities', ['Subject', 'Type', 'AssignedTo', 'DueOn', 'Status'], rows).catch((e) => { org.taskSeedError = e.message })
    })
  }

  // 5. chat: an open channel everyone is in, a private quality channel, history
  const ch = await must(admin, 'POST', '/chat/conversations', { kind: 'channel', name: 'Plant floor', isPrivate: false, description: 'Everyone in the plant' })
  org.channel = ch.id ?? ch.conversation?.id
  await pool(org.people.slice(1), 6, async (p) => must(p, 'POST', `/chat/conversations/${org.channel}/join`, {}))
  const qch = await must(of('Quality')[0], 'POST', '/chat/conversations', { kind: 'channel', name: 'Quality', isPrivate: true, members: [...of('Quality').slice(1), pm].map((p) => p.user.id) })
  org.qualityChannel = qch.id ?? qch.conversation?.id
  const senders = org.people
  const perSender = Math.ceil(o.chatHistory / senders.length)
  await pool(senders, 8, async (p, k) => {
    for (let j = 0; j < perSender && k * perSender + j < o.chatHistory; j++) {
      const r = await p.req('POST', `/chat/conversations/${org.channel}/messages`, { body: { body: `<p>History ${j}: shift note from ${p.user.name}</p>`, clientId: `hist-${inst.key}-${k}-${j}` }, record: false })
      if (r.status === 200) counts.chat++
      else if (r.status === 429) await new Promise((res) => setTimeout(res, 2100))
    }
  })

  // 6. a scheduled report (daily, PDF attached) the background phase runs by hand
  const rep = await admin.req('POST', '/reports', { body: { name: 'Production last 7 days', source: { kind: 'table', tableId: org.ids.ProductionLog, plan: { version: 2, table: 'ProductionLog', filter: { col: 'LoggedOn', op: 'ge', value: { $datetime: new Date(now - 7 * dayMs).toISOString() } }, sort: [{ col: 'LoggedOn', dir: 'desc' }] } }, schedule: { frequency: 'daily', time: '07:00', timeZone: 'Asia/Kolkata' }, recipients: { userIds: [pm.user.id], teamIds: [] }, csvRows: 0, pdf: { mode: 'auto' } }, record: false })
  org.reportId = rep.status === 200 ? rep.json()?.id : null
  if (!org.reportId) org.reportError = `${rep.status} ${rep.buf.toString().slice(0, 200)}`

  // 7. dashboards: the viewer's batch of each (the same compile step the browser runs)
  const { buildBatch } = await imp('src/dashboards/viewer.ts')
  const { resolvePreset, DEFAULT_CALENDAR } = await imp('src/dashboards/dates.ts')
  org.batches = {}
  for (const [k, id] of Object.entries(org.dashboards)) {
    const d = await must(admin, 'GET', `/dashboards/${id}`)
    const def = d.def ?? d.dashboard?.def ?? d
    const range = resolvePreset(def.range ?? 'thisMonth', new Date(), DEFAULT_CALENDAR)
    const b = buildBatch(def, { range, filters: {}, calendar: DEFAULT_CALENDAR, columns: () => null })
    org.batches[k] = b.queries
  }
  // 8. the flows on (after the history, as a plant would switch them on after loading its masters)
  await must(admin, 'POST', `/templates/installed/${mfg.id}/flows`, { enable: org.flowIds })
  // schedules: the pack's daily OEE PDF flow
  const sch = (await must(admin, 'GET', '/admin/schedules')).items ?? []
  const oee = sch.find((s) => s.payload?.flowId === org.flowsByKey.DailyOee || String(s.id).includes(org.flowsByKey.DailyOee))
  org.dailyOeeSchedule = oee?.id ?? null

  org.counts = counts
  // ids the scenarios read
  const someInsp = (await must(admin, 'POST', '/query', { plan: { version: 2, table: 'Inspections', select: ['id'], sort: [{ col: 'InspectedOn', dir: 'desc' }], page: { size: 500 } } })).rows
  org.inspectionIds = someInsp.map((r) => r.id)
  log?.(`  ${inst.key}: seeded ${JSON.stringify(counts)}; ${org.people.length} people (${['Operator', 'Supervisor', 'Quality', 'Maintenance', 'PlantManager'].map((r) => `${r} ${of(r).length}`).join(', ')}); report ${org.reportId ? 'ok' : org.reportError}; daily OEE schedule ${org.dailyOeeSchedule ? 'ok' : 'missing'}${org.crm ? `; CRM ${org.crm}` : ''}${org.taskSeedError ? `; tasks: ${org.taskSeedError.slice(0, 120)}` : ''}`)
  return org
}
