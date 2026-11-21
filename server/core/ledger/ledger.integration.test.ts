/**
 * Ledgers and India GST (P3 package L) against the sandbox PostgreSQL (APPBUILDER_TEST_DB), over HTTP as real users.
 * The figures are the worked examples of docs/plan/gst-spec-draft.md (W1, W2, W3, W8, W11, W13, W14, W16, W29, W30) and
 * the journals are those of its section 9 (G9.1 to G9.7). The draft is not reviewed by an accountant: these tests pin
 * the software to the draft. State codes and rates are test data entered through the API, as an administrator would.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness } from '../kernel-testkit.ts'
import type { KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { hashPassword } from '../password.ts'
import type { UserRecord } from '../contracts.ts'
import { SCHEMA_VERSION } from '../meta-store.ts'
import { LEDGER_TABLES } from './ddl.ts'
import { DEFAULT_ACCOUNTS } from './service.ts'
import { DRAFT_NOTICE } from './core.ts'
import { getDocument } from '../gst/documents.ts'
import { COMPOSITION_HEADER, ENDORSEMENT_LUT, copyMarks, documentBlocks } from '../gst/pdf.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[ledger integration] ${SKIP_PG}\n`)

const PW = 'member-password-1'
/* eslint-disable @typescript-eslint/no-explicit-any */

