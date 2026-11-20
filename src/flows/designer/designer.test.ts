import { describe, expect, it } from 'vitest'
import { STEP_KINDS, type Step } from '@/platform/flows'
import type { TableDef } from '@/platform/contracts'
import {
  cloneSteps, duplicateSteps, findStep, fromTree, insertSteps, moveSteps, newStep, order, removeSteps, renameLoopItem, renameStep, renameVariable,
  searchSteps, toTree, TOP, updateStep, visibleStepNames, type FlowDoc,
} from './model'
import { renameStepRef, stepFx, stepRefsOf } from './refs'
import { compileFilter, lookupFx, parseFilter, parseLookup, type FilterGroup } from './filter'
import { dynamicContent, insertToken, sampleTokens, schemaTokens } from './dynamic'
import { layoutFlow } from './layout'

const col = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, displayName: name, type, ...extra })
const TABLES = [
  { id: 't1', name: 'PurchaseRequests', displayName: 'Purchase requests', primaryColumn: 'Title', columns: [col('Title', 'text'), col('Amount', 'number'), col('Due', 'date'), col('Customer', 'lookup', { lookupTable: 'Customers' }), col('Status', 'choice', { choices: ['New', 'Approved'] })] },
  { id: 't2', name: 'Customers', displayName: 'Customers', primaryColumn: 'Name', columns: [col('Name', 'text'), col('Email', 'email')] },
] as unknown as TableDef[]

/** a definition with every step kind (each with an unknown future field), containers nested */
function everyKind(): FlowDoc {
  const leaf = STEP_KINDS.filter((k) => !k.container).map((k, i) => ({ ...structuredClone(k.example), id: `l${i}`, name: `Leaf${i}`, futureOption: { level: i, list: [1, 2] } }) as unknown as Step)
  const cont = (kind: string, id: string, extra: Record<string, unknown>) => ({ id, name: `C_${id}`, kind, futureFlag: true, ...extra }) as unknown as Step
  return {
    name: 'All', runAs: 'owner', description: 'd', 'x-designer': { zoom: 1 },
    trigger: { type: 'table', table: 'PurchaseRequests', on: ['create', 'update'], futureTrigger: 'x' } as never,
    variables: [{ name: 'Total', type: 'number', initial: 0 }],
    settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
    steps: [
      cont('condition', 'c1', { if: 'true', then: [leaf[0], cont('scope', 's1', { steps: [leaf[1], leaf[2]] })], else: [leaf[3]] }),
      cont('switch', 'w1', { on: '1', cases: [{ value: 1, steps: [leaf[4]], caseNote: 'n' }, { value: 2, steps: [] }], default: [leaf[5]] }),
      cont('forEach', 'f1', { items: '[1,2]', as: 'Line', concurrency: 2, steps: [cont('until', 'u1', { condition: 'true', maxIterations: 3, steps: [leaf[6]] })] }),
      ...leaf.slice(7),
    ],
  }
}

