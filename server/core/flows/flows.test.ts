/**
 * Unit tests of the flow runtime without a database: validation, expression scopes, container paths, retry policy and
 * error classification, values (stored form, JSON, redaction), schedules in time zones.
 */
import { describe, expect, it } from 'vitest'
import type { TableDef } from '../../../src/platform/contracts.ts'
import { DEFAULT_SETTINGS, STEP_KINDS, TRIGGER_TYPES, allSteps, type FlowDefinition } from '../../../src/platform/flows.ts'
import { HttpError } from '../contracts.ts'
import { nextCron, parseCron } from '../cron.ts'
import { checkExpression, evaluate, flowEngine, flowScope } from './expr.ts'
import { validateFlow, type ValidationContext } from './validate.ts'
import { classify, iterationPaths, resolveContainer, retryDelayMs } from './engine.ts'
import { forDisplay, fromStored, fxToJson, jsonToFx, redact, toStored } from './values.ts'
import { newLimits } from '../event-fx.ts'

const col = (name: string, type: string) => ({ name, displayName: name, type }) as TableDef['columns'][number]
const orders: TableDef = { id: 'tbl_o', name: 'Orders', displayName: 'Orders', columns: [col('Ref', 'text'), col('Amount', 'number'), col('Status', 'text')], primaryColumn: 'Ref', createdOn: '', modifiedOn: '' } as unknown as TableDef
const engine = flowEngine({ now: () => new Date('2030-01-01T00:00:00Z') })
const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({ tables: [orders], flows: [], selfId: null, selfName: 'T', connections: new Map(), engine, ...over })
const flow = (steps: FlowDefinition['steps'], o: Partial<FlowDefinition> & { runAs?: unknown } = {}) => ({ name: 'T', settings: DEFAULT_SETTINGS, trigger: { type: 'manual', inputs: [{ name: 'N', type: 'number' }], from: 'any' }, steps, ...o }) as never

