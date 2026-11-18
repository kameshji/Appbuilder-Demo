import type { FxFunctionDoc } from '@/contracts'
import { behaviourFns } from './behaviour'
import { colorFns } from './color'
import { dateFns } from './dates'
import { logicFns } from './logic'
import { mathFns } from './math'
import { tableFns } from './table'
import { textFns } from './text'
import type { FnDef } from './types'
import { bindBuiltinCheck, setUserFunctions, userDocs, userFunction, userFunctionNoCase } from './user'

const ALL: FnDef[] = [...logicFns, ...textFns, ...mathFns, ...dateFns, ...tableFns, ...colorFns, ...behaviourFns]

const BY_NAME = new Map<string, FnDef>()
const BY_LOWER = new Map<string, FnDef>()
for (const f of ALL) {
  BY_NAME.set(f.name, f)
  BY_LOWER.set(f.name.toLowerCase(), f)
}

bindBuiltinCheck((name) => BY_NAME.has(name))

/** Is `name` a built-in function (never a user-defined one)? */
export function isBuiltinFunction(name: string): boolean { return BY_NAME.has(name) }
/** Built-in functions first, then user-defined ones. */
export function lookupFunction(name: string): FnDef | undefined { return BY_NAME.get(name) ?? userFunction(name) }
/** Case-insensitive match, for "Did you mean ...?" */
export function suggestFunction(name: string): FnDef | undefined { return BY_LOWER.get(name.toLowerCase()) ?? userFunctionNoCase(name) }

export function functionDocs(): FxFunctionDoc[] {
  const builtin = ALL.map(({ name, signature, summary, kind }) => ({ name, signature, summary, kind }))
  return [...builtin, ...userDocs()].sort((a, b) => a.name.localeCompare(b.name))
}

export { setUserFunctions }

export type { FnDef }