describe('designer model: definition <-> canvas tree', () => {
  it('round trips every step kind without loss, unknown fields included', () => {
    const doc = everyKind()
    const back = fromTree(toTree(doc))
    expect(back).toEqual(doc)
    expect(JSON.stringify(back)).toBe(JSON.stringify(doc))
    // the tree's nodes hold no child lists (the lanes do) but keep every other field
    const t = toTree(doc)
    const c1 = t.root.items[0]
    expect((c1.step as never as { then: unknown[] }).then).toEqual([])
    expect((c1.step as never as { futureFlag: boolean }).futureFlag).toBe(true)
    expect(c1.lanes.map((l) => l.slot.list)).toEqual(['then', 'else'])
    expect(t.root.items[1].lanes.map((l) => l.slot.list)).toEqual(['case:0', 'case:1', 'default'])
  })

  it('edits copy only what they change and keep unknown fields', () => {
    const doc = everyKind()
    const s = newStep(doc, 'compose', 'compose')
    const d1 = insertSteps(doc, { parent: 's1', list: 'steps' }, 1, [s])
    expect(findStep(d1.steps, s.id)!.slot).toEqual({ parent: 's1', list: 'steps' })
    expect(d1.steps[1]).toBe(doc.steps[1]) // untouched branch is the same object
    expect((d1 as Record<string, unknown>)['x-designer']).toEqual({ zoom: 1 })
    const d2 = removeSteps(d1, [s.id])
    expect(d2).toEqual(doc)
    const d3 = updateStep(doc, 'l0', (x) => ({ ...x, description: 'a note' }))
    expect((findStep(d3.steps, 'l0')!.step as never as { futureOption: unknown }).futureOption).toEqual({ level: 0, list: [1, 2] })
    // a switch case that receives a step keeps its own extra fields
    const d4 = insertSteps(doc, { parent: 'w1', list: 'case:1' }, 0, [newStep(doc, 'compose', 'x')])
    const sw = findStep(d4.steps, 'w1')!.step as never as { cases: { caseNote?: string; steps: Step[] }[] }
    expect(sw.cases[0].caseNote).toBe('n')
    expect(sw.cases[1].steps).toHaveLength(1)
  })

  it('moves steps between containers, refuses a container into itself, fixes runAfter', () => {
    const doc: FlowDoc = {
      name: 'M', runAs: 'owner', trigger: { type: 'manual', inputs: [], from: 'any' }, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
      steps: [
        { id: 'a', name: 'A', kind: 'compose', value: '1' },
        { id: 'try', name: 'Try', kind: 'scope', steps: [{ id: 'b', name: 'B', kind: 'compose', value: 'Steps.A.Output' }] },
        { id: 'c', name: 'C', kind: 'compose', value: 'Steps.B.Output', runAfter: [{ step: 'try', when: ['failed'] }] },
      ] as Step[],
    }
    expect(moveSteps(doc, ['try'], { parent: 'try', list: 'steps' }, 0)).toBeNull()
    const m = moveSteps(doc, ['c'], { parent: 'try', list: 'steps' }, 1)!
    expect(findStep(m.doc.steps, 'c')!.slot.parent).toBe('try')
    expect(findStep(m.doc.steps, 'c')!.step.runAfter).toBeUndefined()
    expect(m.notes.join(' ')).toMatch(/no longer runs after Try/)
    // moving B out to the top, before A: B can no longer see A
    const m2 = moveSteps(doc, ['b'], TOP, 0)!
    expect(order(m2.doc)).toEqual(['b', 'a', 'try', 'c'])
    expect(m2.notes.join(' ')).toMatch(/uses Steps.A/)
    // the index counts the target list before removal: move A after Try at the top
    const m3 = moveSteps(doc, ['a'], TOP, 2)!
    expect(m3.doc.steps.map((s) => s.id)).toEqual(['try', 'a', 'c'])
  })

  it('visible steps follow the runtime rule (siblings before, inside them, not inside loops)', () => {
    const doc = everyKind()
    const v = visibleStepNames(doc, 'l1')
    expect([...v].sort()).toEqual(['Leaf0'])
    const v2 = visibleStepNames(doc, 'l7')
    expect(v2.has('C_c1') && v2.has('Leaf3') && v2.has('Leaf2') && v2.has('C_f1')).toBe(true)
    expect(v2.has('Leaf6')).toBe(false) // inside a loop
  })

  it('copy/paste and duplicate give fresh ids and names and rewrite references inside the copy', () => {
    const doc: FlowDoc = {
      name: 'P', runAs: 'owner', trigger: { type: 'manual', inputs: [], from: 'any' }, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
      steps: [
        { id: 'x', name: 'X', kind: 'compose', value: '1' },
        { id: 'grp', name: 'Grp', kind: 'scope', steps: [{ id: 'a', name: 'A', kind: 'compose', value: 'Steps.X.Output + 1' }, { id: 'b', name: 'B', kind: 'compose', value: 'Steps.A.Output * 2', runAfter: [{ step: 'a', when: ['succeeded', 'failed'] }] }] },
      ] as Step[],
    }
    const { doc: d, added } = duplicateSteps(doc, ['grp'])
    expect(added).toHaveLength(1)
    const copy = findStep(d.steps, added[0])!.step as Step & { steps: Step[] }
    expect(copy.name).toBe('Grp_2')
    expect(copy.steps.map((s) => s.name)).toEqual(['A_2', 'B_2'])
    expect((copy.steps[1] as Step & { value: string }).value).toBe('Steps.A_2.Output * 2')
    expect((copy.steps[0] as Step & { value: string }).value).toBe('Steps.X.Output + 1') // outside the copy: unchanged
    expect(copy.steps[1].runAfter).toEqual([{ step: copy.steps[0].id, when: ['succeeded', 'failed'] }])
    // across flows: a copy pasted into another flow keeps names that are free there
    const other: FlowDoc = { ...doc, steps: [] }
    expect(cloneSteps(other, [doc.steps[0]])[0]).toMatchObject({ id: 'x', name: 'X' })
  })
})

