import type { FxFunctionDoc, FxNamedFormula, FxValue } from '@/contracts'
import { FxError } from '../errors'
import { parse } from '../parser'
import { toBool, toNumber, toText } from '../values'
import { def, type CallCtx, type FnDef } from './types'

/** Maximum nesting of user-defined function calls (recursion guard). */
export const MAX_UDF_DEPTH = 64

const USER = new Map<string, FnDef>()
const USER_DOCS = new Map<string, FxFunctionDoc>()
let isBuiltin: (name: string) => boolean = () => false

/** index.ts tells this module which names belong to built-ins (a user function never replaces one). */
export function bindBuiltinCheck(f: (name: string) => boolean): void {
  isBuiltin = f
}

export function userFunction(name: string): FnDef | undefined { return USER.get(name) }
export function userFunctionNoCase(name: string): FnDef | undefined {
  const l = name.toLowerCase()
  for (const [k, v] of USER) if (k.toLowerCase() === l) return v
  return undefined
}
export function userDocs(): FxFunctionDoc[] { return [...USER_DOCS.values()] }

function coerce(c: CallCtx, v: FxValue, type: string | undefined, argIndex: number | null): FxValue {
  if (v === null || type === undefined) return v
  const at = argIndex === null ? c.node : c.argNode(argIndex)
  switch (type.trim().toLowerCase()) {
    case 'number': return toNumber(v, at)
    case 'text': case 'string': return toText(v, at)
    case 'boolean': return toBool(v, at)
    default: return v
  }
}

function makeUdf(d: FxNamedFormula): FnDef {
  const params = d.params ?? []
  const signature = `${d.name}(${params.map((p) => `${p.name}: ${p.type}`).join(', ')})${d.returnType ? `: ${d.returnType}` : ''}`
  const summary = `User-defined function${d.returnType ? ` returning ${d.returnType}` : ''}.`
  USER_DOCS.set(d.name, { name: d.name, signature, summary, kind: 'pure' })
  return def(d.name, signature, summary, params.length, params.length, (c) => {
    if (c.session.depth >= MAX_UDF_DEPTH) return c.fail(null, `${d.name} calls itself too many times (limit ${MAX_UDF_DEPTH})`, true)
    const rec: Record<string, FxValue> = {}
    params.forEach((p, i) => { rec[p.name] = coerce(c, c.value(i), p.type, i) })
    const parsed = parse(d.formula)
    if (parsed.error) return c.fail(null, `${d.name} has an error in its formula: ${parsed.error.message}`, true)
    if (!parsed.ast) return null
    c.session.depth++
    try {
      return coerce(c, c.scoped(parsed.ast, rec), d.returnType, null)
    } catch (e) {
      if (e instanceof FxError) {
        // body spans point into the body, not the caller's formula: re-point at the call
        const err = new FxError(e.remapped ? e.message : `In ${d.name}: ${e.message}`, c.node, e.fatal)
        err.remapped = true
        throw err
      }
      throw e
    } finally {
      c.session.depth--
    }
  })
}

/** Replaces the registered user-defined functions. Entries without params and names of built-ins are ignored. */
export function setUserFunctions(defs: FxNamedFormula[]): void {
  USER.clear()
  USER_DOCS.clear()
  for (const d of defs) {
    if (!d.params || !d.name || isBuiltin(d.name) || USER.has(d.name)) continue
    USER.set(d.name, makeUdf(d))
  }
}
