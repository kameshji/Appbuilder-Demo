import { describe, expect, it } from 'vitest'
import { fx } from './index'
import { err, val } from './testutil'

describe('logic functions', () => {
  it('If', () => {
    expect(val('=If(1 < 2, "y", "n")')).toBe('y')
    expect(val('=If(1 > 2, "y", "n")')).toBe('n')
    expect(val('=If(false, "y")')).toBeNull()
    expect(val('=If(false, 1, true, 2, 3)')).toBe(2)
    expect(val('=If(false, 1, false, 2, 3)')).toBe(3)
    expect(val('=If(Blank(), 1, 2)')).toBe(2)
  })
  it('If is lazy', () => {
    expect(val('=If(true, 1, 1/0)')).toBe(1)
    expect(val('=If(false, 1/0, 2)')).toBe(2)
  })
  it('Switch', () => {
    expect(val('=Switch(2, 1, "one", 2, "two", "other")')).toBe('two')
    expect(val('=Switch(9, 1, "one", 2, "two", "other")')).toBe('other')
    expect(val('=Switch(9, 1, "one")')).toBeNull()
    expect(val('=Switch("B", "a", 1, "b", 2)')).toBe(2)
  })
  it('And / Or / Not', () => {
    expect(val('=And(true, true, true)')).toBe(true)
    expect(val('=And(true, false)')).toBe(false)
    expect(val('=Or(false, false, true)')).toBe(true)
    expect(val('=Or(false, false)')).toBe(false)
    expect(val('=Not(true)')).toBe(false)
  })
  it('IsBlank / IsEmpty / Blank / Coalesce', () => {
    expect(val('=IsBlank(Blank())')).toBe(true)
    expect(val('=IsBlank("")')).toBe(true)
    expect(val('=IsBlank("a")')).toBe(false)
    expect(val('=IsBlank(0)')).toBe(false)
    expect(val('=IsEmpty([])')).toBe(true)
    expect(val('=IsEmpty([1])')).toBe(false)
    expect(val('=IsEmpty(Blank())')).toBe(true)
    expect(val('=Blank()')).toBeNull()
    expect(val('=Coalesce(Blank(), "", "x", "y")')).toBe('x')
    expect(val('=Coalesce(Blank(), "")')).toBeNull()
    expect(val('=Coalesce(5, 1/0)')).toBe(5)
  })
  it('IfError', () => {
    expect(val('=IfError(1 / 0, "oops")')).toBe('oops')
    expect(val('=IfError(5, "oops")')).toBe(5)
    expect(val('=IfError(Value("x"), -1)')).toBe(-1)
  })
  it('IfError does not hide unknown names', () => {
    expect(err('=IfError(Nope, 1)').message).toBe("Name isn't recognised: Nope")
  })
  it('With', () => {
    expect(val('=With({a: 2, b: 3}, a * b)')).toBe(6)
    expect(val('=With({a: 2}, With({b: a + 1}, a + b))')).toBe(5)
    expect(val('=With({a: 2}, ThisRecord.a)')).toBe(2)
    expect(err('=With(5, 1)').message).toMatch(/needs a record/)
  })
})

