/**
 * Deterministic corpus of formulas with computed numbers and Year() comparisons (P0 package D), over the sample tables
 * of testdata.ts. Used by the reference parity test (parity.test.ts) and the PostgreSQL parity run
 * (server/connectors/postgres/query-v2.integration.test.ts). Test helper only.
 */
import { rng } from './testdata.ts'

const NUM_COLS = ['Priority', 'Score', 'ThisRecord.Priority']
const LITS = ['0', '1', '2', '3', '-1', '0.5', '2.5', '10', '0.1', '1.15', 'varMin', 'Slider1.Value', '"2"', 'Blank()', 'true', '100']
const DIVS = ['2', '3', '4', '0.5', '-4', '10', 'varMin', 'Slider1.Value', '"4"']
const CMP = ['=', '<>', '<', '>', '<=', '>=']

export function exprCorpus(seed = 4242, size = 220): string[] {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const operand = (depth: number): string => {
    const roll = r()
    if (depth <= 0 || roll < 0.35) return pick(NUM_COLS)
    if (roll < 0.5) return pick(LITS)
    if (roll < 0.62) return `${operand(depth - 1)} ${pick(['+', '-', '*'])} ${operand(depth - 1)}`
    if (roll < 0.7) return `(${operand(depth - 1)}) / ${pick(DIVS)}`
    if (roll < 0.75) return `-${pick(NUM_COLS)}`
    if (roll < 0.8) return `Abs(${operand(depth - 1)})`
    if (roll < 0.9) return `${pick(['Round', 'RoundUp', 'RoundDown'])}(${operand(depth - 1)}${pick(['', ', 0', ', 1', ', 2', ', -1'])})`
    if (roll < 0.94) return `${pick(NUM_COLS)}%`
    return `Active * ${pick(['2', '3'])}`
  }
  /** an expression that certainly reads a column */
  const expr = (): string => {
    const roll = r()
    if (roll < 0.5) return `${pick(NUM_COLS)} ${pick(['+', '-', '*'])} ${operand(2)}`
    if (roll < 0.65) return `${pick(['Round', 'RoundUp', 'RoundDown'])}(${pick(NUM_COLS)} ${pick(['*', '/'])} ${pick(['3', '7', '1.15', '0.3'])}${pick(['', ', 1', ', 2', ', -1'])})`
    if (roll < 0.75) return `(${pick(NUM_COLS)} + ${pick(NUM_COLS)}) / ${pick(DIVS)}`
    if (roll < 0.85) return `Abs(${pick(NUM_COLS)} - ${operand(1)})`
    return `${operand(1)} * ${pick(NUM_COLS)}`
  }
  const cond = (): string => {
    const roll = r()
    if (roll < 0.55) return `${expr()} ${pick(CMP)} ${pick(['0', '1', '2.5', '5', '-1', 'varMin', 'Blank()', '"3"', 'Slider1.Value * 2', 'Score', 'true'])}`
    if (roll < 0.65) return `${pick(['5', 'varMin', '0'])} ${pick(CMP)} ${expr()}`
    if (roll < 0.72) return `${expr()} ${pick(CMP)} ${expr()}`
    if (roll < 0.77) return expr()
    if (roll < 0.87) return `Year(${pick(['Due', 'Start', 'Updated', 'createdOn'])}) ${pick(CMP)} ${pick(['2026', '2025', '2027', '2026.5', 'Year(Today())', 'Blank()', '0', '"2026"'])}`
    if (roll < 0.9) return `${pick(['2026', 'Year(Today())'])} ${pick(CMP)} Year(${pick(['Due', 'Updated'])})`
    if (roll < 0.95) return `${expr()} > 1 && ${pick(['Active', 'Status = "open"', 'Priority > 0'])}`
    // refused on purpose
    return pick(['Priority / Score > 1', 'Priority / 0 > 1', 'Priority ^ 2 > 4', 'Month(Due) = 3', 'Priority * 2 > "x"', 'Mod(Priority, 2) = 1', 'Len(Title) * 2 > 4', 'Year(Title) = 2026'])
  }
  const filt = () => `Filter(Tickets, ${cond()})`
  const forms: (() => string)[] = [
    () => `=${filt()}`,
    () => `=CountRows(${filt()})`,
    () => `=CountIf(Tickets, ${cond()})`,
    () => `=${pick(['Sum', 'Average', 'Min', 'Max'])}(${pick(['Tickets', filt(), `FirstN(Sort(Tickets, Priority), 5)`])}, ${expr()})`,
    () => `=${pick(['Sum', 'Average'])}(Tickets, ${pick(['Priority * Score', 'Priority * 1', 'Score + 0', '5', 'Round(Priority * 1.15, 2)', 'Active * 10'])})`,
    () => `=DropColumns(AddColumns(GroupBy(${pick(['Tickets', filt()])}, "${pick(['Status', 'Active'])}", "G"), "Rev", Sum(G, ${expr()}), "Avg", Average(G, ${expr()}), "N", CountIf(G, ${cond()})), "G")`,
    () => `=Sort(${filt()}, ${pick(['Priority', 'Title', 'Due'])}${pick(['', ', SortOrder.Descending'])})`,
    () => `=LookUp(Tickets, ${cond()}, Title)`,
    () => `=Sum(Filter(Tickets, ${cond()}), Priority * Score)`,
    () => `=Sort(Tickets, Priority * 2)`,
  ]
  const out = new Set<string>()
  let guard = 0
  while (out.size < size && guard++ < size * 30) out.add(pick(forms)())
  return [...out]
}
