import { afterEach, describe, expect, it } from 'vitest'
import { fx } from './index'
import { contacts, err, fakeHost, run, val } from './testutil'

afterEach(() => fx.setUserFunctions([]))

const defs = (src: string) => {
  const r = fx.parseNamedFormulas(src)
  expect(r.errors, src).toEqual([])
  return r.items
}

describe('parseNamedFormulas', () => {
  it('splits definitions at ;', () => {
    expect(fx.parseNamedFormulas('Total = 1 + 2; Name = "x";')).toEqual({
      items: [{ name: 'Total', formula: '=1 + 2' }, { name: 'Name', formula: '="x"' }],
      errors: [],
    })
  })
  it('the last ; is optional and layout is free', () => {
    expect(defs('A = 1;\n\n  B =\n    A + 1').map((x) => x.formula)).toEqual(['=1', '=A + 1'])
  })
  it('keeps ; inside text, brackets and interpolation', () => {
    expect(defs('A = "a;b"; B = Concat(T, x, ";"); C = $"{1};{2}"; D = {a: 1}; E = [1, 2]').map((x) => x.formula)).toEqual([
      '="a;b"', '=Concat(T, x, ";")', '=$"{1};{2}"', '={a: 1}', '=[1, 2]',
    ])
  })
  it('skips comments', () => {
    const items = defs('// the total\nA = 1; /* block ; */ B = 2 // trailing ; text\n; C = 3')
    expect(items.map((x) => x.name)).toEqual(['A', 'B', 'C'])
    expect(items[1]!.formula).toBe('=2 // trailing ; text')
  })
  it('quoted names', () => {
    expect(defs("'Grand total' = 5; 'It''s' = 6").map((x) => x.name)).toEqual(['Grand total', "It's"])
  })
  it('empty source and stray semicolons', () => {
    expect(fx.parseNamedFormulas('')).toEqual({ items: [], errors: [] })
    expect(fx.parseNamedFormulas('  \n ;; ')).toEqual({ items: [], errors: [] })
  })
  it('user-defined functions fill params and returnType', () => {
    const [f] = defs('Area(w: Number, h: Number): Number = w * h;')
    expect(f).toEqual({ name: 'Area', formula: '=w * h', params: [{ name: 'w', type: 'Number' }, { name: 'h', type: 'Number' }], returnType: 'Number' })
  })
  it('functions without return type or without params', () => {
    const [a, b] = defs('Greet(name: Text) = "Hi " & name; Now2(): Date = Now();')
    expect(a).toEqual({ name: 'Greet', formula: '="Hi " & name', params: [{ name: 'name', type: 'Text' }] })
    expect(b).toEqual({ name: 'Now2', formula: '=Now()', params: [], returnType: 'Date' })
  })
  it('functions and values can be mixed', () => {
    const items = defs('Rate = 0.18; Tax(x: Number): Number = x * Rate;')
    expect(items[0]!.params).toBeUndefined()
    expect(items[1]!.params).toHaveLength(1)
  })
  it('syntax errors give offsets in the source text', () => {
    const src = 'A = 1;\nB = 1 +;\nC = 3;'
    const r = fx.parseNamedFormulas(src)
    expect(r.items.map((x) => x.name)).toEqual(['A', 'C'])
    expect(r.errors).toHaveLength(1)
    const e = r.errors[0]!
    expect(e.message).toBe('The formula ends too early: a value is missing')
    expect(src.slice(e.start, e.end)).toBe('+')
    expect(e.start).toBeGreaterThanOrEqual(src.indexOf('B'))
  })
  it('error in the middle of a body points into the body', () => {
    const src = 'Calc = 1 + * 2;'
    const e = fx.parseNamedFormulas(src).errors[0]!
    expect(src.slice(e.start, e.end)).toBe('*')
  })
  it('reports a missing name, =, and formula', () => {
    expect(fx.parseNamedFormulas('= 5;').errors[0]!.message).toMatch(/name is needed/)
    expect(fx.parseNamedFormulas('Total 5;').errors[0]!.message).toBe('Expected = after Total')
    expect(fx.parseNamedFormulas('Total = ;').errors[0]!.message).toBe('Total needs a formula after =')
    expect(fx.parseNamedFormulas('Total =').errors[0]!.message).toBe('Total needs a formula after =')
  })
  it('one bad definition does not hide the others', () => {
    const r = fx.parseNamedFormulas('A = 1; B = ; C = 3; D 4; E = 5')
    expect(r.items.map((x) => x.name)).toEqual(['A', 'C', 'E'])
    expect(r.errors).toHaveLength(2)
  })
  it('duplicate names', () => {
    const r = fx.parseNamedFormulas('A = 1; A = 2;')
    expect(r.items).toHaveLength(1)
    expect(r.errors[0]!.message).toBe('A is already defined')
  })
  it('functions may not reuse a built-in name; enums may not be shadowed', () => {
    expect(fx.parseNamedFormulas('Sum(a: Number): Number = a;').errors[0]!.message).toBe('Sum is already a built-in function')
    expect(fx.parseNamedFormulas('Color = 1;').errors[0]!.message).toBe('Color is already a built-in list of values')
  })
  it('parameter problems', () => {
    expect(fx.parseNamedFormulas('F(a, b: Number) = 1;').errors[0]!.message).toBe('a needs a type, like a: Number')
    expect(fx.parseNamedFormulas('F(a: Number, a: Number) = 1;').errors[0]!.message).toBe('Parameter a is used twice')
    expect(fx.parseNamedFormulas('F(a: Number = 1;').errors[0]!.message).toMatch(/Expected , or \)/)
    expect(fx.parseNamedFormulas('F(a: Number): = 1;').errors[0]!.message).toMatch(/return type/)
  })
  it('formulas are ready for evaluate()', () => {
    const items = defs('Doubled = Count * 2;')
    expect(val(items[0]!.formula, { Count: 21 })).toBe(42)
  })
  it('non-ASCII names', () => {
    expect(defs('Preço = 5; Größe(x: Number): Number = x;').map((x) => x.name)).toEqual(['Preço', 'Größe'])
  })
})

