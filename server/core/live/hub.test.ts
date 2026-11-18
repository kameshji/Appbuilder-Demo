/**
 * Unit tests of the realtime protocol and the leak rule (no database): topic parsing, presence scopes, notification
 * settings, do-not-disturb, and tableMessageFor for admins, unrestricted readers, row-scoped readers, hidden columns and
 * users without read access.
 */
import { describe, expect, it } from 'vitest'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { Condition } from '../../../src/platform/http.ts'
import type { UserContext } from '../contracts.ts'
import { tableMessageFor } from './hub.ts'
import { bridgeOutbox, emitTableChange, lastWriterOf, noteLocalWrite, onTableChange, withLiveOrigin } from './changes.ts'
import {
  inDoNotDisturb, parseNotificationSettings, parsePresenceScope, parseTopic,
} from '../../../src/platform/live-protocol.ts'

const def: TableDef = {
  id: 'tbl_t', name: 'T', displayName: 'T', primaryColumn: 'Title', createdOn: '', modifiedOn: '',
  columns: [
    { name: 'id', displayName: 'Id', type: 'text', system: true },
    { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
    { name: 'owner', displayName: 'Owner', type: 'text', system: true },
    { name: 'Title', displayName: 'Title', type: 'text' },
    { name: 'Secret', displayName: 'Secret', type: 'text' },
  ],
}

function ctx(o: { admin?: boolean; read: Condition; hidden?: string[]; access?: boolean }): UserContext {
  return {
    environmentId: 'default',
    user: { id: 'u', name: 'U', email: 'u@x', roleIds: [] },
    roles: [],
    privileges: {
      isAdmin: !!o.admin, isMaker: false, apps: 'all',
      tables: o.access === false ? {} : { tbl_t: { create: false, read: 'all', update: 'none', delete: 'none', columns: Object.fromEntries((o.hidden ?? []).map((c) => [c, 'none'])), filtered: false } },
    } as never,
    rowPredicate: () => o.read,
    canCreate: () => false,
    columnAccess: (_t, c) => ((o.hidden ?? []).includes(c) ? 'none' : 'read'),
    visibleDef: (t) => t,
    canRunApp: () => true,
    session: () => ({}) as never,
  }
}

const change = { op: 'update' as const, rowIds: ['r1', 'r2'], changedColumns: ['Title', 'Secret', 'modifiedOn', 'Nope', 'id'], actor: { id: 'a', name: 'Ada' } }

describe('leak rule (tableMessageFor)', () => {
  it('admins and unrestricted readers get row ids, visible columns and the actor', () => {
    const m = tableMessageFor(ctx({ admin: true, read: { const: true } }), def, 'default', change, 7, 3, 50, 'now')!
    expect(m).toMatchObject({ t: 'table', table: 'tbl_t', topic: 'table:tbl_t', seq: 7, prev: 3, op: 'update', rows: ['r1', 'r2'], by: { id: 'a', name: 'Ada' } })
    expect(m.columns.sort()).toEqual(['Secret', 'Title', 'modifiedOn'])
  })
  it('a hidden column name is never sent', () => {
    const m = tableMessageFor(ctx({ read: { const: true }, hidden: ['Secret'] }), def, 'default', change, 1, 0, 50, 'now')!
    expect(m.columns.sort()).toEqual(['Title', 'modifiedOn'])
    expect(JSON.stringify(m)).not.toContain('Secret')
  })
  it('a row-scoped or row-filtered reader gets a tick: no row ids, no actor', () => {
    for (const read of [{ col: 'owner', op: 'eq', value: 'u' }, { and: [{ col: 'Title', op: 'eq', value: 'x' }] }] as Condition[]) {
      const m = tableMessageFor(ctx({ read, hidden: ['Secret'] }), def, 'default', change, 1, 0, 50, 'now')!
      expect(m.rows).toBeNull()
      expect(m.by).toBeUndefined()
      expect(JSON.stringify(m)).not.toContain('r1')
    }
  })
  it('no read privilege: no message at all', () => {
    expect(tableMessageFor(ctx({ read: { const: false } }), def, 'default', change, 1, 0, 50, 'now')).toBeNull()
    expect(tableMessageFor(ctx({ read: { const: true }, access: false }), def, 'default', change, 1, 0, 50, 'now')).toBeNull()
  })
  it('too many row ids, or unknown ones: rows null', () => {
    const many = { ...change, rowIds: Array.from({ length: 51 }, (_, i) => `r${i}`) }
    expect(tableMessageFor(ctx({ admin: true, read: { const: true } }), def, 'default', many, 1, 0, 50, 'now')!.rows).toBeNull()
    expect(tableMessageFor(ctx({ admin: true, read: { const: true } }), def, 'default', { ...change, rowIds: [] }, 1, 0, 50, 'now')!.rows).toBeNull()
  })
})

describe('change feed', () => {
  it('listeners get the change with the request origin; the last writer of a row is remembered', () => {
    const got: unknown[] = []
    const off = onTableChange((env, t, c) => got.push([env, t, c.origin]))
    withLiveOrigin('conn_abcdefgh', () => emitTableChange('default', 'tbl_x', { op: 'update', rowIds: ['row1'], changedColumns: ['A'], actor: { id: 'u1', name: 'Una' } }))
    withLiveOrigin('bad origin!', () => emitTableChange('default', 'tbl_x', { op: 'delete', rowIds: ['row1'], changedColumns: [], actor: null }))
    off()
    expect(got).toEqual([['default', 'tbl_x', 'conn_abcdefgh'], ['default', 'tbl_x', undefined]])
    expect(lastWriterOf('default', 'tbl_x', 'row1')).toEqual({ id: 'u1', name: 'Una' })
    expect(lastWriterOf('other', 'tbl_x', 'row1')).toBeNull()
  })
})

describe('outbox bridge', () => {
  it('emits committed outbox rows in order with the outbox id as seq, the writer name and the live origin', async () => {
    let feed: ((e: never) => void) | null = null
    const outbox = { subscribe: (fn: (e: never) => void) => ((feed = fn), () => { feed = null }) }
    const got: { t: string; seq?: number; origin?: string; by?: string; op: string; rows: string[] }[] = []
    const off = onTableChange((_env, t, c) => got.push({ t, seq: c.seq, origin: c.origin, by: c.actor?.name, op: c.op, rows: c.rowIds }))
    const stop = bridgeOutbox(outbox, async (id) => (id === 'u9' ? 'Nia' : undefined))
    withLiveOrigin('conn_live1234', () => noteLocalWrite('default', 'tbl_o', 'update', ['r1'], { id: 'u8', name: 'Omar' }, 'req-1'))
    const ev = (o: Record<string, unknown>) => feed!({ environmentId: 'default', tableId: 'tbl_o', rowId: null, rowIds: null, changed: ['A'], requestId: null, ...o } as never)
    ev({ id: 41, op: 'update', rowId: 'r1', actorId: 'u8', requestId: 'req-1' })
    ev({ id: 42, op: 'bulk', rowIds: ['r2', 'r3'], actorId: 'u9' })
    ev({ id: 43, op: 'insert', rowId: 'r4', actorId: null })
    await new Promise((r) => setTimeout(r, 10))
    stop()
    off()
    expect(got).toEqual([
      { t: 'tbl_o', seq: 41, origin: 'conn_live1234', by: 'Omar', op: 'update', rows: ['r1'] },
      { t: 'tbl_o', seq: 42, origin: undefined, by: 'Nia', op: 'delete', rows: ['r2', 'r3'] },
      { t: 'tbl_o', seq: 43, origin: undefined, by: undefined, op: 'insert', rows: ['r4'] },
    ])
  })
})

describe('protocol helpers', () => {
  it('topics', () => {
    expect(parseTopic('table:tbl_1')).toEqual({ kind: 'table', table: 'tbl_1' })
    expect(parseTopic('user:user_1')).toEqual({ kind: 'user', user: 'user_1' })
    expect(parseTopic('app:app_1')).toEqual({ kind: 'app', app: 'app_1' })
    expect(parseTopic('env')).toEqual({ kind: 'env' })
    expect(parseTopic('presence:app:app_1')).toEqual({ kind: 'presence', scope: 'app:app_1' })
    expect(parseTopic('presence:record:tbl_1:0190-abc')).toEqual({ kind: 'presence', scope: 'record:tbl_1:0190-abc' })
    expect(parseTopic('presence:online')).toEqual({ kind: 'presence', scope: 'online' })
    for (const bad of ['', 'table', 'table:', 'table:a:b', 'x:y', 'presence:studio', 'presence:record:t', 'user:a b', 42, null, 'table:' + 'x'.repeat(300)]) {
      expect(parseTopic(bad), String(bad)).toBeNull()
    }
    expect(parsePresenceScope('studio:app_1')).toEqual({ kind: 'studio', app: 'app_1' })
    expect(parsePresenceScope('studio:app_1:x')).toBeNull()
  })
  it('notification settings are sanitised; do-not-disturb wraps midnight', () => {
    expect(parseNotificationSettings({ kinds: { app: false, 'Bad Kind': true, flow: 'yes' }, desktop: 1, dnd: { start: '25:00', end: '07:00' }, hidePresence: true, extra: 1 }))
      .toEqual({ kinds: { app: false }, desktop: false, dnd: null, hidePresence: true })
    const s = parseNotificationSettings({ dnd: { start: '22:00', end: '07:00' } })
    expect(inDoNotDisturb(s, new Date(2026, 0, 1, 23, 0))).toBe(true)
    expect(inDoNotDisturb(s, new Date(2026, 0, 1, 6, 59))).toBe(true)
    expect(inDoNotDisturb(s, new Date(2026, 0, 1, 7, 0))).toBe(false)
    expect(inDoNotDisturb(s, new Date(2026, 0, 1, 12, 0))).toBe(false)
    const day = parseNotificationSettings({ dnd: { start: '12:00', end: '13:00' } })
    expect(inDoNotDisturb(day, new Date(2026, 0, 1, 12, 30))).toBe(true)
    expect(inDoNotDisturb(day, new Date(2026, 0, 1, 13, 30))).toBe(false)
  })
})
