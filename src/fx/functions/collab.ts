/**
 * Core data model functions (P0 package N, docs/guide/maker/core-data-model.md).
 *
 * Table-returning and lookup functions are MACROS over the system tables, so they delegate like any Filter / LookUp:
 *   Comments(record)          SortByColumns(Filter(Comments, regardingId = RecordId(record)), "createdOn", SortOrder.Descending)
 *   Activities(record)        the same over Activities
 *   MyTasks()                 open tasks assigned to the signed-in user, by due date
 *   Mentions()                where the signed-in user was mentioned, newest first
 *   Setting(key)              LookUp(Settings, Key = key, Value)
 *   Convert(value, from, to)  value * factor(from) / factor(to) over Units of measure (blank across dimensions)
 * The query translator (src/fx/query/translate.ts) lowers the expansion (expandSystemCall), the engine evaluates the
 * same expansion when nothing is delegated (demo mode, small tables). Row ids are unique across tables (UUIDs), so a
 * record's comments are found by its id alone.
 *
 * Writes are behaviour functions that go through the host (the runtime calls the platform's collab API):
 *   AddComment(record, text), AddActivity(record, subject [, type [, dueOn [, assignedTo]]]), Follow(record),
 *   Unfollow(record), Tag(record, name), Untag(record, name), NextNumber(name).
 */
import type { FxRecord, FxValue } from '../../contracts.ts'
import type { CallNode, Node } from '../ast.ts'
import { parse } from '../parser.ts'
import { isRecord, toText } from '../values.ts'
import { def, type CallCtx, type FnDef } from './types.ts'

/** the names of the system tables in the current environment (a maker's older table may have taken a name) */
const names: Record<string, string> = { Comments: 'Comments', Activities: 'Activities', Mentions: 'Mentions', Settings: 'Settings', UnitsOfMeasure: 'UnitsOfMeasure', ApprovalRequests: 'ApprovalRequests', ApprovalAssignments: 'ApprovalAssignments' }
/** the runtime tells the engine when a system table carries another name (Sys<Name>) */
export function setSystemTableNames(map: Partial<Record<keyof typeof names, string>>): void {
  for (const [k, v] of Object.entries(map)) if (v && k in names) names[k] = v
}

const TEMPLATES: Record<string, { min: number; max: number; tables: (keyof typeof names)[]; formula: () => string }> = {
  Comments: { min: 1, max: 1, tables: ['Comments'], formula: () => `SortByColumns(Filter(${names.Comments}, regardingId = RecordId(__a0)), "createdOn", SortOrder.Descending)` },
  Activities: { min: 1, max: 1, tables: ['Activities'], formula: () => `SortByColumns(Filter(${names.Activities}, regardingId = RecordId(__a0)), "createdOn", SortOrder.Descending)` },
  MyTasks: { min: 0, max: 0, tables: ['Activities'], formula: () => `SortByColumns(Filter(${names.Activities}, Type = "Task" && AssignedTo = User().Id && Status <> "Done" && Status <> "Cancelled"), "DueOn", SortOrder.Ascending)` },
  Mentions: { min: 0, max: 0, tables: ['Mentions'], formula: () => `SortByColumns(Filter(${names.Mentions}, MentionedUser = User().Id), "createdOn", SortOrder.Descending)` },
  Setting: { min: 1, max: 1, tables: ['Settings'], formula: () => `LookUp(${names.Settings}, Key = __a0, Value)` },
  // P1-C approvals: the requests about a record (visible to the signed-in user), and what waits for the signed-in user
  Approvals: { min: 1, max: 1, tables: ['ApprovalRequests'], formula: () => `SortByColumns(Filter(${names.ApprovalRequests}, regardingId = RecordId(__a0)), "createdOn", SortOrder.Descending)` },
  MyApprovals: { min: 0, max: 0, tables: ['ApprovalAssignments'], formula: () => `SortByColumns(Filter(${names.ApprovalAssignments}, Approver = User().Id && Status = "pending" && RequestStatus = "pending"), "DueOn", SortOrder.Ascending)` },
  Convert: {
    min: 3, max: 3, tables: ['UnitsOfMeasure'],
    formula: () => `With({__f: LookUp(${names.UnitsOfMeasure}, Code = __a1), __t: LookUp(${names.UnitsOfMeasure}, Code = __a2)}, If(IsBlank(__a0) || IsBlank(__f) || IsBlank(__t) || __f.Dimension <> __t.Dimension || IsBlank(__t.Factor) || __t.Factor = 0, Blank(), __a0 * __f.Factor / __t.Factor))`,
  },
}

