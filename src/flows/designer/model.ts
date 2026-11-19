/**
 * The canvas model of the flow designer (P1 package B; docs/dev/flows.md "Designer"). Pure: no React, no DOM.
 *
 * The flow definition (FlowDoc: name, description, runAs, trigger, steps, variables, settings) is the single source of
 * truth. Every edit is a function `(doc) -> doc` that copies only what it changes, so fields this version of the
 * designer does not know (a newer runtime's step options, a package's additions) travel through untouched.
 *
 * Step lists are addressed by a **slot**: the id of the container step that holds the list ('' = the top level) and the
 * list's key: `steps` (for each, do until, scope; and the top level), `then` / `else` (condition), `case:<i>` / `default`
 * (switch). `toTree` / `fromTree` turn a definition into the nested lanes the canvas draws and back without loss.
 */
import type { Step, StepKind, Trigger, FlowDefinition, RunAs, VariableDef } from '@/platform/flows'
import { renameIdentifier } from '@/fx'
import { renameStepRef, renameRootRef, stepFx, mapStepFx, referencedSteps } from './refs'

/** what the designer edits (the version document of a flow) */
export interface FlowDoc extends FlowDefinition {
  name: string
  description?: string
  runAs: RunAs
  [extra: string]: unknown
}

export type ListKey = 'steps' | 'then' | 'else' | 'default' | `case:${number}`
export interface Slot { parent: string; list: ListKey }
export const TOP: Slot = { parent: '', list: 'steps' }

type AnyStep = Step & Record<string, unknown>

export const CONTAINERS: readonly string[] = ['condition', 'switch', 'forEach', 'until', 'scope']
export const isContainerKind = (k: string): boolean => CONTAINERS.includes(k)

/** the child lists of a step with their keys and labels (Yes/No for conditions) */
export function listsOf(s: Step): { key: ListKey; label: string; steps: Step[] }[] {
  const a = s as AnyStep
  switch (s.kind) {
    case 'condition': return [{ key: 'then', label: 'If yes', steps: (a.then as Step[]) ?? [] }, { key: 'else', label: 'If no', steps: (a.else as Step[]) ?? [] }]
    case 'switch': return [
      ...((a.cases as { value: unknown; steps: Step[] }[]) ?? []).map((c, i) => ({ key: `case:${i}` as ListKey, label: `Case ${JSON.stringify(c.value ?? '')}`, steps: c.steps ?? [] })),
      { key: 'default', label: 'Default', steps: (a.default as Step[]) ?? [] },
    ]
    case 'forEach': case 'until': case 'scope': return [{ key: 'steps', label: s.kind === 'scope' ? 'Steps' : 'Repeat', steps: (a.steps as Step[]) ?? [] }]
    default: return []
  }
}

/** a copy of the step with one child list replaced (creates the list when missing) */
function withList(s: Step, key: ListKey, steps: Step[]): Step {
  const a = { ...(s as AnyStep) }
  if (key.startsWith('case:')) {
    const i = Number(key.slice(5))
    const cases = [...((a.cases as { value: unknown; steps: Step[] }[]) ?? [])]
    cases[i] = { ...cases[i], steps }
    a.cases = cases
  } else a[key] = steps
  return a as Step
}

export function getList(steps: Step[], slot: Slot): Step[] | null {
  if (!slot.parent) return steps
  const f = findStep(steps, slot.parent)
  if (!f) return null
  return listsOf(f.step).find((l) => l.key === slot.list)?.steps ?? null
}

export interface Found { step: Step; slot: Slot; index: number; ancestors: string[] }

/** where a step is: its slot, its index there and the ids of its containers (outermost first) */
export function findStep(steps: Step[], id: string, slot: Slot = TOP, ancestors: string[] = []): Found | null {
  for (let i = 0; i < (steps ?? []).length; i++) {
    const s = steps[i]
    if (s.id === id) return { step: s, slot, index: i, ancestors }
    for (const l of listsOf(s)) {
      const r = findStep(l.steps, id, { parent: s.id, list: l.key }, [...ancestors, s.id])
      if (r) return r
    }
  }
  return null
}

