/**
 * "Dynamic content": what a field of a step can read, typed, as ready-to-insert tokens (Trigger.Record.Amount,
 * Steps.Approve.Output.Outcome, Variables.Total, the loop item, Flow.RunId, User().Email). Built from the trigger (table
 * columns, lookups one hop through LookUp, Old for updates, manual inputs, a pasted webhook body sample), from the steps
 * the field's step can see (typed by kind, table, action output schema or a pasted HTTP sample) and the variables. Pure.
 */
import type { Step, InputDef, VariableDef } from '@/platform/flows'
import type { TableDef, ColumnType } from '@/platform/contracts'
import { findStep, visibleStepNames, walk, type FlowDoc } from './model'

export type ValueType = 'text' | 'number' | 'boolean' | 'date' | 'record' | 'table' | 'any'
export interface DynToken { group: string; label: string; insert: string; type: ValueType; doc?: string }

export interface JsonSchemaLite { type?: string | string[]; properties?: Record<string, JsonSchemaLite>; items?: JsonSchemaLite; description?: string }

export interface DynContext {
  tables: TableDef[]
  /** output schema of an action (connection reference, action id) when known */
  actionOutput?(ref: string, action: string): JsonSchemaLite | null
}

export function columnType(t: ColumnType | string): ValueType {
  switch (t) {
    case 'number': case 'decimal': case 'currency': case 'autonumber': return t === 'autonumber' ? 'text' : 'number'
    case 'boolean': return 'boolean'
    case 'date': case 'datetime': return 'date'
    default: return 'text'
  }
}
const inputType = (t: InputDef['type']): ValueType => (t === 'datetime' ? 'date' : t === 'choice' ? 'text' : (t as ValueType))
const varType = (t: VariableDef['type']): ValueType => t as ValueType

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/** a member name for a formula ('Unit price' -> 'Unit price' quoted) */
export const member = (n: string): string => (IDENT.test(n) ? n : `'${n.replace(/'/g, "''")}'`)

export const tableByName = (tables: TableDef[], name: string | undefined): TableDef | undefined => {
  const n = String(name ?? '').toLowerCase()
  return tables.find((t) => t.name.toLowerCase() === n || t.id === name)
}

const SYSTEM: [string, ValueType][] = [['id', 'text'], ['createdOn', 'date'], ['modifiedOn', 'date'], ['createdBy', 'text'], ['owner', 'text']]

/** the columns of a row of a table as tokens under `base` (with lookups one hop when `lookups`) */
export function rowTokens(group: string, base: string, t: TableDef | undefined, tables: TableDef[], o: { lookups?: boolean; prefix?: string } = {}): DynToken[] {
  if (!t) return [{ group, label: o.prefix ?? 'Row', insert: base, type: 'record' }]
  const out: DynToken[] = []
  for (const c of t.columns) {
    if (c.system && SYSTEM.some(([n]) => n === c.name)) continue
    out.push({ group, label: `${o.prefix ? `${o.prefix} ` : ''}${c.displayName}`, insert: `${base}.${member(c.name)}`, type: columnType(c.type), doc: c.type === 'lookup' ? `id of a ${c.lookupTable} row` : c.type })
    if (o.lookups && c.type === 'lookup' && c.lookupTable) {
      const target = tableByName(tables, c.lookupTable)
      if (target) for (const tc of target.columns.filter((x) => !x.system).slice(0, 12)) {
        out.push({ group, label: `${o.prefix ? `${o.prefix} ` : ''}${c.displayName} → ${tc.displayName}`, insert: `LookUp(${member(target.name)}, id = ${base}.${member(c.name)}).${member(tc.name)}`, type: columnType(tc.type), doc: `read from ${target.displayName}` })
      }
    }
  }
  for (const [n, ty] of SYSTEM) out.push({ group, label: `${o.prefix ? `${o.prefix} ` : ''}${n === 'id' ? 'Row id' : n === 'createdOn' ? 'Created on' : n === 'modifiedOn' ? 'Modified on' : n === 'createdBy' ? 'Created by' : 'Owner'}`, insert: `${base}.${n}`, type: ty })
  return out
}

