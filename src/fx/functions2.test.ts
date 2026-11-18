import { describe, expect, it } from 'vitest'
import { err, val } from './testutil.ts'

/** table-driven: [formula, expected] */
function table(rows: [string, unknown][], vars: Record<string, never> = {}): void {
  for (const [src, want] of rows) expect(val(src, vars), src).toEqual(want)
}
/** embeds JSON text in a formula string literal ("" escapes the quote) */
const q = (json: string): string => json.replace(/"/g, '""')
const near = (src: string, want: number, digits = 9) => expect(val(src) as number, src).toBeCloseTo(want, digits)

describe('regular expressions', () => {
  it('IsMatch must match the whole text by default', () => {
    table([
      ['=IsMatch("abc123", "[a-z]+\\d+")', true],
      ['=IsMatch("abc123", "[a-z]+")', false],
      ['=IsMatch("abc", "b")', false],
      ['=IsMatch("", "")', true],
      ['=IsMatch("2024-03-05", "\\d{4}-\\d{2}-\\d{2}")', true],
    ])
  })
  it('IsMatch options', () => {
    table([
      ['=IsMatch("abc", "b", MatchOptions.Contains)', true],
      ['=IsMatch("abc", "^b", MatchOptions.Contains)', false],
      ['=IsMatch("abc", "ab", MatchOptions.BeginsWith)', true],
      ['=IsMatch("abc", "bc", MatchOptions.BeginsWith)', false],
      ['=IsMatch("abc", "bc", MatchOptions.EndsWith)', true],
      ['=IsMatch("ABC", "abc")', false],
      ['=IsMatch("ABC", "abc", MatchOptions.IgnoreCase)', true],
      ['=IsMatch("ABC", "b", MatchOptions.Contains & MatchOptions.IgnoreCase)', true],
      ['=IsMatch("a\nb", "^b$", MatchOptions.Contains & MatchOptions.Multiline)', true],
    ])
  })
  it('Match enum patterns', () => {
    table([
      ['=IsMatch("12345", Match.MultipleDigits)', true],
      ['=IsMatch("123a", Match.MultipleDigits)', false],
      ['=IsMatch("Hello", Match.MultipleLetters)', true],
      ['=IsMatch("asha@x.dev", Match.Email)', true],
      ['=IsMatch("not an email", Match.Email)', false],
      ['=IsMatch("a-b", Match.Letter & Match.Hyphen & Match.Letter)', true],
      ['=IsMatch("(1)", Match.LeftParen & Match.Digit & Match.RightParen)', true],
    ])
  })
  it('Match returns a record or blank', () => {
    const m = val('=Match("order 4711 shipped", "\\d+")') as Record<string, unknown>
    expect(m.FullMatch).toBe('4711')
    expect(m.StartMatch).toBe(7)
    expect(m.SubMatches).toEqual([])
    expect(val('=Match("none here", "\\d+")')).toBeNull()
    expect(val('=IsBlank(Match("none here", "\\d+"))')).toBe(true)
    expect(val('=Match("order 4711", "\\d+").FullMatch')).toBe('4711')
  })
  it('Match captures: SubMatches and named groups', () => {
    const m = val('=Match("2024-03-05", "(\\d+)-(\\d+)-(\\d+)")') as Record<string, unknown>
    expect(m.SubMatches).toEqual([{ Value: '2024' }, { Value: '03' }, { Value: '05' }])
    const n = val('=Match("Asha <asha@x.dev>", "(?<name>\\w+) <(?<mail>[^>]+)>")') as Record<string, unknown>
    expect(n.name).toBe('Asha')
    expect(n.mail).toBe('asha@x.dev')
    expect(n.SubMatches).toEqual([])
    const mixed = val('=Match("k=v", "(?<key>\\w)=(\\w)")') as Record<string, unknown>
    expect(mixed.key).toBe('k')
    expect(mixed.SubMatches).toEqual([{ Value: 'v' }])
  })
  it('Match options', () => {
    expect(val('=Match("ABC", "b", MatchOptions.IgnoreCase).FullMatch')).toBe('B')
    expect(val('=Match("abc", "b", MatchOptions.Complete)')).toBeNull()
    expect(val('=Match("abc", "a.c", MatchOptions.Complete).FullMatch')).toBe('abc')
  })
  it('MatchAll returns every match', () => {
    const all = val('=MatchAll("a1 b22 c333", "\\d+")') as Record<string, unknown>[]
    expect(all.map((r) => r.FullMatch)).toEqual(['1', '22', '333'])
    expect(all.map((r) => r.StartMatch)).toEqual([2, 5, 9])
    expect(val('=CountRows(MatchAll("none", "\\d"))')).toBe(0)
    expect(val('=Concat(MatchAll("x=1, y=2", "(\\w)=(\\d)"), Index(SubMatches, 1).Value, "+")')).toBe('x+y')
    expect(val('=Sum(ForAll(MatchAll("3 4 5", "\\d"), Value(FullMatch)), Value)')).toBe(12)
  })
  it('zero-length matches do not loop forever', () => {
    expect(val('=CountRows(MatchAll("abc", "x*"))')).toBe(4)
  })
  it('bad patterns are reported', () => {
    expect(err('=IsMatch("a", "(")').message).toMatch(/^Invalid pattern:/)
    expect(err('=Match("a", "[")').message).toMatch(/^Invalid pattern:/)
    expect(err('=IsMatch("a", "(")').start).toBe(14)
  })
  it('blank text is treated as empty text', () => {
    expect(val('=IsMatch(Blank(), "")')).toBe(true)
    expect(val('=Match(Blank(), "a")')).toBeNull()
  })
})

describe('text helpers', () => {
  it('Char / UniChar', () => {
    table([
      ['=Char(65)', 'A'],
      ['=Char(97)', 'a'],
      ['=Char(10)', '\n'],
      ['=UniChar(65)', 'A'],
      ['=UniChar(8364)', '€'],
      ['=UniChar(128512)', '😀'],
    ])
    expect(err('=Char(0)').message).toBe('Char needs a number from 1 to 255')
    expect(err('=Char(256)').message).toBe('Char needs a number from 1 to 255')
    expect(err('=UniChar(0)').message).toMatch(/valid Unicode/)
    expect(err('=UniChar(55296)').message).toMatch(/valid Unicode/)
  })
  it('EncodeUrl', () => {
    table([
      ['=EncodeUrl("a b&c=d")', 'a%20b%26c%3Dd'],
      ['=EncodeUrl("café")', 'caf%C3%A9'],
      ['=EncodeUrl("")', ''],
      ['=EncodeUrl("x/y?z")', 'x%2Fy%3Fz'],
    ])
  })
  it('PlainText', () => {
    table([
      ['=PlainText("<p>Hello <b>world</b></p>")', 'Hello world'],
      ['=PlainText("Tom &amp; Jerry")', 'Tom & Jerry'],
      ['=PlainText("1 &lt; 2 &gt; 0")', '1 < 2 > 0'],
      ['=PlainText("&quot;hi&quot;&nbsp;there")', '"hi" there'],
      ['=PlainText("&#65;&#x42;")', 'AB'],
      ['=PlainText("no tags")', 'no tags'],
    ])
  })
  it('TrimEnds keeps inner spaces, Trim collapses them', () => {
    table([
      ['=TrimEnds("  a   b  ")', 'a   b'],
      ['=Trim("  a   b  ")', 'a b'],
      ['=TrimEnds("")', ''],
      ['=Len(TrimEnds("   "))', 0],
    ])
  })
})

describe('Text with more formats', () => {
  const d = 'Date(2024, 3, 5)'
  it('dates', () => {
    table([
      [`=Text(${d}, "mmm d, yyyy")`, 'Mar 5, 2024'],
      [`=Text(${d}, "mmmm d, yyyy")`, 'March 5, 2024'],
      [`=Text(${d}, "dddd")`, 'Tuesday'],
      [`=Text(${d}, "ddd")`, 'Tue'],
      [`=Text(${d}, "dd/mm/yyyy")`, '05/03/2024'],
      [`=Text(${d}, "yyyy-mm-dd")`, '2024-03-05'],
      [`=Text(${d}, "dddd, mmmm d")`, 'Tuesday, March 5'],
      [`=Text(${d}, "mmm yyyy")`, 'Mar 2024'],
      [`=Text(${d}, "yy")`, '24'],
    ])
  })
  it('times', () => {
    const t = 'DateAdd(Date(2024, 3, 5), 14.5, "Hours")'
    table([
      [`=Text(${t}, "h:mm AM/PM")`, '2:30 PM'],
      [`=Text(${t}, "hh:mm")`, '14:30'],
      [`=Text(${t}, "h:mm am/pm")`, '2:30 pm'],
      [`=Text(DateAdd(Date(2024, 3, 5), 9, "Hours"), "h:mm AM/PM")`, '9:00 AM'],
      [`=Text(DateAdd(Date(2024, 3, 5), 0, "Hours"), "h:mm AM/PM")`, '12:00 AM'],
      [`=Text(DateAdd(Date(2024, 3, 5), 12, "Hours"), "h:mm AM/PM")`, '12:00 PM'],
      [`=Text(${t}, "mmm d, yyyy h:mm AM/PM")`, 'Mar 5, 2024 2:30 PM'],
    ])
  })
  it('currency and percent', () => {
    table([
      ['=Text(1234.5, "$#,##0.00")', '$1,234.50'],
      ['=Text(0, "$#,##0.00")', '$0.00'],
      ['=Text(-1234.5, "$#,##0.00")', '-$1,234.50'],
      ['=Text(1234567.891, "$#,##0.00")', '$1,234,567.89'],
      ['=Text(0.256, "0%")', '26%'],
      ['=Text(0.256, "0.0%")', '25.6%'],
      ['=Text(1, "0%")', '100%'],
      ['=Text(12, "#,##0")', '12'],
      ['=Text(5, "000")', '005'],
    ])
  })
})

describe('JSON and ParseJSON', () => {
  it('JSON of scalars, records and tables', () => {
    table([
      ['=JSON(5)', '5'],
      ['=JSON("a""b")', '"a\\"b"'],
      ['=JSON(true)', 'true'],
      ['=JSON(Blank())', 'null'],
      ['=JSON({a: 1, b: "x"})', '{"a":1,"b":"x"}'],
      ['=JSON([{a: 1}, {a: 2}])', '[{"a":1},{"a":2}]'],
      ['=JSON({n: {m: [1, 2]}})', '{"n":{"m":[{"Value":1},{"Value":2}]}}'],
    ])
  })
  it('JSON drops __id and writes dates as ISO text', () => {
    expect(val('=JSON(First(T))', { T: [{ __id: 'x', a: 1 }] })).toBe('{"a":1}')
    expect(val('=JSON(Date(2024, 3, 5))') as string).toMatch(/^"2024-03-0[45]T/)
  })
  it('JSON indent', () => {
    expect(val('=JSON({a: 1}, 2)')).toBe('{\n  "a": 1\n}')
    expect(val('=JSON({a: 1}, 0)')).toBe('{"a":1}')
    expect(val('=JSON({a: 1}, "\t")')).toBe('{\n\t"a": 1\n}')
    expect(val('=JSON({a: 1}, 99)')).toBe('{\n          "a": 1\n}')
  })
  it('ParseJSON to records, tables and scalars', () => {
    table([
      [`=ParseJSON("${q('{"a": 1, "b": "x", "c": null, "d": true}')}")`, { a: 1, b: 'x', c: null, d: true }],
      [`=ParseJSON("${q('[{"a": 1}, {"a": 2}]')}")`, [{ a: 1 }, { a: 2 }]],
      ['=ParseJSON("[1, 2, 3]")', [{ Value: 1 }, { Value: 2 }, { Value: 3 }]],
      ['=ParseJSON("42")', 42],
      [`=ParseJSON("${q('"hi"')}")`, 'hi'],
      ['=ParseJSON("null")', null],
      ['=ParseJSON("")', null],
      [`=ParseJSON("${q('{"o": {"p": [1]}}')}")`, { o: { p: [{ Value: 1 }] } }],
    ])
  })
  it('ParseJSON results work with the rest of the language', () => {
    expect(val(`=ParseJSON("${q('{"user": {"name": "Asha"}}')}").user.name`)).toBe('Asha')
    expect(val(`=Sum(ParseJSON("${q('[{"n": 2}, {"n": 3}]')}"), n)`)).toBe(5)
    expect(val('=CountRows(Table(ParseJSON("[1, 2]"), {Value: 3}))')).toBe(3)
    expect(val(`=First(ParseJSON("${q('[{"n": 7}]')}")).n`)).toBe(7)
  })
  it('JSON round trip', () => {
    expect(val('=ParseJSON(JSON({a: 1, b: [{c: 2}]}))')).toEqual({ a: 1, b: [{ c: 2 }] })
  })
  it('ParseJSON on bad input', () => {
    expect(err('=ParseJSON("{oops")').message).toMatch(/^That isn't valid JSON/)
    expect(err('=ParseJSON("{oops")').start).toBe(11)
  })
  it('ParseJSON keeps a __proto__ key as plain data', () => {
    const r = val(`=ParseJSON("${q('{"__proto__": 1, "a": 2}')}")`) as Record<string, unknown>
    expect(r.a).toBe(2)
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype)
  })
})

describe('GUID', () => {
  it('is a new v4-looking id each time', () => {
    const a = val('=GUID()') as string
    const b = val('=GUID()') as string
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })
  it('parses text', () => {
    expect(val('=GUID("{A1B2C3D4-0000-4000-8000-123456789ABC}")')).toBe('a1b2c3d4-0000-4000-8000-123456789abc')
    expect(val('=GUID("a1b2c3d4000040008000123456789abc")')).toBe('a1b2c3d4-0000-4000-8000-123456789abc')
    expect(err('=GUID("nope")').message).toMatch(/GUID/)
  })
})

describe('maths', () => {
  it('Exp / Ln / Log', () => {
    near('=Exp(1)', Math.E)
    near('=Exp(0)', 1)
    near('=Ln(Exp(3))', 3)
    near('=Log(1000)', 3)
    near('=Log(8, 2)', 3)
    near('=Log(100, 10)', 2)
    expect(err('=Ln(0)').message).toMatch(/logarithm/)
    expect(err('=Log(-5)').message).toMatch(/logarithm/)
    expect(err('=Log(5, 1)').message).toMatch(/base/)
  })
  it('Pi and trigonometry', () => {
    near('=Pi()', Math.PI)
    near('=Sin(Pi() / 2)', 1)
    near('=Cos(0)', 1)
    near('=Cos(Pi())', -1)
    near('=Tan(Pi() / 4)', 1)
    near('=Sin(0)', 0)
    near('=Degrees(Pi())', 180)
    near('=Radians(180)', Math.PI)
    near('=Degrees(Radians(45))', 45)
  })
  it('Trunc', () => {
    table([
      ['=Trunc(3.99)', 3],
      ['=Trunc(-3.99)', -3],
      ['=Trunc(3.14159, 2)', 3.14],
      ['=Trunc(1234.5, -2)', 1200],
      ['=Trunc(0.9999)', 0],
    ])
  })
  it('Count and CountA', () => {
    const T = { T: [{ n: 1, s: 'a' }, { n: null, s: '' }, { n: 3, s: 'c' }, { n: 'x', s: null }] as never }
    expect(val('=Count(T, n)', T)).toBe(2)
    expect(val('=CountA(T, n)', T)).toBe(3)
    expect(val('=CountA(T, s)', T)).toBe(2)
    expect(val('=Count(T.n)', T)).toBe(2)
    expect(val('=CountA(T.s)', T)).toBe(2)
    expect(val('=Count(1, 2, "x", Blank())')).toBe(2)
    expect(val('=CountA(1, "", Blank(), "z")')).toBe(2)
    expect(val('=Count(Sequence(5))')).toBe(5)
    expect(val('=Count(Filter(T, false), n)', T)).toBe(0)
  })
  it('StdevP and VarP', () => {
    near('=VarP(2, 4, 4, 4, 5, 5, 7, 9)', 4)
    near('=StdevP(2, 4, 4, 4, 5, 5, 7, 9)', 2)
    expect(val('=VarP(5, 5, 5)')).toBe(0)
    expect(val('=StdevP([{a: 1}, {a: 3}], a)')).toBe(1)
    expect(val('=VarP([{a: 1}, {a: 3}], a)')).toBe(1)
    expect(val('=StdevP(Filter(T, false), a)', { T: [{ a: 1 }] as never })).toBeNull()
    expect(val('=VarP(Blank())')).toBeNull()
  })
})

describe('dates and times', () => {
  const ymd = (src: string): string => {
    const v = val(src) as Date
    return `${v.getFullYear()}-${v.getMonth() + 1}-${v.getDate()}`
  }
  it('Time and Second', () => {
    const t = val('=Time(14, 30, 15)') as Date
    expect([t.getHours(), t.getMinutes(), t.getSeconds()]).toEqual([14, 30, 15])
    expect(val('=Hour(Time(9, 5, 0))')).toBe(9)
    expect(val('=Minute(Time(9, 5, 0))')).toBe(5)
    expect(val('=Second(Time(9, 5, 42))')).toBe(42)
    expect(val('=Second(Blank())')).toBeNull()
    expect(val('=Text(Time(23, 5, 0), "hh:mm")')).toBe('23:05')
  })
  it('DateValue', () => {
    expect(ymd('=DateValue("2024-03-05")')).toBe('2024-3-5')
    expect(ymd('=DateValue("2024-03-05 14:30")')).toBe('2024-3-5')
    expect(val('=Hour(DateValue("2024-03-05 14:30"))')).toBe(0)
    expect(ymd('=DateValue("March 5, 2024")')).toBe('2024-3-5')
    expect(val('=DateValue(Blank())')).toBeNull()
    expect(val('=DateValue("")')).toBeNull()
    expect(err('=DateValue("not a date")').message).toMatch(/into a date/)
    expect(ymd('=DateValue(Date(2024, 1, 31))')).toBe('2024-1-31')
  })
  it('DateTimeValue', () => {
    const d = val('=DateTimeValue("2024-03-05 14:30:15")') as Date
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2024, 2, 5, 14, 30, 15])
    expect(val('=Minute(DateTimeValue("2024-03-05T08:45"))')).toBe(45)
    expect(val('=Hour(DateTimeValue("2024-03-05"))')).toBe(0)
    expect(val('=DateTimeValue(Blank())')).toBeNull()
    expect(err('=DateTimeValue("x")').message).toMatch(/into a date/)
  })
  it('TimeValue', () => {
    const hm = (s: string) => {
      const t = val(`=TimeValue("${s}")`) as Date
      return [t.getHours(), t.getMinutes(), t.getSeconds()]
    }
    expect(hm('14:30')).toEqual([14, 30, 0])
    expect(hm('2:30 PM')).toEqual([14, 30, 0])
    expect(hm('2:30 am')).toEqual([2, 30, 0])
    expect(hm('12:00 AM')).toEqual([0, 0, 0])
    expect(hm('12:15 PM')).toEqual([12, 15, 0])
    expect(hm('23:59:58')).toEqual([23, 59, 58])
    expect(hm('2024-03-05 08:10')).toEqual([8, 10, 0])
    expect(val('=TimeValue(Blank())')).toBeNull()
    expect(err('=TimeValue("25:00")').message).toMatch(/into a time/)
    expect(err('=TimeValue("13:00 PM")').message).toMatch(/into a time/)
    expect(err('=TimeValue("noon")').message).toMatch(/into a time/)
  })
  it('EDate', () => {
    expect(ymd('=EDate(Date(2024, 1, 15), 1)')).toBe('2024-2-15')
    expect(ymd('=EDate(Date(2024, 1, 31), 1)')).toBe('2024-2-29')
    expect(ymd('=EDate(Date(2023, 1, 31), 1)')).toBe('2023-2-28')
    expect(ymd('=EDate(Date(2024, 3, 31), -1)')).toBe('2024-2-29')
    expect(ymd('=EDate(Date(2024, 11, 30), 3)')).toBe('2025-2-28')
    expect(ymd('=EDate(Date(2024, 5, 10), 0)')).toBe('2024-5-10')
    expect(val('=EDate(Blank(), 1)')).toBeNull()
  })
  it('EOMonth', () => {
    expect(ymd('=EOMonth(Date(2024, 1, 15), 0)')).toBe('2024-1-31')
    expect(ymd('=EOMonth(Date(2024, 1, 15), 1)')).toBe('2024-2-29')
    expect(ymd('=EOMonth(Date(2023, 1, 15), 1)')).toBe('2023-2-28')
    expect(ymd('=EOMonth(Date(2024, 12, 5), 1)')).toBe('2025-1-31')
    expect(ymd('=EOMonth(Date(2024, 3, 5), -3)')).toBe('2023-12-31')
    expect(val('=EOMonth(Blank(), 0)')).toBeNull()
  })
  it('WeekNum', () => {
    expect(val('=WeekNum(Date(2024, 1, 1))')).toBe(1)
    expect(val('=WeekNum(Date(2024, 1, 6))')).toBe(1)
    expect(val('=WeekNum(Date(2024, 1, 7))')).toBe(2)
    expect(val('=WeekNum(Date(2024, 12, 31))')).toBe(53)
    expect(val('=WeekNum(Date(2024, 3, 5))')).toBe(10)
    expect(val('=WeekNum(Date(2024, 1, 7), 2)')).toBe(1)
    expect(val('=WeekNum(Date(2024, 1, 8), 2)')).toBe(2)
    expect(val('=WeekNum(Date(2024, 1, 1), 21)')).toBe(1)
    expect(val('=WeekNum(Date(2021, 1, 3), 21)')).toBe(53)
    expect(val('=WeekNum(Date(2024, 12, 30), 21)')).toBe(1)
    expect(val('=WeekNum(Blank())')).toBeNull()
    expect(err('=WeekNum(Today(), 5)').message).toMatch(/Start of week/)
  })
  it('IsToday', () => {
    expect(val('=IsToday(Today())')).toBe(true)
    expect(val('=IsToday(Now())')).toBe(true)
    expect(val('=IsToday(Today() + 1)')).toBe(false)
    expect(val('=IsToday(DateAdd(Today(), -1, "Days"))')).toBe(false)
    expect(val('=IsToday(Blank())')).toBe(false)
  })
})
