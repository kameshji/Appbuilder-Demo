import { describe, expect, it } from 'vitest'
import { MemoryKV } from './kv'
import { codecFor, decodeJson, encodeJson, toBase64Url } from './codec'
import { Outbox, type SendRequest, type SendResult, type Transport } from './outbox'

const KEY = toBase64Url(new Uint8Array(32).map((_, i) => i + 1))
const KEY2 = toBase64Url(new Uint8Array(32).map((_, i) => 200 - i))

/** a fake server: rows by id, idempotency keys remembered, scripted failures */
function fakeServer() {
  const rows = new Map<string, Record<string, unknown>>()
  const keys = new Map<string, unknown>()
  const log: string[] = []
  let offline = false
  const script: Array<(r: SendRequest) => SendResult | null> = []
  let version = 0
  const transport: Transport = {
    async send(r) {
      if (offline) return { ok: false, network: true }
      const s = script.shift()?.(r)
      if (s) return s
      const hit = keys.get(r.idempotencyKey)
      if (hit) return { ok: true, result: { ...(hit as object), replayed: true } }
      log.push(`${r.item.kind}:${r.item.rowId}`)
      let result: unknown
      if (r.item.kind === 'create') {
        if (rows.has(r.item.rowId)) return { ok: false, status: 409, code: 'conflict', message: 'exists', field: 'id' }
        const row = { id: r.item.rowId, ...r.body.values, modifiedOn: `v${++version}` }
        rows.set(r.item.rowId, row)
        result = { row }
      } else if (r.item.kind === 'update') {
        const cur = rows.get(r.item.rowId)
        if (!cur) return { ok: false, status: 404, code: 'not-found', message: 'Row not found.' }
        if (r.body.ifModifiedOn && r.body.ifModifiedOn !== cur.modifiedOn) return { ok: false, status: 409, code: 'conflict', message: 'changed', field: 'modifiedOn', current: cur }
        const row = { ...cur, ...r.body.values, modifiedOn: `v${++version}` }
        rows.set(r.item.rowId, row)
        result = { row }
      } else {
        result = { id: `att_${log.length}`, size: r.file?.size }
      }
      keys.set(r.idempotencyKey, result)
      return { ok: true, result }
    },
  }
  return { rows, keys, log, transport, script, setOffline: (v: boolean) => { offline = v } }
}

async function box(kv = new MemoryKV(), server = fakeServer(), key = KEY) {
  const o = new Outbox(kv, server.transport)
  await o.load()
  await o.setCodec(await codecFor(key))
  return { o, kv, server }
}
const create = (rowId: string, values: Record<string, unknown> = { Qty: 1 }) => ({ kind: 'create' as const, table: 'Production', rowId, environmentId: 'default', values })

describe('codec', () => {
  it('round-trips dates and refuses a wrong key', async () => {
    const c = await codecFor(KEY)
    const v = { a: new Date('2026-01-02T03:04:05Z'), n: [1, 'x', null] }
    expect(decodeJson(encodeJson(v))).toEqual(v)
    const s = await c.seal(v)
    expect(await c.open(s)).toEqual(v)
    expect(new TextDecoder().decode(new Uint8Array(s.data))).not.toContain('2026')
    const other = await codecFor(KEY2)
    await expect(other.open(s)).rejects.toThrow()
    const b = await c.sealBytes(new Uint8Array([1, 2, 3]).buffer)
    expect([...new Uint8Array(await c.openBytes(b))]).toEqual([1, 2, 3])
  })
})

