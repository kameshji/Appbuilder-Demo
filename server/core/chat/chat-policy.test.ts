/**
 * Unit tests of the chat policy (P3-A, docs/dev/chat.md "Security"): every chat table, every operation, as a member, a
 * non-member, an owner, an environment administrator and an install administrator, for open, private, archived, direct
 * and group conversations. The predicates are evaluated against rows in memory (evaluateWithSemi answers the semi-joins
 * from the same rows), so this checks what the SQL means, not its text. Also the message format helpers.
 */
import { describe, expect, it } from 'vitest'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, SemiJoin } from '../../../src/platform/http.ts'
import {
  SYS, SYSTEM_TABLES, systemCanCreate, systemPredicate, systemTableDef,
} from '../../../src/platform/system-tables.ts'
import type { SystemOp, SystemPredicateEnv } from '../../../src/platform/system-tables.ts'
import { evaluateWithSemi } from '../condition.ts'
import { buildUserContext } from '../security.ts'
import { checkEmoji, messageIdFor, parseBody, parseCards, searchQuery } from './format.ts'
import { checkChatSettingsChange, defaultChatSettings, parseChatSettings } from './settings.ts'

const now = '2026-11-20T00:00:00.000Z'
const tables: TableDef[] = SYSTEM_TABLES.map((s) => systemTableDef(s, now))
const T = (id: string) => tables.find((t) => t.id === id)!

const U = { ann: 'u-ann', bob: 'u-bob', cy: 'u-cy', admin: 'u-admin' }
const CH = { open: 'c-open', priv: 'c-priv', arch: 'c-arch', direct: 'c-direct', group: 'c-group' }

const rows: Record<string, Record<string, unknown>[]> = {
  [SYS.channels]: [
    { id: CH.open, Kind: 'channel', IsPrivate: false, ArchivedOn: null, owner: U.ann },
    { id: CH.priv, Kind: 'channel', IsPrivate: true, ArchivedOn: null, owner: U.ann },
    { id: CH.arch, Kind: 'channel', IsPrivate: false, ArchivedOn: new Date(), owner: U.ann },
    { id: CH.direct, Kind: 'direct', IsPrivate: true, ArchivedOn: null, owner: U.ann },
    { id: CH.group, Kind: 'group', IsPrivate: true, ArchivedOn: null, owner: U.cy },
  ],
  [SYS.channelMembers]: [
    { id: 'm1', Channel: CH.open, User: U.ann, MemberRole: 'owner' },
    { id: 'm2', Channel: CH.priv, User: U.ann, MemberRole: 'owner' },
    { id: 'm3', Channel: CH.priv, User: U.bob, MemberRole: 'member' },
    { id: 'm4', Channel: CH.arch, User: U.ann, MemberRole: 'owner' },
    { id: 'm5', Channel: CH.direct, User: U.ann, MemberRole: 'member' },
    { id: 'm6', Channel: CH.direct, User: U.bob, MemberRole: 'member' },
    { id: 'm7', Channel: CH.group, User: U.cy, MemberRole: 'member' },
    { id: 'm8', Channel: CH.group, User: U.bob, MemberRole: 'member' },
  ],
  [SYS.messages]: Object.values(CH).map((c) => ({ id: `msg-${c}`, Channel: c, Body: 'x', createdBy: U.ann })),
  [SYS.messageReactions]: Object.values(CH).map((c) => ({ id: `r-${c}`, Message: `msg-${c}`, Emoji: '👍', owner: U.ann })),
  [SYS.mentions]: [
    { id: 'mn-priv', MentionedUser: U.bob, regardingTable: SYS.messages, regardingId: `msg-${CH.priv}`, Message: `msg-${CH.priv}` },
  ],
}

function env(user: string, isAdmin: boolean): SystemPredicateEnv {
  return { user: { id: user }, teams: [], tables, sameStore: () => true, readOf: () => ({ const: false }), isAdmin }
}

async function matches(c: Condition, row: Record<string, unknown>): Promise<boolean> {
  return evaluateWithSemi(c, row as never, async (sj: SemiJoin, value: unknown) => {
    for (const r of rows[sj.table.id] ?? []) if (String(r[sj.key]) === String(value) && (await matches(sj.where, r))) return true
    return false
  })
}

