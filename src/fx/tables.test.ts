import { describe, expect, it } from 'vitest'
import { contacts, err, val } from './testutil.ts'

const C = () => ({ Contacts: contacts() })
const names = (v: unknown) => (v as { Name: string }[]).map((r) => r.Name)
const ids = (v: unknown) => (v as { __id: string }[]).map((r) => r.__id)

describe('Filter', () => {
  it('filters with row-scope fields', () => {
    expect(names(val('=Filter(Contacts, City = "Pune")', C()))).toEqual(['Asha Rao', 'Chitra Nair'])
    expect(names(val('=Filter(Contacts, Age > 26 && Active)', C()))).toEqual(['Asha Rao', 'Chitra Nair', 'Dev Patel'])
  })
  it('multiple conditions are ANDed', () => {
    expect(names(val('=Filter(Contacts, City = "Pune", Age > 35)', C()))).toEqual(['Chitra Nair'])
  })
  it('preserves __id', () => {
    expect(ids(val('=Filter(Contacts, Active)', C()))).toEqual(['a', 'c', 'd'])
  })
  it('the sample search formula', () => {
    const f = '=Filter(Contacts, SearchBox.Value in Name || SearchBox.Value in Company)'
    const s = (q: string) => names(val(f, { ...C(), SearchBox: { Value: q } }))
    expect(s('')).toHaveLength(4)
    expect(s('north')).toEqual(['Asha Rao', 'Chitra Nair'])
    expect(s('dev')).toEqual(['Dev Patel'])
    expect(s('zzz')).toEqual([])
  })
  it('ThisRecord and As', () => {
    expect(names(val('=Filter(Contacts, ThisRecord.Age < 30)', C()))).toEqual(['Ben Cole', 'Dev Patel'])
    expect(names(val('=Filter(Contacts As c, c.Age < 30)', C()))).toEqual(['Ben Cole', 'Dev Patel'])
  })
  it('row fields shadow outer names; outer names still reachable', () => {
    expect(names(val('=Filter(Contacts, City = Wanted)', { ...C(), Wanted: 'Delhi' }))).toEqual(['Ben Cole'])
  })
  it('works on scalar tables via Value', () => {
    expect(val('=Filter([1, 2, 3, 4], Value > 2)')).toEqual([{ Value: 3 }, { Value: 4 }])
  })
  it('errors', () => {
    const e = err('=Filter(5, true)')
    expect(e.message).toBe('Filter needs a table as its first argument')
    expect(e.start).toBe(8)
    expect(e.end).toBe(9)
    expect(err('=Filter(Contacts, Nope = 1)', C()).message).toBe("Name isn't recognised: Nope")
    expect(val('=Filter(Blank(), true)')).toEqual([])
  })
})

describe('Search / LookUp', () => {
  it('Search', () => {
    expect(names(val('=Search(Contacts, "NORTH", "Company")', C()))).toEqual(['Asha Rao', 'Chitra Nair'])
    expect(names(val('=Search(Contacts, "pune", "Name", "City")', C()))).toEqual(['Asha Rao', 'Chitra Nair'])
    expect(names(val('=Search(Contacts, "", "Name")', C()))).toHaveLength(4)
    expect(names(val('=Search(Contacts, "31", "Age")', C()))).toEqual(['Asha Rao'])
    expect(val('=Search(Contacts, "x", "Nope")', C())).toEqual([])
  })
  it('LookUp', () => {
    expect((val('=LookUp(Contacts, Name = "Ben Cole")', C()) as { __id: string }).__id).toBe('b')
    expect(val('=LookUp(Contacts, Name = "Ben Cole", Age)', C())).toBe(25)
    expect(val('=LookUp(Contacts, Name = "Nobody", Age)', C())).toBeNull()
    expect(val('=LookUp(Contacts, Active = false).Company', C())).toBe('Contoso')
  })
})

