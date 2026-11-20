import type { AppDef, ControlNode, FxHost, FxRecord, FxValue } from '@/contracts'
import { Evaluator, ROOT_CTX, enumName, type Env, type NodeCtx, type RuntimeView } from './evaluator'
import { uid, isRecord } from './util'
import { printCall, generateFileCall, newFileToken } from '@/print/runtime'
import { changeShare, collabAction, requestApprovalCall, restoreCall, runFlowCall, sendNotification, currentRow, errorMessage, isTable, platformMode, rowId, submitDeps, tableRows, tables } from './data'
import { pendingFilesOf } from './attachments'
import { finishSubmit } from './submit'
import { chainItems, prepareAction } from './delegation'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'
export interface Toast { id: string; message: string; kind: ToastKind }
export interface TraceEntry { id: string; at: number; kind: 'trace' | 'error'; message: string; data?: string; source?: string }

export interface RunInput {
  app: AppDef
  rt: RuntimeView & { navStack: string[] }
  env: Env
  node: ControlNode | null
  ctx: NodeCtx
  /** an action formula, or a direct host call (form submit from the built-in Save button) */
  formula?: string
  action?: (host: FxHost) => void
  label: string
  /** the built-in Save button (already validated by the control) */
  fromSubmitButton?: boolean
  /** design-time run (App.OnStart while editing): table writes are skipped */
  dryData?: boolean
}

export interface FollowUp { nodeId: string; event: string; ctx: NodeCtx }

/**
 * A Form submit whose verdict is not known yet (server mode, or files to upload). The store awaits `work`
 * and then writes LastSubmit / Error and fires OnSuccess or OnFailure.
 */
export interface DeferredSubmit {
  /** output key of the form (see Evaluator.outKey) */
  key: string
  nodeId: string
  ctx: NodeCtx
  name: string
  label: string
  /** resolves with the stored row; rejects with a SubmitError */
  work: () => Promise<FxRecord>
}

export interface RunResult {
  vars: Record<string, FxValue>
  context: Record<string, Record<string, FxValue>>
  collections: Record<string, FxRecord[]>
  navStack: string[]
  toasts: Toast[]
  resetIds: string[]
  focusIds: string[]
  formModes: Record<string, string>
  /** outKey -> output values to merge */
  outputs: Record<string, Record<string, FxValue>>
  followUps: FollowUp[]
  deferred: DeferredSubmit[]
  traces: TraceEntry[]
  exit: boolean
  /** an action failed (formula error or a refused data operation) */
  failed: string | null
}

const withId = (rec: FxRecord, existing: FxRecord[]): FxRecord => {
  const cur = rec.__id
  if (typeof cur === 'string' && !existing.some((r) => r.__id === cur)) return rec
  return { ...rec, __id: uid() }
}

const asText = (v: FxValue | undefined) => (v == null ? '' : typeof v === 'string' ? v : String(v))

function stringifyData(v: FxValue | undefined): string | undefined {
  if (v === undefined) return undefined
  try {
    return JSON.stringify(v, (k, val) => (k === '__id' ? undefined : val))
  } catch {
    return String(v)
  }
}

export function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
      return
    }
  } catch {
    /* ignore */
  }
  fallbackCopy(text)
}

function fallbackCopy(text: string) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  } catch {
    /* ignore */
  }
}

/** Run an action against a private copy of the runtime; the caller commits the result in one update. */
export function runFormula(input: RunInput): RunResult {
  const run = beginRun(input)
  run.exec(() => {
    if (input.action) input.action(run.host)
    else {
      const r = run.evr.engine.evaluate(input.formula ?? '=', run.evr.scopeFor(input.node, input.ctx), run.host)
      if (!r.ok) run.res.failed = r.error.message
    }
  })
  return run.end()
}

/**
 * Server mode, an action that reads tables the browser does not hold whole: each top-level step (`a; b; c`) has its
 * table reads run on the server first (after the writes of the earlier steps are saved), then runs with the results
 * bound. A read the server can't run fails the action with the reason; nothing runs on part of the rows.
 */
export async function runFormulaAsync(input: RunInput): Promise<RunResult> {
  const run = beginRun(input)
  try {
    const steps = chainItems(input.formula ?? '=')
    for (let i = 0; i < steps.length && !run.res.failed && !run.res.exit; i++) {
      if (i > 0 && run.writes() > 0) await submitDeps.flush().catch(() => {})
      const prep = await prepareAction(steps[i]!, run.evr.scopeFor(input.node, input.ctx), run.evr.engine, run.res.collections)
      run.exec(() => {
        const r = run.evr.engine.evaluate(prep.formula, prep.scope, run.host)
        if (!r.ok) run.res.failed = r.error.message
      })
    }
  } catch (e) {
    run.res.failed = errorMessage(e)
  }
  return run.end()
}