/** ids of the rows of a table this user may touch with op */
async function visible(tableId: string, user: string, isAdmin: boolean, op: SystemOp = 'read'): Promise<string[]> {
  const pred = systemPredicate(T(tableId), op, env(user, isAdmin))
  const out: string[] = []
  for (const r of rows[tableId] ?? []) if (await matches(pred, r)) out.push(String(r.id))
  return out.sort()
}

const CHAT = [SYS.channels, SYS.channelMembers, SYS.messages, SYS.messageReactions]

describe('chat policy (system tables)', () => {
  it('the four communication tables use the chat policy', () => {
    for (const id of CHAT) expect(T(id).systemPolicy).toBe('chat')
  })

  it('GAP 1+2: nobody creates, updates or deletes chat rows through the data API (administrators included)', async () => {
    for (const id of CHAT) {
      expect(systemCanCreate(T(id), false)).toBe(false)
      expect(systemCanCreate(T(id), true)).toBe(false)
      for (const op of ['create', 'update', 'delete', 'share'] as SystemOp[]) {
        for (const [user, admin] of [[U.ann, false], [U.admin, true]] as [string, boolean][]) {
          expect(systemPredicate(T(id), op, env(user, admin)), `${id} ${op} admin=${admin}`).toEqual({ const: false })
        }
      }
    }
  })

  it('GAP 3: administrators are not TRUE on chat tables; they read like everyone else (membership, open channels)', async () => {
    for (const id of CHAT) expect(systemPredicate(T(id), 'read', env(U.admin, true))).not.toEqual({ const: true })
    expect(await visible(SYS.channels, U.admin, true)).toEqual([CH.open])
    expect(await visible(SYS.messages, U.admin, true)).toEqual([`msg-${CH.open}`])
    expect(await visible(SYS.messageReactions, U.admin, true)).toEqual([`r-${CH.open}`])
    expect(await visible(SYS.channelMembers, U.admin, true)).toEqual(['m1'])
  })

  it('channels: members, plus open channels that are not archived', async () => {
    expect(await visible(SYS.channels, U.ann, false)).toEqual([CH.arch, CH.direct, CH.open, CH.priv].sort())
    expect(await visible(SYS.channels, U.bob, false)).toEqual([CH.direct, CH.group, CH.open, CH.priv].sort())
    expect(await visible(SYS.channels, U.cy, false)).toEqual([CH.group, CH.open].sort())
  })

  it('members, messages and reactions follow the channel; an archived open channel is members only', async () => {
    expect(await visible(SYS.channelMembers, U.cy, false)).toEqual(['m1', 'm7', 'm8'])
    expect(await visible(SYS.messages, U.cy, false)).toEqual([`msg-${CH.group}`, `msg-${CH.open}`].sort())
    expect(await visible(SYS.messageReactions, U.cy, false)).toEqual([`r-${CH.group}`, `r-${CH.open}`].sort())
    expect(await visible(SYS.messages, U.bob, false)).not.toContain(`msg-${CH.arch}`)
    expect(await visible(SYS.messages, U.ann, false)).toContain(`msg-${CH.arch}`)
  })

  it('chat mentions follow the message, for administrators too (no TRUE on Mentions about messages)', async () => {
    expect(await visible(SYS.mentions, U.bob, false)).toEqual(['mn-priv'])
    expect(await visible(SYS.mentions, U.cy, false)).toEqual([])
    expect(await visible(SYS.mentions, U.admin, true)).toEqual([])
    // rows about other things stay as they were for administrators
    rows[SYS.mentions].push({ id: 'mn-rec', MentionedUser: U.bob, regardingTable: 'tbl_x', regardingId: 'r1' })
    try {
      expect(await visible(SYS.mentions, U.admin, true)).toEqual(['mn-rec'])
    } finally {
      rows[SYS.mentions].pop()
    }
  })

  it('a reporting view over Messages reads with the chat rule (an administrator is not TRUE on it either)', () => {
    const view: TableDef = {
      id: 'tbl_view', name: 'MessageFacts', displayName: 'Message facts', primaryColumn: 'BodyText', createdOn: now, modifiedOn: now, connectionId: 'conn_default', source: 'v_messagefacts', readOnly: true,
      columns: [{ name: 'id', displayName: 'Id', type: 'text', system: true }, { name: 'BodyText', displayName: 'Text', type: 'multiline' }],
      reporting: { kind: 'view', role: 'fact', base: SYS.messages, baseSource: SYS.messages, columns: [{ name: 'BodyText', displayName: 'Text', type: 'multiline', source: 'BodyText' }] },
    } as TableDef
    const all = [...tables, view]
    const admin = { id: U.admin, name: 'Admin', email: 'a@example.com', roleIds: ['r_admin'], isInstallAdmin: true } as never
    const ctx = buildUserContext(admin, [{ id: 'r_admin', name: 'Administrator', isAdmin: true, privileges: [], apps: 'all' } as never], all, undefined, 'default')
    const p = ctx.rowPredicate(view, 'read')
    expect(p).not.toEqual({ const: true })
    expect(JSON.stringify(p)).toContain(SYS.channelMembers)
    expect(ctx.canCreate(T(SYS.messages))).toBe(false)
    expect(ctx.rowPredicate(T(SYS.messages), 'update')).toEqual({ const: false })
  })

  it('other system tables keep their rules (administrators still read Comments entirely)', () => {
    expect(systemPredicate(T(SYS.comments), 'read', env(U.admin, true))).toEqual({ const: true })
    expect(systemCanCreate(T(SYS.comments), false)).toBe(true)
  })
})

