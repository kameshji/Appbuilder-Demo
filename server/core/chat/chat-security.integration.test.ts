/**
 * THE CHAT LEAK SUITE (P3 package A, exit check 5 server side; docs/dev/chat.md "Security"). Against a real PostgreSQL,
 * over HTTP and WebSocket, as different people: a member (positive control), a non-member, a maker, an environment
 * administrator, an install administrator, a user of another environment, an API key (service account with the
 * administrator role) and an anonymous client. Proves, by checking the response BYTES:
 *  - a private channel, a direct and a group conversation, their messages, members, reactions, files and their existence
 *    are invisible to non-members on every chat route AND on the generic routes (Query v2 rows / count / aggregate /
 *    search, data API v1 and v2 reads and writes, CSV export, attachments, the environment data export, a backup's table
 *    browser, live subscriptions, the notification feed and the Mentions page, the dashboards batch endpoint, print
 *    templates, flows' data steps);
 *  - writes to the four chat tables through the generic data API are refused for everyone;
 *  - cards never return a field or a row the reader may not read (and say "not available" alike for a hidden and a
 *    missing row); mentions do not notify people about conversations they cannot see (they are refused);
 *  - search never ranks or counts hidden messages; a removed member loses the conversation at once and on the socket.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/chat/chat-security.integration
 */
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { ROLE_ADMIN, ROLE_MAKER, ROLE_VIEWER } from '../auth.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[chat security integration] ${SKIP_PG}\n`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* eslint-disable @typescript-eslint/no-explicit-any */

/** an HTTP client: cookie session or API key; keeps the raw response text */
class P {
  cookie = ''
  bearer = ''
  base: string
  label: string
  constructor(base: string, label: string) {
    this.base = base
    this.label = label
  }
  async req(method: string, p: string, body?: unknown, o: { raw?: Buffer; type?: string; env?: string } = {}): Promise<{ status: number; data: any; text: string; bytes: Buffer }> {
    const headers: Record<string, string> = {}
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`
    else headers['X-Appbuilder'] = '1'
    if (this.cookie) headers.Cookie = this.cookie
    if (o.env) headers['X-Appbuilder-Environment'] = o.env
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
    const bytes = Buffer.from(await res.arrayBuffer())
    const text = bytes.toString('utf8')
    let data: any = text
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try { data = JSON.parse(text) } catch { /* keep text */ }
    }
    return { status: res.status, data, text, bytes }
  }
  get = (p: string, env?: string) => this.req('GET', p, undefined, { env })
  post = (p: string, b?: unknown, env?: string) => this.req('POST', p, b ?? {}, { env })
  patch = (p: string, b: unknown) => this.req('PATCH', p, b)
  put = (p: string, b: unknown) => this.req('PUT', p, b)
  del = (p: string, b?: unknown) => this.req('DELETE', p, b)
}

class Sock {
  ws: WebSocket
  msgs: any[] = []
  raw: string[] = []
  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (d) => { this.raw.push(d.toString()); this.msgs.push(JSON.parse(d.toString())) })
    this.ws.on('error', () => {})
  }
  async waitMsg(pred: (m: any) => boolean, ms = 6000): Promise<any> {
    const end = Date.now() + ms
    for (;;) {
      const m = this.msgs.find(pred)
      if (m) return m
      if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(this.msgs.slice(-4))}`)
      await sleep(40)
    }
  }
  async sub(topic: string, env?: string) {
    const id = Math.random().toString(36).slice(2)
    this.ws.send(JSON.stringify({ t: 'sub', id, topic, ...(env ? { env } : {}) }))
    return this.waitMsg((m) => m.id === id)
  }
  close() { this.ws.terminate() }
}

/** the files of a ZIP (central directory; deflate or stored) */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip')
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extra = buf.readUInt16LE(p + 30)
    const comment = buf.readUInt16LE(p + 32)
    const off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const lname = buf.readUInt16LE(off + 26)
    const lextra = buf.readUInt16LE(off + 28)
    const data = buf.subarray(off + 30 + lname + lextra, off + 30 + lname + lextra + csize)
    out.set(name, (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'))
    p += 46 + nameLen + extra + comment
  }
  return out
}

