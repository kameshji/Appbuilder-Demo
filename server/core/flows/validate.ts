/**
 * Save-time validation of a flow (docs/dev/flows.md "Validation"): the schema of the trigger and of every step,
 * expressions checked with the server engine in the scope they run in (Trigger, Steps.<name>.Output typed from the step
 * kinds where known, Variables, loop items), delegable table reads, references to tables, columns, flows and
 * connections, runAfter (only earlier siblings, so no cycles; steps that can never run), callFlow recursion, limits.
 * Every problem names the step id and field so the designer can show it next to the input.
 */
import type { FxEngine, FxRecord, FxValue } from '../../../src/contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import {
  FLOW_LIMITS, STEP_KINDS, TRIGGER_TYPES, childLists, type FlowDefinition, type InputDef, type RunAs, type Step, type StepKind, type ValidationProblem,
} from '../../../src/platform/flows.ts'
import { CronError, checkTimeZone, parseCron } from '../cron.ts'
import { blankRecord } from '../event-fx.ts'
import { checkExpression, flowScope, open, type Problem, type ScopeData } from './expr.ts'
import * as approvalsPlatform from '../../../src/platform/approvals.ts'

export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const KINDS = new Set(STEP_KINDS.map((k) => k.kind))
const RUN_AFTER = ['succeeded', 'failed', 'skipped', 'timedOut']
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const INPUT_TYPES = ['text', 'number', 'boolean', 'date', 'datetime', 'choice', 'record', 'table']
const VAR_TYPES = ['text', 'number', 'boolean', 'date', 'record', 'table', 'any']
const SYSTEM_COLS = new Set(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])

/** what validation needs to know about the environment */
export interface ValidationContext {
  tables: TableDef[]
  /** other flows (callFlow targets and the recursion check): id, name, manual inputs, the flows they call */
  flows: { id: string; name: string; trigger: FlowDefinition['trigger']; calls: string[] }[]
  /** this flow's id (null: a new flow) */
  selfId: string | null
  selfName: string
  /** connection references of the flow: ref -> connector kind */
  connections: Map<string, string>
  engine: FxEngine
  /** actions of a connection reference (null: unknown, not checked) */
  actionsOf?(ref: string): Promise<{ id: string; inputs?: { required?: string[]; properties?: Record<string, unknown> } }[] | null>
}

const tableOf = (ctx: ValidationContext, name: string): TableDef | undefined => {
  const n = String(name ?? '').toLowerCase()
  return ctx.tables.find((t) => t.name.toLowerCase() === n || t.id === name)
}

const sampleOf = (type: string): FxValue => {
  switch (type) {
    case 'number': return 0
    case 'boolean': return false
    case 'date': case 'datetime': return new Date(0)
    case 'record': return open({})
    case 'table': return []
    case 'any': return open({})
    default: return ''
  }
}

export function triggerSample(t: FlowDefinition['trigger'], tables: TableDef[]): FxRecord {
  const user = { FullName: '', Email: '', Image: '', Id: '' }
  switch (t?.type) {
    case 'table': {
      const def = tables.find((x) => x.name.toLowerCase() === String(t.table ?? '').toLowerCase() || x.id === t.table)
      const rec = def ? blankRecord(def) : open({})
      for (const c of ['createdOn', 'modifiedOn', 'createdBy', 'owner']) if (def) (rec as FxRecord)[c] = null
      const old = def ? { ...blankRecord(def), createdOn: null, modifiedOn: null, createdBy: null, owner: null } : open({})
      return { Record: rec, Old: old, Operation: '', ChangedColumns: [], Table: '', User: user }
    }
    case 'schedule': return { ScheduledTime: new Date(0) }
    case 'manual': {
      const inputs: FxRecord = {}
      for (const i of t.inputs ?? []) if (i?.name) inputs[i.name] = sampleOf(i.type)
      return { Inputs: inputs, User: user }
    }
    case 'webhook': return { Body: open({}), Query: open({}), Headers: open({}), ReceivedOn: new Date(0), DeliveryId: '' }
    // P1-C
    case 'approvalDecided': return {
      Request: { Id: '', Title: '', Status: '', Outcome: '', RequestedBy: '', RequestedByEmail: '', Policy: '', RegardingTable: '', RegardingId: '', CompletedOn: new Date(0), Fields: open({}) },
      Responses: [{ Approver: '', Name: '', Response: '', Comment: '', Time: null, Stage: 0, UserId: '' }],
    }
    default: return open({})
  }
}