describe('reference rename', () => {
  it('renames Steps.<name> only where it is a step reference', () => {
    expect(renameStepRef('Steps.Mgr.Output.Outcome = "Steps.Mgr" && Mgr.Output', 'Mgr', 'Manager')).toBe('Steps.Manager.Output.Outcome = "Steps.Mgr" && Mgr.Output')
    expect(renameStepRef('=If(Steps.Mgr.Status = "timedOut", LookUp(T, id = Steps.Mgr.Output.Id).Name, "")', 'Mgr', 'M2')).toBe('=If(Steps.M2.Status = "timedOut", LookUp(T, id = Steps.M2.Output.Id).Name, "")')
    expect(renameStepRef('Steps.Mgra.Output', 'Mgr', 'X')).toBe('Steps.Mgra.Output')
    expect(renameStepRef('not a formula ((', 'Mgr', 'X')).toBe('not a formula ((')
    expect(stepRefsOf('Steps.A.Output & Steps.B.Status & Steps.A.Error')).toEqual(['A', 'B'])
  })

  it('a step rename updates every formula of the flow, incl. nested ones and record fields', () => {
    const doc = {
      name: 'R', runAs: 'owner', trigger: { type: 'manual', inputs: [], from: 'any' }, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
      steps: [
        { id: 'mgr', name: 'Mgr', kind: 'approval', title: '"t"', approvers: '"a@b.c"', regarding: { table: 'T', rowId: 'Steps.Mgr.Output.ApprovalId' } },
        { id: 'dec', name: 'Decide', kind: 'condition', if: 'Steps.Mgr.Output.Outcome = "Approve"', then: [{ id: 'up', name: 'Up', kind: 'data.update', table: 'T', rowId: 'Trigger.Record', values: { Note: 'Steps.Mgr.Output.Comments' } }], else: [] },
      ],
    } as unknown as FlowDoc
    const r = renameStep(doc, 'mgr', 'Manager')
    expect(r.error).toBeUndefined()
    const all = JSON.stringify(r.doc)
    expect(all).not.toMatch(/Steps\.Mgr\b/)
    expect(all.match(/Steps\.Manager/g)).toHaveLength(3)
    expect(renameStep(doc, 'mgr', 'Decide').error).toMatch(/already called/)
    expect(renameStep(doc, 'mgr', '2bad').error).toMatch(/letters/)
    expect(stepFx(r.doc.steps[0]).map((f) => f.field)).toEqual(['title', 'approvers', 'regarding.rowId'])
  })

  it('renames variables and loop items', () => {
    const doc = {
      name: 'V', runAs: 'owner', trigger: { type: 'manual', inputs: [], from: 'any' }, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
      variables: [{ name: 'Total', type: 'number' }],
      steps: [{ id: 'each', name: 'Each', kind: 'forEach', items: '[1,2]', as: 'Line', steps: [{ id: 'sv', name: 'Add', kind: 'setVariable', variable: 'Total', value: 'Variables.Total + Line.Value + ThisItem.Value' }] }],
    } as unknown as FlowDoc
    const d = renameLoopItem(renameVariable(doc, 'Total', 'Sum'), 'each', 'Row')
    const sv = findStep(d.steps, 'sv')!.step as Step & { variable: string; value: string }
    expect(sv.variable).toBe('Sum')
    expect(sv.value).toBe('Variables.Sum + Row.Value + ThisItem.Value')
    expect(d.variables).toEqual([{ name: 'Sum', type: 'number' }])
  })
})

