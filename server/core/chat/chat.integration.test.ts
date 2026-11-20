/**
 * Chat behaviour (P3 package A, docs/dev/chat.md) against a real PostgreSQL, with chat moved to its own environment
 * ("Chat home") before anything is written: the change counter stays contiguous under 50 parallel senders; gap recovery
 * through /changes; history pages; idempotent sends (clientId); threads, edits, deletes, reactions; notification
 * idempotency and the digest relevance check; retention with a moved clock; moderation and its audit trail; read-only
 * people; typing; an environment copy never takes chat; the chat environment cannot be deleted while it holds messages;
 * the schema 13 -> 14 upgrade. The search scale run (100,000 messages) runs with APPBUILDER_BENCH=1.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/chat/chat.integration
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { ROLE_VIEWER } from '../auth.ts'
import { createDelivery } from '../notifications-delivery.ts'
import { runInEnvironment } from '../env-context.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[chat integration] ${SKIP_PG}\n`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* eslint-disable @typescript-eslint/no-explicit-any */

class P {
  cookie = ''
  base: string
  constructor(base: string) {
    this.base = base
  }
  async req(method: string, p: string, body?: unknown, o: { raw?: Buffer; type?: string } = {}): Promise<{ status: number; data: any; text: string }> {
    const headers: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    let payload: BodyInit | undefined
    if (o.raw) {
      headers['Content-Type'] = o.type ?? 'application/octet-stream'
      payload = new Uint8Array(o.raw)
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await fetch(this.base + '/api/v1' + p, { method, headers, body: payload })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    const text = await res.text()
    let data: any = text
    try { data = JSON.parse(text) } catch { /* text */ }
    return { status: res.status, data, text }
  }
  get = (p: string) => this.req('GET', p)
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  patch = (p: string, b: unknown) => this.req('PATCH', p, b)
  put = (p: string, b: unknown) => this.req('PUT', p, b)
  del = (p: string, b?: unknown) => this.req('DELETE', p, b)
}

class Sock {
  ws: WebSocket
  msgs: any[] = []
  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())))
    this.ws.on('error', () => {})
  }
  async waitMsg(pred: (m: any) => boolean, ms = 8000): Promise<any> {
    const end = Date.now() + ms
    for (;;) {
      const m = this.msgs.find(pred)
      if (m) return m
      if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(this.msgs.slice(-3))}`)
      await sleep(30)
    }
  }
  async sub(topic: string) {
    const id = Math.random().toString(36).slice(2)
    this.ws.send(JSON.stringify({ t: 'sub', id, topic }))
    return this.waitMsg((m) => m.id === id)
  }
  close() { this.ws.terminate() }
}

const ENV = 'chat_home'
const S = `env_${ENV}`

describe.skipIf(!PG_URL)('chat (PostgreSQL)', { timeout: 180_000 }, () => {
  let h: KernelHarness
  let srv: http.Server
  let base = ''
  let wsUrl = ''
  const C: Record<string, P> = {}
  const ids: Record<string, string> = {}
  const socks: Sock[] = []
  let chan = ''

  const sock = (p: P) => {
    const s = new Sock(wsUrl, { Origin: base, Cookie: p.cookie })
    socks.push(s)
    return s
  }

  beforeAll(async () => {
    h = await startHarness('chat', { jobs: false, env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    srv = http.createServer((req, res) => { void h.app.handle(req, res).then((x) => { if (!x) res.writeHead(404).end() }) })
    srv.on('upgrade', (req, socket, head) => { if (!h.app.handleUpgrade(req, socket, head)) socket.destroy() })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    wsUrl = base.replace('http', 'ws') + '/api/v1/live'
    C.ada = new P(base)
    expect((await C.ada.post('/auth/login', { email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
    // chat moves to its own environment while it is empty
    const e = await C.ada.post('/environments', { name: 'Chat home', type: 'production' })
    expect(e.status, e.text).toBe(200)
    expect(e.data.id).toBe(ENV)
    const st = await C.ada.put('/chat/admin/settings', { environmentId: ENV })
    expect(st.status, st.text).toBe(200)
    expect(st.data.environmentId).toBe(ENV)
    for (const [name, key] of [['Asha', 'asha'], ['Ravi', 'ravi'], ['Meera', 'meera'], ['Dev Admin', 'dev']] as const) {
      const u = await C.ada.post('/users', { name, email: `${key}@example.com`, roleIds: [ROLE_VIEWER], password: 'some-password-1' })
      expect(u.status, u.text).toBe(200)
      ids[key] = u.data.id
      await h.q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [u.data.id])
      expect((await C.ada.put(`/environments/${ENV}/access/${u.data.id}`, key === 'dev' ? { isEnvAdmin: true } : {})).status).toBe(200)
      C[key] = new P(base)
      expect((await C[key].post('/auth/login', { email: `${key}@example.com`, password: 'some-password-1' })).status).toBe(200)
    }
    ids.ada = (await C.ada.get('/auth/session')).data.user.id
    // the environment administrator of the chat environment is an administrator in chat
    const me = await C.dev.get('/chat/me')
    expect(me.data).toMatchObject({ environmentId: ENV, isAdmin: true })
    const c = await C.asha.post('/chat/conversations', { kind: 'channel', name: 'Plant floor', isPrivate: true, members: [ids.ravi, ids.meera] })
    expect(c.status, c.text).toBe(200)
    chan = c.data.id
  }, 240_000)

  afterAll(async () => {
    for (const s of socks) s.close()
    await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()))
    await h?.close()
  }, 60_000)

  it('chat rows live in the chat environment, not in Default', async () => {
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ${S}.sys_channels`))[0].n).toBe(1)
    expect((await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.sys_channels'))[0].n).toBe(0)
  })

  it('the change counter is contiguous under 50 parallel senders; every push arrives with prev = seq - 1', async () => {
    const s = sock(C.meera)
    await s.waitMsg((m) => m.t === 'hello')
    const ack = await s.sub(`chat:${chan}`)
    expect(ack.t).toBe('subscribed')
    const start = ack.seq as number
    const senders = [C.asha, C.ravi, C.meera]
    const res = await Promise.all(Array.from({ length: 50 }, (_, i) => senders[i % 3].post(`/chat/conversations/${chan}/messages`, { body: `parallel ${i}`, clientId: `par-${i}-abcdefgh` })))
    expect(res.map((r) => r.status)).toEqual(Array(50).fill(200))
    const seqs = res.map((r) => r.data.message.seq).sort((a: number, b: number) => a - b)
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => start + 1 + i))
    await s.waitMsg(() => s.msgs.filter((m) => m.t === 'chat').length >= 50)
    const pushes = s.msgs.filter((m) => m.t === 'chat')
    for (const p of pushes) expect(p.prev).toBe(p.seq - 1)
    expect(new Set(pushes.map((p) => p.seq)).size).toBe(50)
    // in order on the socket (the hub orders pushes per channel)
    const order = pushes.map((p) => p.seq)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const db = await h.q<{ last: string }>(`SELECT "LastSeq"::text AS last FROM ${S}.sys_channels WHERE id = $1`, [chan])
    expect(Number(db[0].last)).toBe(start + 50)
  })

  it('a retried send with the same clientId is one message; gap recovery returns every change after a seq', async () => {
    const a = await C.asha.post(`/chat/conversations/${chan}/messages`, { body: 'once only', clientId: 'retry-1234567' })
    const b = await C.asha.post(`/chat/conversations/${chan}/messages`, { body: 'once only', clientId: 'retry-1234567' })
    expect(a.data.message.id).toBe(b.data.message.id)
    expect(b.data.duplicate).toBe(true)
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ${S}.sys_messages WHERE "BodyText" = 'once only'`))[0].n).toBe(1)
    const after = a.data.message.seq - 1
    await C.ravi.post(`/chat/messages/${a.data.message.id}/reactions`, { emoji: '🎉' })
    await C.asha.patch(`/chat/messages/${a.data.message.id}`, { body: 'once only (edited)' })
    const ch = await C.meera.get(`/chat/conversations/${chan}/changes?after=${after}`)
    expect(ch.status, ch.text).toBe(200)
    expect(ch.data.reset).toBe(false)
    const m = ch.data.messages.find((x: any) => x.id === a.data.message.id)
    expect(m).toMatchObject({ text: 'once only (edited)', reactions: [{ emoji: '🎉', users: [ids.ravi] }] })
    expect(m.editedOn).toBeTruthy()
    expect(ch.data.lastSeq).toBe(m.changeSeq)
  })

  it('history pages 50 at a time from the server; threads keep one level with a reply count', async () => {
    const p1 = await C.ravi.get(`/chat/conversations/${chan}/messages?limit=50`)
    expect(p1.data.messages).toHaveLength(50)
    expect(p1.data.more).toBe(true)
    const p2 = await C.ravi.get(`/chat/conversations/${chan}/messages?before=${p1.data.messages[0].seq}`)
    expect(p2.data.messages.length).toBeGreaterThan(0)
    expect(p2.data.messages[p2.data.messages.length - 1].seq).toBeLessThan(p1.data.messages[0].seq)
    const root = p1.data.messages[p1.data.messages.length - 1]
    const r1 = await C.meera.post(`/chat/conversations/${chan}/messages`, { body: 'a reply', parent: root.id })
    expect(r1.status, r1.text).toBe(200)
    expect((await C.meera.post(`/chat/conversations/${chan}/messages`, { body: 'nested', parent: r1.data.message.id })).status).toBe(422)
    const rep = await C.asha.get(`/chat/messages/${root.id}/replies`)
    expect(rep.data.root.replyCount).toBe(1)
    expect(rep.data.messages.map((x: any) => x.text)).toEqual(['a reply'])
    // replies are not in the main history
    expect((await C.asha.get(`/chat/conversations/${chan}/messages`)).data.messages.some((x: any) => x.id === r1.data.message.id)).toBe(false)
  })

  it('delete leaves a "deleted" line; others cannot edit or delete it; system messages are not editable', async () => {
    const m = await C.ravi.post(`/chat/conversations/${chan}/messages`, { body: 'to be deleted' })
    expect((await C.asha.patch(`/chat/messages/${m.data.message.id}`, { body: 'hijack' })).status).toBe(403)
    expect((await C.asha.del(`/chat/messages/${m.data.message.id}`)).status).toBe(403)
    expect((await C.ravi.del(`/chat/messages/${m.data.message.id}`)).status).toBe(200)
    const v = (await C.asha.get(`/chat/conversations/${chan}/changes?after=${m.data.message.seq - 1}`)).data.messages.find((x: any) => x.id === m.data.message.id)
    expect(v).toMatchObject({ deleted: true, body: '', text: '', moderated: false })
    const sys = (await C.asha.get(`/chat/conversations/${chan}/changes?after=0`)).data.messages.find((x: any) => x.kind === 'system')
    expect((await C.asha.patch(`/chat/messages/${sys.id}`, { body: 'x' })).status).toBe(403)
  })

  it('notifications: one per message and person (idempotent), mentions in edits notify the newly mentioned once; mute and none', async () => {
    const count = async (who: string) => (await C[who].get('/notifications?limit=100')).data.items.filter((n: any) => n.kind === 'chat').length
    const before = await count('meera')
    const m = await C.asha.post(`/chat/conversations/${chan}/messages`, { body: `<span data-mention="${ids.ravi}">@Ravi</span> check line 2` })
    expect(m.status).toBe(200)
    await sleep(100)
    expect(await count('meera')).toBe(before) // channel default: mentions only
    const rv = (await C.ravi.get('/notifications?limit=100')).data.items.filter((n: any) => n.kind === 'chat' && n.link === `#chat?c=${chan}&m=${m.data.message.seq}`)
    expect(rv).toHaveLength(1)
    expect(rv[0].title).toBe('Asha mentioned you in #Plant floor')
    // an edit that adds Meera notifies Meera once; Ravi is not told again
    await C.asha.patch(`/chat/messages/${m.data.message.id}`, { body: `<span data-mention="${ids.ravi}">@Ravi</span> <span data-mention="${ids.meera}">@Meera</span> check line 2` })
    await C.asha.patch(`/chat/messages/${m.data.message.id}`, { body: `<span data-mention="${ids.ravi}">@Ravi</span> <span data-mention="${ids.meera}">@Meera</span> check line 2 !` })
    await sleep(100)
    expect(await count('meera')).toBe(before + 1)
    expect((await C.ravi.get('/notifications?limit=100')).data.items.filter((n: any) => n.link === `#chat?c=${chan}&m=${m.data.message.seq}`)).toHaveLength(1)
    // muted: nothing, even for a mention
    expect((await C.meera.patch(`/chat/conversations/${chan}/me`, { muted: true })).status).toBe(200)
    await C.asha.post(`/chat/conversations/${chan}/messages`, { body: `<span data-mention="${ids.meera}">@Meera</span> muted?` })
    await sleep(100)
    expect(await count('meera')).toBe(before + 1)
    await C.meera.patch(`/chat/conversations/${chan}/me`, { muted: false })
    // direct messages notify (level all by default); reading the conversation marks them read
    const dm = await C.asha.post('/chat/conversations', { kind: 'direct', members: [ids.meera] })
    expect((await C.asha.post('/chat/conversations', { kind: 'direct', members: [ids.meera] })).data.id).toBe(dm.data.id)
    const sent = await C.asha.post(`/chat/conversations/${dm.data.id}/messages`, { body: 'hello Meera' })
    await sleep(100)
    const n = (await C.meera.get('/notifications?limit=100')).data.items.find((x: any) => x.link === `#chat?c=${dm.data.id}&m=${sent.data.message.seq}`)
    expect(n).toMatchObject({ title: 'Asha sent you a message', readOn: null })
    const conv = (await C.meera.get('/chat/conversations')).data.items.find((x: any) => x.id === dm.data.id)
    expect(conv).toMatchObject({ unread: 1, kind: 'direct', name: 'Asha' })
    const read = await C.meera.post(`/chat/conversations/${dm.data.id}/read`, { seq: sent.data.message.seq })
    expect(read.data).toMatchObject({ unread: 0, mentions: 0 })
    const n2 = (await C.meera.get('/notifications?limit=100')).data.items.find((x: any) => x.id === n.id)
    expect(n2.readOn).toBeTruthy()
    expect((await C.meera.post(`/chat/conversations/${dm.data.id}/leave`)).status).toBe(422)
  })

  it('digest relevance: a chat item read before the digest (or no longer readable) is dropped with the reason', async () => {
    const m = await C.asha.post(`/chat/conversations/${chan}/messages`, { body: `<span data-mention="${ids.ravi}">@Ravi</span> digest me` })
    const link = `#chat?c=${chan}&m=${m.data.message.seq}`
    const dlv = 'dlv_chattest000000001'
    await h.q(`INSERT INTO ab.notification_deliveries (id, at, user_id, notification_id, environment_id, kind, title, channel, status, reason, mail_id) VALUES ($1, now(), $2, NULL, $3, 'chat', 't', 'email', 'digest', 'r', NULL)`, [dlv, ids.ravi, ENV])
    await h.q(`INSERT INTO ab.notification_digest (id, user_id, kind, title, body, link, environment_id, created_on, reason, hold_until, delivery_id) VALUES ('dgi_chattest1', $1, 'chat', 't', 'b', $2, $3, now() - interval '2 hours', 'r', NULL, $4)`, [ids.ravi, link, ENV, dlv])
    // still unread: kept
    await runInEnvironment('default', () => createDelivery(h.app.services).runDigests(new Date(Date.now() + 2 * 86400_000)))
    expect((await h.q('SELECT 1 FROM ab.notification_digest WHERE id = $1', ['dgi_chattest1'])).length).toBe(1)
    // read: dropped with the reason
    await C.ravi.post(`/chat/conversations/${chan}/read`, { seq: m.data.message.seq })
    await runInEnvironment('default', () => createDelivery(h.app.services).runDigests(new Date(Date.now() + 3 * 86400_000)))
    expect((await h.q('SELECT 1 FROM ab.notification_digest WHERE id = $1', ['dgi_chattest1'])).length).toBe(0)
    const d = await h.q<{ status: string; reason: string }>('SELECT status, reason FROM ab.notification_deliveries WHERE id = $1', [dlv])
    expect(d[0]).toEqual({ status: 'dropped', reason: 'Read before the digest.' })
  })

  it('files: upload, send, open for members; over the limit refused before upload; a file of someone else cannot be claimed', async () => {
    const up = await C.asha.req('POST', `/chat/conversations/${chan}/files?name=pump%20photo.jpg`, undefined, { raw: Buffer.from('JPEGDATA'), type: 'image/jpeg' })
    expect(up.status, up.text).toBe(200)
    expect((await C.ravi.post(`/chat/conversations/${chan}/messages`, { body: 'steal', files: [up.data.id] })).status).toBe(422)
    const m = await C.asha.post(`/chat/conversations/${chan}/messages`, { body: 'the pump', files: [up.data.id] })
    expect(m.status, m.text).toBe(200)
    expect(m.data.message.files[0]).toMatchObject({ name: 'pump photo.jpg', mime: 'image/jpeg', size: 8 })
    const f = await C.meera.get(m.data.message.files[0].url.replace('/api/v1', ''))
    expect(f.status).toBe(200)
    expect(f.text).toBe('JPEGDATA')
    // the same file cannot be named by a second message
    expect((await C.asha.post(`/chat/conversations/${chan}/messages`, { body: 'again', files: [up.data.id] })).status).toBe(422)
    // too big: refused from the declared length, before the body is read
    const big = await fetch(`${base}/api/v1/chat/conversations/${chan}/files?name=big.bin`, { method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: C.asha.cookie, 'Content-Type': 'application/octet-stream', 'Content-Length': String(26 * 1024 * 1024) }, body: new Uint8Array(1024), duplex: 'half' } as any).catch(() => null)
    if (big) expect(big.status).toBe(413)
    // the file name is found by search
    expect((await C.ravi.get('/chat/search?q=pump%20photo')).data.items.map((i: any) => i.message.id)).toContain(m.data.message.id)
  })

  it('typing reaches other readers, at most one per person per 3 s; never the typer', async () => {
    const s = sock(C.ravi)
    await s.waitMsg((m) => m.t === 'hello')
    expect((await s.sub(`chat:typing:${chan}`)).t).toBe('subscribed')
    const mine = sock(C.asha)
    await mine.waitMsg((m) => m.t === 'hello')
    await mine.sub(`chat:typing:${chan}`)
    await C.asha.post(`/chat/conversations/${chan}/typing`)
    await C.asha.post(`/chat/conversations/${chan}/typing`)
    await s.waitMsg((m) => m.t === 'typing' && m.userId === ids.asha)
    await sleep(200)
    expect(s.msgs.filter((m) => m.t === 'typing')).toHaveLength(1)
    expect(mine.msgs.filter((m) => m.t === 'typing')).toHaveLength(0)
  })

  it('moderation, reports, read-only people, archive, member removal: every administrator action is audited without message text', async () => {
    const m = await C.ravi.post(`/chat/conversations/${chan}/messages`, { body: 'rude words here' })
    expect((await C.meera.post(`/chat/messages/${m.data.message.id}/report`, { reason: 'abusive' })).status).toBe(200)
    const reps = await C.dev.get('/chat/admin/reports')
    expect(reps.status, reps.text).toBe(200)
    const rep = reps.data.items.find((x: any) => x.message.id === m.data.message.id)
    expect(rep).toMatchObject({ reason: 'abusive', message: { text: 'rude words here' }, reporter: { name: 'Meera' } })
    expect((await C.dev.post(`/chat/admin/reports/${rep.id}`, { action: 'delete' })).status).toBe(200)
    const v = (await C.asha.get(`/chat/conversations/${chan}/changes?after=${m.data.message.seq - 1}`)).data.messages.find((x: any) => x.id === m.data.message.id)
    expect(v).toMatchObject({ deleted: true, moderated: true, text: '' })
    // a moderator delete of another message, read-only, archive, member removal
    const m2 = await C.ravi.post(`/chat/conversations/${chan}/messages`, { body: 'second rude one' })
    expect((await C.dev.post(`/chat/admin/messages/${m2.data.message.id}/moderate`, {})).status).toBe(200)
    expect((await C.dev.post('/chat/admin/readonly', { userId: ids.ravi, readOnly: true })).status).toBe(200)
    const ro = await C.ravi.post(`/chat/conversations/${chan}/messages`, { body: 'can I?' })
    expect(ro.status).toBe(403)
    expect(ro.data.error.message).toMatch(/read-only in chat/)
    expect((await C.ravi.get(`/chat/conversations/${chan}/messages`)).status).toBe(200)
    expect((await C.dev.post('/chat/admin/readonly', { userId: ids.ravi, readOnly: false })).status).toBe(200)
    const side = await C.asha.post('/chat/conversations', { kind: 'channel', name: 'Side room', isPrivate: true, members: [ids.ravi] })
    expect((await C.dev.post(`/chat/admin/channels/${side.data.id}/archive`, { archived: true })).status).toBe(200)
    expect((await C.asha.post(`/chat/conversations/${side.data.id}/messages`, { body: 'archived?' })).status).toBe(403)
    expect((await C.dev.del(`/chat/admin/channels/${side.data.id}/members/${ids.ravi}`)).status).toBe(200)
    expect((await C.ravi.get(`/chat/conversations/${side.data.id}`)).status).toBe(404)
    const audit = await h.q<{ action: string; details: any; user_id: string; at: Date }>(`SELECT action, details, user_id, at FROM ${S}.ab_audit WHERE action LIKE 'chat.%' ORDER BY id`)
    const actions = audit.map((a) => a.action)
    for (const a of ['chat.report.handle', 'chat.message.moderate', 'chat.readonly', 'chat.channel.archive', 'chat.member.remove']) expect(actions).toContain(a)
    for (const a of audit) {
      expect(a.at).toBeTruthy()
      const t = JSON.stringify(a.details)
      expect(t).not.toContain('rude')
      expect(t).not.toContain('second rude')
    }
    expect(audit.find((a) => a.action === 'chat.message.moderate')!.user_id).toBe(ids.dev)
  })

  it('retention: 30 days, the clock moved 31 days: older messages and their files are gone, clients reload (reset)', async () => {
    expect((await C.dev.put('/chat/admin/settings', { retention: { channel: 29 } })).status).toBe(422)
    expect((await C.dev.put('/chat/admin/settings', { retention: { channel: 30 } })).status).toBe(200)
    const up = await C.asha.req('POST', `/chat/conversations/${chan}/files?name=old.txt`, undefined, { raw: Buffer.from('OLD'), type: 'text/plain' })
    const old = await C.asha.post(`/chat/conversations/${chan}/messages`, { body: 'an old message', files: [up.data.id] })
    const fresh = await C.asha.post(`/chat/conversations/${chan}/messages`, { body: 'a fresh message' })
    const total = (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ${S}.sys_messages WHERE "Channel" = $1`, [chan]))[0].n
    // the clock moves 31 days: every message of the channel but the fresh one is now older than 30 days
    await h.q(`UPDATE ${S}.sys_messages SET "createdOn" = "createdOn" - interval '31 days' WHERE "Channel" = $1 AND id <> $2`, [chan, fresh.data.message.id])
    const s = sock(C.meera)
    await s.waitMsg((m) => m.t === 'hello')
    await s.sub(`chat:${chan}`)
    const r = await C.dev.post('/chat/admin/retention/run')
    expect(r.status, r.text).toBe(200)
    expect(r.data.messages).toBe(total - 1)
    expect(r.data.files).toBeGreaterThanOrEqual(1)
    expect((await C.meera.get(old.data.message.files[0].url.replace('/api/v1', ''))).status).toBe(404)
    expect((await h.q('SELECT 1 FROM ' + S + '.ab_attachments WHERE id = $1', [up.data.id])).length).toBe(0)
    const left = await C.meera.get(`/chat/conversations/${chan}/messages`)
    expect(left.data.messages.map((x: any) => x.text)).toEqual(['a fresh message'])
    const ch = await C.meera.get(`/chat/conversations/${chan}/changes?after=1`)
    expect(ch.data.reset).toBe(true)
    expect(ch.data.purgedSeq).toBe(ch.data.lastSeq)
    const push = await s.waitMsg((m) => m.t === 'chat' && m.op === 'channel' && m.seq === ch.data.purgedSeq)
    expect(push.prev).toBe(push.seq - 1)
    expect((await C.dev.put('/chat/admin/settings', { retention: { channel: null } })).status).toBe(200)
  })

  it('an environment copy never takes chat; the chat environment cannot be deleted while it holds messages; chat cannot move while it has messages', async () => {
    const cp = await C.ada.post('/environments', { name: 'Chat copy', type: 'sandbox', copyFrom: ENV, copy: 'data' })
    expect(cp.status, cp.text).toBe(200)
    const cs = `env_${cp.data.id}`
    for (const t of ['sys_channels', 'sys_channel_members', 'sys_messages', 'sys_message_reactions']) {
      expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ${cs}.${t}`))[0].n, t).toBe(0)
    }
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ${cs}.ab_attachments WHERE table_id = 'sys_messages'`))[0].n).toBe(0)
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ${cs}.sys_mentions WHERE "regardingTable" = 'sys_messages'`))[0].n).toBe(0)
    const del = await C.ada.del(`/environments/${ENV}`, { confirmName: 'Chat home', proceedWithoutBackup: true })
    expect(del.status, del.text).toBe(409)
    expect(del.data.error.message).toMatch(/holds the install's chat/)
    expect((await C.ada.put('/chat/admin/settings', { environmentId: 'default' })).status).toBe(409)
    expect((await C.dev.put('/chat/admin/settings', { environmentId: 'default' })).status).toBe(403)
  })

  it('schema 13 -> 14: the chat tables appear, nothing else changes; the step refuses a schema that lost one', async () => {
    const before = (await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.ab_tables'))[0].n
    await h.q('DROP TABLE env_default.ab_chat_reports, env_default.ab_chat_exports')
    await h.q(`UPDATE ab.environments SET schema_version = 13 WHERE id = 'default'`)
    const { migrateEnvironmentSchema, SCHEMA_VERSION } = await import('../meta-store.ts')
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14)
    expect(await migrateEnvironmentSchema(h.app.services.state.db!, { id: 'default', schema: 'env_default' })).toEqual({ from: 13, to: SCHEMA_VERSION })
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name LIKE 'ab_chat_%'`))[0].n).toBe(2)
    expect((await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.ab_tables'))[0].n).toBe(before)
    // the new columns and indexes of the communication tables are there
    const cols = (await h.q<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'env_default' AND table_name = 'sys_messages'`)).map((r) => r.c)
    for (const c of ['Seq', 'ChangeSeq', 'BodyText', 'Cards', 'Files', 'MentionIds', 'ReplyCount', 'DeletedBy']) expect(cols).toContain(c)
    expect((await h.q(`SELECT 1 FROM pg_indexes WHERE schemaname = 'env_default' AND indexname = 'ab_ix_chat_msg_fts'`)).length).toBe(1)
    const { upgradeEnvironmentTo14Chat } = await import('./ddl.ts')
    await h.q('DROP TABLE env_default.ab_chat_exports')
    await expect(upgradeEnvironmentTo14Chat(h.app.services.state.db!, 'env_default')).rejects.toThrow(/ab_chat_exports is missing/)
  })

  it.skipIf(!process.env.APPBUILDER_BENCH)('BENCH search: 100,000 messages in 200 channels; a member of 20 sees only those (and open ones); p95', async () => {
    const asha = ids.asha
    await h.q(`INSERT INTO ${S}.sys_channels ("id", "createdOn", "modifiedOn", "Name", "Kind", "IsPrivate", "LastSeq", "PurgedSeq", "PostingPolicy")
      SELECT md5('bench' || g)::uuid::text, now(), now(), 'bench ' || g, 'channel', true, 500, 0, 'everyone' FROM generate_series(1, 200) g`)
    await h.q(`INSERT INTO ${S}.sys_channel_members ("id", "createdOn", "modifiedOn", "Channel", "User", "MemberRole", "LastReadSeq", "NotifyLevel", "Muted")
      SELECT md5('benchm' || g)::uuid::text, now(), now(), md5('bench' || g)::uuid::text, $1, 'member', 0, 'mentions', false FROM generate_series(1, 20) g`, [asha])
    await h.q(`INSERT INTO ${S}.sys_messages ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Channel", "Body", "BodyText", "Seq", "ChangeSeq", "Kind", "ReplyCount")
      SELECT md5('benchmsg' || g)::uuid::text, now() - (g || ' seconds')::interval, now(), $1, $1, md5('bench' || (1 + g % 200))::uuid::text, 'x',
             'machine ' || (g % 97) || ' report ' || CASE WHEN g % 200 = 150 THEN 'onlyinprivate' ELSE 'common' END || ' shift ' || (g % 3), (g / 200) + 1, (g / 200) + 1, 'message', 0
        FROM generate_series(1, 100000) g`, [asha])
    await h.q(`ANALYZE ${S}.sys_messages`)
    const times: number[] = []
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now()
      const r = await C.asha.get(`/chat/search?q=${i % 2 ? 'report' : 'machine 4'}`)
      times.push(performance.now() - t0)
      expect(r.status).toBe(200)
      const allowed = new Set((await h.q<{ id: string }>(`SELECT "Channel" AS id FROM ${S}.sys_channel_members WHERE "User" = $1`, [asha])).map((x) => x.id))
      for (const it of r.data.items) expect(allowed.has(it.message.channelId)).toBe(true)
    }
    // a word only in channel 151 (Asha is not a member): nothing for her
    expect((await C.asha.get('/chat/search?q=onlyinprivate')).data.items).toEqual([])
    times.sort((a, b) => a - b)
    const p95 = times[Math.floor(times.length * 0.95)]
    process.stdout.write(`[bench] chat search p95 ${p95.toFixed(0)} ms, median ${times[20].toFixed(0)} ms over 100,000 messages\n`)
  }, 600_000)
})
