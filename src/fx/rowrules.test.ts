import { describe, expect, it } from 'vitest'
import { createEngine } from './engine.ts'
import { REJECT, SET_FIELD, formulaColumnOrder, formulaInputs, recordScope, userRecord } from './rowrules.ts'
import type { FxHost } from '../contracts.ts'

describe('row rules', () => {
  it('reads New, Old, ThisRecord and bare column names', () => {
    const e = createEngine()
    const s = recordScope({ Qty: 3, Price: 2 }, { Qty: 1 }, userRecord({ name: 'Ada', email: 'a@x.test' }))
    expect(e.evaluate('=Qty * Price', s)).toEqual({ ok: true, value: 6 })
    expect(e.evaluate('=New.Qty - Old.Qty', s)).toEqual({ ok: true, value: 2 })
    expect(e.evaluate('=User().Email', s)).toEqual({ ok: true, value: 'a@x.test' })
  })
  it('SetField and Reject call the host; later actions see set values', () => {
    const e = createEngine({}, [SET_FIELD, REJECT])
    const rec: Record<string, unknown> = { Qty: 3 }
    const sets: [string, unknown][] = []
    let rejected: unknown = null
    const host = { setField: (k: string, v: unknown) => { sets.push([k, v]); rec[k] = v }, reject: (m: string, f?: string) => { rejected = { m, f } } } as unknown as FxHost
    const s = recordScope(rec as never, null, userRecord(null))
    expect(e.evaluate('=SetField({Qty: 5}); SetField({Double: New.Qty * 2})', s, host).ok).toBe(true)
    expect(sets).toEqual([['Qty', 5], ['Double', 10]])
    expect(e.evaluate('=If(Qty > 1, Reject("Too many", Qty))', s, host).ok).toBe(false)
    expect(rejected).toEqual({ m: 'Too many', f: 'Qty' })
  })
  it('orders formula columns by dependency and finds cycles', () => {
    const cols = ['Qty', 'Price', 'Net', 'Gross', 'A', 'B']
    expect(formulaInputs('Qty * New.Price', cols)).toEqual(new Set(['Qty', 'Price']))
    expect(formulaColumnOrder([{ name: 'Gross', formula: 'Net * 1.18' }, { name: 'Net', formula: 'Qty * Price' }], cols).order).toEqual(['Net', 'Gross'])
    expect(formulaColumnOrder([{ name: 'A', formula: 'B + 1' }, { name: 'B', formula: 'A + 1' }], cols).cycle).toEqual(['A', 'B', 'A'])
  })
})