/** a sample of what a step's Output looks like (closed records where the shape is known) */
export function outputSample(s: Step, tables: TableDef[]): FxValue {
  const t = 'table' in s ? tables.find((x) => x.name.toLowerCase() === String(s.table ?? '').toLowerCase() || x.id === s.table) : undefined
  const row = (): FxValue => (t ? { ...blankRecord(t), createdOn: null, modifiedOn: null, createdBy: null, owner: null } : open({}))
  switch (s.kind) {
    case 'data.get': case 'data.create': case 'data.update': return row()
    case 'data.list': return [row() as FxRecord]
    case 'data.delete': return { Deleted: true }
    case 'condition': return { Result: false, Branch: '' }
    case 'switch': return { Value: null, Case: null }
    case 'forEach': return { Count: 0, Succeeded: 0, Failed: 0 }
    case 'until': return { Iterations: 0 }
    case 'scope': return { Status: '' }
    case 'approval': return {
      Outcome: '', Status: '', Responses: [{ Approver: '', Name: '', Response: '', Comment: '', Time: null, Stage: 0, UserId: '' }],
      Approvers: [{ Approver: '', Name: '', Stage: 0, Source: '', Status: '' }], ApprovalId: '', CompletedOn: null, Comments: '',
    }
    case 'delay': return { ResumedOn: new Date(0) }
    case 'notify': return { Delivered: [], Skipped: [] }
    case 'http': return { Status: 0, Headers: open({}), Body: open({}) }
    case 'callFlow': return { Status: '', Outputs: open({}), RunId: '' }
    case 'waitForCallback': return { Url: '', Body: open({}), ReceivedOn: new Date(0) }
    // a calculated value of unknown type: blank (it may be a number compared in a delegated filter)
    case 'compose': case 'setVariable': case 'respond': return null
    default: return open({})
  }
}

interface ListCtx {
  /** step name -> Steps.<name> sample */
  visible: Map<string, FxRecord>
  loops: { as: string; item: FxValue }[]
  parallelLoop: boolean
  depth: number
  /** a step id path for messages */
  inLoop: boolean
}

export interface ValidateOptions { strictConnections?: boolean }

