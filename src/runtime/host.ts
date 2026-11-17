import type { AppDef, ControlNode, FxHost, FxRecord, FxValue } from '@/contracts'
import { fx } from '@/fx'
import { Evaluator, type NodeCtx, type RuntimeView } from './evaluator'
import { uid, isRecord } from './util'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'
export interface Toast { id: string; message: string; kind: ToastKind }

export interface RunInput {
  app: AppDef
  rt: RuntimeView & { navStack: string[] }
  node: ControlNode | null
  ctx: NodeCtx
  formula: string
  label: string
}

export interface RunResult {
  vars: Record<string, FxValue>
  context: Record<string, FxValue>
  collections: Record<string, FxRecord[]>
  navStack: string[]
  toasts: Toast[]
  resetIds: string[]
}

const withId = (rec: FxRecord, existing: FxRecord[]): FxRecord => {
  const cur = rec.__id
  if (typeof cur === 'string' && !existing.some((r) => r.__id === cur)) return rec
  return { ...rec, __id: uid() }
}

/** Run an action formula against a private copy of the runtime; the caller commits the result in one update. */
export function runFormula(input: RunInput): RunResult {
  const { app, rt, node, ctx, formula, label } = input
  const view = {
    vars: { ...rt.vars },
    context: { ...rt.context },
    collections: { ...rt.collections },
    outputs: rt.outputs,
    resetKeys: rt.resetKeys,
  }
  let nav = rt.navStack.slice()
  const toasts: Toast[] = []
  const resetIds: string[] = []
  const ev = new Evaluator(app, view)

  const host: FxHost = {
    setVar(name, value) {
      view.vars[name] = value
      ev.invalidate()
    },
    updateContext(values) {
      Object.assign(view.context, values)
      ev.invalidate()
    },
    collect(coll, items, clearFirst) {
      const base = clearFirst ? [] : (view.collections[coll] ?? [])
      const next = base.slice()
      for (const it of items) next.push(withId(isRecord(it) ? it : { Value: it }, next))
      view.collections[coll] = next
      ev.invalidate()
    },
    clear(coll) {
      view.collections[coll] = []
      ev.invalidate()
    },
    remove(coll, records) {
      const ids = new Set(records.map((r) => r.__id).filter((x): x is string => typeof x === 'string'))
      view.collections[coll] = (view.collections[coll] ?? []).filter((r) => !(typeof r.__id === 'string' && ids.has(r.__id)))
      ev.invalidate()
    },
    patch(coll, base, changes) {
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
      ev.invalidate()
      return stored
    },
    navigate(screenName) {
      const s = ev.screensByName.get(screenName)
      if (!s) {
        toasts.push({ id: uid(), message: `Navigate: screen "${screenName}" not found`, kind: 'error' })
        return
      }
      if (nav[nav.length - 1] !== s.id) nav = [...nav, s.id]
    },
    back() {
      if (nav.length > 1) nav = nav.slice(0, -1)
    },
    notify(message, kind) {
      toasts.push({ id: uid(), message, kind })
    },
    reset(controlName) {
      const info = ev.byName.get(controlName)
      if (info) resetIds.push(info.node.id)
    },
  }

  try {
    const r = fx.evaluate(formula, ev.scopeFor(node, ctx), host)
    if (!r.ok) toasts.push({ id: uid(), message: `${label}: ${r.error.message}`, kind: 'error' })
  } catch (e) {
    toasts.push({ id: uid(), message: `${label}: ${e instanceof Error ? e.message : String(e)}`, kind: 'error' })
  }
  return { vars: view.vars, context: view.context, collections: view.collections, navStack: nav, toasts, resetIds }
}
