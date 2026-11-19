/**
 * Designer commands on the store (used by the canvas, the keyboard and the toolbar): add, delete, move, duplicate, copy
 * and paste steps, rename with reference updates, run after, notes. Each is one undo step.
 */
import type { RunAfterStatus, Step } from '@/platform/flows'
import {
  cloneSteps, duplicateSteps, findStep, insertSteps, isInside, moveSteps, newStep, removeSteps, renameStep, updateStep, walk, type Slot,
} from './model'
import { readClipboard, selectedIds, useDesigner, writeClipboard } from './store'

const st = () => useDesigner.getState()

export function addStep(slot: Slot, index: number, kind: string, title: string, extra: Record<string, unknown> = {}): string | null {
  const s = newStep(st().doc, kind, title, extra)
  const ok = st().edit((x) => ({ ...x, doc: insertSteps(x.doc, slot, index, [s]) }))
  if (!ok) return null
  st().set({ selection: { kind: 'steps', ids: [s.id] }, focus: s.id, picker: null })
  return s.id
}

/** the top-most of the selected ids (a container and something inside it: the container) */
function roots(ids: string[]): string[] {
  const steps = st().doc.steps
  return ids.filter((id) => !ids.some((o) => o !== id && isInside(steps, id, o)))
}

export function deleteSelected(): void {
  const ids = roots(selectedIds(st().selection))
  if (!ids.length) return
  const order: string[] = []
  walk(st().doc.steps, (s) => order.push(s.id))
  const first = order.indexOf(ids[0])
  st().edit((x) => ({ ...x, doc: removeSteps(x.doc, ids) }))
  const left: string[] = []
  walk(st().doc.steps, (s) => left.push(s.id))
  const next = left[Math.min(Math.max(0, first - 1), left.length - 1)]
  st().set({ selection: next ? { kind: 'steps', ids: [next] } : null, focus: next ?? 'trigger' })
}

export function duplicateSelected(): void {
  const ids = roots(selectedIds(st().selection))
  if (!ids.length) return
  let added: string[] = []
  st().edit((x) => {
    const r = duplicateSteps(x.doc, ids)
    added = r.added
    return { ...x, doc: r.doc }
  })
  if (added.length) st().set({ selection: { kind: 'steps', ids: added }, focus: added[0] })
}

export function copySelected(): number {
  const ids = roots(selectedIds(st().selection))
  const steps = ids.map((id) => findStep(st().doc.steps, id)?.step).filter(Boolean) as Step[]
  if (steps.length) writeClipboard(steps)
  return steps.length
}

/** pastes after the focused/selected step (or at the end) */
export function paste(at?: { slot: Slot; index: number }): number {
  const clip = readClipboard() as Step[] | null
  if (!clip?.length) return 0
  const sel = selectedIds(st().selection)
  let target = at
  if (!target) {
    const f = sel.length ? findStep(st().doc.steps, sel[sel.length - 1]) : null
    target = f ? { slot: f.slot, index: f.index + 1 } : { slot: { parent: '', list: 'steps' }, index: st().doc.steps.length }
  }
  const copies = cloneSteps(st().doc, clip)
  st().edit((x) => ({ ...x, doc: insertSteps(x.doc, target!.slot, target!.index, copies) }))
  st().set({ selection: { kind: 'steps', ids: copies.map((c) => c.id) }, focus: copies[0].id })
  return copies.length
}

export function move(ids: string[], slot: Slot, index: number): { ok: boolean; notes: string[] } {
  const r = moveSteps(st().doc, roots(ids), slot, index)
  if (!r) return { ok: false, notes: ['A container cannot move into itself.'] }
  st().edit((x) => ({ ...x, doc: r.doc }))
  st().set({ notes: r.notes })
  return { ok: true, notes: r.notes }
}

export function rename(id: string, name: string): string | null {
  const r = renameStep(st().doc, id, name)
  if (r.error) return r.error
  st().edit((x) => ({ ...x, doc: r.doc }))
  return null
}

export function setNote(id: string, note: string): void {
  st().edit((x) => ({
    ...x,
    doc: updateStep(x.doc, id, (s) => {
      const out = { ...s }
      if (note.trim()) out.description = note.trim()
      else delete out.description
      return out
    }),
  }))
}

export function setRunAfter(id: string, entries: { step: string; when: RunAfterStatus[] }[]): void {
  st().edit((x) => ({
    ...x,
    doc: updateStep(x.doc, id, (s) => {
      const out = { ...s }
      const ok = entries.filter((e) => e.when.length)
      if (ok.length) out.runAfter = ok
      else delete out.runAfter
      return out
    }),
  }))
}

/** replaces one step by a function of it (fields of the panel) */
export function patchStep(id: string, fn: (s: Step) => Step, key?: string): void {
  st().edit((x) => ({ ...x, doc: updateStep(x.doc, id, fn) }), key)
}