/** every step, depth first, with its slot */
export function walk(steps: Step[], fn: (s: Step, slot: Slot, depth: number) => void, slot: Slot = TOP, depth = 0): void {
  for (const s of steps ?? []) {
    fn(s, slot, depth)
    for (const l of listsOf(s)) walk(l.steps, fn, { parent: s.id, list: l.key }, depth + 1)
  }
}

export function allIds(steps: Step[]): Set<string> {
  const out = new Set<string>()
  walk(steps, (s) => out.add(s.id))
  return out
}
export function allNames(steps: Step[]): Set<string> {
  const out = new Set<string>()
  walk(steps, (s) => out.add(s.name))
  return out
}
export const countSteps = (steps: Step[]): number => allIds(steps).size

/** maps a list in the tree (copy on write) */
function mapList(steps: Step[], slot: Slot, fn: (list: Step[]) => Step[]): Step[] {
  if (!slot.parent) return fn(steps)
  let changed = false
  const out = steps.map((s) => {
    let r = s
    if (s.id === slot.parent) {
      const l = listsOf(s).find((x) => x.key === slot.list)
      if (l || ['then', 'else', 'default', 'steps'].includes(slot.list)) r = withList(s, slot.list, fn(l?.steps ?? []))
    } else {
      for (const l of listsOf(s)) {
        const next = mapList(l.steps, slot, fn)
        if (next !== l.steps) r = withList(r, l.key, next)
      }
    }
    if (r !== s) changed = true
    return r
  })
  return changed ? out : steps
}

/** maps every step (copy on write): fn returns the same object when nothing changes */
export function mapSteps(steps: Step[], fn: (s: Step) => Step): Step[] {
  let changed = false
  const out = (steps ?? []).map((s0) => {
    let s = fn(s0)
    for (const l of listsOf(s)) {
      const next = mapSteps(l.steps, fn)
      if (next !== l.steps) s = withList(s, l.key, next)
    }
    if (s !== s0) changed = true
    return s
  })
  return changed ? out : steps
}

/* ------------------------------------------------------------------ names and ids */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
export const isIdentifier = (s: string): boolean => IDENT.test(s)

/** a name a formula can use: letters, digits and _ (spaces and other characters become _) */
export function toIdentifier(s: string): string {
  const t = s.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!t) return 'Step'
  return /^[0-9]/.test(t) ? `S_${t}` : t
}

export function uniqueName(doc: { steps: Step[]; variables?: VariableDef[] }, base: string, taken: Set<string> = new Set()): string {
  const used = new Set([...allNames(doc.steps), ...taken].map((x) => x.toLowerCase()))
  const b = toIdentifier(base)
  if (!used.has(b.toLowerCase())) return b
  for (let i = 2; ; i++) if (!used.has(`${b}_${i}`.toLowerCase())) return `${b}_${i}`
}

export function uniqueId(doc: { steps: Step[] }, base: string, taken: Set<string> = new Set()): string {
  const used = new Set([...allIds(doc.steps), ...taken, 'trigger'])
  const b = toIdentifier(base).toLowerCase().slice(0, 24) || 's'
  if (!used.has(b)) return b
  for (let i = 2; ; i++) if (!used.has(`${b}${i}`)) return `${b}${i}`
}

/* ------------------------------------------------------------------ new steps */