interface Run {
  res: RunResult
  evr: Evaluator
  host: FxHost
  /** table writes so far */
  writes(): number
  exec(fn: () => void): void
  end(): RunResult
}

function beginRun(input: RunInput): Run {
  const { app, rt, node, ctx, label } = input
  const view: RuntimeView = {
    ...rt,
    vars: { ...rt.vars },
    context: { ...rt.context },
    collections: { ...rt.collections },
    formModes: { ...rt.formModes },
  }
  let nav = rt.navStack.slice()
  const res: RunResult = {
    vars: view.vars,
    context: view.context,
    collections: view.collections,
    navStack: nav,
    toasts: [],
    resetIds: [],
    focusIds: [],
    formModes: view.formModes,
    outputs: {},
    followUps: [],
    deferred: [],
    traces: [],
    exit: false,
    failed: null,
  }
  // private evaluator over `view`, which the host mutates in place; each write drops what depends on it
  const evr = new Evaluator(app, view, input.env)
  const submitFromButton = !!input.fromSubmitButton
  const inv = (...deps: string[]) => deps.forEach((d) => evr.invalidate(d))
  const fresh = () => evr.invalidateTables()

  const fail = (message: string): never => {
    throw new HostFailure(message)
  }
  const isTableTarget = (name: string) => isTable(name) && !Object.prototype.hasOwnProperty.call(view.collections, name)
  const screenId = () => evr.screenIdOf(node) ?? nav[nav.length - 1] ?? app.screens[0]?.id
  const nodeByName = (name: string) => evr.byName.get(name)
  const setOut = (target: ControlNode, tctx: NodeCtx, values: Record<string, FxValue>) => {
    const k = evr.outKey(target, tctx)
    res.outputs[k] = { ...(res.outputs[k] ?? {}), ...values }
  }

  let writeCount = 0
  const tableWrite = <T,>(fn: () => T, dry?: T): T => {
    if (input.dryData) return dry as T
    try {
      const r = fn()
      writeCount++
      fresh()
      return r
    } catch (e) {
      if (e instanceof HostFailure) throw e
      return fail(errorMessage(e))
    }
  }

  const counter = (v: FxValue | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  /** effective form mode: the Mode output once written (NewForm/EditForm/ViewForm), else the Mode prop */
  const formMode = (f: ControlNode, fctx: NodeCtx) => {
    const out = evr.outputsOf(f, fctx).Mode
    const m = enumName(out == null || out === '' ? evr.evalProp(f, 'Mode', fctx).value : out)
    return m === 'new' ? 'new' : m === 'view' ? 'view' : 'edit'
  }

  const submitForm = (formName: string, fromButton: boolean) => {
    const info = nodeByName(formName)
    if (!info) return fail(`SubmitForm: "${formName}" is not a UI component`)
    const f = info.node
    const fctx = info.galleries.length ? ctx : ROOT_CTX
    const p = (k: string) => evr.evalProp(f, k, fctx).value
    const outs = { ...evr.outputsOf(f, fctx), ...(res.outputs[evr.outKey(f, fctx)] ?? {}) }
    const ds = asText(p('DataSource')).trim()
    const mode = formMode(f, fctx)
    const onFailure = () => res.followUps.push({ nodeId: f.id, event: 'OnFailure', ctx: fctx })
    if (counter(outs.__busy) > 0) return // a previous submit is still waiting for the server
    if (mode === 'view') {
      setOut(f, fctx, { Error: 'The form is in View mode' })
      onFailure()
      return
    }
    if (!fromButton && outs.Valid === false) {
      setOut(f, fctx, { Error: 'Fix the highlighted fields and try again', __touch: counter(outs.__touch) + 1 })
      onFailure()
      return
    }
    const updates = isRecord(outs.Updates) ? outs.Updates : {}
    try {
      let stored: FxRecord
      let deferTable = false
      if (!ds) throw new Error('The form has no DataSource')
      const item = p('Item')
      const id = mode === 'new' ? null : rowId(isRecord(item) ? item : null)
      if (input.dryData) stored = { ...updates }
      else if (isTableTarget(ds)) {
        // the form's base version (package H): a stale save is refused with 409 and the form offers reload / keep mine
        const version = outs.__version instanceof Date || (typeof outs.__version === 'string' && outs.__version) ? (outs.__version as Date | string) : null
        stored = id ? tables.update(ds, id, updates, { ifVersion: version }) : tables.insert(ds, updates)
        fresh()
        deferTable = true
      } else if (Object.prototype.hasOwnProperty.call(view.collections, ds)) {
        const list = view.collections[ds].slice()
        const i = id ? list.findIndex((r) => r.__id === id) : -1
        stored = i >= 0 ? { ...list[i], ...updates } : { ...updates, __id: uid() }
        if (i >= 0) list[i] = stored
        else list.push(stored)
        view.collections[ds] = list
        inv('k:' + ds)
      } else throw new Error(`"${ds}" is not a table`)
      const files = deferTable ? pendingFilesOf(outs.__files) : []
      const storedId = rowId(stored)
      if (deferTable && storedId && (files.length > 0 || platformMode() === 'server')) {
        // wait for the server's verdict, then upload the pending files; the store finishes the submit
        const table = ds
        setOut(f, fctx, { Error: '', __busy: 1 })
        res.deferred.push({
          key: evr.outKey(f, fctx),
          nodeId: f.id,
          ctx: fctx,
          name: f.name,
          label,
          work: async () => {
            await finishSubmit(submitDeps, { table, rowId: storedId, files })
            return currentRow(table, storedId) ?? stored
          },
        })
        return
      }
      setOut(f, fctx, { LastSubmit: stored, Error: '', Unsaved: false, __saved: counter(outs.__saved) + 1 })
      res.followUps.push({ nodeId: f.id, event: 'OnSuccess', ctx: fctx })
    } catch (e) {
      const msg = errorMessage(e)
      setOut(f, fctx, { Error: msg })
      res.toasts.push({ id: uid(), message: `${f.name}: ${msg}`, kind: 'error' })
      res.traces.push({ id: uid(), at: Date.now(), kind: 'error', message: `${f.name}: ${msg}`, source: label })
      onFailure()
    }
  }

  const host: FxHost = {
    setVar(name, value) {
      view.vars[name] = value
      inv('v:' + name)
    },
    updateContext(values) {
      const s = screenId()
      if (!s) return
      view.context[s] = { ...(view.context[s] ?? {}), ...values }
      inv(...Object.keys(values).map((k) => `c:${s}:${k}`))
    },
    collect(coll, items, clearFirst) {
      if (isTableTarget(coll)) {
        if (clearFirst) fail(`ClearCollect works on collections; ${coll} is a table (use Collect or Patch)`)
        tableWrite(() => {
          for (const it of items) tables.insert(coll, isRecord(it) ? it : { Value: it })
        })
        return
      }
      const base = clearFirst ? [] : (view.collections[coll] ?? [])
      const next = base.slice()
      for (const it of items) next.push(withId(isRecord(it) ? it : { Value: it }, next))
      view.collections[coll] = next
      inv('k:' + coll)
    },
    clear(coll) {
      if (isTableTarget(coll)) {
        tableWrite(() => {
          const ids = tableRows(coll).map((r) => rowId(r)).filter((x): x is string => !!x)
          if (ids.length) tables.delete(coll, ids)
        })
        return
      }
      view.collections[coll] = []
      inv('k:' + coll)
    },
    remove(coll, records) {
      const ids = records.map((r) => rowId(r)).filter((x): x is string => !!x)
      if (isTableTarget(coll)) {
        if (ids.length) tableWrite(() => tables.delete(coll, ids))
        return
      }
      const set = new Set(ids)
      view.collections[coll] = (view.collections[coll] ?? []).filter((r) => !(typeof r.__id === 'string' && set.has(r.__id)))
      inv('k:' + coll)
    },
    patch(coll, base, changes) {
      if (isTableTarget(coll)) {
        const id = rowId(base)
        return tableWrite(() => (id ? tables.update(coll, id, changes) : tables.insert(coll, { ...base, ...changes })), { ...base, ...changes })
      }
      const list = (view.collections[coll] ?? []).slice()
      const id = typeof base.__id === 'string' ? base.__id : null
      const i = id ? list.findIndex((r) => r.__id === id) : -1
      let stored: FxRecord
      if (i >= 0) {
        stored = { ...list[i], ...changes, __id: id as string }
        list[i] = stored
      } else {
        stored = { ...base, ...changes, __id: uid() }
        list.push(stored)
      }
      view.collections[coll] = list
      inv('k:' + coll)
      return stored
    },
    navigate(screenName) {
      const s = evr.screensByName.get(screenName)
      if (!s) {
        res.toasts.push({ id: uid(), message: `Navigate: screen "${screenName}" not found`, kind: 'error' })
        return
      }
      if (nav[nav.length - 1] !== s.id) nav = [...nav, s.id]
      view.currentScreenId = s.id
    },
    back() {
      if (nav.length > 1) nav = nav.slice(0, -1)
      view.currentScreenId = nav[nav.length - 1]
    },
    notify(message, kind) {
      res.toasts.push({ id: uid(), message, kind })
    },
    reset(controlName) {
      const info = nodeByName(controlName)
      if (info) res.resetIds.push(info.node.id)
    },
    form(action, formName) {
      if (action === 'submit') return submitForm(formName, submitFromButton)
      const info = nodeByName(formName)
      if (!info) return fail(`"${formName}" is not a UI component`)
      const fctx = info.galleries.length ? ctx : ROOT_CTX
      const k = evr.outKey(info.node, fctx)
      const outs = { ...evr.outputsOf(info.node, fctx), ...(res.outputs[k] ?? {}) }
      const patch: Record<string, FxValue> = { Error: '' }
      if (action === 'new') patch.Mode = 'New'
      if (action === 'edit') patch.Mode = 'Edit'
      if (action === 'view') patch.Mode = 'View'
      if (action === 'new' || action === 'reset') patch.__reset = counter(outs.__reset) + 1
      setOut(info.node, fctx, patch)
    },
    select(controlName) {
      const info = nodeByName(controlName)
      if (info) res.followUps.push({ nodeId: info.node.id, event: 'OnSelect', ctx: info.galleries.length ? ctx : ROOT_CTX })
    },
    setFocus(controlName) {
      const info = nodeByName(controlName)
      if (info) res.focusIds.push(info.node.id)
    },
    launch(url) {
      try {
        window.open(url, '_blank', 'noopener')
      } catch {
        /* blocked */
      }
    },
    copy(text) {
      copyText(text)
    },
    trace(message, data) {
      res.traces.push({ id: uid(), at: Date.now(), kind: 'trace', message, data: stringifyData(data), source: label })
    },
    exit() {
      res.exit = true
    },
    refresh(source) {
      if (isTable(source)) tables.reload(source)
    },
    share(rowIdValue, principal, access) {
      void changeShare(rowIdValue, principal, access)
    },
    unshare(rowIdValue, principal) {
      void changeShare(rowIdValue, principal, null)
    },
    sendNotification(to, title, body, link) {
      if (input.dryData) return
      void sendNotification({ to, title, ...(body ? { body } : {}), ...(link ? { link } : {}) })
    },
    collab(action, args) {
      if (input.dryData) return action === 'nextNumber' ? '' : true
      return collabAction(action, args)
    },
    runFlow(flow, inputs, options) {
      const runId = `run_${uid().replace(/[^A-Za-z0-9]/g, '').slice(0, 24).padEnd(12, '0')}`
      if (input.dryData) return runId
      void runFlowCall({ flow, inputs: toJsonValue(inputs), runId, wait: options.wait, timeoutSeconds: options.timeoutSeconds }, options.wait ? (v) => host.setVar(options.result, fromJsonValue(v)) : undefined)
      return runId
    },
    requestApproval(req) {
      if (input.dryData) return req.id
      void requestApprovalCall({ ...req, fields: toJsonValue(req.fields) })
      return req.id
    },
    restore(what) {
      if (input.dryData) return
      restoreCall(what)
    },
    // P2-B print templates
    print(template, recordId) {
      if (input.dryData) return
      void printCall(template, recordId)
    },
    generateFile(kind, template, recordId) {
      const token = newFileToken()
      if (input.dryData) return token
      void generateFileCall(kind, template, recordId, token)
      return token
    },
  }

  return {
    res,
    evr,
    host,
    writes: () => writeCount,
    exec(fn) {
      try {
        fn()
      } catch (e) {
        res.failed = errorMessage(e)
      }
    },
    end() {
      if (res.failed) {
        const message = `${label}: ${res.failed}`
        res.toasts.push({ id: uid(), message, kind: 'error' })
        res.traces.push({ id: uid(), at: Date.now(), kind: 'error', message, source: label })
      }
      res.navStack = nav
      return res
    },
  }
}

class HostFailure extends Error {}

/** formula values -> JSON for the server (dates as ISO text, single-column tables as lists) */
function toJsonValue(v: FxValue): unknown {
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.every((x) => isRecord(x) && Object.keys(x).filter((k) => k !== '__id').length === 1 && 'Value' in x) ? v.map((x) => toJsonValue((x as FxRecord).Value)) : v.map(toJsonValue)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '__id').map(([k, x]) => [k, toJsonValue(x)]))
  return v
}
/** JSON from the server -> a formula value (objects are records, lists of scalars tables of Value) */
function fromJsonValue(j: unknown): FxValue {
  if (j === null || j === undefined) return null
  if (Array.isArray(j)) return j.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? fromJsonValue(x) : { Value: fromJsonValue(x) })) as FxValue
  if (typeof j === 'object') return Object.fromEntries(Object.entries(j as Record<string, unknown>).map(([k, x]) => [k, fromJsonValue(x)])) as FxValue
  return j as FxValue
}
