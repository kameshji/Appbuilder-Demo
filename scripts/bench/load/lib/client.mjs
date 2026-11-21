/**
 * The load harness's HTTP and WebSocket clients (scripts/bench/load). One keep-alive agent per install (what Caddy's
 * upstream pool does); every virtual user has its own session cookie and its own client address (X-Forwarded-For, which
 * the install trusts behind its proxy), so sign-in throttles and rate limits see people, not the harness.
 */
import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'
import { sessionCookie } from './fleet.mjs'

export function agentFor(o = {}) {
  return new http.Agent({ keepAlive: true, maxSockets: o.maxSockets ?? 48, maxFreeSockets: o.maxSockets ?? 48, keepAliveMsecs: 10_000, timeout: 120_000 })
}

/**
 * The recorder: every request lands in one sample list per phase + scenario + step, and one per phase + org + class
 * (read / write / job / heavy / auth) for the noisy-neighbour comparison.
 */
export function recorder() {
  const byKey = new Map()
  const byOrg = new Map()
  const errors = new Map()
  const counts = { requests: 0, errors: 0, statuses: {} }
  let phase = 'setup'
  const push = (m, k, v) => { let a = m.get(k); if (!a) { a = []; m.set(k, a) } a.push(v) }
  return {
    setPhase(p) { phase = p },
    get phase() { return phase },
    record(e) {
      counts.requests++
      counts.statuses[e.status] = (counts.statuses[e.status] ?? 0) + 1
      const ph = e.phase ?? phase
      const k = `${ph}|${e.scenario}|${e.step}|${e.cls}`
      push(byKey, k, e.ms)
      push(byOrg, `${ph}|${e.org}|${e.cls}`, e.ms)
      if (e.error) {
        counts.errors++
        push(byKey, `${k}|err`, 1)
        const ek = `${e.status} ${e.scenario}/${e.step}: ${String(e.message ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\d{3,}/g, '<n>').slice(0, 160)}`
        const x = errors.get(ek) ?? { n: 0, phases: new Set(), orgs: new Set(), first: Date.now() }
        x.n++
        x.phases.add(ph)
        x.orgs.add(e.org)
        errors.set(ek, x)
      }
    },
    byKey, byOrg, errors, counts,
  }
}

/** a person: a session on one install, a client address, a role in the pack */
export class Person {
  constructor(inst, user, ctx) {
    this.inst = inst
    this.user = user
    this.ctx = ctx
    this.cookie = ''
    this.ip = user.ip
    this.busy = false
  }

  /** one request, timed from the first byte written to the last byte read; recorded unless o.record === false */
  req(method, p, o = {}) {
    const inst = this.inst
    const ctx = this.ctx
    return new Promise((resolve) => {
      const payload = o.body === undefined ? undefined : Buffer.isBuffer(o.body) || typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
      const headers = {
        host: inst.host, 'x-appbuilder': '1', 'x-forwarded-proto': 'https', 'x-forwarded-for': this.ip,
        'user-agent': o.ua ?? this.user.ua ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 (load test)',
        ...(payload !== undefined ? { 'content-type': o.contentType ?? 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(o.headers ?? {}),
      }
      const t0 = performance.now()
      const phase = ctx.rec.phase
      let done = false
      const finish = (status, buf, message, resHeaders) => {
        if (done) return
        done = true
        const ms = performance.now() - t0
        const expected = o.ok ?? ((s) => s >= 200 && s < 300)
        const error = !expected(status)
        let json = null
        const parse = () => { if (json === null) { try { json = JSON.parse(buf.toString('utf8')) } catch { json = undefined } } return json }
        if (o.record !== false) {
          let msg = message
          if (error && !msg) msg = parse()?.error?.message ?? buf.toString('utf8').slice(0, 120)
          ctx.rec.record({ phase, org: inst.key, scenario: o.scenario ?? 'other', step: o.step ?? `${method} ${p.split('?')[0]}`, cls: o.cls ?? (method === 'GET' ? 'read' : 'write'), ms, status, error, message: msg })
        }
        resolve({ status, ms, buf, headers: resHeaders ?? {}, json: parse, error })
      }
      const req = http.request({ host: '127.0.0.1', port: inst.port, method, path: '/api/v1' + p, headers, agent: ctx.agents.get(inst.key), timeout: o.timeout ?? 120_000 }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => finish(res.statusCode ?? 0, Buffer.concat(chunks), null, res.headers))
        res.on('error', (e) => finish(0, Buffer.alloc(0), `response: ${e.code ?? e.message}`))
      })
      req.on('error', (e) => finish(0, Buffer.alloc(0), `network: ${e.code ?? e.message}`))
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })))
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  /** o.fresh: as a new device (no cookie sent; signing in with a session cookie replaces that session) */
  async signIn(o = {}) {
    const keep = this.cookie
    if (o.fresh) this.cookie = ''
    const r = await this.req('POST', '/auth/login', { body: { email: this.user.email, password: this.user.password }, scenario: o.scenario ?? 'sign_in', step: 'login', cls: 'auth', record: o.record })
    if (r.status === 200) {
      const set = [].concat(r.headers['set-cookie'] ?? [])
      const c = sessionCookie({ headers: { 'set-cookie': set } })
      if (c) this.cookie = c
    } else this.cookie = keep
    return r
  }
}

/**
 * One live socket (/api/v1/live) of a person, with the headers a browser sends behind the proxy. handlers: onTable,
 * onChat, onUser (each (msg, receivedAt)).
 */
export function openLive(person, handlers = {}) {
  const inst = person.inst
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/api/v1/live`, {
      headers: { Host: inst.host, Origin: `https://${inst.host}`, Cookie: person.cookie, 'X-Forwarded-For': person.ip, 'X-Forwarded-Proto': 'https' },
      perMessageDeflate: false, handshakeTimeout: 20_000,
    })
    const s = { ws, person, open: false, closed: null, hello: null, subs: new Map(), received: 0, pending: new Map(), seq: 1 }
    s.sub = (topic, env) => new Promise((res) => {
      const id = `s${s.seq++}`
      s.pending.set(id, res)
      try { ws.send(JSON.stringify({ t: 'sub', id, topic, ...(env ? { env } : {}) })) } catch { s.pending.delete(id); res({ t: 'error', code: 'closed' }) }
      setTimeout(() => { if (s.pending.has(id)) { s.pending.delete(id); res({ t: 'error', code: 'timeout' }) } }, 15_000)
    })
    ws.on('open', () => { s.open = true })
    ws.on('message', (d) => {
      const at = performance.now()
      s.received++
      let m
      try { m = JSON.parse(d.toString()) } catch { return }
      if (m.t === 'hello') { s.hello = m; resolve(s); return }
      if ((m.t === 'subscribed' || m.t === 'error') && m.id && s.pending.has(m.id)) { const f = s.pending.get(m.id); s.pending.delete(m.id); if (m.t === 'subscribed') s.subs.set(m.topic, m); f(m); return }
      if (m.t === 'table') handlers.onTable?.(m, at, s)
      else if (m.t === 'chat') handlers.onChat?.(m, at, s)
      else if (m.t === 'user') handlers.onUser?.(m, at, s)
      else if (m.t === 'resync') handlers.onResync?.(m, at, s)
    })
    ws.on('close', (code) => { s.open = false; s.closed = { code, at: Date.now() }; resolve(s); handlers.onClose?.(s, code) })
    ws.on('error', () => { /* the close follows */ })
    setTimeout(() => resolve(s), 25_000)
  })
}
