// STUB. Replaced by the Platform agent. Signatures are final (see ./contracts.ts).
import type { PlatformApi, WorkspaceState } from './contracts'
export * from './contracts'
const ni = (): never => { throw new Error('platform not implemented yet') }
export const platform = new Proxy({}, { get: () => ni }) as unknown as PlatformApi
export function usePlatform<T>(_selector: (s: WorkspaceState) => T): T { return ni() }
