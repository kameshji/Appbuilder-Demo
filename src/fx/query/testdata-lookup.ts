/**
 * P3-C: sorting a list by a lookup column's label (a sort key with `via`, docs/dev/query-v2.md 5b). Sample tables and a
 * deterministic corpus for the parity tests: the engine vs the reference executor (lookup-sort.test.ts) and the
 * reference executor vs PostgreSQL in several collations (server/connectors/postgres/query-v2.integration.test.ts).
 * Test helper only.
 *
 * Clients (the target) mixes NULL and '' names, case variants, accents (code point order puts "é" after "z"), spaces
 * and punctuation, ties, and blank numbers, dates, instants and booleans. Some clients are HIDDEN from the viewer
 * (`Hidden = true`: their rows are not readable); Orders point at readable clients, hidden clients, ids that do not
 * exist, and at nothing (NULL), through two lookups (Client, Agent). Orders share createdOn in pairs (id breaks ties).
 */
import type { FxRecord, FxScope, FxValue } from '../../contracts.ts'
import type { SchemaInfo } from '../../platform/query.ts'
import { rng } from './testdata.ts'

export const LOOKUP_SCHEMA: SchemaInfo = {
  tables: {
    Clients: {
      columns: { id: 'text', createdOn: 'datetime', Name: 'text', Tier: 'number', Since: 'date', Seen: 'datetime', Vip: 'boolean', Hidden: 'boolean' },
    },
    Orders: {
      columns: { id: 'text', createdOn: 'datetime', Title: 'text', Amount: 'number', Client: 'text', Agent: 'text' },
      lookups: { Client: 'Clients', Agent: 'Clients' },
    },
  },
}

/** target names: no number-like text (the engine orders two number-like texts as numbers, query-v2.md section 10) */
export const CLIENT_NAMES: (string | null)[] = [
  'Asha', 'asha', 'ASHA', 'Ben', 'ben ', ' ben', 'Éva', 'éva', 'eva', 'Zoë', 'zoe', 'Zed', 'zed', 'Ölaf', 'ölaf', 'Ünal', 'ångström',
  'Ab', 'ab', 'a b', 'a-b', 'a_b', "O'Neil", 'oneil', 'Mary-Jo', 'mary jo', 'ß', 'ss', 'Ä', 'ä', '', null, null, '',
]

export function clientRows(): FxRecord[] {
  const r = rng(31)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  return CLIENT_NAMES.map((name, i) => {
    const id = `cl${String(i).padStart(2, '0')}`
    return {
      __id: id, id, createdOn: new Date(Date.UTC(2025, 0, 1 + Math.floor(i / 3))), Name: name,
      Tier: pick([0, 1, 2, 2, 3, -1, 2.5, null] as const),
      Since: r() < 0.25 ? null : new Date(2024, Math.floor(r() * 12), 1 + Math.floor(r() * 28)),
      Seen: r() < 0.25 ? null : new Date(Date.UTC(2026, Math.floor(r() * 12), 1 + Math.floor(r() * 28), Math.floor(r() * 24))),
      Vip: pick([true, false, null] as const),
      // every 4th client is hidden from the viewer (their rows are not readable): they must sort as blank
      Hidden: i % 4 === 1,
    }
  })
}

export function orderRows(clients: FxRecord[]): FxRecord[] {
  const r = rng(53)
  const ids = clients.map((c) => c.id as string)
  const ref = (): string | null => {
    const x = r()
    if (x < 0.08) return null
    if (x < 0.13) return `gone${Math.floor(r() * 3)}` // points at a row that does not exist (deleted)
    return ids[Math.floor(r() * ids.length)]!
  }
  const out: FxRecord[] = []
  for (let i = 0; i < 160; i++) {
    const id = `o${String(i).padStart(3, '0')}`
    out.push({
      __id: id, id, createdOn: new Date(Date.UTC(2026, 1, 1, 9, Math.floor(i / 2))), Title: `Order ${i % 37}`,
      Amount: Math.floor(r() * 6), Client: ref(), Agent: ref(),
    })
  }
  return out
}

/** the clients the viewer may read (the row filter `Hidden = false` of the PostgreSQL test) */
export const readableClients = (clients: FxRecord[]): FxRecord[] => clients.filter((c) => c.Hidden !== true)

/** the engine's scope as the viewer: a lookup reads the fields of a readable client, a hidden or missing one reads blank */
export function lookupScope(tables: { Orders: FxRecord[]; Clients: FxRecord[] }): FxScope {
  const readable = new Map(readableClients(tables.Clients).map((c) => [c.id as string, c]))
  const vars: Record<string, FxValue> = { Orders: tables.Orders, Clients: readableClients(tables.Clients), varMin: 2 }
  return {
    resolve: (n) => (Object.prototype.hasOwnProperty.call(vars, n) ? vars[n] : undefined),
    recordById: (x) => readable.get(x) ?? null,
  }
}

const FIELDS = ['Name', 'Name', 'Name', 'Tier', 'Since', 'Seen', 'Vip']
const LOOKUPS = ['Client', 'Client', 'Agent']

/** a deterministic corpus of formulas sorting Orders through its lookups (and a few that must be refused) */
export function lookupCorpus(seed = 20261120, size = 160): string[] {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const order = () => pick(['', '', ', SortOrder.Ascending', ', SortOrder.Descending'])
  const key = () => `${pick(LOOKUPS)}.${pick(FIELDS)}`
  const sorted = (): string => {
    const base = pick(['Orders', 'Orders', 'Filter(Orders, Amount >= varMin)', 'Filter(Orders, Title <> "Order 3")', 'Sort(Orders, Amount)', 'Sort(Orders, Title, SortOrder.Descending)'])
    let s = `Sort(${base}, ${key()}${order()})`
    if (r() < 0.3) s = `Sort(${s}, ${key()}${order()})`
    return s
  }
  const forms: (() => string)[] = [
    () => `=${sorted()}`,
    () => `=${sorted()}`,
    () => `=${sorted()}`,
    () => `=FirstN(${sorted()}, ${pick([1, 5, 12, 40])})`,
    () => `=LastN(${sorted()}, ${pick([1, 7, 30])})`,
    () => `=First(${sorted()})`,
    () => `=Last(${sorted()})`,
    () => `=ShowColumns(${sorted()}, "Title", "Client")`,
    () => `=CountRows(${sorted()})`,
    () => `=Sum(${sorted()}, Amount)`,
    () => `=First(${sorted()}).Title`,
    // refused: the order through a lookup matters for grouping (no partial or wrong result)
    () => `=Distinct(${sorted()}, Title)`,
    () => `=Sum(FirstN(${sorted()}, 5), Amount)`,
  ]
  const out = new Set<string>()
  while (out.size < size) out.add(pick(forms)())
  return [...out]
}