/** tokens for a JSON value (a pasted sample): its fields, nested up to 3 levels */
export function sampleTokens(group: string, base: string, sample: unknown, prefix = '', depth = 0): DynToken[] {
  const out: DynToken[] = []
  if (sample === null || sample === undefined || depth > 3) return out
  if (Array.isArray(sample)) {
    out.push({ group, label: prefix || 'List', insert: base, type: 'table' })
    if (sample.length && typeof sample[0] === 'object' && sample[0] !== null) out.push(...sampleTokens(group, `First(${base})`, sample[0], `${prefix || 'List'} → first`, depth + 1))
    return out
  }
  if (typeof sample === 'object') {
    for (const [k, v] of Object.entries(sample as Record<string, unknown>)) {
      const ins = `${base}.${member(k)}`
      const label = prefix ? `${prefix} → ${k}` : k
      if (v && typeof v === 'object') out.push(...(Array.isArray(v) ? sampleTokens(group, ins, v, label, depth + 1) : [{ group, label, insert: ins, type: 'record' as ValueType }, ...sampleTokens(group, ins, v, label, depth + 1)]))
      else out.push({ group, label, insert: ins, type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text' })
    }
  }
  return out
}

/** tokens for a JSON Schema (action outputs) */
export function schemaTokens(group: string, base: string, s: JsonSchemaLite | null | undefined, prefix = '', depth = 0): DynToken[] {
  if (!s || depth > 3) return []
  const ty = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type
  if (ty === 'object' && s.properties) {
    const out: DynToken[] = []
    for (const [k, v] of Object.entries(s.properties)) {
      const vt = Array.isArray(v.type) ? v.type.find((x) => x !== 'null') : v.type
      const label = prefix ? `${prefix} → ${k}` : k
      const ins = `${base}.${member(k)}`
      if (vt === 'object') out.push({ group, label, insert: ins, type: 'record', doc: v.description }, ...schemaTokens(group, ins, v, label, depth + 1))
      else out.push({ group, label, insert: ins, type: vt === 'array' ? 'table' : vt === 'number' || vt === 'integer' ? 'number' : vt === 'boolean' ? 'boolean' : 'text', doc: v.description })
    }
    return out
  }
  return []
}

/** what Steps.<name> gives, typed */
export function stepOutputTokens(s: Step, ctx: DynContext): DynToken[] {
  const g = s.name
  const base = `Steps.${s.name}.Output`
  const a = s as Step & Record<string, unknown>
  const t = 'table' in a ? tableByName(ctx.tables, a.table as string) : undefined
  const fixed = (fields: [string, ValueType][]) => fields.map(([f, ty]) => ({ group: g, label: f, insert: `${base}.${f}`, type: ty }))
  let out: DynToken[]
  switch (s.kind) {
    case 'data.get': case 'data.create': case 'data.update': out = rowTokens(g, base, t, ctx.tables); break
    case 'data.list': out = [
      { group: g, label: 'Rows (table)', insert: base, type: 'table' },
      { group: g, label: 'Number of rows', insert: `CountRows(${base})`, type: 'number' },
      ...rowTokens(g, `First(${base})`, t, ctx.tables, { prefix: 'First row →' }),
    ]; break
    case 'data.delete': out = fixed([['Deleted', 'boolean']]); break
    case 'approval': out = fixed([['Outcome', 'text'], ['Comments', 'text'], ['CompletedOn', 'date'], ['ApprovalId', 'text'], ['Responses', 'table']]); break
    case 'http': {
      out = fixed([['Status', 'number'], ['Body', 'record'], ['Headers', 'record']])
      if (a.sample !== undefined) out.push(...sampleTokens(g, `${base}.Body`, a.sample, 'Body'))
      break
    }
    case 'action': {
      const sch = ctx.actionOutput?.(String(a.connection ?? ''), String(a.action ?? ''))
      out = [{ group: g, label: 'Output', insert: base, type: 'any' }, ...schemaTokens(g, base, sch)]
      if (a.sample !== undefined) out.push(...sampleTokens(g, base, a.sample))
      break
    }
    case 'callFlow': out = fixed([['Status', 'text'], ['Outputs', 'record'], ['RunId', 'text']]); break
    case 'condition': out = fixed([['Result', 'boolean'], ['Branch', 'text']]); break
    case 'switch': out = fixed([['Value', 'any'], ['Case', 'any']]); break
    case 'forEach': out = fixed([['Count', 'number'], ['Succeeded', 'number'], ['Failed', 'number']]); break
    case 'until': out = fixed([['Iterations', 'number']]); break
    case 'delay': out = fixed([['ResumedOn', 'date']]); break
    case 'notify': out = fixed([['Delivered', 'table'], ['Skipped', 'table']]); break
    case 'waitForCallback': out = fixed([['Body', 'record'], ['ReceivedOn', 'date']]); break
    case 'scope': out = fixed([['Status', 'text']]); break
    default: out = [{ group: g, label: 'Output', insert: base, type: 'any' }]
  }
  out.push({ group: g, label: 'Status of the step', insert: `Steps.${s.name}.Status`, type: 'text', doc: 'succeeded, failed, skipped, timedOut' })
  if (!['condition', 'switch', 'scope', 'forEach', 'until', 'compose', 'setVariable'].includes(s.kind)) out.push({ group: g, label: 'Error message', insert: `Steps.${s.name}.Error`, type: 'text' })
  return out
}

/** what the trigger gives */
export function triggerTokens(doc: FlowDoc, ctx: DynContext): DynToken[] {
  const tr = doc.trigger as FlowDoc['trigger'] & Record<string, unknown>
  const g = 'Trigger'
  switch (tr?.type) {
    case 'table': {
      const t = tableByName(ctx.tables, tr.table as string)
      const out = rowTokens(g, 'Trigger.Record', t, ctx.tables, { lookups: true })
      if (Array.isArray(tr.on) && (tr.on as string[]).includes('update')) out.push(...rowTokens('Trigger (before the change)', 'Trigger.Old', t, ctx.tables, { prefix: 'Old' }))
      out.push({ group: g, label: 'Operation', insert: 'Trigger.Operation', type: 'text', doc: 'create, update or delete' }, { group: g, label: 'Changed columns', insert: 'Trigger.ChangedColumns', type: 'table' }, { group: g, label: 'Changed by: name', insert: 'Trigger.User.FullName', type: 'text' }, { group: g, label: 'Changed by: email', insert: 'Trigger.User.Email', type: 'text' })
      return out
    }
    case 'schedule': return [{ group: g, label: 'Scheduled time', insert: 'Trigger.ScheduledTime', type: 'date' }]
    case 'manual': return [
      ...((tr.inputs as InputDef[]) ?? []).filter((i) => i?.name).map((i) => ({ group: g, label: `Input ${i.name}`, insert: `Trigger.Inputs.${member(i.name)}`, type: inputType(i.type), doc: i.description })),
      { group: g, label: 'Started by: name', insert: 'Trigger.User.FullName', type: 'text' }, { group: g, label: 'Started by: email', insert: 'Trigger.User.Email', type: 'text' },
    ]
    case 'webhook': return [
      { group: g, label: 'Body', insert: 'Trigger.Body', type: 'record' },
      ...(tr.sample !== undefined ? sampleTokens(g, 'Trigger.Body', tr.sample, 'Body') : []),
      { group: g, label: 'Query', insert: 'Trigger.Query', type: 'record' }, { group: g, label: 'Headers', insert: 'Trigger.Headers', type: 'record' }, { group: g, label: 'Received on', insert: 'Trigger.ReceivedOn', type: 'date' },
    ]
    default: return []
  }
}

/** the loops around a step (outermost first) with their item tokens */
function loopTokens(doc: FlowDoc, stepId: string, ctx: DynContext): DynToken[] {
  const f = findStep(doc.steps, stepId)
  if (!f) return []
  const out: DynToken[] = []
  const loops = f.ancestors.map((id) => findStep(doc.steps, id)!.step).filter((s) => s.kind === 'forEach')
  loops.forEach((l, i) => {
    const as = String((l as Step & { as?: string }).as || 'Item')
    const g = `Loop item (${as})`
    const items = String((l as Step & { items?: string }).items ?? '').trim().replace(/^=/, '')
    const m = /^Steps\.([A-Za-z_][A-Za-z0-9_]*)\.Output$/.exec(items)
    let src: Step | undefined
    if (m) walk(doc.steps, (s) => { if (s.name === m[1]) src = s })
    const t = src && src.kind === 'data.list' ? tableByName(ctx.tables, (src as Step & { table: string }).table) : undefined
    out.push({ group: g, label: as, insert: as, type: 'record' }, ...(t ? rowTokens(g, as, t, ctx.tables) : []))
    if (i === loops.length - 1) out.push({ group: g, label: 'ThisItem', insert: 'ThisItem', type: 'record', doc: 'the item of the innermost loop' })
  })
  return out
}

/** everything a field of step `stepId` (or of the trigger: 'trigger') can insert, grouped */
export function dynamicContent(doc: FlowDoc, stepId: string, ctx: DynContext): DynToken[] {
  if (stepId === 'trigger') {
    // the trigger condition sees the record (and Old), nothing else
    return triggerTokens(doc, ctx).filter((t) => t.insert.startsWith('Trigger.Record') || t.insert.startsWith('Trigger.Old') || t.insert.startsWith('LookUp('))
  }
  const out: DynToken[] = [...triggerTokens(doc, ctx)]
  const vis = visibleStepNames(doc, stepId)
  walk(doc.steps, (s) => { if (vis.has(s.name) && s.id !== stepId) out.push(...stepOutputTokens(s, ctx)) })
  out.push(...loopTokens(doc, stepId, ctx))
  for (const v of doc.variables ?? []) out.push({ group: 'Variables', label: v.name, insert: `Variables.${member(v.name)}`, type: varType(v.type) })
  out.push(
    { group: 'Flow', label: 'Run id', insert: 'Flow.RunId', type: 'text' }, { group: 'Flow', label: 'Flow name', insert: 'Flow.Name', type: 'text' },
    { group: 'Flow', label: 'Now', insert: 'Now()', type: 'date' }, { group: 'Flow', label: 'Today', insert: 'Today()', type: 'date' },
    { group: 'Run as', label: 'Name', insert: 'User().FullName', type: 'text' }, { group: 'Run as', label: 'Email', insert: 'User().Email', type: 'text' },
  )
  return out
}

/** inserts a token into a formula at the caret: inside a text literal it becomes " & token & " */
export function insertToken(fx: string, caret: number, token: string): { text: string; caret: number } {
  const before = fx.slice(0, caret)
  let quotes = 0
  for (const ch of before) if (ch === '"') quotes++
  const ins = quotes % 2 === 1 ? `" & ${token} & "` : token
  return { text: before + ins + fx.slice(caret), caret: caret + ins.length }
}