describe('flow validation', () => {
  it('a valid flow has no problems', async () => {
    const p = await validateFlow(flow([
      { id: 'a', name: 'A', kind: 'compose', value: 'Trigger.Inputs.N * 2' },
      { id: 'l', name: 'L', kind: 'data.list', table: 'Orders', filter: 'Amount > Steps.A.Output', top: 10 },
      { id: 'f', name: 'F', kind: 'forEach', items: 'Steps.L.Output', as: 'Row', steps: [{ id: 'g', name: 'G', kind: 'compose', value: 'Row.Ref & ThisItem.Status' }] },
      { id: 'c', name: 'C', kind: 'compose', value: 'CountRows(Filter(Orders, Status = "Open"))' },
    ]), ctx())
    expect(p.filter((x) => x.severity === 'error')).toEqual([])
  })
  it('names every problem with step id and field', async () => {
    const p = await validateFlow(flow([
      { id: 'a', name: 'A', kind: 'compose', value: 'Row.Ref' },
      { id: 'b', name: 'A', kind: 'compose', value: '1' },
      { id: 'c', name: 'C', kind: 'data.update', table: 'Nope', rowId: '1', values: {} },
      { id: 'd', name: 'D', kind: 'delay' },
      { id: 'e', name: 'E', kind: 'until', condition: 'true', maxIterations: 0, steps: [] },
      { id: 'x', name: 'X', kind: 'compose', value: '1', runAfter: [{ step: 'x', when: ['succeeded'] }] },
    ] as never), ctx())
    const at = (step: string, field: string) => p.find((x) => x.step === step && x.field === field)
    expect(at('a', 'value')?.message).toMatch(/isn't recognised: Row/)
    expect(at('b', 'name')?.message).toMatch(/used twice/)
    expect(at('c', 'table')?.message).toMatch(/no table "Nope"/)
    expect(at('d', 'minutes')?.message).toMatch(/either minutes or until/)
    expect(at('e', 'maxIterations')).toBeTruthy()
    expect(at('x', 'runAfter')?.message).toMatch(/same place/)
  })
  it('checks trigger settings: schedule cron and time zone, runAs and perRecord', async () => {
    const p = await validateFlow(flow([], { trigger: { type: 'schedule', cron: '61 * * * *', timeZone: 'Mars/Base' }, runAs: 'triggeringUser', settings: { ...DEFAULT_SETTINGS, concurrency: 'perRecord' } }), ctx())
    expect(p.map((x) => x.field).sort()).toEqual(['cron', 'runAs', 'settings.concurrency', 'timeZone'])
  })
  it('refuses callFlow recursion through other flows', async () => {
    const c = ctx({ flows: [{ id: 'f_b', name: 'B', trigger: { type: 'manual', inputs: [], from: 'any' }, calls: ['f_a'] }], selfId: 'f_a', selfName: 'A' })
    const p = await validateFlow(flow([{ id: 'call', name: 'Call', kind: 'callFlow', flow: 'B' }], { name: 'A' } as never), c)
    expect(p.find((x) => x.step === 'call')?.message).toMatch(/makes a loop: A -> B -> A/)
  })
  it('loop items are only visible inside the loop; inner steps of loops are not visible after it', async () => {
    const p = await validateFlow(flow([
      { id: 'f', name: 'F', kind: 'forEach', items: 'Sequence(3)', as: 'X', steps: [{ id: 'in', name: 'In', kind: 'compose', value: 'X.Value' }] },
      { id: 'after', name: 'After', kind: 'compose', value: 'Steps.In.Output' },
    ]), ctx())
    expect(p.find((x) => x.step === 'after')?.message).toMatch(/no step "In"/)
  })
})

describe('expressions', () => {
  const scope = flowScope({ trigger: { Inputs: { N: 4 } }, steps: { A: { Output: { Total: 10 }, Status: 'succeeded' } }, variables: { V: 'x' }, flow: { RunId: 'run_1' }, user: { Email: 'a@b' }, loops: [{ as: 'Outer', item: { K: 1 } }, { as: 'Inner', item: { K: 2 } }] }, new Set(['Orders']))
  const env = { tables: [orders], identity: null, data: null as never, limits: newLimits(1000), engine }
  it('see Trigger, Steps, Variables, Flow, User(), loop items and ThisItem (innermost)', async () => {
    expect(await evaluate('Trigger.Inputs.N + Steps.A.Output.Total', scope, env)).toEqual({ ok: true, value: 14 })
    expect(await evaluate('Variables.V & Flow.RunId & User().Email', scope, env)).toEqual({ ok: true, value: 'xrun_1a@b' })
    expect(await evaluate('Outer.K * 10 + Inner.K + ThisItem.K', scope, env)).toEqual({ ok: true, value: 14 })
    expect(await evaluate('Year(Now())', scope, env)).toEqual({ ok: true, value: 2030 })
  })
  it('save-time checks refuse actions and whole-table reads', () => {
    expect(checkExpression('Patch(Orders, Defaults(Orders), {Ref: "x"})', scope, [orders], engine)[0].message).toMatch(/is an action/)
    expect(checkExpression('Orders', scope, [orders], engine)[0].message).toMatch(/read as a whole/)
    expect(checkExpression('First(Filter(Orders, Amount > Trigger.Inputs.N)).Ref', scope, [orders], engine)).toEqual([])
  })
})

describe('engine paths, retries and errors', () => {
  const doc = { name: 'T', runAs: 'owner' as const, settings: DEFAULT_SETTINGS, trigger: { type: 'manual' as const, inputs: [], from: 'any' as const }, steps: [
    { id: 'c', name: 'C', kind: 'condition' as const, if: 'true', then: [{ id: 'f', name: 'F', kind: 'forEach' as const, items: '[]', as: 'X', steps: [{ id: 'x', name: 'X1', kind: 'compose' as const, value: '1' }] }] },
  ] }
  it('resolves container paths', () => {
    expect(resolveContainer(doc, '')!.list.map((s) => s.id)).toEqual(['c'])
    expect(resolveContainer(doc, '/c.then')!.list.map((s) => s.id)).toEqual(['f'])
    const it3 = resolveContainer(doc, '/c.then/f#3')!
    expect(it3).toMatchObject({ index: 3, ownerKey: '/c.then/f', parentScope: '/c.then' })
    expect(resolveContainer(doc, '/nope')).toBeNull()
    expect(iterationPaths('/a#1/b.then/c#2/d')).toEqual(['/a#1', '/a#1/b.then/c#2'])
  })
  it('retry delays and error classes', () => {
    expect(retryDelayMs({ type: 'exponential', count: 4, intervalSeconds: 5, maxIntervalSeconds: 30 }, 3)).toBe(20_000)
    expect(retryDelayMs({ type: 'exponential', count: 4, intervalSeconds: 5, maxIntervalSeconds: 30 }, 6)).toBe(30_000)
    expect(retryDelayMs({ type: 'fixed', count: 4, intervalSeconds: 7, maxIntervalSeconds: 30 }, 3)).toBe(7_000)
    expect(classify(new HttpError(403, 'denied', 'no')).permanent).toBe(true)
    expect(classify(new HttpError(429, 'rate_limited', 'later')).permanent).toBe(false)
    expect(classify(Object.assign(new Error('deadlock'), { code: '40P01' })).permanent).toBe(false)
    expect(classify(Object.assign(new Error('bad'), { code: '23505' })).permanent).toBe(true)
    expect(classify(new Error('socket hang up')).permanent).toBe(false)
  })
})

describe('values', () => {
  it('stored form keeps dates; JSON form lists single-column tables', () => {
    const v = { When: new Date('2030-01-02T03:04:05Z'), List: [{ Value: 1 }, { Value: 2 }], Rec: { a: 'x', __id: 'r1' } }
    const back = fromStored(JSON.parse(JSON.stringify(toStored(v)))) as Record<string, unknown>
    expect(back.When).toBeInstanceOf(Date)
    expect(fxToJson(v)).toEqual({ When: '2030-01-02T03:04:05.000Z', List: [1, 2], Rec: { a: 'x' } })
    expect(jsonToFx({ a: [1, { b: 2 }] })).toEqual({ a: [{ Value: 1 }, { b: 2 }] })
  })
  it('redacts secrets and caps what is shown', () => {
    expect(redact({ headers: { Authorization: 'Bearer x', 'X-Api-Key': 'k', Accept: 'a' }, password: 'p' })).toEqual({ headers: { Authorization: '[redacted]', 'X-Api-Key': '[redacted]', Accept: 'a' }, password: '[redacted]' })
    const big = forDisplay({ s: 'x'.repeat(70_000) })
    expect(big.truncated).toBe(true)
  })
})

describe('schedules in time zones (the cron library the schedule trigger uses)', () => {
  it('08:30 in Kolkata is 03:00 UTC', () => {
    expect(nextCron(parseCron('30 8 * * 1-5'), new Date('2030-03-04T00:00:00Z'), 'Asia/Kolkata')!.toISOString()).toBe('2030-03-04T03:00:00.000Z')
  })
})

describe('catalogue', () => {
  it('documents every step kind and trigger type once', () => {
    expect(new Set(STEP_KINDS.map((k) => k.kind)).size).toBe(STEP_KINDS.length)
    expect(TRIGGER_TYPES.map((t) => t.type)).toEqual(['table', 'schedule', 'manual', 'webhook', 'approvalDecided', 'formSubmitted'])
    for (const k of STEP_KINDS) expect(allSteps([k.example as never]).length, k.kind).toBe(1)
  })
})