describe('user-defined functions', () => {
  it('are callable like built-ins', () => {
    fx.setUserFunctions(defs('Area(w: Number, h: Number): Number = w * h;'))
    expect(val('=Area(3, 4)')).toBe(12)
    expect(val('=Area(2, 3) + Area(1, 1)')).toBe(7)
    expect(val('=Sum(ForAll(Sequence(3), Area(Value, 2)), Value)')).toBe(12)
  })
  it('params are local names', () => {
    fx.setUserFunctions(defs('Greet(name: Text): Text = "Hi " & name;'))
    expect(val('=Greet("Asha")')).toBe('Hi Asha')
    expect(val('=Greet(Name)', { Name: 'Ben' })).toBe('Hi Ben')
  })
  it('the body does not see the caller\'s row scope or variables named like its params', () => {
    fx.setUserFunctions(defs('Twice(x: Number): Number = x * 2;'))
    expect(val('=Twice(x + 1)', { x: 4 })).toBe(10)
    expect(val('=Sum(ForAll(Sequence(3), Twice(Value)), Value)')).toBe(12)
    fx.setUserFunctions(defs('Peek(): Number = Age;'))
    expect(err('=First(Contacts).Name & Peek()', { Contacts: contacts() }).message).toMatch(/Name isn't recognised: Age/)
  })
  it('the body can read host names, enums and call other functions', () => {
    fx.setUserFunctions(defs('Tax(x: Number): Number = x * Rate; Gross(x: Number): Number = x + Tax(x); Red(): Text = Color.Red;'))
    expect(val('=Gross(100)', { Rate: 0.1 })).toBeCloseTo(110)
    expect(val('=Red()')).toBe('rgba(239, 68, 68, 1)')
  })
  it('table and record parameters', () => {
    fx.setUserFunctions(defs('Total(t: Table): Number = Sum(t, Age); Label(r: Record): Text = r.Name & " (" & r.Age & ")";'))
    expect(val('=Total(Contacts)', { Contacts: contacts() })).toBe(126)
    expect(val('=Label(First(Contacts))', { Contacts: contacts() })).toBe('Asha Rao (31)')
    expect(val('=Total(Filter(Contacts, Active))', { Contacts: contacts() })).toBe(101)
  })
  it('typed params coerce Number, Text and Boolean', () => {
    fx.setUserFunctions(defs('Inc(n: Number): Number = n + 1; Len2(s: Text): Number = Len(s); Not2(b: Boolean): Boolean = !b;'))
    expect(val('=Inc("41")')).toBe(42)
    expect(val('=Len2(12345)')).toBe(5)
    expect(val('=Not2("true")')).toBe(false)
    expect(err('=Inc("abc")').message).toMatch(/into a number/)
    expect(err('=Inc("abc")').start).toBe(5)
  })
  it('blank stays blank', () => {
    fx.setUserFunctions(defs('Pass(n: Number): Number = n;'))
    expect(val('=Pass(Blank())')).toBeNull()
  })
  it('return type is applied', () => {
    fx.setUserFunctions(defs('AsText(n: Number): Text = n; AsNum(): Number = "7";'))
    expect(val('=AsText(5) & "!"')).toBe('5!')
    expect(val('=AsNum() + 1')).toBe(8)
  })
  it('arity is checked', () => {
    fx.setUserFunctions(defs('Area(w: Number, h: Number): Number = w * h; Zero(): Number = 0;'))
    expect(err('=Area(1)').message).toBe('Area needs 2 arguments')
    expect(err('=Area(1, 2, 3)').message).toBe('Area takes at most 2 arguments')
    expect(err('=Zero(1)').message).toBe("Zero doesn't take any arguments")
    expect(fx.check('=Area(1)')[0]!.message).toBe('Area needs 2 arguments')
    expect(fx.check('=Area(1, 2)')).toEqual([])
  })
  it('are pure: behaviour in a body is an error without a host', () => {
    fx.setUserFunctions(defs('Bad(): Number = Set(x, 1);'))
    expect(err('=Bad()').message).toBe('In Bad: Behaviour function in a non-behaviour property')
  })
  it('errors in the body point at the call and name the function', () => {
    fx.setUserFunctions(defs('Inv(x: Number): Number = 1 / x;'))
    const e = err('=10 + Inv(0)')
    expect(e.message).toBe("In Inv: Can't divide by zero")
    expect([e.start, e.end]).toEqual([6, 12])
  })
  it('nested failures are re-pointed once', () => {
    fx.setUserFunctions(defs('Inv(x: Number): Number = 1 / x; Outer(x: Number): Number = Inv(x) + 1;'))
    const e = err('=Outer(0)')
    expect(e.message).toBe("In Inv: Can't divide by zero")
    expect([e.start, e.end]).toEqual([1, 9])
  })
  it('IfError can catch them', () => {
    fx.setUserFunctions(defs('Inv(x: Number): Number = 1 / x;'))
    expect(val('=IfError(Inv(0), -1)')).toBe(-1)
    expect(val('=IfError(Inv(4), -1)')).toBe(0.25)
  })
  it('recursion works up to the limit', () => {
    fx.setUserFunctions(defs('Fact(n: Number): Number = If(n <= 1, 1, n * Fact(n - 1)); Sum2(n: Number): Number = If(n <= 0, 0, n + Sum2(n - 1));'))
    expect(val('=Fact(5)')).toBe(120)
    expect(val('=Fact(10)')).toBe(3628800)
    expect(val('=Sum2(60)')).toBe(1830)
  })
  it('runaway recursion stops at depth 64 with a clear fatal error', () => {
    fx.setUserFunctions(defs('Loop(n: Number): Number = Loop(n + 1); Deep(n: Number): Number = If(n = 0, 0, 1 + Deep(n - 1));'))
    const e = err('=Loop(1)')
    expect(e.message).toMatch(/calls itself too many times \(limit 64\)/)
    expect(val('=Deep(63)')).toBe(63)
    expect(err('=Deep(64)').message).toMatch(/limit 64/)
    expect(err('=IfError(Loop(1), 0)').message).toMatch(/limit 64/)
  })
  it('the depth counter resets after errors and between calls', () => {
    fx.setUserFunctions(defs('Deep(n: Number): Number = If(n = 0, 0, 1 + Deep(n - 1));'))
    for (let i = 0; i < 5; i++) {
      expect(err('=Deep(100)').message).toMatch(/limit 64/)
      expect(val('=Deep(60)')).toBe(60)
    }
  })
  it('setUserFunctions replaces the previous set', () => {
    fx.setUserFunctions(defs('A(): Number = 1;'))
    expect(val('=A()')).toBe(1)
    fx.setUserFunctions(defs('B(): Number = 2;'))
    expect(val('=B()')).toBe(2)
    expect(err('=A()').message).toBe("Function isn't recognised: A")
    fx.setUserFunctions([])
    expect(err('=B()').message).toBe("Function isn't recognised: B")
  })
  it('built-ins cannot be replaced and plain named formulas are ignored', () => {
    fx.setUserFunctions([{ name: 'Sum', formula: '=0', params: [{ name: 'a', type: 'Number' }] }, { name: 'Rate', formula: '=0.2' }])
    expect(val('=Sum(1, 2)')).toBe(3)
    expect(err('=Rate()').message).toBe("Function isn't recognised: Rate")
  })
  it('did-you-mean works for user functions', () => {
    fx.setUserFunctions(defs('Area(w: Number): Number = w;'))
    expect(err('=area(1)').message).toBe('Did you mean Area?')
  })
  it('a function name without brackets gets the usual hint', () => {
    fx.setUserFunctions(defs('Area(w: Number): Number = w;'))
    expect(err('=Area').message).toBe('Area is a function: add brackets after it, like Area(...)')
  })
  it('functions() lists them with their signature', () => {
    fx.setUserFunctions(defs('Area(w: Number, h: Number): Number = w * h; Zero() = 0;'))
    const docs = fx.functions()
    const area = docs.find((d) => d.name === 'Area')!
    expect(area).toEqual({ name: 'Area', signature: 'Area(w: Number, h: Number): Number', summary: 'User-defined function returning Number.', kind: 'pure' })
    expect(docs.find((d) => d.name === 'Zero')?.signature).toBe('Zero()')
    expect(docs.some((d) => d.name === 'Filter')).toBe(true)
    fx.setUserFunctions([])
    expect(fx.functions().some((d) => d.name === 'Area')).toBe(false)
  })
  it('functions() stays sorted', () => {
    fx.setUserFunctions(defs('Aardvark(): Number = 1;'))
    const names = fx.functions().map((d) => d.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(names[0]).toBe('Aardvark')
  })
  it('referencedNames sees arguments but not function names', () => {
    fx.setUserFunctions(defs('Area(w: Number, h: Number): Number = w * h;'))
    expect(fx.referencedNames('=Area(Slider1.Value, Width)')).toEqual(['Slider1', 'Width'])
  })
  it('work inside behaviour chains', () => {
    fx.setUserFunctions(defs('Next(n: Number): Number = n + 1;'))
    const { host, calls } = fakeHost()
    val('=Set(count, Next(count))', { count: 1 }, host)
    expect(calls).toEqual([{ fn: 'setVar', args: ['count', 2] }])
  })
  it('see variables set earlier in the same chain', () => {
    fx.setUserFunctions(defs('ReadX(): Number = x;'))
    const { host } = fakeHost()
    expect(val('=Set(x, 9); ReadX()', {}, host)).toBe(9)
  })
  it('a broken body is a fatal error, not a crash', () => {
    fx.setUserFunctions([{ name: 'Broken', formula: '=1 +', params: [] }])
    const r = run('=Broken()')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/^In Broken|Broken has an error/)
    expect(err('=IfError(Broken(), 1)').message).toMatch(/Broken has an error/)
  })
  it('empty-bodied definition', () => {
    fx.setUserFunctions([{ name: 'Nothing', formula: '=', params: [] }])
    expect(val('=Nothing()')).toBeNull()
  })
})
