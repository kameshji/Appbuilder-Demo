import { describe, expect, it } from 'vitest'
import * as lucide from 'lucide-react'
import { enums, fx } from './index.ts'
import { ICON_NAMES, NAMED_COLORS } from './enums.ts'
import { contacts, err, val } from './testutil.ts'

const C = () => ({ Contacts: contacts() })

describe('new enums', () => {
  const expected: Record<string, string[]> = {
    Anchor: ['Start', 'End', 'Stretch', 'Center', 'Scale'],
    Layout: ['Manual', 'Row', 'Column', 'Grid'],
    Justify: ['Start', 'Center', 'End', 'SpaceBetween', 'SpaceAround'],
    AlignItems: ['Auto', 'Start', 'Center', 'End', 'Stretch'],
    FormMode: ['Edit', 'New', 'View'],
    Fit: ['Cover', 'Contain', 'Fill'],
    Orientation: ['Horizontal', 'Vertical'],
    Variant: ['Default', 'Secondary', 'Outline', 'Ghost', 'Destructive'],
    Size: ['Small', 'Medium', 'Large'],
    Side: ['Left', 'Right', 'Top', 'Bottom'],
    ChartType: ['Bar', 'Line', 'Area', 'Pie', 'Donut'],
    TextMode: ['SingleLine', 'MultiLine', 'Password', 'Number'],
    SelectionMode: ['None', 'Single', 'Multiple'],
  }
  it('lists the members in enums()', () => {
    const e = enums()
    for (const [name, members] of Object.entries(expected)) expect(e[name], name).toEqual(members)
  })
  it('every member evaluates to its own name', () => {
    for (const [name, members] of Object.entries(expected)) {
      for (const m of members) expect(val(`=${name}.${m}`), `${name}.${m}`).toBe(m)
    }
  })
  it('unknown members are reported', () => {
    expect(err('=Anchor.Middle').message).toBe("Anchor doesn't have a member called Middle")
    expect(err('=Size.Huge').message).toBe("Size doesn't have a member called Huge")
    expect(err('=FormMode.Delete').message).toBe("FormMode doesn't have a member called Delete")
  })
  it('enum values compare and switch like text', () => {
    expect(val('=Layout.Row = "Row"')).toBe(true)
    expect(val('=Switch(Orientation.Vertical, Orientation.Horizontal, 1, Orientation.Vertical, 2)')).toBe(2)
    expect(val('=SelectionMode.Single <> SelectionMode.Multiple')).toBe(true)
  })
  it('referencedNames ignores the new enum names', () => {
    expect(fx.referencedNames('=If(Self.Mode = FormMode.New, Size.Large, Anchor.End)')).toEqual(['Self'])
  })
  it('Icon enum is a list of lucide names', () => {
    const icons = enums().Icon!
    expect(icons.length).toBeGreaterThanOrEqual(80)
    for (const n of ['Plus', 'Trash', 'Edit', 'Search', 'Check', 'X', 'ChevronRight']) expect(icons).toContain(n)
    expect(val('=Icon.Plus')).toBe('Plus')
    expect(val('=Icon.ChevronRight')).toBe('ChevronRight')
    expect(err('=Icon.NotAnIcon').message).toBe("Icon doesn't have a member called NotAnIcon")
  })
  it('every Icon member exists in lucide-react', () => {
    const lib = lucide as unknown as Record<string, unknown>
    const missing = ICON_NAMES.filter((n) => !lib[n])
    expect(missing).toEqual([])
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length)
  })
  it('Match and MatchOptions enums exist', () => {
    expect(enums().MatchOptions).toContain('IgnoreCase')
    expect(enums().Match).toEqual(expect.arrayContaining(['Digit', 'Email', 'MultipleDigits']))
  })
})