export async function validateFlow(doc: { name?: unknown; description?: unknown; runAs?: unknown } & Partial<FlowDefinition>, ctx: ValidationContext): Promise<ValidationProblem[]> {
  const out: ValidationProblem[] = []
  const err = (step: string, field: string, message: string, p?: Problem) => out.push({ step, field, message, severity: 'error', ...(p?.start !== undefined ? { start: p.start, end: p.end } : {}) })
  const warn = (step: string, field: string, message: string) => out.push({ step, field, message, severity: 'warning' })

  if (typeof doc.name !== 'string' || !doc.name.trim()) err('', 'name', 'A flow needs a name.')
  else if (doc.name.length > 100) err('', 'name', 'The name is longer than 100 characters.')
  if (doc.description !== undefined && doc.description !== null && typeof doc.description !== 'string') err('', 'description', 'The description must be text.')

  // run as
  const runAs = doc.runAs as RunAs | undefined
  const trig = doc.trigger
  if (runAs !== undefined && runAs !== 'owner' && runAs !== 'triggeringUser' && !(runAs && typeof runAs === 'object' && typeof (runAs as { serviceAccount?: unknown }).serviceAccount === 'string')) {
    err('', 'runAs', 'runAs must be "owner", "triggeringUser" or { "serviceAccount": "<user id>" }.')
  }
  if (runAs === 'triggeringUser' && (trig?.type === 'schedule' || trig?.type === 'webhook' || trig?.type === 'approvalDecided')) err('', 'runAs', `A ${trig.type === 'schedule' ? 'schedule' : trig.type === 'webhook' ? 'web request' : 'decided approval'} has no triggering user: run the flow as its owner or a service account.`)

  // settings
  const st = doc.settings as Partial<FlowDefinition['settings']> | undefined
  if (!st || typeof st !== 'object') err('', 'settings', 'The flow needs settings (concurrency, timeoutMinutes, retentionDays, onError).')
  else {
    if (!['parallel', 'singleton', 'perRecord'].includes(String(st.concurrency))) err('', 'settings.concurrency', 'concurrency must be "parallel", "singleton" or "perRecord".')
    if (st.concurrency === 'perRecord' && trig?.type !== 'table') err('', 'settings.concurrency', '"perRecord" needs a table trigger (one run at a time per record).')
    if (!Number.isInteger(st.timeoutMinutes) || Number(st.timeoutMinutes) < 1 || Number(st.timeoutMinutes) > FLOW_LIMITS.runTimeoutMinutesMax) err('', 'settings.timeoutMinutes', `timeoutMinutes must be a whole number from 1 to ${FLOW_LIMITS.runTimeoutMinutesMax} (30 days).`)
    if (!Number.isInteger(st.retentionDays) || Number(st.retentionDays) < 1 || Number(st.retentionDays) > 3650) err('', 'settings.retentionDays', 'retentionDays must be a whole number from 1 to 3650.')
    if (!['fail', 'continue'].includes(String(st.onError))) err('', 'settings.onError', 'onError must be "fail" or "continue".')
    if (st.maxRunsPerMinute !== undefined && (!Number.isInteger(st.maxRunsPerMinute) || st.maxRunsPerMinute < 1 || st.maxRunsPerMinute > FLOW_LIMITS.runsPerMinute)) err('', 'settings.maxRunsPerMinute', `maxRunsPerMinute must be from 1 to ${FLOW_LIMITS.runsPerMinute}.`)
    if (st.triggerOnOwnChanges !== undefined && typeof st.triggerOnOwnChanges !== 'boolean') err('', 'settings.triggerOnOwnChanges', 'triggerOnOwnChanges must be true or false.')
  }

  // trigger
  if (!trig || typeof trig !== 'object') err('trigger', 'type', 'The flow needs a trigger.')
  else {
    const td = TRIGGER_TYPES.find((x) => x.type === trig.type)
    if (!td) err('trigger', 'type', `There is no trigger type "${String((trig as { type?: unknown }).type)}" (table, schedule, manual, webhook).`)
    else if (td.reserved) err('trigger', 'type', `The trigger "${trig.type}" is reserved for a later release.`)
    else if (trig.type === 'table') {
      const t = tableOf(ctx, trig.table)
      if (!t) err('trigger', 'table', `There is no table "${String(trig.table ?? '')}".`)
      if (!Array.isArray(trig.on) || !trig.on.length || !trig.on.every((o) => ['create', 'update', 'delete', 'restore'].includes(o))) err('trigger', 'on', 'on must list one or more of create, update, delete, restore.')
      if (trig.columns !== undefined) {
        if (!Array.isArray(trig.columns)) err('trigger', 'columns', 'columns must be a list of column names.')
        else if (t) for (const c of trig.columns) if (!t.columns.some((x) => x.name === c) && !SYSTEM_COLS.has(c)) err('trigger', 'columns', `${t.displayName} has no column "${String(c)}".`)
        if (Array.isArray(trig.on) && !trig.on.includes('update')) warn('trigger', 'columns', 'columns only filter updates; this trigger does not fire on updates.')
      }
      if (trig.coalesce !== undefined && typeof trig.coalesce !== 'boolean') err('trigger', 'coalesce', 'coalesce must be true or false.')
    } else if (trig.type === 'approvalDecided') {
      if (trig.policy !== undefined && (typeof trig.policy !== 'string' || !trig.policy.trim())) err('trigger', 'policy', 'policy must name an approval policy.')
      if (trig.statuses !== undefined && (!Array.isArray(trig.statuses) || !trig.statuses.length || trig.statuses.some((x) => !['approved', 'rejected', 'completed', 'expired', 'cancelled'].includes(x)))) err('trigger', 'statuses', 'statuses must list approved, rejected, completed, expired and/or cancelled.')
    } else if (trig.type === 'schedule') {
      const hasCron = typeof trig.cron === 'string' && trig.cron.trim() !== ''
      const hasEvery = trig.everyMinutes !== undefined && trig.everyMinutes !== null
      if (hasCron === hasEvery) err('trigger', 'cron', 'A schedule needs either a cron expression or everyMinutes.')
      if (hasCron) {
        try { parseCron(String(trig.cron)) } catch (e) { err('trigger', 'cron', e instanceof CronError ? e.message : 'The cron expression is not valid.') }
      }
      if (hasEvery && (!Number.isInteger(trig.everyMinutes) || Number(trig.everyMinutes) < 1 || Number(trig.everyMinutes) > 366 * 1440)) err('trigger', 'everyMinutes', 'everyMinutes must be a whole number from 1 to 527040 (a year).')
      try { checkTimeZone(String(trig.timeZone ?? '')) } catch (e) { err('trigger', 'timeZone', (e as Error).message) }
    } else if (trig.type === 'manual') {
      if (!Array.isArray(trig.inputs)) err('trigger', 'inputs', 'inputs must be a list (it may be empty).')
      else {
        const seen = new Set<string>()
        for (const [i, inp] of (trig.inputs as InputDef[]).entries()) {
          const f = `inputs[${i}]`
          if (!inp || typeof inp.name !== 'string' || !IDENT_RE.test(inp.name)) { err('trigger', `${f}.name`, 'An input needs a name made of letters, digits and _.'); continue }
          if (seen.has(inp.name.toLowerCase())) err('trigger', `${f}.name`, `The input "${inp.name}" is listed twice.`)
          seen.add(inp.name.toLowerCase())
          if (!INPUT_TYPES.includes(inp.type)) err('trigger', `${f}.type`, `The input "${inp.name}" needs a type: ${INPUT_TYPES.join(', ')}.`)
          if (inp.type === 'choice' && (!Array.isArray(inp.choices) || !inp.choices.length)) err('trigger', `${f}.choices`, `The choice input "${inp.name}" needs its choices.`)
        }
      }
      if (!['app', 'record', 'any'].includes(String(trig.from))) err('trigger', 'from', 'from must be "app", "record" or "any".')
    }
  }

  // variables
  const vars: FxRecord = {}
  for (const [i, v] of (Array.isArray(doc.variables) ? doc.variables : []).entries()) {
    if (!v || !IDENT_RE.test(String(v.name))) { err('', `variables[${i}].name`, 'A variable needs a name made of letters, digits and _.'); continue }
    if (v.name in vars) err('', `variables[${i}].name`, `The variable "${v.name}" is declared twice.`)
    if (!VAR_TYPES.includes(v.type)) err('', `variables[${i}].type`, `The variable "${v.name}" needs a type: ${VAR_TYPES.join(', ')}.`)
    vars[v.name] = v.initial !== undefined ? (v.initial as FxValue) : sampleOf(v.type)
  }
  if (doc.variables !== undefined && !Array.isArray(doc.variables)) err('', 'variables', 'variables must be a list.')

  // steps
  if (!Array.isArray(doc.steps)) {
    err('', 'steps', 'steps must be a list.')
    return out
  }
  const all: Step[] = []
  const collect = (list: Step[], depth: number): void => {
    for (const s of list) {
      if (!s || typeof s !== 'object') continue
      all.push(s)
      if (depth + 1 > FLOW_LIMITS.nesting && childLists(s).length) err(String(s.id ?? ''), 'steps', `Steps are nested more than ${FLOW_LIMITS.nesting} levels deep.`)
      for (const l of safeChildLists(s)) collect(l.steps, depth + 1)
    }
  }
  collect(doc.steps, 0)
  if (all.length > FLOW_LIMITS.stepsPerFlow) err('', 'steps', `A flow has at most ${FLOW_LIMITS.stepsPerFlow} steps; this one has ${all.length}. Split it with child flows (callFlow).`)
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const s of all) {
    const id = String(s.id ?? '')
    if (!IDENT_RE.test(id)) err(id, 'id', `"${id}" is not a valid step id (letters, digits and _, starting with a letter).`)
    else if (ids.has(id)) err(id, 'id', `The step id "${id}" is used twice.`)
    ids.add(id)
    if (typeof s.name !== 'string' || !IDENT_RE.test(s.name)) err(id, 'name', `The step needs a name made of letters, digits and _ (expressions read Steps.<name>.Output).`)
    else if (names.has(s.name.toLowerCase())) err(id, 'name', `The step name "${s.name}" is used twice.`)
    else if (['Trigger', 'Steps', 'Variables', 'Flow', 'ThisItem'].includes(s.name)) err(id, 'name', `"${s.name}" is a reserved name.`)
    names.add(String(s.name ?? '').toLowerCase())
    if (!KINDS.has(s.kind as StepKind)) err(id, 'kind', `There is no step kind "${String(s.kind)}".`)
  }
  if (out.some((p) => p.severity === 'error' && (p.field === 'id' || p.field === 'kind'))) return out

  const tables = ctx.tables
  const tableNames = new Set(tables.map((t) => t.name))
  const base: Omit<ScopeData, 'steps' | 'loops'> = {
    trigger: trig ? triggerSample(trig, tables) : open({}),
    variables: vars,
    flow: { RunId: '', Name: '', Id: '', Version: 0, Mode: '', Callback: open({}) },
    user: { FullName: '', Email: '', Image: '', Id: '' },
  }

  const checkFx = (stepId: string, field: string, formula: unknown, lc: ListCtx, required = true): void => {
    if (formula === undefined || formula === null || formula === '') {
      if (required) err(stepId, field, 'This formula is required.')
      return
    }
    if (typeof formula !== 'string') {
      // numbers and booleans are accepted as literal formulas
      if (typeof formula === 'number' || typeof formula === 'boolean') return
      err(stepId, field, 'A formula must be text.')
      return
    }
    const steps: FxRecord = {}
    for (const [n, v] of lc.visible) steps[n] = v
    const scope = flowScope({ ...base, steps, loops: lc.loops }, tableNames)
    for (const p of checkExpression(formula, scope, tables, ctx.engine, lc.loops.map((l) => l.as))) err(stepId, field, p.message, p)
  }

  const checkValues = (s: Step & { table: string; values: Record<string, unknown> }, lc: ListCtx): void => {
    const t = tableOf(ctx, s.table)
    if (!s.values || typeof s.values !== 'object' || Array.isArray(s.values)) { err(s.id, 'values', 'values must be an object of column: formula.'); return }
    for (const [k, f] of Object.entries(s.values)) {
      if (t) {
        const col = t.columns.find((c) => c.name === k)
        if (!col) err(s.id, `values.${k}`, `${t.displayName} has no column "${k}".`)
        else if (col.computed) err(s.id, `values.${k}`, `${col.displayName} is calculated; it cannot be set.`)
        else if (SYSTEM_COLS.has(k)) err(s.id, `values.${k}`, `${k} is set by the platform.`)
      }
      checkFx(s.id, `values.${k}`, f, lc)
    }
  }

  const runAfterIssues = (list: Step[]): void => {
    const pos = new Map(list.map((s, i) => [s.id, i]))
    for (const [i, s] of list.entries()) {
      if (s.runAfter === undefined) continue
      if (!Array.isArray(s.runAfter)) { err(s.id, 'runAfter', 'runAfter must be a list of { step, when }.'); continue }
      if (i === 0 && s.runAfter.length) err(s.id, 'runAfter', 'The first step of a list cannot wait for another step: there is none before it.')
      for (const ra of s.runAfter) {
        const j = pos.get(ra?.step)
        if (j === undefined) err(s.id, 'runAfter', ids.has(ra?.step) ? `runAfter can only name a step of the same list (here: ${list.slice(0, i).map((x) => x.id).join(', ') || 'none'}); "${ra?.step}" is elsewhere.` : `runAfter names "${String(ra?.step)}", which is not a step.`)
        else if (j >= i) err(s.id, 'runAfter', `runAfter names "${ra.step}", which comes ${j === i ? 'at the same place' : 'later'}: a step can only run after an earlier step (this also rules out cycles).`)
        if (!Array.isArray(ra?.when) || !ra.when.length || !ra.when.every((w) => RUN_AFTER.includes(w))) err(s.id, 'runAfter', `when must list one or more of ${RUN_AFTER.join(', ')}.`)
        else if (j !== undefined && j < i) {
          const target = list[j]
          if (target.kind === 'terminate' && ra.when.includes('succeeded')) warn(s.id, 'runAfter', `"${target.id}" ends the run (Terminate) when it succeeds, so this step only runs when it does not.`)
          const canTimeOut = target.timeoutMinutes !== undefined || ['approval', 'delay', 'waitForCallback', 'http', 'action', 'email', 'until', 'callFlow'].includes(target.kind) || ['scope', 'condition', 'switch', 'forEach'].includes(target.kind)
          if (ra.when.length === 1 && ra.when[0] === 'timedOut' && !canTimeOut) warn(s.id, 'runAfter', `"${target.id}" cannot time out, so this step only runs when it is skipped or never.`)
        }
      }
    }
    // a step after a Terminate with the default runAfter never runs
    for (const [i, s] of list.entries()) {
      if (i > 0 && list[i - 1].kind === 'terminate' && s.runAfter === undefined) warn(s.id, 'runAfter', `This step never runs: "${list[i - 1].id}" (Terminate) ends the run before it.`)
    }
  }

  const callTargets: string[] = []

  const validateList = async (list: Step[], lc: ListCtx): Promise<void> => {
    runAfterIssues(list)
    const visible = new Map(lc.visible)
    for (const s of list) {
      const here: ListCtx = { ...lc, visible: new Map(visible) }
      await validateStep(s, here)
      // later siblings see this step and the steps inside its (non-loop) containers
      visible.set(s.name, { Output: outputSample(s, tables), Status: '', Error: null, StartedOn: null, FinishedOn: null })
      if (s.kind === 'scope' || s.kind === 'condition' || s.kind === 'switch') {
        for (const l of safeChildLists(s)) addNested(l.steps, visible)
      }
    }
  }
  const addNested = (list: Step[], into: Map<string, FxRecord>): void => {
    for (const s of list) {
      into.set(s.name, { Output: outputSample(s, tables), Status: '', Error: null, StartedOn: null, FinishedOn: null })
      if (s.kind === 'scope' || s.kind === 'condition' || s.kind === 'switch') for (const l of safeChildLists(s)) addNested(l.steps, into)
    }
  }

  const connRef = (s: Step, field: string, ref: unknown, kinds?: string[]): void => {
    if (typeof ref !== 'string' || !ref) { err(s.id, field, 'Choose a connection attached to the flow.'); return }
    const k = ctx.connections.get(ref)
    if (k === undefined) err(s.id, field, `The flow has no connection "${ref}": attach a connection under that name first.`)
    else if (kinds && k && !kinds.includes(k)) err(s.id, field, `The connection "${ref}" is a ${k} connection; this step needs ${kinds.join(' or ')}.`)
  }

  const validateStep = async (s: Step, lc: ListCtx): Promise<void> => {
    const id = s.id
    if (s.retry !== undefined) {
      const r = s.retry
      if (!r || !['none', 'fixed', 'exponential'].includes(r.type)) err(id, 'retry.type', 'retry.type must be "none", "fixed" or "exponential".')
      else if (r.type !== 'none') {
        if (r.count !== undefined && (!Number.isInteger(r.count) || r.count < 1 || r.count > 10)) err(id, 'retry.count', 'retry.count (attempts in all) must be from 1 to 10.')
        if (r.intervalSeconds !== undefined && (!(Number(r.intervalSeconds) >= 1) || Number(r.intervalSeconds) > 86400)) err(id, 'retry.intervalSeconds', 'retry.intervalSeconds must be from 1 to 86400.')
      }
    }
    if (s.timeoutMinutes !== undefined && (!(Number(s.timeoutMinutes) > 0) || Number(s.timeoutMinutes) > FLOW_LIMITS.runTimeoutMinutesMax)) err(id, 'timeoutMinutes', `timeoutMinutes must be more than 0 and at most ${FLOW_LIMITS.runTimeoutMinutesMax}.`)
    switch (s.kind) {
      case 'condition':
        checkFx(id, 'if', s.if, lc)
        if (!Array.isArray(s.then)) err(id, 'then', 'then must be a list of steps.')
        if (s.else !== undefined && !Array.isArray(s.else)) err(id, 'else', 'else must be a list of steps.')
        for (const l of safeChildLists(s)) await validateList(l.steps, { ...lc, depth: lc.depth + 1 })
        break
      case 'switch':
        checkFx(id, 'on', s.on, lc)
        if (!Array.isArray(s.cases) || !s.cases.length) err(id, 'cases', 'A switch needs at least one case.')
        else {
          const seen = new Set<string>()
          for (const [i, c] of s.cases.entries()) {
            if (!c || !Array.isArray(c.steps)) err(id, `cases[${i}]`, 'A case needs { value, steps }.')
            const k = JSON.stringify(c?.value ?? null)
            if (seen.has(k)) err(id, `cases[${i}].value`, `The value ${k} is used by two cases.`)
            seen.add(k)
          }
        }
        for (const l of safeChildLists(s)) await validateList(l.steps, { ...lc, depth: lc.depth + 1 })
        break
      case 'forEach': {
        checkFx(id, 'items', s.items, lc)
        if (typeof s.as !== 'string' || !IDENT_RE.test(s.as)) err(id, 'as', 'as names the current item: letters, digits and _.')
        else if (['Trigger', 'Steps', 'Variables', 'Flow', 'ThisItem', 'User'].includes(s.as) || tableNames.has(s.as) || lc.loops.some((l) => l.as === s.as)) err(id, 'as', `"${s.as}" is already a name here; choose another.`)
        const conc = s.concurrency ?? 1
        if (!Number.isInteger(conc) || conc < 1 || conc > FLOW_LIMITS.forEachConcurrency) err(id, 'concurrency', `concurrency must be from 1 to ${FLOW_LIMITS.forEachConcurrency}.`)
        if (s.max !== undefined && (!Number.isInteger(s.max) || s.max < 1 || s.max > FLOW_LIMITS.loopIterations)) err(id, 'max', `max must be from 1 to ${FLOW_LIMITS.loopIterations}.`)
        if (!Array.isArray(s.steps)) err(id, 'steps', 'steps must be a list.')
        // the item: a row of the items table when the items come from a step whose rows are known
        let item: FxValue = open({})
        const m = typeof s.items === 'string' ? /^=?\s*Steps\.([A-Za-z_][A-Za-z0-9_]*)\.Output\s*$/.exec(s.items) : null
        const from = m ? lc.visible.get(m[1]) : undefined
        const outp = from?.Output
        if (Array.isArray(outp) && outp.length) item = outp[0]
        await validateList(s.steps ?? [], { ...lc, depth: lc.depth + 1, loops: [...lc.loops, { as: String(s.as), item }], parallelLoop: lc.parallelLoop || conc > 1, inLoop: true })
        break
      }
      case 'until':
        if (!Number.isInteger(s.maxIterations) || s.maxIterations < 1 || s.maxIterations > FLOW_LIMITS.loopIterations) err(id, 'maxIterations', `maxIterations must be from 1 to ${FLOW_LIMITS.loopIterations}.`)
        if (!Array.isArray(s.steps)) err(id, 'steps', 'steps must be a list.')
        await validateList(s.steps ?? [], { ...lc, depth: lc.depth + 1, inLoop: true })
        {
          // the condition sees the steps of the body
          const v = new Map(lc.visible)
          addNested(s.steps ?? [], v)
          checkFx(id, 'condition', s.condition, { ...lc, visible: v })
        }
        break
      case 'scope':
        if (!Array.isArray(s.steps)) err(id, 'steps', 'steps must be a list.')
        await validateList(s.steps ?? [], { ...lc, depth: lc.depth + 1 })
        break
      case 'setVariable':
        if (typeof s.variable !== 'string' || !(s.variable in vars)) err(id, 'variable', `There is no variable "${String(s.variable ?? '')}"; declare it in the flow's variables.`)
        if (lc.parallelLoop) err(id, 'variable', 'Set variable is not allowed inside a parallel For each (iterations would overwrite each other). Use concurrency 1, or Compose and collect the outputs.')
        checkFx(id, 'value', s.value, lc)
        break
      case 'compose':
        checkFx(id, 'value', s.value, lc)
        break
      case 'data.get': case 'data.delete': case 'data.update': case 'data.create': case 'data.list': {
        const t = tableOf(ctx, s.table)
        if (!t) err(id, 'table', `There is no table "${String(s.table ?? '')}".`)
        if (s.kind === 'data.get' || s.kind === 'data.delete' || s.kind === 'data.update') checkFx(id, 'rowId', s.rowId, lc)
        if (s.kind === 'data.create' || s.kind === 'data.update') checkValues(s as never, lc)
        if (t && (s.kind === 'data.create' || s.kind === 'data.update' || s.kind === 'data.delete') && t.readOnly) err(id, 'table', `${t.displayName} is read-only.`)
        if (s.kind === 'data.list') {
          if (s.filter !== undefined && s.filter !== '' && t) {
            const steps: FxRecord = {}
            for (const [n, v] of lc.visible) steps[n] = v
            const scope = flowScope({ ...base, steps, loops: lc.loops }, tableNames)
            for (const p of checkExpression(`Filter(${t.name}, ${String(s.filter).replace(/^\s*=/, '')})`, scope, tables, ctx.engine, lc.loops.map((l) => l.as))) err(id, 'filter', p.message)
          }
          if (s.top !== undefined && (!Number.isInteger(s.top) || s.top < 1 || s.top > 5000)) err(id, 'top', 'top must be from 1 to 5000.')
          if (s.sort !== undefined) {
            if (!Array.isArray(s.sort)) err(id, 'sort', 'sort must be a list of { column, descending }.')
            else if (t) for (const so of s.sort) if (!so || (!t.columns.some((c) => c.name === so.column) && !SYSTEM_COLS.has(so.column))) err(id, 'sort', `${t.displayName} has no column "${String(so?.column)}".`)
          }
          if (s.select !== undefined && (!Array.isArray(s.select) || (t && s.select.some((c) => !t.columns.some((x) => x.name === c) && !SYSTEM_COLS.has(c))))) err(id, 'select', 'select must list columns of the table.')
        }
        break
      }
      case 'approval':
        checkFx(id, 'title', s.title, lc)
        checkFx(id, 'details', s.details, lc, false)
        // P1-C: approvers may come from a policy
        // P1-E: or the step's own stages (sequential)
        checkFx(id, 'approvers', s.approvers, lc, !s.policy && !(s.type === 'sequential' && Array.isArray(s.stages) && s.stages.length > 0))
        if (s.policy !== undefined && (typeof s.policy !== 'string' || !s.policy.trim())) err(id, 'policy', 'policy must name an approval policy.')
        if (s.fields !== undefined) {
          if (!s.fields || typeof s.fields !== 'object' || Array.isArray(s.fields)) err(id, 'fields', 'fields must map labels to formulas.')
          else for (const [k, f] of Object.entries(s.fields)) {
            if (!k.trim() || k.length > 60) err(id, 'fields', 'Each field needs a label of at most 60 characters.')
            checkFx(id, `fields.${k}`, f, lc)
          }
        }
        {
          const { definitionProblems } = approvalsPlatform
          const def: Record<string, unknown> = { type: s.type ?? 'single', approvers: s.policy ? undefined : ['x@example.com'] }
          for (const k of ['quorum', 'stages', 'rules', 'responses', 'dueMinutes', 'reminders', 'escalation'] as const) if ((s as unknown as Record<string, unknown>)[k] !== undefined) def[k] = (s as unknown as Record<string, unknown>)[k]
          if (s.type === 'sequential' && !s.stages && s.policy) def.stages = [{ approvers: ['manager'] }]
          if (s.type === 'sequential' && !s.stages && !s.policy) def.stages = undefined
          if (def.escalation && def.dueMinutes === undefined && s.timeoutMinutes) def.dueMinutes = s.timeoutMinutes
          for (const p of definitionProblems(def)) if (p.field !== 'approvers' || !s.policy) err(id, p.field, p.message)
        }
        if (s.type !== undefined && !['single', 'all', 'any', 'sequential', 'quorum'].includes(s.type)) err(id, 'type', 'type must be single, any, all, quorum or sequential.')
        if (s.options !== undefined && (!Array.isArray(s.options) || !s.options.length || s.options.some((o) => typeof o !== 'string' || !o.trim()))) err(id, 'options', 'options must be a list of texts (default Approve, Reject).')
        if (s.regarding !== undefined) {
          if (!tableOf(ctx, s.regarding?.table)) err(id, 'regarding.table', `There is no table "${String(s.regarding?.table ?? '')}".`)
          checkFx(id, 'regarding.rowId', s.regarding?.rowId, lc)
        }
        break
      case 'delay':
        if ((s.minutes === undefined) === (s.until === undefined || s.until === '')) err(id, 'minutes', 'A delay needs either minutes or until.')
        if (s.minutes !== undefined && (!(Number(s.minutes) > 0) || Number(s.minutes) > FLOW_LIMITS.runTimeoutMinutesMax)) err(id, 'minutes', `minutes must be more than 0 and at most ${FLOW_LIMITS.runTimeoutMinutesMax}.`)
        if (s.until !== undefined && s.until !== '') checkFx(id, 'until', s.until, lc)
        break
      case 'notify':
        checkFx(id, 'to', s.to, lc)
        checkFx(id, 'title', s.title, lc)
        checkFx(id, 'body', s.body, lc, false)
        checkFx(id, 'link', s.link, lc, false)
        if (!Array.isArray(s.channels) || !s.channels.length || s.channels.some((c) => c !== 'inApp' && c !== 'email')) err(id, 'channels', 'channels must list inApp and/or email.')
        break
      case 'email':
        checkFx(id, 'to', s.to, lc)
        checkFx(id, 'cc', s.cc, lc, false)
        checkFx(id, 'subject', s.subject, lc)
        checkFx(id, 'body', s.body, lc)
        checkFx(id, 'attachments', s.attachments, lc, false)
        if (s.connection !== undefined) connRef(s, 'connection', s.connection, ['email'])
        break
      case 'action': {
        connRef(s, 'connection', s.connection)
        if (typeof s.action !== 'string' || !s.action) err(id, 'action', 'Choose the action.')
        if (!s.inputs || typeof s.inputs !== 'object' || Array.isArray(s.inputs)) err(id, 'inputs', 'inputs must be an object of name: formula.')
        else for (const [k, f] of Object.entries(s.inputs)) checkFx(id, `inputs.${k}`, f, lc)
        if (ctx.actionsOf && typeof s.connection === 'string' && ctx.connections.has(s.connection) && typeof s.action === 'string') {
          const list = await ctx.actionsOf(s.connection).catch(() => null)
          if (list) {
            const a = list.find((x) => x.id === s.action)
            if (!a) err(id, 'action', `The connection "${s.connection}" has no action "${s.action}" (it has: ${list.map((x) => x.id).slice(0, 15).join(', ') || 'none'}).`)
            else for (const r of a.inputs?.required ?? []) if (!(r in (s.inputs ?? {}))) err(id, `inputs.${r}`, `The action needs the input "${r}".`)
          }
        }
        break
      }
      case 'http':
        if (!METHODS.includes(String(s.method ?? '').toUpperCase())) err(id, 'method', `method must be one of ${METHODS.join(', ')}.`)
        checkFx(id, 'url', s.url, lc)
        if (s.headers !== undefined) {
          if (!s.headers || typeof s.headers !== 'object' || Array.isArray(s.headers)) err(id, 'headers', 'headers must be an object of name: formula.')
          else for (const [k, f] of Object.entries(s.headers)) checkFx(id, `headers.${k}`, f, lc)
        }
        checkFx(id, 'body', s.body, lc, false)
        if (s.auth === undefined) err(id, 'auth', 'An HTTP step needs an HTTP connection: it holds the hosts the flow may call and their credentials.')
        else connRef(s, 'auth', s.auth, ['http'])
        break
      case 'callFlow': {
        const target = ctx.flows.find((f) => f.id === s.flow || f.name.toLowerCase() === String(s.flow ?? '').toLowerCase())
        if (!target) err(id, 'flow', `There is no flow "${String(s.flow ?? '')}" in this environment.`)
        else if (target.trigger?.type !== 'manual') err(id, 'flow', `"${target.name}" is not started by a person or an app (manual trigger), so it cannot be called.`)
        else {
          callTargets.push(target.id)
          const defs = target.trigger.inputs ?? []
          for (const k of Object.keys(s.inputs ?? {})) if (!defs.some((d) => d.name === k)) err(id, `inputs.${k}`, `"${target.name}" has no input "${k}".`)
          for (const d of defs) if (d.required && d.default === undefined && !(d.name in (s.inputs ?? {}))) err(id, `inputs.${d.name}`, `"${target.name}" needs the input "${d.name}".`)
        }
        if (target && (target.id === ctx.selfId)) err(id, 'flow', 'A flow cannot call itself.')
        for (const [k, f] of Object.entries(s.inputs ?? {})) checkFx(id, `inputs.${k}`, f, lc)
        break
      }
      case 'terminate':
        if (!['succeeded', 'failed', 'cancelled'].includes(s.status)) err(id, 'status', 'status must be succeeded, failed or cancelled.')
        checkFx(id, 'message', s.message, lc, false)
        break
      case 'respond':
        checkFx(id, 'body', s.body, lc)
        if (s.status !== undefined && (!Number.isInteger(s.status) || s.status < 200 || s.status > 599)) err(id, 'status', 'status must be an HTTP status from 200 to 599.')
        if (lc.inLoop) warn(id, '', 'Respond inside a loop: only the first response of a run counts.')
        break
      case 'waitForCallback':
        break
    }
  }

  // the trigger condition
  if (trig?.type === 'table' && trig.condition) {
    const scope = flowScope({ ...base, steps: {}, loops: [] }, tableNames)
    for (const p of checkExpression(trig.condition, scope, tables, ctx.engine)) err('trigger', 'condition', p.message, p)
  }

  await validateList(doc.steps, { visible: new Map(), loops: [], parallelLoop: false, depth: 0, inLoop: false })

  // callFlow recursion: this flow -> ... -> this flow
  if (callTargets.length) {
    const graph = new Map(ctx.flows.map((f) => [f.id, f.calls]))
    const self = ctx.selfId ?? '__new__'
    graph.set(self, callTargets)
    const path: string[] = []
    const seen = new Set<string>()
    const nameOf = (fid: string) => (fid === self ? ctx.selfName : ctx.flows.find((f) => f.id === fid)?.name ?? fid)
    const dfs = (fid: string): boolean => {
      if (path.includes(fid)) {
        path.push(fid)
        return true
      }
      if (seen.has(fid)) return false
      seen.add(fid)
      path.push(fid)
      for (const n of graph.get(fid) ?? []) if (dfs(n)) return true
      path.pop()
      return false
    }
    for (const t of callTargets) {
      path.length = 0
      path.push(self)
      seen.clear()
      if (dfs(t)) {
        const start = path.indexOf(path[path.length - 1])
        const cyc = path.slice(start).map(nameOf)
        if (cyc.includes(ctx.selfName) || path[path.length - 1] === self) {
          const step = all.find((s) => s.kind === 'callFlow' && (s.flow === t || ctx.flows.find((f) => f.id === t)?.name.toLowerCase() === String(s.flow).toLowerCase()))
          err(step?.id ?? '', 'flow', `Calling this flow makes a loop: ${cyc.join(' -> ')}. Flows may not call themselves, directly or through others.`)
          break
        }
      }
    }
  }
  return out
}

function safeChildLists(s: Step): { suffix: string; steps: Step[] }[] {
  try {
    return childLists(s).map((l) => ({ ...l, steps: Array.isArray(l.steps) ? l.steps : [] }))
  } catch {
    return []
  }
}

/** the flows a definition calls (ids or names as written) */
export function callsOf(steps: Step[]): string[] {
  const out: string[] = []
  const visit = (list: Step[]): void => {
    for (const s of list ?? []) {
      if (s?.kind === 'callFlow' && typeof s.flow === 'string') out.push(s.flow)
      for (const l of safeChildLists(s)) visit(l.steps)
    }
  }
  visit(steps)
  return out
}