const DEFAULTS: Record<string, Record<string, unknown>> = {
  condition: { if: '', then: [], else: [] },
  switch: { on: '', cases: [{ value: '', steps: [] }], default: [] },
  forEach: { items: '', as: 'Item', steps: [] },
  until: { condition: '', steps: [], maxIterations: 10 },
  scope: { steps: [] },
  setVariable: { variable: '', value: '' },
  compose: { value: '' },
  'data.get': { table: '', rowId: '' },
  'data.list': { table: '', top: 100 },
  'data.create': { table: '', values: {} },
  'data.update': { table: '', rowId: '', values: {} },
  'data.delete': { table: '', rowId: '' },
  approval: { title: '', approvers: '', type: 'single' },
  delay: { minutes: 60 },
  notify: { to: '', title: '', body: '""', channels: ['inApp'] },
  email: { to: '', subject: '', body: '' },
  action: { connection: '', action: '', inputs: {} },
  http: { method: 'GET', url: '', auth: '' },
  callFlow: { flow: '', inputs: {} },
  terminate: { status: 'succeeded' },
  respond: { body: '' },
  waitForCallback: { timeoutMinutes: 1440 },
}

/** a step of a kind with its defaults, a fresh id and a free name */
export function newStep(doc: { steps: Step[] }, kind: StepKind | string, title: string, extra: Record<string, unknown> = {}, taken: { ids?: Set<string>; names?: Set<string> } = {}): Step {
  const name = uniqueName(doc, title.replace(/\b\w/g, (c) => c.toUpperCase()), taken.names)
  const id = uniqueId(doc, name, taken.ids)
  return { id, name, kind, ...structuredClone(DEFAULTS[kind] ?? {}), ...extra } as Step
}

/* ------------------------------------------------------------------ edits */

export interface EditResult { doc: FlowDoc; notes: string[] }

export function updateStep(doc: FlowDoc, id: string, fn: (s: Step) => Step): FlowDoc {
  const steps = mapSteps(doc.steps, (s) => (s.id === id ? fn(s) : s))
  return steps === doc.steps ? doc : { ...doc, steps }
}

export function insertSteps(doc: FlowDoc, slot: Slot, index: number, add: Step[]): FlowDoc {
  return { ...doc, steps: mapList(doc.steps, slot, (l) => [...l.slice(0, index), ...add, ...l.slice(index)]) }
}

/** removes steps (and what is inside them); runAfter entries naming them are dropped */
export function removeSteps(doc: FlowDoc, ids: Iterable<string>): FlowDoc {
  const gone = new Set(ids)
  const drop = (list: Step[]): Step[] => list.filter((s) => !gone.has(s.id)).map((s) => {
    let out = s
    for (const l of listsOf(s)) out = withList(out, l.key, drop(l.steps))
    if (s.runAfter?.some((r) => gone.has(r.step))) {
      const ra = s.runAfter.filter((r) => !gone.has(r.step))
      out = { ...out }
      if (ra.length) out.runAfter = ra
      else delete out.runAfter
    }
    return out
  })
  return { ...doc, steps: drop(doc.steps) }
}

/** is `id` (or one of its containers) the step `container`, or inside it? */
export function isInside(steps: Step[], id: string, container: string): boolean {
  if (id === container) return true
  return !!findStep(steps, id)?.ancestors.includes(container)
}

/**
 * Moves steps (in their order of appearance) to a slot. Refused (null) when a container would move into itself.
 * runAfter entries that would no longer name an earlier sibling are dropped (with a note); references to steps that the
 * moved steps can no longer see are reported (validation shows them as problems; nothing is rewritten).
 */
export function moveSteps(doc: FlowDoc, ids: string[], slot: Slot, index: number): EditResult | null {
  if (slot.parent && ids.some((id) => isInside(doc.steps, slot.parent, id))) return null
  const order: string[] = []
  walk(doc.steps, (s) => { if (ids.includes(s.id) && !order.some((o) => isInside(doc.steps, s.id, o))) order.push(s.id) })
  if (!order.length) return { doc, notes: [] }
  const moving = order.map((id) => findStep(doc.steps, id)!.step)
  // the target index counts steps of the target list before removal
  const target = getList(doc.steps, slot) ?? []
  const before = target.slice(0, index).filter((s) => !order.includes(s.id)).length
  let next = { ...doc, steps: doc.steps }
  const gone = new Set(order)
  const strip = (list: Step[]): Step[] => list.filter((s) => !gone.has(s.id)).map((s) => {
    let out = s
    for (const l of listsOf(s)) out = withList(out, l.key, strip(l.steps))
    return out
  })
  next.steps = strip(next.steps)
  next = insertSteps(next, slot, before, moving)
  return fixRunAfter(next, order)
}

