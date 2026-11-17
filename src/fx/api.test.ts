import { describe, expect, it } from 'vitest'
import { check, enums, evaluate, fx, functions, referencedNames, renameIdentifier } from './index'
import { val } from './testutil'

describe('referencedNames', () => {
  it('lists bare identifiers once, in order', () => {
    expect(referencedNames('=Button1.Text & TextInput1.Value & Button1.Text')).toEqual(['Button1', 'TextInput1'])
  })
  it('ignores function names, fields, strings, enums and record labels', () => {
    expect(referencedNames('=If(Toggle1.Value, "Toggle1", Color.Red)')).toEqual(['Toggle1'])
    expect(referencedNames('={Name: Name1.Value}')).toEqual(['Name1'])
    expect(referencedNames('=a.b.c')).toEqual(['a'])
  })
  it('includes collections used as first arguments', () => {
    expect(referencedNames('=Patch(Contacts, Defaults(Contacts), {Name: NameInput.Value}); Navigate(AddScreen)')).toEqual(['Contacts', 'NameInput', 'AddScreen'])
  })
  it('skips As names and ThisRecord, includes interpolation names', () => {
    expect(referencedNames('=Filter(Contacts As c, c.Age > Limit)')).toEqual(['Contacts', 'Limit'])
    expect(referencedNames('=$"Hi {Name1.Value}"')).toEqual(['Name1'])
    expect(referencedNames('=ThisRecord.Age + ThisItem.X')).toEqual(['ThisItem'])
  })
  it('handles blank, invalid and quoted', () => {
    expect(referencedNames('=')).toEqual([])
    expect(referencedNames('=(((')).toEqual([])
    expect(referencedNames("='My Button'.Text")).toEqual(['My Button'])
  })
})

describe('renameIdentifier', () => {
  it('renames references only', () => {
    expect(renameIdentifier('=Button1.Text & "Button1"', 'Button1', 'Save')).toBe('=Save.Text & "Button1"')
    expect(renameIdentifier('=Button1.Button1', 'Button1', 'B')).toBe('=B.Button1')
  })
  it('keeps layout and comments', () => {
    expect(renameIdentifier('= A  +  A // A\n + A', 'A', 'Z')).toBe('= Z  +  Z // A\n + Z')
  })
  it('does not touch record labels or function names', () => {
    expect(renameIdentifier('={Name: Name}', 'Name', 'N2')).toBe('={Name: N2}')
    expect(renameIdentifier('=Len(Len)', 'Len', 'X')).toBe('=Len(X)')
  })
  it('renames inside interpolation holes', () => {
    expect(renameIdentifier('=$"Hi {Box1.Value} {Box1.Value}!"', 'Box1', 'Box2')).toBe('=$"Hi {Box2.Value} {Box2.Value}!"')
  })
  it('quotes new names that need it', () => {
    expect(renameIdentifier('=a + 1', 'a', 'my var')).toBe("='my var' + 1")
    expect(renameIdentifier("='my var' + 1", 'my var', 'b')).toBe('=b + 1')
  })
  it('renames collection names in behaviour calls', () => {
    expect(renameIdentifier('=Patch(Contacts, Defaults(Contacts), {})', 'Contacts', 'People')).toBe('=Patch(People, Defaults(People), {})')
  })
  it('leaves As-bound names alone', () => {
    expect(renameIdentifier('=Filter(T As c, c.x > c.y)', 'c', 'd')).toBe('=Filter(T As c, c.x > c.y)')
  })
  it('returns the source unchanged on syntax errors or no match', () => {
    expect(renameIdentifier('=A +', 'A', 'B')).toBe('=A +')
    expect(renameIdentifier('=A', 'Q', 'B')).toBe('=A')
    expect(renameIdentifier('=', 'A', 'B')).toBe('=')
    expect(renameIdentifier('=A', 'A', 'A')).toBe('=A')
  })
  it('renamed formulas still evaluate the same', () => {
    const f = renameIdentifier('=Box1.Value & "!"', 'Box1', 'Greeting')
    expect(val(f, { Greeting: { Value: 'hey' } })).toBe('hey!')
  })
})

describe('api surface', () => {
  it('exports fx and named methods', () => {
    expect(fx.check).toBe(check)
    expect(fx.evaluate).toBe(evaluate)
    expect(fx.functions).toBe(functions)
    expect(fx.enums).toBe(enums)
    expect(fx.referencedNames).toBe(referencedNames)
    expect(fx.renameIdentifier).toBe(renameIdentifier)
  })
  it('evaluate never throws', () => {
    const bad = ['', '=', '=(', '=)', '=Filter(', '="', '=$"{', "='", '=1 +', '=Set(', '=[,]', '={,}', '=a.', '=.', '=1.2.3', '=#', '=Foo()', '=Foo.Bar()', '=((((((((((1))))))))))']
    for (const b of bad) expect(() => evaluate(b, { resolve: () => undefined })).not.toThrow()
  })
  it('handles very deep nesting without throwing', () => {
    const src = '=' + '('.repeat(20000) + '1' + ')'.repeat(20000)
    const r = evaluate(src, { resolve: () => undefined })
    expect(r.ok === true || r.ok === false).toBe(true)
  })
  it('lists every spec function', () => {
    const names = new Set(functions().map((f) => f.name))
    const spec = 'If Switch And Or Not IsBlank IsEmpty Blank Coalesce IfError With Text Value Len Left Mid Right Lower Upper Proper Trim Concatenate Concat Substitute Replace Find StartsWith EndsWith Split Round RoundUp RoundDown Int Abs Mod Sqrt Power Min Max Sum Average Rand RandBetween Now Today DateAdd DateDiff Date Year Month Day Hour Minute Weekday Filter Search LookUp Sort SortByColumns First Last FirstN LastN Index Distinct AddColumns DropColumns ShowColumns CountRows CountIf ForAll Sequence Table Defaults RGBA ColorValue ColorFade Set UpdateContext Collect ClearCollect Clear Remove RemoveIf Patch UpdateIf Navigate Back Notify Reset Refresh'.split(' ')
    for (const s of spec) expect(names.has(s), s).toBe(true)
  })
  it('results are cached but independent per scope', () => {
    expect(val('=x + 1', { x: 1 })).toBe(2)
    expect(val('=x + 1', { x: 5 })).toBe(6)
  })
})
