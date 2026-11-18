/**
 * The formula engine (src/fx) is shared with the server (P0 package B): it must load under plain Node type stripping
 * (relative `.ts` imports, erasable syntax, no DOM/React at import time) and keep user-defined functions and named
 * formulas per engine instance, so two apps or two concurrent requests cannot see each other's definitions.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FxHost, FxRecord, FxScope, FxValue } from '../../src/contracts.ts'
import { createEngine, fx } from '../../src/fx/index.ts'
import { analyze } from '../../src/fx/query/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const fxEntry = path.resolve(here, '../../src/fx/index.ts')
const queryEntry = path.resolve(here, '../../src/fx/query/index.ts')

/** a minimal host scope: a few variables, a table and the signed-in user */
function scopeOf(vars: Record<string, FxValue>): FxScope {
  return { resolve: (n) => (Object.prototype.hasOwnProperty.call(vars, n) ? vars[n] : undefined) }
}

const tickets: FxRecord[] = [
  { id: 't1', Title: 'Printer jam', Status: 'Open', Price: 10, Due: new Date(2026, 0, 5) },
  { id: 't2', Title: 'VPN down', Status: 'closed', Price: 25, Due: null },
  { id: 't3', Title: 'New laptop', Status: 'OPEN', Price: 900, Due: new Date(2026, 1, 1) },
]
const scope = scopeOf({ Tickets: tickets, Threshold: 20, User: { Email: 'asha@example.com', FullName: 'Asha' } })

function value(engine: ReturnType<typeof createEngine>, src: string, host?: FxHost): FxValue {
  const r = engine.evaluate(src, scope, host)
  if (!r.ok) throw new Error(`${src}: ${r.error.message}`)
  return r.value
}

describe('shared formula engine on the server', () => {
  it('evaluates formulas with a minimal host scope', () => {
    const e = createEngine()
    expect(value(e, '=1 + 2 * 3')).toBe(7)
    expect(value(e, '=CountRows(Filter(Tickets, Status = "open"))')).toBe(2)
    expect(value(e, '=Sum(Filter(Tickets, Price > Threshold), Price)')).toBe(925)
    expect(value(e, '=Concat(Sort(Tickets, Price, SortOrder.Descending), Title, ", ")')).toBe('New laptop, VPN down, Printer jam')
    expect(value(e, '=Lower(User.Email)')).toBe('asha@example.com')
    expect(value(e, '=Text(Date(2026, 3, 9), "yyyy-mm-dd")')).toBe('2026-03-09')
    expect(value(e, '=LookUp(Tickets, IsBlank(Due), Title)')).toBe('VPN down')
  })

  it('named formulas and user-defined functions belong to the engine instance', () => {
    const e = createEngine({
      formulas: 'Expensive = Filter(Tickets, Price >= Threshold); Total = Sum(Expensive, Price); Net(x: Number): Number = x * 0.8; Label(t: Text): Text = "#" & Upper(t);',
    })
    expect(value(e, '=CountRows(Expensive)')).toBe(2)
    expect(value(e, '=Net(Total)')).toBe(740)
    expect(value(e, '=Label(First(Expensive).Status)')).toBe('#CLOSED')
    expect(e.check('=Net(1)')).toEqual([])
    expect(e.functions().some((f) => f.name === 'Net')).toBe(true)
    // the scope wins over a named formula of the same name
    expect(e.evaluate('=Threshold', scopeOf({ Threshold: 1 })).ok).toBe(true)
  })

  it('two engines with same-named user functions do not interfere', () => {
    const a = createEngine({ formulas: 'Fee(x: Number): Number = x + 1; Kind = "A";' })
    const b = createEngine({ formulas: 'Fee(x: Number): Number = x * 100; Kind = "B";' })
    // interleaved, as two concurrent requests would be
    expect(value(a, '=Fee(2)')).toBe(3)
    expect(value(b, '=Fee(2)')).toBe(200)
    expect(value(a, '=Fee(5) & Kind')).toBe('6A')
    expect(value(b, '=Fee(5) & Kind')).toBe('500B')
    // neither touches the default engine
    expect(fx.evaluate('=Fee(1)', scope).ok).toBe(false)
    expect(fx.check('=Fee(1)')[0]?.message).toMatch(/isn't recognised/)
    b.setUserFunctions([])
    expect(b.evaluate('=Fee(1)', scope).ok).toBe(false)
    expect(value(a, '=Fee(1)')).toBe(2)
  })

  it('reports circular named formulas instead of overflowing', () => {
    const e = createEngine({ formulas: 'A = B + 1; B = A + 1;' })
    const r = e.evaluate('=A', scope)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/Circular reference/)
  })

  it('behaviour functions reach the environment only through the host', () => {
    const calls: string[] = []
    const host = {
      setVar: (n: string) => calls.push('set:' + n), updateContext: () => {}, collect: () => {}, clear: () => {}, remove: () => {},
      patch: (_c: string, b: FxRecord, ch: FxRecord) => ({ ...b, ...ch }), navigate: () => {}, back: () => {}, notify: (m: string) => calls.push('notify:' + m),
      reset: () => {}, form: () => {}, select: () => {}, setFocus: () => {}, launch: (u: string) => calls.push('launch:' + u),
      copy: (t: string) => calls.push('copy:' + t), trace: () => {}, exit: () => {}, refresh: () => {},
    } as unknown as FxHost
    value(createEngine(), '=Set(x, 1); Copy("hi"); Launch("https://example.com"); Notify("done")', host)
    expect(calls).toEqual(['set:x', 'copy:hi', 'launch:https://example.com', 'notify:done'])
  })

  it('the translator runs on the server too', () => {
    const r = analyze('=Filter(Tickets, Price > Threshold)', { tables: { Tickets: { columns: { id: 'text', Price: 'number', Title: 'text' } } } }, { scope })
    expect(r.plan).toEqual({ version: 2, table: 'Tickets', filter: { col: 'Price', op: 'gt', value: 20 } })
  })

  it('loads under plain Node type stripping (no Vite, no alias)', () => {
    const script = `
      const { createEngine } = await import(${JSON.stringify(pathToFileURL(fxEntry).href)});
      const e = createEngine({ formulas: 'Double(x: Number): Number = x * 2; Base = 20;' });
      const r = e.evaluate('=Double(Base) + CountRows(Filter(T, v > 1))', { resolve: (n) => n === 'T' ? [{ v: 1 }, { v: 2 }, { v: 3 }] : undefined });
      const { analyze } = await import(${JSON.stringify(pathToFileURL(queryEntry).href)});
      const q = analyze('=CountRows(Filter(T, v > 1))', { tables: { T: { columns: { id: 'text', v: 'number' } } } });
      if (typeof window !== 'undefined' || typeof document !== 'undefined') throw new Error('DOM leaked');
      process.stdout.write(JSON.stringify({ r, plan: q.plan }));
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(JSON.parse(out)).toEqual({
      r: { ok: true, value: 42 },
      plan: { version: 2, table: 'T', filter: { col: 'v', op: 'gt', value: 1 }, count: true },
    })
  })
})