/** keeps only runAfter entries that name an earlier sibling; notes what was dropped */
function fixRunAfter(doc: FlowDoc, touched: string[]): EditResult {
  const notes: string[] = []
  const fix = (list: Step[]): Step[] => list.map((s, i) => {
    let out = s
    for (const l of listsOf(s)) out = withList(out, l.key, fix(l.steps))
    if (s.runAfter?.length) {
      const earlier = new Set(list.slice(0, i).map((x) => x.id))
      const ok = s.runAfter.filter((r) => earlier.has(r.step))
      if (ok.length !== s.runAfter.length) {
        notes.push(`"${s.name}" no longer runs after ${s.runAfter.filter((r) => !earlier.has(r.step)).map((r) => nameOf(doc, r.step)).join(', ')}: run after can only name an earlier step of the same list.`)
        out = { ...out }
        if (ok.length) out.runAfter = ok
        else delete out.runAfter
      }
    }
    return out
  })
  const steps = fix(doc.steps)
  const out = { ...doc, steps }
  for (const id of touched) {
    const f = findStep(out.steps, id)
    if (!f) continue
    const vis = visibleStepNames(out, id)
    walk([f.step], (s) => {
      for (const ref of referencedSteps(s)) {
        if (!vis.has(ref) && !isInsideByName(out, ref, f.step.id) && allNames(out.steps).has(ref)) notes.push(`"${s.name}" uses Steps.${ref}, which it cannot see from its new place.`)
      }
    })
  }
  return { doc: out, notes: [...new Set(notes)] }
}

const isInsideByName = (doc: FlowDoc, name: string, container: string): boolean => {
  let id = ''
  walk(doc.steps, (s) => { if (s.name === name) id = s.id })
  return !!id && isInside(doc.steps, id, container)
}

export const nameOf = (doc: { steps: Step[] }, id: string): string => findStep(doc.steps, id)?.step.name ?? id

/**
 * Steps a step may read with Steps.<name> (the runtime's rule): earlier siblings and the steps inside them (not inside
 * loops), and the same for each enclosing container; inside a loop iteration, the steps of that iteration.
 */
export function visibleStepNames(doc: { steps: Step[] }, id: string): Set<string> {
  const out = new Set<string>()
  const addInside = (s: Step) => {
    out.add(s.name)
    if (s.kind === 'forEach' || s.kind === 'until') return
    for (const l of listsOf(s)) for (const c of l.steps) addInside(c)
  }
  const f = findStep(doc.steps, id)
  if (!f) return out
  const chain = [...f.ancestors, id]
  let list = doc.steps
  for (const cid of chain) {
    const idx = list.findIndex((s) => s.id === cid)
    for (const s of list.slice(0, idx)) addInside(s)
    const s = list[idx]
    if (cid === id) break
    // the container itself is visible to what it holds (its Output once it ended is not, but Status is harmless)
    const next = chain[chain.indexOf(cid) + 1]
    const l = listsOf(s).find((x) => x.steps.some((c) => c.id === next))
    list = l?.steps ?? []
  }
  return out
}

/** a slot plus index for "insert after this step" */
export function after(doc: { steps: Step[] }, id: string): { slot: Slot; index: number } | null {
  const f = findStep(doc.steps, id)
  return f ? { slot: f.slot, index: f.index + 1 } : null
}

/* ------------------------------------------------------------------ copy, paste, duplicate */

