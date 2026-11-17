import { describe, expect, it } from 'vitest'
import { contacts, err, fakeHost, val } from './testutil'

const C = () => ({ Contacts: contacts() })
const names = (v: unknown): string[] => (v as { Name: string }[]).map((r) => r.Name)

describe('GroupBy / Ungroup', () => {
  it('groups by one column in first-seen order', () => {
    const g = val('=GroupBy(Contacts, "City", "People")', C()) as { City: string; People: unknown[] }[]
    expect(g.map((r) => r.City)).toEqual(['Pune', 'Delhi', 'Mumbai'])
    expect(g.map((r) => r.People.length)).toEqual([2, 1, 1])
    expect(names(g[0]!.People)).toEqual(['Asha Rao', 'Chitra Nair'])
  })
  it('group rows keep every column and __id', () => {
    const g = val('=GroupBy(Contacts, "City", "People")', C()) as { People: Record<string, unknown>[] }[]
    expect(g[1]!.People[0]).toMatchObject({ __id: 'b', Company: 'Contoso', Age: 25 })
    expect(Object.keys(g[0]!).sort()).toEqual(['City', 'People'])
  })
  it('groups by several columns', () => {
    const g = val('=GroupBy(Contacts, "Company", "City", "Rows")', C()) as { Company: string; City: string; Rows: unknown[] }[]
    expect(g.map((r) => `${r.Company}/${r.City}/${r.Rows.length}`)).toEqual(['Northwind/Pune/2', 'Contoso/Delhi/1', 'Fabrikam/Mumbai/1'])
  })
  it('groups ignore case in text', () => {
    const t = [{ k: 'a', v: 1 }, { k: 'A', v: 2 }, { k: 'b', v: 3 }]
    expect(val('=CountRows(GroupBy(T, "k", "G"))', { T: t })).toBe(2)
  })
  it('blank is a group of its own', () => {
    const t = [{ k: null, v: 1 }, { k: 'x', v: 2 }, { k: null, v: 3 }]
    const g = val('=GroupBy(T, "k", "G")', { T: t }) as { k: unknown; G: unknown[] }[]
    expect(g.map((r) => r.G.length)).toEqual([2, 1])
    expect(g[0]!.k).toBeNull()
  })
  it('empty and blank tables', () => {
    expect(val('=GroupBy(T, "k", "G")', { T: [] })).toEqual([])
    expect(val('=GroupBy(T, "k", "G")', { T: null })).toEqual([])
  })
  it('AddColumns over GroupBy gives a summary table', () => {
    const f = '=AddColumns(GroupBy(Contacts, "City", "G"), "Count", CountRows(G), "AvgAge", Average(G, Age))'
    const rows = val(f, C()) as { City: string; Count: number; AvgAge: number }[]
    expect(rows.map((r) => [r.City, r.Count, r.AvgAge])).toEqual([['Pune', 2, 36.5], ['Delhi', 1, 25], ['Mumbai', 1, 28]])
  })
  it('summaries can be dropped down to the interesting columns', () => {
    const f = '=ShowColumns(AddColumns(GroupBy(Contacts, "Company", "G"), "Total", Sum(G, Age)), "Company", "Total")'
    expect(val(f, C())).toEqual([{ Company: 'Northwind', Total: 73 }, { Company: 'Contoso', Total: 25 }, { Company: 'Fabrikam', Total: 28 }])
  })
  it('Sort and Filter work on the grouped table', () => {
    const f = '=First(Sort(AddColumns(GroupBy(Contacts, "City", "G"), "N", CountRows(G)), N, SortOrder.Descending)).City'
    expect(val(f, C())).toBe('Pune')
  })
  it('Ungroup flattens again', () => {
    const rows = val('=Ungroup(GroupBy(Contacts, "City", "G"), "G")', C()) as { Name: string }[]
    expect(names(rows)).toEqual(['Asha Rao', 'Chitra Nair', 'Ben Cole', 'Dev Patel'])
  })
  it('Ungroup keeps outer columns that were added', () => {
    const rows = val('=Ungroup(AddColumns(GroupBy(Contacts, "City", "G"), "N", CountRows(G)), "G")', C()) as { Name: string; N: number }[]
    expect(rows.map((r) => r.N)).toEqual([2, 2, 1, 1])
  })
  it('errors', () => {
    expect(err('=GroupBy(Contacts, "City", "City")', C()).message).toMatch(/different from the grouping columns/)
    expect(err('=Ungroup(Contacts, "G")', C()).message).toBe('The table has no column called G')
    expect(err('=Ungroup(Contacts, "City")', C()).message).toMatch(/isn't a table/)
    expect(err('=GroupBy(Contacts, "City")', C()).message).toBe('GroupBy needs at least 3 arguments')
  })
})

describe('Shuffle', () => {
  it('keeps the same rows', () => {
    const rows = val('=Shuffle(Contacts)', C()) as { Name: string }[]
    expect(names(rows).sort()).toEqual(['Asha Rao', 'Ben Cole', 'Chitra Nair', 'Dev Patel'])
  })
  it('does not change the original', () => {
    const c = C()
    val('=Shuffle(Contacts)', c)
    expect(names(c.Contacts)).toEqual(['Asha Rao', 'Ben Cole', 'Chitra Nair', 'Dev Patel'])
  })
  it('actually reorders at least once in many tries', () => {
    const orders = new Set<string>()
    for (let i = 0; i < 40; i++) orders.add(names(val('=Shuffle(Contacts)', C())).join(','))
    expect(orders.size).toBeGreaterThan(1)
  })
  it('empty table', () => {
    expect(val('=Shuffle(T)', { T: [] })).toEqual([])
    expect(val('=CountRows(Shuffle(Sequence(10)))')).toBe(10)
  })
})

describe('RenameColumns', () => {
  it('renames one or several columns, keeping order', () => {
    const r = val('=RenameColumns(Contacts, "Name", "Full name", "Age", "Years")', C()) as Record<string, unknown>[]
    expect(Object.keys(r[0]!)).toEqual(['__id', 'Full name', 'Company', 'City', 'Years', 'Active'])
    expect(r[0]!['Full name']).toBe('Asha Rao')
    expect(r[1]!.Years).toBe(25)
    expect(r[0]!.Name).toBeUndefined()
  })
  it('new names are usable with quoted identifiers', () => {
    expect(val(`=First(RenameColumns(Contacts, "Name", "Full name")).'Full name'`, C())).toBe('Asha Rao')
  })
  it('errors', () => {
    expect(err('=RenameColumns(Contacts, "Nope", "X")', C()).message).toBe('The table has no column called Nope')
    expect(err('=RenameColumns(Contacts, "Name")', C()).message).toBe('RenameColumns needs at least 3 arguments')
    expect(err('=RenameColumns(Contacts, "Name", "A", "Age")', C()).message).toMatch(/old and a new name/)
  })
  it('empty tables are fine', () => {
    expect(val('=RenameColumns(T, "a", "b")', { T: [] })).toEqual([])
  })
})

describe('Choices', () => {
  it('distinct values of a column by name', () => {
    expect(val('=Choices(Contacts, "City")', C())).toEqual([{ Value: 'Pune' }, { Value: 'Delhi' }, { Value: 'Mumbai' }])
    expect(val('=Choices(Contacts, "Company")', C())).toEqual([{ Value: 'Northwind' }, { Value: 'Contoso' }, { Value: 'Fabrikam' }])
  })
  it('Table.Column form', () => {
    expect(val('=Choices(Contacts.City)', C())).toEqual([{ Value: 'Pune' }, { Value: 'Delhi' }, { Value: 'Mumbai' }])
    expect(val('=CountRows(Choices(Contacts.Active))', C())).toBe(1 + 1)
  })
  it('collection name as text', () => {
    expect(val('=Choices("Contacts", "City")', C())).toEqual([{ Value: 'Pune' }, { Value: 'Delhi' }, { Value: 'Mumbai' }])
    expect(err('=Choices("Nope", "City")', C()).message).toBe("Name isn't recognised: Nope")
  })
  it('skips blanks and ignores case', () => {
    const t = [{ s: 'a' }, { s: null }, { s: 'A' }, { s: '' }, { s: 'b' }]
    expect(val('=Choices(T, "s")', { T: t })).toEqual([{ Value: 'a' }, { Value: 'b' }])
  })
  it('feeds a ComboBox-like Items list', () => {
    expect(val('=Concat(Choices(Contacts, "City"), Value, ", ")', C())).toBe('Pune, Delhi, Mumbai')
    expect(val('=Sort(Choices(Contacts, "City"), Value)', C())).toEqual([{ Value: 'Delhi' }, { Value: 'Mumbai' }, { Value: 'Pune' }])
  })
  it('multi-column table without a column name is an error', () => {
    expect(err('=Choices(Contacts)', C()).message).toMatch(/several columns/)
  })
  it('blank table', () => {
    expect(val('=Choices(T, "a")', { T: null })).toEqual([])
  })
})

describe('Table() from JSON and arrays', () => {
  it('flattens tables, records and scalars', () => {
    expect(val('=Table({a: 1}, {a: 2})')).toEqual([{ a: 1 }, { a: 2 }])
    expect(val('=Table([{a: 1}], {a: 2})')).toEqual([{ a: 1 }, { a: 2 }])
    expect(val('=Table(1, 2)')).toEqual([{ Value: 1 }, { Value: 2 }])
    expect(val('=CountRows(Table(Sequence(3), Sequence(2)))')).toBe(5)
  })
  it('Distinct and Sort over a single-column table', () => {
    expect(val('=Distinct(Table(1, 2, 2, 3, 1), Value)')).toEqual([{ Value: 1 }, { Value: 2 }, { Value: 3 }])
    expect(val('=Sort(Table(3, 1, 2), Value, SortOrder.Descending)')).toEqual([{ Value: 3 }, { Value: 2 }, { Value: 1 }])
  })
})

describe('SortOrder enum with Sort and SortByColumns', () => {
  it('Ascending and Descending', () => {
    expect(names(val('=Sort(Contacts, Age, SortOrder.Ascending)', C()))).toEqual(['Ben Cole', 'Dev Patel', 'Asha Rao', 'Chitra Nair'])
    expect(names(val('=Sort(Contacts, Age, SortOrder.Descending)', C()))).toEqual(['Chitra Nair', 'Asha Rao', 'Dev Patel', 'Ben Cole'])
    expect(names(val('=SortByColumns(Contacts, "City", SortOrder.Descending, "Name")', C()))).toEqual(['Asha Rao', 'Chitra Nair', 'Dev Patel', 'Ben Cole'])
  })
})

describe('Patch(record, record) as a pure merge', () => {
  it('merges without a host', () => {
    expect(val('=Patch({a: 1, b: 2}, {b: 3, c: 4})')).toEqual({ a: 1, b: 3, c: 4 })
    expect(val('=Patch({a: 1}, {b: 2}, {c: 3})')).toEqual({ a: 1, b: 2, c: 3 })
    expect(val('=Patch({a: 1}, Blank())')).toEqual({ a: 1 })
  })
  it('merges rows and keeps their __id', () => {
    const r = val('=Patch(First(Contacts), {Age: 99})', C()) as Record<string, unknown>
    expect(r.Age).toBe(99)
    expect(r.__id).toBe('a')
    expect(r.Name).toBe('Asha Rao')
  })
  it('does not change the original record', () => {
    const c = C()
    val('=Patch(First(Contacts), {Age: 99})', c)
    expect(c.Contacts[0]!.Age).toBe(31)
  })
  it('later __id is ignored', () => {
    expect(val('=Patch({a: 1}, {__id: "evil", b: 2})')).toEqual({ a: 1, b: 2 })
  })
  it('works with a record variable and a host, without a host call', () => {
    const { host, calls } = fakeHost()
    expect(val('=Patch(rec, {x: 2}).x', { rec: { x: 1, y: 5 } }, host)).toBe(2)
    expect(calls).toEqual([])
  })
  it('the collection form still reaches the host', () => {
    const { host, calls } = fakeHost()
    val('=Patch(Contacts, Defaults(Contacts), {Name: "Z"})', C(), host)
    expect(calls.map((c) => c.fn)).toEqual(['patch'])
    val('=Patch(Fresh, Defaults(Fresh), {Name: "Z"})', {}, host)
    expect(calls.map((c) => c.fn)).toEqual(['patch', 'patch'])
  })
  it('the collection form without a host is still an error', () => {
    expect(err('=Patch(Contacts, Defaults(Contacts), {Name: "Z"})', C()).message).toBe('Behaviour function in a non-behaviour property')
    expect(err('=Patch(Fresh, {a: 1})').message).toBe('Behaviour function in a non-behaviour property')
  })
  it('a non-record change is an error', () => {
    expect(err('=Patch({a: 1}, 5)').message).toMatch(/must be a record/)
  })
  it('result can be used in a Collect', () => {
    const { host, calls } = fakeHost()
    val('=Collect(Cart, Patch({qty: 1}, {qty: 3}))', {}, host)
    expect(calls[0]).toEqual({ fn: 'collect', args: ['Cart', [{ qty: 3 }], false] })
  })
})
