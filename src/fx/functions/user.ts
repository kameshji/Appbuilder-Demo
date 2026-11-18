import type { FxFunctionDoc, FxNamedFormula, FxValue } from '../../contracts.ts'
import { FxError } from '../errors.ts'
import { parse } from '../parser.ts'
import { toBool, toNumber, toText } from '../values.ts'
import { def, type CallCtx, type FnDef } from './types.ts'

/** Maximum nesting of user-defined function calls (recursion guard). */
export const MAX_UDF_DEPTH = 64

/**
 * One set of user-defined functions (App.Formulas entries with parameters). Each engine instance owns one
 * (see ../engine.ts); there is no module-level active set, so two apps or two server requests never share one.
 */
export interface UserFunctionSet {
  readonly byName: ReadonlyMap<string, FnDef>
  readonly docs: readonly FxFunctionDoc[]
  readonly defs: readonly FxNamedFormula[]
}

export const EMPTY_USER_FUNCTIONS: UserFunctionSet = { byName: new Map(), docs: [], defs: [] }

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

function signatureOf(d: FxNamedFormula): string {
  const params = d.params ?? []
  return `${d.name}(${params.map((p) => `${p.name}: ${p.type}`).join(', ')})${d.returnType ? `: ${d.returnType}` : ''}`
}

function makeUdf(d: FxNamedFormula): FnDef {
  const params = d.params ?? []
  const signature = signatureOf(d)
  const summary = `User-defined function${d.returnType ? ` returning ${d.returnType}` : ''}.`
  // parse once per set, not per call
  const parsed = parse(d.formula)
  return def(d.name, signature, summary, params.length, params.length, (c) => {
    if (c.session.depth >= MAX_UDF_DEPTH) return c.fail(null, `${d.name} calls itself too many times (limit ${MAX_UDF_DEPTH})`, true)
    const rec: Record<string, FxValue> = {}
    params.forEach((p, i) => { rec[p.name] = coerce(c, c.value(i), p.type, i) })
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

/**
 * Builds a user-function set. Entries without params, without a name, named like a built-in or repeated are
 * ignored (the first definition of a name wins).
 */
export function buildUserFunctions(defs: readonly FxNamedFormula[], isBuiltin: (name: string) => boolean): UserFunctionSet {
  const byName = new Map<string, FnDef>()
  const docs: FxFunctionDoc[] = []
  const kept: FxNamedFormula[] = []
  for (const d of defs) {
    if (!d.params || !d.name || isBuiltin(d.name) || byName.has(d.name)) continue
    const f = makeUdf(d)
    byName.set(d.name, f)
    docs.push({ name: f.name, signature: f.signature, summary: f.summary, kind: 'pure' })
    kept.push(d)
  }
  return { byName, docs, defs: kept }
}

/** Case-insensitive match in a set, for "Did you mean ...?" */
export function userFunctionNoCase(set: UserFunctionSet, name: string): FnDef | undefined {
  const l = name.toLowerCase()
  for (const [k, v] of set.byName) if (k.toLowerCase() === l) return v
  return undefined
}
