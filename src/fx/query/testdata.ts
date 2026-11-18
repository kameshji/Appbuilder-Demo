/**
 * Sample tables and a deterministic formula corpus for the Query v2 tests (parity.test.ts). Test helper only.
 * Rows deliberately mix blanks (NULL and ''), case variants, numeric-looking text, zero, negatives, decimals,
 * true/false/blank booleans, calendar dates and instants, and rows sharing a createdOn (id breaks the tie).
 */
import type { FxRecord, FxScope, FxValue } from '../../contracts.ts'
import type { SchemaInfo } from '../../platform/query.ts'

/** mulberry32: small deterministic PRNG */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const SCHEMA: SchemaInfo = {
  tables: {
    Tickets: {
      columns: {
        id: 'text', createdOn: 'datetime', Title: 'text', Status: 'text', Code: 'text', Owner: 'text',
        Priority: 'number', Score: 'number', Active: 'boolean', Flag: 'boolean', Due: 'date', Start: 'date',
        Updated: 'datetime', Blob: 'other',
      },
    },
    Customers: {
      columns: { id: 'text', createdOn: 'datetime', Name: 'text', Email: 'text', Tier: 'number' },
    },
  },
}

const TITLES = ['Printer jam', 'printer JAM', 'VPN down', 'New laptop', 'Reset password', '', null, 'Ünïcode café', 'zebra', 'Alpha', 'alpha', 'Beta test', 'Monitor flicker', 'Mail bounce']
const STATUSES = ['Open', 'open', 'OPEN', 'Closed', 'closed', 'In progress', '', null]
const CODES = ['10', '9', '010', 'A1', 'a1', ' 7 ', '', null, '1,000', '12%', 'x']
const OWNERS = ['asha@example.com', 'BEN@example.com', 'chitra@example.org', null, '']
const PRIORITIES: (number | null)[] = [0, 1, 2, 3, 5, -1, 2.5, 10, null, 100, 0.1]
const BOOLS: (boolean | null)[] = [true, false, null]

export function ticketRows(): FxRecord[] {
  const r = rng(7)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const out: FxRecord[] = []
  for (let i = 0; i < 40; i++) {
    const id = `t${String(i).padStart(2, '0')}`
    // pairs of rows share a createdOn, so the id must break the tie
    const createdOn = new Date(Date.UTC(2026, 0, 1, 8, Math.floor(i / 2) * 7))
    const due = r() < 0.2 ? null : new Date(2026, Math.floor(r() * 12), 1 + Math.floor(r() * 28))
    const start = r() < 0.2 ? null : new Date(2026, Math.floor(r() * 12), 1 + Math.floor(r() * 28))
    const updated = r() < 0.2 ? null : new Date(Date.UTC(2026, Math.floor(r() * 12), 1 + Math.floor(r() * 28), Math.floor(r() * 24), Math.floor(r() * 60)))
    out.push({
      __id: id, id, createdOn, Title: pick(TITLES), Status: pick(STATUSES), Code: pick(CODES), Owner: pick(OWNERS),
      Priority: pick(PRIORITIES), Score: pick(PRIORITIES), Active: pick(BOOLS), Flag: pick(BOOLS), Due: due, Start: start,
      Updated: updated, Blob: null,
    })
  }
  // today, so Today()-based conditions hit something
  const now = new Date()
  out[3]!.Due = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  out[4]!.Updated = new Date(now.getTime() - 3600000)
  return out
}

export function customerRows(): FxRecord[] {
  return [
    { __id: 'c1', id: 'c1', createdOn: new Date(Date.UTC(2026, 0, 1)), Name: 'Asha', Email: 'asha@example.com', Tier: 1 },
    { __id: 'c2', id: 'c2', createdOn: new Date(Date.UTC(2026, 0, 2)), Name: 'Ben', Email: 'ben@example.com', Tier: 2 },
    { __id: 'c3', id: 'c3', createdOn: new Date(Date.UTC(2026, 0, 3)), Name: 'chitra', Email: null, Tier: null },
  ]
}

/** outside values the formulas use: variables, control records, the signed-in user */
export function sampleScope(tables: Record<string, FxRecord[]>): FxScope {
  const vars: Record<string, FxValue> = {
    ...tables,
    varMin: 2,
    varText: 'open',
    varBlank: null,
    varDate: new Date(2026, 5, 15),
    varList: [{ Value: 'Open' }, { Value: 'Closed' }],
    TextInput1: { Text: 'pri', Value: 'pri' },
    Dropdown1: { Selected: { Value: 'Closed' } },
    Slider1: { Value: 3 },
    'User()': { FullName: 'Asha', Email: 'asha@example.com', Image: '' },
  }
  return { resolve: (n) => (Object.prototype.hasOwnProperty.call(vars, n) ? vars[n] : undefined) }
}