/**
 * Fresh copies of steps for pasting into `doc`: new ids and names (Name_2 ...), references between the copied steps
 * rewritten (Steps.Old -> Steps.New, runAfter ids). References to steps outside the copy are kept as they are.
 */
export function cloneSteps(doc: { steps: Step[] }, steps: Step[]): Step[] {
  const ids = new Map<string, string>()
  const names = new Map<string, string>()
  const takenIds = new Set<string>()
  const takenNames = new Set<string>()
  const assign = (list: Step[]) => {
    for (const s of list) {
      const name = uniqueName(doc, s.name, takenNames)
      takenNames.add(name)
      const id = uniqueId(doc, s.id, takenIds)
      takenIds.add(id)
      ids.set(s.id, id)
      names.set(s.name, name)
      for (const l of listsOf(s)) assign(l.steps)
    }
  }
  assign(steps)
  const rewrite = (list: Step[]): Step[] => list.map((s0) => {
    let s = { ...structuredClone(s0), id: ids.get(s0.id)!, name: names.get(s0.name)! } as Step
    if (s.runAfter) s.runAfter = s.runAfter.map((r) => ({ ...r, step: ids.get(r.step) ?? r.step }))
    s = mapStepFx(s, (fx) => {
      let out = fx
      for (const [from, to] of names) if (from !== to) out = renameStepRef(out, from, to)
      return out
    }, false)
    for (const l of listsOf(s)) s = withList(s, l.key, rewrite(l.steps))
    return s
  })
  return rewrite(steps)
}

export function duplicateSteps(doc: FlowDoc, ids: string[]): { doc: FlowDoc; added: string[] } {
  const order: string[] = []
  walk(doc.steps, (s) => { if (ids.includes(s.id) && !order.some((o) => isInside(doc.steps, s.id, o))) order.push(s.id) })
  if (!order.length) return { doc, added: [] }
  const last = findStep(doc.steps, order[order.length - 1])!
  const copies = cloneSteps(doc, order.map((id) => findStep(doc.steps, id)!.step))
  return { doc: insertSteps(doc, last.slot, last.index + 1, copies), added: copies.map((c) => c.id) }
}

/* ------------------------------------------------------------------ rename with references */

/** renames a step and every Steps.<old> in the flow's formulas */
export function renameStep(doc: FlowDoc, id: string, newName: string): { doc: FlowDoc; error?: string } {
  const f = findStep(doc.steps, id)
  if (!f) return { doc, error: 'There is no such step.' }
  const name = newName.trim()
  if (!isIdentifier(name)) return { doc, error: 'A step name uses letters, digits and _ and does not start with a digit (formulas read it as Steps.<name>).' }
  if (name === f.step.name) return { doc }
  if ([...allNames(doc.steps)].some((n) => n.toLowerCase() === name.toLowerCase() && n !== f.step.name)) return { doc, error: `Another step is already called ${name}.` }
  const old = f.step.name
  let steps = mapSteps(doc.steps, (s) => mapStepFx(s.id === id ? { ...s, name } : s, (fx) => renameStepRef(fx, old, name), false))
  if (steps === doc.steps) steps = doc.steps
  return { doc: { ...doc, steps } }
}

/** renames a variable (declaration, setVariable targets and Variables.<old> everywhere) */
export function renameVariable(doc: FlowDoc, oldName: string, newName: string): FlowDoc {
  const variables = (doc.variables ?? []).map((v) => (v.name === oldName ? { ...v, name: newName } : v))
  const steps = mapSteps(doc.steps, (s) => {
    let out = s
    if (s.kind === 'setVariable' && (s as AnyStep).variable === oldName) out = { ...s, variable: newName } as Step
    return mapStepFx(out, (fx) => renameRootRef(fx, 'Variables', oldName, newName), false)
  })
  return { ...doc, variables, steps }
}

