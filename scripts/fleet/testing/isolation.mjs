/**
 * The cross-instance isolation checks (H-B; docs/plan/hosting-spec.md exit check 2 and its threat model), run against a
 * fleet of real installs from fleet.mjs. As organisation A's administrator, A's ordinary user and an anonymous client,
 * every check tries to reach organisation B and asserts BOTH the refusal AND that nothing of B (its marker data, admin
 * email, database and role name, database password, secret key, folders, tokens) appears in the answer; at the end A's
 * console output and log files are searched for B and for A's own secrets.
 *
 *   const r = await runIsolation({ log })   ->  { results: [{ area, check, ok, detail }], notes, env }
 *
 * Most checks have a positive control (the same credential works at A), so a refusal at B is meaningful. Negative
 * controls prove the suite detects the mistakes it is meant to catch: PostgreSQL's default grants (a database created
 * without REVOKE ... FROM PUBLIC is reachable by A's role), the postgres database before the cluster preparation, and an
 * on-premises outbound policy (the loopback canary is reached).
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { createHmac, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  DNS_DOMAIN, DOMAIN, PORTS, WIN, call, cookieFrom, createInstallDatabase, opaqueId, revokeShared, root, startFleet, tryConnect,
} from './fleet.mjs'

const API = '/api/v1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (n) => randomBytes(n).toString('hex')

/* ------------------------------------------------------------------ tokens the way the product signs them */