describe('chat message format', () => {
  it('sanitises the body, derives the text, extracts mentions (people and @channel)', () => {
    const p = parseBody('<p>Hi <span data-mention="u-bob">@Bob</span> and <span data-mention="channel">@channel</span><script>x()</script><img src=x onerror=alert(1)></p>')
    expect(p.body).not.toMatch(/script|img|onerror/)
    expect(p.text).toContain('Hi @Bob and @channel')
    expect(p.mentions).toEqual(['u-bob'])
    expect(p.mentionsChannel).toBe(true)
  })

  it('refuses text over 4,000 characters', () => {
    expect(() => parseBody('a'.repeat(4001))).toThrow(/too long/)
    expect(parseBody('a'.repeat(4000)).text.length).toBe(4000)
  })

  it('cards: at most 3 references of known kinds, at most 6 fields, never values', () => {
    expect(parseCards([{ kind: 'record', env: 'default', table: 't1', row: 'r1', fields: ['A', 'B', 'A'], values: { A: 1 } }])).toEqual([{ kind: 'record', env: 'default', table: 't1', row: 'r1', fields: ['A', 'B'] }])
    expect(() => parseCards([1, 2, 3, 4])).toThrow(/At most 3/)
    expect(() => parseCards([{ kind: 'record', env: 'default', table: 't', row: 'r', fields: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }])).toThrow(/6 fields/)
    expect(() => parseCards([{ kind: 'sql', env: 'default' }])).toThrow(/kind/)
    expect(() => parseCards([{ kind: 'app', env: 'Bad Env', app: 'a' }])).toThrow(/env/)
  })

  it('emoji: only the 12 offered', () => {
    expect(checkEmoji('👍')).toBe('👍')
    expect(() => checkEmoji('🦄')).toThrow()
  })

  it('search query: letters and digits only, prefix words ANDed; no tsquery syntax gets through', () => {
    expect(searchQuery('Pump  failure!')).toBe('pump:* & failure:*')
    expect(searchQuery("a & b | !c:* <-> 'd'")).toBe('a:* & b:* & c:* & d:*')
    expect(searchQuery('मशीन बंद')).toBe('मशीन:* & बंद:*')
    expect(searchQuery('  &&& ')).toBeNull()
  })

  it('a clientId gives the same message id for the same person and conversation only', () => {
    expect(messageIdFor('u1', 'c1', 'abc12345')).toBe(messageIdFor('u1', 'c1', 'abc12345'))
    expect(messageIdFor('u2', 'c1', 'abc12345')).not.toBe(messageIdFor('u1', 'c1', 'abc12345'))
    expect(messageIdFor('u1', 'c1', 'abc12345')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('chat settings', () => {
  it('defaults: Default environment, everyone creates channels, keep everything', () => {
    expect(parseChatSettings(null)).toEqual(defaultChatSettings())
    expect(defaultChatSettings()).toMatchObject({ environmentId: 'default', createChannels: 'everyone', retention: { channel: null, direct: null, group: null } })
  })
  it('retention below 30 days is refused (not clamped)', () => {
    expect(() => checkChatSettingsChange(defaultChatSettings(), { retention: { channel: 29 } })).toThrow(/at least 30/)
    expect(checkChatSettingsChange(defaultChatSettings(), { retention: { direct: 30 } }).retention).toEqual({ channel: null, direct: 30, group: null })
  })
})