/** is this call one of the macros (by name and argument count)? */
export function isSystemMacro(n: Node): n is CallNode {
  if (n.t !== 'call') return false
  const t = TEMPLATES[n.name]
  return !!t && n.args.length >= t.min && n.args.length <= t.max
}

/** the system tables a macro call reads (for the runtime's "which tables does this formula read") */
export function systemMacroTables(n: CallNode): string[] {
  return (TEMPLATES[n.name]?.tables ?? []).map((k) => names[k])
}

const parsed = new Map<string, Node>()
function templateAst(formula: string): Node {
  let ast = parsed.get(formula)
  if (!ast) {
    const p = parse('=' + formula)
    if (!p.ast) throw new Error(`system macro does not parse: ${formula}`)
    ast = p.ast
    parsed.set(formula, ast)
  }
  return ast
}

/** copy of a template with `__aN` replaced by the call's argument nodes; every synthetic node spans the call */
function substitute(n: Node, args: Node[], span: { start: number; end: number }): Node {
  const s = { start: span.start, end: span.end }
  const sub = (x: Node): Node => substitute(x, args, span)
  switch (n.t) {
    case 'id': {
      const m = /^__a(\d)$/.exec(n.name)
      return m && args[Number(m[1])] ? args[Number(m[1])] : { ...n, ...s }
    }
    case 'num': case 'str': case 'bool': return { ...n, ...s }
    case 'member': return { ...n, ...s, obj: sub(n.obj), nameStart: span.start, nameEnd: span.end }
    case 'call': return { ...n, ...s, nameStart: span.start, nameEnd: span.end, args: n.args.map(sub) }
    case 'unary': case 'pct': return { ...n, ...s, arg: sub(n.arg) }
    case 'bin': return { ...n, ...s, left: sub(n.left), right: sub(n.right) }
    case 'chain': return { ...n, ...s, items: n.items.map(sub) }
    case 'rec': return { ...n, ...s, fields: n.fields.map((f) => ({ ...f, nameStart: span.start, nameEnd: span.end, value: sub(f.value) })) }
    case 'tab': return { ...n, ...s, items: n.items.map(sub) }
    case 'interp': return { ...n, ...s, parts: n.parts.map((p) => (typeof p === 'string' ? p : sub(p))) }
    case 'as': return { ...n, ...s, expr: sub(n.expr) }
  }
}

/** the expansion of a macro call (null when it is not one) */
export function expandSystemCall(n: Node): Node | null {
  if (!isSystemMacro(n)) return null
  return substitute(templateAst(TEMPLATES[n.name]!.formula()), n.args, n)
}

/** evaluate a macro without delegation: argument values bound as __a0.. in a scope that still sees tables and User() */
function runMacro(c: CallCtx): FxValue {
  const t = TEMPLATES[c.node.name]!
  const rec: FxRecord = {}
  for (let i = 0; i < c.argc; i++) rec[`__a${i}`] = c.value(i)
  return c.scoped(templateAst(t.formula()), rec)
}

/** the row id of a record (its hidden __id or id), or the text given */
export function recordIdOf(v: FxValue): string {
  if (v === null || v === undefined) return ''
  if (isRecord(v)) {
    const id = v.__id ?? v.id
    return typeof id === 'string' ? id : id === null || id === undefined ? '' : String(id)
  }
  return typeof v === 'string' ? v : ''
}

function hostCall(c: CallCtx, fname: string, action: Parameters<NonNullable<NonNullable<CallCtx['host']>['collab']>>[0], args: Record<string, FxValue>): FxValue {
  if (!c.host) return c.fail(null, `${fname} only works in behaviour properties such as OnSelect`, true)
  if (!c.host.collab) return c.fail(null, `${fname} works in apps (not here)`, true)
  return c.host.collab(action, args)
}

const recordArg = (c: CallCtx, i: number, fname: string): string => {
  const id = recordIdOf(c.value(i))
  if (!id) c.fail(i, `${fname} needs a record of a table (or its id)`)
  return id
}

