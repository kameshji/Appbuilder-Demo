import { describe, expect, it } from 'vitest'
import type { FxValue } from '../contracts.ts'
import { createEngine, fx } from './index.ts'
import { printNode } from './print.ts'
import { parse } from './parser.ts'

const none = { resolve: () => undefined }

describe('engine instances', () => {
  it('keep user-defined functions and named formulas apart', () => {
    const a = createEngine({ formulas: 'F(x: Number): Number = x + 1; N = 5;' })
    const b = createEngine({ formulas: 'F(x: Text): Text = "b" & x; N = "five";' })
    expect(a.evaluate('=F(N)', none)).toEqual({ ok: true, value: 6 })
    expect(b.evaluate('=F(N)', none)).toEqual({ ok: true, value: 'bfive' })
    expect(a.functions().find((f) => f.name === 'F')!.signature).toBe('F(x: Number): Number')
    expect(b.signatureAt('=F(', 3)!.signature).toBe('F(x: Text): Text')
    expect(a.userFunctions().map((d) => d.name)).toEqual(['F'])
    expect(a.namedFormulas()).toEqual([{ name: 'N', formula: '=5' }])
    expect(fx.functions().some((f) => f.name === 'F')).toBe(false)
  })

  it('setFormulas replaces both sets and returns parse errors', () => {
    const e = createEngine()
    expect(e.setFormulas('X = 1; Y = ;')).not.toEqual([])
    expect(e.setFormulas('G(): Number = 2;')).toEqual([])
    expect(e.evaluate('=G()', none)).toEqual({ ok: true, value: 2 })
    expect(e.evaluate('=X', none).ok).toBe(false)
  })

  it('the scope wins over a named formula; named formulas see each other lazily', () => {
    const e = createEngine({ formulas: 'Rate = 0.2; Tax = Price * Rate; Price = 100;' })
    expect(e.evaluate('=Tax', none)).toEqual({ ok: true, value: 20 })
    expect(e.evaluate('=Tax', { resolve: (n) => (n === 'Price' ? 50 : undefined) })).toEqual({ ok: true, value: 10 })
  })

  it('check() knows the instance functions', () => {
    const e = createEngine({ userFunctions: [{ name: 'Twice', formula: '=x * 2', params: [{ name: 'x', type: 'Number' }] }] })
    expect(e.check('=Twice(1)')).toEqual([])
    expect(e.check('=Twice(1, 2)')[0]!.message).toMatch(/takes at most 1/)
    expect(fx.check('=Twice(1)')[0]!.message).toMatch(/isn't recognised/)
  })
})

describe('printNode', () => {
  it('prints formulas that parse back to the same value', () => {
    const vars: Record<string, FxValue> = { 'my var': 3, t: [{ a: 1 }, { a: 2 }] }
    const scope = { resolve: (n: string) => vars[n] }
    for (const src of ['=1 + 2 * 3 - -4', '=(1 + 2) * 3%', '="a""b" & $"x{1 + 1}{{y"', "='my var' ^ 2", '=!true || false && true',
      '=Filter(t As r, r.a > 1)', '={x: 1, \'y z\': [1, 2]}', '=3 in [1, 2, 3]', '="Ab" exactin "xAby"', '=If(1 <> 2, "y", "n")']) {
      const p = parse(src)
      const again = '=' + printNode(p.ast!)
      expect(fx.evaluate(again, scope), `${src} -> ${again}`).toEqual(fx.evaluate(src, scope))
    }
  })
})