describe('Sort / SortByColumns', () => {
  it('Sort', () => {
    expect(names(val('=Sort(Contacts, Age)', C()))).toEqual(['Ben Cole', 'Dev Patel', 'Asha Rao', 'Chitra Nair'])
    expect(names(val('=Sort(Contacts, Age, SortOrder.Descending)', C()))).toEqual(['Chitra Nair', 'Asha Rao', 'Dev Patel', 'Ben Cole'])
    expect(names(val('=Sort(Contacts, Name, "Descending")', C()))[0]).toBe('Dev Patel')
    expect(names(val('=Sort(Contacts, Len(Name))', C()))[0]).toBe('Asha Rao')
    expect(ids(val('=Sort(Contacts, Age)', C()))).toEqual(['b', 'd', 'a', 'c'])
    expect(err('=Sort(Contacts, Age, "sideways")', C()).message).toMatch(/Ascending or Descending/)
  })
  it('Sort is case-insensitive and numeric-aware', () => {
    expect(val('=Sort(["b", "A", "c"], Value)')).toEqual([{ Value: 'A' }, { Value: 'b' }, { Value: 'c' }])
    expect(val('=Sort([10, 9, 100], Value)')).toEqual([{ Value: 9 }, { Value: 10 }, { Value: 100 }])
  })
  it('SortByColumns', () => {
    expect(names(val('=SortByColumns(Contacts, "Age")', C()))).toEqual(['Ben Cole', 'Dev Patel', 'Asha Rao', 'Chitra Nair'])
    expect(names(val('=SortByColumns(Contacts, "Age", SortOrder.Descending)', C()))[0]).toBe('Chitra Nair')
    expect(names(val('=SortByColumns(Contacts, "City", SortOrder.Ascending, "Age", SortOrder.Descending)', C()))).toEqual(['Ben Cole', 'Dev Patel', 'Chitra Nair', 'Asha Rao'])
    expect(names(val('=SortByColumns(Contacts, "Company", "Name")', C()))).toEqual(['Ben Cole', 'Dev Patel', 'Asha Rao', 'Chitra Nair'])
  })
})

