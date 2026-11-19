/**
 * Formulas inside steps: which fields of a step kind are formulas (Fx), mapping them, and rewriting references
 * (`Steps.<name>`, `Variables.<name>`) through the formula parser, so a name inside a text literal or a column of the
 * same name is never touched. Pure.
 */
import type { Step } from '@/platform/flows'
import { parse } from '@/fx/parser'
import { freeIdentifiers, childrenOf, type Node } from '@/fx/ast'

type AnyStep = Step & Record<string, unknown>

/** the Fx fields of each step kind; `x.*` is every value of the record x; `a.b` a nested field */
export const FX_FIELDS: Record<string, string[]> = {
  condition: ['if'],
  switch: ['on'],
  forEach: ['items'],
  until: ['condition'],
  setVariable: ['value'],
  compose: ['value'],
  'data.get': ['rowId'],
  'data.list': ['filter'],
  'data.create': ['values.*'],
  'data.update': ['rowId', 'values.*'],
  'data.delete': ['rowId'],
  approval: ['title', 'details', 'approvers', 'regarding.rowId'],
  delay: ['until'],
  notify: ['to', 'title', 'body', 'link'],
  email: ['to', 'cc', 'subject', 'body', 'attachments'],
  action: ['inputs.*'],
  http: ['url', 'body', 'headers.*'],
  callFlow: ['inputs.*'],
  terminate: ['message'],
  respond: ['body'],
}

export interface FxRef { field: string; value: string }

/** the formulas of one step (not of the steps inside it), with the validator's field names (values.Amount ...) */
export function stepFx(s: Step): FxRef[] {
  const a = s as AnyStep
  const out: FxRef[] = []
  for (const f of FX_FIELDS[s.kind] ?? []) {
    const [head, sub] = f.split('.')
    if (sub === '*') {
      const rec = a[head]
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) for (const [k, v] of Object.entries(rec)) if (typeof v === 'string') out.push({ field: `${head}.${k}`, value: v })
    } else if (sub) {
      const rec = a[head] as Record<string, unknown> | undefined
      if (rec && typeof rec[sub] === 'string') out.push({ field: f, value: rec[sub] as string })
    } else if (typeof a[head] === 'string') out.push({ field: head, value: a[head] as string })
  }
  return out
}

/** a copy of the step with fn applied to each formula (same object when nothing changed); deep: also inner steps */
export function mapStepFx(s: Step, fn: (fx: string, field: string) => string, deep = false): Step {
  const a = s as AnyStep
  let out: AnyStep | null = null
  const put = (head: string, v: unknown) => {
    if (!out) out = { ...a }
    out[head] = v
  }
  for (const f of FX_FIELDS[s.kind] ?? []) {
    const [head, sub] = f.split('.')
    if (sub === '*') {
      const rec = a[head]
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
      let changed = false
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rec)) {
        const nv = typeof v === 'string' ? fn(v, `${head}.${k}`) : v
        if (nv !== v) changed = true
        next[k] = nv
      }
      if (changed) put(head, next)
    } else if (sub) {
      const rec = a[head] as Record<string, unknown> | undefined
      if (rec && typeof rec[sub] === 'string') {
        const nv = fn(rec[sub] as string, f)
        if (nv !== rec[sub]) put(head, { ...rec, [sub]: nv })
      }
    } else if (typeof a[head] === 'string') {
      const nv = fn(a[head] as string, head)
      if (nv !== a[head]) put(head, nv)
    }
  }
  let res = (out ?? a) as Step
  if (deep) {
    for (const k of ['then', 'else', 'default', 'steps']) {
      const l = (res as AnyStep)[k]
      if (Array.isArray(l)) {
        const next = l.map((c: Step) => mapStepFx(c, fn, true))
        if (next.some((c, i) => c !== l[i])) res = { ...res, [k]: next } as Step
      }
    }
    const cases = (res as AnyStep).cases as { value: unknown; steps: Step[] }[] | undefined
    if (Array.isArray(cases)) {
      const next = cases.map((c) => {
        const st = (c.steps ?? []).map((x) => mapStepFx(x, fn, true))
        return st.some((x, i) => x !== c.steps[i]) ? { ...c, steps: st } : c
      })
      if (next.some((c, i) => c !== cases[i])) res = { ...res, cases: next } as Step
    }
  }
  return res
}

const withEq = (fx: string): { src: string; shift: number } => {
  const t = fx.trimStart()
  return t.startsWith('=') ? { src: fx, shift: 0 } : { src: `=${fx}`, shift: 1 }
}

/** member nodes `<root>.<name>` where root is a free identifier */
function rootMembers(ast: Node, root: string): { name: string; nameStart: number; nameEnd: number }[] {
  const free = new Set(freeIdentifiers(ast))
  const out: { name: string; nameStart: number; nameEnd: number }[] = []
  const visit = (n: Node) => {
    if (n.t === 'member' && n.obj.t === 'id' && n.obj.name === root && free.has(n.obj)) out.push({ name: n.name, nameStart: n.nameStart, nameEnd: n.nameEnd })
    for (const c of childrenOf(n)) visit(c)
  }
  visit(ast)
  return out
}

/** rewrites `<root>.<from>` to `<root>.<to>` in a formula (same text when nothing matches or it does not parse) */
export function renameRootRef(fx: string, root: string, from: string, to: string): string {
  if (!fx || from === to || !fx.includes(from)) return fx
  const { src, shift } = withEq(fx)
  const p = parse(src)
  if (!p.ast) return fx
  const hits = rootMembers(p.ast, root).filter((m) => m.name === from)
  if (!hits.length) return fx
  let out = src
  for (const h of hits.sort((a, b) => b.nameStart - a.nameStart)) {
    // a quoted name ('My step') spans the quotes
    out = out.slice(0, h.nameStart) + to + out.slice(h.nameEnd)
  }
  return shift ? out.slice(shift) : out
}

export const renameStepRef = (fx: string, from: string, to: string): string => renameRootRef(fx, 'Steps', from, to)

/** names after `Steps.` in a formula */
export function stepRefsOf(fx: string): string[] {
  if (!fx || !fx.includes('Steps')) return []
  const p = parse(withEq(fx).src)
  return p.ast ? [...new Set(rootMembers(p.ast, 'Steps').map((m) => m.name))] : []
}

/** step names the formulas of a step (not its inner steps) use */
export function referencedSteps(s: Step): string[] {
  return [...new Set(stepFx(s).flatMap((r) => stepRefsOf(r.value)))]
}
