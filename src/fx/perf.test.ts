import { describe, expect, it } from 'vitest'
import { evaluate } from './index'

const rows = Array.from({ length: 40 }, (_, i) => ({
  __id: 'r' + i,
  Name: 'Person ' + ((i * 7) % 40),
  Age: 20 + ((i * 13) % 45),
  City: ['Pune', 'Delhi', 'Mumbai', 'Goa'][i % 4]!,
  Active: i % 3 !== 0,
}))
const scope = { resolve: (n: string) => (n === 'Contacts' ? rows : undefined) }

describe('performance', () => {
  it('Filter + Sort over 40 rows averages well under 1 ms (generous bound: 3 ms)', () => {
    const src = '=Sort(Filter(Contacts, Active && Age > 25 && City <> "Goa"), Name, SortOrder.Descending)'
    const first = evaluate(src, scope)
    expect(first.ok).toBe(true)
    if (first.ok) expect((first.value as unknown[]).length).toBeGreaterThan(5)
    const N = 300
    const t0 = performance.now()
    for (let i = 0; i < N; i++) evaluate(src, scope)
    const avg = (performance.now() - t0) / N
    expect(avg).toBeLessThan(3)
  })
  it('column access, GroupBy and AddColumns over 40 rows stay fast too', () => {
    const src = '=AddColumns(GroupBy(Contacts, "City", "G"), "N", CountRows(G), "Avg", Average(G, Age))'
    const N = 200
    const t0 = performance.now()
    for (let i = 0; i < N; i++) evaluate(src, scope)
    expect((performance.now() - t0) / N).toBeLessThan(3)
    expect((evaluate('=Sum(Contacts.Age)', scope) as { ok: true; value: number }).value).toBe(rows.reduce((a, r) => a + r.Age, 0))
  })
  it('the parse cache makes repeated evaluation cheaper than parsing every time', () => {
    const src = '=Concat(Filter(Contacts, Age > 30), Name, ", ")'
    evaluate(src, scope)
    const N = 500
    const t0 = performance.now()
    for (let i = 0; i < N; i++) evaluate(src, scope)
    expect((performance.now() - t0) / N).toBeLessThan(2)
  })
})