/* ------------------------------------------------------------------ corpus */

const LITS: Record<string, string[]> = {
  text: ['"open"', '"OPEN"', '"Closed"', '""', 'Blank()', '"printer jam"', '"m"', 'varText', 'Dropdown1.Selected.Value', 'TextInput1.Text', '"10"', '10', 'true', 'Lower("ALPHA")', 'User().Email'],
  number: ['0', '1', '2.5', '-1', 'Blank()', '"2"', '"x"', 'varMin', 'Slider1.Value', 'true', '""', 'Slider1.Value * 2', '100'],
  boolean: ['true', 'false', 'Blank()', '"true"', '"FALSE"', '1', '0', '"1"', '"maybe"'],
  date: ['Today()', 'DateAdd(Today(), -30, "Days")', 'DateAdd(Today(), 2, "Months")', 'Date(2026, 6, 1)', 'varDate', 'Blank()', 'Now()', '"2026-03-01"', 'DateValue("2026-02-10")', 'DateAdd(varDate, 12, "Hours")'],
  datetime: ['Now()', 'DateAdd(Now(), -7, "Days")', 'Date(2026, 6, 1)', 'Today()', 'Blank()', '"2026-05-01T10:00:00Z"', 'varDate'],
}
const COLS: Record<string, string[]> = {
  text: ['Title', 'Status', 'Code', 'Owner'],
  number: ['Priority', 'Score'],
  boolean: ['Active', 'Flag'],
  date: ['Due', 'Start'],
  datetime: ['Updated', 'createdOn'],
}
const CMP = ['=', '<>', '<', '>', '<=', '>=']
const SORTABLE = ['Title', 'Status', 'Owner', 'Priority', 'Score', 'Active', 'Due', 'Updated', 'createdOn']

