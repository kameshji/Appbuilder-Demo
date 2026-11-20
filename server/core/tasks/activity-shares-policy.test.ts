/**
 * Unit tests of the Activities read rule and the ActivityShares policy (P3 package T, spec 5.10), as different people: the
 * owner, the assignee, a person the note is shared with (read and edit), a member of a team it is shared with, a bystander
 * and an administrator. The predicates are evaluated against rows in memory (evaluateWithSemi answers the semi-joins from
 * the same rows), so this checks what the SQL means, not its text. Pattern of server/core/chat/chat-policy.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, SemiJoin } from '../../../src/platform/http.ts'
import { SYS, SYSTEM_TABLES, systemCanCreate, systemPredicate, systemTableDef } from '../../../src/platform/system-tables.ts'
import type { SystemOp, SystemPredicateEnv } from '../../../src/platform/system-tables.ts'
import { evaluateWithSemi } from '../condition.ts'

const now = '2026-11-20T00:00:00.000Z'
const tables: TableDef[] = SYSTEM_TABLES.map((s) => systemTableDef(s, now))
const T = (id: string) => tables.find((t) => t.id === id)!

const U = { ann: 'u-ann', bob: 'u-bob', cy: 'u-cy', di: 'u-di', eve: 'u-eve', admin: 'u-admin' }
const TEAM = 't-ops'
const TEAMS: Record<string, string[]> = { [U.di]: [TEAM] }

const rows: Record<string, Record<string, unknown>[]> = {
  [SYS.activities]: [
    { id: 'a-note', Type: 'Note', owner: U.ann, createdBy: U.ann, regardingId: null },
    { id: 'a-edit', Type: 'Note', owner: U.ann, createdBy: U.ann, regardingId: null },
    { id: 'a-task', Type: 'Task', owner: U.ann, createdBy: U.ann, AssignedTo: U.bob, regardingId: null },
    { id: 'a-private', Type: 'Note', owner: U.ann, createdBy: U.ann, regardingId: null },
    { id: 'a-team', Type: 'Task', owner: U.ann, createdBy: U.ann, regardingId: null },
    { id: 'a-bobs', Type: 'Note', owner: U.bob, createdBy: U.bob, regardingId: null },
  ],
  [SYS.activityShares]: [
    { id: 's1', Activity: 'a-note', PrincipalType: 'user', Principal: U.cy, Access: 'read', owner: U.ann },
    { id: 's2', Activity: 'a-edit', PrincipalType: 'user', Principal: U.cy, Access: 'edit', owner: U.ann },
    { id: 's3', Activity: 'a-team', PrincipalType: 'team', Principal: TEAM, Access: 'edit', owner: U.ann },
    { id: 's4', Activity: 'a-task', PrincipalType: 'user', Principal: U.cy, Access: 'read', owner: U.ann },
  ],
  [SYS.comments]: [
    { id: 'c-note', regardingTable: SYS.activities, regardingId: 'a-note' },
    { id: 'c-private', regardingTable: SYS.activities, regardingId: 'a-private' },
  ],
}

function env(user: string, isAdmin = false): SystemPredicateEnv {
  return { user: { id: user }, teams: TEAMS[user] ?? [], tables, sameStore: () => true, readOf: () => ({ const: false }), isAdmin }
}

async function matches(c: Condition, row: Record<string, unknown>): Promise<boolean> {
  return evaluateWithSemi(c, row as never, async (sj: SemiJoin, value: unknown) => {
    for (const r of rows[sj.table.id] ?? []) if (String(r[sj.key]) === String(value) && (await matches(sj.where, r))) return true
    return false
  })
}

/** ids of the rows of a table this user may touch with op */
async function visible(tableId: string, user: string, op: SystemOp = 'read', isAdmin = false): Promise<string[]> {
  const pred = systemPredicate(T(tableId), op, env(user, isAdmin))
  const out: string[] = []
  for (const r of rows[tableId] ?? []) if (await matches(pred, r)) out.push(String(r.id))
  return out.sort()
}

