/**
 * Core data model in demo mode (P0 package N): the system tables in the browser workspace and the same rules as the
 * server where feasible, so the hosted demo and the tests behave alike. The row security itself is shared code
 * (src/platform/system-tables.ts through orgsec.ts rowPredicateFor); this module adds the write rules and the
 * collaboration API.
 *
 * In demo mode: Users, Departments, Teams, Team members, Roles, Role assignments (projections of the workspace),
 * Activities, Comments, Mentions, Follows, Tags, Tag links, and the reference tables (Currencies, Units of measure,
 * Countries, States, Calendars, Holidays, Number sequences, Settings).
 * Server only: Shares, Notifications, Documents, Document versions, Attachment links, Channels, Channel members,
 * Messages, Message reactions, Audit entries, Sign-in log, Job runs, Event runs, Flow runs; notifications of mentions
 * and follows; the orphan sweep.
 */
import type { FxRecord, FxValue } from '../contracts.ts'
import type { DepartmentDef, RoleDef, TableDef, TeamDef, UserDef } from './contracts.ts'
import { PlatformError } from './contracts.ts'
import type { CollabApi, MentionItem, PersonOption, TaskItem, TimelineItem } from './collab-api.ts'
import {
  DEFAULT_SETTINGS, INDIA_STATES, REGARDING, SYS, SYSTEM_TABLE_BY_ID, UNITS, financialYearOf, formatSequenceNumber, fyStartMonth,
  mentionedUserIds, richTextToPlain, sanitizeRichText, seedId, sequencePeriod, systemTableDef,
} from './system-tables.ts'
import { COUNTRIES, CURRENCIES } from './system-reference-data.ts'

void financialYearOf

/** the system tables demo mode has */
export const DEMO_SYSTEM_TABLES = [
  SYS.users, SYS.departments, SYS.teams, SYS.teamMembers, SYS.roles, SYS.roleAssignments,
  SYS.activities, SYS.comments, SYS.mentions, SYS.follows, SYS.tags, SYS.tagLinks,
  SYS.currencies, SYS.units, SYS.countries, SYS.states, SYS.calendars, SYS.holidays, SYS.sequences, SYS.settings,
] as const

type Row = FxRecord
type Op = 'read' | 'update' | 'delete' | 'create'

export interface DemoCollabDeps {
  /** every table definition (unstripped) */
  tables(): TableDef[]
  /** raw rows of a table */
  rows(tableId: string): Row[]
  /** may this user do op on the row (the shared predicate, evaluated in memory) */
  can(userId: string, table: TableDef, op: Op, row: Row): boolean
  currentUserId(): string
  users(): UserDef[]
  departments(): DepartmentDef[]
  teams(): TeamDef[]
  roles(): RoleDef[]
  /** platform.tables writes by table name (secure: as the run-as user; false: as the platform) */
  insert(table: string, values: FxRecord, secure: boolean): Row
  update(table: string, id: string, changes: FxRecord, secure: boolean): Row
  remove(table: string, ids: string[], secure: boolean): void
  now(): Date
}

const fail = (code: PlatformError['code'], message: string): never => {
  throw new PlatformError(code, message)
}
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : str(v))

