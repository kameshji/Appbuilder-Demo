/**
 * The ledger core (P3 package L; docs/dev/ledgers-gst.md): chart of accounts, financial years and monthly periods with
 * locking (draft G9.9, G9.10), journals and the reports over them. Every function takes the SqlDb to run on, so a
 * caller that is inside a transaction (issuing a document) posts in that same transaction.
 *
 * Journal rules, all checked in postJournal INSIDE the transaction that writes them:
 *   - at least two lines; every line a debit or a credit of whole paise, never both, never zero;
 *   - total debits = total credits (checked on the input and again on the rows the database stored);
 *   - the date lies in a period that exists; 'locked' refuses everybody, 'soft_locked' everybody but an Accounts admin
 *     (the period row is locked FOR SHARE, so a lock cannot slip in between the check and the commit);
 *   - every account exists and is active.
 * Posted journals and lines are never updated or deleted: there is no code path that does. A correction is a reversal
 * (reverseJournal: the same lines with debit and credit swapped, linked by `reverses`, at most one per journal).
 */
import type { SqlDb } from '../contracts.ts'
import { rowUid, uid } from '../util.ts'
import { financialYearOf, monthsOf } from '../gst/engine.ts'
import { rupees, type Paise } from '../gst/money.ts'
import { T, conflict, invalid, notFound, type Level } from './core.ts'
import { HttpError } from '../contracts.ts'

export type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense'
export const ACCOUNT_KINDS: AccountKind[] = ['asset', 'liability', 'equity', 'income', 'expense']
export interface Account { id: string; code: string; name: string; kind: AccountKind; systemKey: string | null; active: boolean }

/**
 * The seeded default chart: a small general chart plus the GST accounts of draft section 9.1. `key` is what the
 * postings look up (postings.ts), so an administrator may rename or renumber an account without breaking them.
 */
export const DEFAULT_ACCOUNTS: { code: string; name: string; kind: AccountKind; key: string }[] = [
  { code: '1000', name: 'Cash', kind: 'asset', key: 'cash' },
  { code: '1010', name: 'Bank', kind: 'asset', key: 'bank' },
  { code: '1100', name: 'Trade receivables', kind: 'asset', key: 'receivables' },
  { code: '1200', name: 'Input CGST', kind: 'asset', key: 'input_cgst' },
  { code: '1201', name: 'Input SGST', kind: 'asset', key: 'input_sgst' },
  { code: '1202', name: 'Input UTGST', kind: 'asset', key: 'input_utgst' },
  { code: '1203', name: 'Input IGST', kind: 'asset', key: 'input_igst' },
  { code: '1204', name: 'Input Cess', kind: 'asset', key: 'input_cess' },
  { code: '1210', name: 'Input CGST (RCM)', kind: 'asset', key: 'input_cgst_rcm' },
  { code: '1211', name: 'Input SGST (RCM)', kind: 'asset', key: 'input_sgst_rcm' },
  { code: '1212', name: 'Input UTGST (RCM)', kind: 'asset', key: 'input_utgst_rcm' },
  { code: '1213', name: 'Input IGST (RCM)', kind: 'asset', key: 'input_igst_rcm' },
  { code: '1220', name: 'GST on advances suspense', kind: 'asset', key: 'advance_gst_suspense' },
  { code: '1300', name: 'Inventory', kind: 'asset', key: 'inventory' },
  { code: '1500', name: 'Fixed assets', kind: 'asset', key: 'fixed_assets' },
  { code: '2000', name: 'Trade payables', kind: 'liability', key: 'payables' },
  { code: '2100', name: 'Output CGST', kind: 'liability', key: 'output_cgst' },
  { code: '2101', name: 'Output SGST', kind: 'liability', key: 'output_sgst' },
  { code: '2102', name: 'Output UTGST', kind: 'liability', key: 'output_utgst' },
  { code: '2103', name: 'Output IGST', kind: 'liability', key: 'output_igst' },
  { code: '2104', name: 'Output Cess', kind: 'liability', key: 'output_cess' },
  { code: '2110', name: 'RCM CGST payable', kind: 'liability', key: 'rcm_cgst' },
  { code: '2111', name: 'RCM SGST payable', kind: 'liability', key: 'rcm_sgst' },
  { code: '2112', name: 'RCM UTGST payable', kind: 'liability', key: 'rcm_utgst' },
  { code: '2113', name: 'RCM IGST payable', kind: 'liability', key: 'rcm_igst' },
  { code: '2120', name: 'Customer advances', kind: 'liability', key: 'customer_advances' },
  { code: '2130', name: 'Composition tax CGST payable', kind: 'liability', key: 'composition_cgst' },
  { code: '2131', name: 'Composition tax SGST payable', kind: 'liability', key: 'composition_sgst' },
  { code: '2200', name: 'Loans', kind: 'liability', key: 'loans' },
  { code: '3000', name: 'Capital', kind: 'equity', key: 'capital' },
  { code: '3100', name: 'Retained earnings', kind: 'equity', key: 'retained_earnings' },
  { code: '4000', name: 'Sales (taxable)', kind: 'income', key: 'sales_taxable' },
  { code: '4001', name: 'Sales (exempt)', kind: 'income', key: 'sales_exempt' },
  { code: '4002', name: 'Sales (nil-rated)', kind: 'income', key: 'sales_nil' },
  { code: '4003', name: 'Sales (zero-rated)', kind: 'income', key: 'sales_zero_rated' },
  { code: '4004', name: 'Sales (non-GST)', kind: 'income', key: 'sales_non_gst' },
  { code: '4010', name: 'Sales returns', kind: 'income', key: 'sales_returns' },
  { code: '4020', name: 'Sales discounts', kind: 'income', key: 'sales_discounts' },
  { code: '4100', name: 'Other income', kind: 'income', key: 'other_income' },
  { code: '4900', name: 'Round-off', kind: 'income', key: 'round_off' },
  { code: '5000', name: 'Purchases', kind: 'expense', key: 'purchases' },
  { code: '5100', name: 'General expenses', kind: 'expense', key: 'expenses' },
  { code: '5110', name: 'Legal and professional fees', kind: 'expense', key: 'legal_expenses' },
  { code: '5200', name: 'Composition tax expense', kind: 'expense', key: 'composition_expense' },
  { code: '5300', name: 'Salaries and wages', kind: 'expense', key: 'salaries' },
  { code: '5400', name: 'Rent', kind: 'expense', key: 'rent' },
]