describe('fuller Color palette', () => {
  it('keeps the old colours unchanged', () => {
    expect(val('=Color.Red')).toBe('rgba(239, 68, 68, 1)')
    expect(val('=Color.Transparent')).toBe('rgba(0, 0, 0, 0)')
  })
  it('adds many named colours', () => {
    expect(Object.keys(NAMED_COLORS).length).toBeGreaterThanOrEqual(40)
    for (const n of ['Indigo', 'Navy', 'Gold', 'Lime', 'Rose', 'Silver', 'Emerald', 'Coral', 'Lavender', 'Charcoal']) {
      expect(enums().Color, n).toContain(n)
      expect(val(`=Color.${n}`), n).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/)
    }
  })
  it('ColorValue and ColorFade understand them', () => {
    expect(val('=ColorValue("Indigo")')).toBe('rgba(99, 102, 241, 1)')
    expect(val('=ColorValue("gold")')).toBe(val('=Color.Gold'))
    expect(val('=ColorFade(Color.Navy, 1)')).toBe('rgba(255, 255, 255, 1)')
  })
})

describe('Table.Column access', () => {
  it('returns a single-column table', () => {
    expect(val('=Contacts.Name', C())).toEqual([{ Name: 'Asha Rao' }, { Name: 'Ben Cole' }, { Name: 'Chitra Nair' }, { Name: 'Dev Patel' }])
    expect(val('=Contacts.Age', C())).toEqual([{ Age: 31 }, { Age: 25 }, { Age: 42 }, { Age: 28 }])
  })
  it('works on computed tables', () => {
    expect(val('=Filter(Contacts, Active).City', C())).toEqual([{ City: 'Pune' }, { City: 'Pune' }, { City: 'Mumbai' }])
    expect(val('=Sort(Contacts, Age).Name', C())).toEqual([{ Name: 'Ben Cole' }, { Name: 'Dev Patel' }, { Name: 'Asha Rao' }, { Name: 'Chitra Nair' }])
  })
  it('feeds the aggregate functions', () => {
    expect(val('=Sum(Contacts.Age)', C())).toBe(126)
    expect(val('=Max(Contacts.Age)', C())).toBe(42)
    expect(val('=CountRows(Contacts.Name)', C())).toBe(4)
    expect(val('=Concat(Contacts.Name, Name, "|")', C())).toBe('Asha Rao|Ben Cole|Chitra Nair|Dev Patel')
    expect(val('=First(Contacts.Name).Name', C())).toBe('Asha Rao')
    expect(val('=Average(Contacts.Age)', C())).toBe(31.5)
  })
  it('drops __id and other columns', () => {
    const r = val('=First(Contacts.Name)', C()) as Record<string, unknown>
    expect(Object.keys(r)).toEqual(['Name'])
  })
  it('missing values in some rows become blank', () => {
    expect(val('=T.a', { T: [{ a: 1 }, { b: 2 }] })).toEqual([{ a: 1 }, { a: null }])
  })
  it('empty and blank tables', () => {
    expect(val('=T.a', { T: [] })).toEqual([])
    expect(val('=T.a', { T: null })).toBeNull()
  })
  it('a column no row has is an error that points at the name', () => {
    const e = err('=Contacts.Nope', C())
    expect(e.message).toBe("Can't read .Nope from a table: it has no column called Nope")
    expect(e.start).toBe(10)
    expect(e.end).toBe(14)
  })
  it('is not confused with record access', () => {
    expect(val('=First(Contacts).Name', C())).toBe('Asha Rao')
    expect(val('=LookUp(Contacts, Age = 25).City', C())).toBe('Delhi')
  })
  it('works with scalar tables (Value column)', () => {
    expect(val('=Sequence(3).Value')).toEqual([{ Value: 1 }, { Value: 2 }, { Value: 3 }])
    expect(val('=[10, 20].Value')).toEqual([{ Value: 10 }, { Value: 20 }])
  })
})

describe('in on single-column tables', () => {
  it('searches the only column', () => {
    expect(val('="Ben Cole" in Contacts.Name', C())).toBe(true)
    expect(val('="ben cole" in Contacts.Name', C())).toBe(true)
    expect(val('="Zed" in Contacts.Name', C())).toBe(false)
    expect(val('=28 in Contacts.Age', C())).toBe(true)
    expect(val('=29 in Contacts.Age', C())).toBe(false)
  })
  it('exactin is case sensitive', () => {
    expect(val('="ben cole" exactin Contacts.Name', C())).toBe(false)
    expect(val('="Ben Cole" exactin Contacts.Name', C())).toBe(true)
  })
  it('works inside Filter', () => {
    expect(val('=CountRows(Filter(Contacts, City in Filter(Contacts, Active).City))', C())).toBe(3)
    expect(val('=CountRows(Filter(Contacts, Name in ShowColumns(Contacts, "Name")))', C())).toBe(4)
  })
  it('multi-column tables still need a record or Value', () => {
    expect(val('="Pune" in Contacts', C())).toBe(false)
    expect(val('=3 in [1, 2, 3]')).toBe(true)
  })
})