/** the seeded rows of a demo system table (stable ids: the same as on the server) */
export function demoSeedRows(id: string, now: Date): Row[] {
  const row = (key: string, values: FxRecord): Row => ({ id: seedId(key), __id: seedId(key), createdOn: now, modifiedOn: now, createdBy: null, owner: null, ...values })
  switch (id) {
    case SYS.currencies: return CURRENCIES.map(([c, n, s, d]) => row(`currency:${c}`, { Code: c, Name: n, Symbol: s, DecimalPlaces: d, ExchangeRate: c === 'INR' ? 1 : null, IsDefault: c === 'INR', IsActive: true }))
    case SYS.units: return UNITS.map(([c, n, dim, f, base]) => row(`unit:${c}`, { Code: c, Name: n, Dimension: dim, Factor: f, IsBase: base }))
    case SYS.countries: return COUNTRIES.map(([c, n]) => row(`country:${c}`, { Code: c, Name: n }))
    case SYS.states: return INDIA_STATES.map(([code, n, kind, active]) => row(`state:IN:${code}`, { Country: seedId('country:IN'), CountryCode: 'IN', Code: code, Name: n, Kind: kind, GstStateCode: code, IsActive: active }))
    case SYS.calendars: return [row('calendar:standard', { Name: 'Standard', TimeZone: 'Asia/Kolkata', WorkingDays: 'Mon,Tue,Wed,Thu,Fri,Sat', WorkStart: '09:30', WorkEnd: '18:00', IsDefault: true, Description: 'Monday to Saturday. Add holidays in Holidays.' })]
    case SYS.settings: return DEFAULT_SETTINGS.map(([k, v, d]) => row(`setting:${k}`, { Key: k, Value: v, Description: d }))
    default: return []
  }
}

/** rows of the people projections from the workspace (users, organisation, roles) */
export function demoPeopleRows(id: string, d: Pick<DemoCollabDeps, 'users' | 'departments' | 'teams' | 'roles'>, now: Date): Row[] | null {
  const base = (rid: string, owner: string | null): Row => ({ id: rid, __id: rid, createdOn: now, modifiedOn: now, createdBy: null, owner })
  switch (id) {
    case SYS.users: return d.users().map((u) => ({ ...base(u.id, u.id), FullName: u.name, Email: u.email, Department: u.departmentId ?? null, Manager: u.managerId ?? null, JobTitle: u.jobTitle ?? null, Phone: u.phone ?? null, EmployeeCode: u.employeeCode ?? null, Status: u.status ?? 'active' }))
    case SYS.departments: return d.departments().map((x) => ({ ...base(x.id, null), Code: x.code, Name: x.name, Parent: x.parentId ?? null, Description: x.description ?? null }))
    case SYS.teams: return d.teams().map((t) => ({ ...base(t.id, null), Code: t.code, Name: t.name, Description: t.description ?? null }))
    case SYS.teamMembers: return d.teams().flatMap((t) => t.memberIds.map((m) => ({ ...base(`${t.id}:${m}`, m), Team: t.id, User: m })))
    case SYS.roles: return d.roles().map((r) => ({ ...base(r.id, null), Name: r.name, Description: r.description ?? null, IsAdmin: !!r.isAdmin, IsMaker: !!r.isMaker }))
    case SYS.roleAssignments: return d.users().flatMap((u) => u.roleIds.map((r) => ({ ...base(`${u.id}:${r}`, u.id), User: u.id, Role: r })))
    default: return null
  }
}

/** the TableDef of a demo system table (custom columns of a stored definition kept); undefined for server-only ones */
export function demoSystemDef(id: string, now: string, existing: TableDef | null, name?: string): TableDef | undefined {
  const spec = SYSTEM_TABLE_BY_ID.get(id)
  if (!spec) return undefined
  const def = systemTableDef(spec, now, existing, name ?? spec.name)
  delete def.source
  delete def.connectionId
  delete def.managed
  return def
}