describe('filter builder', () => {
  const cols = ['Status', 'Amount', 'Title', 'Due']
  it('compiles rules and groups to a delegable formula', () => {
    const g: FilterGroup = { join: 'and', rules: [
      { column: 'Status', op: 'eq', value: '"Open"' },
      { column: 'Amount', op: 'gt', value: 'Trigger.Record.Amount * 2' },
      { join: 'or', rules: [{ column: 'Title', op: 'contains', value: '"chair"' }, { column: 'Due', op: 'blank', value: '' }] },
    ] }
    const fx = compileFilter(g)
    expect(fx).toBe('Status = "Open" && Amount > (Trigger.Record.Amount * 2) && ("chair" in Title || IsBlank(Due))')
    expect(parseFilter(fx, cols)).toEqual({ join: 'and', rules: [
      { column: 'Status', op: 'eq', value: '"Open"' }, { column: 'Amount', op: 'gt', value: 'Trigger.Record.Amount * 2' },
      { join: 'or', rules: [{ column: 'Title', op: 'contains', value: '"chair"' }, { column: 'Due', op: 'blank', value: '' }] },
    ] })
    expect(compileFilter({ join: 'or', rules: [{ column: 'Title', op: 'startsWith', value: '"A"' }, { column: 'Due', op: 'notBlank', value: '' }] })).toBe('StartsWith(Title, "A") || !IsBlank(Due)')
    expect(compileFilter({ join: 'and', rules: [] })).toBe('')
  })
  it('falls back to the formula editor for other shapes, and handles LookUp for Get a row', () => {
    expect(parseFilter('CountRows(Filter(X, a = 1)) > 2', cols)).toBeNull()
    expect(parseFilter('Nope = 1', cols)).toBeNull()
    expect(parseFilter('', cols)).toEqual({ join: 'and', rules: [] })
    const fx = lookupFx('Customers', { join: 'and', rules: [{ column: 'Email', op: 'eq', value: 'Trigger.Record.Email' }] })
    expect(fx).toBe('LookUp(Customers, Email = Trigger.Record.Email)')
    expect(parseLookup(fx, 'Customers', ['Email'])).toEqual({ join: 'and', rules: [{ column: 'Email', op: 'eq', value: 'Trigger.Record.Email' }] })
    expect(parseLookup('Trigger.Record.Customer', 'Customers', ['Email'])).toBeNull()
  })
})

