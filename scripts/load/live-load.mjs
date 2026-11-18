/**
 * Realtime load check (package H). DEVELOPER TOOL. Against a running server on an EMPTY sandbox database started with
 * APPBUILDER_LIVE_MAX_PER_USER=400 (all sockets use one account), e.g. PORT=5197 as in scripts/docs-shots/live.mjs:
 *   SETUP_CODE=<code> SERVER_PID=<pid> node scripts/load/live-load.mjs
 * Opens SOCKETS sockets (default 300) subscribed to one table, writes RATE row updates per second (default 50) for
 * SECONDS (default 30) through the HTTP API, and reports delivery latency (write sent -> message received on every
 * socket), messages received, and the server process's CPU and memory (from /proc, Linux).
 */
import fs from 'node:fs'
import { WebSocket } from 'ws'

const BASE = (process.env.BASE || 'http://localhost:5197').replace(/\/$/, '')
const SOCKETS = Number(process.env.SOCKETS || 300)
const RATE = Number(process.env.RATE || 50)
const SECONDS = Number(process.env.SECONDS || 30)
const PID = process.env.SERVER_PID
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(cookie, method, p, body) {
  const headers = { 'X-Appbuilder': '1', ...(cookie ? { Cookie: cookie } : {}) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const set = res.headers.getSetCookie().find((c) => c.startsWith('ab_session='))
  return { status: res.status, data: await res.json().catch(() => null), cookie: set ? set.split(';')[0] : cookie }
}
const r = await api('', 'POST', '/setup/admin', { name: 'Load Admin', email: 'load@example.test', password: 'Example-Only-Pass-2026', setupCode: process.env.SETUP_CODE })
if (r.status !== 200) throw new Error(JSON.stringify(r.data))
const cookie = r.cookie
const t = (await api(cookie, 'POST', '/tables', { displayName: 'Load', columns: [{ displayName: 'Title', type: 'text' }] })).data
const rows = []
for (let i = 0; i < 50; i++) rows.push((await api(cookie, 'POST', `/data/${t.id}/rows`, { values: { Title: `row ${i}` } })).data.row.id)

const sentAt = new Map() // row id + seq-ish -> time; we key by the write counter written into Title
const latencies = []
let received = 0
const socks = []
for (let i = 0; i < SOCKETS; i++) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/api/v1/live', { headers: { Origin: BASE, Cookie: cookie } })
  socks.push(ws)
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.t === 'hello') ws.send(JSON.stringify({ t: 'sub', topic: `table:${t.id}`, env: 'default' }))
    if (m.t === 'table' && m.rows) {
      received++
      const at = sentAt.get(m.rows[0])
      if (at) latencies.push(Date.now() - at)
    }
  })
  ws.on('error', () => {})
  if (i % 50 === 49) await sleep(100)
}
await sleep(2000)
const open = socks.filter((s) => s.readyState === 1).length

function proc() {
  if (!PID) return null
  const st = fs.readFileSync(`/proc/${PID}/stat`, 'utf8').split(') ')[1].split(' ')
  const ticks = Number(st[11]) + Number(st[12])
  const rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${PID}/status`, 'utf8'))[1]) / 1024
  return { ticks, rss }
}
const p0 = proc()
const tStart = Date.now()
let writes = 0
let failed = 0
const inflight = []
let rssMax = p0?.rss ?? 0
while (Date.now() - tStart < SECONDS * 1000) {
  const tick = Date.now()
  for (let i = 0; i < RATE; i++) {
    const id = rows[writes % rows.length]
    writes++
    sentAt.set(id, Date.now())
    inflight.push(api(cookie, 'PATCH', `/data/${t.id}/rows/${id}`, { changes: { Title: `w${writes}` } }).then((x) => { if (x.status !== 200) failed++ }))
    await sleep(Math.max(0, 1000 / RATE - 1))
  }
  const p = proc()
  if (p) rssMax = Math.max(rssMax, p.rss)
  const spent = Date.now() - tick
  if (spent < 1000) await sleep(1000 - spent)
}
await Promise.all(inflight)
await sleep(2000)
const p1 = proc()
const elapsed = (Date.now() - tStart) / 1000
latencies.sort((a, b) => a - b)
const pct = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]
console.log(JSON.stringify({
  sockets: SOCKETS, open, writes, failedWrites: failed, seconds: SECONDS,
  messagesReceived: received, expectedAtMost: writes * open,
  latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: latencies[latencies.length - 1] },
  serverCpuPercent: p0 && p1 ? Math.round(((p1.ticks - p0.ticks) / 100 / elapsed) * 1000) / 10 : null,
  serverRssMB: p1 ? { before: Math.round(p0.rss), max: Math.round(rssMax), after: Math.round(p1.rss) } : null,
}, null, 2))
for (const s of socks) s.terminate()
process.exit(0)