export function createDemoCollab(d: DemoCollabDeps) {
  const tableById = (id: string) => d.tables().find((t) => t.id === id)
  const nameOf = (id: string) => tableById(id)?.name ?? fail('unavailable', 'This needs the system tables of the core data model.')
  const me = () => d.currentUserId()

  /** the table holding a row id (row ids are unique across tables) */
  function tableOfRow(rowId: string, tableHint?: string): { table: TableDef; row: Row } | null {
    const lower = rowId.toLowerCase()
    for (const t of d.tables()) {
      if (tableHint && t.id !== tableHint && t.name !== tableHint) continue
      if (t.system && t.id !== SYS.activities) continue
      const row = d.rows(t.id).find((r) => str(r.id).toLowerCase() === lower)
      if (row) return { table: t, row }
    }
    return null
  }

  function readable(userId: string, rowId: string, tableHint?: string): { table: TableDef; row: Row } | null {
    const hit = tableOfRow(rowId, tableHint)
    return hit && d.can(userId, hit.table, 'read', hit.row) ? hit : null
  }

  /** server parity: an unreadable record answers exactly like a missing one */
  function regardingOf(values: FxRecord, required: boolean): FxRecord {
    const id = str(values[REGARDING.id]).trim()
    if (!id) {
      if (required) fail('invalid', 'Say which record this is about (regardingId).')
      return { [REGARDING.table]: null, [REGARDING.id]: null }
    }
    const hit = readable(me(), id, str(values[REGARDING.table]) || undefined)
    if (!hit) fail('invalid', `There is no record with the id "${id.slice(0, 64)}" that you can see.`)
    return { [REGARDING.table]: hit!.table.id, [REGARDING.id]: str(hit!.row.id) }
  }

  const hooks = {
    /** system tables: normalise and check a new row's values (before the platform's own checks) */
    beforeInsert(def: TableDef, values: FxRecord): FxRecord {
      if (!def.system) return values
      const out: FxRecord = { ...values }
      if (def.regarding) Object.assign(out, regardingOf(values, def.id !== SYS.activities))
      if (def.id === SYS.comments) {
        const body = sanitizeRichText(str(values.Body))
        if (!richTextToPlain(body).trim() && !/data-mention=/.test(body)) fail('invalid', 'A comment cannot be empty.')
        out.Body = body
        const ids = mentionedUserIds(body)
        const refused = ids.filter((u) => !readable(u, str(out[REGARDING.id])))
        if (refused.length) fail('invalid', `${refused.map((u) => d.users().find((x) => x.id === u)?.name ?? u).join(', ')} cannot see this record, so they cannot be mentioned here.`)
        out.MentionIds = ids.length ? JSON.stringify(ids) : null
      }
      if (def.id === SYS.activities) {
        if (!str(values.Type)) out.Type = 'Task'
        if (!str(values.Status)) out.Status = 'Open'
        if (values.Description) out.Description = sanitizeRichText(str(values.Description))
        if (str(out.Status) === 'Done') {
          out.CompletedOn = d.now()
          out.CompletedBy = me()
        }
      }
      if (def.id === SYS.tags) out.Name = str(values.Name).trim().slice(0, 100)
      return out
    },
    beforeUpdate(def: TableDef, existing: Row, changes: FxRecord): FxRecord {
      if (!def.system) return changes
      const out: FxRecord = { ...changes }
      if (def.regarding && (REGARDING.id in changes || REGARDING.table in changes)) {
        if (str(changes[REGARDING.id] ?? existing[REGARDING.id]).toLowerCase() !== str(existing[REGARDING.id]).toLowerCase()) fail('invalid', 'The record a row is about cannot be changed; add a new one instead.')
      }
      if (def.id === SYS.comments && 'Body' in changes) {
        if (str(existing.createdBy) !== me()) fail('denied', 'Only the author can change a comment.')
        out.Body = sanitizeRichText(str(changes.Body))
        out.EditedOn = d.now()
        out.MentionIds = JSON.stringify(mentionedUserIds(str(out.Body)))
      }
      if (def.id === SYS.mentions) {
        if (Object.keys(changes).some((k) => k !== 'IsRead' && k !== 'ReadOn')) fail('denied', 'Only "Read" can be changed on a mention.')
        out.ReadOn = changes.IsRead === true ? d.now() : null
      }
      if (def.id === SYS.activities && 'Status' in changes) {
        const done = str(changes.Status) === 'Done'
        const was = str(existing.Status) === 'Done'
        if (done && !was) Object.assign(out, { CompletedOn: d.now(), CompletedBy: me() })
        if (!done && was) Object.assign(out, { CompletedOn: null, CompletedBy: null })
      }
      return out
    },
    afterInsert(def: TableDef, row: Row): void {
      if (def.id !== SYS.comments) return
      for (const u of mentionList(row.MentionIds)) {
        d.insert(nameOf(SYS.mentions), { MentionedUser: u, Comment: str(row.id), [REGARDING.table]: row[REGARDING.table], [REGARDING.id]: row[REGARDING.id], IsRead: false, owner: u }, false)
      }
    },
    /** polymorphic integrity (server parity): rows about deleted records go */
    afterDelete(def: TableDef, ids: string[]): void {
      if (!ids.length) return
      const gone = new Set(ids.map((x) => x.toLowerCase()))
      for (const t of [SYS.activities, SYS.comments, SYS.mentions, SYS.follows, SYS.tagLinks]) {
        const td = tableById(t)
        if (!td) continue
        const victims = d.rows(t).filter((r) => (str(r[REGARDING.table]) === def.id && gone.has(str(r[REGARDING.id]).toLowerCase())) || (t === SYS.mentions && def.id === SYS.comments && gone.has(str(r.Comment).toLowerCase())))
        if (victims.length) d.remove(td.name, victims.map((r) => str(r.id)), false)
      }
    },
  }

  function mentionList(v: unknown): string[] {
    try {
      const a = JSON.parse(str(v) || '[]')
      return Array.isArray(a) ? a.map(String) : []
    } catch {
      return []
    }
  }

  const userName = (id: string | null) => (id ? d.users().find((u) => u.id === id)?.name ?? null : null)
  const visibleRows = (id: string): Row[] => {
    const t = tableById(id)
    return t ? d.rows(id).filter((r) => d.can(me(), t, 'read', r)) : []
  }
  function labels<T extends { regardingTable?: string | null; regardingId?: string | null }>(list: T[]): (T & { regardingLabel?: string; regardingTableName?: string })[] {
    return list.map((x) => {
      const hit = x.regardingId ? readable(me(), x.regardingId) : null
      return hit ? { ...x, regardingLabel: str(hit.row[hit.table.primaryColumn]), regardingTableName: hit.table.displayName } : x
    })
  }

  /** NextNumber in demo mode: the same formatting and reset rules as the server (one browser: no concurrency) */
  function nextNumber(name: string): string {
    const seq = d.rows(SYS.sequences).find((r) => str(r.Name).toLowerCase() === name.trim().toLowerCase())
    if (!seq) return fail('invalid', `There is no number sequence "${name.slice(0, 80)}". Add it in Number sequences.`)
    const fy = fyStartMonth(d.rows(SYS.settings).find((r) => str(r.Key) === 'FinancialYearStartMonth')?.Value)
    const now = d.now()
    const rule = str(seq.ResetRule) || 'never'
    const period = sequencePeriod(rule, now, fy)
    const current = Math.max(1, Math.trunc(Number(seq.NextValue ?? 1)) || 1)
    const value = rule !== 'never' && str(seq.CurrentPeriod) !== period ? 1 : current
    d.update(nameOf(SYS.sequences), str(seq.id), { NextValue: value + 1, CurrentPeriod: period || null }, false)
    return formatSequenceNumber({ Prefix: str(seq.Prefix), Suffix: str(seq.Suffix), Padding: seq.Padding === null || seq.Padding === undefined ? 4 : Number(seq.Padding) }, value, now, fy)
  }

  const api: CollabApi = {
    async timeline(rowId, o = {}) {
      const hit = readable(me(), rowId, o.table)
      if (!hit) fail('not-found', 'Record not found.')
      const id = str(hit!.row.id).toLowerCase()
      const about = (t: string) => d.rows(t).filter((r) => str(r[REGARDING.id]).toLowerCase() === id)
      const items: TimelineItem[] = [
        ...about(SYS.comments).map((r) => ({ kind: 'comment' as const, id: str(r.id), at: iso(r.createdOn), by: str(r.createdBy) || null, byName: userName(str(r.createdBy)), data: { Body: r.Body, ParentComment: r.ParentComment, EditedOn: r.EditedOn ? iso(r.EditedOn) : null, MentionIds: mentionList(r.MentionIds), canEdit: str(r.createdBy) === me() } })),
        ...about(SYS.activities).map((r) => ({ kind: 'activity' as const, id: str(r.id), at: iso(r.createdOn), by: str(r.createdBy) || null, byName: userName(str(r.createdBy)), assignedName: userName(str(r.AssignedTo) || null), data: { Type: r.Type, Subject: r.Subject, Status: r.Status, Priority: r.Priority, DueOn: r.DueOn ? iso(r.DueOn) : null, AssignedTo: r.AssignedTo, CompletedOn: r.CompletedOn ? iso(r.CompletedOn) : null, Description: r.Description } })),
        { kind: 'event', id: `created:${id}`, at: iso(hit!.row.createdOn), by: str(hit!.row.createdBy) || null, byName: userName(str(hit!.row.createdBy)), data: { action: 'created', columns: [] } },
      ]
      items.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
      const limit = o.limit ?? 30
      const start = o.cursor ? Number(o.cursor) || 0 : 0
      const page = items.slice(start, start + limit)
      const follows = about(SYS.follows)
      const tagIds = new Set(about(SYS.tagLinks).map((r) => str(r.Tag)))
      return {
        table: hit!.table.id, row: id, title: str(hit!.row[hit!.table.primaryColumn]), items: page,
        nextCursor: start + limit < items.length ? String(start + limit) : null,
        following: follows.some((r) => str(r.owner) === me()), followers: follows.length,
        tags: d.rows(SYS.tags).filter((t) => tagIds.has(str(t.id))).map((t) => ({ id: str(t.id), name: str(t.Name), color: (t.Color as string | null) ?? null })),
        canComment: true,
      }
    },
    async addComment(i) {
      return str(d.insert(nameOf(SYS.comments), { Body: i.body, regardingId: i.rowId, ...(i.table ? { regardingTable: i.table } : {}), ...(i.parent ? { ParentComment: i.parent } : {}), ...(i.link ? { Link: i.link } : {}) }, true).id)
    },
    async editComment(id, body) { d.update(nameOf(SYS.comments), id, { Body: body }, true) },
    async deleteComment(id) { d.remove(nameOf(SYS.comments), [id], true) },
    async addActivity(i) {
      return str(d.insert(nameOf(SYS.activities), {
        Subject: i.subject, Type: i.type ?? 'Task', ...(i.description ? { Description: i.description } : {}), ...(i.dueOn ? { DueOn: new Date(i.dueOn) } : {}),
        ...(i.assignedTo ? { AssignedTo: i.assignedTo } : {}), ...(i.priority ? { Priority: i.priority } : {}), ...(i.rowId ? { regardingId: i.rowId } : {}),
      }, true).id)
    },
    async updateActivity(id, changes) { d.update(nameOf(SYS.activities), id, changes as FxRecord, true) },
    async deleteActivity(id) { d.remove(nameOf(SYS.activities), [id], true) },
    async follow(rowId, on, table) {
      const mine = d.rows(SYS.follows).filter((r) => str(r[REGARDING.id]).toLowerCase() === rowId.toLowerCase() && str(r.owner) === me())
      if (!on) {
        if (mine.length) d.remove(nameOf(SYS.follows), mine.map((r) => str(r.id)), true)
        return
      }
      if (!mine.length) d.insert(nameOf(SYS.follows), { regardingId: rowId, ...(table ? { regardingTable: table } : {}) }, true)
    },
    async tag(rowId, tag, on, table) {
      const name = tag.trim()
      let t = d.rows(SYS.tags).find((r) => str(r.Name).toLowerCase() === name.toLowerCase())
      const linked = t ? d.rows(SYS.tagLinks).filter((r) => str(r.Tag) === str(t!.id) && str(r[REGARDING.id]).toLowerCase() === rowId.toLowerCase()) : []
      if (!on) {
        if (linked.length) d.remove(nameOf(SYS.tagLinks), linked.map((r) => str(r.id)), true)
        return
      }
      if (!t) t = d.insert(nameOf(SYS.tags), { Name: name }, true)
      if (!linked.length) d.insert(nameOf(SYS.tagLinks), { Tag: str(t.id), regardingId: rowId, ...(table ? { regardingTable: table } : {}) }, true)
    },
    async attachFile() {
      fail('unavailable', 'Files about a record need the local server (demo mode keeps no document library).')
    },
    async mentionable(rowId, q, table) {
      if (!readable(me(), rowId, table)) fail('not-found', 'Record not found.')
      const needle = q.trim().toLowerCase()
      return d.users().filter((u) => u.status !== 'disabled' && (!needle || u.name.toLowerCase().includes(needle) || u.email.toLowerCase().startsWith(needle)) && !!readable(u.id, rowId, table))
        .slice(0, 20).map((u): PersonOption => ({ id: u.id, name: u.name, email: u.email }))
    },
    async people(q = '') {
      const needle = q.trim().toLowerCase()
      return d.users().filter((u) => u.status !== 'disabled' && (!needle || u.name.toLowerCase().includes(needle) || u.email.toLowerCase().startsWith(needle)))
        .slice(0, 50).map((u) => ({ id: u.id, name: u.name, email: u.email }))
    },
    async myTasks(o = {}) {
      const teams = d.teams().filter((t) => t.memberIds.includes(me())).map((t) => t.id)
      const list = visibleRows(SYS.activities).filter((r) => str(r.Type) === 'Task' && (str(r.AssignedTo) === me() || teams.includes(str(r.AssignedTeam)) || (!r.AssignedTo && !r.AssignedTeam && str(r.owner) === me()))
        && (o.all || ['Open', 'In progress'].includes(str(r.Status))))
      list.sort((a, b) => (a.DueOn ? (a.DueOn as Date).getTime() : Infinity) - (b.DueOn ? (b.DueOn as Date).getTime() : Infinity))
      return labels(list.map((r): TaskItem => ({
        id: str(r.id), Subject: str(r.Subject), Type: str(r.Type), Status: str(r.Status), Priority: (r.Priority as string) ?? null, DueOn: r.DueOn ? iso(r.DueOn) : null,
        AssignedTo: (r.AssignedTo as string) ?? null, AssignedTeam: (r.AssignedTeam as string) ?? null, regardingTable: (r.regardingTable as string) ?? null, regardingId: (r.regardingId as string) ?? null,
        createdOn: iso(r.createdOn), createdBy: (r.createdBy as string) ?? null,
      })))
    },
    async mentions() {
      const list = visibleRows(SYS.mentions).filter((r) => str(r.MentionedUser) === me()).sort((a, b) => iso(b.createdOn).localeCompare(iso(a.createdOn)))
      const comments = new Map(d.rows(SYS.comments).map((c) => [str(c.id), c]))
      return labels(list.map((r): MentionItem => {
        const c = comments.get(str(r.Comment))
        return { id: str(r.id), Comment: (r.Comment as string) ?? null, IsRead: r.IsRead === true, createdOn: iso(r.createdOn), regardingTable: (r.regardingTable as string) ?? null, regardingId: (r.regardingId as string) ?? null, Body: (c?.Body as string) ?? null, Link: (c?.Link as string) ?? null, byName: userName(str(c?.createdBy) || null) }
      }))
    },
    async markMentionRead(id) { d.update(nameOf(SYS.mentions), id, { IsRead: true }, true) },
    async nextNumber(name) { return nextNumber(name) },
    nextNumberNow: (name) => nextNumber(name),
    topics: () => [],
  }

  return { hooks, api, nextNumber }
}

export type DemoCollab = ReturnType<typeof createDemoCollab>
export type { FxValue }