describe.skipIf(!PG_URL)(PG_URL ? 'ledgers and GST (PostgreSQL)' : `ledgers and GST (PostgreSQL) ${SKIP_PG}`, () => {
  let h: KernelHarness
  const c: Record<string, Client> = {}
  const ids: Record<string, string> = {}
  const acc: Record<string, { id: string; code: string }> = {}
  const ok = (r: { status: number; data: any }) => {
    expect(r.status, JSON.stringify(r.data).slice(0, 500)).toBe(200)
    return r.data
  }
  const fails = (r: { status: number; data: any }, status: number, re?: RegExp) => {
    expect(r.status, JSON.stringify(r.data).slice(0, 500)).toBe(status)
    if (re) expect(String(r.data?.error?.message)).toMatch(re)
    return r.data
  }
  const put = (cl: Client, p: string, b: unknown) => cl.req('PUT', p, b)
  /** the lines of a journal as "key debit credit" (rupees), sorted, with the account's system key */
  const lines = async (journalId: string): Promise<string[]> => {
    const j = ok(await h.admin.get(`/accounts/journals/${journalId}`)).journal
    const keyOf = (id: string) => Object.entries(acc).find(([, a]) => a.id === id)?.[0] ?? id
    return j.lines.map((l: any) => `${keyOf(l.accountId)} ${(l.debit / 100).toFixed(2)} ${(l.credit / 100).toFixed(2)}`).sort()
  }
  const draft = async (body: Record<string, unknown>, cl: Client = h.admin) => ok(await cl.post('/accounts/documents', body)).document
  const issue = async (id: string, cl: Client = h.admin) => ok(await cl.post(`/accounts/documents/${id}/issue`, {})).document
  const invoice = (partyId: string | null, date: string, ls: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ docType: 'tax_invoice', date, partyId, lines: ls, ...extra })
  const tb = async () => ok(await h.admin.get('/accounts/reports/trial-balance?to=2027-03-31'))
  const closing = async (key: string): Promise<number> => (await tb()).rows.find((r: any) => r.accountId === acc[key].id)?.closing ?? 0
  const SRC = 'test data, not a real notification'

  beforeAll(async () => {
    h = await startHarness('ledger')
    // people: Bo may post, Cy may only read, Di has no Accounts access
    const poster = ok(await h.admin.post('/roles', { name: 'Accounts clerk', apps: [], privileges: [] }))
    const reader = ok(await h.admin.post('/roles', { name: 'Accounts reader', apps: [], privileges: [] }))
    ids.poster = poster.id
    ids.reader = reader.id
    await runInEnvironment('default', async () => {
      for (const [k, name, roles] of [['bo', 'Bo Brown', [poster.id]], ['cy', 'Cy Clark', [reader.id]], ['di', 'Di Diaz', []]] as const) {
        ids[k] = `user_${k}`
        await h.app.services.meta.users.insert({ id: ids[k], name, email: `${k}@example.com`, roleIds: [...roles], status: 'active', passwordHash: await hashPassword(PW) } as UserRecord)
      }
    })
    for (const k of ['bo', 'cy', 'di']) await h.q(`INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ('default', $1, false, now()) ON CONFLICT DO NOTHING`, [ids[k]])
    h.app.services.security.invalidate('all')
    for (const k of ['bo', 'cy', 'di']) {
      c[k] = new Client(h.base)
      ok(await c[k].post('/auth/login', { email: `${k}@example.com`, password: PW }))
    }
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('schema version 15: the tables exist, and a version 14 environment is upgraded by the step', async () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15)
    for (const t of LEDGER_TABLES) expect((await h.q<any>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`env_default.${t}`]))[0].ok, t).toBe(true)
    await h.q(`UPDATE ab.environments SET schema_version = 14 WHERE id = 'default'`)
    const m = (await h.app.services.meta.migrate()) as any
    expect(m.environments.find((e: any) => e.id === 'default')).toMatchObject({ from: 14, to: SCHEMA_VERSION, ok: true })
    expect((await h.q<any>(`SELECT schema_version FROM ab.environments WHERE id = 'default'`))[0].schema_version).toBe(SCHEMA_VERSION)
  }, 30_000)

  it('nothing ships as data: reference tables and the chart are empty until an administrator fills them', async () => {
    const st = ok(await h.admin.get('/accounts/state'))
    expect(st).toMatchObject({ level: 'admin', notice: DRAFT_NOTICE, business: null })
    expect(st.setup).toMatchObject({ business: false, chart: false, years: 0, states: 0, rates: 0, thresholds: 0 })
    expect(st.notice).toMatch(/draft that has not yet been reviewed by a practising accountant/)
    // without the dated value the software does not guess the financial year
    fails(await h.admin.post('/accounts/years', { date: '2026-06-15' }), 422, /financial_year_start_month.*not set/)
  })

  it('setup: example data is marked not approved and carries no rates; the default chart has the GST accounts of draft 9.1', async () => {
    const ex = ok(await h.admin.post('/accounts/reference/examples', {})).added
    expect(ex.states).toBeGreaterThan(30)
    expect(ok(await h.admin.post('/accounts/reference/examples', {})).added).toEqual({ states: 0, values: 0 })
    const states = ok(await h.admin.get('/accounts/reference/states')).items
    expect(states.every((s: any) => /NOT APPROVED/.test(s.source) && s.approvedBy === '')).toBe(true)
    expect(states.find((s: any) => s.code === '04')).toMatchObject({ name: 'Chandigarh', usesUtgst: true })
    expect(ok(await h.admin.get('/accounts/reference/rates')).items).toEqual([])
    const added = ok(await h.admin.post('/accounts/setup', {})).added
    expect(added.accounts).toBe(DEFAULT_ACCOUNTS.length)
    expect(ok(await h.admin.post('/accounts/setup', {})).added).toEqual({ accounts: 0, series: 0 })
    const chart = ok(await h.admin.get('/accounts/chart')).items
    for (const a of chart) if (a.systemKey) acc[a.systemKey] = { id: a.id, code: a.code }
    for (const k of ['output_cgst', 'output_sgst', 'output_utgst', 'output_igst', 'output_cess', 'input_cgst', 'input_sgst', 'input_utgst', 'input_igst', 'input_cess', 'rcm_cgst', 'rcm_sgst', 'rcm_utgst', 'rcm_igst',
      'input_cgst_rcm', 'input_sgst_rcm', 'input_utgst_rcm', 'input_igst_rcm', 'advance_gst_suspense', 'customer_advances', 'composition_cgst', 'composition_sgst', 'composition_expense', 'round_off',
      'sales_taxable', 'sales_exempt', 'sales_nil', 'sales_zero_rated', 'sales_non_gst', 'receivables', 'payables']) expect(acc[k], k).toBeTruthy()
    // an administrator may add and rename accounts; a system account cannot be switched off
    const extra = ok(await h.admin.post('/accounts/chart', { code: '5500', name: 'Freight outward', kind: 'expense' })).item
    fails(await h.admin.post('/accounts/chart', { code: '5500', name: 'Again', kind: 'expense' }), 409)
    expect(ok(await h.admin.patch(`/accounts/chart/${extra.id}`, { name: 'Freight and cartage' })).item.name).toBe('Freight and cartage')
    fails(await h.admin.patch(`/accounts/chart/${acc.output_cgst.id}`, { active: false }), 422, /automatic postings/)
  })

  it('business registration, financial year with 12 periods, rates with their rules (G4.2), parties and items', async () => {
    fails(await put(h.admin, '/accounts/business', { legalName: 'Asha Pumps Private Limited', address: 'Indore', stateCode: '23', regType: 'regular', gstin: '27ABCDE1234F1Z5' }), 422, /starts with 27/)
    const b = ok(await put(h.admin, '/accounts/business', { legalName: 'Asha Pumps Private Limited', address: '12 Industrial Area, Indore 452001', stateCode: '23', regType: 'regular', gstin: '23ABCDE1234F1Z5', luts: [{ fy: '2026-27', reference: 'AD230426000123X', filedOn: '2026-04-02' }], footer: 'Bank: Example Bank, Indore' })).business
    expect(b.settings).toEqual({ taxMode: 'line', roundOff: true, manualPlaceOfSupply: false })
    const y = ok(await h.admin.post('/accounts/years', { date: '2026-06-15' })).item
    expect(y).toMatchObject({ name: '2026-27', start: '2026-04-01', end: '2027-03-31' })
    expect(y.periods).toHaveLength(12)
    expect(y.periods.every((p: any) => p.state === 'open')).toBe(true)
    for (const p of y.periods) ids[`period_${p.start.slice(0, 7)}`] = p.id
    fails(await h.admin.post('/accounts/years', { date: '2027-01-01' }), 409, /exists already/)
    // rates
    const rate = (code: string, kind: string, igst: string, half: string, extra: Record<string, unknown> = {}) => ({ code, kind, igst, cgst: half, sgst: half, effectiveFrom: '2025-09-22', source: SRC, ...extra })
    fails(await h.admin.post('/accounts/reference/rates', { ...rate('8413', 'goods', '18', '9'), sgst: '8' }), 422, /must equal the IGST rate/)
    fails(await h.admin.post('/accounts/reference/rates', { ...rate('8413', 'goods', '18', '9'), source: '' }), 422, /source/)
    ids.rate8413 = ok(await h.admin.post('/accounts/reference/rates', rate('8413', 'goods', '18', '9'))).item.id
    fails(await h.admin.post('/accounts/reference/rates', rate('8413', 'goods', '5', '2.5', { effectiveFrom: '2026-01-01' })), 409, /covers part of these dates/)
    ok(await h.admin.post('/accounts/reference/rates', rate('1006', 'goods', '5', '2.5')))
    ok(await h.admin.post('/accounts/reference/rates', rate('9983', 'service', '18', '9')))
    ok(await h.admin.post('/accounts/reference/rates', rate('9982', 'service', '18', '9')))
    expect(ok(await h.admin.patch(`/accounts/reference/rates/${ids.rate8413}`, { description: 'Pumps', approvedBy: 'Test accountant', approvedOn: '2026-04-01' })).item).toMatchObject({ description: 'Pumps', igst: '18', cgst: '9', approvedBy: 'Test accountant' })
    // parties
    const party = async (b: Record<string, unknown>) => ok(await h.admin.post('/accounts/parties', b)).item.id
    fails(await h.admin.post('/accounts/parties', { name: 'X', regType: 'regular', stateCode: '27', gstin: '23AAAAA0000A1Z5' }), 422, /starts with 23/)
    fails(await h.admin.post('/accounts/parties', { name: 'X', regType: 'unregistered', stateCode: '99' }), 422, /no State with code 99/)
    ids.mp = await party({ name: 'Bhopal Traders', regType: 'regular', stateCode: '23', gstin: '23AAAAA0000A1Z5', address: 'MP Nagar, Bhopal' })
    ids.mh = await party({ name: 'Pune Engineering', regType: 'regular', stateCode: '27', gstin: '27BBBBB1111B1Z5', address: 'Hadapsar, Pune' })
    ids.walkin = await party({ name: 'Cash customer, Jaipur', regType: 'unregistered', stateCode: '08', address: 'Jaipur' })
    ids.abroad = await party({ name: 'Rhein Pumpen GmbH', regType: 'overseas', country: 'DE', address: 'Köln' })
    ids.supplier = await party({ name: 'Indore Castings', role: 'supplier', regType: 'regular', stateCode: '23', gstin: '23CCCCC2222C1Z5', address: 'Sanwer Road, Indore' })
    ids.advocate = await party({ name: 'R. Verma, Advocate', role: 'supplier', regType: 'unregistered', stateCode: '23', address: 'Indore' })
    // items
    const item = async (b: Record<string, unknown>) => ok(await h.admin.post('/accounts/items', b)).item.id
    ids.pump = await item({ name: 'Monoblock pump 1 HP', kind: 'goods', hsn: '84137010', uqc: 'NOS', unitPrice: '1250.00' })
    ids.rice = await item({ name: 'Rice 25 kg', kind: 'goods', hsn: '10063010', uqc: 'BAG' })
    ids.book = await item({ name: 'Printed manual', kind: 'goods', hsn: '49011010', uqc: 'NOS', supplyClass: 'exempt' })
    ids.consult = await item({ name: 'Consulting', kind: 'service', hsn: '998311', uqc: 'OTH' })
    ids.survey = await item({ name: 'Site survey of a building', kind: 'service', hsn: '998399', posCategory: 'immovable property' })
    ids.legal = await item({ name: 'Legal services', kind: 'service', hsn: '998212', rcmCategory: 'legal', itcDefault: 'eligible', expenseAccount: acc.legal_expenses.id })
    ids.food = await item({ name: 'Food for staff', kind: 'goods', hsn: '10063090', itcDefault: 'ineligible', expenseAccount: acc.expenses.id })
    fails(await h.admin.post('/accounts/items', { name: 'Bad', kind: 'goods', hsn: '84A' }), 422, /2 to 8 digits/)
  })

  it('access: no role, a reader, a clerk; the Accountant role', async () => {
    expect(ok(await c.di.get('/accounts/state')).level).toBe('none')
    fails(await c.di.get('/accounts/chart'), 403, /not available for your role/)
    fails(await c.bo.get('/accounts/chart'), 403)
    ok(await put(h.admin, '/accounts/access', { access: { [ids.poster]: 'post', [ids.reader]: 'view' } }))
    expect(ok(await c.bo.get('/accounts/state')).level).toBe('post')
    expect(ok(await c.cy.get('/accounts/chart')).items.length).toBeGreaterThan(40)
    fails(await c.cy.post('/accounts/journals', { date: '2026-06-01', narration: 'x', lines: [] }), 403, /read Accounts but not change/)
    fails(await c.bo.post('/accounts/reference/rates', {}), 403, /Accounts administrator/)
    fails(await put(c.bo, '/accounts/business', {}), 403)
    fails(await c.di.get('/accounts/documents'), 403)
    const r = ok(await h.admin.post('/accounts/access/accountant-role', {}))
    expect(r.role.name).toBe('Accountant')
    expect(ok(await h.admin.get('/accounts/access')).roles.find((x: any) => x.id === r.role.id).level).toBe('admin')
    fails(await put(h.admin, '/accounts/access', { access: { nope: 'view' } }), 422)
  })

  it('journals: balanced double entry is enforced in the transaction; posted journals change only by reversal', async () => {
    const j = (ls: unknown[], extra: Record<string, unknown> = {}) => ({ date: '2026-04-10', narration: 'Capital introduced', lines: ls, ...extra })
    fails(await c.bo.post('/accounts/journals', j([{ accountId: acc.bank.id, debit: '500000.00' }, { accountId: acc.capital.id, credit: '499999.99' }])), 422, /does not balance: debits 500000.00, credits 499999.99/)
    fails(await c.bo.post('/accounts/journals', j([{ accountId: acc.bank.id, debit: '10', credit: '10' }, { accountId: acc.capital.id, credit: '10' }])), 422, /a debit or a credit, not both/)
    fails(await c.bo.post('/accounts/journals', j([{ accountId: acc.bank.id, debit: '10' }])), 422, /at least two lines/)
    fails(await c.bo.post('/accounts/journals', j([{ accountId: acc.bank.id, debit: '10.001' }, { accountId: acc.capital.id, credit: '10' }])), 422, /more than 2 decimals/)
    fails(await c.bo.post('/accounts/journals', j([{ accountId: 'acc_nope', debit: '10' }, { accountId: acc.capital.id, credit: '10' }])), 422, /does not exist/)
    fails(await c.bo.post('/accounts/journals', j([{ accountId: acc.bank.id, debit: '10' }, { accountId: acc.capital.id, credit: '10' }], { date: '2025-03-31' })), 422, /no financial year for 2025-03-31/)
    expect((await h.q<any>(`SELECT count(*)::int AS n FROM env_default.ab_led_journals`))[0].n).toBe(0)
    const posted = ok(await c.bo.post('/accounts/journals', j([{ accountId: acc.bank.id, debit: '500000.00' }, { accountId: acc.capital.id, credit: '500000.00' }]))).journal
    expect(posted).toMatchObject({ number: 1, total: 50000000, sourceKind: 'manual' })
    ids.capital = posted.id
    // no route changes or deletes a posted journal
    expect((await h.admin.patch(`/accounts/journals/${posted.id}`, { narration: 'changed' })).status).toBeGreaterThanOrEqual(404)
    expect((await h.admin.del(`/accounts/journals/${posted.id}`)).status).toBeGreaterThanOrEqual(404)
    // a wrong journal is corrected by a reversal, once
    const wrong = ok(await c.bo.post('/accounts/journals', j([{ accountId: acc.rent.id, debit: '900.00' }, { accountId: acc.bank.id, credit: '900.00' }], { narration: 'Rent (wrong amount)' }))).journal
    const rev = ok(await c.bo.post(`/accounts/journals/${wrong.id}/reverse`, { date: '2026-04-11', reason: 'wrong amount' })).journal
    expect(rev.reverses).toBe(wrong.id)
    expect(rev.lines.map((l: any) => [l.accountId, l.debit, l.credit])).toEqual([[acc.rent.id, 0, 90000], [acc.bank.id, 90000, 0]])
    fails(await c.bo.post(`/accounts/journals/${wrong.id}/reverse`, { date: '2026-04-11', reason: 'again' }), 409, /reversed already/)
    fails(await c.bo.post(`/accounts/journals/${rev.id}/reverse`, { date: '2026-04-11', reason: 'undo' }), 422, /itself a reversal/)
    expect(ok(await h.admin.get(`/accounts/journals/${wrong.id}`)).journal.reversedBy).toBe(rev.id)
    expect(await closing('rent')).toBe(0)
    expect(await closing('bank')).toBe(50000000)
    // the database itself refuses a line that is both or neither
    await expect(h.q(`INSERT INTO env_default.ab_led_lines (journal_id, line_no, date, account_id, debit, credit) VALUES ('x', 1, '2026-04-10', 'a', 5, 5)`)).rejects.toThrow(/check constraint/)
    await expect(h.q(`INSERT INTO env_default.ab_led_lines (journal_id, line_no, date, account_id, debit, credit) VALUES ('x', 1, '2026-04-10', 'a', 0, 0)`)).rejects.toThrow(/check constraint/)
  })

  it('W1: an intra-State tax invoice is computed, numbered at issue and posted as G9.1; then it is immutable', async () => {
    const d = await draft(invoice(ids.mp, '2026-06-10', [{ itemId: ids.pump, quantity: '10', unitPrice: '1250.00' }]), c.bo)
    expect(d).toMatchObject({ state: 'draft', number: null, problem: null, taxKind: 'intra', placeOfSupply: '23' })
    expect(d.totals).toEqual({ taxable: 1250000, cgst: 112500, sgst: 112500, igst: 0, cess: 0, roundOff: 0, total: 1475000 })
    // a draft may change
    const changed = ok(await c.bo.patch(`/accounts/documents/${d.id}`, { lines: [{ itemId: ids.pump, quantity: '9', unitPrice: '1250.00' }] })).document
    expect(changed.totals.taxable).toBe(1125000)
    ok(await c.bo.patch(`/accounts/documents/${d.id}`, { lines: [{ itemId: ids.pump, quantity: '10', unitPrice: '1250.00' }] }))
    const inv = await issue(d.id, c.bo)
    ids.w1 = inv.id
    expect(inv).toMatchObject({ state: 'issued', number: 'INV/26-27/00001', fy: '2026-27', supplyType: 'B2B', taxKind: 'intra' })
    expect(inv.snapshot).toMatchObject({ rule: 'T1', placeOfSupplyName: 'Madhya Pradesh', utgst: false })
    expect(inv.lines[0]).toMatchObject({ hsn: '84137010', cgstRate: '9', sgstRate: '9', igstRate: '18', taxable: 1250000, cgst: 112500, sgst: 112500 })
    expect(await lines(inv.journalId)).toEqual(['output_cgst 0.00 1125.00', 'output_sgst 0.00 1125.00', 'receivables 14750.00 0.00', 'sales_taxable 0.00 12500.00'])
    const j = ok(await h.admin.get(`/accounts/journals/${inv.journalId}`)).journal
    expect(j).toMatchObject({ sourceKind: 'document', sourceId: inv.id, date: '2026-06-10' })
    expect(j.lines.find((l: any) => l.accountId === acc.receivables.id).partyId).toBe(ids.mp)
    // G7.8: no edit, no delete, no second issue, no manual reversal of its journal
    fails(await c.bo.patch(`/accounts/documents/${inv.id}`, { lines: [{ itemId: ids.pump, quantity: '1', unitPrice: '1.00' }] }), 409, /issued and cannot be changed.*credit note or a debit note/)
    fails(await c.bo.del(`/accounts/documents/${inv.id}`), 409)
    fails(await c.bo.post(`/accounts/documents/${inv.id}/issue`, {}), 409)
    fails(await c.bo.post(`/accounts/journals/${inv.journalId}/reverse`, { date: '2026-06-10', reason: 'x' }), 422, /posted by a document/)
    const audit = await h.q<any>(`SELECT details FROM env_default.ab_audit WHERE action = 'accounts.document.issue' AND row_id = $1`, [inv.id])
    expect(audit[0].details).toMatchObject({ number: 'INV/26-27/00001', total: '14750.00', rule: 'T1' })
  })

  it('W2 inter-State (G9.2a) and W3 two rates with a round-off (G9.2)', async () => {
    const w2 = await issue((await draft(invoice(ids.mh, '2026-06-11', [{ itemId: ids.pump, quantity: '10', unitPrice: '1250.00' }]))).id)
    ids.w2 = w2.id
    expect(w2).toMatchObject({ number: 'INV/26-27/00002', taxKind: 'inter', placeOfSupply: '27' })
    expect(w2.totals).toMatchObject({ taxable: 1250000, igst: 225000, cgst: 0, sgst: 0, total: 1475000 })
    expect(await lines(w2.journalId)).toEqual(['output_igst 0.00 2250.00', 'receivables 14750.00 0.00', 'sales_taxable 0.00 12500.00'])
    const w3 = await issue((await draft(invoice(ids.mp, '2026-06-12', [{ itemId: ids.pump, quantity: '4', unitPrice: '2345.50' }, { itemId: ids.rice, quantity: '3', unitPrice: '799.00' }]))).id)
    expect(w3.totals).toEqual({ taxable: 1177900, cgst: 90431, sgst: 90431, igst: 0, cess: 0, roundOff: 38, total: 1358800 })
    expect(await lines(w3.journalId)).toEqual(['output_cgst 0.00 904.31', 'output_sgst 0.00 904.31', 'receivables 13588.00 0.00', 'round_off 0.00 0.38', 'sales_taxable 0.00 11779.00'])
  })

  it('STOP cases issue nothing and take no number (G3.9, G4.3, G3.11, W12)', async () => {
    const stopped = async (body: Record<string, unknown>, rule: string, re: RegExp) => {
      const d = await draft(body)
      expect(d.problem).toMatch(re)
      const r = fails(await h.admin.post(`/accounts/documents/${d.id}/issue`, {}), 422, re)
      expect(r.stop).toEqual({ rule })
      expect(ok(await h.admin.get(`/accounts/documents/${d.id}`)).document).toMatchObject({ state: 'draft', number: null })
      ok(await h.admin.del(`/accounts/documents/${d.id}`))
    }
    await stopped(invoice(ids.mp, '2026-06-12', [{ itemId: ids.survey, quantity: '1', unitPrice: '40000' }]), 'G3.9', /^Place of supply needs the accountant: services in the "immovable property" category/)
    await stopped(invoice(ids.mp, '2026-06-12', [{ itemId: ids.pump, quantity: '1', unitPrice: '100' }], { supply: { goodsMove: 'unknown' } }), 'G3.9', /say whether the goods move/)
    const noRate = ok(await h.admin.post('/accounts/items', { name: 'Unrated thing', kind: 'goods', hsn: '73181500' })).item.id
    await stopped(invoice(ids.mp, '2026-06-12', [{ itemId: noRate, quantity: '1', unitPrice: '100' }]), 'G4.3', /^No approved rate for HSN\/SAC 73181500 on 2026-06-12\.$/)
    await stopped(invoice(ids.mp, '2026-06-12', [{ itemId: ids.pump, quantity: '1', unitPrice: '100' }, { itemId: ids.book, quantity: '1', unitPrice: '50' }]), 'G7.3', /only taxable lines/)
    await stopped(invoice(null, '2026-06-12', [{ itemId: ids.pump, quantity: '50', unitPrice: '1250.00' }]), 'G3.11', /unregistered recipient needs a name, an address and a State/)
    await stopped(invoice(ids.abroad, '2026-06-12', [{ itemId: ids.pump, quantity: '1', unitPrice: '100' }], { supply: { shipToCountry: 'DE', zeroRated: 'with_payment' } }), 'G1.11', /Exports with payment of integrated tax/)
    await stopped(invoice(ids.mp, '2026-06-12', [{ itemId: ids.pump, quantity: '1', unitPrice: '100' }], { supply: { manualState: '29', manualReason: 'because' } }), 'G3.9', /manual place of supply is switched off/)
    // the counter did not move: the next issued invoice is 00004
    expect((await h.q<any>(`SELECT last_value FROM env_default.ab_gst_series_counters c JOIN env_default.ab_gst_series s ON s.id = c.series_id WHERE s.doc_type = 'tax_invoice'`))[0].last_value).toBe(3)
  })

  it('numbering (G7.6): parallel issues get consecutive numbers without gaps; a number is never back-dated; unique whatever the case', async () => {
    const drafts = await Promise.all([1, 2, 3, 4, 5, 6].map((q) => draft(invoice(ids.walkin, '2026-06-15', [{ itemId: ids.rice, quantity: String(q), unitPrice: '799.00' }]))))
    const issued = await Promise.all(drafts.map((d) => issue(d.id)))
    expect(issued.map((d) => d.number).sort()).toEqual(['INV/26-27/00004', 'INV/26-27/00005', 'INV/26-27/00006', 'INV/26-27/00007', 'INV/26-27/00008', 'INV/26-27/00009'])
    // W21 by the way: an unregistered buyer whose State is recorded
    expect(issued[0]).toMatchObject({ taxKind: 'inter', placeOfSupply: '08', supplyType: 'B2C' })
    expect(issued[0].snapshot.rule).toBe('T4')
    const back = await draft(invoice(ids.mp, '2026-06-14', [{ itemId: ids.rice, quantity: '1', unitPrice: '799.00' }]))
    fails(await h.admin.post(`/accounts/documents/${back.id}/issue`, {}), 422, /cannot be back-dated/)
    ok(await h.admin.del(`/accounts/documents/${back.id}`))
    // a second series, and the 16-character limit
    fails(await h.admin.post('/accounts/series', { docType: 'tax_invoice', name: 'Long', prefix: 'INVOICE/{FY}/', padding: 5 }), 422, /limit is 16/)
    fails(await h.admin.post('/accounts/series', { docType: 'tax_invoice', name: 'Odd', prefix: 'INV_', padding: 5 }), 422, /letters, digits, the hyphen and the slash/)
    const exp = ok(await h.admin.post('/accounts/series', { docType: 'tax_invoice', name: 'Exports', prefix: 'EXP/{FY}/', padding: 4 })).item
    ids.expSeries = exp.id
    // the database refuses the same number in another letter case within a financial year
    await expect(h.q(`UPDATE env_default.ab_gst_documents SET number = 'inv/26-27/00001' WHERE number = 'INV/26-27/00002'`)).rejects.toThrow(/ab_ux_gst_documents_number/)
    // a series that issued numbers keeps its format
    const def = ok(await h.admin.get('/accounts/series')).items.find((s: any) => s.docType === 'tax_invoice' && s.isDefault)
    fails(await h.admin.patch(`/accounts/series/${def.id}`, { prefix: 'TI/{FY}/' }), 409, /format cannot change/)
  }, 30_000)

  it('W8: a credit note takes the rates of its invoice, posts G9.3 and cannot credit more than the invoice still has (G5.12)', async () => {
    const body = { docType: 'credit_note', date: '2026-06-20', partyId: ids.mp, originalId: ids.w1, reason: 'return', itcReversalConfirmed: 'yes', lines: [{ itemId: ids.pump, quantity: '2', unitPrice: '1250.00' }] }
    fails(await h.admin.post(`/accounts/documents/${(await draft({ ...body, itcReversalConfirmed: null })).id}/issue`, {}), 422, /reversal of input tax credit/)
    fails(await h.admin.post(`/accounts/documents/${(await draft({ ...body, partyId: ids.mh })).id}/issue`, {}), 422, /same customer/)
    fails(await h.admin.post(`/accounts/documents/${(await draft({ ...body, lines: [{ itemId: ids.rice, quantity: '1', unitPrice: '10' }] })).id}/issue`, {}), 422, /is not on INV\/26-27\/00001/)
    fails(await h.admin.post(`/accounts/documents/${(await draft({ ...body, date: '2026-06-09' })).id}/issue`, {}), 422, /before its original/)
    const cn = await issue((await draft(body)).id)
    ids.cn = cn.id
    expect(cn).toMatchObject({ number: 'CN/26-27/00001', taxKind: 'intra', placeOfSupply: '23', originalId: ids.w1 })
    expect(cn.totals).toMatchObject({ taxable: 250000, cgst: 22500, sgst: 22500, total: 295000 })
    expect(cn.snapshot.original).toMatchObject({ number: 'INV/26-27/00001', date: '2026-06-10' })
    expect(await lines(cn.journalId)).toEqual(['output_cgst 225.00 0.00', 'output_sgst 225.00 0.00', 'receivables 0.00 2950.00', 'sales_returns 2500.00 0.00'])
    // the invoice still has 10,000.00 / 900.00 / 900.00: 9 more units are refused, 8 are accepted
    const tooMuch = await draft({ ...body, date: '2026-06-21', lines: [{ itemId: ids.pump, quantity: '9', unitPrice: '1250.00' }] })
    expect(fails(await h.admin.post(`/accounts/documents/${tooMuch.id}/issue`, {}), 422, /more taxable value than the original invoice still has/).stop).toEqual({ rule: 'G5.12' })
    // two notes for the rest at the same moment: exactly one is issued
    const a = await draft({ ...body, date: '2026-06-21', lines: [{ itemId: ids.pump, quantity: '8', unitPrice: '1250.00' }] })
    const b = await draft({ ...body, date: '2026-06-21', lines: [{ itemId: ids.pump, quantity: '8', unitPrice: '1250.00' }] })
    const both = await Promise.all([h.admin.post(`/accounts/documents/${a.id}/issue`, {}), h.admin.post(`/accounts/documents/${b.id}/issue`, {})])
    expect(both.map((r) => r.status).sort()).toEqual([200, 422])
    // W27: the deadline of 30 November after the financial year is checked from the dated value
    const late = await draft({ ...body, date: '2027-12-05', lines: [{ itemId: ids.pump, quantity: '1', unitPrice: '1.00' }] })
    expect(late.problem).toMatch(/cannot be dated after 2027-11-30/)
    // a debit note posts like an invoice (W10)
    const dn = await issue((await draft({ docType: 'debit_note', date: '2026-06-22', partyId: ids.mh, originalId: ids.w2, lines: [{ itemId: ids.pump, quantity: '10', unitPrice: '50.00' }] })).id)
    expect(dn.totals).toMatchObject({ taxable: 50000, igst: 9000, total: 59000 })
    expect(await lines(dn.journalId)).toEqual(['output_igst 0.00 90.00', 'receivables 590.00 0.00', 'sales_taxable 0.00 500.00'])
  }, 30_000)

  it('W14: export under LUT is zero-rated with the endorsement (G9.2b); without an LUT entry it is a STOP', async () => {
    const body = invoice(ids.abroad, '2026-06-23', [{ itemId: ids.pump, quantity: '260', unitPrice: '1250.00' }], { seriesId: ids.expSeries, supply: { shipToCountry: 'DE', shipToAddress: 'Hafenstrasse 1, Köln' } })
    const exp = await issue((await draft(body)).id)
    ids.exp = exp.id
    expect(exp).toMatchObject({ number: 'EXP/26-27/0001', taxKind: 'zero', placeOfSupply: 'OTHER', supplyType: 'EXPWOP' })
    expect(exp.totals).toMatchObject({ taxable: 32500000, igst: 0, total: 32500000 })
    expect(exp.snapshot).toMatchObject({ zeroRated: 'lut', lutReference: 'AD230426000123X' })
    expect(await lines(exp.journalId)).toEqual(['receivables 325000.00 0.00', 'sales_zero_rated 0.00 325000.00'])
    const blocks = JSON.stringify(await runInEnvironment('default', async () => documentBlocks((await getDocument(h.app.services.state.db!, exp.id))!, '96')))
    expect(blocks).toContain(ENDORSEMENT_LUT)
    expect(blocks).toContain('Country of destination: DE')
    expect(blocks).toContain('Outside India (96)')
    // the next financial year has no LUT entry
    ok(await h.admin.post('/accounts/years', { date: '2027-04-10' }))
    const next = await draft({ ...body, date: '2027-04-10' })
    expect(next.problem).toMatch(/needs an LUT entry for this financial year/)
    ok(await h.admin.del(`/accounts/documents/${next.id}`))
  })

  it('purchases: W29 ineligible credit joins the expense (G9.4), eligible credit goes to the input accounts, W11 reverse charge (G9.5)', async () => {
    const pur = (partyId: string, ls: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ docType: 'purchase_invoice', date: '2026-06-25', partyId, supplierInvoiceNo: 'IC/118', supplierInvoiceDate: '2026-06-24', lines: ls, ...extra })
    const und = await draft(pur(ids.supplier, [{ itemId: ids.rice, quantity: '1', unitPrice: '2000.00' }]))
    expect(und.problem).toMatch(/Decide the input tax credit flag/)
    ok(await h.admin.del(`/accounts/documents/${und.id}`))
    const w29 = await issue((await draft(pur(ids.supplier, [{ itemId: ids.food, quantity: '1', unitPrice: '2000.00', itcReason: 'food for staff' }]))).id)
    expect(w29).toMatchObject({ number: 'PUR/26-27/00001', supplyType: 'INWARD', taxKind: 'intra' })
    expect(w29.totals).toMatchObject({ taxable: 200000, cgst: 5000, sgst: 5000, total: 210000 })
    expect(w29.lines[0]).toMatchObject({ itc: 'ineligible', itcReason: 'food for staff', cgst: 5000 })
    expect(await lines(w29.journalId)).toEqual(['expenses 2100.00 0.00', 'payables 0.00 2100.00'])
    const elig = await issue((await draft(pur(ids.supplier, [{ itemId: ids.rice, quantity: '10', unitPrice: '2000.00', itc: 'eligible' }], { supplierInvoiceNo: 'IC/119' }))).id)
    expect(await lines(elig.journalId)).toEqual(['input_cgst 500.00 0.00', 'input_sgst 500.00 0.00', 'payables 0.00 21000.00', 'purchases 20000.00 0.00'])
    // W11: the advocate bills 25,000.00 without tax; the business computes 2,250.00 + 2,250.00 payable and, eligible, as credit
    const w11 = await issue((await draft(pur(ids.advocate, [{ itemId: ids.legal, quantity: '1', unitPrice: '25000.00' }], { supplierInvoiceNo: 'RV-7' }))).id)
    expect(w11.totals).toMatchObject({ taxable: 2500000, cgst: 225000, sgst: 225000, total: 2500000 })
    expect(w11.lines[0]).toMatchObject({ reverseCharge: true, itc: 'eligible' })
    expect(await lines(w11.journalId)).toEqual(['input_cgst_rcm 2250.00 0.00', 'input_sgst_rcm 2250.00 0.00', 'legal_expenses 25000.00 0.00', 'payables 0.00 25000.00', 'rcm_cgst 0.00 2250.00', 'rcm_sgst 0.00 2250.00'])
    const w11b = await issue((await draft(pur(ids.advocate, [{ itemId: ids.legal, quantity: '1', unitPrice: '25000.00', itc: 'ineligible', itcReason: 'personal use' }], { supplierInvoiceNo: 'RV-8' }))).id)
    expect(await lines(w11b.journalId)).toEqual(['legal_expenses 29500.00 0.00', 'payables 0.00 25000.00', 'rcm_cgst 0.00 2250.00', 'rcm_sgst 0.00 2250.00'])
    // a customer is not a supplier
    fails(await h.admin.post(`/accounts/documents/${(await draft(pur(ids.mp, [{ itemId: ids.rice, quantity: '1', unitPrice: '1', itc: 'eligible' }]))).id}/issue`, {}), 422, /is a customer, not a supplier/)
  })

  it('W16: a receipt voucher for a service advance is tax-inclusive and posts G9.6; a refund voucher reverses it; a payment voucher', async () => {
    const rv = await issue((await draft({ docType: 'receipt_voucher', date: '2026-06-26', partyId: ids.mp, lines: [{ itemId: ids.consult, quantity: '1', unitPrice: '118000.00' }] })).id)
    expect(rv).toMatchObject({ number: 'RV/26-27/00001', taxKind: 'intra', supplyType: 'ADVANCE' })
    expect(rv.totals).toMatchObject({ taxable: 10000000, cgst: 900000, sgst: 900000, total: 11800000 })
    expect(await lines(rv.journalId)).toEqual(['advance_gst_suspense 18000.00 0.00', 'bank 118000.00 0.00', 'customer_advances 0.00 118000.00', 'output_cgst 0.00 9000.00', 'output_sgst 0.00 9000.00'])
    const rf = await issue((await draft({ docType: 'refund_voucher', date: '2026-06-27', partyId: ids.mp, originalId: rv.id, lines: [{ itemId: ids.consult, quantity: '1', unitPrice: '59000.00' }] })).id)
    expect(rf.totals).toMatchObject({ taxable: 5000000, cgst: 450000, sgst: 450000, total: 5900000 })
    expect(await lines(rf.journalId)).toEqual(['advance_gst_suspense 0.00 9000.00', 'bank 0.00 59000.00', 'customer_advances 59000.00 0.00', 'output_cgst 4500.00 0.00', 'output_sgst 4500.00 0.00'])
    fails(await h.admin.post(`/accounts/documents/${(await draft({ docType: 'refund_voucher', date: '2026-06-27', partyId: ids.mp, originalId: rv.id, lines: [{ itemId: ids.consult, quantity: '1', unitPrice: '60000.00' }] })).id}/issue`, {}), 422, /refund voucher refunds more/)
    // an advance for goods carries no tax (G5.15)
    const goods = await issue((await draft({ docType: 'receipt_voucher', date: '2026-06-27', partyId: ids.mp, moneyAccount: 'cash', lines: [{ itemId: ids.pump, quantity: '1', unitPrice: '5000.00' }] })).id)
    expect(await lines(goods.journalId)).toEqual(['cash 5000.00 0.00', 'customer_advances 0.00 5000.00'])
    const pv = await issue((await draft({ docType: 'payment_voucher', date: '2026-06-28', partyId: ids.supplier, amount: '2100.00' })).id)
    expect(await lines(pv.journalId)).toEqual(['bank 0.00 2100.00', 'payables 2100.00 0.00'])
  })

  it('after issue only the recorded fields change: IRN once, e-way bill, notes (G7.8, G8.3, G8.6, W30)', async () => {
    // 45,000.00 taxable at 18 %: consignment value 53,100.00 is above the dated threshold, so the document asks for the e-way bill
    const big = await issue((await draft(invoice(ids.mp, '2026-06-28', [{ itemId: ids.pump, quantity: '36', unitPrice: '1250.00' }]))).id)
    expect(big.snapshot).toMatchObject({ consignmentValue: 5310000, ewayRequired: true, irnRequired: false })
    const small = await draft(invoice(ids.mp, '2026-06-28', [{ itemId: ids.pump, quantity: '33.6', unitPrice: '1250.00' }]))
    expect(small.snapshot).toMatchObject({ consignmentValue: 4956000, ewayRequired: false })
    ok(await h.admin.del(`/accounts/documents/${small.id}`))
    fails(await c.bo.post(`/accounts/documents/${big.id}/record`, { ewayNo: '12345' }), 422, /12 digits/)
    const rec = ok(await c.bo.post(`/accounts/documents/${big.id}/record`, { ewayNo: '181234567890', ewayDate: '2026-06-28', vehicleNo: 'MP09AB1234', notes: 'Loaded at gate 2' })).document
    expect(rec).toMatchObject({ ewayNo: '181234567890', ewayDate: '2026-06-28', vehicleNo: 'MP09AB1234', notes: 'Loaded at gate 2' })
    const irn = 'a'.repeat(64)
    fails(await c.bo.post(`/accounts/documents/${big.id}/record`, { irn: 'short' }), 422, /64 characters/)
    expect(ok(await c.bo.post(`/accounts/documents/${big.id}/record`, { irn, irnAckNo: '112010012345678', irnAckDate: '2026-06-28' })).document.irn).toBe(irn)
    fails(await c.bo.post(`/accounts/documents/${big.id}/record`, { irn: 'b'.repeat(64), irnAckNo: '1', irnAckDate: '2026-06-28' }), 409, /entered already/)
    expect((await h.q<any>(`SELECT details FROM env_default.ab_audit WHERE action = 'accounts.document.record' AND row_id = $1 ORDER BY id`, [big.id])).map((a) => a.details.changed)).toEqual([['eway_no', 'eway_date', 'eway_valid_until', 'vehicle_no', 'notes'], ['irn', 'irn_ack_no', 'irn_ack_date', 'irn_qr']])
    // the figures did not move
    expect(ok(await h.admin.get(`/accounts/documents/${big.id}`)).document.totals).toEqual(big.totals)
    ids.big = big.id
    // above the e-invoice threshold in an earlier year, a B2B invoice is marked "IRN required"
    const b = ok(await h.admin.get('/accounts/business')).business
    ok(await put(h.admin, '/accounts/business', { ...b, turnovers: { '2024-25': '60000000', '2025-26': '60000000' } }))
    const need = await draft(invoice(ids.mp, '2026-06-28', [{ itemId: ids.pump, quantity: '1', unitPrice: '1250.00' }]))
    expect(need.snapshot.irnRequired).toBe(true)
    // and 6 digits of HSN are then enough only because the item has 8; a 4-digit code is refused (G7.7)
    const short = ok(await h.admin.post('/accounts/items', { name: 'Pump, short code', kind: 'goods', hsn: '8413' })).item.id
    expect((await draft(invoice(ids.mp, '2026-06-28', [{ itemId: short, quantity: '1', unitPrice: '10' }]))).problem).toMatch(/shorter than the 6 digits required/)
    ok(await put(h.admin, '/accounts/business', { ...b, turnovers: {} }))
    expect((await draft(invoice(ids.mp, '2026-06-28', [{ itemId: short, quantity: '1', unitPrice: '10' }]))).problem).toBeNull()
    ok(await h.admin.del(`/accounts/documents/${need.id}`))
  })

  it('cancellation (G7.9): keeps the number, reverses the journal; refused with an IRN or a later note', async () => {
    fails(await h.admin.post(`/accounts/documents/${ids.big}/cancel`, { reason: 'x' }), 409, /has an IRN/)
    fails(await h.admin.post(`/accounts/documents/${ids.w1}/cancel`, { reason: 'x' }), 409, /later note or voucher/)
    const before = await closing('receivables')
    const inv = await issue((await draft(invoice(ids.mh, '2026-06-29', [{ itemId: ids.pump, quantity: '1', unitPrice: '1000.00' }]))).id)
    expect(await closing('receivables')).toBe(before + 118000)
    fails(await h.admin.post(`/accounts/documents/${inv.id}/cancel`, { reason: ' ' }), 422, /reason/)
    const x = ok(await c.bo.post(`/accounts/documents/${inv.id}/cancel`, { date: '2026-06-30', reason: 'raised twice' })).document
    expect(x).toMatchObject({ state: 'cancelled', number: inv.number, cancelReason: 'raised twice' })
    expect(await lines(x.cancelJournalId)).toEqual(['output_igst 180.00 0.00', 'receivables 0.00 1180.00', 'sales_taxable 1000.00 0.00'])
    expect(await closing('receivables')).toBe(before)
    fails(await h.admin.post(`/accounts/documents/${inv.id}/cancel`, { reason: 'again' }), 409, /cancelled already/)
    ids.cancelled = inv.id
    ids.cancelledNo = inv.number
  })

  it('period locks (G9.10): soft lock lets only an Accounts administrator post; a lock refuses everybody; unlocking needs a reason', async () => {
    const july = ids['period_2026-07']
    const j = { date: '2026-07-05', narration: 'Rent July', lines: [{ accountId: acc.rent.id, debit: '15000.00' }, { accountId: acc.bank.id, credit: '15000.00' }] }
    fails(await c.bo.post(`/accounts/periods/${july}/lock`, { state: 'soft_locked' }), 403)
    expect(ok(await h.admin.post(`/accounts/periods/${july}/lock`, { state: 'soft_locked' })).item.state).toBe('soft_locked')
    fails(await c.bo.post('/accounts/journals', j), 403, /soft-locked: only an Accounts administrator/)
    ok(await h.admin.post('/accounts/journals', j))
    expect(ok(await h.admin.post(`/accounts/periods/${july}/lock`, { state: 'locked' })).item.state).toBe('locked')
    fails(await h.admin.post('/accounts/journals', j), 409, /The period July 2026 is locked/)
    const d = await draft(invoice(ids.mp, '2026-07-06', [{ itemId: ids.pump, quantity: '1', unitPrice: '1250.00' }]))
    fails(await h.admin.post(`/accounts/documents/${d.id}/issue`, {}), 409, /July 2026 is locked: nobody can issue a document in it/)
    expect(ok(await h.admin.get(`/accounts/documents/${d.id}`)).document).toMatchObject({ state: 'draft', number: null })
    // a reversal dated in the locked period is refused too; dated in an open period it is fine
    fails(await h.admin.post(`/accounts/journals/${ids.capital}/reverse`, { date: '2026-07-31', reason: 'x' }), 409, /locked/)
    fails(await h.admin.post(`/accounts/periods/${july}/lock`, { state: 'locked' }), 409)
    fails(await h.admin.post(`/accounts/periods/${july}/unlock`, {}), 422, /reason is required/)
    // only an install administrator reverses a hard lock (an Accounts administrator is not one)
    ok(await put(h.admin, '/accounts/access', { access: { [ids.poster]: 'admin', [ids.reader]: 'view' } }))
    expect(ok(await c.bo.get('/accounts/state')).level).toBe('admin')
    fails(await c.bo.post(`/accounts/periods/${july}/unlock`, { reason: 'late bill' }), 403, /install administrator/)
    expect(ok(await h.admin.post(`/accounts/periods/${july}/unlock`, { reason: 'late bill' })).item).toMatchObject({ state: 'open', reason: 'late bill' })
    expect((await h.q<any>(`SELECT action, details FROM env_default.ab_audit WHERE action LIKE 'accounts.period.%' ORDER BY id`)).map((a) => `${a.action} ${a.details.to ?? a.details.reason}`))
      .toEqual(['accounts.period.lock soft_locked', 'accounts.period.lock locked', 'accounts.period.unlock late bill'])
    expect((await issue(d.id)).state).toBe('issued')
  }, 30_000)

  it('reports: the trial balance balances; ledger, profit and loss and balance sheet agree with it; CSV', async () => {
    const t = await tb()
    expect(t.balanced).toBe(true)
    expect(t.totals.debit).toBe(t.totals.credit)
    expect(t.totals.closingDebit).toBe(t.totals.closingCredit)
    const sums = await h.q<any>(`SELECT sum(debit)::bigint AS d, sum(credit)::bigint AS c FROM env_default.ab_led_lines`)
    expect(Number(sums[0].d)).toBe(t.totals.debit)
    expect(Number(sums[0].d)).toBe(Number(sums[0].c))
    // every journal balances on its own
    expect(await h.q(`SELECT journal_id FROM env_default.ab_led_lines GROUP BY journal_id HAVING sum(debit) <> sum(credit)`)).toEqual([])
    const led = ok(await h.admin.get(`/accounts/ledger?account=${acc.output_igst.id}&from=2026-04-01&to=2027-03-31`))
    expect(led.closing).toBe(await closing('output_igst'))
    expect(led.entries[led.entries.length - 1].balance).toBe(led.closing)
    const party = ok(await h.admin.get(`/accounts/ledger?account=${acc.receivables.id}&to=2027-03-31&party=${ids.mh}`))
    expect(party.entries.every((e: any) => e.partyId === ids.mh)).toBe(true)
    const pl = ok(await h.admin.get('/accounts/reports/profit-loss?from=2026-04-01&to=2027-03-31'))
    expect(pl.profit).toBe(pl.totalIncome - pl.totalExpense)
    const bs = ok(await h.admin.get('/accounts/reports/balance-sheet?asOf=2027-03-31'))
    expect(bs.balanced).toBe(true)
    expect(bs.profitToDate).toBe(pl.profit)
    expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity)
    fails(await h.admin.get('/accounts/reports/profit-loss'), 422, /from is required/)
    const csv = await h.admin.get('/accounts/reports/trial-balance?to=2027-03-31&format=csv')
    expect(csv.status).toBe(200)
    expect(String(csv.data)).toMatch(/Code,Account,Kind,Opening,Debit,Credit,Closing debit,Closing credit/)
    expect(String(csv.data)).toMatch(/2103,Output IGST,liability/)
    for (const p of ['/accounts/reports/profit-loss?from=2026-04-01&format=csv', '/accounts/reports/balance-sheet?format=csv', `/accounts/ledger?account=${acc.bank.id}&format=csv`]) expect((await h.admin.get(p)).status, p).toBe(200)
  })

  it('PDF: tax invoice, bill of supply and credit note print with the particulars of G7.1, G7.3 and G7.4; nothing about the draft status', async () => {
    const pdf = async (id: string) => {
      const res = await fetch(`${h.base}/api/v1/accounts/documents/${id}/pdf`, { headers: { Cookie: h.admin.cookie, 'X-Appbuilder': '1' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      const bytes = Buffer.from(await res.arrayBuffer())
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
      expect(bytes.length).toBeGreaterThan(3000)
      return bytes
    }
    const view = (id: string) => runInEnvironment('default', async () => (await getDocument(h.app.services.state.db!, id))!)
    const inv = await view(ids.w1)
    const text = JSON.stringify(documentBlocks(inv, '96'))
    for (const s of ['Asha Pumps Private Limited', '12 Industrial Area, Indore 452001', 'GSTIN: 23ABCDE1234F1Z5', 'INV/26-27/00001', '10-06-2026', 'Bhopal Traders', 'GSTIN/UIN: 23AAAAA0000A1Z5', 'State: Madhya Pradesh (code 23)',
      '84137010', 'Monoblock pump 1 HP', 'NOS', '12,500.00', 'CGST %', 'SGST %', '1,125.00', '14,750.00', 'Madhya Pradesh (23)', 'Tax payable on reverse charge', 'authorised signatory', 'Bank: Example Bank, Indore', '"1,250.00"']) expect(text, s).toContain(s)
    // the unit price is printed like every other amount (grouped), not as it was typed
    expect(text).not.toContain('"1250.00"')
    expect(text).not.toMatch(/draft|not reviewed|accountant/i)
    expect(copyMarks(inv)).toEqual(['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER'])
    await pdf(ids.w1)
    await pdf(ids.w2)
    const cn = JSON.stringify(documentBlocks(await view(ids.cn), '96'))
    for (const s of ['CN/26-27/00001', 'Against invoice', 'INV/26-27/00001 dated 10-06-2026', 'Reason: goods returned', '2,950.00', 'Total credited (INR)']) expect(cn, s).toContain(s)
    await pdf(ids.cn)
    // the invoice with an IRN prints one unmarked copy with the IRN; a cancelled one says so
    const big = await view(ids.big)
    expect(copyMarks(big)).toEqual([''])
    expect(JSON.stringify(documentBlocks(big, '96'))).toContain('a'.repeat(64))
    expect(JSON.stringify(documentBlocks(await view(ids.cancelled), '96'))).toContain('CANCELLED')
    // a bill of supply for an exempt item: no tax columns, no rate
    const bos = await issue((await draft({ docType: 'bill_of_supply', date: '2026-07-10', partyId: ids.mp, lines: [{ itemId: ids.book, quantity: '12', unitPrice: '100.00' }] })).id)
    expect(bos).toMatchObject({ number: 'BOS/26-27/00001', taxKind: 'none' })
    expect(await lines(bos.journalId)).toEqual(['receivables 1200.00 0.00', 'sales_exempt 0.00 1200.00'])
    const bosText = JSON.stringify(documentBlocks(await view(bos.id), '96'))
    expect(bosText).toContain('Bill of supply no.')
    expect(bosText).not.toMatch(/CGST|IGST|Taxable value|reverse charge/)
    await pdf(bos.id)
    // drafts and vouchers have no print
    const d = await draft(invoice(ids.mp, '2026-07-10', [{ itemId: ids.pump, quantity: '1', unitPrice: '1.00' }]))
    fails(await h.admin.get(`/accounts/documents/${d.id}/pdf`), 422, /issue it first/)
    ok(await h.admin.del(`/accounts/documents/${d.id}`))
  }, 30_000)

  it('W13: a composition business issues bills of supply without tax (G9.7), never to another State; the helper computes the period tax', async () => {
    const b = ok(await h.admin.get('/accounts/business')).business
    ok(await put(h.admin, '/accounts/business', { ...b, regType: 'composition', composition: { category: 'manufacturer', from: '2026-08-01' } }))
    const inv = await draft(invoice(ids.mp, '2026-08-05', [{ itemId: ids.pump, quantity: '40', unitPrice: '1250.00' }]))
    expect(inv.problem).toMatch(/composition taxable person issues a bill of supply/)
    ok(await h.admin.del(`/accounts/documents/${inv.id}`))
    const out = await draft({ docType: 'bill_of_supply', date: '2026-08-05', partyId: ids.mh, lines: [{ itemId: ids.pump, quantity: '1', unitPrice: '1250.00' }] })
    expect(out.problem).toMatch(/may not make an outward supply whose place of supply is in another State/)
    ok(await h.admin.del(`/accounts/documents/${out.id}`))
    const bos = await issue((await draft({ docType: 'bill_of_supply', date: '2026-08-05', partyId: ids.mp, lines: [{ itemId: ids.pump, quantity: '40', unitPrice: '1250.00' }] })).id)
    expect(bos.totals).toMatchObject({ taxable: 5000000, cgst: 0, sgst: 0, igst: 0, total: 5000000 })
    expect(await lines(bos.journalId)).toEqual(['receivables 50000.00 0.00', 'sales_taxable 0.00 50000.00'])
    const text = JSON.stringify(await runInEnvironment('default', async () => documentBlocks((await getDocument(h.app.services.state.db!, bos.id))!, '96')))
    expect(text).toContain(COMPOSITION_HEADER)
    expect(text).not.toMatch(/CGST|IGST|%/)
    const helper = ok(await h.admin.get('/accounts/returns/composition-helper?from=2026-08-01&to=2026-08-31'))
    const row = (k: string) => helper.rows.find((r: any[]) => r[0] === k)?.[1]
    expect(row('Turnover in the State for the period')).toBe('50000.00')
    expect(row('Composition tax, CGST')).toBe('250.00')
    expect(row('Composition tax, SGST')).toBe('250.00')
    // a composition business never takes input tax credit
    const pur = await issue((await draft({ docType: 'purchase_invoice', date: '2026-08-06', partyId: ids.supplier, supplierInvoiceNo: 'IC/200', lines: [{ itemId: ids.rice, quantity: '1', unitPrice: '1000.00', itc: 'eligible' }] })).id)
    expect(pur.lines[0].itc).toBe('ineligible')
    expect(await lines(pur.journalId)).toEqual(['payables 0.00 1050.00', 'purchases 1050.00 0.00'])
    ok(await put(h.admin, '/accounts/business', { ...b }))
  })

  it('return summaries are data and CSV only (section 10)', async () => {
    const list = ok(await h.admin.get('/accounts/returns'))
    expect(list.items).toHaveLength(13)
    expect(list.notice).toMatch(/does not prepare, check or file any return/)
    const get = async (name: string) => ok(await h.admin.get(`/accounts/returns/${name}?from=2026-06-01&to=2026-06-30`))
    const reg = await get('outward-register')
    const w1 = reg.rows.find((r: any[]) => r[1] === 'INV/26-27/00001')
    expect(reg.columns.slice(0, 5)).toEqual(['Document type', 'Number', 'Date', 'Status', 'Recipient GSTIN'])
    expect(w1.slice(0, 9)).toEqual(['Tax invoice', 'INV/26-27/00001', '2026-06-10', 'issued', '23AAAAA0000A1Z5', 'Bhopal Traders', '23', '23', 'B2B'])
    expect(w1.slice(14, 20)).toEqual(['12500.00', '18', '0.00', '1125.00', '1125.00', '0.00'])
    expect(reg.rows.find((r: any[]) => r[3] === 'cancelled')).toBeTruthy()
    const b2b = await get('b2b')
    expect(b2b.rows.find((r: any[]) => r[1] === 'INV/26-27/00002')).toEqual(['27BBBBB1111B1Z5', 'INV/26-27/00002', '2026-06-11', '14750.00', '27', 'N', 'B2B', '18', '12500.00', '2250.00', '0.00', '0.00', '0.00'])
    expect(b2b.rows.some((r: any[]) => r[1] === ids.cancelledNo)).toBe(false)
    const b2c = await get('b2c-others')
    // six invoices of 1..6 bags at 799.00 to the unregistered buyer in Rajasthan, 5 %
    expect(b2c.rows).toEqual([['08', '5', '16779.00', '838.95', '0.00', '0.00', '0.00']])
    const notes = await get('notes')
    expect(notes.rows.find((r: any[]) => r[1] === 'CN/26-27/00001')).toEqual(['Credit note', 'CN/26-27/00001', '2026-06-20', 'INV/26-27/00001', '2026-06-10', '23AAAAA0000A1Z5', 'Y', '23', '18', '2500.00', '0.00', '225.00', '225.00', '0.00', 'return', 'yes'])
    const exp = await get('exports')
    expect(exp.rows).toEqual([['EXP/26-27/0001', '2026-06-23', '325000.00', 'Export', 'without payment', 'AD230426000123X', '', '', '', '0', '325000.00', '0.00']])
    const issuedDocs = await get('documents-issued')
    const inv = issuedDocs.rows.find((r: any[]) => r[0] === 'Tax invoice' && r[1] === 'Default')
    expect(inv.slice(2, 5)).toEqual(['2026-27', 'INV/26-27/00001', 'INV/26-27/00011'])
    expect(inv.slice(5)).toEqual([11, 1, 10])
    const inward = await get('inward-register')
    expect(inward.rows.find((r: any[]) => r[3] === 'RV-7').slice(8, 19)).toEqual(['Y', '998212', 'Legal services', '18', '25000.00', '0.00', '2250.00', '2250.00', '0.00', 'eligible', ''])
    const helper = await get('gstr3b-helper')
    const section = (name: string) => helper.rows.find((r: any[]) => String(r[0]).startsWith(name)).slice(1)
    expect(section('Outward taxable supplies (zero-rated)')).toEqual(['325000.00', '0.00', '0.00', '0.00', '0.00'])
    expect(section('Inward supplies liable to reverse charge')).toEqual(['50000.00', '0.00', '4500.00', '4500.00', '0.00'])
    expect(section('ITC: inward supplies liable to reverse charge')).toEqual(['25000.00', '0.00', '2250.00', '2250.00', '0.00'])
    expect(section('Ineligible ITC')).toEqual(['27000.00', '0.00', '2300.00', '2300.00', '0.00'])
    const adv = await get('advances')
    expect(adv.rows.find((r: any[]) => r[1] === '18')).toEqual(['23', '18', '50000.00', '0.00', '4500.00', '4500.00', '0.00'])
    const hsn = await get('hsn')
    expect(hsn.rows.find((r: any[]) => r[0] === '10063010' && r[5] === '5')).toBeTruthy()
    for (const { name } of list.items) {
      const csv = await h.admin.get(`/accounts/returns/${name}?from=2026-04-01&to=2027-03-31&format=csv`)
      expect(csv.status, name).toBe(200)
      expect(String(csv.data).length, name).toBeGreaterThan(10)
    }
    fails(await h.admin.get('/accounts/returns/nope?from=2026-04-01&to=2027-03-31'), 404)
    fails(await h.admin.get('/accounts/returns/b2b'), 422)
  })

  it('a read-only install refuses every write in Accounts and keeps the reads', async () => {
    const keys = h.app.router.routes().filter((r) => r.pattern.startsWith('/accounts'))
    expect(keys.length).toBeGreaterThan(45)
    const { READ_ONLY_ALLOWED } = await import('../hosting/read-only.ts')
    expect(keys.filter((r) => r.method !== 'GET' && READ_ONLY_ALLOWED.has(r.key))).toEqual([])
    // every reading route is a GET and every route needs a signed-in user
    expect(keys.every((r) => r.opts.auth === 'user')).toBe(true)
    const anon = new Client(h.base)
    expect((await anon.get('/accounts/state')).status).toBe(401)
    expect((await anon.get('/accounts/documents')).status).toBe(401)
  })
})