const hmac = (key, text) => createHmac('sha256', key).update(text).digest()
function signed(key, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`
}
const unsubscribeKey = (secretHex) => hmac(Buffer.from(secretHex, 'hex'), 'appbuilder.unsubscribe.v1')
const snapshotKey = (secretHex) => hmac(unsubscribeKey(secretHex), 'appbuilder.dashboard-snapshot.v1')
const approvalKey = (secretHex) => hmac(Buffer.from(secretHex, 'hex'), 'appbuilder.approval-link.v1')

/* ------------------------------------------------------------------ WebSocket probe */

function wsProbe(target, host, o = {}) {
  return new Promise((resolve) => {
    const s = target.socketPath ? net.connect(target.socketPath) : net.connect(target.port, '127.0.0.1')
    let buf = Buffer.alloc(0)
    let status = 0
    let closeCode = null
    const finish = () => { s.destroy(); resolve({ status, closeCode, head: buf.toString('latin1').split('\r\n\r\n')[0] }) }
    s.setTimeout(4000, finish)
    s.on('error', () => finish())
    s.on('close', () => resolve({ status, closeCode, head: buf.toString('latin1').split('\r\n\r\n')[0] }))
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c])
      const t = buf.toString('latin1')
      status = Number(/^HTTP\/1\.1 (\d{3})/.exec(t)?.[1] ?? 0)
      const i = t.indexOf('\r\n\r\n')
      if (i < 0) return
      if (status !== 101) return finish()
      const frame = buf.subarray(i + 4)
      if (frame.length >= 4 && (frame[0] & 0x0f) === 0x8) { closeCode = frame.readUInt16BE(2); finish() }
    })
    s.on('connect', () => {
      s.write([
        `GET ${API}/live HTTP/1.1`, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13', ...(o.origin === null ? [] : [`Origin: ${o.origin ?? `https://${host}`}`]), ...(o.cookie ? [`Cookie: ${o.cookie}`] : []), '', '',
      ].join('\r\n'))
      // a valid session at the install it belongs to stays open: wait a moment for a close frame that never comes
      setTimeout(finish, o.waitMs ?? 1500)
    })
  })
}

/* ------------------------------------------------------------------ the suite */

export async function runIsolation(o = {}) {
  const log = o.log ?? (() => {})
  const results = []
  const notes = []
  const t0 = Date.now()
  log('starting three installs (A, B, C) with their own databases, roles, folders and keys ...')
  const fleet = await startFleet({ installs: ['a', 'b', 'c'] })
  const { a: A, b: B, c: C } = fleet.installs
  const via = fleet.via
  const env = { cluster: fleet.cluster.mode, listen: A.socketPath ? 'unix socket' : 'tcp 127.0.0.1', platform: process.platform }
  log(`fleet up in ${((Date.now() - t0) / 1000).toFixed(1)} s (PostgreSQL: ${fleet.cluster.mode}, installs on ${env.listen})`)

  /**
   * what of an install must never appear in another install's answers or logs. Its database and role name are not on
   * the list: every role reads them in PostgreSQL's catalogue (by design; they are opaque ids), so A may send them and
   * see them echoed in a refusal.
   */
  const secrets = (inst) => [inst.marker, inst.adminEmail, inst.userEmail, inst.password, inst.secretKey, inst.adminPassword,
    inst.adminCookie?.split('=')[1], inst.apiKey, inst.viewToken, inst.inviteToken, inst.dir, inst.workspace].filter((s) => typeof s === 'string' && s.length >= 6)
  const leakOf = (inst, responses) => {
    const all = secrets(inst)
    for (const r of responses) {
      const text = typeof r === 'string' ? r : `${r.head ?? ''}\n${JSON.stringify(r.headers ?? {})}\n${r.body ?? ''}`
      const lower = text.toLowerCase()
      for (const s of all) if (text.includes(s) || lower.includes(s.toLowerCase().replaceAll('\\', '\\\\')) || lower.includes(s.toLowerCase())) return s === inst.password || s === inst.secretKey || s === inst.adminPassword ? '(a secret value)' : s
    }
    return null
  }
  const rec = (area, check, ok, detail, responses = [], against = B) => {
    const leak = leakOf(against, responses)
    results.push({ area, check, ok: !!ok && !leak, detail: leak ? `LEAK of ${against.key.toUpperCase()}: ${leak}` : detail })
    if (!ok || leak) log(`FAIL ${area}: ${check}: ${leak ? `leak ${leak}` : detail}`)
  }
  const safe = async (area, check, fn) => {
    try { await fn() } catch (e) { results.push({ area, check, ok: false, detail: `error: ${e.message}` }); log(`FAIL ${area}: ${check}: ${e.stack}`) }
  }
  const as = (inst, cookie) => ({
    get: (p, x = {}) => via(inst.host, 'GET', API + p, { cookie, ...x }),
    post: (p, body, x = {}) => via(inst.host, 'POST', API + p, { cookie, body: body ?? {}, ...x }),
    put: (p, body, x = {}) => via(inst.host, 'PUT', API + p, { cookie, body, ...x }),
    patch: (p, body, x = {}) => via(inst.host, 'PATCH', API + p, { cookie, body, ...x }),
  })

  try {
    /* -------------------------------------------------------------- data and credentials of each install */
    for (const inst of [A, B, C]) {
      const adm = as(inst, inst.adminCookie)
      inst.marker = `HB-MARK-${inst.key.toUpperCase()}-${hex(6)}`
      const t = await adm.post('/tables', { displayName: 'Hb mark', name: 'HbMark', columns: [{ displayName: 'Title', type: 'text' }] })
      if (t.status !== 200) throw new Error(`table at ${inst.key}: ${t.status} ${t.body}`)
      inst.tableId = t.json().id
      const row = await adm.post(`/data/${inst.tableId}/rows`, { values: { Title: inst.marker } })
      if (row.status !== 200) throw new Error(`row at ${inst.key}: ${row.status} ${row.body}`)
      inst.userEmail = `user@${inst.key}-org.example`
      inst.userPassword = `Hb-user-${hex(4)}-pw1`
      const u = await adm.post('/users', { name: `User ${inst.key}`, email: inst.userEmail, roleIds: ['role_viewer'], password: inst.userPassword })
      if (u.status !== 200) throw new Error(`user at ${inst.key}: ${u.status} ${u.body}`)
      inst.userId = u.json()?.id
    }
    // A's ordinary user signs in (with the password A's administrator set)
    {
      const l = await via(A.host, 'POST', `${API}/auth/login`, { body: { email: A.userEmail, password: A.userPassword } })
      A.userCookie = cookieFrom(l)
      if (!A.userCookie) notes.push(`setup: A's user did not sign in: ${l.status} ${l.body.slice(0, 200)}`)
    }
    // A's API key, view token, offline key, a second invitation, a reset code
    {
      const adm = as(A, A.adminCookie)
      const sa = await adm.post('/identity/service-accounts', { name: 'Hb robot', environmentId: 'default', roleIds: ['role_admin'] })
      const key = await adm.post(`/identity/service-accounts/${sa.json()?.id}/keys`, { name: 'k' })
      A.apiKey = key.json()?.key
      const d = await adm.post('/dashboards', { def: { version: 1, title: 'Hb board', range: 'all', filters: [], tiles: [{ id: 'n', title: 'Rows', kind: 'kpi', layout: { x: 0, y: 0, w: 3, h: 3 }, query: { table: 'HbMark', measures: [{ id: 'N', fn: 'count' }] } }] } })
      A.dashboardId = d.json()?.id
      const vt = await adm.post(`/dashboards/${A.dashboardId}/tokens`, { label: 'Hall TV' })
      A.viewToken = vt.json()?.token
      const inv = A.cli(['admin', 'invite', '--email', `second@a-org.example`, '--name', 'Second A', '--print-link'])
      A.secondInvite = decodeURIComponent(/#invite=(\S+)/.exec(inv.stdout + inv.stderr)?.[1] ?? '')
      const rc = await adm.post(`/users/${A.userId}/reset-code`, {})
      A.resetCode = rc.json()?.code
      if (!A.apiKey || !A.viewToken || !A.secondInvite || !A.resetCode) notes.push(`setup: api key ${!!A.apiKey}, view token ${!!A.viewToken}, invitation ${!!A.secondInvite}, reset code ${!!A.resetCode} (${rc.status} ${rc.body.slice(0, 200)})`)
    }

    /* -------------------------------------------------------------- 1. routing and host names */
    const R = 'Routing and host names'
    await safe(R, 'the proxy routes each host name to its own install (control)', async () => {
      const a = await as(A, A.adminCookie).get('/auth/session')
      const b = await as(B, B.adminCookie).get('/auth/session')
      rec(R, 'the proxy routes each host name to its own install (control)', a.status === 200 && a.body.includes(A.adminEmail) && b.status === 200 && b.body.includes(B.adminEmail), `A ${a.status}, B ${b.status}`, [a])
    })
    await safe(R, 'an unknown host name gets the catch-all 404 and reaches no install', async () => {
      const n = fleet.proxyLog.length
      const r = await via(`z.${DOMAIN}`, 'GET', `${API}/status`)
      const r2 = await via('localhost', 'GET', `${API}/status`)
      const r3 = await via('127.0.0.1', 'GET', `${API}/status`)
      rec(R, 'an unknown host name gets the catch-all 404 and reaches no install', [r, r2, r3].every((x) => x.status === 404 && x.body === 'no site') && fleet.proxyLog.length === n + 3, `${r.status} ${r2.status} ${r3.status}`, [r, r2, r3])
    })
    for (const h of [B.host, `${B.host}:443`, B.host.toUpperCase(), `${B.host}.`, `${A.host}@${B.host}`, `${B.host}%2f`, `${B.host}\\`, 'evil.example']) {
      const name = `Host "${h}" sent straight to A's listener is refused (403)`
      await safe(R, name, async () => {
        const r = await call(A.target(), 'GET', `${API}/auth/session`, { host: h, cookie: A.adminCookie })
        rec(R, name, r.status === 403 || r.status === 400, `${r.status}`, [r])
      })
    }
    await safe(R, 'loopback host names on A\'s listener (local tools: the health check) are answered as A only', async () => {
      const rs = []
      for (const h of ['localhost', '127.0.0.1', '[::1]']) rs.push(await call(A.target(), 'GET', `${API}/auth/session`, { host: h, cookie: A.adminCookie }))
      rec(R, 'loopback host names on A\'s listener (local tools: the health check) are answered as A only', rs.every((r) => r.status === 403 || (r.status === 200 && r.body.includes(A.adminEmail))), `${rs.map((r) => r.status).join(' ')} (only this machine can send them; the proxy sends the canonical name)`, rs)
    })
    await safe(R, 'two Host headers on A\'s listener: refused or answered as A, never as B', async () => {
      const out = []
      for (const [h1, h2] of [[A.host, B.host], [B.host, A.host]]) {
        out.push(await call(A.target(), 'GET', '', { raw: `GET ${API}/auth/session HTTP/1.1\r\nHost: ${h1}\r\nHost: ${h2}\r\nCookie: ${A.adminCookie}\r\nX-Appbuilder: 1\r\nConnection: close\r\n\r\n` }))
      }
      rec(R, 'two Host headers on A\'s listener: refused or answered as A, never as B', out.every((r) => r.status === 400 || r.status === 403 || (r.status === 200 && r.body.includes(A.adminEmail))), out.map((r) => r.status).join(', '), out)
    })
    await safe(R, 'an absolute request target naming B on A\'s listener is answered as A (Host decides)', async () => {
      const r = await call(A.target(), 'GET', '', { raw: `GET http://${B.host}${API}/auth/session HTTP/1.1\r\nHost: ${A.host}\r\nCookie: ${A.adminCookie}\r\nX-Appbuilder: 1\r\nConnection: close\r\n\r\n` })
      const viaProxy = await call({ port: PORTS.proxy }, 'GET', '', { raw: `GET http://${B.host}${API}/auth/session HTTP/1.1\r\nHost: ${A.host}\r\nCookie: ${A.adminCookie}\r\nX-Appbuilder: 1\r\nConnection: close\r\n\r\n` })
      rec(R, 'an absolute request target naming B on A\'s listener is answered as A (Host decides)', (r.status === 200 && r.body.includes(A.adminEmail)) || r.status === 403 || r.status === 400, `A's listener ${r.status}; through the proxy (routed to B, A's cookie): ${viaProxy.status}`, [r, viaProxy])
      rec(R, 'through the proxy an absolute target naming B goes to B, where A\'s cookie is nobody', viaProxy.status === 401, `${viaProxy.status}`, [viaProxy])
    })
    await safe(R, 'X-Forwarded-Host naming B changes nothing at A (locked public address)', async () => {
      const r = await call(A.target(), 'GET', `${API}/install/public-address`, { host: A.host, cookie: A.adminCookie, headers: { 'x-forwarded-host': B.host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.5' } })
      const p = await via(A.host, 'GET', `${API}/install/public-address`, { cookie: A.adminCookie, headers: { 'x-forwarded-host': B.host } })
      rec(R, 'X-Forwarded-Host naming B changes nothing at A (locked public address)', r.json()?.publicUrl === A.url && p.json()?.publicUrl === A.url, `${r.status} ${r.json()?.publicUrl}; proxy ${p.json()?.publicUrl}`, [r, p])
    })
    if (A.socketPath) {
      await safe(R, 'each install listens on its own Unix socket, mode 660 (user and proxy group only), and on no TCP port', async () => {
        const modes = [A, B, C].map((i) => (fs.statSync(i.socketPath).mode & 0o777).toString(8))
        const tcp = await call({ port: PORTS.a }, 'GET', `${API}/health`, { host: A.host, timeout: 2000 })
        rec(R, 'each install listens on its own Unix socket, mode 660 (user and proxy group only), and on no TCP port', modes.every((m) => m === '660') && tcp.status === 0, `modes ${modes.join(' ')}; TCP ${PORTS.a}: ${tcp.body}`)
      })
    } else results.push({ area: R, check: 'each install listens on its own Unix socket, mode 660 (user and proxy group only), and on no TCP port', ok: true, skipped: true, detail: 'not run on Windows (Node makes a named pipe there): CI on Linux runs it' })
    await safe(R, 'B\'s setup routes answer 404 to anyone (setup closed)', async () => {
      const r = await via(B.host, 'POST', `${API}/setup/admin`, { body: { name: 'Eve', email: 'eve@x.example', password: 'eve-password-123', setupCode: 'x' } })
      const r2 = await call(B.target(), 'POST', `${API}/setup/database`, { host: B.host, body: { host: '127.0.0.1' } })
      rec(R, 'B\'s setup routes answer 404 to anyone (setup closed)', r.status === 404 && r2.status === 404, `${r.status} ${r2.status}`, [r, r2])
    })

    /* -------------------------------------------------------------- 2. sessions, cookies, the live socket */
    const S = 'Sessions, cookies, live socket'
    const token = A.adminCookie.split('=')[1]
    await safe(S, 'A\'s administrator session works at A (control) and is nobody at B', async () => {
      const a = await as(A, A.adminCookie).get('/auth/session')
      const b = await as(B, A.adminCookie).get('/auth/session')
      const bd = await as(B, A.adminCookie).post('/query', { plan: { version: 2, table: 'HbMark' } })
      rec(S, 'A\'s administrator session works at A (control) and is nobody at B', a.status === 200 && b.status === 401 && bd.status === 401, `A ${a.status}, B ${b.status}, B rows ${bd.status}`, [b, bd])
    })
    await safe(S, 'A\'s ordinary user session is nobody at B', async () => {
      const a = await as(A, A.userCookie).get('/auth/session')
      const b = await as(B, A.userCookie).get('/auth/session')
      rec(S, 'A\'s ordinary user session is nobody at B', a.status === 200 && b.status === 401, `A ${a.status}, B ${b.status}`, [b])
    })
    await safe(S, 'A\'s session token under every cookie name (__Host- and legacy) is nobody at B', async () => {
      const names = ['ab_session', '__Host-ab_session', 'ab_mfa', '__Host-ab_mfa', 'ab_dev', '__Host-ab_dev', 'ab_td', '__Host-ab_td']
      const rs = []
      for (const n of names) rs.push(await as(B, `${n}=${token}`).get('/auth/session'))
      rs.push(await as(B, names.map((n) => `${n}=${token}`).join('; ')).get('/auth/session'))
      rec(S, 'A\'s session token under every cookie name (__Host- and legacy) is nobody at B', rs.every((r) => r.status === 401), rs.map((r) => r.status).join(' '), rs)
    })
    await safe(S, 'a plain (tossable) cookie with B\'s own valid token is ignored by B; B sets only __Host- cookies without Domain', async () => {
      const own = B.adminCookie.split('=')[1]
      const r = await as(B, `ab_session=${own}`).get('/auth/session')
      const l = await via(B.host, 'POST', `${API}/auth/login`, { body: { email: B.adminEmail, password: B.adminPassword } })
      const set = [].concat(l.headers['set-cookie'] ?? [])
      const good = set.length > 0 && set.every((c) => (c.startsWith('__Host-') && /;\s*Secure/i.test(c) && /;\s*Path=\//i.test(c) && !/domain=/i.test(c)) || /Max-Age=0/i.test(c))
      rec(S, 'a plain (tossable) cookie with B\'s own valid token is ignored by B; B sets only __Host- cookies without Domain', r.status === 401 && l.status === 200 && good, `plain ${r.status}; login ${l.status}; ${set.map((c) => c.split(';')[0].split('=')[0]).join(',')}`, [])
    })
    await safe(S, 'a page on A cannot use B\'s cookie: B refuses requests whose Origin is A (siblings are same-site)', async () => {
      const w = await as(B, B.adminCookie).post('/tables', { displayName: 'From A', name: 'FromA', columns: [] }, { headers: { origin: A.url, 'sec-fetch-site': 'same-site' } })
      const rd = await as(B, B.adminCookie).post('/query', { plan: { version: 2, table: 'HbMark' } }, { headers: { origin: A.url, 'sec-fetch-site': 'same-site' } })
      rec(S, 'a page on A cannot use B\'s cookie: B refuses requests whose Origin is A (siblings are same-site)', w.status === 403 && rd.status === 403, `write ${w.status}, read ${rd.status}`, [w])
    })
    await safe(S, 'a same-site request from A\'s pages without Origin writes nothing and cannot be read by A', async () => {
      // a GET from A's page (a link, an image) carries B's cookie (same site) and no Origin: B answers it, but no GET
      // route writes data (READ_ONLY_REFUSED_GETS is empty) and the browser does not let A's page read the answer
      // (B sends no CORS headers); every other method needs X-Appbuilder, which a page can only send with CORS
      const r = await as(B, B.adminCookie).get('/workspace', { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' } })
      const ro = await import(pathToFileURL(path.join(root, 'server/core/hosting/read-only.ts')).href)
      const cors = Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))
      const post = await via(B.host, 'POST', `${API}/tables`, { cookie: B.adminCookie, body: { displayName: 'X', name: 'X', columns: [] }, headers: { 'x-appbuilder': '', 'sec-fetch-site': 'same-site' } })
      results.push({ area: S, check: 'a same-site request from A\'s pages without Origin writes nothing and cannot be read by A', ok: ro.READ_ONLY_REFUSED_GETS.size === 0 && cors.length === 0 && post.status === 403, detail: `GET answered ${r.status} without CORS headers; GET routes that write: ${ro.READ_ONLY_REFUSED_GETS.size}; POST without X-Appbuilder ${post.status}` })
    })
    await safe(S, 'the live socket: A\'s cookie opens A\'s (control), is closed 4401 at B; B\'s cookie with Origin A refused', async () => {
      const a = await wsProbe({ port: PORTS.proxy }, A.host, { cookie: A.adminCookie })
      const b = await wsProbe({ port: PORTS.proxy }, B.host, { cookie: A.adminCookie })
      const cross = await wsProbe({ port: PORTS.proxy }, B.host, { cookie: B.adminCookie, origin: A.url })
      const noOrigin = await wsProbe({ port: PORTS.proxy }, B.host, { cookie: B.adminCookie, origin: null })
      const ok = a.status === 101 && a.closeCode === null && (b.status !== 101 || b.closeCode === 4401) && cross.status === 403 && noOrigin.status === 403
      rec(S, 'the live socket: A\'s cookie opens A\'s (control), is closed 4401 at B; B\'s cookie with Origin A refused', ok, `A ${a.status}/${a.closeCode}; B ${b.status}/${b.closeCode}; Origin A at B ${cross.status}; no Origin ${noOrigin.status}`, [b.head, cross.head])
    })

    /* -------------------------------------------------------------- 3. tokens, links, keys presented to B */
    const T = 'Tokens, links and keys'
    await safe(T, 'A\'s API key works at A (control) and is refused at B', async () => {
      const h = { authorization: `Bearer ${A.apiKey}` }
      const a = await via(A.host, 'GET', `${API}/auth/session`, { headers: h })
      const b = await via(B.host, 'GET', `${API}/auth/session`, { headers: h })
      const b2 = await via(B.host, 'POST', `${API}/query`, { headers: h, body: { plan: { version: 2, table: 'HbMark' } } })
      rec(T, 'A\'s API key works at A (control) and is refused at B', a.status === 200 && b.status === 401 && b2.status === 401, `A ${a.status}, B ${b.status}/${b2.status}`, [b, b2])
    })
    await safe(T, 'A\'s kiosk view token works at A (control) and is refused at B', async () => {
      const h = { authorization: `Bearer ${A.viewToken}` }
      const a = await via(A.host, 'GET', `${API}/dashboards/kiosk`, { headers: h })
      const b = await via(B.host, 'GET', `${API}/dashboards/kiosk`, { headers: h })
      const bq = await via(B.host, 'POST', `${API}/dashboards/kiosk/query`, { headers: h, body: {} })
      rec(T, 'A\'s kiosk view token works at A (control) and is refused at B', a.status === 200 && b.status === 401 && bq.status === 401, `A ${a.status}, B ${b.status}/${bq.status}`, [b, bq])
    })
    await safe(T, 'A\'s invitation link is valid at A (control) and not at B; accepting it at B creates nothing', async () => {
      const a = await via(A.host, 'POST', `${API}/auth/invitation/check`, { body: { token: A.secondInvite } })
      const b = await via(B.host, 'POST', `${API}/auth/invitation/check`, { body: { token: A.secondInvite } })
      const acc = await via(B.host, 'POST', `${API}/auth/invitation/accept`, { body: { token: A.secondInvite, password: 'Hb-takeover-pass-1' } })
      rec(T, 'A\'s invitation link is valid at A (control) and not at B; accepting it at B creates nothing', a.status === 200 && b.status >= 400 && acc.status >= 400 && !cookieFrom(acc), `A ${a.status}, B check ${b.status}, accept ${acc.status}`, [b, acc])
    })
    await safe(T, 'A\'s password reset code is valid at A (control) and not at B', async () => {
      const a = await via(A.host, 'POST', `${API}/auth/password/reset/check`, { body: { email: A.userEmail, code: A.resetCode } })
      const b = await via(B.host, 'POST', `${API}/auth/password/reset/check`, { body: { email: A.userEmail, code: A.resetCode } })
      const b2 = await via(B.host, 'POST', `${API}/auth/password/reset/check`, { body: { email: B.userEmail, code: A.resetCode } })
      rec(T, 'A\'s password reset code is valid at A (control) and not at B', a.status === 200 && b.status === 422 && b2.status === 422, `A ${a.status}, B ${b.status}/${b2.status}`, [b, b2])
    })
    await safe(T, 'an unsubscribe link signed with A\'s key verifies at A (control) and not at B', async () => {
      const t = signed(unsubscribeKey(A.secretKey), { u: A.adminId ?? 'user_x', k: '*' })
      const a = await via(A.host, 'GET', `${API}/notifications/unsubscribe?t=${encodeURIComponent(t)}`)
      const b = await via(B.host, 'GET', `${API}/notifications/unsubscribe?t=${encodeURIComponent(t)}`)
      const bp = await via(B.host, 'POST', `${API}/notifications/unsubscribe?t=${encodeURIComponent(t)}`, { body: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded', headers: { 'x-appbuilder': '' } })
      rec(T, 'an unsubscribe link signed with A\'s key verifies at A (control) and not at B', !/not valid/i.test(a.body) && a.status === 200 && /not valid/i.test(b.body) && bp.status === 400, `A ${a.status} ${/not valid/i.test(a.body) ? 'invalid' : 'valid'}, B ${b.status} ${/not valid/i.test(b.body) ? 'invalid' : 'VALID'}, one-click ${bp.status}`, [b, bp])
    })
    await safe(T, 'a snapshot unsubscribe link signed with A\'s key verifies at A (control) and not at B', async () => {
      const t = signed(snapshotKey(A.secretKey), { u: A.adminId ?? 'user_x', s: 'snap_x', e: 'default' })
      const a = await via(A.host, 'GET', `${API}/dashboards/snapshots/unsubscribe?t=${encodeURIComponent(t)}`)
      const b = await via(B.host, 'GET', `${API}/dashboards/snapshots/unsubscribe?t=${encodeURIComponent(t)}`)
      rec(T, 'a snapshot unsubscribe link signed with A\'s key verifies at A (control) and not at B', !/not valid/i.test(a.body) && /not valid/i.test(b.body), `A ${/not valid/i.test(a.body) ? 'invalid' : 'valid'}, B ${/not valid/i.test(b.body) ? 'invalid' : 'VALID'}`, [b])
    })
    await safe(T, 'an approval email link signed with A\'s key passes A\'s signature check (control) and fails B\'s', async () => {
      const t = signed(approvalKey(A.secretKey), { e: 'default', l: hex(16) })
      const a = (await as(A, A.adminCookie).post('/approvals/links/inspect', { token: t })).json()
      const bRes = await as(B, B.adminCookie).post('/approvals/links/inspect', { token: t })
      const b = bRes.json()
      rec(T, 'an approval email link signed with A\'s key passes A\'s signature check (control) and fails B\'s', a?.ok === false && /any more/.test(a?.reason ?? '') && b?.ok === false && /cut off/.test(b?.reason ?? ''), `A: ${a?.reason}; B: ${b?.reason}`, [bRes])
    })
    await safe(T, 'A\'s export download ticket works at A (control) and not at B', async () => {
      const tk = await as(A, A.adminCookie).post('/admin/export-data/ticket', {})
      const url = tk.json()?.url ?? ''
      const t2 = (await as(A, A.adminCookie).post('/admin/export-data/ticket', {})).json()?.url ?? ''
      const bAnon = await via(B.host, 'GET', t2)
      const bA = await via(B.host, 'GET', t2, { cookie: A.adminCookie })
      const a = await via(A.host, 'GET', url, { cookie: A.adminCookie })
      rec(T, 'A\'s export download ticket works at A (control) and not at B', tk.status === 200 && a.status === 200 && bAnon.status === 401 && bA.status === 401, `ticket ${tk.status}, A (ticket and session) ${a.status}, B (ticket only) ${bAnon.status}, B (ticket and A's cookie) ${bA.status}`, [bAnon, bA])
    })
    await safe(T, 'offline store keys: A\'s cookie gets none at B; the same device id gives B\'s administrator another key', async () => {
      const a = await as(A, A.adminCookie).post('/offline/key', { deviceId: 'device-hb-0001' })
      const bA = await as(B, A.adminCookie).post('/offline/key', { deviceId: 'device-hb-0001' })
      const bB = await as(B, B.adminCookie).post('/offline/key', { deviceId: 'device-hb-0001' })
      const ka = JSON.stringify(a.json() ?? {})
      rec(T, 'offline store keys: A\'s cookie gets none at B; the same device id gives B\'s administrator another key', a.status === 200 && bA.status === 401 && bB.status === 200 && JSON.stringify(bB.json()) !== ka, `A ${a.status}, B with A's cookie ${bA.status}, B's own ${bB.status}`, [bA])
    })
    await safe(T, 'the same Idempotency-Key at B is B\'s own write, never a replay of A\'s', async () => {
      const k = `hb-key-${hex(6)}`
      const a = await as(A, A.adminCookie).post(`/data/${A.tableId}/rows`, { values: { Title: `${A.marker}-idem` } }, { headers: { 'idempotency-key': k } })
      const a2 = await as(A, A.adminCookie).post(`/data/${A.tableId}/rows`, { values: { Title: `${A.marker}-idem` } }, { headers: { 'idempotency-key': k } })
      const b = await as(B, B.adminCookie).post(`/data/${B.tableId}/rows`, { values: { Title: 'b-idem' } }, { headers: { 'idempotency-key': k } })
      const idOf = (x) => x.json()?.row?.id ?? x.json()?.id
      rec(T, 'the same Idempotency-Key at B is B\'s own write, never a replay of A\'s', a.status === 200 && !!idOf(a) && idOf(a2) === idOf(a) && b.status === 200 && !!idOf(b) && idOf(b) !== idOf(a) && !b.body.includes(A.marker), `A ${a.status} (replay gives the same row: ${idOf(a2) === idOf(a)}), B ${b.status} (own row: ${idOf(b) !== idOf(a)})`, [b], A)
    })
    await safe(T, 'webhook and WhatsApp callback addresses of A answer nothing at B', async () => {
      const hook = await via(B.host, 'POST', `${API}/hooks/default/flow_${hex(6)}/${hex(16)}`, { body: { x: 1 }, headers: { 'x-appbuilder': '' } })
      const wa = await via(B.host, 'GET', `${API}/whatsapp/webhook/default/conn_${hex(6)}?hub.mode=subscribe&hub.verify_token=${hex(8)}&hub.challenge=4242`)
      rec(T, 'webhook and WhatsApp callback addresses of A answer nothing at B', hook.status >= 400 && wa.status >= 400 && !wa.body.includes('4242'), `hook ${hook.status}, whatsapp verify ${wa.status} (looked up in B's own database: A's ids do not exist there)`, [hook, wa])
    })
    await safe(T, 'web app manifests and the service worker name no host: each install is its own origin', async () => {
      const ma = await via(A.host, 'GET', `${API}/pwa/manifest.webmanifest`)
      const mb = await via(B.host, 'GET', `${API}/pwa/manifest.webmanifest`)
      const swb = await via(B.host, 'GET', `${API}/pwa/sw.js`)
      const m = mb.json() ?? {}
      const ok = ma.status === 200 && mb.status === 200 && swb.status === 200 && m.scope === '/' && !/^[a-z]+:/i.test(String(m.start_url ?? '')) && ![mb.body, swb.body].some((t) => t.includes(DOMAIN))
      rec(T, 'web app manifests and the service worker name no host: each install is its own origin', ok, `scope ${m.scope}, start_url ${m.start_url}`, [mb, swb])
    })

    /* -------------------------------------------------------------- 4. database roles */
    const D = 'Database roles'
    const roleA = { ...fleet.cluster.conn, user: A.role, password: A.password }
    const neg = opaqueId()
    await createInstallDatabase(fleet, neg, hex(12), { defaultGrants: true })
    await safe(D, 'NEGATIVE CONTROL: a database left with PostgreSQL\'s default grants is reachable by A\'s role (the suite detects it)', async () => {
      const r = await tryConnect(roleA, neg)
      results.push({ area: D, check: 'NEGATIVE CONTROL: a database left with PostgreSQL\'s default grants is reachable by A\'s role (the suite detects it)', ok: r.ok, detail: r.ok ? 'detected: connected (as the spec measured)' : `NOT detected: ${r.code}`, control: true })
    })
    const sharedRevocable = process.env.APPBUILDER_HB_SHARED_CLUSTER !== '1'
    if (sharedRevocable) {
      await safe(D, 'NEGATIVE CONTROL: before the cluster preparation A\'s role reaches the postgres database', async () => {
        const r = await tryConnect(roleA, 'postgres')
        results.push({ area: D, check: 'NEGATIVE CONTROL: before the cluster preparation A\'s role reaches the postgres database', ok: r.ok, detail: r.ok ? 'detected: connected' : `not detected: ${r.code}`, control: true })
      })
      await revokeShared(fleet)
    }
    await safe(D, 'A\'s role connects to its own database (control)', async () => {
      const r = await tryConnect(roleA, A.dbName)
      rec(D, 'A\'s role connects to its own database (control)', r.ok, r.code)
    })
    for (const [what, db] of [['B\'s database', B.dbName], ['C\'s database', C.dbName], ['postgres', 'postgres'], ['template1', 'template1']]) {
      const name = `A's role cannot connect to ${what}`
      if (!sharedRevocable && (db === 'postgres' || db === 'template1')) { results.push({ area: D, check: name, ok: true, skipped: true, detail: 'not run: APPBUILDER_HB_SHARED_CLUSTER=1 (the cluster is shared)' }); continue }
      await safe(D, name, async () => {
        const r = await tryConnect(roleA, db)
        rec(D, name, !r.ok && r.code === '42501', `${r.code}: ${r.message.slice(0, 80)}`, [r.message])
      })
    }
    await safe(D, 'A\'s role with B\'s role name and A\'s password, or B\'s name with a guess, is refused', async () => {
      const r1 = await tryConnect({ ...roleA, user: B.role }, B.dbName)
      const r2 = await tryConnect({ ...roleA, user: B.role, password: 'postgres' }, B.dbName)
      rec(D, 'A\'s role with B\'s role name and A\'s password, or B\'s name with a guess, is refused', !r1.ok && !r2.ok && r1.code === '28P01', `${r1.code} ${r2.code}`)
    })
    const sqlAsA = async (sql, params) => {
      const pg = (await import('pg')).default
      const c = new pg.Client({ ...roleA, database: A.dbName })
      c.on('error', () => {})
      await c.connect()
      try { return { ok: true, rows: (await c.query(sql, params)).rows } } catch (e) { return { ok: false, code: e.code, message: e.message } } finally { await c.end().catch(() => {}) }
    }
    await safe(D, 'A\'s role: no superuser, CREATEDB, CREATEROLE, replication or BYPASSRLS; limit 12; statement timeout 60 s', async () => {
      const r = await sqlAsA(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit, current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS it FROM pg_roles WHERE rolname = current_user`)
      const x = r.rows?.[0] ?? {}
      rec(D, 'A\'s role: no superuser, CREATEDB, CREATEROLE, replication or BYPASSRLS; limit 12; statement timeout 60 s', r.ok && !x.rolsuper && !x.rolcreatedb && !x.rolcreaterole && !x.rolreplication && !x.rolbypassrls && x.rolconnlimit === 12 && x.st === '1min' && x.it === '5min', JSON.stringify(x))
    })
    for (const [what, sql] of [
      ['CREATE DATABASE', `CREATE DATABASE ab_hb_x${hex(3)}`],
      ['ALTER ROLE of B', `ALTER ROLE "${B.role}" PASSWORD 'x'`],
      ['SET ROLE to B', `SET ROLE "${B.role}"`],
      ['GRANT B\'s role to itself', `GRANT "${B.role}" TO "${A.role}"`],
      ['COPY TO PROGRAM', `COPY (SELECT 1) TO PROGRAM 'echo x'`],
      ['pg_read_file', `SELECT pg_read_file('postgresql.conf')`],
      ['pg_ls_dir', `SELECT pg_ls_dir('.')`],
      ['CREATE EXTENSION dblink', 'CREATE EXTENSION dblink'],
      ['CREATE EXTENSION postgres_fdw', 'CREATE EXTENSION postgres_fdw'],
      ['lo_import of a server file', `SELECT lo_import('postgresql.conf')`],
      ['ALTER SYSTEM', `ALTER SYSTEM SET max_connections = 5`],
    ]) {
      const name = `A's role cannot ${what}`
      await safe(D, name, async () => {
        const r = await sqlAsA(sql)
        rec(D, name, !r.ok, r.ok ? 'ALLOWED' : `${r.code}`, [r.message ?? ''])
      })
    }
    await safe(D, 'the catalogue is readable by every role (by design): database and role names are opaque ids', async () => {
      const r = await sqlAsA(`SELECT datname FROM pg_database WHERE datname LIKE 'ab\\_hb\\_%' UNION ALL SELECT rolname FROM pg_roles WHERE rolname LIKE 'ab\\_hb\\_%'`)
      const names = (r.rows ?? []).map((x) => x.datname)
      const opaque = names.every((n) => /^ab_hb_o[a-z2-7]{8}$/.test(n))
      results.push({ area: D, check: 'the catalogue is readable by every role (by design): database and role names are opaque ids', ok: r.ok && names.includes(B.dbName) && opaque, detail: `${names.length} names visible, all opaque: ${opaque}` })
    })
    await safe(D, 'pg_stat_activity shows A nothing of B\'s sessions (no query text, no client address)', async () => {
      // B is busy meanwhile, so its connections carry recent statements
      await as(B, B.adminCookie).post('/query', { plan: { version: 2, table: 'HbMark' } })
      const r = await sqlAsA(`SELECT usename, query, client_addr::text AS addr, datname FROM pg_stat_activity WHERE usename = $1`, [B.role])
      const rows = r.rows ?? []
      const shown = rows.filter((x) => (x.query && x.query !== '<insufficient privilege>') || x.addr)
      rec(D, 'pg_stat_activity shows A nothing of B\'s sessions (no query text, no client address)', r.ok && shown.length === 0, `${rows.length} rows of B's role, ${shown.length} with details`, [JSON.stringify(rows)])
    })
    await safe(D, 'A\'s role cannot hold more than 12 connections; B still connects meanwhile (no starvation)', async () => {
      const pg = (await import('pg')).default
      const open = []
      let refused = null
      for (let i = 0; i < 20 && !refused; i++) {
        const c = new pg.Client({ ...roleA, database: A.dbName, connectionTimeoutMillis: 10_000 })
        c.on('error', () => {})
        try { await c.connect(); open.push(c) } catch (e) { refused = e }
      }
      const admin = await fleet.admin()
      const held = Number((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1', [A.role])).rows[0].n)
      await admin.end()
      const b = await as(B, B.adminCookie).post('/query', { plan: { version: 2, table: 'HbMark' } })
      const bRole = await tryConnect({ ...fleet.cluster.conn, user: B.role, password: B.password }, B.dbName)
      for (const c of open) await c.end().catch(() => {})
      rec(D, 'A\'s role cannot hold more than 12 connections; B still connects meanwhile (no starvation)', refused?.code === '53300' && held <= 12 && b.status === 200 && bRole.ok, `opened ${open.length} more, then ${refused?.code ?? 'never refused'}; A's role held ${held}; B answered ${b.status}`)
      // A's server recovers its pool once they are released
      await sleep(500)
    })
    await safe(D, 'statement timeout: applies to every new session of A\'s role (the role can still lower or lift it itself: residual)', async () => {
      const r = await sqlAsA(`SET statement_timeout = '200ms'; SELECT pg_sleep(1)`)
      const lift = await sqlAsA(`SET statement_timeout = 0; SHOW statement_timeout`)
      results.push({ area: D, check: 'statement timeout: applies to every new session of A\'s role (the role can still lower or lift it itself: residual)', ok: !r.ok && r.code === '57014', detail: `a 200 ms timeout cancels (${r.code}); SET statement_timeout = 0 by the role itself: ${lift.ok ? 'possible (PostgreSQL has no per-role ceiling)' : 'refused'}` })
    })

    /* -------------------------------------------------------------- 5. outbound from A */
    const O = 'Outbound from A'
    const adm = as(A, A.adminCookie)
    const canaryHits = () => fleet.canaries.hits.http.length + fleet.canaries.hits.tcp.length
    const hosts = [
      '127.0.0.1', 'localhost', 'app.localhost', '127.1', '2130706433', '0x7f000001', '0177.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::]', '0.0.0.0',
      '10.0.0.7', '169.254.169.254', 'metadata.google.internal', '[fe80::1]', `loop.${DNS_DOMAIN}`, `six.${DNS_DOMAIN}`, `mapped.${DNS_DOMAIN}`, `meta.${DNS_DOMAIN}`,
      `ten.${DNS_DOMAIN}`, `cgnat.${DNS_DOMAIN}`, B.host, A.host, `x.${B.host}`,
    ]
    let n = 0
    for (const h of hosts) {
      const name = `HTTP connector to ${h} (with "allow private network") is refused and reaches nothing`
      await safe(O, name, async () => {
        const before = canaryHits()
        const c = await adm.post('/connections', { name: `Hb http ${++n}`, connector: 'http', settings: { baseUrl: `http://${h}:${PORTS.httpCanary}/`, allowPrivateNetwork: 'true' } })
        const id = c.json()?.id
        const t = id ? await adm.post(`/connections/${id}/actions/request/test`, { inputs: { path: '/' } }) : c
        const ok = (c.status === 422 || c.json()?.status === 'error') && (t.status >= 400 || t.json()?.ok === false) && canaryHits() === before
        rec(O, name, ok, `create ${c.status} ${c.json()?.status ?? ''}; call ${t.json()?.error?.code ?? t.status}; canary ${canaryHits() - before}`, [c, t])
      })
    }
    await safe(O, 'OAuth token address on loopback is refused and reaches nothing', async () => {
      const before = canaryHits()
      const c = await adm.post('/connections', { name: 'Hb oauth', connector: 'http', settings: { baseUrl: 'https://api.example.com/', authMode: 'oauth2cc', tokenUrl: `http://127.0.0.1:${PORTS.httpCanary}/token`, clientId: 'x', allowPrivateNetwork: 'true' }, secret: JSON.stringify({ clientSecret: 'x' }) })
      const id = c.json()?.id
      const t = id ? await adm.post(`/connections/${id}/actions/request/test`, { inputs: { path: '/' } }) : c
      rec(O, 'OAuth token address on loopback is refused and reaches nothing', canaryHits() === before && (c.status === 422 || t.json()?.ok === false || t.status >= 400), `create ${c.status}; call ${t.json()?.error?.code ?? t.status}; canary ${canaryHits() - before}`, [c, t])
    })
    const dbHosts = [
      ['127.0.0.1', PORTS.tcpCanary], ['localhost', PORTS.tcpCanary], [`loop.${DNS_DOMAIN}`, PORTS.tcpCanary], [`six.${DNS_DOMAIN}`, PORTS.tcpCanary], ['[::1]', PORTS.tcpCanary], ['::1', PORTS.tcpCanary],
      ['10.0.0.7', 5432], ['127.0.0.1', PORTS.pg], [B.host, PORTS.pg],
      [fleet.cluster.unixSocketDir ?? '/var/run/postgresql', PORTS.pg], ['/tmp', PORTS.pg], ['\\\\.\\pipe\\appbuilder-hb', PORTS.pg],
    ]
    for (const [kind, hp] of [['postgres', dbHosts], ['mysql', dbHosts.slice(0, 6)]]) {
      for (const [h, port] of hp) {
        const name = `${kind} connection to ${h}:${port} (B's database and role) is refused, also when used later, and reaches nothing`
        await safe(O, name, async () => {
          const before = canaryHits()
          const c = await adm.post('/connections', { name: `Hb ${kind} ${++n}`, connector: kind, settings: { host: h, port: String(port), database: B.dbName, user: B.role }, secret: 'guess' })
          const id = c.json()?.id
          // the stored connection used afterwards: listing its tables connects (a check only at save time would not be enough)
          const use = id ? await adm.get(`/connections/${id}/source-tables`) : null
          const t = id ? await adm.post(`/connections/${id}/test`, {}) : null
          await sleep(300)
          const reached = canaryHits() - before
          const ok = reached === 0 && (c.status === 422 || c.json()?.status === 'error') && (!use || use.status >= 400) && (!t || t.json()?.ok !== true)
          rec(O, name, ok, `create ${c.status} ${c.json()?.status ?? ''}; tables ${use?.status ?? '-'}; test ${t?.json()?.ok ?? '-'}; canary ${reached}`, [c, use, t].filter(Boolean))
        })
      }
    }
    await safe(O, 'SMTP relay on loopback or a name resolving to it is refused and reaches nothing', async () => {
      const before = canaryHits()
      const rs = []
      for (const h of ['127.0.0.1', `loop.${DNS_DOMAIN}`, 'localhost']) {
        rs.push(await adm.put('/identity/email', { host: h, port: PORTS.tcpCanary, security: 'none', username: '', verifyCertificate: false, fromAddress: 'apps@a-org.example', fromName: 'A', replyTo: '', installName: 'A', publicUrl: A.url }))
        rs.push(await adm.post('/identity/email/test', { to: A.adminEmail }))
      }
      await sleep(500)
      rec(O, 'SMTP relay on loopback or a name resolving to it is refused and reaches nothing', canaryHits() === before && rs.filter((_, i) => i % 2 === 1).every((r) => r.status >= 400), `${rs.map((r) => r.status).join(' ')}; canary ${canaryHits() - before}`, rs)
    })
    await safe(O, 'heartbeat address on loopback is refused and reaches nothing', async () => {
      const before = canaryHits()
      const s = await adm.put('/admin/health-alerts', { heartbeat: { enabled: true, everyMinutes: 5, allowPrivateNetwork: true, url: `http://127.0.0.1:${PORTS.httpCanary}/ping` } })
      const s2 = await adm.put('/admin/health-alerts', { heartbeat: { enabled: true, everyMinutes: 5, allowPrivateNetwork: true, url: `http://loop.${DNS_DOMAIN}:${PORTS.httpCanary}/ping` } })
      const t = await adm.post('/admin/health-alerts/test', { what: 'heartbeat' })
      await sleep(300)
      rec(O, 'heartbeat address on loopback is refused and reaches nothing', canaryHits() === before && s.status === 422, `literal ${s.status}, name ${s2.status}, test ${t.status} ${t.json()?.ok ?? ''}; canary ${canaryHits() - before}`, [s, s2, t])
    })
    await safe(O, 'NEGATIVE CONTROL: the on-premises policy (private networks allowed) reaches the loopback canary', async () => {
      const { safeRequest } = await import(pathToFileURL(path.join(root, 'server/core/actions/outbound.ts')).href)
      const before = fleet.canaries.hits.http.length
      const p = { allowedHosts: ['127.0.0.1'], allowPrivate: true, maxRedirects: 0, maxResponseBytes: 10_000, timeoutMs: 5000, verifyTls: true, env: {} }
      const r = await safeRequest({ method: 'GET', url: `http://127.0.0.1:${PORTS.httpCanary}/` }, p).catch((e) => ({ status: 0, e }))
      let hosted = null
      try { await safeRequest({ method: 'GET', url: `http://127.0.0.1:${PORTS.httpCanary}/` }, { ...p, env: { APPBUILDER_OUTBOUND_PRIVATE: 'deny' } }) } catch (e) { hosted = e.code }
      results.push({ area: O, check: 'NEGATIVE CONTROL: the on-premises policy (private networks allowed) reaches the loopback canary', ok: r.status === 200 && fleet.canaries.hits.http.length === before + 1 && hosted === 'blocked', detail: `on-premises: ${r.status} (canary +${fleet.canaries.hits.http.length - before}); hosted policy: ${hosted}`, control: true })
    })
    await safe(O, 'redirect hops are checked like the first one (in-process, product code)', async () => {
      const { safeRequest } = await import(pathToFileURL(path.join(root, 'server/core/actions/outbound.ts')).href)
      // the canary answers 200; a tiny local server answers a redirect to the cloud metadata address
      const srv = await new Promise((resolve) => {
        const s = net.createServer((sock) => { sock.once('data', () => sock.end('HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')); sock.on('error', () => {}) })
        s.listen(PORTS.tcpCanary + 1, '127.0.0.1', () => resolve(s))
      })
      let code = null
      try { await safeRequest({ method: 'GET', url: `http://127.0.0.1:${PORTS.tcpCanary + 1}/` }, { allowedHosts: ['127.0.0.1', '169.254.169.254'], allowPrivate: true, maxRedirects: 3, maxResponseBytes: 10_000, timeoutMs: 5000, verifyTls: true, env: {} }) } catch (e) { code = `${e.code}: ${e.message}` }
      await new Promise((r) => srv.close(() => r()))
      results.push({ area: O, check: 'redirect hops are checked like the first one (in-process, product code)', ok: /^blocked/.test(code ?? ''), detail: code ?? 'followed' })
    })

    /* -------------------------------------------------------------- 6. files and folders */
    const F = 'Files and folders'
    await safe(F, 'path tricks in attachment, backup and generated-file ids reach no file', async () => {
      const ids = ['..%2F..%2F..%2Fb%2Fworkspace%2F.secret-key', '..%5C..%5C..%5Cb%5Cworkspace%5C.secret-key', encodeURIComponent(path.join(B.workspace, '.secret-key')), '%2e%2e%2f%2e%2e%2fserver.json']
      const rs = []
      for (const id of ids) {
        rs.push(await adm.get(`/attachments/${id}`))
        rs.push(await adm.get(`/backups/${id}`))
        rs.push(await adm.get(`/backups/${id}/download`))
        rs.push(await adm.get(`/print/files/${id}`))
      }
      rec(F, 'path tricks in attachment, backup and generated-file ids reach no file', rs.every((r) => r.status >= 400 && !r.body.includes(A.secretKey)), rs.map((r) => r.status).join(' '), rs)
    })
    await safe(F, 'APPBUILDER_INSTANCE_DIR: a backup folder in B\'s folder and a tools folder are refused; nothing is created', async () => {
      const target = path.join(B.dir, 'backups', `from-a-${hex(3)}`)
      const r = await adm.put('/backups/settings', { folder: target })
      const r2 = await adm.put('/backups/settings', { offsite: { folder: target, enabled: true } })
      const r3 = await adm.put('/backups/settings', { pgBinPath: path.join(B.dir) })
      rec(F, 'APPBUILDER_INSTANCE_DIR: a backup folder in B\'s folder and a tools folder are refused; nothing is created', r.status === 422 && r2.status === 422 && r3.status === 422 && !fs.existsSync(target), `${r.status} ${r2.status} ${r3.status}; created: ${fs.existsSync(target)}`, [])
    })
    await safe(F, 'A\'s backups API lists and serves only A\'s archives (B\'s backup id is unknown at A)', async () => {
      const bk = await as(B, B.adminCookie).post('/backups', { scope: 'install' })
      const bid = bk.json()?.id ?? bk.json()?.backup?.id
      let st = ''
      for (let i = 0; i < 60; i++) {
        const l = (await as(B, B.adminCookie).get('/backups')).json()
        st = (l?.items ?? []).find((x) => x.id === bid)?.state ?? st
        if (st && st !== 'queued' && st !== 'running') break
        await sleep(1000)
      }
      const list = await adm.get('/backups')
      const one = await adm.get(`/backups/${bid}`)
      const tk = await adm.post(`/backups/${bid}/download-ticket`, {})
      const rs = await adm.post(`/backups/${bid}/restore`, { mode: 'copy' })
      rec(F, 'A\'s backups API lists and serves only A\'s archives (B\'s backup id is unknown at A)', !!bid && !list.body.includes(bid) && one.status === 404 && tk.status >= 400 && rs.status >= 400, `B's backup ${bk.status} ${st}; at A: list without it, get ${one.status}, ticket ${tk.status}, restore ${rs.status}`, [list, one, tk, rs])
    })

    /* -------------------------------------------------------------- 7. read-only state */
    const RO = 'Read-only state'
    await safe(RO, 'suspending B (read-only) does not affect A or C; A\'s command cannot clear B\'s state', async () => {
      const on = B.cli(['read-only', 'on', '--reason', 'suspended'])
      let bw = 0
      for (let i = 0; i < 40; i++) {
        bw = (await as(B, B.adminCookie).post(`/data/${B.tableId}/rows`, { values: { Title: 'b' } })).status
        if (bw === 503) break
        await sleep(300)
      }
      const aw = await as(A, A.adminCookie).post(`/data/${A.tableId}/rows`, { values: { Title: 'a' } })
      const cw = await as(C, C.adminCookie).post(`/data/${C.tableId}/rows`, { values: { Title: 'c' } })
      const offA = A.cli(['read-only', 'off'])
      await sleep(6000)
      const bw2 = (await as(B, B.adminCookie).post(`/data/${B.tableId}/rows`, { values: { Title: 'b' } })).status
      const st = await as(B, B.adminCookie).get('/install/read-only')
      B.cli(['read-only', 'off'])
      rec(RO, 'suspending B (read-only) does not affect A or C; A\'s command cannot clear B\'s state', on.status === 0 && bw === 503 && aw.status === 200 && cw.status === 200 && offA.status === 0 && bw2 === 503 && st.json()?.readOnly?.reason === 'suspended', `B write ${bw}, A ${aw.status}, C ${cw.status}; after A's "read-only off": B write ${bw2}`, [aw, cw], B)
    })

    /* -------------------------------------------------------------- 8. logs */
    const L = 'Logs'
    await safe(L, 'A\'s console and log files hold nothing of B, and none of A\'s own secrets', async () => {
      const files = []
      const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(log|jsonl)$/.test(e.name) || e.name.includes('log')) files.push(p) } }
      walk(path.join(A.workspace, 'logs'))
      const text = [A.out(), ...files.map((f) => fs.readFileSync(f, 'utf8'))].join('\n')
      const ownSecrets = [A.password, A.secretKey, A.adminPassword, A.adminCookie.split('=')[1], A.apiKey, A.viewToken].filter(Boolean)
      const own = ownSecrets.filter((s) => text.includes(s)).length
      rec(L, 'A\'s console and log files hold nothing of B, and none of A\'s own secrets', own === 0 && text.length > 0, `${files.length} log file(s), ${text.length} characters; A's own secrets found: ${own}`, [text])
    })
  } finally {
    log('stopping the fleet ...')
    await fleet.stop()
  }
  const linuxOnly = !WIN ? [] : ['the installs listen on TCP 127.0.0.1 here; on Linux (CI) they listen on Unix sockets, as hosted installs do']
  return { results, notes: [...notes, ...fleet.notes, ...linuxOnly], env, seconds: Math.round((Date.now() - t0) / 1000) }
}

/** the Markdown table: one row per area (checks, passed, failed), then every failed check */
export function report(r) {
  const areas = new Map()
  for (const x of r.results) {
    const a = areas.get(x.area) ?? { n: 0, pass: 0, fail: 0, skipped: 0 }
    a.n++
    if (x.skipped) a.skipped++
    else if (x.ok) a.pass++
    else a.fail++
    areas.set(x.area, a)
  }
  const lines = ['| Area | Checks | Passed | Failed | Not run |', '| --- | ---: | ---: | ---: | ---: |']
  for (const [k, v] of areas) lines.push(`| ${k} | ${v.n} | ${v.pass} | ${v.fail} | ${v.skipped} |`)
  const tot = r.results.length
  const fail = r.results.filter((x) => !x.ok && !x.skipped)
  lines.push(`| **All** | **${tot}** | **${r.results.filter((x) => x.ok && !x.skipped).length}** | **${fail.length}** | **${r.results.filter((x) => x.skipped).length}** |`)
  lines.push('', 'Negative controls (each must be detected):', '')
  for (const c of r.results.filter((x) => x.control)) lines.push(`- ${c.ok ? 'detected' : 'NOT DETECTED'}: ${c.check.replace(/^NEGATIVE CONTROL: /, '')} (${c.detail})`)
  if (fail.length) {
    lines.push('', '| Failed check | Area | Detail |', '| --- | --- | --- |')
    for (const f of fail) lines.push(`| ${f.check} | ${f.area} | ${String(f.detail).replace(/\|/g, '/')} |`)
  }
  lines.push('', `Run: ${r.env.platform}, PostgreSQL ${r.env.cluster}, installs on ${r.env.listen}, ${r.seconds} s.`)
  for (const n of r.notes) lines.push(`- ${n}`)
  return lines.join('\n')
}