export const collabFns: FnDef[] = [
  def('RecordId', 'RecordId(record)', 'The id of a record (row) of a table; with text, the text itself. Blank for blank.', 1, 1, (c) => recordIdOf(c.value(0)) || null),
  def('Comments', 'Comments(record)', 'The comments about a record (core data model), newest first. Delegates: Filter(Comments, regardingId = RecordId(record)).', 1, 1, runMacro),
  def('Activities', 'Activities(record)', 'The activities (tasks, calls, meetings, notes) about a record, newest first. Delegates like Filter.', 1, 1, runMacro),
  def('MyTasks', 'MyTasks()', 'Open tasks assigned to the signed-in user, by due date. Delegates like Filter.', 0, 0, runMacro),
  def('Mentions', 'Mentions()', 'Where the signed-in user was @mentioned, newest first. Delegates like Filter.', 0, 0, runMacro),
  def('Approvals', 'Approvals(record)', 'The approval requests about a record that you may see (Approval requests: Title, Status, Outcome, RequestedBy, DueOn ...), newest first. Delegates like Filter.', 1, 1, runMacro),
  def('MyApprovals', 'MyApprovals()', 'The approvals waiting for the signed-in user (Approval assignments: Request, Title, DueOn, regardingId ...), by due date. Delegates like Filter.', 0, 0, runMacro),
  def('RequestApproval', 'RequestApproval(policyOrApprovers, record, title [, details [, fields]])', 'Asks for an approval about a record (server mode) and returns the request id at once. policyOrApprovers: the name of an approval policy, or approvers ("asha@example.com; role:Finance", "manager", a table of people). details: text every approver sees; fields: a record such as {Amount: ThisItem.Amount} (shown to approvers, read by threshold rules). You are the requester.', 3, 5, (c) => {
    if (!c.host) return c.fail(null, 'RequestApproval only works in behaviour properties such as OnSelect', true)
    if (!c.host.requestApproval) return c.fail(null, 'Approvals run on the server: RequestApproval is not available here (demo mode).', true)
    const who = c.value(0)
    const approvers: string[] = []
    let policy: string | undefined
    const addPerson = (v: FxValue) => {
      if (isRecord(v)) {
        for (const k of ['Email', 'Id', 'id', 'Code']) { const x = v[k]; if (typeof x === 'string' && x.trim()) { approvers.push(x.trim()); return } }
      } else if (typeof v === 'string' && v.trim()) approvers.push(...v.split(/[;,\n]/).map((x) => x.trim()).filter(Boolean))
    }
    if (Array.isArray(who)) for (const r of who) addPerson(r as FxValue)
    else if (isRecord(who)) addPerson(who)
    else {
      const s = toText(who, c.argNode(0)).trim()
      if (!s) return c.fail(0, 'Name an approval policy or the approvers')
      if (/[@:;,]/.test(s) || /^(manager|department-head)$/i.test(s)) addPerson(s)
      else policy = s
    }
    const record = recordIdOf(c.value(1))
    const title = c.text(2).trim()
    if (!title) return c.fail(2, 'The title must not be empty')
    const f = c.argc > 4 ? c.value(4) : null
    if (f !== null && !isRecord(f)) return c.fail(4, 'fields must be a record, like {Amount: ThisItem.Amount}')
    const id = `appr_${Array.from({ length: 20 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')}`
    return c.host.requestApproval({ id, ...(policy ? { policy } : { approvers }), record, title, details: c.argc > 3 ? c.text(3) : '', fields: (f ?? {}) as FxRecord })
  }, 'behaviour'),
  def('Setting', 'Setting(key)', 'The value (text) of a setting of this environment from the Settings table, such as Setting("FinancialYearStartMonth"). Blank when missing.', 1, 1, runMacro),
  def('Convert', 'Convert(value, fromUnit, toUnit)', 'Converts a quantity between units of the same dimension using the factors in Units of measure, such as Convert(2.5, "KG", "G"). Blank when a unit is unknown or the dimensions differ.', 3, 3, runMacro),
  def('NextNumber', 'NextNumber(sequence)', 'The next number of a number sequence, formatted with its prefix and padding. Gap-free on the server in a column default (=NextNumber("Invoices")) or a before-event; in apps it works in demo mode only.', 1, 1, (c) => hostCall(c, 'NextNumber', 'nextNumber', { name: c.text(0) }), 'behaviour'),
  def('AddComment', 'AddComment(record, text)', 'Adds a comment about a record (people you @mention in the text with <span data-mention="userId"> are notified). Asynchronous.', 2, 2, (c) => {
    hostCall(c, 'AddComment', 'addComment', { record: recordArg(c, 0, 'AddComment'), text: c.text(1) })
    return true
  }, 'behaviour'),
  def('AddActivity', 'AddActivity(record, subject [, type [, dueOn [, assignedTo]]])', 'Adds an activity about a record: type Task (default), Call, Meeting, Email, Note or Custom; assignedTo a user id or a record of Users. Blank record: a personal task. Asynchronous.', 2, 5, (c) => {
    const rec = c.value(0)
    const assigned = c.argc > 4 ? c.value(4) : null
    hostCall(c, 'AddActivity', 'addActivity', {
      record: rec === null ? '' : recordArg(c, 0, 'AddActivity'), subject: c.text(1), type: c.argc > 2 ? c.text(2) || 'Task' : 'Task',
      dueOn: c.argc > 3 ? c.value(3) : null, assignedTo: assigned === null ? null : recordIdOf(assigned) || toText(assigned, c.argNode(4)),
    })
    return true
  }, 'behaviour'),
  def('Follow', 'Follow(record)', 'Follows a record: you are notified of new comments about it. Asynchronous.', 1, 1, (c) => {
    hostCall(c, 'Follow', 'follow', { record: recordArg(c, 0, 'Follow') })
    return true
  }, 'behaviour'),
  def('Unfollow', 'Unfollow(record)', 'Stops following a record. Asynchronous.', 1, 1, (c) => {
    hostCall(c, 'Unfollow', 'unfollow', { record: recordArg(c, 0, 'Unfollow') })
    return true
  }, 'behaviour'),
  def('Tag', 'Tag(record, name)', 'Puts a tag on a record (the tag is created when it is new). Asynchronous.', 2, 2, (c) => {
    hostCall(c, 'Tag', 'tag', { record: recordArg(c, 0, 'Tag'), tag: c.text(1) })
    return true
  }, 'behaviour'),
  def('Untag', 'Untag(record, name)', 'Takes a tag off a record. Asynchronous.', 2, 2, (c) => {
    hostCall(c, 'Untag', 'untag', { record: recordArg(c, 0, 'Untag'), tag: c.text(1) })
    return true
  }, 'behaviour'),
]

