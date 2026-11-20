/**
 * Custom actions of HTTP connections travel in solutions (P1 package D): the connection entry of a package carries
 * `actions` (the definitions, never secrets); importing creates or replaces them on the target connection.
 */
import type { Services } from '../contracts.ts'
import { checkCustomAction } from './http.ts'

type Impl = { custom?: { list(id: string): Promise<{ def: unknown }[]>; put(id: string, def: never, by: string | null): Promise<unknown> } }
const impl = (s: Services): Impl | undefined => s.actions as unknown as Impl | undefined

/** the custom actions of a connection, for a package (empty for other kinds) */
export async function exportConnectionActions(s: Services, conn: { id: string; connector: string }): Promise<{ actions?: unknown[] }> {
  if (conn.connector !== 'http') return {}
  const list = (await impl(s)?.custom?.list(conn.id)) ?? []
  return list.length ? { actions: list.map((c) => c.def) } : {}
}

/** creates or replaces the package's custom actions on a connection; returns warnings for the ones refused */
export async function importConnectionActions(s: Services, connectionId: string, raw: unknown, by: string | null): Promise<string[]> {
  if (!Array.isArray(raw) || !impl(s)?.custom) return []
  const warnings: string[] = []
  for (const a of raw.slice(0, 300)) {
    const { def, problems } = checkCustomAction(a)
    if (problems.length) {
      warnings.push(`The action "${String((a as { id?: unknown })?.id ?? '?')}" was skipped: ${problems[0]}`)
      continue
    }
    await impl(s)!.custom!.put(connectionId, def as never, by)
  }
  return warnings
}

/** connector kinds a package may contain */
export const PACKAGE_CONNECTORS = ['postgres', 'mysql', 'gsheets', 'http', 'email', 'whatsapp']