describe('dynamic content typing', () => {
  const doc = {
    name: 'D', runAs: 'owner', settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
    trigger: { type: 'table', table: 'PurchaseRequests', on: ['update'] },
    variables: [{ name: 'Total', type: 'number' }],
    steps: [
      { id: 'lst', name: 'Open', kind: 'data.list', table: 'PurchaseRequests' },
      { id: 'api', name: 'Api', kind: 'http', method: 'GET', url: '"x"', auth: 'a', sample: { data: { id: 5, tags: ['a'] }, ok: true } },
      { id: 'act', name: 'Erp', kind: 'action', connection: 'erp', action: 'createOrder', inputs: {} },
      { id: 'each', name: 'Each', kind: 'forEach', items: 'Steps.Open.Output', as: 'Req', steps: [{ id: 'in', name: 'Inner', kind: 'compose', value: '' }] },
      { id: 'after', name: 'After', kind: 'compose', value: '' },
    ],
  } as unknown as FlowDoc
  const ctx = { tables: TABLES, actionOutput: (ref: string, a: string) => (ref === 'erp' && a === 'createOrder' ? { type: 'object', properties: { orderNo: { type: 'string' }, total: { type: 'number' }, lines: { type: 'array' } } } : null) }

  it('types trigger fields (columns, lookups one hop, Old for updates)', () => {
    const t = dynamicContent(doc, 'after', ctx)
    const by = (ins: string) => t.find((x) => x.insert === ins)
    expect(by('Trigger.Record.Amount')?.type).toBe('number')
    expect(by('Trigger.Record.Due')?.type).toBe('date')
    expect(by('LookUp(Customers, id = Trigger.Record.Customer).Email')?.label).toBe('Customer → Email')
    expect(by('Trigger.Old.Status')?.group).toBe('Trigger (before the change)')
    expect(by('Variables.Total')?.type).toBe('number')
    expect(by('CountRows(Steps.Open.Output)')?.type).toBe('number')
    expect(by('First(Steps.Open.Output).Title')?.type).toBe('text')
    expect(by('Steps.Api.Output.Body.data.id')?.type).toBe('number')
    expect(by('Steps.Erp.Output.total')?.type).toBe('number')
    expect(by('Steps.Erp.Output.lines')?.type).toBe('table')
    expect(t.some((x) => x.insert.startsWith('Steps.Inner'))).toBe(false) // inside a loop
    expect(t.some((x) => x.insert === 'Req.Amount')).toBe(false) // not inside the loop
  })
  it('inside a loop: the item typed from the list it walks, and ThisItem', () => {
    const t = dynamicContent(doc, 'in', ctx)
    expect(t.find((x) => x.insert === 'Req.Amount')?.type).toBe('number')
    expect(t.some((x) => x.insert === 'ThisItem')).toBe(true)
    expect(t.some((x) => x.insert.startsWith('Steps.After'))).toBe(false)
  })
  it('the trigger condition sees only the record; samples and schemas flatten', () => {
    expect(dynamicContent(doc, 'trigger', ctx).every((x) => /^(Trigger\.(Record|Old)|LookUp)/.test(x.insert))).toBe(true)
    expect(sampleTokens('g', 'B', [{ a: 1 }]).map((x) => x.insert)).toEqual(['B', 'First(B).a'])
    expect(schemaTokens('g', 'O', { type: 'object', properties: { 'unit price': { type: 'number' } } })[0].insert).toBe("O.'unit price'")
    expect(insertToken('"Hello " & x', 3, 'Trigger.Record.Title')).toEqual({ text: '"He" & Trigger.Record.Title & "llo " & x', caret: 31 })
  })
})

describe('layout', () => {
  it('places every card, region, insertion point and run-after connector', () => {
    const doc = everyKind()
    const L = layoutFlow(doc.steps, new Set())
    const ids = order(doc)
    expect(L.cards.map((c) => c.id).sort()).toEqual([...ids].sort())
    expect(L.regions.map((r) => r.id).sort()).toEqual(['c1', 'f1', 's1', 'u1', 'w1'])
    // inserts: one before and after each step of each non-empty list, one in each empty list
    expect(L.inserts.filter((i) => i.empty).map((i) => `${i.slot.parent}:${i.slot.list}`)).toEqual(['w1:case:1'])
    // collapsing hides the inside
    const C = layoutFlow(doc.steps, new Set(['c1']))
    expect(C.cards.find((c) => c.id === 'c1')!.collapsed).toBe(true)
    expect(C.cards.some((c) => c.id === 'l0')).toBe(false)
    // no overlap between cards
    for (const a of L.cards) for (const b of L.cards) if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
  })
  it('draws non-default run-after as labelled connectors', () => {
    const steps = [
      { id: 'mgr', name: 'Mgr', kind: 'approval', title: '""', approvers: '""' },
      { id: 'esc', name: 'Esc', kind: 'compose', value: '1', runAfter: [{ step: 'mgr', when: ['timedOut'] }] },
      { id: 'next', name: 'Next', kind: 'compose', value: '1', runAfter: [{ step: 'esc', when: ['succeeded'] }] },
    ] as Step[]
    const L = layoutFlow(steps, new Set())
    expect(L.runAfter).toHaveLength(1)
    expect(L.runAfter[0]).toMatchObject({ from: 'mgr', to: 'esc', label: 'timed out', failed: true })
  })
  it('search finds by name, kind title and formula text', () => {
    expect(searchSteps(everyKind(), 'c_w1', (k) => k)).toEqual(['w1'])
    expect(searchSteps(everyKind(), 'approved', (k) => k).length).toBeGreaterThan(0)
  })
})