describe('Activities read rule with shares', () => {
  it('owner: everything personal of theirs; nothing of other people\'s', async () => {
    expect(await visible(SYS.activities, U.ann)).toEqual(['a-edit', 'a-note', 'a-private', 'a-task', 'a-team'])
    expect(await visible(SYS.activities, U.bob)).toEqual(['a-bobs', 'a-task'])
  })

  it('a person it is shared with reads it (and an assignee still reads their task)', async () => {
    expect(await visible(SYS.activities, U.cy)).toEqual(['a-edit', 'a-note', 'a-task'])
    expect(await visible(SYS.activities, U.cy)).not.toContain('a-private')
  })

  it('a member of a team it is shared with reads it; a bystander reads none', async () => {
    expect(await visible(SYS.activities, U.di)).toEqual(['a-team'])
    expect(await visible(SYS.activities, U.eve)).toEqual([])
  })

  it('removed from the team: the share stops applying at once (the predicate takes the CURRENT teams)', async () => {
    const gone = systemPredicate(T(SYS.activities), 'read', { ...env(U.di), teams: [] })
    for (const r of rows[SYS.activities]) expect(await matches(gone, r)).toBe(false)
  })

  it('an administrator reads everything (as for every collaboration table)', async () => {
    expect((await visible(SYS.activities, U.admin, 'read', true)).length).toBe(rows[SYS.activities].length)
  })

  it('a read share does not allow a change; an edit share does; the owner always does; sharing never allows delete', async () => {
    expect(await visible(SYS.activities, U.cy, 'update')).toEqual(['a-edit'])
    expect(await visible(SYS.activities, U.di, 'update')).toEqual(['a-team'])
    expect(await visible(SYS.activities, U.ann, 'update')).toEqual(['a-edit', 'a-note', 'a-private', 'a-task', 'a-team'])
    expect(await visible(SYS.activities, U.cy, 'delete')).toEqual([])
    expect(await visible(SYS.activities, U.di, 'delete')).toEqual([])
    expect(await visible(SYS.activities, U.eve, 'update')).toEqual([])
  })

  it('comments on a shared note follow the note: readable by who it is shared with, not by a bystander', async () => {
    expect(await visible(SYS.comments, U.cy)).toEqual(['c-note'])
    expect(await visible(SYS.comments, U.ann)).toEqual(['c-note', 'c-private'])
    expect(await visible(SYS.comments, U.eve)).toEqual([])
  })
})

describe('ActivityShares table policy', () => {
  it('is a system table with the parent policy, the spec\'s columns and one share per person or team', () => {
    expect(T(SYS.activityShares).systemPolicy).toBe('parent')
    expect(T(SYS.activityShares).columns.map((c) => c.name)).toEqual(expect.arrayContaining(['Activity', 'PrincipalType', 'Principal', 'Access']))
    expect(T(SYS.activityShares).uniqueTogether).toEqual([['Activity', 'PrincipalType', 'Principal']])
    expect(SYSTEM_TABLES.find((s) => s.id === SYS.activityShares)?.kind).toBe('table')
  })

  it('the Activities columns of the spec exist', () => {
    const names = T(SYS.activities).columns.map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['Recurrence', 'RecurrenceParent', 'ReminderSentOn', 'Body', 'Files', 'ReminderOn']))
    expect(T(SYS.activities).columns.find((c) => c.name === 'Files')).toMatchObject({ type: 'file', multiple: true })
    expect(T(SYS.activities).columns.find((c) => c.name === 'RecurrenceParent')).toMatchObject({ type: 'lookup', lookupTable: 'Activities' })
  })

  it('whoever can read the activity sees its shares; others do not', async () => {
    expect(await visible(SYS.activityShares, U.ann)).toEqual(['s1', 's2', 's3', 's4'])
    expect(await visible(SYS.activityShares, U.cy)).toEqual(['s1', 's2', 's4'])
    expect(await visible(SYS.activityShares, U.bob)).toEqual(['s4'])
    expect(await visible(SYS.activityShares, U.di)).toEqual(['s3'])
    expect(await visible(SYS.activityShares, U.eve)).toEqual([])
  })

  it('only the activity\'s owner writes shares: not an assignee, not someone it is shared with (even with edit), not a bystander', async () => {
    for (const op of ['create', 'update', 'delete'] as SystemOp[]) {
      expect(await visible(SYS.activityShares, U.ann, op), op).toEqual(['s1', 's2', 's3', 's4'])
      expect(await visible(SYS.activityShares, U.bob, op), op).toEqual([])
      expect(await visible(SYS.activityShares, U.cy, op), op).toEqual([])
      expect(await visible(SYS.activityShares, U.di, op), op).toEqual([])
      expect(await visible(SYS.activityShares, U.eve, op), op).toEqual([])
    }
    // a new share row for an activity of Bob's: Bob may add it, Ann (owner of other activities) may not
    const mine = { id: 'new', Activity: 'a-bobs', PrincipalType: 'user', Principal: U.eve, Access: 'read' }
    expect(await matches(systemPredicate(T(SYS.activityShares), 'create', env(U.bob)), mine)).toBe(true)
    expect(await matches(systemPredicate(T(SYS.activityShares), 'create', env(U.ann)), mine)).toBe(false)
    expect(await matches(systemPredicate(T(SYS.activityShares), 'create', env(U.cy)), { ...mine, Activity: 'a-edit' })).toBe(false)
  })

  it('may be created through the data API by ordinary users (the row rule decides); share is never allowed on it', () => {
    expect(systemCanCreate(T(SYS.activityShares), false)).toBe(true)
    expect(systemPredicate(T(SYS.activityShares), 'share', env(U.ann))).toEqual({ const: false })
  })
})