describe('First / Last / Index / counting', () => {
  it('First / Last / FirstN / LastN', () => {
    expect((val('=First(Contacts)', C()) as { Name: string }).Name).toBe('Asha Rao')
    expect((val('=Last(Contacts)', C()) as { Name: string }).Name).toBe('Dev Patel')
    expect(val('=First([])')).toBeNull()
    expect(val('=Last([])')).toBeNull()
    expect(names(val('=FirstN(Contacts, 2)', C()))).toEqual(['Asha Rao', 'Ben Cole'])
    expect(names(val('=FirstN(Contacts)', C()))).toEqual(['Asha Rao'])
    expect(names(val('=LastN(Contacts, 2)', C()))).toEqual(['Chitra Nair', 'Dev Patel'])
    expect(val('=LastN(Contacts, 0)', C())).toEqual([])
    expect(val('=First(Contacts).Name', C())).toBe('Asha Rao')
  })
  it('Index', () => {
    expect((val('=Index(Contacts, 2)', C()) as { Name: string }).Name).toBe('Ben Cole')
    const e = err('=Index(Contacts, 9)', C())
    expect(e.message).toMatch(/Row 9 doesn't exist/)
    expect(e.start).toBe(17)
    expect(err('=Index(Contacts, 0)', C()).message).toMatch(/doesn't exist/)
  })
  it('CountRows / CountIf', () => {
    expect(val('=CountRows(Contacts)', C())).toBe(4)
    expect(val('=CountRows(Filter(Contacts, Active))', C())).toBe(3)
    expect(val('=CountRows(Blank())')).toBe(0)
    expect(val('=CountIf(Contacts, City = "Pune")', C())).toBe(2)
    expect(val('=CountIf(Contacts, Age > 100)', C())).toBe(0)
    expect(err('=CountRows("x")').message).toBe('CountRows needs a table as its first argument')
  })
  it('Sequence', () => {
    expect(val('=Sequence(3)')).toEqual([{ Value: 1 }, { Value: 2 }, { Value: 3 }])
    expect(val('=Sequence(3, 10)')).toEqual([{ Value: 10 }, { Value: 11 }, { Value: 12 }])
    expect(val('=Sequence(3, 0, 5)')).toEqual([{ Value: 0 }, { Value: 5 }, { Value: 10 }])
    expect(val('=Sequence(0)')).toEqual([])
  })
})

describe('Distinct / AddColumns / DropColumns / ShowColumns / ForAll', () => {
  it('Distinct', () => {
    expect(val('=Distinct(Contacts, City)', C())).toEqual([{ Value: 'Pune' }, { Value: 'Delhi' }, { Value: 'Mumbai' }])
    expect(val('=Distinct([1, 2, 1, 2, 3], Value)')).toEqual([{ Value: 1 }, { Value: 2 }, { Value: 3 }])
    expect(val('=Distinct(["a", "A"], Value)')).toEqual([{ Value: 'a' }])
  })
  it('AddColumns keeps existing fields and __id', () => {
    const r = val('=AddColumns(Contacts, "Next", Age + 1, "Tag", Name & "!")', C()) as Record<string, unknown>[]
    expect(r[0]).toEqual({ __id: 'a', Name: 'Asha Rao', Company: 'Northwind', City: 'Pune', Age: 31, Active: true, Next: 32, Tag: 'Asha Rao!' })
    expect(r).toHaveLength(4)
    expect(err('=AddColumns(Contacts, "x")', C()).message).toMatch(/at least 3/)
    expect(err('=AddColumns(Contacts, "x", 1, "y")', C()).message).toMatch(/name and a formula/)
  })
  it('DropColumns', () => {
    const r = val('=DropColumns(Contacts, "Company", "City", "Age", "Active")', C()) as Record<string, unknown>[]
    expect(r[1]).toEqual({ __id: 'b', Name: 'Ben Cole' })
    const r2 = val('=DropColumns(Contacts, "__id")', C()) as Record<string, unknown>[]
    expect(r2[0]!.__id).toBe('a')
  })
  it('ShowColumns keeps __id', () => {
    const r = val('=ShowColumns(Contacts, "Name", "Age")', C()) as Record<string, unknown>[]
    expect(r[2]).toEqual({ __id: 'c', Name: 'Chitra Nair', Age: 42 })
  })
  it('__id survives chained table functions', () => {
    expect(ids(val('=FirstN(Sort(Filter(Contacts, Active), Age), 2)', C()))).toEqual(['d', 'a'])
    expect(ids(val('=Sort(AddColumns(Contacts, "X", 1), Age)', C()))).toEqual(['b', 'd', 'a', 'c'])
  })
  it('ForAll', () => {
    expect(val('=ForAll([1, 2, 3], Value * 2)')).toEqual([{ Value: 2 }, { Value: 4 }, { Value: 6 }])
    expect(val('=ForAll(Contacts, Upper(Name))', C())).toEqual([{ Value: 'ASHA RAO' }, { Value: 'BEN COLE' }, { Value: 'CHITRA NAIR' }, { Value: 'DEV PATEL' }])
    expect(val('=ForAll(Sequence(2), {n: Value})')).toEqual([{ n: 1 }, { n: 2 }])
    expect(ids(val('=ForAll(Contacts, ThisRecord)', C()))).toEqual(['a', 'b', 'c', 'd'])
    expect(val('=ForAll(Contacts As c, c.Age)', C())).toEqual([{ Value: 31 }, { Value: 25 }, { Value: 42 }, { Value: 28 }])
  })
  it('Defaults is an empty record and does not evaluate its argument', () => {
    expect(val('=Defaults(Contacts)')).toEqual({})
  })
})

describe('nested scopes', () => {
  const data = { Orders: [{ Id: 1, Items: [{ Qty: 2 }, { Qty: 3 }] }, { Id: 2, Items: [{ Qty: 5 }] }] }
  it('inner row scope sees outer row', () => {
    expect(val('=ForAll(Orders, Sum(Items, Qty))', data)).toEqual([{ Value: 5 }, { Value: 5 }])
    expect(val('=ForAll(Orders, CountRows(Filter(Items, Qty > Id)))', data)).toEqual([{ Value: 2 }, { Value: 1 }])
  })
  it('As names reach across nested scopes', () => {
    expect(val('=ForAll(Orders As o, Sum(Items, Qty * o.Id))', data)).toEqual([{ Value: 5 }, { Value: 10 }])
    expect(val('=ForAll(Orders As o, CountRows(Filter(o.Items As i, i.Qty >= 3)))', data)).toEqual([{ Value: 1 }, { Value: 1 }])
  })
  it('ThisRecord is the innermost row', () => {
    expect(val('=ForAll(Orders, First(Items).Qty)', data)).toEqual([{ Value: 2 }, { Value: 5 }])
    expect(val('=First(ForAll(Orders, CountRows(Filter(Items, ThisRecord.Qty > 2)))).Value', data)).toBe(1)
  })
  it('With inside rows', () => {
    expect(val('=ForAll(Orders, With({k: Id * 10}, k + 1))', data)).toEqual([{ Value: 11 }, { Value: 21 }])
  })
  it('suggests the right case for row fields', () => {
    expect(err('=Filter(Orders, id = 1)', data).message).toBe("Name isn't recognised: id. Did you mean Id?")
  })
})