/** a deterministic corpus of formulas over Tickets (and a few over Customers) */
export function corpus(seed = 20261118, size = 650): string[] {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const kinds = Object.keys(COLS)
  const atom = (): string => {
    const k = pick(kinds)
    const col = pick(COLS[k]!)
    const roll = r()
    if (roll < 0.45) return `${col} ${pick(CMP)} ${pick(LITS[k]!)}`
    if (roll < 0.55) return `${pick(LITS[k]!)} ${pick(CMP)} ${col}`
    if (roll < 0.62) {
      const other = pick(COLS[k]!.filter((x) => x !== col).concat(col))
      return `${col} ${pick(CMP)} ${other}`
    }
    if (roll < 0.68) return pick([`IsBlank(${col})`, `!IsBlank(${col})`, `Not(IsBlank(${col}))`])
    if (roll < 0.76) {
      const t = pick(COLS.text!)
      return pick([`StartsWith(${t}, ${pick(['"p"', '"Al"', '""', 'TextInput1.Text', '"open"'])})`, `EndsWith(${t}, ${pick(['"m"', '".com"', '""', '"N"'])})`,
        `${pick(['"jam"', '"A"', '""', 'TextInput1.Text', '"é"'])} in ${t}`, `${pick(['"jam"', '"A"', '"JAM"'])} exactin ${t}`])
    }
    if (roll < 0.84) {
      return pick([`Status in ["Open", "closed"]`, `Status in varList`, `Status exactin ["Open", "closed"]`, `Status in ["Open", Blank()]`,
        `Priority in [1, "2", Blank()]`, `Priority in [5, 10]`, `Active in [true]`, `Due in [Today()]`, `Title in ["zebra", ""]`, `Code in ["10", "x"]`])
    }
    if (roll < 0.9) return pick(['Active', '!Active', 'Flag', 'Priority', '!Priority', 'Not(Flag)'])
    if (roll < 0.95) return pick([`ThisRecord.Priority > varMin`, `ThisRecord.Status = "open"`, `IsBlank(ThisRecord.Due)`])
    return pick(['true', 'false', 'varMin > 1', 'Len(Title) > 3', 'Priority * 2 > 4', 'Lower(Status) = "open"', 'DateAdd(Due, 1, "Days") > Today()', 'Code < "5"', 'Title > ""', 'Active > false', 'Status in "Open, Closed"', 'If(Active, Priority > 1, false)'])
  }
  const cond = (): string => {
    const roll = r()
    if (roll < 0.55) return atom()
    if (roll < 0.7) return `${atom()} && ${atom()}`
    if (roll < 0.8) return `${atom()} || ${atom()}`
    if (roll < 0.88) return `And(${atom()}, Or(${atom()}, ${atom()}))`
    if (roll < 0.94) return `Not(${atom()})`
    return `!(${atom()} || ${atom()})`
  }
  const order = (): string => pick(['', ', SortOrder.Ascending', ', SortOrder.Descending', ', "Descending"'])
  const filt = (): string => (r() < 0.15 ? `Filter(Tickets, ${cond()}, ${cond()})` : `Filter(Tickets, ${cond()})`)
  const sorted = (): string => {
    const roll = r()
    if (roll < 0.5) return `Sort(${filt()}, ${pick(SORTABLE)}${order()})`
    if (roll < 0.8) return `SortByColumns(${filt()}, "${pick(SORTABLE)}"${order()}, "${pick(SORTABLE)}"${order()})`
    return `Sort(Sort(${filt()}, ${pick(SORTABLE)}), ${pick(SORTABLE)}, SortOrder.Descending)`
  }
  const tableExpr = (): string => {
    const roll = r()
    if (roll < 0.25) return filt()
    if (roll < 0.45) return sorted()
    if (roll < 0.52) return `Search(${pick(['Tickets', filt()])}, ${pick(['"jam"', '"A"', '""', 'TextInput1.Text', '"EXAMPLE"'])}, "Title", "Owner")`
    if (roll < 0.6) return `ShowColumns(${filt()}, "Title", "Priority", "Due")`
    if (roll < 0.65) return `DropColumns(${sorted()}, "Blob", "Code")`
    if (roll < 0.7) return `Filter(Tickets As t, t.Priority >= varMin || t.Status = varText)`
    return filt()
  }
  const out = new Set<string>()
  const forms: (() => string)[] = [
    () => `=${tableExpr()}`,
    () => `=CountRows(${tableExpr()})`,
    () => `=CountIf(Tickets, ${cond()})`,
    () => `=FirstN(${sorted()}, ${pick(['3', '0', 'Slider1.Value', '50'])})`,
    () => `=LastN(${sorted()}, ${pick(['2', '1', '0'])})`,
    () => `=First(${sorted()})`,
    () => `=Last(${pick([sorted(), filt()])})`,
    () => `=First(${sorted()}).Title`,
    () => `=LookUp(Tickets, ${cond()})`,
    () => `=LookUp(${sorted()}, ${cond()}, Title)`,
    () => `=LookUp(Tickets, ${cond()}, Title & " / " & Priority)`,
    () => `=${pick(['Sum', 'Average', 'Min', 'Max'])}(${pick([filt(), 'Tickets', `FirstN(${sorted()}, 5)`])}, ${pick(['Priority', 'Score'])})`,
    () => `=Distinct(${filt()}, ${pick(['Status', 'Active', 'Due', 'Priority', 'Owner'])})`,
    () => `=Sort(Distinct(${filt()}, Status), Value${order()})`,
    () => `=DropColumns(AddColumns(GroupBy(${filt()}, "${pick(['Status', 'Active', 'Owner'])}", "G"), "Total", Sum(G, Priority), "N", CountRows(G), "Hi", CountIf(G, Priority > 2), "Avg", Average(G, Score)), "G")`,
    () => `=CountRows(GroupBy(${filt()}, "Status", "Items"))`,
    () => `=SortByColumns(DropColumns(AddColumns(GroupBy(Tickets, "Status", "G"), "N", CountRows(G)), "G"), "N", SortOrder.Descending, "Status")`,
    () => `=IsEmpty(${filt()})`,
    () => `=!IsEmpty(${filt()})`,
    () => `="Open: " & CountRows(${filt()}) & " of " & CountRows(Tickets)`,
    () => `=Concat(FirstN(${sorted()}, 4), Title & ";")`,
    () => `=AddColumns(${filt()}, "Double", Priority * 2)`,
    () => `=Filter(FirstN(${sorted()}, 10), ${cond()})`,
    () => `=Sort(FirstN(${filt()}, 6), ${pick(SORTABLE)})`,
    () => `=If(varMin > 1, ${filt()}, ${filt()})`,
    () => `=Concat(${filt()}, Title)`,
    () => `=Filter(Tickets, Owner = LookUp(Customers, Name = "Asha", Email))`,
    () => `=CountRows(Filter(Customers, ${pick(['Tier > 1', 'IsBlank(Email)', 'Name = "CHITRA"', 'Tier = Blank()'])}))`,
    () => `=Sum(Tickets, Priority * 2)`,
    () => `=ForAll(Tickets, Title)`,
    () => `=ForAll(varList, CountRows(Filter(Tickets, Status = Value)))`,
    () => `=AddColumns(GroupBy(Tickets, "Status", "G"), "N", CountRows(G))`,
  ]
  let guard = 0
  while (out.size < size && guard++ < size * 20) out.add(pick(forms)())
  return [...out]
}