/**
 * Expands every macro call of a formula whose tables exist (the translator runs this before planning, so
 * CountRows(Comments(r)) or First(MyTasks()) delegate like the Filter they stand for).
 */
export function expandMacros(n: Node, hasTable: (name: string) => boolean): Node {
  const go = (x: Node): Node => expandMacros(x, hasTable)
  if (isSystemMacro(n) && systemMacroTables(n).every(hasTable)) {
    const args = n.args.map(go)
    return substitute(templateAst(TEMPLATES[n.name]!.formula()), args, n)
  }
  switch (n.t) {
    case 'member': return { ...n, obj: go(n.obj) }
    case 'call': return { ...n, args: n.args.map(go) }
    case 'unary': case 'pct': return { ...n, arg: go(n.arg) }
    case 'bin': return { ...n, left: go(n.left), right: go(n.right) }
    case 'chain': return { ...n, items: n.items.map(go) }
    case 'rec': return { ...n, fields: n.fields.map((f) => ({ ...f, value: go(f.value) })) }
    case 'tab': return { ...n, items: n.items.map(go) }
    case 'interp': return { ...n, parts: n.parts.map((p) => (typeof p === 'string' ? p : go(p))) }
    case 'as': return { ...n, expr: go(n.expr) }
    default: return n
  }
}

/** does the formula call a macro anywhere? (cheap pre-check) */
export function hasSystemMacro(n: Node): boolean {
  if (isSystemMacro(n)) return true
  const k = n as Node
  switch (k.t) {
    case 'member': return hasSystemMacro(k.obj)
    case 'call': return k.args.some(hasSystemMacro)
    case 'unary': case 'pct': return hasSystemMacro(k.arg)
    case 'bin': return hasSystemMacro(k.left) || hasSystemMacro(k.right)
    case 'chain': return k.items.some(hasSystemMacro)
    case 'rec': return k.fields.some((f) => hasSystemMacro(f.value))
    case 'tab': return k.items.some(hasSystemMacro)
    case 'interp': return k.parts.some((p) => typeof p !== 'string' && hasSystemMacro(p))
    case 'as': return hasSystemMacro(k.expr)
    default: return false
  }
}