/** renames the item of a forEach (as) inside its own steps */
export function renameLoopItem(doc: FlowDoc, loopId: string, newAs: string): FlowDoc {
  const f = findStep(doc.steps, loopId)
  if (!f || f.step.kind !== 'forEach') return doc
  const old = (f.step as AnyStep).as as string
  return updateStep(doc, loopId, (s) => {
    const inner = mapSteps(((s as AnyStep).steps as Step[]) ?? [], (c) => mapStepFx(c, (fx) => renameFree(fx, old, newAs), false))
    return { ...s, as: newAs, steps: inner } as Step
  })
}

const renameFree = (fx: string, from: string, to: string): string => {
  if (!fx) return fx
  const s = fx.trim().startsWith('=') ? fx : `=${fx}`
  const out = renameIdentifier(s, from, to)
  return out === s ? fx : fx.trim().startsWith('=') ? out : out.slice(1)
}

/* ------------------------------------------------------------------ the tree the canvas draws */

export interface TreeNode {
  /** the step without its child lists (everything else, known or not, is kept) */
  step: Step
  lanes: TreeLane[]
}
export interface TreeLane { slot: Slot; label: string; items: TreeNode[] }
export interface FlowTree { trigger: Trigger; root: TreeLane; rest: Omit<FlowDoc, 'steps' | 'trigger'>; /** the definition's own key order */ keys: string[] }

const LIST_FIELDS = ['then', 'else', 'default', 'steps']

function nodeOf(s: Step): TreeNode {
  const lists = listsOf(s)
  const bare = { ...(s as AnyStep) }
  if (lists.length) {
    for (const k of LIST_FIELDS) if (k in bare && Array.isArray(bare[k])) bare[k] = []
    if (Array.isArray(bare.cases)) bare.cases = (bare.cases as { value: unknown; steps: Step[] }[]).map((c) => ({ ...c, steps: [] }))
  }
  return { step: bare as Step, lanes: lists.map((l) => ({ slot: { parent: s.id, list: l.key }, label: l.label, items: l.steps.map(nodeOf) })) }
}

export function toTree(doc: FlowDoc): FlowTree {
  const { steps, trigger, ...rest } = doc
  return { trigger, root: { slot: TOP, label: '', items: (steps ?? []).map(nodeOf) }, rest, keys: Object.keys(doc) }
}

function stepOf(n: TreeNode): Step {
  let s = { ...n.step } as Step
  for (const l of n.lanes) s = withList(s, l.slot.list, l.items.map(stepOf))
  return s
}

export function fromTree(t: FlowTree): FlowDoc {
  const all: Record<string, unknown> = { ...t.rest, trigger: t.trigger, steps: t.root.items.map(stepOf) }
  const out: Record<string, unknown> = {}
  for (const k of [...t.keys, ...Object.keys(all)]) if (k in all && !(k in out)) out[k] = all[k]
  return out as FlowDoc
}

/* ------------------------------------------------------------------ search */

/** steps whose name, title, kind or formulas contain the text */
export function searchSteps(doc: { steps: Step[] }, text: string, titleOf: (k: string) => string): string[] {
  const q = text.trim().toLowerCase()
  if (!q) return []
  const out: string[] = []
  walk(doc.steps, (s) => {
    const hay = [s.name, s.description ?? '', s.kind, titleOf(s.kind), ...stepFx(s).map((x) => x.value)].join('\n').toLowerCase()
    if (hay.includes(q)) out.push(s.id)
  })
  return out
}

/** ids in drawing order (keyboard navigation) */
export function order(doc: { steps: Step[] }, collapsed: Set<string> = new Set()): string[] {
  const out: string[] = []
  const v = (list: Step[]) => {
    for (const s of list) {
      out.push(s.id)
      if (!collapsed.has(s.id)) for (const l of listsOf(s)) v(l.steps)
    }
  }
  v(doc.steps)
  return out
}
