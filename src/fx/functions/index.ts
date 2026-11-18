import type { FxFunctionDoc, FxNamedFormula } from '../../contracts.ts'
import { behaviourFns } from './behaviour.ts'
import { collabFns } from './collab.ts'
import { colorFns } from './color.ts'
import { dateFns } from './dates.ts'
import { logicFns } from './logic.ts'
import { mathFns } from './math.ts'
import { tableFns } from './table.ts'
import { textFns } from './text.ts'
import type { FnDef } from './types.ts'
import { buildUserFunctions, EMPTY_USER_FUNCTIONS, userFunctionNoCase, type UserFunctionSet } from './user.ts'

const ALL: FnDef[] = [...logicFns, ...textFns, ...mathFns, ...dateFns, ...tableFns, ...colorFns, ...behaviourFns, ...collabFns]

const BY_NAME = new Map<string, FnDef>()
const BY_LOWER = new Map<string, FnDef>()
for (const f of ALL) {
  BY_NAME.set(f.name, f)
  BY_LOWER.set(f.name.toLowerCase(), f)
}

/** Is `name` a built-in function (never a user-defined one)? */
export function isBuiltinFunction(name: string): boolean { return BY_NAME.has(name) }
/** A built-in function by exact name. */
export function builtinFunction(name: string): FnDef | undefined { return BY_NAME.get(name) }

/**
 * The functions one evaluation can call: the built-ins (immutable, shared) plus one engine's user-defined
 * functions. Passed explicitly into check / evaluate / signatureAt; nothing here is global mutable state.
 */
export interface FunctionTable {
  /** built-in functions first, then user-defined ones */
  lookup(name: string): FnDef | undefined
  /** case-insensitive match, for "Did you mean ...?" */
  suggest(name: string): FnDef | undefined
  /** docs of every function, sorted by name */
  docs(): FxFunctionDoc[]
  readonly user: UserFunctionSet
}

const BUILTIN_DOCS: FxFunctionDoc[] = ALL.map(({ name, signature, summary, kind }) => ({ name, signature, summary, kind }))

export function functionTable(user: UserFunctionSet = EMPTY_USER_FUNCTIONS): FunctionTable {
  let docs: FxFunctionDoc[] | null = null
  return {
    user,
    lookup: (name) => BY_NAME.get(name) ?? user.byName.get(name),
    suggest: (name) => BY_LOWER.get(name.toLowerCase()) ?? userFunctionNoCase(user, name),
    docs: () => (docs ??= [...BUILTIN_DOCS, ...user.docs].sort((a, b) => a.name.localeCompare(b.name))).slice(),
  }
}

/** Table with only the built-ins. */
export const BUILTIN_TABLE: FunctionTable = functionTable()

export function userFunctionSet(defs: readonly FxNamedFormula[]): UserFunctionSet {
  return buildUserFunctions(defs, isBuiltinFunction)
}

export type { FnDef, UserFunctionSet }
