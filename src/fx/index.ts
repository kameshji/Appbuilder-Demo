import type { FxApi, FxDiagnostic, FxFunctionDoc, FxHost, FxResult, FxScope, Formula } from '@/contracts'
import { freeIdentifiers, childrenOf, type Node } from './ast'
import { ENUM_RECORDS, enums as enumsImpl } from './enums'
import { arityMessage, evaluateSource, unknownFunctionMessage } from './evaluate'
import { functionDocs, lookupFunction } from './functions'
import { parse } from './parser'

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Syntax check plus unknown-function and argument-count checks. Empty array = fine. */
export function check(source: Formula): FxDiagnostic[] {
  const p = parse(source)
  if (p.error) return [p.error]
  if (!p.ast) return []
  const out: FxDiagnostic[] = []
  const visit = (n: Node): void => {
    if (n.t === 'call') {
      const def = lookupFunction(n.name)
      if (!def) {
        out.push({ message: unknownFunctionMessage(n.name), start: n.nameStart, end: n.nameEnd })
      } else {
        const msg = arityMessage(def.name, def.min, def.max, n.args.length)
        if (msg) out.push({ message: msg, start: n.start, end: n.end })
      }
    }
    for (const c of childrenOf(n)) visit(c)
  }
  visit(p.ast)
  return out
}

export function evaluate(source: Formula, scope: FxScope, host?: FxHost): FxResult {
  return evaluateSource(source, scope, host)
}

export function referencedNames(source: Formula): string[] {
  const p = parse(source)
  if (!p.ast) return []
  const seen = new Set<string>()
  for (const id of freeIdentifiers(p.ast)) {
    if (id.name === 'ThisRecord') continue
    if (Object.prototype.hasOwnProperty.call(ENUM_RECORDS, id.name)) continue
    seen.add(id.name)
  }
  return [...seen]
}

export function renameIdentifier(source: Formula, from: string, to: string): Formula {
  if (from === to) return source
  const p = parse(source)
  if (!p.ast) return source
  const hits = freeIdentifiers(p.ast).filter((id) => id.name === from)
  if (hits.length === 0) return source
  const text = IDENT_RE.test(to) ? to : `'${to.replace(/'/g, "''")}'`
  let out = source
  for (const h of [...hits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, h.start) + text + out.slice(h.end)
  }
  return out
}

export function functions(): FxFunctionDoc[] {
  return functionDocs()
}

export function enums(): Record<string, string[]> {
  return enumsImpl()
}

export const fx: FxApi = { check, evaluate, referencedNames, renameIdentifier, functions, enums }