describe('text functions', () => {
  it('Text with number formats', () => {
    expect(val('=Text(3.14159, "0.00")')).toBe('3.14')
    expect(val('=Text(2, "0.00")')).toBe('2.00')
    expect(val('=Text(1234567.891, "#,##0")')).toBe('1,234,568')
    expect(val('=Text(1234.5, "#,##0.00")')).toBe('1,234.50')
    expect(val('=Text(5, "000")')).toBe('005')
    expect(val('=Text(0.256, "0%")')).toBe('26%')
    expect(val('=Text(-42.5, "0.0")')).toBe('-42.5')
    expect(val('=Text(1234, "$#,##0")')).toBe('$1,234')
    expect(val('=Text(2.5, "0")')).toBe('3')
    expect(val('=Text(12, "#")')).toBe('12')
    expect(val('=Text(1.5)')).toBe('1.5')
    expect(val('=Text(Blank(), "0.00")')).toBe('')
  })
  it('Text with date formats', () => {
    const d = 'Date(2024, 3, 5)'
    expect(val(`=Text(${d}, "dd/mm/yyyy")`)).toBe('05/03/2024'.replace('03', '03'))
    expect(val(`=Text(${d}, "yyyy-mm-dd")`)).toBe('2024-03-05')
    expect(val(`=Text(DateAdd(${d}, 14.5, "Hours"), "hh:mm")`)).toBe('14:30')
    expect(val(`=Text(${d}, "d mmm yy")`)).toBe('5 Mar 24')
    expect(val(`=Text(${d}, "dddd, mmmm d")`)).toBe('Tuesday, March 5')
    expect(val(`=Text(DateAdd(${d}, 15, "Hours"), "h:mm AM/PM")`)).toBe('3:00 PM')
    expect(val('=Text("2024-12-25", "dd/mm/yyyy")')).toBe('25/12/2024')
  })
  it('Value', () => {
    expect(val('=Value("12.5")')).toBe(12.5)
    expect(val('=Value("1,234")')).toBe(1234)
    expect(val('=Value("50%")')).toBe(0.5)
    expect(val('=Value("")')).toBeNull()
    expect(val('=Value(7)')).toBe(7)
    expect(err('=Value("abc")').message).toMatch(/Can't turn the text "abc" into a number/)
  })
  it('Len Left Mid Right', () => {
    expect(val('=Len("hello")')).toBe(5)
    expect(val('=Len(Blank())')).toBe(0)
    expect(val('=Left("hello", 2)')).toBe('he')
    expect(val('=Left("hi", 10)')).toBe('hi')
    expect(val('=Right("hello", 3)')).toBe('llo')
    expect(val('=Right("hello", 0)')).toBe('')
    expect(val('=Mid("hello", 2, 3)')).toBe('ell')
    expect(val('=Mid("hello", 3)')).toBe('llo')
  })
  it('case and trim', () => {
    expect(val('=Lower("AbC")')).toBe('abc')
    expect(val('=Upper("AbC")')).toBe('ABC')
    expect(val('=Proper("hello wORLD of fx")')).toBe('Hello World Of Fx')
    expect(val('=Trim("  a   b  ")')).toBe('a b')
  })
  it('Concatenate / Concat', () => {
    expect(val('=Concatenate("a", 1, "b")')).toBe('a1b')
    expect(val('=Concat([1, 2, 3], Value, ", ")')).toBe('1, 2, 3')
    expect(val('=Concat([{n: "a"}, {n: "b"}], n)')).toBe('ab')
    expect(val('=Concat([], "x")')).toBe('')
  })
  it('Substitute / Replace / Find', () => {
    expect(val('=Substitute("a-b-c", "-", "+")')).toBe('a+b+c')
    expect(val('=Substitute("a-b-c", "-", "+", 2)')).toBe('a-b+c')
    expect(val('=Substitute("abc", "", "x")')).toBe('abc')
    expect(val('=Replace("abcdef", 2, 3, "X")')).toBe('aXef')
    expect(val('=Find("lo", "hello")')).toBe(4)
    expect(val('=Find("z", "hello")')).toBeNull()
    expect(val('=Find("l", "hello", 4)')).toBe(4)
  })
  it('StartsWith / EndsWith / Split', () => {
    expect(val('=StartsWith("Hello", "he")')).toBe(true)
    expect(val('=StartsWith("Hello", "lo")')).toBe(false)
    expect(val('=EndsWith("Hello", "LO")')).toBe(true)
    expect(val('=Split("a,b,c", ",")')).toEqual([{ Value: 'a' }, { Value: 'b' }, { Value: 'c' }])
    expect(val('=CountRows(Split("abc", ""))')).toBe(3)
  })
})

describe('math functions', () => {
  it('rounding', () => {
    expect(val('=Round(2.5, 0)')).toBe(3)
    expect(val('=Round(-2.5)')).toBe(-3)
    expect(val('=Round(1.005, 2)')).toBe(1.01)
    expect(val('=Round(1234, -2)')).toBe(1200)
    expect(val('=RoundUp(1.21, 1)')).toBe(1.3)
    expect(val('=RoundUp(-1.21, 1)')).toBe(-1.3)
    expect(val('=RoundDown(1.99, 1)')).toBe(1.9)
    expect(val('=RoundDown(-1.99)')).toBe(-1)
    expect(val('=Int(-1.5)')).toBe(-2)
    expect(val('=Int(2.9)')).toBe(2)
  })
  it('Abs Mod Sqrt Power', () => {
    expect(val('=Abs(-3)')).toBe(3)
    expect(val('=Mod(10, 3)')).toBe(1)
    expect(val('=Mod(-1, 3)')).toBe(2)
    expect(err('=Mod(1, 0)').message).toMatch(/divide by zero/)
    expect(val('=Sqrt(16)')).toBe(4)
    expect(err('=Sqrt(-1)').message).toMatch(/negative/)
    expect(val('=Power(2, 10)')).toBe(1024)
  })
  it('aggregates over scalars', () => {
    expect(val('=Min(3, 1, 2)')).toBe(1)
    expect(val('=Max(3, 1, 2)')).toBe(3)
    expect(val('=Sum(1, 2, 3)')).toBe(6)
    expect(val('=Average(2, 4)')).toBe(3)
    expect(val('=Sum(5)')).toBe(5)
  })
  it('aggregates over tables', () => {
    expect(val('=Sum([1, 2, 3])')).toBe(6)
    expect(val('=Sum(t, n)', { t: [{ n: 1 }, { n: 2 }] })).toBe(3)
    expect(val('=Sum(t, n * 2)', { t: [{ n: 1 }, { n: 2 }] })).toBe(6)
    expect(val('=Max(t, n)', { t: [{ n: 1 }, { n: 7 }] })).toBe(7)
    expect(val('=Min(t, n)', { t: [{ n: 4 }, { n: 7 }] })).toBe(4)
    expect(val('=Average(t, n)', { t: [{ n: 4 }, { n: 8 }] })).toBe(6)
    expect(val('=Average([])')).toBeNull()
    expect(val('=Sum(t As r, r.n)', { t: [{ n: 4 }, { n: 8 }] })).toBe(12)
    expect(val('=Sum(t, n)', { t: [{ n: 4 }, { n: null }] })).toBe(4)
  })
  it('Rand / RandBetween', () => {
    for (let i = 0; i < 20; i++) {
      const r = val('=Rand()') as number
      expect(r >= 0 && r < 1).toBe(true)
      const b = val('=RandBetween(3, 5)') as number
      expect(Number.isInteger(b) && b >= 3 && b <= 5).toBe(true)
    }
  })
})

describe('date functions', () => {
  it('Now / Today', () => {
    expect(val('=Now()')).toBeInstanceOf(Date)
    const t = val('=Today()') as Date
    expect(t.getHours()).toBe(0)
  })
  it('Date and parts', () => {
    expect(val('=Year(Date(2024, 3, 5))')).toBe(2024)
    expect(val('=Month(Date(2024, 3, 5))')).toBe(3)
    expect(val('=Day(Date(2024, 3, 5))')).toBe(5)
    expect(val('=Hour(DateAdd(Date(2024, 3, 5), 5, "Hours"))')).toBe(5)
    expect(val('=Minute(DateAdd(Date(2024, 3, 5), 45, "Minutes"))')).toBe(45)
    expect(val('=Month(Date(2024, 14, 1))')).toBe(2)
    expect(val('=Year(Blank())')).toBeNull()
    expect(val('=Year("2023-06-01")')).toBe(2023)
  })
  it('Weekday', () => {
    expect(val('=Weekday(Date(2024, 3, 5))')).toBe(3) // Tuesday, Sunday = 1
    expect(val('=Weekday(Date(2024, 3, 5), 2)')).toBe(2)
    expect(val('=Weekday(Date(2024, 3, 10))')).toBe(1) // Sunday
    expect(val('=Weekday(Date(2024, 3, 10), 2)')).toBe(7)
    expect(val('=Weekday(Date(2024, 3, 4), 3)')).toBe(0)
  })
  it('DateAdd', () => {
    expect(val('=Text(DateAdd(Date(2024, 1, 31), 1, "Months"), "yyyy-mm-dd")')).toBe('2024-02-29')
    expect(val('=Text(DateAdd(Date(2024, 1, 31), 1, "Days"), "yyyy-mm-dd")')).toBe('2024-02-01')
    expect(val('=Text(DateAdd(Date(2024, 2, 29), 1, "Years"), "yyyy-mm-dd")')).toBe('2025-02-28')
    expect(val('=Text(DateAdd(Date(2024, 3, 5), -5, "Days"), "yyyy-mm-dd")')).toBe('2024-02-29')
    expect(err('=DateAdd(Today(), 1, "Fortnights")').message).toMatch(/Unknown unit/)
  })
  it('DateDiff', () => {
    expect(val('=DateDiff(Date(2024, 1, 1), Date(2024, 3, 1))')).toBe(60)
    expect(val('=DateDiff(Date(2024, 1, 15), Date(2024, 3, 1), "Months")')).toBe(2)
    expect(val('=DateDiff(Date(2020, 6, 1), Date(2024, 3, 1), "Years")')).toBe(4)
    expect(val('=DateDiff(Date(2024, 3, 1), Date(2024, 1, 1), "Days")')).toBe(-60)
    expect(val('=DateDiff(Date(2024, 3, 1), DateAdd(Date(2024, 3, 1), 90, "Minutes"), "Hours")')).toBe(1)
  })
  it('date arithmetic and comparison', () => {
    expect(val('=Day(Date(2024, 3, 5) + 2)')).toBe(7)
    expect(val('=Date(2024, 3, 5) - Date(2024, 3, 1)')).toBe(4)
    expect(val('=Date(2024, 3, 5) > Date(2024, 3, 1)')).toBe(true)
    expect(val('=Date(2024, 3, 5) = Date(2024, 3, 5)')).toBe(true)
  })
})

describe('colour functions and enums', () => {
  it('RGBA', () => {
    expect(val('=RGBA(79, 70, 229, 1)')).toBe('rgba(79, 70, 229, 1)')
    expect(val('=RGBA(300, -5, 0, 0.5)')).toBe('rgba(255, 0, 0, 0.5)')
  })
  it('ColorValue / ColorFade', () => {
    expect(val('=ColorValue("#4f46e5")')).toBe('rgba(79, 70, 229, 1)')
    expect(val('=ColorValue("#fff")')).toBe('rgba(255, 255, 255, 1)')
    expect(val('=ColorValue("rgb(1, 2, 3)")')).toBe('rgba(1, 2, 3, 1)')
    expect(val('=ColorValue("white")')).toBe(val('=Color.White'))
    expect(val('=ColorFade(RGBA(0, 0, 0, 1), 0.5)')).toBe('rgba(128, 128, 128, 1)')
    expect(val('=ColorFade(RGBA(100, 200, 50, 0.5), -0.5)')).toBe('rgba(50, 100, 25, 0.5)')
    expect(err('=ColorValue("nope")').message).toMatch(/Can't read the colour/)
  })
  it('enums', () => {
    expect(val('=Align.Center')).toBe('Center')
    expect(val('=FontWeight.Bold')).toBe('Bold')
    expect(val('=DisplayMode.Disabled')).toBe('Disabled')
    expect(val('=SortOrder.Descending')).toBe('Descending')
    expect(val('=NotificationType.Success')).toBe('Success')
    expect(val('=ButtonStyle.Destructive')).toBe('Destructive')
    expect(val('=Color.Red')).toMatch(/^rgba\(/)
    expect(val('=Color.Transparent')).toBe('rgba(0, 0, 0, 0)')
    expect(val('=Align.Left = "left"')).toBe(true)
    expect(err('=Align.Middle').message).toBe("Align doesn't have a member called Middle")
  })
  it('enums() and functions() listings', () => {
    const e = fx.enums()
    expect(e.Align).toEqual(['Left', 'Center', 'Right'])
    expect(e.Color).toContain('Purple')
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['Color', 'Align', 'FontWeight', 'DisplayMode', 'SortOrder', 'NotificationType', 'ButtonStyle']))
    const f = fx.functions()
    expect(f.length).toBeGreaterThan(90)
    expect(f.find((x) => x.name === 'Filter')?.kind).toBe('pure')
    expect(f.find((x) => x.name === 'Patch')?.kind).toBe('behaviour')
    expect(f.every((x) => x.signature.startsWith(x.name) && x.summary.length > 0)).toBe(true)
  })
})

describe('function errors', () => {
  it('unknown function and did-you-mean', () => {
    const e = err('=filter(Contacts, true)', { Contacts: [] })
    expect(e.message).toBe('Did you mean Filter?')
    expect(e.start).toBe(1)
    expect(e.end).toBe(7)
    expect(err('=Foo(1)').message).toBe("Function isn't recognised: Foo")
  })
  it('arity', () => {
    expect(err('=Len()').message).toBe('Len needs 1 argument')
    expect(err('=Len(1, 2)').message).toBe('Len takes at most 1 argument')
    expect(err('=If(true)').message).toMatch(/at least 2/)
  })
  it('unknown names', () => {
    const e = err('=Buton1.Text')
    expect(e.message).toBe("Name isn't recognised: Buton1")
    expect(e.start).toBe(1)
    expect(e.end).toBe(7)
    expect(err('=Filter').message).toMatch(/is a function/)
  })
  it('host resolve errors surface with their message', () => {
    const r = fx.evaluate('=a + 1', { resolve: () => { throw new Error('Circular reference') } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('Circular reference')
  })
})
