import type { FxDiagnostic, FxEngine, FxEngineOptions, FxHost, FxNamedFormula, FxResult, FxScope, FxValue, Formula } from '../contracts.ts'
import { childrenOf, type Node } from './ast.ts'
import { arityMessage, evaluateSource, unknownFunctionMessage } from './evaluate.ts'
import { BUILTIN_TABLE, functionTable, userFunctionSet, type FunctionTable } from './functions/index.ts'
import { parseNamedFormulas } from './named.ts'
import { parse } from './parser.ts'
import { signatureAt } from './signature.ts'

/** Syntax check plus unknown-function and argument-count checks against one function table. */
export function checkWith(source: Formula, fns: FunctionTable = BUILTIN_TABLE): FxDiagnostic[] {
  const p = parse(source)
  if (p.error) return [p.error]
  if (!p.ast) return []
  const out: FxDiagnostic[] = []
  const visit = (n: Node): void => {
    if (n.t === 'call') {
      const def = fns.lookup(n.name)
      if (!def) {
        out.push({ message: unknownFunctionMessage(n.name, fns), start: n.nameStart, end: n.nameEnd })
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

/** App.Formulas source -> named formulas and user-defined functions (a leading '=' is ignored). */
export function splitFormulas(source: string | undefined): { named: FxNamedFormula[]; udfs: FxNamedFormula[]; errors: FxDiagnostic[] } {
  const src = (source ?? '').replace(/^\s*=/, '')
  if (!src.trim()) return { named: [], udfs: [], errors: [] }
  const r = parseNamedFormulas(src)
  return { named: r.items.filter((i) => !i.params), udfs: r.items.filter((i) => !!i.params), errors: r.errors }
}

/**
 * A formula engine instance. Holds its own user-defined functions and named formulas; nothing is shared between
 * instances except the immutable built-ins. Safe to use from several apps (browser tabs, Studio + preview) or
 * concurrent server requests: create one per app definition.
 */
export function createEngine(options: FxEngineOptions = {}): FxEngine {
  let fns: FunctionTable = BUILTIN_TABLE
  let named = new Map<string, Formula>()

  const setUserFunctions = (defs: FxNamedFormula[]): void => {
    const set = userFunctionSet(defs)
    fns = set.byName.size ? functionTable(set) : BUILTIN_TABLE
  }
  const setNamedFormulas = (defs: FxNamedFormula[]): void => {
    const m = new Map<string, Formula>()
    for (const d of defs) if (!d.params && d.name && !m.has(d.name)) m.set(d.name, d.formula)
    named = m
  }

  /** The caller's scope, then this engine's named formulas (lazy, cached for one evaluate call, cycle-checked). */
  const withNamed = (scope: FxScope): FxScope => {
    if (named.size === 0) return scope
    const defs = named
    const table = fns
    const cache = new Map<string, FxValue>()
    const active = new Set<string>()
    const wrapped: FxScope = {
      resolve(name) {
        const v = scope.resolve(name)
        if (v !== undefined) return v
        const f = defs.get(name)
        if (f === undefined) return undefined
        if (cache.has(name)) return cache.get(name)
        if (active.has(name)) throw new Error(`Circular reference in named formula ${name}`)
        active.add(name)
        try {
          const r = evaluateSource(f, wrapped, undefined, table)
          if (!r.ok) throw new Error(r.error.message.startsWith('Circular reference') ? r.error.message : `${name}: ${r.error.message}`)
          cache.set(name, r.value)
          return r.value
        } finally {
          active.delete(name)
        }
      },
    }
    return wrapped
  }

  const engine: FxEngine = {
    check: (source) => checkWith(source, fns),
    evaluate: (source: Formula, scope: FxScope, host?: FxHost): FxResult => evaluateSource(source, withNamed(scope), host, fns),
    functions: () => fns.docs(),
    signatureAt: (source, offset) => signatureAt(source, offset, fns),
    setUserFunctions,
    setNamedFormulas,
    setFormulas(source) {
      const r = splitFormulas(source)
      setUserFunctions(r.udfs)
      setNamedFormulas(r.named)
      return r.errors
    },
    userFunctions: () => [...fns.user.defs],
    namedFormulas: () => [...named].map(([name, formula]) => ({ name, formula })),
  }

  if (options.formulas !== undefined) engine.setFormulas(options.formulas)
  if (options.userFunctions) setUserFunctions(options.userFunctions)
  if (options.namedFormulas) setNamedFormulas(options.namedFormulas)
  return engine
}
