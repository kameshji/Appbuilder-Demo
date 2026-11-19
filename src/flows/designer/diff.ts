/**
 * What changed between two versions of a flow (pure): steps added, removed, changed (their own fields, not the steps
 * inside them) or moved, by step id; the trigger, settings, variables, run-as, name. Feeds the visual diff of the
 * version history.
 */
import type { Step } from '@/platform/flows'
import { findStep, listsOf, walk, type FlowDoc } from './model'

export type ChangeKind = 'added' | 'removed' | 'changed' | 'moved' | 'same'
export interface StepChange { id: string; name: string; kind: string; change: ChangeKind; fields: string[]; depth: number }
export interface FlowDiff { steps: StepChange[]; flow: string[] }

const own = (s: Step): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...(s as unknown as Record<string, unknown>) }
  for (const k of ['then', 'else', 'default', 'steps']) delete out[k]
  if (Array.isArray(out.cases)) out.cases = (out.cases as { value: unknown }[]).map((c) => ({ ...c, steps: undefined }))
  return out
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** the merged outline of both versions: every step of `to` in order, removed ones of `from` where they were */
export function diffFlows(from: FlowDoc, to: FlowDoc): FlowDiff {
  const out: StepChange[] = []
  const toIds = new Set<string>()
  walk(to.steps, (s) => toIds.add(s.id))
  const visit = (list: Step[], depth: number, fromList: Step[]) => {
    // removed steps of the old list that are not anywhere in the new version, shown first
    for (const o of fromList) if (!toIds.has(o.id)) { pushRemoved(o, depth) }
    for (const s of list) {
      const f = findStep(from.steps ?? [], s.id)
      if (!f) { pushAll(s, depth, 'added'); continue }
      const fields = Object.keys({ ...own(s), ...own(f.step) }).filter((k) => !same(own(s)[k], own(f.step)[k]))
      const parentNow = findStep(to.steps, s.id)!.slot
      const moved = parentNow.parent !== f.slot.parent || parentNow.list !== f.slot.list
      out.push({ id: s.id, name: s.name, kind: s.kind, change: fields.length ? 'changed' : moved ? 'moved' : 'same', fields, depth })
      const oldLists = listsOf(f.step)
      for (const l of listsOf(s)) visit(l.steps, depth + 1, oldLists.find((x) => x.key === l.key)?.steps ?? [])
    }
  }
  const pushAll = (s: Step, depth: number, change: ChangeKind) => {
    out.push({ id: s.id, name: s.name, kind: s.kind, change, fields: [], depth })
    for (const l of listsOf(s)) for (const c of l.steps) pushAll(c, depth + 1, change)
  }
  const pushRemoved = (s: Step, depth: number) => {
    out.push({ id: s.id, name: s.name, kind: s.kind, change: 'removed', fields: [], depth })
    for (const l of listsOf(s)) for (const c of l.steps) if (!toIds.has(c.id)) pushRemoved(c, depth + 1)
  }
  visit(to.steps ?? [], 0, from.steps ?? [])
  const flow: string[] = []
  for (const k of ['name', 'description', 'runAs', 'trigger', 'variables', 'settings']) if (!same((from as Record<string, unknown>)[k], (to as Record<string, unknown>)[k])) flow.push(k)
  return { steps: out, flow }
}
