import { afterEach, describe, expect, it } from 'vitest'
import { fx, signatureAt } from './index'
import { err, val } from './testutil'

afterEach(() => fx.setUserFunctions([]))

/** `|` marks the caret */
function at(marked: string) {
  const offset = marked.indexOf('|')
  return signatureAt(marked.replace('|', ''), offset)
}
const arg = (marked: string): number | undefined => at(marked)?.argIndex
const name = (marked: string): string | undefined => at(marked)?.name

describe('signatureAt', () => {
  it('finds the function and the first argument', () => {
    const s = at('=Filter(|')!
    expect(s.name).toBe('Filter')
    expect(s.argIndex).toBe(0)
    expect(s.signature).toBe('Filter(table, condition [, condition2, ...])')
    expect(s.summary).toMatch(/Rows of the table/)
  })
  it('counts commas', () => {
    expect(arg('=Filter(Contacts, |')).toBe(1)
    expect(arg('=Filter(Contacts, Age > 3, |')).toBe(2)
    expect(arg('=Filter(Contacts|, Age)')).toBe(0)
    expect(arg('=Filter(Contacts,| Age)')).toBe(1)
    expect(arg('=Filter(Contacts, A|ge)')).toBe(1)
    expect(arg('=Filter(Contacts, Age|)')).toBe(1)
  })
  it('works on unfinished formulas', () => {
    expect(name('=If(a > 1, Left(Name, |')).toBe('Left')
    expect(arg('=If(a > 1, Left(Name, |')).toBe(1)
    expect(name('=Text(Now(), "yyyy|')).toBe('Text')
  })
  it('nested calls: innermost wins, outer resumes after the close', () => {
    expect(name('=If(Len(a|), 1, 2)')).toBe('Len')
    expect(name('=If(Len(a)|, 1, 2)')).toBe('If')
    expect(arg('=If(Len(a), |1, 2)')).toBe(1)
    expect(arg('=If(Len(a), 1, |2)')).toBe(2)
    expect(name('=Sum(Filter(T, x > 1)|)')).toBe('Sum')
  })
  it('commas inside records, tables, strings and brackets belong to those, not the call', () => {
    expect(arg('=Patch(Contacts, {a: 1, b: 2, |c: 3}')).toBe(1)
    expect(arg('=Patch(Contacts, {a: 1, b: 2}, |')).toBe(2)
    expect(arg('=Concat(T, "a,b,c", |')).toBe(2)
    expect(arg('=Concat([1, 2, 3], |')).toBe(1)
    expect(arg("=Concat('a,b', |")).toBe(1)
    expect(arg('=Sum((1, 2), |')).toBe(1)
  })
  it('commas inside text interpolation are ignored', () => {
    expect(arg('=Concat(T, $"{Len(a)}, {b}", |')).toBe(2)
    expect(arg('=Text(1, $"x{1}|y")')).toBe(1)
  })
  it('comments do not count', () => {
    expect(arg('=Filter(T, // a, b, c\n |')).toBe(1)
    expect(arg('=Filter(T, /* , , */ |')).toBe(1)
  })
  it('inside a string the enclosing call still applies', () => {
    expect(name('=Left("he|llo", 2)')).toBe('Left')
    expect(arg('=Left("he,|llo", 2)')).toBe(0)
  })
  it('null outside any call', () => {
    expect(at('=|')).toBeNull()
    expect(at('=a + |b')).toBeNull()
    expect(at('=Len(a)|')).toBeNull()
    expect(at('=Len(a) + |')).toBeNull()
    expect(at('=Len(a|) + 1')?.name).toBe('Len')
    expect(at('=(1 + |2)')).toBeNull()
    expect(at('=Color.|')).toBeNull()
    expect(at('=Gallery1.Selected.Name|')).toBeNull()
  })
  it('null for unknown functions and non-formulas', () => {
    expect(at('=Nope(|')).toBeNull()
    expect(signatureAt('Filter(', 7)).toBeNull()
    expect(signatureAt('', 0)).toBeNull()
    expect(signatureAt('=Filter(', 0)).toBeNull()
  })
  it('the caret before the opening bracket is not inside', () => {
    expect(at('=Len|(a)')).toBeNull()
    expect(at('=Len(|a)')?.name).toBe('Len')
  })
  it('grouping brackets and operators that look like calls', () => {
    expect(name('=Len(a) and (|')).toBeUndefined()
    expect(name('=Left(a, 1) or (b in (|')).toBeUndefined()
    expect(name('=If(a and (b, |')).toBe('If')
    expect(arg('=If(a and (b), |')).toBe(1)
    expect(name('=Or(|')).toBe('Or')
    expect(name('=Not(|')).toBe('Not')
    expect(name('=If(x as (|')).toBe('If')
  })
  it('member names that precede ( are not calls', () => {
    expect(name('=If(a.Len(|')).toBe('If')
  })
  it('is case-insensitive for the tip but reports the real name', () => {
    expect(name('=filter(|')).toBe('Filter')
    expect(name('=FILTER(a, |')).toBe('Filter')
  })
  it('whitespace between name and bracket', () => {
    expect(name('=Filter (T, |')).toBe('Filter')
    expect(arg('=Filter (T, |')).toBe(1)
  })
  it('offsets are clamped and leading whitespace is fine', () => {
    expect(signatureAt('  =Left("a", 1)', 8)?.name).toBe('Left')
    expect(signatureAt('=Left(', 99)?.name).toBe('Left')
    expect(signatureAt('=Left(', -3)).toBeNull()
  })
  it('variadic arguments keep counting', () => {
    expect(arg('=Sum(1, 2, 3, 4, 5, |')).toBe(5)
    expect(arg('=Concatenate(a, b, c, |')).toBe(3)
  })
  it('behaviour functions too', () => {
    const s = at('=Patch(Contacts, |')!
    expect(s.name).toBe('Patch')
    expect(s.signature).toMatch(/^Patch\(/)
    expect(name('=SubmitForm(|')).toBe('SubmitForm')
  })
  it('user-defined functions', () => {
    fx.setUserFunctions([{ name: 'Area', formula: '=w * h', params: [{ name: 'w', type: 'Number' }, { name: 'h', type: 'Number' }], returnType: 'Number' }])
    expect(at('=Area(2, |')).toEqual({ name: 'Area', signature: 'Area(w: Number, h: Number): Number', summary: 'User-defined function returning Number.', argIndex: 1 })
    fx.setUserFunctions([])
    expect(at('=Area(2, |')).toBeNull()
  })
  it('every function has a tip', () => {
    for (const f of fx.functions()) {
      const s = signatureAt(`=${f.name}(`, f.name.length + 2)
      expect(s?.name, f.name).toBe(f.name)
      expect(s?.signature, f.name).toBe(f.signature)
    }
  })
})

describe('registry sanity', () => {
  it('lists every function from SPEC2 section 1', () => {
    const names = new Set(fx.functions().map((f) => f.name))
    const wanted = 'SubmitForm ResetForm NewForm EditForm ViewForm Select SetFocus Launch Copy Trace Exit Refresh Concurrent Download IfError IsError Error IsBlankOrError IsNumeric IsMatch Match MatchAll Char UniChar EncodeUrl PlainText TrimEnds JSON ParseJSON GUID Boolean Exp Ln Log Pi Sin Cos Tan Degrees Radians Trunc StdevP VarP Count CountA Time DateValue TimeValue DateTimeValue EDate EOMonth WeekNum IsToday Second GroupBy Ungroup Shuffle RenameColumns Choices Table Patch Param User Language Now Today'.split(' ')
    for (const n of wanted) expect(names.has(n), n).toBe(true)
  })
  it('all docs have a signature that starts with the name and a summary', () => {
    for (const f of fx.functions()) {
      expect(f.signature.startsWith(f.name), f.name).toBe(true)
      expect(f.summary.length, f.name).toBeGreaterThan(5)
    }
  })
  it('check() accepts every new function name', () => {
    expect(fx.check('=IsMatch("a", "a")')).toEqual([])
    expect(fx.check('=GroupBy(T, "a", "G")')).toEqual([])
    expect(fx.check('=Concurrent(Back(), Back())')).toEqual([])
  })
  it('parse cache does not leak between user-function sets', () => {
    fx.setUserFunctions([{ name: 'F', formula: '=1', params: [] }])
    expect(val('=F()')).toBe(1)
    fx.setUserFunctions([{ name: 'F', formula: '=2', params: [] }])
    expect(val('=F()')).toBe(2)
    fx.setUserFunctions([])
    expect(err('=F()').message).toBe("Function isn't recognised: F")
  })
})
