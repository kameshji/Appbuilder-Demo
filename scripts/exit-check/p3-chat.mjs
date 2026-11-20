#!/usr/bin/env node
/**
 * Phase 3 exit checks 1 to 8 for chat (docs/plan/p3-spec.md section 3), API LEVEL: what package A (the server) can show
 * without a browser. Package B adds the browser part (dock, pop-out, phone size, three browsers) to this script.
 * DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable.
 *
 *   . .\.sandbox\env.ps1; node scripts/exit-check/p3-chat.mjs
 *
 * A server is started in this process (HTTP and WebSocket on 127.0.0.1:EXIT_PORT, default 5196) on an EMPTY database
 * whose name starts with appbuilder_exit_p3a (dropped and created here). Three people (Asha, Ravi with two "tabs",
 * Meera), an outsider (Nia) and an environment administrator (Dev).
 *   1  chat end to end      open, private, direct and group conversations; send, edit, delete, react, reply; every change
 *                           reaches the other sockets (p95 of push latency); unread counts after a "reload"; 10,000
 *                           messages page back 50 at a time (first page time); a socket killed while 20 messages are
 *                           sent recovers all 20 exactly once and in order through /changes
 *   2  mentions             a mention and a direct message notify in the app; a mention of a non-member in a private
 *                           channel is refused with the reason; muted members get nothing. (Email digest with a fake
 *                           SMTP server and the WhatsApp mock: SKIP here, covered by server/core/chat/chat.integration.test.ts
 *                           for the digest relevance check)
 *   3  files                a member opens a file; a non-member gets the missing-attachment answer; over the limit is
 *                           refused before upload; the file name is found by search
 *   4  cards                a hidden column is absent from the response bytes; a hidden row answers like a missing one;
 *                           an app the reader may not run is not available
 *   5  security             the leak checks of the integration suite in short (non-member, generic writes refused,
 *                           environment administrator through Query v2), the audited and announced export, a removed
 *                           member's socket ends within 5 s and the search hits go at once
 *   6  record discussions   SKIP: package E
 *   7  search at scale      EXIT_SCALE messages (default 100,000) in 200 channels; a member of 20 sees hits only from
 *                           those; p95 of 40 searches (target 500 ms on the sandbox); a word only in a private channel
 *                           returns nothing to a non-member
 *   8  retention, moderation, audit   retention 30 days with the clock moved 31 days; a report, a moderator delete, an
 *                           archive, a member removal, a read-only person: each in the audit log without message text
 *
 * Settings: APPBUILDER_TEST_DB (dot-source .sandbox/env.ps1) or EXIT_DB_HOST / EXIT_DB_PORT / EXIT_DB_USER /
 * EXIT_DB_PASSWORD / EXIT_MAINT_DB; EXIT_DB_NAME (appbuilder_exit_p3a); EXIT_PORT (5196); EXIT_SCALE (100000);
 * EXIT_WORKSPACE (.sandbox/p3a/workspace); KEEP=1 keeps the database. Refuses ports 5174 and 5433 (a real install).
 * Prints PASS / FAIL / SKIP lines and a table; exit code 1 when a check fails.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { WebSocket } from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const fromUrl = (() => { try { return E.APPBUILDER_TEST_DB ? new URL(E.APPBUILDER_TEST_DB) : null } catch { return null } })()
const DB = {
  host: E.EXIT_DB_HOST || fromUrl?.hostname || '',
  port: Number(E.EXIT_DB_PORT || fromUrl?.port || 0),
  user: E.EXIT_DB_USER || (fromUrl ? decodeURIComponent(fromUrl.username) : ''),
  password: E.EXIT_DB_PASSWORD || (fromUrl ? decodeURIComponent(fromUrl.password) : ''),
  database: E.EXIT_DB_NAME || 'appbuilder_exit_p3a',
}
const MAINT = E.EXIT_MAINT_DB || (fromUrl ? fromUrl.pathname.replace(/^\//, '') : '') || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5196)
const SCALE = Number(E.EXIT_SCALE || 100_000)
const BASE = `http://127.0.0.1:${PORT}`
const WS = `ws://127.0.0.1:${PORT}/api/v1/live`
const WORKSPACE = path.resolve(root, E.EXIT_WORKSPACE || path.join('.sandbox', 'p3a', 'workspace'))
const ADMIN = { name: 'Exit Admin', email: 'exit@example.test', password: 'Exit-Example-Pass-2026' }
if (!DB.host || !DB.port || !DB.user) { console.error('Name the sandbox database: dot-source .sandbox/env.ps1 (APPBUILDER_TEST_DB) or set EXIT_DB_HOST, EXIT_DB_PORT, EXIT_DB_USER, EXIT_DB_PASSWORD.'); process.exit(2) }
if (PORT === 5174 || DB.port === 5433) { console.error('Refusing to touch ports 5174 / 5433 (a real install).'); process.exit(2) }
if (!/^appbuilder_exit_p3a[a-z0-9_]*$/.test(DB.database)) { console.error('The database must start with appbuilder_exit_p3a (it is dropped).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { setQuiet } = await imp('server/core/util.ts')
setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (check, name, status, evidence = '') => { results.push({ check, name, status, evidence }); log(`${status} ${check} ${name}${evidence ? `: ${evidence}` : ''}`) }
let failures = 0
const ok = (check, cond, name, evidence = '') => { if (!cond) failures++; record(check, name, cond ? 'PASS' : 'FAIL', evidence) }
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0 }

async function maint(sql) {
  const c = new pg.Client({ ...DB, database: MAINT })
  await c.connect()
  try { await c.query(sql) } finally { await c.end() }
}
async function q(sql, params = []) {
  const c = new pg.Client(DB)
  await c.connect()
  try { return (await c.query(sql, params)).rows } finally { await c.end() }
}

class P {
  constructor(label) { this.label = label; this.cookie = '' }
  async req(method, p, body, o = {}) {
    const headers = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    let payload
    if (o.raw) { headers['Content-Type'] = o.type || 'application/octet-stream'; payload = o.raw } else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(BASE + '/api/v1' + p, { method, headers, body: payload })
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const [n, v] = pair.split('='); if (n === 'ab_session') this.cookie = v ? `ab_session=${v}` : '' }
    const text = await res.text()
    let data = text
    try { data = JSON.parse(text) } catch { /* text */ }
    return { status: res.status, data, text }
  }
  get(p) { return this.req('GET', p) }
  post(p, b) { return this.req('POST', p, b ?? {}) }
  patch(p, b) { return this.req('PATCH', p, b) }
  put(p, b) { return this.req('PUT', p, b) }
  del(p, b) { return this.req('DELETE', p, b) }
}
class Sock {
  constructor(p) {
    this.msgs = []
    this.arrived = new Map()
    this.ws = new WebSocket(WS, { headers: { Origin: BASE, Cookie: p.cookie } })
    this.ws.on('message', (d) => { const m = JSON.parse(d.toString()); this.msgs.push(m); if (m.t === 'chat' && m.message) this.arrived.set(m.message.id + ':' + m.op, Date.now()) })
    this.ws.on('error', () => {})
  }
  async wait(pred, ms = 8000) { const end = Date.now() + ms; for (;;) { const m = this.msgs.find(pred); if (m) return m; if (Date.now() > end) throw new Error('timed out on the socket'); await sleep(20) } }
  async sub(topic) { const id = Math.random().toString(36).slice(2); this.ws.send(JSON.stringify({ t: 'sub', id, topic })); return this.wait((m) => m.id === id) }
  close() { this.ws.terminate() }
}

