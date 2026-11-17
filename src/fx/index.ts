// STUB. Replaced by the Fx agent. Signatures are final (see src/contracts.ts).
import type { FxApi } from '@/contracts'
const ni = (): never => { throw new Error('fx not implemented yet') }
export const fx: FxApi = { check: ni, evaluate: ni, referencedNames: ni, renameIdentifier: ni, functions: ni, enums: ni }