const toAccount = (r: Record<string, unknown>): Account => ({
  id: String(r.id), code: String(r.code), name: String(r.name), kind: r.kind as AccountKind, systemKey: r.system_key ? String(r.system_key) : null, active: r.active === true,
})

/** adds the default accounts that are missing (by system key); never changes an existing account. Returns how many were added */
export async function seedChart(db: SqlDb): Promise<number> {
  let added = 0
  for (const a of DEFAULT_ACCOUNTS) {
    const r = await db.exec(
      `INSERT INTO ${T('ab_led_accounts')} (id, code, name, kind, system_key, active, created_on)
       SELECT $1, $2, $3, $4, $5, true, now()
        WHERE NOT EXISTS (SELECT 1 FROM ${T('ab_led_accounts')} WHERE system_key = $5 OR lower(code) = lower($2))`,
      [uid('acc'), a.code, a.name, a.kind, a.key],
    )
    added += r.affectedRows
  }
  return added
}

export async function listAccounts(db: SqlDb): Promise<Account[]> {
  return (await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_led_accounts')} ORDER BY lower(code) COLLATE "C", id`)).map(toAccount)
}
/** system key -> account id; a posting that needs a key the chart does not have is refused in plain words */
export async function accountsByKey(db: SqlDb): Promise<(key: string) => string> {
  const map = new Map((await listAccounts(db)).filter((a) => a.systemKey).map((a) => [a.systemKey!, a]))
  return (key) => {
    const a = map.get(key)
    if (!a) throw invalid(`The chart of accounts has no account for "${key}". Open Accounts > Settings and set up the books (it adds the missing default accounts).`)
    return a.id
  }
}

export async function createAccount(db: SqlDb, a: { code: string; name: string; kind: AccountKind }): Promise<Account> {
  if (!/^[A-Za-z0-9.-]{1,20}$/.test(a.code)) throw invalid('An account code is 1 to 20 letters, digits, dots or hyphens.', 'code')
  if ((await db.query(`SELECT 1 FROM ${T('ab_led_accounts')} WHERE lower(code) = lower($1)`, [a.code])).length) throw conflict(`There is already an account with the code ${a.code}.`, 'code')
  const id = uid('acc')
  await db.exec(`INSERT INTO ${T('ab_led_accounts')} (id, code, name, kind, active, created_on) VALUES ($1, $2, $3, $4, true, now())`, [id, a.code, a.name, a.kind])
  return { id, ...a, systemKey: null, active: true }
}
/** only the name, the code and "active" change: the kind of an account with postings would move it between reports */
export async function updateAccount(db: SqlDb, id: string, ch: { name?: string; code?: string; active?: boolean }): Promise<Account> {
  const cur = (await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_led_accounts')} WHERE id = $1`, [id]))[0]
  if (!cur) throw notFound('Account')
  const code = ch.code ?? String(cur.code)
  if (!/^[A-Za-z0-9.-]{1,20}$/.test(code)) throw invalid('An account code is 1 to 20 letters, digits, dots or hyphens.', 'code')
  if ((await db.query(`SELECT 1 FROM ${T('ab_led_accounts')} WHERE lower(code) = lower($1) AND id <> $2`, [code, id])).length) throw conflict(`There is already an account with the code ${code}.`, 'code')
  if (ch.active === false && cur.system_key) throw invalid('This account is used by the automatic postings and cannot be switched off.', 'active')
  await db.exec(`UPDATE ${T('ab_led_accounts')} SET name = $2, code = $3, active = $4 WHERE id = $1`, [id, ch.name ?? cur.name, code, ch.active ?? cur.active])
  return toAccount((await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_led_accounts')} WHERE id = $1`, [id]))[0])
}

/* ------------------------------------------------------------------ financial years and periods */

export interface Period { id: string; yearId: string; start: string; end: string; state: 'open' | 'soft_locked' | 'locked'; changedBy: string | null; changedOn: string | null; reason: string | null }
export interface Year { id: string; name: string; start: string; end: string; periods: Period[] }

const toPeriod = (r: Record<string, unknown>): Period => ({
  id: String(r.id), yearId: String(r.year_id), start: String(r.start_date), end: String(r.end_date), state: r.state as Period['state'],
  changedBy: r.changed_by ? String(r.changed_by) : null, changedOn: r.changed_on ? new Date(r.changed_on as string).toISOString() : null, reason: r.reason ? String(r.reason) : null,
})

export async function listYears(db: SqlDb): Promise<Year[]> {
  const years = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_led_years')} ORDER BY start_date`)
  const periods = (await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_led_periods')} ORDER BY start_date`)).map(toPeriod)
  return years.map((y) => ({ id: String(y.id), name: String(y.name), start: String(y.start_date), end: String(y.end_date), periods: periods.filter((p) => p.yearId === String(y.id)) }))
}

/** the financial year that contains `date`, with its 12 monthly periods (G9.9, G9.10); refuses a second one for the same year */
export async function createYear(db: SqlDb, date: string, startMonth: number): Promise<Year> {
  const fy = financialYearOf(date, startMonth)
  return db.tx(async (tx) => {
    if ((await tx.query(`SELECT 1 FROM ${T('ab_led_years')} WHERE start_date <= $2::date AND end_date >= $1::date`, [fy.start, fy.end])).length) throw conflict(`The financial year ${fy.name} (or one that overlaps it) exists already.`)
    const id = uid('fy')
    await tx.exec(`INSERT INTO ${T('ab_led_years')} (id, name, start_date, end_date, created_on) VALUES ($1, $2, $3, $4, now())`, [id, fy.name, fy.start, fy.end])
    for (const m of monthsOf(fy)) await tx.exec(`INSERT INTO ${T('ab_led_periods')} (id, year_id, start_date, end_date, state) VALUES ($1, $2, $3, $4, 'open')`, [uid('per'), id, m.start, m.end])
    return (await listYears(tx)).find((y) => y.id === id)!
  })
}

const monthName = (start: string): string => new Date(`${start}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/**
 * The period a posting dated `date` falls in, checked against the caller's level, and LOCKED FOR SHARE until the
 * caller's transaction ends (a period lock waits for running postings and they see it afterwards). Call inside a
 * transaction. G9.10.
 */
export async function assertPostable(db: SqlDb, date: string, level: Level, what = 'post'): Promise<Period> {
  const r = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_led_periods')} WHERE start_date <= $1::date AND end_date >= $1::date FOR SHARE`, [date])
  if (!r.length) throw invalid(`There is no financial year for ${date}. An Accounts administrator can add it in Accounts > Periods.`, 'date')
  const p = toPeriod(r[0])
  if (p.state === 'locked') throw conflict(`The period ${monthName(p.start)} is locked: nobody can ${what} in it. Use a date in an open period.`, 'date')
  if (p.state === 'soft_locked' && level !== 'admin') throw new HttpError(403, 'denied', `The period ${monthName(p.start)} is soft-locked: only an Accounts administrator can ${what} in it.`, 'date')
  return p
}

/** G9.10: open -> soft_locked -> locked by an Accounts admin; back only through unlockPeriod */
export async function setPeriodState(db: SqlDb, id: string, state: Period['state'], by: string, reason: string | null): Promise<{ before: Period; after: Period }> {
  return db.tx(async (tx) => {
    // FOR UPDATE: waits for postings that hold the period FOR SHARE
    const r = await tx.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_led_periods')} WHERE id = $1 FOR UPDATE`, [id])
    if (!r.length) throw notFound('Period')
    const before = toPeriod(r[0])
    await tx.exec(`UPDATE ${T('ab_led_periods')} SET state = $2, changed_by = $3, changed_on = now(), reason = $4 WHERE id = $1`, [id, state, by, reason])
    return { before, after: toPeriod((await tx.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_led_periods')} WHERE id = $1`, [id]))[0]) }
  })
}

/* ------------------------------------------------------------------ journals */

export interface JournalLineInput { accountId: string; partyId?: string | null; debit?: Paise; credit?: Paise; memo?: string }
export interface JournalInput {
  date: string
  narration: string
  lines: JournalLineInput[]
  sourceKind?: string
  sourceId?: string | null
  reverses?: string | null
}
export interface JournalLine { lineNo: number; accountId: string; accountCode: string; accountName: string; partyId: string | null; debit: Paise; credit: Paise; memo: string }
export interface Journal {
  id: string; number: number; date: string; narration: string; sourceKind: string; sourceId: string | null; reverses: string | null; reversedBy: string | null
  total: Paise; postedBy: string | null; postedOn: string; lines: JournalLine[]
}

export const MAX_JOURNAL_LINES = 500

/** see the header. Runs in its own transaction (a savepoint when the caller already has one). */
export async function postJournal(db: SqlDb, inp: JournalInput, who: { userId: string | null; level: Level }): Promise<Journal> {
  const lines = inp.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0)
  if (lines.length < 2) throw invalid('A journal needs at least two lines with an amount.', 'lines')
  if (lines.length > MAX_JOURNAL_LINES) throw invalid(`A journal has at most ${MAX_JOURNAL_LINES} lines.`, 'lines')
  let debit = 0
  let credit = 0
  for (const [i, l] of lines.entries()) {
    const d = l.debit ?? 0
    const c = l.credit ?? 0
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0) throw invalid(`Line ${i + 1}: amounts are whole paise and not negative.`, 'lines')
    if (d !== 0 && c !== 0) throw invalid(`Line ${i + 1}: a line is a debit or a credit, not both.`, 'lines')
    debit += d
    credit += c
  }
  if (debit !== credit) throw invalid(`The journal does not balance: debits ${rupees(debit)}, credits ${rupees(credit)}.`, 'lines')
  return db.tx(async (tx) => {
    await assertPostable(tx, inp.date, who.level)
    const ids = [...new Set(lines.map((l) => l.accountId))]
    const accounts = await tx.query<{ id: string; active: boolean; name: string }>(`SELECT id, active, name FROM ${T('ab_led_accounts')} WHERE id = ANY($1::text[])`, [ids])
    for (const id of ids) {
      const a = accounts.find((x) => x.id === id)
      if (!a) throw invalid('A line names an account that does not exist.', 'lines')
      if (!a.active) throw invalid(`The account ${a.name} is switched off.`, 'lines')
    }
    if (inp.reverses) await tx.query(`SELECT 1 FROM ${T('ab_led_journals')} WHERE id = $1 FOR UPDATE`, [inp.reverses])
    const id = rowUid()
    const n = await tx.query<{ v: number }>(`INSERT INTO ${T('ab_counters')} (k, v) VALUES ('ledger.journal', 1) ON CONFLICT (k) DO UPDATE SET v = ${T('ab_counters')}.v + 1 RETURNING v`)
    await tx.exec(
      `INSERT INTO ${T('ab_led_journals')} (id, number, date, narration, source_kind, source_id, reverses, total, posted_by, posted_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [id, Number(n[0].v), inp.date, inp.narration.slice(0, 500), inp.sourceKind ?? 'manual', inp.sourceId ?? null, inp.reverses ?? null, debit, who.userId],
    )
    for (const [i, l] of lines.entries()) {
      await tx.exec(
        `INSERT INTO ${T('ab_led_lines')} (journal_id, line_no, date, account_id, party_id, debit, credit, memo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, i + 1, inp.date, l.accountId, l.partyId ?? null, l.debit ?? 0, l.credit ?? 0, (l.memo ?? '').slice(0, 300)],
      )
    }
    // the stored rows, not the input, are what must balance
    const s = await tx.query<{ d: number; c: number; n: number }>(`SELECT COALESCE(sum(debit), 0)::bigint AS d, COALESCE(sum(credit), 0)::bigint AS c, count(*)::int AS n FROM ${T('ab_led_lines')} WHERE journal_id = $1`, [id])
    if (Number(s[0].d) !== Number(s[0].c) || Number(s[0].d) !== debit || Number(s[0].n) !== lines.length) throw new Error(`journal ${id} does not balance after it was written (debits ${s[0].d}, credits ${s[0].c}); nothing was posted`)
    return (await getJournal(tx, id))!
  })
}

export async function getJournal(db: SqlDb, id: string): Promise<Journal | null> {
  const r = await db.query<Record<string, unknown>>(
    `SELECT j.*, (SELECT r.id FROM ${T('ab_led_journals')} r WHERE r.reverses = j.id) AS reversed_by FROM ${T('ab_led_journals')} j WHERE j.id = $1`, [id])
  if (!r.length) return null
  const lines = await db.query<Record<string, unknown>>(
    `SELECT l.*, a.code, a.name FROM ${T('ab_led_lines')} l JOIN ${T('ab_led_accounts')} a ON a.id = l.account_id WHERE l.journal_id = $1 ORDER BY l.line_no`, [id])
  return { ...toJournal(r[0]), lines: lines.map((l) => ({ lineNo: Number(l.line_no), accountId: String(l.account_id), accountCode: String(l.code), accountName: String(l.name), partyId: l.party_id ? String(l.party_id) : null, debit: Number(l.debit), credit: Number(l.credit), memo: String(l.memo) })) }
}
const toJournal = (j: Record<string, unknown>): Journal => ({
  id: String(j.id), number: Number(j.number), date: String(j.date), narration: String(j.narration), sourceKind: String(j.source_kind), sourceId: j.source_id ? String(j.source_id) : null,
  reverses: j.reverses ? String(j.reverses) : null, reversedBy: j.reversed_by ? String(j.reversed_by) : null, total: Number(j.total), postedBy: j.posted_by ? String(j.posted_by) : null,
  postedOn: new Date(j.posted_on as string).toISOString(), lines: [],
})

export async function listJournals(db: SqlDb, f: { from?: string | null; to?: string | null; limit: number; offset: number }): Promise<{ items: Journal[]; total: number }> {
  const where = `($1::date IS NULL OR j.date >= $1::date) AND ($2::date IS NULL OR j.date <= $2::date)`
  const rows = await db.query<Record<string, unknown>>(
    `SELECT j.*, (SELECT r.id FROM ${T('ab_led_journals')} r WHERE r.reverses = j.id) AS reversed_by FROM ${T('ab_led_journals')} j WHERE ${where} ORDER BY j.number DESC LIMIT $3 OFFSET $4`,
    [f.from ?? null, f.to ?? null, f.limit, f.offset])
  const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T('ab_led_journals')} j WHERE ${where}`, [f.from ?? null, f.to ?? null])
  return { items: rows.map(toJournal), total: Number(total[0].n) }
}

/**
 * The correction of a posted journal: a new journal with every debit and credit swapped. `force` is for the document
 * service (a cancellation); a journal that came from a document is otherwise corrected through the document.
 */
export async function reverseJournal(db: SqlDb, id: string, o: { date: string; reason: string; force?: boolean; sourceKind?: string; sourceId?: string | null }, who: { userId: string | null; level: Level }): Promise<Journal> {
  return db.tx(async (tx) => {
    const j = await getJournal(tx, id)
    if (!j) throw notFound('Journal')
    if (j.reverses) throw invalid('This journal is itself a reversal. Post a new journal instead of reversing it.')
    if (j.reversedBy) throw conflict('This journal has been reversed already.')
    if (j.sourceKind !== 'manual' && !o.force) throw invalid('This journal was posted by a document. Cancel the document or issue a credit or debit note instead.')
    try {
      return await postJournal(tx, {
        date: o.date, narration: `Reversal of journal ${j.number}: ${o.reason}`.slice(0, 500), reverses: j.id, sourceKind: o.sourceKind ?? j.sourceKind, sourceId: o.sourceId ?? j.sourceId,
        lines: j.lines.map((l) => ({ accountId: l.accountId, partyId: l.partyId, debit: l.credit, credit: l.debit, memo: l.memo })),
      }, who)
    } catch (e) {
      // two reversals at once: the unique index on `reverses` refuses the second
      if ((e as { code?: string }).code === '23505') throw conflict('This journal has been reversed already.')
      throw e
    }
  })
}

/* ------------------------------------------------------------------ reports */

export interface BalanceRow { accountId: string; code: string; name: string; kind: AccountKind; opening: Paise; debit: Paise; credit: Paise; closing: Paise }
/** signed balances are debit-positive: closing = opening + debit - credit */
export async function trialBalance(db: SqlDb, from: string | null, to: string): Promise<{ from: string | null; to: string; rows: BalanceRow[]; totals: { debit: Paise; credit: Paise; closingDebit: Paise; closingCredit: Paise } }> {
  const r = await db.query<Record<string, unknown>>(
    `SELECT a.id, a.code, a.name, a.kind,
            COALESCE(sum(l.debit - l.credit) FILTER (WHERE $1::date IS NOT NULL AND l.date < $1::date), 0)::bigint AS opening,
            COALESCE(sum(l.debit) FILTER (WHERE ($1::date IS NULL OR l.date >= $1::date) AND l.date <= $2::date), 0)::bigint AS debit,
            COALESCE(sum(l.credit) FILTER (WHERE ($1::date IS NULL OR l.date >= $1::date) AND l.date <= $2::date), 0)::bigint AS credit
       FROM ${T('ab_led_accounts')} a LEFT JOIN ${T('ab_led_lines')} l ON l.account_id = a.id AND l.date <= $2::date
      GROUP BY a.id, a.code, a.name, a.kind ORDER BY lower(a.code) COLLATE "C", a.id`, [from, to])
  const rows = r.map((x) => {
    const opening = Number(x.opening), debit = Number(x.debit), credit = Number(x.credit)
    return { accountId: String(x.id), code: String(x.code), name: String(x.name), kind: x.kind as AccountKind, opening, debit, credit, closing: opening + debit - credit }
  }).filter((x) => x.opening !== 0 || x.debit !== 0 || x.credit !== 0)
  const totals = { debit: 0, credit: 0, closingDebit: 0, closingCredit: 0 }
  for (const x of rows) {
    totals.debit += x.debit
    totals.credit += x.credit
    if (x.closing >= 0) totals.closingDebit += x.closing
    else totals.closingCredit -= x.closing
  }
  return { from, to, rows, totals }
}

export interface LedgerEntry { journalId: string; number: number; date: string; narration: string; memo: string; partyId: string | null; debit: Paise; credit: Paise; balance: Paise }
export async function accountLedger(db: SqlDb, accountId: string, from: string | null, to: string, partyId?: string | null): Promise<{ account: Account; opening: Paise; entries: LedgerEntry[]; closing: Paise; truncated: boolean }> {
  const a = (await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_led_accounts')} WHERE id = $1`, [accountId]))[0]
  if (!a) throw notFound('Account')
  const party = partyId || null
  const open = from
    ? Number((await db.query<{ v: number }>(`SELECT COALESCE(sum(debit - credit), 0)::bigint AS v FROM ${T('ab_led_lines')} WHERE account_id = $1 AND date < $2::date AND ($3::text IS NULL OR party_id = $3)`, [accountId, from, party]))[0].v)
    : 0
  const LIMIT = 5000
  const rows = await db.query<Record<string, unknown>>(
    `SELECT l.journal_id, j.number, l.date, j.narration, l.memo, l.party_id, l.debit, l.credit
       FROM ${T('ab_led_lines')} l JOIN ${T('ab_led_journals')} j ON j.id = l.journal_id
      WHERE l.account_id = $1 AND ($2::date IS NULL OR l.date >= $2::date) AND l.date <= $3::date AND ($4::text IS NULL OR l.party_id = $4)
      ORDER BY l.date, j.number, l.line_no LIMIT ${LIMIT + 1}`, [accountId, from, to, party])
  let balance = open
  const entries = rows.slice(0, LIMIT).map((x) => {
    balance += Number(x.debit) - Number(x.credit)
    return { journalId: String(x.journal_id), number: Number(x.number), date: String(x.date), narration: String(x.narration), memo: String(x.memo), partyId: x.party_id ? String(x.party_id) : null, debit: Number(x.debit), credit: Number(x.credit), balance }
  })
  return { account: toAccount(a), opening: open, entries, closing: balance, truncated: rows.length > LIMIT }
}

export interface StatementRow { accountId: string; code: string; name: string; amount: Paise }
/** income and expense between two dates; amounts are positive in the natural direction of their section */
export async function profitAndLoss(db: SqlDb, from: string, to: string): Promise<{ from: string; to: string; income: StatementRow[]; expense: StatementRow[]; totalIncome: Paise; totalExpense: Paise; profit: Paise }> {
  const tb = await trialBalance(db, from, to)
  const pick = (kind: AccountKind, sign: 1 | -1): StatementRow[] => tb.rows.filter((r) => r.kind === kind && r.debit !== r.credit).map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, amount: sign * (r.debit - r.credit) }))
  const income = pick('income', -1)
  const expense = pick('expense', 1)
  const totalIncome = income.reduce((s, r) => s + r.amount, 0)
  const totalExpense = expense.reduce((s, r) => s + r.amount, 0)
  return { from, to, income, expense, totalIncome, totalExpense, profit: totalIncome - totalExpense }
}