let app = null
let server = null
const socks = []
const sock = async (p) => { const s = new Sock(p); socks.push(s); await s.wait((m) => m.t === 'hello'); return s }

try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
  fs.mkdirSync(WORKSPACE, { recursive: true })
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: WORKSPACE }, printSetupCode: false, jobs: true })
  server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }, () => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const admin = new P('admin')
  const code = app.services.setupCode.current() ?? ''
  if ((await admin.post('/setup/database', { setupCode: code, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })).status !== 200) throw new Error('setup failed')
  await admin.post('/setup/admin', { setupCode: code, ...ADMIN })
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password })
  const ids = {}
  const C = {}
  for (const [key, name, roles] of [['asha', 'Asha', ['role_viewer']], ['ravi', 'Ravi', ['role_viewer']], ['meera', 'Meera', ['role_viewer']], ['nia', 'Nia', ['role_viewer']], ['kiran', 'Kiran', ['role_viewer']], ['dev', 'Dev', ['role_admin']]]) {
    const u = await admin.post('/users', { name, email: `${key}@example.test`, roleIds: roles, password: 'Some-Example-Pass-1' })
    ids[key] = u.data.id
    await q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [u.data.id])
    C[key] = new P(name)
    await C[key].post('/auth/login', { email: `${key}@example.test`, password: 'Some-Example-Pass-1' })
  }
  C.ravi2 = new P('Ravi (second tab)')
  C.ravi2.cookie = C.ravi.cookie

  /* ---------------------------------------------------------------- 1 */
  log('check 1: chat end to end')
  const open = (await C.asha.post('/chat/conversations', { kind: 'channel', name: 'General', isPrivate: false })).data.id
  const priv = (await C.asha.post('/chat/conversations', { kind: 'channel', name: 'Quality', isPrivate: true, members: [ids.ravi, ids.meera, ids.kiran] })).data.id
  const dm = (await C.asha.post('/chat/conversations', { kind: 'direct', members: [ids.ravi] })).data.id
  const grp = (await C.asha.post('/chat/conversations', { kind: 'group', members: [ids.ravi, ids.meera, ids.kiran] })).data.id
  ok(1, [open, priv, dm, grp].every((x) => typeof x === 'string'), 'an open channel, a private channel, a 1:1 and a group conversation')
  await C.ravi.post(`/chat/conversations/${open}/join`)
  await C.meera.post(`/chat/conversations/${open}/join`)
  await C.kiran.post(`/chat/conversations/${open}/join`)
  const tabs = [await sock(C.ravi), await sock(C.ravi2), await sock(C.meera)]
  for (const s of tabs) for (const c of [open, priv, grp]) await s.sub(`chat:${c}`)
  await tabs[0].sub(`chat:${dm}`)
  await tabs[1].sub(`chat:${dm}`)
  const lat = []
  for (let i = 0; i < 20; i++) {
    const c = [open, priv, grp][i % 3]
    const sent = Date.now()
    // (a sender is limited to 30 messages a minute: Kiran sends these)
    const m = (await C.kiran.post(`/chat/conversations/${c}/messages`, { body: `message ${i}` })).data.message
    for (const s of tabs) { await s.wait((x) => x.t === 'chat' && x.message?.id === m.id); lat.push(s.arrived.get(m.id + ':message') - sent) }
  }
  const m0 = (await C.asha.post(`/chat/conversations/${dm}/messages`, { body: 'direct hello' })).data.message
  await tabs[1].wait((x) => x.t === 'chat' && x.message?.id === m0.id)
  await C.asha.patch(`/chat/messages/${m0.id}`, { body: 'direct hello (edited)' })
  await C.ravi.post(`/chat/messages/${m0.id}/reactions`, { emoji: '👍' })
  const reply = (await C.ravi.post(`/chat/conversations/${dm}/messages`, { body: 'a reply', parent: m0.id })).data.message
  await C.ravi.del(`/chat/messages/${reply.id}`)
  for (const op of ['edit', 'reaction', 'message', 'delete']) await tabs[1].wait((x) => x.t === 'chat' && x.op === op && x.channelId === dm)
  ok(1, true, 'send, edit, react, reply and delete reach the other tab of the same person')
  ok(1, p95(lat) < 1000, 'every change reaches the other people and tabs live: push p95 under 1 s', `p95 ${p95(lat)} ms over ${lat.length} deliveries`)
  const list = (await C.meera.get('/chat/conversations')).data.items
  const un = Object.fromEntries(list.map((c) => [c.id, c.unread]))
  ok(1, un[open] === 7 && un[priv] === 7 && un[grp] === 6, 'unread counts are right after a reload', JSON.stringify({ open: un[open], priv: un[priv], grp: un[grp] }))
  // 10,000 messages in one channel (written directly: the change counter, as the service does)
  const big = (await C.asha.post('/chat/conversations', { kind: 'channel', name: 'Archive of ten thousand', isPrivate: true, members: [ids.ravi] })).data.id
  await q(`INSERT INTO env_default.sys_messages ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Channel", "Body", "BodyText", "Seq", "ChangeSeq", "Kind", "ReplyCount")
           SELECT md5('big' || g)::uuid::text, now() - ((10000 - g) || ' seconds')::interval, now(), $1, $1, $2, '<p>row ' || g || '</p>', 'row ' || g, 1 + g, 1 + g, 'message', 0 FROM generate_series(1, 10000) g`, [ids.asha, big])
  await q(`UPDATE env_default.sys_channels SET "LastSeq" = 10001 WHERE id = $1`, [big])
  await q('ANALYZE env_default.sys_messages')
  const tp = Date.now()
  const page1 = await C.ravi.get(`/chat/conversations/${big}/messages`)
  const firstMs = Date.now() - tp
  const page2 = await C.ravi.get(`/chat/conversations/${big}/messages?before=${page1.data.messages[0].seq}`)
  ok(1, page1.data.messages.length === 50 && page1.data.more && page2.data.messages.length === 50 && page2.data.messages[49].seq === page1.data.messages[0].seq - 1, 'a channel with 10,000 messages pages back from the server 50 at a time', `pages of ${page1.data.messages.length} and ${page2.data.messages.length}`)
  ok(1, firstMs < 300, 'first page under 300 ms on the sandbox', `${firstMs} ms`)
  // a socket killed while 20 messages are sent: recovered exactly once and in order
  const victim = await sock(C.meera)
  const ack = await victim.sub(`chat:${grp}`)
  const lastSeen = ack.seq
  victim.close()
  const sent20 = []
  for (let i = 0; i < 20; i++) sent20.push((await C.ravi.post(`/chat/conversations/${grp}/messages`, { body: `while offline ${i}`, clientId: `offline-${i}-abcdefgh` })).data.message.id)
  // the client retries a send it is unsure of (same clientId): still one message
  await C.ravi.post(`/chat/conversations/${grp}/messages`, { body: 'while offline 0', clientId: 'offline-0-abcdefgh' })
  const back = await sock(C.meera)
  const ack2 = await back.sub(`chat:${grp}`)
  const ch = (await C.meera.get(`/chat/conversations/${grp}/changes?after=${lastSeen}`)).data
  const got = ch.messages.filter((m) => m.text.startsWith('while offline')).map((m) => m.id)
  ok(1, ack2.seq === lastSeen + 20 && got.length === 20 && got.every((x, i) => x === sent20[i]), 'a socket killed while 20 messages are sent recovers all 20 exactly once and in order', `gap ${lastSeen} -> ${ack2.seq}, ${got.length} recovered`)

  /* ---------------------------------------------------------------- 2 */
  log('check 2: mentions and notifications')
  const mm = (await C.asha.post(`/chat/conversations/${priv}/messages`, { body: `<span data-mention="${ids.meera}">@Meera</span> please check` })).data.message
  await sleep(200)
  const nm = (await C.meera.get('/notifications?limit=50')).data.items.filter((n) => n.kind === 'chat' && n.link === `#chat?c=${priv}&m=${mm.seq}`)
  ok(2, nm.length === 1, 'a mention in a channel creates one in-app notification', nm[0]?.title)
  const nd = (await C.ravi.get('/notifications?limit=50')).data.items.filter((n) => n.kind === 'chat' && n.link.startsWith(`#chat?c=${dm}&`))
  ok(2, nd.length >= 1, 'a direct message creates an in-app notification', nd[0]?.title)
  const refused = await C.asha.post(`/chat/conversations/${priv}/messages`, { body: `<span data-mention="${ids.nia}">@Nia</span> look` })
  ok(2, refused.status === 422 && /not in this conversation/.test(refused.data.error.message), 'a mention of a non-member in a private channel is refused with the reason', refused.data.error?.message)
  await C.ravi.patch(`/chat/conversations/${priv}/me`, { muted: true })
  const before = (await C.ravi.get('/notifications?limit=100')).data.items.length
  await C.asha.post(`/chat/conversations/${priv}/messages`, { body: `<span data-mention="${ids.ravi}">@Ravi</span> muted` })
  await sleep(200)
  ok(2, (await C.ravi.get('/notifications?limit=100')).data.items.length === before, 'nothing goes to a muted member')
  record(2, 'email digest at the digest slot (fake SMTP) and WhatsApp template (mock)', 'SKIP', 'browser/mail part of the exit check; the digest relevance check is in server/core/chat/chat.integration.test.ts')

  /* ---------------------------------------------------------------- 3 */
  log('check 3: files')
  const up = await C.asha.req('POST', `/chat/conversations/${priv}/files?name=inspection-photo.jpg`, undefined, { raw: Buffer.from('JPEG'), type: 'image/jpeg' })
  const fm = (await C.asha.post(`/chat/conversations/${priv}/messages`, { body: 'the photo', files: [up.data.id] })).data.message
  const url = fm.files[0].url.replace('/api/v1', '')
  ok(3, (await C.meera.get(url)).status === 200, 'a file sent in a message opens for members')
  const nf = await C.nia.get(url)
  const missing = await C.nia.get('/attachments/att_000000000000?env=default')
  ok(3, nf.status === 404 && nf.text.replace(/"requestId":"[^"]+"/, '') === missing.text.replace(/"requestId":"[^"]+"/, ''), 'a non-member gets the same answer as for a missing attachment', `${nf.status}`)
  const tooBig = await new Promise((resolve) => {
    const r = http.request(`${BASE}/api/v1/chat/conversations/${priv}/files?name=big.bin`, { method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: C.asha.cookie, 'Content-Type': 'application/octet-stream', 'Content-Length': String(26 * 1024 * 1024) } }, (res) => { res.resume(); resolve(res.statusCode) })
    r.on('error', () => resolve(-1))
    r.write(Buffer.alloc(1024))
    setTimeout(() => r.destroy(), 3000)
  })
  ok(3, tooBig === 413, 'a file over the limit is refused before upload', `${tooBig}`)
  const fs1 = (await C.ravi.get('/chat/search?q=inspection-photo')).data.items.map((i) => i.message.id)
  ok(3, fs1.includes(fm.id), 'the file name is found by search')

  /* ---------------------------------------------------------------- 4 */
  log('check 4: cards')
  const t = (await admin.post('/tables', { displayName: 'Machines', name: 'ExitMachines', columns: [{ displayName: 'Code', type: 'text' }, { displayName: 'Cost', type: 'text' }] })).data
  const partial = (await admin.post('/roles', { name: 'Partial machines', apps: [], privileges: [{ table: t.id, create: true, read: 'own', update: 'own', delete: 'none', columns: { Cost: 'none' } }] })).data
  const full = (await admin.post('/roles', { name: 'Full machines', apps: [], privileges: [{ table: t.id, create: true, read: 'all', update: 'all', delete: 'none' }] })).data
  // (the Viewer role reads every table: Meera keeps only the partial role)
  await admin.patch(`/users/${ids.meera}`, { roleIds: [partial.id] })
  await admin.patch(`/users/${ids.ravi}`, { roleIds: [full.id] })
  const meeraRow = (await C.meera.post(`/data/${t.id}/rows`, { values: { Code: 'M-01' } })).data.row.id
  await admin.patch(`/data/${t.id}/rows/${meeraRow}`, { changes: { Cost: 'COST-SECRET-4711' } })
  const other = (await admin.post(`/data/${t.id}/rows`, { values: { Code: 'M-02', Cost: 'OTHER-SECRET' } })).data.row.id
  const cm = (await C.asha.post(`/chat/conversations/${open}/messages`, { body: 'machines', cards: [{ kind: 'record', env: 'default', table: t.id, row: meeraRow, fields: ['Code', 'Cost'] }, { kind: 'record', env: 'default', table: t.id, row: other, fields: ['Code'] }, { kind: 'record', env: 'default', table: t.id, row: '00000000-0000-5000-8000-000000000000', fields: ['Code'] }, { kind: 'app', env: 'default', app: 'app_does_not_exist' }].slice(0, 3) })).data.message
  const fullCard = await C.ravi.post('/chat/cards/resolve', { messageId: cm.id, index: 0 })
  const partCard = await C.meera.post('/chat/cards/resolve', { messageId: cm.id, index: 0 })
  ok(4, fullCard.text.includes('COST-SECRET-4711'), 'a full reader sees the chosen fields')
  ok(4, partCard.data.available && !partCard.text.includes('COST-SECRET') && !partCard.text.includes('"Cost"'), 'a reader without access to one column does not get that column (response bytes)')
  const hiddenRow = await C.meera.post('/chat/cards/resolve', { messageId: cm.id, index: 1 })
  const missingRow = await C.meera.post('/chat/cards/resolve', { messageId: cm.id, index: 2 })
  ok(4, hiddenRow.text === missingRow.text && !hiddenRow.text.includes('M-02'), 'a reader without access to the row gets the same answer as for a record that does not exist', hiddenRow.text)
  const am = (await C.asha.post(`/chat/conversations/${open}/messages`, { body: 'an app', cards: [{ kind: 'app', env: 'default', app: 'app_does_not_exist' }] })).data.message
  ok(4, JSON.stringify((await C.meera.post('/chat/cards/resolve', { messageId: am.id, index: 0 })).data) === JSON.stringify({ available: false, kind: 'app' }), 'a reader who may not run the app gets "not available"')
  const hist = await C.nia.get(`/chat/conversations/${open}/messages`)
  ok(4, !hist.text.includes('COST-SECRET') && !hist.text.includes('OTHER-SECRET'), 'messages carry references only, never field values')
  record(4, 'the notification email for a card holds no field value; a record change updates the card', 'SKIP', 'mail and browser part (package E); notification bodies never carry card values (server/core/chat/service.ts notifyMessage)')

  /* ---------------------------------------------------------------- 5 */
  log('check 5: nothing leaks from chat')
  const ns = await C.nia.get('/chat/search?q=photo')
  const nl = await C.nia.get('/chat/conversations')
  ok(5, ns.data.items.length === 0 && !nl.text.includes(priv) && (await C.nia.get(`/chat/conversations/${priv}`)).status === 404, 'for a non-member a private channel is absent from the list and search, and answers 404')
  const writes = await Promise.all(['Channels', 'ChannelMembers', 'Messages', 'MessageReactions'].map((tb) => C.dev.post(`/data/${tb}/rows`, { values: { Name: 'x', Channel: priv, User: ids.nia, Message: fm.id, Emoji: '👍', Body: 'x' } })))
  ok(5, writes.every((r) => r.status >= 400), 'writes to the four chat tables through the generic data API are refused (here: an environment administrator)', writes.map((r) => r.status).join(','))
  const qv = await C.dev.post('/query', { plan: { version: 2, table: 'Messages', select: ['BodyText'] } })
  ok(5, qv.status === 200 && !qv.text.includes('please check') && !qv.text.includes('the photo'), 'an environment administrator who is not a member does not see private messages through Query v2')
  const ex = await C.dev.post(`/chat/admin/channels/${priv}/export`, { reason: 'Exit check: audited export' })
  const audit = await q(`SELECT 1 FROM env_default.ab_audit WHERE action = 'chat.export' AND user_id = $1`, [ids.dev])
  const announced = (await C.meera.get(`/chat/conversations/${priv}/messages`)).data.messages.some((m) => m.event?.type === 'export')
  ok(5, ex.status === 200 && audit.length === 1 && announced, 'an administrator export is audited and announced in the conversation')
  const watch = await sock(C.meera)
  await watch.sub(`chat:${priv}`)
  const tr = Date.now()
  await C.asha.del(`/chat/conversations/${priv}/members/${ids.meera}`)
  let ended = -1
  try { await watch.wait((m) => m.t === 'unsubscribed' && m.topic === `chat:${priv}`, 5000); ended = Date.now() - tr } catch { /* not within 5 s */ }
  const gone = (await C.meera.get('/chat/search?q=please')).data.items.filter((i) => i.message.channelId === priv).length === 0
  ok(5, ended >= 0 && ended < 5000 && gone, 'a removed member stops receiving its messages within 5 s and loses search hits at once', `${ended} ms`)
  record(5, 'the full leak suite (every route, every persona)', 'SKIP', 'not run by this script: npx vitest run server/core/chat/chat-security.integration')

  record(6, 'per-record discussions (Comments in chat\'s Discussions list)', 'SKIP', 'package E')

  /* ---------------------------------------------------------------- 7 */
  log(`check 7: search over ${SCALE} messages`)
  await q(`INSERT INTO env_default.sys_channels ("id", "createdOn", "modifiedOn", "Name", "Kind", "IsPrivate", "LastSeq", "PurgedSeq", "PostingPolicy")
           SELECT md5('s' || g)::uuid::text, now(), now(), 'scale ' || g, 'channel', true, 0, 0, 'everyone' FROM generate_series(1, 200) g`)
  await q(`INSERT INTO env_default.sys_channel_members ("id", "createdOn", "modifiedOn", "Channel", "User", "MemberRole", "LastReadSeq", "NotifyLevel", "Muted")
           SELECT md5('sm' || g)::uuid::text, now(), now(), md5('s' || g)::uuid::text, $1, 'member', 0, 'mentions', false FROM generate_series(1, 20) g`, [ids.nia])
  await q(`INSERT INTO env_default.sys_messages ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Channel", "Body", "BodyText", "Seq", "ChangeSeq", "Kind", "ReplyCount")
           SELECT md5('sg' || g)::uuid::text, now() - (g || ' seconds')::interval, now(), $1, $1, md5('s' || (1 + g % 200))::uuid::text, 'x',
                  'machine ' || (g % 97) || ' downtime report ' || CASE WHEN g % 200 = 150 THEN 'secretword' ELSE 'normal' END, (g / 200) + 1, (g / 200) + 1, 'message', 0
             FROM generate_series(1, $2::int) g`, [ids.asha, SCALE])
  await q('ANALYZE env_default.sys_messages')
  const allowed = new Set([...(await q('SELECT "Channel" AS c FROM env_default.sys_channel_members WHERE "User" = $1', [ids.nia])).map((r) => r.c),
    ...(await q(`SELECT id AS c FROM env_default.sys_channels WHERE "Kind" = 'channel' AND "IsPrivate" = false AND "ArchivedOn" IS NULL`)).map((r) => r.c)])
  const times = []
  let outside = 0
  for (let i = 0; i < 40; i++) {
    const s = Date.now()
    const r = await C.nia.get(`/chat/search?q=${['downtime', 'machine 4', 'report normal', 'machine'][i % 4]}`)
    times.push(Date.now() - s)
    for (const it of r.data.items) if (!allowed.has(it.message.channelId)) outside++
  }
  ok(7, outside === 0, 'a member of 20 channels sees hits only from those 20 (and open channels)', `${outside} hits outside`)
  ok(7, p95(times) < 500, 'search p95 under 500 ms on the sandbox', `p95 ${p95(times)} ms, ${SCALE} messages in 200 channels`)
  ok(7, (await C.nia.get('/chat/search?q=secretword')).data.items.length === 0, 'a word that occurs only in a private channel returns nothing to a non-member')

  /* ---------------------------------------------------------------- 8 */
  log('check 8: retention, moderation, audit')
  await C.dev.put('/chat/admin/settings', { retention: { channel: 30 } })
  const oldMsg = (await C.asha.post(`/chat/conversations/${open}/messages`, { body: 'very old' })).data.message
  await q(`UPDATE env_default.sys_messages SET "createdOn" = now() - interval '31 days' WHERE id = $1`, [oldMsg.id])
  const ret = await C.dev.post('/chat/admin/retention/run')
  const stillThere = (await q('SELECT 1 FROM env_default.sys_messages WHERE id = $1', [oldMsg.id])).length
  const chg = (await C.ravi.get(`/chat/conversations/${open}/changes?after=1`)).data
  ok(8, ret.status === 200 && stillThere === 0 && chg.reset === true, 'retention 30 days, clock moved 31 days: older messages are gone and clients reload cleanly (reset)', JSON.stringify(ret.data))
  await C.dev.put('/chat/admin/settings', { retention: { channel: null } })
  const bad = (await C.ravi.post(`/chat/conversations/${open}/messages`, { body: 'not nice' })).data.message
  await C.asha.post(`/chat/messages/${bad.id}/report`, { reason: 'not nice' })
  const rep = (await C.dev.get('/chat/admin/reports')).data.items.find((r) => r.message.id === bad.id)
  await C.dev.post(`/chat/admin/reports/${rep.id}`, { action: 'delete' })
  const side = (await C.asha.post('/chat/conversations', { kind: 'channel', name: 'Side', isPrivate: true, members: [ids.ravi] })).data.id
  await C.dev.post(`/chat/admin/channels/${side}/archive`, { archived: true })
  await C.dev.del(`/chat/admin/channels/${side}/members/${ids.ravi}`)
  await C.dev.post('/chat/admin/readonly', { userId: ids.ravi, readOnly: true })
  const ro = await C.ravi.post(`/chat/conversations/${open}/messages`, { body: 'x' })
  const acts = (await q(`SELECT action, details::text AS d FROM env_default.ab_audit WHERE action LIKE 'chat.%' AND user_id = $1`, [ids.dev]))
  const need = ['chat.report.handle', 'chat.channel.archive', 'chat.member.remove', 'chat.readonly', 'chat.settings']
  ok(8, ro.status === 403, 'a person made read-only in chat cannot post')
  ok(8, need.every((a) => acts.some((x) => x.action === a)) && !acts.some((x) => x.d.includes('not nice') && x.action !== 'chat.report.handle'), 'every administrator action is in the audit log with who, when and what (not message text)', acts.map((a) => a.action).join(', '))
} catch (e) {
  failures++
  record('-', 'the run', 'FAIL', String(e?.stack ?? e).slice(0, 600))
} finally {
  for (const s of socks) s.close()
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())) }
  if (app) await app.close().catch(() => {})
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
}

console.log('\n| Check | What | Result | Evidence |\n| --- | --- | --- | --- |')
for (const r of results) console.log(`| ${r.check} | ${r.name.replace(/\|/g, '/')} | ${r.status} | ${String(r.evidence).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 200)} |`)
console.log(`\n${failures ? `FAIL: ${failures} check(s) failed` : 'PASS (SKIP lines are other packages\' parts)'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
process.exit(failures ? 1 : 0)
