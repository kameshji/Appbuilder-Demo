import type { FxApi, FxDiagnostic, FxEngine, FxEngineOptions, FxFunctionDoc, FxHost, FxNamedFormula, FxResult, FxScope, Formula } from '../contracts.ts'
import { freeIdentifiers } from './ast.ts'
import { createEngine as makeEngine } from './engine.ts'
import { ENUM_RECORDS, enums as enumsImpl } from './enums.ts'
import { parseNamedFormulas as parseNamed } from './named.ts'
import { parse } from './parser.ts'

/**
 * Public entry of the formula engine. Runs in the browser and, unchanged, in Node (type stripping): no React, no DOM,
 * explicit `.ts` imports, erasable TypeScript only. Environment-specific effects (clipboard, launch, navigation,
 * timers) only happen through the FxHost the caller passes in.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The default engine behind `fx`: built-ins plus whatever fx.setUserFunctions registered on it. */
const defaultEngine = makeEngine()

/** Syntax check plus unknown-function and argument-count checks. Empty array = fine. */
export function check(source: Formula): FxDiagnostic[] {
  return defaultEngine.check(source)
}

export function evaluate(source: Formula, scope: FxScope, host?: FxHost): FxResult {
  return defaultEngine.evaluate(source, scope, host)
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
  return defaultEngine.functions()
}

export function enums(): Record<string, string[]> {
  return enumsImpl()
}

export function parseNamedFormulas(source: string): { items: FxNamedFormula[]; errors: FxDiagnostic[] } {
  return parseNamed(source)
}

/** Replaces the user-defined functions of the default engine only. */
export function setUserFunctions(defs: FxNamedFormula[]): void {
  defaultEngine.setUserFunctions(defs)
}

export function signatureAt(source: Formula, offset: number): { name: string; signature: string; summary: string; argIndex: number } | null {
  return defaultEngine.signatureAt(source, offset)
}

export function createEngine(options?: FxEngineOptions): FxEngine {
  return makeEngine(options)
}

export { splitFormulas, checkWith } from './engine.ts'

export const fx: FxApi = { check, evaluate, referencedNames, renameIdentifier, functions, enums, parseNamedFormulas, setUserFunctions, signatureAt, createEngine }