describe.skipIf(!PG_URL)('chat leak suite (PostgreSQL)', { timeout: 180_000 }, () => {
  let h: KernelHarness
  let live: http.Server
  let base = ''
  let wsUrl = ''
  const P_: Record<string, P> = {}
  const ids: Record<string, string> = {}
  const socks: Sock[] = []
  // the conversations and their content
  let priv = ''
  let direct = ''
  let group = ''
  let open = ''
  let privMsg = ''
  let fileId = ''
  let tableId = ''
  let recordOk = ''
  let recordHidden = ''
  let cardMsg = ''
  /** strings that only members of the private / direct / group conversations may ever receive */
  let SECRETS: string[] = []

  const sock = (p: P) => {
    const s = new Sock(wsUrl, { Origin: base, ...(p.cookie ? { Cookie: p.cookie } : {}) })
    socks.push(s)
    return s
  }
  const noSecret = (label: string, text: string, list = SECRETS) => {
    for (const x of list) expect(text.includes(x), `${label} leaks "${x.slice(0, 20)}"`).toBe(false)
  }

  async function person(name: string, email: string, roleIds: string[]): Promise<P> {
    const u = await P_.ada.post('/users', { name, email, roleIds, password: 'some-password-1' })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    ids[name] = u.data.id
    await h.q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [u.data.id])
    const c = new P(base, name)
    expect((await c.post('/auth/login', { email, password: 'some-password-1' })).status).toBe(200)
    return c
  }

  beforeAll(async () => {
    h = await startHarness('chatsec', { jobs: true, env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    live = http.createServer((req, res) => { void h.app.handle(req, res).then((x) => { if (!x) res.writeHead(404).end() }) })
    live.on('upgrade', (req, socket, head) => { if (!h.app.handleUpgrade(req, socket, head)) socket.destroy() })
    await new Promise<void>((r) => live.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(live.address() as AddressInfo).port}`
    wsUrl = base.replace('http', 'ws') + '/api/v1/live'
    P_.ada = new P(base, 'install admin')
    expect((await P_.ada.post('/auth/login', { email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
    ids.Ada = (await P_.ada.get('/auth/session')).data.user.id

    // a table for record cards: Secret is hidden from the "Partial" role, which also reads only its own rows
    const t = await P_.ada.post('/tables', { displayName: 'Cases', name: 'ChatCases', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Secret', type: 'text' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    tableId = t.data.id
    const full = await P_.ada.post('/roles', { name: 'Full readers', apps: 'all', privileges: [{ table: tableId, create: true, read: 'all', update: 'all', delete: 'none' }] })
    const partial = await P_.ada.post('/roles', { name: 'Partial', apps: [], privileges: [{ table: tableId, create: true, read: 'own', update: 'own', delete: 'none', columns: { Secret: 'none' } }] })
    expect([full.status, partial.status]).toEqual([200, 200])

    P_.mo = await person('Mo Member', 'mo@example.com', [full.data.id])
    P_.raj = await person('Raj Member', 'raj@example.com', [partial.data.id])
    P_.sam = await person('Sam Member', 'sam@example.com', [ROLE_VIEWER])
    P_.nia = await person('Nia Outsider', 'nia@example.com', [partial.data.id])
    P_.mia = await person('Mia Maker', 'mia@example.com', [ROLE_MAKER])
    P_.eve = await person('Eve EnvAdmin', 'eve@example.com', [ROLE_ADMIN])
    // a person of another environment only
    const env = await P_.ada.post('/environments', { name: 'Other', type: 'sandbox' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const oto = await P_.ada.post('/users', { name: 'Oto Other', email: 'oto@example.com', roleIds: [], password: 'some-password-1' })
    ids['Oto Other'] = oto.data.id
    await h.q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [oto.data.id])
    expect((await P_.ada.put(`/environments/${env.data.id}/access/${oto.data.id}`, {})).status).toBe(200)
    P_.oto = new P(base, 'other environment')
    expect((await P_.oto.post('/auth/login', { email: 'oto@example.com', password: 'some-password-1' })).status).toBe(200)
    // an API key of a service account holding the administrator role in Default
    const sa = await P_.ada.post('/identity/service-accounts', { name: 'Robot', environmentId: 'default', roleIds: [ROLE_ADMIN] })
    expect(sa.status, JSON.stringify(sa.data)).toBe(200)
    const key = await P_.ada.post(`/identity/service-accounts/${sa.data.id}/keys`, { name: 'k' })
    expect(key.status, JSON.stringify(key.data)).toBe(200)
    P_.key = new P(base, 'API key')
    P_.key.bearer = key.data.key
    P_.anon = new P(base, 'anonymous')

    // records: Mo's (Raj may not read the row) and Raj's own (Raj may read it, without Secret)
    const r1 = await P_.mo.post(`/data/${tableId}/rows`, { values: { Title: 'Hidden order', Secret: 'HIDDENROW-SECRET' } })
    const r2 = await P_.raj.post(`/data/${tableId}/rows`, { values: { Title: 'Raj order' } })
    expect([r1.status, r2.status], JSON.stringify([r1.data, r2.data])).toEqual([200, 200])
    recordHidden = r1.data.row.id
    recordOk = r2.data.row.id
    expect((await P_.mo.patch(`/data/${tableId}/rows/${recordOk}`, { changes: { Secret: 'COLUMN-SECRET' } })).status).toBe(200)

    // the conversations, made through the chat API by members
    const pc = await P_.mo.post('/chat/conversations', { kind: 'channel', name: 'Secret ops', isPrivate: true, members: [ids['Raj Member']] })
    expect(pc.status, JSON.stringify(pc.data)).toBe(200)
    priv = pc.data.id
    const up = await P_.mo.req('POST', `/chat/conversations/${priv}/files?name=zebrafile-plan.txt`, undefined, { raw: Buffer.from('ZEBRA-BYTES of the plan'), type: 'text/plain' })
    expect(up.status, up.text).toBe(200)
    fileId = up.data.id
    const pm = await P_.mo.post(`/chat/conversations/${priv}/messages`, { body: `<p>zebracode 4711 for <span data-mention="${ids['Raj Member']}">@Raj</span></p>`, files: [fileId] })
    expect(pm.status, JSON.stringify(pm.data)).toBe(200)
    privMsg = pm.data.message.id
    expect((await P_.raj.post(`/chat/messages/${privMsg}/reactions`, { emoji: '👍' })).status).toBe(200)
    const dm = await P_.mo.post('/chat/conversations', { kind: 'direct', members: [ids['Raj Member']] })
    expect(dm.status, JSON.stringify(dm.data)).toBe(200)
    direct = dm.data.id
    expect((await P_.mo.post(`/chat/conversations/${direct}/messages`, { body: 'quokkaword between us' })).status).toBe(200)
    const gc = await P_.mo.post('/chat/conversations', { kind: 'group', members: [ids['Raj Member'], ids['Sam Member']] })
    expect(gc.status, JSON.stringify(gc.data)).toBe(200)
    group = gc.data.id
    expect((await P_.sam.post(`/chat/conversations/${group}/messages`, { body: 'kiwiword in the group' })).status).toBe(200)
    const oc = await P_.mo.post('/chat/conversations', { kind: 'channel', name: 'General', isPrivate: false })
    expect(oc.status, JSON.stringify(oc.data)).toBe(200)
    open = oc.data.id
    expect((await P_.mo.post(`/chat/conversations/${open}/messages`, { body: 'wombatword hello everyone' })).status).toBe(200)
    // a card in the open channel: a record with Title and Secret; the hidden record; an app that does not exist
    const cm = await P_.mo.post(`/chat/conversations/${open}/messages`, {
      body: 'cards', cards: [
        { kind: 'record', env: 'default', table: tableId, row: recordOk, fields: ['Title', 'Secret'] },
        { kind: 'record', env: 'default', table: tableId, row: recordHidden, fields: ['Title', 'Secret'] },
        { kind: 'record', env: 'default', table: tableId, row: '00000000-0000-5000-8000-000000000000', fields: ['Title'] },
      ],
    })
    expect(cm.status, JSON.stringify(cm.data)).toBe(200)
    cardMsg = cm.data.message.id
    SECRETS = ['zebracode', 'zebrafile', 'ZEBRA-BYTES', 'quokkaword', 'kiwiword', priv, direct, group, privMsg, fileId, 'Secret ops']
  }, 240_000)

  afterAll(async () => {
    for (const s of socks) s.close()
    await new Promise<void>((r) => (live ? live.close(() => r()) : r()))
    await h?.close()
  }, 60_000)

  const OUTSIDERS = ['nia', 'mia', 'eve', 'ada', 'oto', 'key', 'anon'] as const

  it('positive control: members see their conversations, messages, file and reaction', async () => {
    const list = await P_.raj.get('/chat/conversations')
    expect(list.status).toBe(200)
    for (const x of [priv, direct, group]) expect(list.text).toContain(x)
    expect((await P_.raj.get('/chat/conversations?browse=1')).text).toContain(open)
    const hist = await P_.raj.get(`/chat/conversations/${priv}/messages`)
    expect(hist.text).toContain('zebracode')
    expect(hist.text).toContain('zebrafile-plan.txt')
    expect(hist.data.messages.find((m: any) => m.id === privMsg).reactions).toEqual([{ emoji: '👍', users: [ids['Raj Member']] }])
    const f = await P_.raj.get(`/attachments/${fileId}?env=default`)
    expect(f.status).toBe(200)
    expect(f.text).toContain('ZEBRA-BYTES')
    expect((await P_.raj.get('/chat/search?q=zebracode')).data.items.map((i: any) => i.message.id)).toEqual([privMsg])
    expect((await P_.raj.get('/chat/search?q=zebrafile')).data.items.map((i: any) => i.message.id)).toEqual([privMsg])
    // Query v2 for a member follows membership too (apps may list a channel's messages for its members)
    const q2 = await P_.raj.post('/query', { plan: { version: 2, table: 'Messages', select: ['BodyText'] } })
    expect(q2.status, q2.text).toBe(200)
    expect(q2.text).toContain('zebracode')
  })

  it('LEAK chat routes: a private, direct or group conversation does not exist for anyone outside it', async () => {
    for (const who of OUTSIDERS) {
      const p = P_[who]
      const expectNo = (r: { status: number }, label: string) => {
        // people who may use chat: 404 (no existence leak); everyone else is refused before anything is looked up
        if (['nia', 'mia', 'eve', 'ada'].includes(who)) expect(r.status, `${who} ${label}`).toBe(404)
        else expect([401, 403], `${who} ${label}`).toContain(r.status)
      }
      const list = await p.get('/chat/conversations')
      noSecret(`${who} list`, list.text)
      noSecret(`${who} browse`, (await p.get('/chat/conversations?browse=1')).text)
      for (const c of [priv, direct, group]) {
        for (const r of [
          await p.get(`/chat/conversations/${c}`), await p.get(`/chat/conversations/${c}/messages`), await p.get(`/chat/conversations/${c}/members`),
          await p.get(`/chat/conversations/${c}/changes?after=0`), await p.get(`/chat/conversations/${c}/mentionable`),
          await p.post(`/chat/conversations/${c}/messages`, { body: 'let me in' }), await p.post(`/chat/conversations/${c}/join`),
          await p.post(`/chat/conversations/${c}/read`, { seq: 99 }), await p.post(`/chat/conversations/${c}/typing`),
          await p.post(`/chat/conversations/${c}/members`, { userIds: [ids['Nia Outsider']] }), await p.patch(`/chat/conversations/${c}`, { name: 'x' }),
          await p.req('POST', `/chat/conversations/${c}/files?name=x.txt`, undefined, { raw: Buffer.from('x'), type: 'text/plain' }),
        ]) {
          expectNo(r, `conversation ${c}`)
          noSecret(`${who} conversation route`, r.text)
        }
      }
      for (const r of [
        await p.get(`/chat/messages/${privMsg}/replies`), await p.patch(`/chat/messages/${privMsg}`, { body: 'x' }), await p.del(`/chat/messages/${privMsg}`),
        await p.post(`/chat/messages/${privMsg}/reactions`, { emoji: '👍' }), await p.post(`/chat/messages/${privMsg}/report`, { reason: 'curious' }),
        await p.post('/chat/cards/resolve', { messageId: privMsg, index: 0 }),
      ]) {
        expectNo(r, 'message route')
        noSecret(`${who} message route`, r.text)
      }
      for (const q of ['zebracode', 'zebra', 'zebrafile', 'quokkaword', 'kiwiword', '4711']) {
        const r = await p.get(`/chat/search?q=${encodeURIComponent(q)}`)
        noSecret(`${who} search ${q}`, r.text)
        if (r.status === 200) expect(r.data.items, `${who} search ${q}`).toEqual([])
      }
      // a search restricted to the private channel is empty too (not an error that says it exists)
      const rs = await p.get(`/chat/search?q=zebracode&channel=${priv}`)
      if (rs.status === 200) expect(rs.data.items).toEqual([])
    }
    // the record was not changed by any of the attempts
    expect((await P_.raj.get(`/chat/conversations/${priv}/messages`)).text).toContain('zebracode')
  })

  it('LEAK chat routes: who is not a chat user is refused (other environment, API key, anonymous)', async () => {
    expect((await P_.oto.get('/chat/conversations')).status).toBe(403)
    expect((await P_.key.get('/chat/conversations')).status).toBe(403)
    expect((await P_.anon.get('/chat/conversations')).status).toBe(401)
    expect((await P_.key.post('/chat/conversations', { kind: 'channel', name: 'bots' })).status).toBe(403)
  })

  it('LEAK admin routes: administrators see conversation metadata, never message text or files', async () => {
    for (const who of ['eve', 'ada'] as const) {
      const r = await P_[who].get('/chat/admin/channels')
      expect(r.status, r.text).toBe(200)
      expect(r.data.items.map((x: any) => x.id)).toEqual(expect.arrayContaining([priv, direct, group, open]))
      noSecret(`${who} admin list`, r.text, ['zebracode', 'zebrafile', 'ZEBRA-BYTES', 'quokkaword', 'kiwiword', privMsg, fileId])
      const m = await P_[who].get(`/chat/admin/channels/${priv}/members`)
      expect(m.status).toBe(200)
      noSecret(`${who} admin members`, m.text, ['zebracode', 'zebrafile', privMsg])
    }
    for (const who of ['nia', 'mia'] as const) {
      expect((await P_[who].get('/chat/admin/channels')).status).toBe(403)
      expect((await P_[who].post(`/chat/admin/messages/${privMsg}/moderate`, {})).status).toBe(403)
      expect((await P_[who].post(`/chat/admin/channels/${priv}/export`, { reason: 'I just want to read it' })).status).toBe(403)
    }
  })

  it('GAP 1+2: writes to the four chat tables through the generic data API are refused for everyone (members included)', async () => {
    const targets: [string, Record<string, unknown>][] = [
      ['Channels', { Name: 'mine', Kind: 'channel', IsPrivate: false }],
      ['ChannelMembers', { Channel: priv, User: ids['Nia Outsider'], MemberRole: 'owner' }],
      ['Messages', { Channel: priv, Body: 'injected' }],
      ['MessageReactions', { Message: privMsg, Emoji: '👍' }],
    ]
    for (const who of ['mo', 'raj', 'nia', 'mia', 'eve', 'ada', 'key'] as const) {
      for (const [table, values] of targets) {
        const r = await P_[who].post(`/data/${table}/rows`, { values })
        expect(r.status, `${who} insert ${table}: ${r.text}`).toBeGreaterThanOrEqual(400)
      }
      for (const r of [
        await P_[who].patch(`/data/Messages/rows/${privMsg}`, { changes: { Body: 'changed' } }),
        await P_[who].post('/data/Messages/delete', { ids: [privMsg] }),
        await P_[who].post('/data/Channels/delete', { ids: [priv] }),
        await P_[who].post('/data/Messages/import', { csv: 'Channel,Body\n' + priv + ',imported', mode: 'append' }),
        await P_[who].req('POST', `/attachments?table=Messages&column=Files&rowId=${privMsg}&name=x.txt`, undefined, { raw: Buffer.from('x'), type: 'text/plain' }),
        await P_[who].del(`/attachments/${fileId}`),
      ]) expect(r.status, `${who} write: ${r.text}`).toBeGreaterThanOrEqual(400)
    }
    const n = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.sys_messages WHERE "Body" LIKE '%injected%' OR "Body" LIKE '%changed%' OR "Body" LIKE '%imported%'`)
    expect(n[0].n).toBe(0)
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.sys_channel_members WHERE "User" = $1`, [ids['Nia Outsider']]))[0].n).toBe(0)
    expect((await P_.raj.get(`/attachments/${fileId}?env=default`)).status).toBe(200)
  })

  it('LEAK generic reads (GAP 3): Query v2 rows, count, aggregate, search; v1 query; CSV; attachments; Mentions; file links', async () => {
    const tables = ['Channels', 'ChannelMembers', 'Messages', 'MessageReactions', 'Mentions', 'AttachmentLinks']
    const openCount = (await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.sys_messages WHERE "Channel" = $1', [open]))[0].n
    for (const who of OUTSIDERS) {
      const p = P_[who]
      for (const table of tables) {
        for (const plan of [
          { version: 2, table },
          { version: 2, table, count: true, page: { size: 0 } },
          { version: 2, table, aggregate: { groupBy: [], measures: [{ name: 'N', fn: 'count' }] } },
          ...(table === 'Messages' ? [{ version: 2, table, search: { text: 'zebra', columns: ['BodyText', 'Body'] } }, { version: 2, table, aggregate: { groupBy: ['Channel'], measures: [{ name: 'N', fn: 'count' }] } }] : []),
        ]) {
          const r = await p.post('/query', { plan })
          noSecret(`${who} query ${table} ${JSON.stringify(plan).slice(0, 60)}`, r.text)
          // counts count only what the reader may read: of the four conversations, only the open channel
          if (r.status === 200 && plan.count && table === 'Channels') expect(r.data.count, `${who} count ${table}`).toBe(who === 'oto' ? 0 : 1)
        }
        // the Data API v1 read route is gone (P3 package C): it must answer 404 and still say nothing
        noSecret(`${who} v1 ${table}`, (await p.post(`/data/${table}/query`, {})).text)
        noSecret(`${who} csv ${table}`, (await p.get(`/tables/${table}/csv`)).text)
      }
      // counts over Messages: only the open channel's messages are counted
      const c = await p.post('/query', { plan: { version: 2, table: 'Messages', count: true, page: { size: 0 } } })
      if (c.status === 200) expect(c.data.count, `${who} message count`).toBe(who === 'oto' ? 0 : openCount)
      else expect(['oto', 'anon']).toContain(who)
      // the file
      const f = await p.get(`/attachments/${fileId}?env=default`)
      expect(f.status, `${who} file`).not.toBe(200)
      noSecret(`${who} file`, f.text)
      const rs = await p.post('/attachments/resolve', { ids: [fileId] })
      noSecret(`${who} resolve`, rs.text)
      // the Mentions page and the notification feed
      noSecret(`${who} mentions page`, (await p.get('/collab/mentions')).text)
      noSecret(`${who} notifications`, (await p.get('/notifications?limit=100')).text)
      // record presence and table topics on chat tables are refused on the socket below
    }
  })

  it('LEAK live: chat topics only for readers; table and record topics on chat tables refused for everyone', async () => {
    for (const who of ['nia', 'mia', 'eve', 'ada'] as const) {
      const s = sock(P_[who])
      await s.waitMsg((m) => m.t === 'hello')
      expect((await s.sub(`chat:${priv}`)).code, `${who} chat topic`).toBe('not-found')
      expect((await s.sub(`chat:typing:${direct}`)).code).toBe('not-found')
      expect((await s.sub(`chat:${open}`)).t).toBe('subscribed')
      for (const t of ['Messages', 'sys_messages', 'Channels', 'ChannelMembers', 'MessageReactions']) {
        const r = await s.sub(`table:${t}`, 'default')
        expect(r.t, `${who} table:${t}`).toBe('error')
      }
      expect((await s.sub(`presence:record:sys_messages:${privMsg}`, 'default')).t).toBe('error')
      await sleep(100)
      // (a refusal echoes the topic the person asked for; everything else must be free of the conversations)
      for (const raw of s.raw) if (JSON.parse(raw).t !== 'error') noSecret(`${who} socket`, raw)
    }
    // the member's subscription works, and a message arrives with its text
    const raj = sock(P_.raj)
    await raj.waitMsg((m) => m.t === 'hello')
    const ack = await raj.sub(`chat:${priv}`)
    expect(ack).toMatchObject({ t: 'subscribed', seq: expect.any(Number) })
    // an outsider watching the open channel gets nothing of the private one while it changes
    const nia = sock(P_.nia)
    await nia.waitMsg((m) => m.t === 'hello')
    await nia.sub(`chat:${open}`)
    const sent = await P_.mo.post(`/chat/conversations/${priv}/messages`, { body: 'zebracode again' })
    expect(sent.status).toBe(200)
    const push = await raj.waitMsg((m) => m.t === 'chat' && m.message?.id === sent.data.message.id)
    expect(push).toMatchObject({ channelId: priv, op: 'message', prev: push.seq - 1 })
    await sleep(200)
    for (const raw of nia.raw) noSecret('nia socket', raw)
  })

  it('LEAK mentions: a non-member cannot be mentioned in a private conversation (refused with the reason), and is not notified', async () => {
    const before = (await P_.nia.get('/notifications?limit=100')).data.items.length
    const r = await P_.mo.post(`/chat/conversations/${priv}/messages`, { body: `<p>hey <span data-mention="${ids['Nia Outsider']}">@Nia</span> zebracode</p>` })
    expect(r.status).toBe(422)
    expect(r.data.error.message).toMatch(/Nia Outsider is not in this conversation/)
    for (const c of [direct, group]) {
      const x = await P_.mo.post(`/chat/conversations/${c}/messages`, { body: `<span data-mention="${ids['Nia Outsider']}">@Nia</span>` })
      expect(x.status).toBe(422)
    }
    await sleep(200)
    const after = await P_.nia.get('/notifications?limit=100')
    expect(after.data.items.length).toBe(before)
    noSecret('nia notifications', after.text)
    // in an open channel everyone who uses chat can read it: the mention notifies, without anything of the private ones
    const ok = await P_.mo.post(`/chat/conversations/${open}/messages`, { body: `<span data-mention="${ids['Nia Outsider']}">@Nia</span> look` })
    expect(ok.status, ok.text).toBe(200)
    const got = await P_.nia.get('/notifications?limit=100')
    expect(got.data.items.some((n: any) => n.kind === 'chat' && n.link.startsWith(`#chat?c=${open}`))).toBe(true)
    // the member mentioned in the private channel got exactly one notification for it
    const rajN = (await P_.raj.get('/notifications?limit=100')).data.items.filter((n: any) => n.kind === 'chat' && n.link.startsWith(`#chat?c=${priv}`))
    expect(rajN.length).toBe(1)
  })

  it('LEAK cards: a reader gets only the fields and rows they may read (checked in the response bytes)', async () => {
    // Mo reads everything: both records, Title and Secret
    const full = await P_.mo.post('/chat/cards/resolve', { messageId: cardMsg, index: 0 })
    expect(full.data).toMatchObject({ available: true, kind: 'record' })
    expect(full.text).toContain('COLUMN-SECRET')
    // Raj: his own row without the Secret column (not even its name), the other row not available
    const own = await P_.raj.post('/chat/cards/resolve', { messageId: cardMsg, index: 0 })
    expect(own.status).toBe(200)
    expect(own.data.available).toBe(true)
    expect(own.data.fields.map((f: any) => f.name)).toEqual(['Title'])
    expect(own.text).not.toContain('COLUMN-SECRET')
    expect(own.text).not.toContain('"Secret"')
    const hidden = await P_.raj.post('/chat/cards/resolve', { messageId: cardMsg, index: 1 })
    const missing = await P_.raj.post('/chat/cards/resolve', { messageId: cardMsg, index: 2 })
    expect(hidden.status).toBe(200)
    expect(hidden.data).toEqual({ available: false, kind: 'record' })
    expect(hidden.text).toBe(missing.text)
    expect(hidden.text).not.toContain('HIDDENROW')
    expect(hidden.text).not.toContain('Hidden order')
    // Nia reads only her own rows of the table (she owns neither): not available for both
    for (const i of [0, 1]) {
      const r = await P_.nia.post('/chat/cards/resolve', { messageId: cardMsg, index: i })
      expect(r.data).toEqual({ available: false, kind: 'record' })
    }
    // the stored message holds references only: no value went into the message, the history or the push
    const hist = await P_.nia.get(`/chat/conversations/${open}/messages`)
    expect(hist.text).not.toContain('COLUMN-SECRET')
    expect(hist.text).not.toContain('HIDDENROW')
    // a deleted record: not available for everyone, with the same answer
    expect((await P_.ada.post(`/data/${tableId}/delete`, { ids: [recordOk] })).status).toBe(200)
    expect((await P_.mo.post('/chat/cards/resolve', { messageId: cardMsg, index: 0 })).data).toEqual({ available: false, kind: 'record' })
  })

  it('LEAK generic engines: dashboards batch, print templates and flows data steps over the chat tables', async () => {
    // dashboards' batch endpoint with a plan over Messages
    for (const who of ['nia', 'mia', 'eve', 'ada', 'key'] as const) {
      const r = await P_[who].post('/dashboards/query', { queries: [{ id: 'a', plan: { version: 2, table: 'Messages', select: ['BodyText', 'Channel'] } }, { id: 'b', plan: { version: 2, table: 'Messages', aggregate: { groupBy: ['Channel'], measures: [{ name: 'N', fn: 'count' }] } } }] })
      noSecret(`${who} dashboards batch`, r.text)
    }
    // print: a record sheet of a private message is refused for outsiders, works for the member
    const tpl = await P_.ada.post('/print/builtins', { key: 'record-sheet', table: 'Messages' })
    expect(tpl.status, tpl.text).toBe(200)
    const tid = tpl.data.template.id
    for (const who of ['nia', 'mia', 'eve', 'ada'] as const) {
      const r = await P_[who].get(`/print/templates/${tid}/pdf?recordId=${privMsg}`)
      expect(r.status, `${who} print: ${r.status}`).toBeGreaterThanOrEqual(400)
      noSecret(`${who} print`, r.text)
    }
    expect((await P_.raj.get(`/print/templates/${tid}/pdf?recordId=${privMsg}`)).status).toBe(200)
    // flows: a data step that lists Messages runs as its owner (an environment administrator): the private ones are not in it
    const f = await P_.eve.post('/flows', {
      name: 'Chat peek', enabled: true, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
      trigger: { type: 'manual', inputs: [], from: 'any' },
      steps: [{ id: 'l', name: 'L', kind: 'data.list', table: 'Messages', top: 100 }, { id: 'r', name: 'R', kind: 'respond', body: '{N: CountRows(Steps.L.Output)}' }],
    })
    expect(f.status, f.text).toBe(200)
    const run = await P_.eve.post(`/flows/${f.data.flow.id}/run`, { wait: true, timeoutSeconds: 20 })
    expect(run.status, run.text).toBe(200)
    let d: any = null
    for (let i = 0; i < 100; i++) {
      d = (await P_.eve.get(`/flows/runs/${run.data.runId}`)).data.run
      if (d && !['queued', 'running'].includes(d.status)) break
      await sleep(150)
    }
    expect(d.status, JSON.stringify(d).slice(0, 400)).toBe('succeeded')
    noSecret('flow run', JSON.stringify(d))
  })

  it('LEAK exports: the environment data export and a backup\'s table browser never show chat', async () => {
    for (const who of ['eve', 'ada'] as const) {
      const r = await P_[who].get('/admin/export-data')
      expect(r.status, r.text.slice(0, 200)).toBe(200)
      const files = unzip(r.bytes)
      expect([...files.keys()].some((n) => /Messages|Channels|ChannelMembers|MessageReactions/.test(n))).toBe(false)
      for (const [name, content] of files) noSecret(`${who} export ${name}`, content, ['zebracode', 'zebrafile', 'quokkaword', 'kiwiword', 'Secret ops', fileId])
    }
    const b = await P_.ada.post('/backups', {})
    expect(b.status, b.text).toBe(200)
    let st: any = null
    for (let i = 0; i < 400; i++) {
      st = (await P_.ada.get(`/backups/${b.data.id}`)).data
      if (!['queued', 'running', 'verifying'].includes(st.state)) break
      await sleep(150)
    }
    expect(st.state, JSON.stringify(st)).toBe('ok')
    for (const table of ['sys_messages', 'sys_channels', 'sys_channel_members', 'sys_message_reactions']) {
      const r = await P_.ada.post(`/backups/${b.data.id}/browse`, { environment: 'default', table })
      expect(r.status, `${table}: ${r.text}`).toBe(403)
      noSecret(`browse ${table}`, r.text)
    }
  })

  it('the administrator export: typed reason, audited, announced in the conversation; only the exporting administrator downloads', async () => {
    expect((await P_.eve.post(`/chat/admin/channels/${priv}/export`, { reason: 'short' })).status).toBe(422)
    const e = await P_.eve.post(`/chat/admin/channels/${priv}/export`, { reason: 'Legal hold requested by HR, ticket 42' })
    expect(e.status, e.text).toBe(200)
    const audit = await h.q<{ action: string; details: any; user_id: string }>(`SELECT action, details, user_id FROM env_default.ab_audit WHERE action = 'chat.export'`)
    expect(audit).toHaveLength(1)
    expect(audit[0].user_id).toBe(ids['Eve EnvAdmin'])
    expect(JSON.stringify(audit[0].details)).not.toContain('zebracode')
    const hist = await P_.raj.get(`/chat/conversations/${priv}/messages`)
    expect(hist.data.messages.some((m: any) => m.kind === 'system' && m.event?.type === 'export' && /An administrator exported this conversation/.test(m.text))).toBe(true)
    expect((await P_.ada.get(e.data.url.replace('/api/v1', ''))).status).toBe(404)
    const zip = await P_.eve.get(e.data.url.replace('/api/v1', ''))
    expect(zip.status).toBe(200)
    const files = unzip(zip.bytes)
    expect(files.get('transcript.html')).toContain('zebracode')
    expect([...files.values()].some((c) => c.includes('ZEBRA-BYTES'))).toBe(true)
  })

  it('a removed member stops receiving the conversation at once: socket ended, no search hits, 404', async () => {
    const s = sock(P_.raj)
    await s.waitMsg((m) => m.t === 'hello')
    expect((await s.sub(`chat:${priv}`)).t).toBe('subscribed')
    expect((await P_.raj.get('/chat/search?q=zebracode')).data.items.length).toBeGreaterThan(0)
    const t0 = Date.now()
    expect((await P_.mo.del(`/chat/conversations/${priv}/members/${ids['Raj Member']}`)).status).toBe(200)
    await s.waitMsg((m) => m.t === 'unsubscribed' && m.topic === `chat:${priv}`, 5000)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect((await P_.raj.get('/chat/search?q=zebracode')).data.items).toEqual([])
    expect((await P_.raj.get(`/chat/conversations/${priv}`)).status).toBe(404)
    expect((await P_.raj.get(`/attachments/${fileId}?env=default`)).status).toBe(404)
    // nothing more on the old subscription
    const n = s.msgs.length
    await P_.mo.post(`/chat/conversations/${priv}/messages`, { body: 'after you left: zebracode' })
    await sleep(300)
    expect(s.msgs.slice(n).filter((m) => m.t === 'chat')).toEqual([])
  })
})