describe('deep member access', () => {
  const sel = { Selected: { Company: { Name: 'Contoso', Address: { City: 'Delhi' } }, Id: 4 } }
  it('reads nested records', () => {
    expect(val('=Gallery1.Selected.Company.Name', { Gallery1: sel })).toBe('Contoso')
    expect(val('=Gallery1.Selected.Company.Address.City', { Gallery1: sel })).toBe('Delhi')
  })
  it('blank anywhere in the chain gives blank', () => {
    expect(val('=Gallery1.Selected.Company.Name', { Gallery1: { Selected: null } })).toBeNull()
    expect(val('=Gallery1.Selected.Company.Name', { Gallery1: { Selected: { Company: null } } })).toBeNull()
    expect(val('=Gallery1.Selected.Missing.Name', { Gallery1: sel })).toBeNull()
  })
  it('column access on a nested table', () => {
    expect(val('=Sum(Order.Lines.Qty)', { Order: { Lines: [{ Qty: 2 }, { Qty: 5 }] } })).toBe(7)
  })
})

describe('User() and Param()', () => {
  const scope = (map: Record<string, unknown>) => ({ resolve: (n: string) => (n in map ? (map[n] as never) : undefined) })
  it('User() reads scope.resolve("User()")', () => {
    const user = { FullName: 'Sam Maker', Email: 'sam@x.dev', Image: '' }
    const asked: string[] = []
    const r = fx.evaluate('=User().FullName', { resolve: (n) => { asked.push(n); return n === 'User()' ? user : undefined } })
    expect(r).toEqual({ ok: true, value: 'Sam Maker' })
    expect(asked).toEqual(['User()'])
    expect(fx.evaluate('=User().Email', scope({ 'User()': user }))).toEqual({ ok: true, value: 'sam@x.dev' })
  })
  it('User() without an answer is a record with blank fields', () => {
    expect(val('=User()')).toEqual({ FullName: '', Email: '', Image: '' })
    expect(val('=IsBlank(User().FullName)')).toBe(true)
  })
  it('User() takes no arguments', () => {
    expect(fx.check('=User(1)')[0]!.message).toBe("User doesn't take any arguments")
  })
  it('Param(name) reads scope.resolve("Param:name")', () => {
    const asked: string[] = []
    const r = fx.evaluate('=Param("id") & Param("tab")', { resolve: (n) => { asked.push(n); return n === 'Param:id' ? '42' : n === 'Param:tab' ? 'x' : undefined } })
    expect(r).toEqual({ ok: true, value: '42x' })
    expect(asked).toEqual(['Param:id', 'Param:tab'])
  })
  it('missing Param is blank', () => {
    expect(val('=Param("nothing")')).toBeNull()
    expect(val('=IsBlank(Param("nothing"))')).toBe(true)
    expect(val('=Coalesce(Param("page"), "home")')).toBe('home')
  })
  it('Param name may be computed', () => {
    expect(fx.evaluate('=Param("a" & "b")', scope({ 'Param:ab': 7 }))).toEqual({ ok: true, value: 7 })
  })
  it('a scope that throws gives a clear fatal error', () => {
    const r = fx.evaluate('=IfError(Param("x"), "fallback")', { resolve: () => { throw new Error('no params here') } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('no params here')
  })
  it('Language() is en-US', () => {
    expect(val('=Language()')).toBe('en-US')
  })
})

describe('IfError family', () => {
  it('two arguments behave as before', () => {
    expect(val('=IfError(1 / 0, "x")')).toBe('x')
    expect(val('=IfError(5, "x")')).toBe(5)
  })
  it('first failing value picks its fallback', () => {
    expect(val('=IfError(1 / 0, "a", 2, "b")')).toBe('a')
    expect(val('=IfError(1, "a", 1 / 0, "b")')).toBe('b')
    expect(val('=IfError(1, "a", 1 / 0, "b", 1 / 0, "c")')).toBe('b')
  })
  it('without a failure the last value (or the default) is returned', () => {
    expect(val('=IfError(1, "a", 2, "b")')).toBe(2)
    expect(val('=IfError(1, "a", 2, "b", "default")')).toBe('default')
    expect(val('=IfError(1, "a", "default")')).toBe('default')
  })
  it('default is only used when nothing failed', () => {
    expect(val('=IfError(1 / 0, "a", "default")')).toBe('a')
  })
  it('later values are not evaluated after a failure', () => {
    expect(val('=IfError(1 / 0, "a", Value("nope"), "b")')).toBe('a')
  })
  it('FirstError.Message is available in the fallback', () => {
    expect(val('=IfError(1 / 0, FirstError.Message)')).toBe("Can't divide by zero")
    expect(val('=IfError(Error("boom"), "caught: " & FirstError.Message)')).toBe('caught: boom')
  })
  it('FirstError does not hide ThisRecord', () => {
    expect(val('=Concat(Contacts, IfError(1 / 0, ThisRecord.Name), ",")', C())).toBe('Asha Rao,Ben Cole,Chitra Nair,Dev Patel')
  })
  it('fatal errors are not swallowed', () => {
    expect(err('=IfError(Nope, 1, 2, 3)').message).toBe("Name isn't recognised: Nope")
    expect(err('=IfError(1, 1 / 0, Nope, 3)').message).toBe("Name isn't recognised: Nope")
  })
  it('needs two arguments', () => {
    expect(fx.check('=IfError(1)')[0]!.message).toBe('IfError needs at least 2 arguments')
  })
  it('IsError', () => {
    expect(val('=IsError(1 / 0)')).toBe(true)
    expect(val('=IsError(1)')).toBe(false)
    expect(val('=IsError(Value("abc"))')).toBe(true)
    expect(val('=IsError(Blank())')).toBe(false)
    expect(val('=IsError(Error("x"))')).toBe(true)
    expect(err('=IsError(Nope)').message).toBe("Name isn't recognised: Nope")
  })
  it('IsBlankOrError', () => {
    expect(val('=IsBlankOrError(1 / 0)')).toBe(true)
    expect(val('=IsBlankOrError(Blank())')).toBe(true)
    expect(val('=IsBlankOrError("")')).toBe(true)
    expect(val('=IsBlankOrError("a")')).toBe(false)
    expect(val('=IsBlankOrError(0)')).toBe(false)
  })
  it('Error(text)', () => {
    const e = err('=Error("Out of stock")')
    expect(e.message).toBe('Out of stock')
    expect(e.start).toBe(1)
    expect(err('=Error("")').message).toBe('An error occurred')
    expect(err('=Error({Message: "from record"})').message).toBe('from record')
    expect(val('=IfError(Error("x"), 9)')).toBe(9)
  })
  it('Error in a conditional branch', () => {
    expect(val('=IfError(If(1 > 2, 1, Error("bad input")), "fallback")')).toBe('fallback')
    expect(val('=IfError(If(2 > 1, "ok", Error("bad input")), "fallback")')).toBe('ok')
  })
})

describe('IsNumeric and Boolean', () => {
  it('IsNumeric', () => {
    expect(val('=IsNumeric(5)')).toBe(true)
    expect(val('=IsNumeric("12.5")')).toBe(true)
    expect(val('=IsNumeric("1,234")')).toBe(true)
    expect(val('=IsNumeric("abc")')).toBe(false)
    expect(val('=IsNumeric("")')).toBe(false)
    expect(val('=IsNumeric(Blank())')).toBe(false)
    expect(val('=IsNumeric(true)')).toBe(false)
    expect(val('=IsNumeric(Today())')).toBe(false)
  })
  it('Boolean', () => {
    expect(val('=Boolean("true")')).toBe(true)
    expect(val('=Boolean("FALSE")')).toBe(false)
    expect(val('=Boolean(1)')).toBe(true)
    expect(val('=Boolean(0)')).toBe(false)
    expect(val('=Boolean(Blank())')).toBeNull()
    expect(err('=Boolean("maybe")').message).toMatch(/true\/false/)
  })
})