describe('condition builder', () => {
  it('compiles and parses conditions on any value', async () => {
    const { compileCondition, parseCondition } = await import('./filter')
    const g = { join: 'and' as const, rules: [{ column: 'Trigger.Record.Amount', op: 'gt' as const, value: '1000' }, { column: 'Steps.Mgr.Output.Outcome', op: 'eq' as const, value: '"Approve"' }] }
    const fx = compileCondition(g)
    expect(fx).toBe('Trigger.Record.Amount > 1000 && Steps.Mgr.Output.Outcome = "Approve"')
    expect(parseCondition(fx)).toEqual(g)
    expect(parseCondition('Steps.Mgr.Status = "timedOut" || (Steps.Mgr.Output.Outcome = "Approve" && Trigger.Record.Amount > 10000)')).toEqual({ join: 'or', rules: [
      { column: 'Steps.Mgr.Status', op: 'eq', value: '"timedOut"' },
      { join: 'and', rules: [{ column: 'Steps.Mgr.Output.Outcome', op: 'eq', value: '"Approve"' }, { column: 'Trigger.Record.Amount', op: 'gt', value: '10000' }] },
    ] })
    expect(parseCondition('If(a, b, c)')).toBeNull()
  })
})

describe('literal values', () => {
  it('text with dynamic content, numbers, dates, yes/no and choices round trip', async () => {
    const { literalOf, literalFx, textOf } = await import('./literal')
    expect(literalFx('text', 'Hello {Trigger.Record.Title}, "ok"')).toBe('$"Hello {Trigger.Record.Title}, ""ok"""')
    expect(textOf('$"Hello {Trigger.Record.Title}, ""ok"""')).toBe('Hello {Trigger.Record.Title}, "ok"')
    expect(literalFx('text', 'plain')).toBe('"plain"')
    expect(textOf('"a" & Trigger.Record.Title')).toBeNull()
    expect(literalOf('number', '12.5')).toBe('12.5')
    expect(literalOf('number', 'Trigger.Record.Amount')).toBeNull()
    expect(literalFx('date', '2026-03-01')).toBe('Date(2026, 3, 1)')
    expect(literalOf('date', 'Date(2026, 3, 1)')).toBe('2026-03-01')
    expect(literalOf('boolean', 'true')).toBe(true)
    expect(literalFx('choice', 'Open')).toBe('"Open"')
    expect(literalOf('choice', '"Open"')).toBe('Open')
  })
})

