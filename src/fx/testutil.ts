import type { FxHost, FxRecord, FxResult, FxValue } from '@/contracts'
import { evaluate } from './index'

export type Vars = Record<string, FxValue>

export function run(src: string, vars: Vars = {}, host?: FxHost): FxResult {
  return evaluate(src, { resolve: (n) => (Object.prototype.hasOwnProperty.call(vars, n) ? vars[n] : undefined) }, host)
}

/** value of a formula, throws a readable error when it fails */
export function val(src: string, vars: Vars = {}, host?: FxHost): FxValue {
  const r = run(src, vars, host)
  if (!r.ok) throw new Error(`${src} -> ${r.error.message} [${r.error.start},${r.error.end}]`)
  return r.value
}

export function err(src: string, vars: Vars = {}, host?: FxHost) {
  const r = run(src, vars, host)
  if (r.ok) throw new Error(`${src} should have failed but gave ${JSON.stringify(r.value)}`)
  return r.error
}

export const contacts = (): FxRecord[] => [
  { __id: 'a', Name: 'Asha Rao', Company: 'Northwind', City: 'Pune', Age: 31, Active: true },
  { __id: 'b', Name: 'Ben Cole', Company: 'Contoso', City: 'Delhi', Age: 25, Active: false },
  { __id: 'c', Name: 'Chitra Nair', Company: 'Northwind', City: 'Pune', Age: 42, Active: true },
  { __id: 'd', Name: 'Dev Patel', Company: 'Fabrikam', City: 'Mumbai', Age: 28, Active: true },
]

export interface Call { fn: string; args: unknown[] }

export function fakeHost(): { host: FxHost; calls: Call[] } {
  const calls: Call[] = []
  let n = 0
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }) }
  const host: FxHost = {
    setVar: rec('setVar'),
    updateContext: rec('updateContext'),
    collect: rec('collect'),
    clear: rec('clear'),
    remove: rec('remove'),
    patch: (coll, base, changes) => {
      calls.push({ fn: 'patch', args: [coll, base, changes] })
      return { ...base, ...changes, __id: typeof base.__id === 'string' ? base.__id : 'new' + ++n }
    },
    navigate: rec('navigate'),
    back: rec('back'),
    notify: rec('notify'),
    reset: rec('reset'),
  }
  return { host, calls }
}