describe('outbox', () => {
  it('sends in order once online, including uploads after their row', async () => {
    const { o, server } = await box()
    server.setOffline(true)
    await o.add(create('r1'))
    await o.add({ kind: 'update', table: 'Production', rowId: 'r1', environmentId: 'default', values: { Qty: 2 } })
    await o.add({ kind: 'upload', table: 'Production', rowId: 'r1', environmentId: 'default', column: 'Photo', file: new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), fileName: 'p.jpg' })
    await o.add(create('r2'))
    expect(await o.flush()).toEqual({ sent: 0, stopped: 'network' })
    expect(o.count).toBe(4)
    server.setOffline(false)
    expect(await o.flush()).toEqual({ sent: 4 })
    expect(server.log).toEqual(['create:r1', 'update:r1', 'upload:r1', 'create:r2'])
    expect(server.rows.get('r1')?.Qty).toBe(2)
    expect(o.count).toBe(0)
  })

  it('a retry after a lost answer never duplicates (idempotency key)', async () => {
    const { o, server } = await box()
    await o.add(create('r1'))
    // the server writes, but the answer is lost
    server.script.push((r) => {
      server.keys.set(r.idempotencyKey, { row: { id: 'r1' } })
      server.rows.set('r1', { id: 'r1' })
      server.log.push('create:r1')
      return { ok: false, network: true }
    })
    expect((await o.flush()).stopped).toBe('network')
    expect(await o.flush()).toEqual({ sent: 1 })
    expect(server.log).toEqual(['create:r1'])
  })

  it('survives a restart (crash while sending): reloaded items are sent once', async () => {
    const kv = new MemoryKV()
    const server = fakeServer()
    const a = await box(kv, server)
    server.setOffline(true)
    await a.o.add(create('r1'))
    await a.o.add(create('r2'))
    // simulate a crash mid-send: the stored status is 'sending'
    const [k, v] = (await kv.entries<{ status: string }>('outbox'))[0]
    await kv.put('outbox', k, { ...v, status: 'sending' })
    server.setOffline(false)
    const b = new Outbox(kv, server.transport)
    await b.load()
    expect(b.count).toBe(2)
    expect(b.list().every((i) => i.status === 'waiting' && !i.body)).toBe(true) // locked: countable, not readable
    expect(await b.flush()).toEqual({ sent: 0, stopped: 'locked' })
    await b.setCodec(await codecFor(KEY))
    expect(b.list()[0].body?.values).toEqual({ Qty: 1 })
    expect(await b.flush()).toEqual({ sent: 2 })
    // new items continue the sequence after a restart
    await b.add(create('r3'))
    expect(b.list()[0].seq).toBe(3)
  })

  it('conflict: blocks later items of the row, keep mine resends against the new version', async () => {
    const { o, server } = await box()
    server.rows.set('r1', { id: 'r1', Qty: 1, modifiedOn: 'v0' })
    await o.add({ kind: 'update', table: 'Production', rowId: 'r1', environmentId: 'default', values: { Qty: 5 }, ifModifiedOn: 'old' })
    await o.add({ kind: 'update', table: 'Production', rowId: 'r1', environmentId: 'default', values: { Note: 'x' } })
    await o.add(create('r2'))
    expect(await o.flush()).toEqual({ sent: 1 })
    const [first, second] = o.list()
    expect(first.status).toBe('conflict')
    expect(first.body?.current?.modifiedOn).toBe('v0')
    expect(second.blocked).toBe(true)
    await o.keepMine(first.id)
    expect(await o.flush()).toEqual({ sent: 2 })
    expect(server.rows.get('r1')).toMatchObject({ Qty: 5, Note: 'x' })
  })

  it('conflict: use the server version drops the change', async () => {
    const { o, server } = await box()
    server.rows.set('r1', { id: 'r1', Qty: 1, modifiedOn: 'v0' })
    await o.add({ kind: 'update', table: 'Production', rowId: 'r1', environmentId: 'default', values: { Qty: 5 }, ifModifiedOn: 'old' })
    await o.flush()
    await o.useServer(o.list()[0].id)
    expect(o.count).toBe(0)
    expect(server.rows.get('r1')?.Qty).toBe(1)
  })

  it('rejection: fix and resend with corrected values; callbacks report the outcome', async () => {
    const { o, server } = await box()
    server.script.push(() => ({ ok: false, status: 422, code: 'invalid', message: 'Qty must be positive.', field: 'Qty' }))
    const events: string[] = []
    await o.add(create('r1', { Qty: -1 }), { done: () => events.push('done'), fail: (e) => events.push(`fail:${(e as Error).message}`) })
    expect(await o.flush()).toEqual({ sent: 0 })
    const it0 = o.list()[0]
    expect(it0.status).toBe('rejected')
    expect(it0.body?.error).toEqual({ code: 'invalid', message: 'Qty must be positive.', field: 'Qty' })
    expect(events).toEqual(['fail:Qty must be positive.'])
    await o.resend(it0.id, { Qty: 3 })
    expect(o.list()[0].rev).toBe(1)
    expect(await o.flush()).toEqual({ sent: 1 })
    expect(server.rows.get('r1')?.Qty).toBe(3)
  })

  it('5xx and 401 pause the replay; the item stays waiting', async () => {
    const { o, server } = await box()
    await o.add(create('r1'))
    server.script.push(() => ({ ok: false, status: 503, code: 'unavailable', message: 'down' }))
    expect(await o.flush()).toEqual({ sent: 0, stopped: 'server' })
    server.script.push(() => ({ ok: false, status: 401, code: 'unauthenticated', message: 'sign in' }))
    expect(await o.flush()).toEqual({ sent: 0, stopped: 'auth' })
    expect(o.list()[0]).toMatchObject({ status: 'waiting', attempts: 2 })
    expect(await o.flush()).toEqual({ sent: 1 })
  })

  it('concurrent flushes share one replay; pendingFor tracks rows', async () => {
    const { o, server } = await box()
    await o.add(create('r1'))
    expect(o.pendingFor('production', 'r1')).toBe(true)
    const [a, b] = await Promise.all([o.flush(), o.flush()])
    expect(a).toBe(b)
    expect(server.log).toEqual(['create:r1'])
    expect(o.pendingFor('Production', 'r1')).toBe(false)
  })

  it('is encrypted at rest: stored records do not contain the values', async () => {
    const { o, kv } = await box()
    await o.add(create('r1', { Secret: 'batch-4711' }))
    const raw = JSON.stringify((await kv.entries('outbox')).map(([, v]) => v), (_k, v) => (v instanceof ArrayBuffer ? new TextDecoder().decode(v) : v))
    expect(raw).not.toContain('batch-4711')
    expect(raw).toContain('Production') // table and status stay countable
  })

  it('refuses to add while locked', async () => {
    const o = new Outbox(new MemoryKV(), fakeServer().transport)
    await o.load()
    await expect(o.add(create('r1'))).rejects.toThrow(/locked/)
  })
})