describe('version diff, run overlay, RunFlow helper', () => {
  it('diff: added, removed, changed and moved steps by id', async () => {
    const { diffFlows } = await import('./diff')
    const base = { name: 'X', runAs: 'owner', trigger: { type: 'manual', inputs: [], from: 'any' }, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' } } as unknown as FlowDoc
    const from = { ...base, steps: [
      { id: 'a', name: 'A', kind: 'compose', value: '1' },
      { id: 'g', name: 'G', kind: 'scope', steps: [{ id: 'b', name: 'B', kind: 'compose', value: '2' }, { id: 'old', name: 'Old', kind: 'compose', value: '3' }] },
    ] } as FlowDoc
    const to = { ...base, name: 'Y', steps: [
      { id: 'a', name: 'A', kind: 'compose', value: '10' },
      { id: 'b', name: 'B', kind: 'compose', value: '2' },
      { id: 'g', name: 'G', kind: 'scope', steps: [{ id: 'new', name: 'New', kind: 'notify', to: '""', title: '""', body: '""', channels: ['inApp'] }] },
    ] } as FlowDoc
    const d = diffFlows(from, to)
    expect(d.flow).toEqual(['name'])
    expect(d.steps.map((s) => `${s.name}:${s.change}`)).toEqual(['A:changed', 'B:moved', 'G:same', 'Old:removed', 'New:added'])
    expect(d.steps[0].fields).toEqual(['value'])
  })

  it('overlay: step status by id, one iteration of a loop at a time', async () => {
    const { overlayOf, loopIterations } = await import('./overlay')
    const row = (key: string, stepId: string, status: string, kind = 'compose') => ({ key, stepId, name: stepId, kind, scope: '', status, attempt: 1, startedOn: '2030-01-01T00:00:00Z' })
    const run = { steps: [row('/each', 'each', 'succeeded', 'forEach'), row('/each#0', 'each', 'succeeded', 'iteration'), row('/each#0/x', 'x', 'succeeded'), row('/each#1', 'each', 'failed', 'iteration'), row('/each#1/x', 'x', 'failed'), row('/after', 'after', 'skipped')] } as never
    expect(loopIterations(run)).toEqual({ each: [0, 1] })
    expect(overlayOf(run, {}).get('x')?.status).toBe('failed') // the last iteration by default
    expect(overlayOf(run, { each: 0 }).get('x')?.status).toBe('succeeded')
    expect(overlayOf(run, {}).get('each')?.status).toBe('succeeded')
    expect(overlayOf(run, {}).get('after')?.status).toBe('skipped')
  })

  it('RunFlow helper: the call with typed inputs, appended to a behaviour formula', async () => {
    const { runFlowCall, appendCall } = await import('../RunFlowHelper')
    const call = runFlowCall('Quote "big"', { Qty: '2', Note: 'TextInput1.Text', Empty: '' }, { on: true, result: 'Answer' })
    expect(call).toBe('RunFlow("Quote ""big""", {Qty: 2, Note: TextInput1.Text}, {Wait: true, Result: "Answer"})')
    expect(appendCall('=Navigate(Home)', 'RunFlow("A", {})')).toBe('=Navigate(Home); RunFlow("A", {})')
    expect(appendCall('', 'RunFlow("A", {})')).toBe('=RunFlow("A", {})')
    expect(appendCall('=false', 'RunFlow("A", {})')).toBe('=RunFlow("A", {})')
  })
})

describe('P3 step fields: data.create owner, approval requester', () => {
  it('are formulas of their step, so renaming a step rewrites them', () => {
    const mk = { id: 'mk', name: 'MakeTask', kind: 'data.create', table: 'T', values: { A: 'Steps.Who.Output.Id' }, owner: 'Steps.Who.Output.Email' } as unknown as Step
    const ask = { id: 'ask', name: 'Ask', kind: 'approval', title: '"x"', approvers: '"role:Q"', requester: 'Steps.Who.Output.Email' } as unknown as Step
    expect(stepFx(mk).map((f) => f.field)).toEqual(['values.A', 'owner'])
    expect(stepFx(ask).map((f) => f.field)).toContain('requester')
    const doc = { trigger: { type: 'manual', inputs: [] }, steps: [{ id: 'who', name: 'Who', kind: 'compose', value: '1' } as Step, mk, ask] } as never
    const r = renameStep(doc, 'who', 'Person')
    expect(JSON.stringify(r.doc)).toContain('"owner":"Steps.Person.Output.Email"')
    expect(JSON.stringify(r.doc)).toContain('"requester":"Steps.Person.Output.Email"')
  })
})