/**
 * Assets, liabilities and equity on a date. There are no closing entries in this version: income less expense of ALL
 * time up to the date is shown as one line under equity ("Profit to date, not closed"), so the sheet balances.
 */
export async function balanceSheet(db: SqlDb, asOf: string): Promise<{ asOf: string; assets: StatementRow[]; liabilities: StatementRow[]; equity: StatementRow[]; totalAssets: Paise; totalLiabilities: Paise; totalEquity: Paise; profitToDate: Paise; balanced: boolean }> {
  const tb = await trialBalance(db, null, asOf)
  const pick = (kind: AccountKind, sign: 1 | -1): StatementRow[] => tb.rows.filter((r) => r.kind === kind && r.closing !== 0).map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, amount: sign * r.closing }))
  const assets = pick('asset', 1)
  const liabilities = pick('liability', -1)
  const equity = pick('equity', -1)
  const profitToDate = -tb.rows.filter((r) => r.kind === 'income' || r.kind === 'expense').reduce((s, r) => s + r.closing, 0)
  const total = (xs: StatementRow[]) => xs.reduce((s, r) => s + r.amount, 0)
  const totalAssets = total(assets), totalLiabilities = total(liabilities), totalEquity = total(equity) + profitToDate
  return { asOf, assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, profitToDate, balanced: totalAssets === totalLiabilities + totalEquity }
}
