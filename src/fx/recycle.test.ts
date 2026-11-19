/** Recycle bin formula functions: DeletedRows(Table) reads the host's Deleted view, Restore(row or batch) asks the host. */
import { describe, expect, it } from 'vitest'
import { fx } from './index.ts'
import type { FxHost, FxRecord } from '../contracts.ts'

const deleted: FxRecord[] = [{ __id: 'r1', Name: 'Acme', DeleteBatch: 'del_1', DeletedTable: 'Customers', DaysLeft: 29 }]
const scope = { resolve: (n: string) => (n === 'Customers' ? [] : n === 'DeletedRows:Customers' ? deleted : undefined) }

describe('recycle bin functions', () => {
  it('DeletedRows(Table): the rows the host provides (empty while loading or for another table)', () => {
    expect(fx.evaluate('=CountRows(DeletedRows(Customers))', scope)).toEqual({ ok: true, value: 1 })
    expect(fx.evaluate('=First(DeletedRows(Customers)).DaysLeft', scope)).toEqual({ ok: true, value: 29 })
    expect(fx.evaluate('=CountRows(DeletedRows(Orders))', scope)).toEqual({ ok: true, value: 0 })
  })

  it('Restore(row) and Restore(batch) ask the host; anything else is an error', () => {
    const calls: unknown[] = []
    const host = { restore: (w: unknown) => calls.push(w) } as unknown as FxHost
    expect(fx.evaluate('=Restore(First(DeletedRows(Customers)))', scope, host).ok).toBe(true)
    expect(fx.evaluate('=Restore(First(DeletedRows(Customers)).DeleteBatch)', scope, host).ok).toBe(true)
    expect(calls).toEqual([{ rowId: 'r1', table: 'Customers' }, { batch: 'del_1' }])
    const bad = fx.evaluate('=Restore({Name: "x"})', scope, host)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.message).toMatch(/Restore needs a row of DeletedRows/)
    // not a behaviour property: Restore is refused there
    expect(fx.evaluate('=Restore("del_1")', scope).ok).toBe(false)
  })
})
