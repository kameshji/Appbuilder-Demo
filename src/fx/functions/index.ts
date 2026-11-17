import type { FxFunctionDoc } from '@/contracts'
import { behaviourFns } from './behaviour'
import { colorFns } from './color'
import { dateFns } from './dates'
import { logicFns } from './logic'
import { mathFns } from './math'
import { tableFns } from './table'
import { textFns } from './text'
import type { FnDef } from './types'

const ALL: FnDef[] = [...logicFns, ...textFns, ...mathFns, ...dateFns, ...tableFns, ...colorFns, ...behaviourFns]

const BY_NAME = new Map<string, FnDef>()
const BY_LOWER = new Map<string, FnDef>()
for (const f of ALL) {
  BY_NAME.set(f.name, f)
  BY_LOWER.set(f.name.toLowerCase(), f)
}

export function lookupFunction(name: string): FnDef | undefined { return BY_NAME.get(name) }
/** Case-insensitive match, for "Did you mean ...?" */
export function suggestFunction(name: string): FnDef | undefined { return BY_LOWER.get(name.toLowerCase()) }

export function functionDocs(): FxFunctionDoc[] {
  return ALL.map(({ name, signature, summary, kind }) => ({ name, signature, summary, kind })).sort((a, b) => a.name.localeCompare(b.name))
}

export type { FnDef }
