/**
 * Accounts API (P3 package L: ledgers and India GST; docs/plan/ledgers-gst-spec.md section 3, docs/dev/ledgers-gst.md).
 * The GST calculation rules behind it are a DRAFT that no practising accountant has reviewed: GET /accounts/state
 * carries that notice for the settings page. Nothing here files a return or talks to any government system.
 *
 * Levels (core.ts): view = every GET; post = drafts, issue, cancel, record, journals, parties, items; admin = business,
 * access, setup, reference data, series, chart, years, period locks. Unlocking a LOCKED period: install administrators
 * only, with a typed reason (draft G9.10). All reads are GET, so a read-only install refuses every write here by the
 * router's default. Every change is audited (accounts.*). Amounts in JSON are integer paise; amounts sent are decimal
 * rupees as text; CSV carries rupees.
 *
 *   GET  /accounts/state
 *   GET|PUT /accounts/business            GET|PUT /accounts/access        POST /accounts/access/accountant-role
 *   POST /accounts/setup                  seeds the default chart and number series (adds what is missing)
 *   GET|POST /accounts/reference/:kind    PATCH|DELETE /accounts/reference/:kind/:id     POST /accounts/reference/examples
 *   GET|POST /accounts/parties, PATCH /accounts/parties/:id        GET|POST /accounts/items, PATCH /accounts/items/:id
 *   GET|POST /accounts/series, PATCH /accounts/series/:id          GET|POST /accounts/chart, PATCH /accounts/chart/:id
 *   GET|POST /accounts/years              POST /accounts/periods/:id/lock { state }      POST /accounts/periods/:id/unlock { reason }
 *   GET|POST /accounts/journals           GET /accounts/journals/:id                     POST /accounts/journals/:id/reverse { date, reason }
 *   GET  /accounts/ledger?account=&from=&to=&party=                 (format=csv)
 *   GET  /accounts/reports/trial-balance?from=&to=   /profit-loss?from=&to=   /balance-sheet?asOf=   (format=csv)
 *   GET|POST /accounts/documents          GET|PATCH|DELETE /accounts/documents/:id
 *   POST /accounts/documents/:id/issue    POST /accounts/documents/:id/cancel { date?, reason }   POST /accounts/documents/:id/record
 *   GET  /accounts/documents/:id/pdf
 *   GET  /accounts/returns                GET /accounts/returns/:name?from=&to=          (format=csv)
 */
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Ctx } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { uid } from '../util.ts'
import { DRAFT_NOTICE, LEVELS, T, audit, bodyOf, conflict, csvResponse, dateOf, dbOf, getSetting, guarded, invalid, isObj, levelOf, need, notFound, oneOf, optionalDate, putSetting, requiredText, text, toCsv, type Level } from './core.ts'
import {
  ACCOUNT_KINDS, accountLedger, balanceSheet, createAccount, createYear, getJournal, listAccounts, listJournals, listYears, postJournal, profitAndLoss, reverseJournal, seedChart, setPeriodState, trialBalance, updateAccount,
} from './service.ts'
import { paise, rupees } from '../gst/money.ts'
import { DOC_TITLES, DOC_TYPES } from '../gst/engine.ts'
import { REFERENCE_KINDS, getBusiness, listItems, listParties, listReference, listSeries, loadExamples, putBusiness, removeReference, saveItem, saveParty, saveReference, saveSeries, seedSeries, thresholdsOn } from '../gst/reference.ts'
import { cancelDocument, createDraft, deleteDraft, getDocument, issueDocument, listDocuments, readDocInput, recordOnIssued, updateDraft } from '../gst/documents.ts'
import { PRINTABLE, documentPdf } from '../gst/pdf.ts'
import { RETURN_SUMMARIES, returnSummary } from '../gst/returns.ts'

const today = (): string => new Date().toISOString().slice(0, 10)
const paging = (ctx: Ctx, max = 500) => ({
  limit: Math.max(1, Math.min(max, Math.trunc(Number(ctx.query.get('limit') ?? 100)) || 100)),
  offset: Math.max(0, Math.trunc(Number(ctx.query.get('offset') ?? 0)) || 0),
})
const qDate = (ctx: Ctx, name: string, required = false): string | null => {
  const v = ctx.query.get(name)
  if (!v) {
    if (required) throw invalid(`${name} is required (a date written YYYY-MM-DD).`, name)
    return null
  }
  return dateOf(v, name, name)
}
const wantsCsv = (ctx: Ctx): boolean => ctx.query.get('format') === 'csv'

export function ledgerRoutes(router: ApiRouter, s: CoreServices): void {
  const db = () => dbOf(s)
  const who = (ctx: Ctx, level: Level) => ({ userId: ctx.user!.user.id, level })

  /* ---------------------------------------------------------------- state, business, access, setup */

  router.add('GET', '/accounts/state', async (ctx) => {
    const level = await levelOf(s, ctx.user!)
    if (level === 'none') return { level, notice: DRAFT_NOTICE }
    const [business, accounts, years, series] = await Promise.all([getBusiness(db()), listAccounts(db()), listYears(db()), listSeries(db())])
    const counts = await db().query<{ states: number; rates: number; thresholds: number }>(
      `SELECT (SELECT count(*)::int FROM ${T('ab_gst_states')}) AS states, (SELECT count(*)::int FROM ${T('ab_gst_rates')}) AS rates, (SELECT count(*)::int FROM ${T('ab_gst_thresholds')}) AS thresholds`)
    return {
      level, notice: DRAFT_NOTICE, business, isInstallAdmin: ctx.user!.user.isInstallAdmin === true,
      setup: { business: !!business, chart: accounts.length > 0, years: years.length, series: series.length > 0, states: Number(counts[0].states), rates: Number(counts[0].rates), thresholds: Number(counts[0].thresholds) },
      docTypes: DOC_TYPES.map((t) => ({ type: t, title: DOC_TITLES[t], printable: (PRINTABLE as readonly string[]).includes(t) })),
    }
  }, { auth: 'user' })

  router.add('GET', '/accounts/business', async (ctx) => {
    await need(s, ctx, 'view')
    return { business: await getBusiness(db()), notice: DRAFT_NOTICE }
  }, { auth: 'user' })
  router.add('PUT', '/accounts/business', async (ctx) => {
    await need(s, ctx, 'admin')
    const before = await getBusiness(db())
    const business = await guarded(() => putBusiness(db(), bodyOf(ctx)))
    await audit(s, ctx, 'accounts.business', { gstin: business.gstin, regType: business.regType, stateCode: business.stateCode, settings: business.settings, before: before ? { gstin: before.gstin, regType: before.regType, settings: before.settings } : null })
    return { business }
  }, { auth: 'user' })

  router.add('GET', '/accounts/access', async (ctx) => {
    await need(s, ctx, 'admin')
    const access = await getSetting<Record<string, Level>>(db(), 'access', {})
    return { roles: (await s.meta.roles.list()).map((r) => ({ id: r.id, name: r.name, level: r.isAdmin ? 'admin' : access[r.id] ?? 'none', fixed: r.isAdmin === true })) }
  }, { auth: 'user' })
  router.add('PUT', '/accounts/access', async (ctx) => {
    await need(s, ctx, 'admin')
    const b = bodyOf(ctx)
    if (!isObj(b.access)) throw invalid('access maps role ids to none, view, post or admin.', 'access')
    const roles = new Set((await s.meta.roles.list()).map((r) => r.id))
    const access: Record<string, Level> = {}
    for (const [id, l] of Object.entries(b.access)) {
      if (!roles.has(id)) throw invalid('There is no such role.', 'access')
      const level = oneOf(l, LEVELS, 'A level', 'access')
      if (level !== 'none') access[id] = level
    }
    await putSetting(db(), 'access', access)
    await audit(s, ctx, 'accounts.access', { access })
    return { access }
  }, { auth: 'user' })
  router.add('POST', '/accounts/access/accountant-role', async (ctx) => {
    await need(s, ctx, 'admin')
    if (!ctx.user!.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only an administrator can create roles.')
    const roles = await s.meta.roles.list()
    let role = roles.find((r) => r.name.toLowerCase() === 'accountant')
    if (!role) {
      role = { id: uid('role'), name: 'Accountant', description: 'Accounts administrator: settings, reference data, documents, journals and period locks in Accounts.', privileges: [], apps: [] }
      await s.meta.roles.upsert(role)
      s.security.invalidate()
    }
    const access = await getSetting<Record<string, Level>>(db(), 'access', {})
    access[role.id] = 'admin'
    await putSetting(db(), 'access', access)
    await audit(s, ctx, 'accounts.access', { accountantRole: role.id, access })
    return { role: { id: role.id, name: role.name }, access }
  }, { auth: 'user' })

  router.add('POST', '/accounts/setup', async (ctx) => {
    await need(s, ctx, 'admin')
    const r = await db().tx(async (tx) => ({ accounts: await seedChart(tx), series: await seedSeries(tx) }))
    await audit(s, ctx, 'accounts.setup', r)
    return { added: r }
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- reference data */

  router.add('POST', '/accounts/reference/examples', async (ctx) => {
    await need(s, ctx, 'admin')
    const r = await loadExamples(db(), ctx.user!.user.id)
    await audit(s, ctx, 'accounts.reference.examples', r)
    return { added: r }
  }, { auth: 'user' })
  router.add('GET', '/accounts/reference/:kind', async (ctx) => {
    await need(s, ctx, 'view')
    if (!REFERENCE_KINDS[ctx.params.kind]) throw notFound('Reference data kind')
    return { kind: ctx.params.kind, items: await listReference(db(), ctx.params.kind) }
  }, { auth: 'user' })
  router.add('POST', '/accounts/reference/:kind', async (ctx) => {
    await need(s, ctx, 'admin')
    const row = await guarded(() => saveReference(db(), ctx.params.kind, null, bodyOf(ctx), ctx.user!.user.id))
    await audit(s, ctx, 'accounts.reference.add', { kind: ctx.params.kind, row }, row.id)
    return { item: row }
  }, { auth: 'user' })
  router.add('PATCH', '/accounts/reference/:kind/:id', async (ctx) => {
    await need(s, ctx, 'admin')
    const before = (await listReference(db(), ctx.params.kind)).find((r) => r.id === ctx.params.id) ?? null
    const row = await guarded(() => saveReference(db(), ctx.params.kind, ctx.params.id, bodyOf(ctx), ctx.user!.user.id))
    await audit(s, ctx, 'accounts.reference.change', { kind: ctx.params.kind, before, after: row }, row.id)
    return { item: row }
  }, { auth: 'user' })
  router.add('DELETE', '/accounts/reference/:kind/:id', async (ctx) => {
    await need(s, ctx, 'admin')
    const row = await removeReference(db(), ctx.params.kind, ctx.params.id)
    await audit(s, ctx, 'accounts.reference.remove', { kind: ctx.params.kind, row }, row.id)
    return { ok: true }
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- parties, items, series */

  router.add('GET', '/accounts/parties', async (ctx) => { await need(s, ctx, 'view'); return { items: await listParties(db()) } }, { auth: 'user' })
  router.add('POST', '/accounts/parties', async (ctx) => {
    await need(s, ctx, 'post')
    const item = await saveParty(db(), null, bodyOf(ctx))
    await audit(s, ctx, 'accounts.party.add', { name: item.name, gstin: item.gstin, regType: item.regType }, item.id)
    return { item }
  }, { auth: 'user' })
  router.add('PATCH', '/accounts/parties/:id', async (ctx) => {
    await need(s, ctx, 'post')
    const item = await saveParty(db(), ctx.params.id, bodyOf(ctx))
    await audit(s, ctx, 'accounts.party.change', { name: item.name, gstin: item.gstin, regType: item.regType, stateCode: item.stateCode }, item.id)
    return { item }
  }, { auth: 'user' })
  router.add('GET', '/accounts/items', async (ctx) => { await need(s, ctx, 'view'); return { items: await listItems(db()) } }, { auth: 'user' })
  router.add('POST', '/accounts/items', async (ctx) => {
    await need(s, ctx, 'post')
    const item = await saveItem(db(), null, bodyOf(ctx))
    await audit(s, ctx, 'accounts.item.add', { name: item.name, hsn: item.hsn, rateCode: item.rateCode, supplyClass: item.supplyClass }, item.id)
    return { item }
  }, { auth: 'user' })
  router.add('PATCH', '/accounts/items/:id', async (ctx) => {
    await need(s, ctx, 'post')
    const item = await saveItem(db(), ctx.params.id, bodyOf(ctx))
    await audit(s, ctx, 'accounts.item.change', { name: item.name, hsn: item.hsn, rateCode: item.rateCode, supplyClass: item.supplyClass }, item.id)
    return { item }
  }, { auth: 'user' })
  router.add('GET', '/accounts/series', async (ctx) => { await need(s, ctx, 'view'); return { items: await listSeries(db()) } }, { auth: 'user' })
  router.add('POST', '/accounts/series', async (ctx) => {
    await need(s, ctx, 'admin')
    const item = await saveSeries(db(), null, bodyOf(ctx))
    await audit(s, ctx, 'accounts.series.add', item, item.id)
    return { item }
  }, { auth: 'user' })
  router.add('PATCH', '/accounts/series/:id', async (ctx) => {
    await need(s, ctx, 'admin')
    const item = await saveSeries(db(), ctx.params.id, bodyOf(ctx))
    await audit(s, ctx, 'accounts.series.change', item, item.id)
    return { item }
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- chart, years, periods */

  router.add('GET', '/accounts/chart', async (ctx) => { await need(s, ctx, 'view'); return { items: await listAccounts(db()) } }, { auth: 'user' })
  router.add('POST', '/accounts/chart', async (ctx) => {
    await need(s, ctx, 'admin')
    const b = bodyOf(ctx)
    const item = await createAccount(db(), { code: requiredText(b.code, 20, 'Code', 'code'), name: requiredText(b.name, 120, 'Name', 'name'), kind: oneOf(b.kind, ACCOUNT_KINDS, 'Kind', 'kind') })
    await audit(s, ctx, 'accounts.chart.add', item, item.id)
    return { item }
  }, { auth: 'user' })
  router.add('PATCH', '/accounts/chart/:id', async (ctx) => {
    await need(s, ctx, 'admin')
    const b = bodyOf(ctx)
    const item = await updateAccount(db(), ctx.params.id, { ...(b.name !== undefined ? { name: requiredText(b.name, 120, 'Name', 'name') } : {}), ...(b.code !== undefined ? { code: requiredText(b.code, 20, 'Code', 'code') } : {}), ...(b.active !== undefined ? { active: b.active !== false } : {}) })
    await audit(s, ctx, 'accounts.chart.change', item, item.id)
    return { item }
  }, { auth: 'user' })

  router.add('GET', '/accounts/years', async (ctx) => { await need(s, ctx, 'view'); return { items: await listYears(db()) } }, { auth: 'user' })
  router.add('POST', '/accounts/years', async (ctx) => {
    await need(s, ctx, 'admin')
    const date = dateOf(bodyOf(ctx).date, 'A date inside the financial year', 'date')
    // G9.9: the first month of the financial year is data
    const startMonth = (await thresholdsOn(db(), date)).requiredInt('financial_year_start_month')
    if (startMonth < 1 || startMonth > 12) throw invalid('The value financial_year_start_month must be 1 to 12.')
    const year = await createYear(db(), date, startMonth)
    await audit(s, ctx, 'accounts.year.add', { name: year.name, start: year.start, end: year.end }, year.id)
    return { item: year }
  }, { auth: 'user' })
  router.add('POST', '/accounts/periods/:id/lock', async (ctx) => {
    await need(s, ctx, 'admin')
    const state = oneOf(bodyOf(ctx).state, ['soft_locked', 'locked'], 'state', 'state')
    const years = await listYears(db())
    const cur = years.flatMap((y) => y.periods).find((p) => p.id === ctx.params.id)
    if (!cur) throw notFound('Period')
    if (cur.state === 'locked') throw conflict('This period is locked already.')
    if (cur.state === state) throw conflict('This period is soft-locked already.')
    const r = await setPeriodState(db(), ctx.params.id, state, ctx.user!.user.id, text(bodyOf(ctx).reason, 300) || null)
    await audit(s, ctx, 'accounts.period.lock', { period: r.after.start, from: r.before.state, to: r.after.state }, r.after.id)
    return { item: r.after }
  }, { auth: 'user' })
  router.add('POST', '/accounts/periods/:id/unlock', async (ctx) => {
    await need(s, ctx, 'admin')
    const reason = requiredText(bodyOf(ctx).reason, 300, 'A reason', 'reason')
    const cur = (await listYears(db())).flatMap((y) => y.periods).find((p) => p.id === ctx.params.id)
    if (!cur) throw notFound('Period')
    if (cur.state === 'open') throw conflict('This period is open already.')
    // G9.10: a hard lock is reversed only by an install administrator, with a typed reason
    if (cur.state === 'locked' && ctx.user!.user.isInstallAdmin !== true) throw new HttpError(403, 'denied', 'Only an install administrator can unlock a locked period.')
    const r = await setPeriodState(db(), ctx.params.id, 'open', ctx.user!.user.id, reason)
    await audit(s, ctx, 'accounts.period.unlock', { period: r.after.start, from: r.before.state, reason }, r.after.id)
    return { item: r.after }
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- journals, ledger, reports */

  router.add('GET', '/accounts/journals', async (ctx) => {
    await need(s, ctx, 'view')
    return listJournals(db(), { from: qDate(ctx, 'from'), to: qDate(ctx, 'to'), ...paging(ctx) })
  }, { auth: 'user' })
  router.add('GET', '/accounts/journals/:id', async (ctx) => {
    await need(s, ctx, 'view')
    const j = await getJournal(db(), ctx.params.id)
    if (!j) throw notFound('Journal')
    return { journal: j }
  }, { auth: 'user' })
  router.add('POST', '/accounts/journals', async (ctx) => {
    const level = await need(s, ctx, 'post')
    const b = bodyOf(ctx)
    if (!Array.isArray(b.lines)) throw invalid('lines is a list of { accountId, debit or credit, memo? }.', 'lines')
    const lines = await guarded(async () => (b.lines as unknown[]).slice(0, 501).map((x, i) => {
      const o = isObj(x) ? x : {}
      const amt = (v: unknown, what: string) => (v === undefined || v === null || v === '' ? 0 : paise(v, `Line ${i + 1}: ${what}`))
      return { accountId: text(o.accountId, 80), partyId: text(o.partyId, 80) || null, debit: amt(o.debit, 'debit'), credit: amt(o.credit, 'credit'), memo: text(o.memo, 300) }
    }))
    const journal = await postJournal(db(), { date: dateOf(b.date, 'Date', 'date'), narration: requiredText(b.narration, 500, 'A narration', 'narration'), lines }, who(ctx, level))
    await audit(s, ctx, 'accounts.journal.post', { number: journal.number, date: journal.date, total: rupees(journal.total), lines: journal.lines.length }, journal.id)
    return { journal }
  }, { auth: 'user' })
  router.add('POST', '/accounts/journals/:id/reverse', async (ctx) => {
    const level = await need(s, ctx, 'post')
    const b = bodyOf(ctx)
    const journal = await reverseJournal(db(), ctx.params.id, { date: dateOf(b.date ?? today(), 'Date', 'date'), reason: requiredText(b.reason, 300, 'A reason', 'reason') }, who(ctx, level))
    await audit(s, ctx, 'accounts.journal.reverse', { number: journal.number, reverses: ctx.params.id, date: journal.date }, journal.id)
    return { journal }
  }, { auth: 'user' })

  router.add('GET', '/accounts/ledger', async (ctx) => {
    await need(s, ctx, 'view')
    const account = ctx.query.get('account')
    if (!account) throw invalid('account is required.', 'account')
    const r = await accountLedger(db(), account, qDate(ctx, 'from'), qDate(ctx, 'to') ?? today(), ctx.query.get('party'))
    if (!wantsCsv(ctx)) return r
    return csvResponse(`ledger-${r.account.code}`, toCsv(['Date', 'Journal', 'Narration', 'Memo', 'Debit', 'Credit', 'Balance'],
      [['', '', 'Opening balance', '', '', '', rupees(r.opening)], ...r.entries.map((e) => [e.date, e.number, e.narration, e.memo, e.debit ? rupees(e.debit) : '', e.credit ? rupees(e.credit) : '', rupees(e.balance)])]))
  }, { auth: 'user' })

  router.add('GET', '/accounts/reports/trial-balance', async (ctx) => {
    await need(s, ctx, 'view')
    const r = await trialBalance(db(), qDate(ctx, 'from'), qDate(ctx, 'to') ?? today())
    if (!wantsCsv(ctx)) return { ...r, balanced: r.totals.debit === r.totals.credit && r.totals.closingDebit === r.totals.closingCredit }
    return csvResponse(`trial-balance-${r.to}`, toCsv(['Code', 'Account', 'Kind', 'Opening', 'Debit', 'Credit', 'Closing debit', 'Closing credit'],
      [...r.rows.map((x) => [x.code, x.name, x.kind, rupees(x.opening), rupees(x.debit), rupees(x.credit), x.closing >= 0 ? rupees(x.closing) : '', x.closing < 0 ? rupees(-x.closing) : '']),
        ['', 'Total', '', '', rupees(r.totals.debit), rupees(r.totals.credit), rupees(r.totals.closingDebit), rupees(r.totals.closingCredit)]]))
  }, { auth: 'user' })
  router.add('GET', '/accounts/reports/profit-loss', async (ctx) => {
    await need(s, ctx, 'view')
    const r = await profitAndLoss(db(), qDate(ctx, 'from', true)!, qDate(ctx, 'to') ?? today())
    if (!wantsCsv(ctx)) return r
    return csvResponse(`profit-and-loss-${r.from}-${r.to}`, toCsv(['Section', 'Code', 'Account', 'Amount'], [
      ...r.income.map((x) => ['Income', x.code, x.name, rupees(x.amount)]), ['Income', '', 'Total income', rupees(r.totalIncome)],
      ...r.expense.map((x) => ['Expense', x.code, x.name, rupees(x.amount)]), ['Expense', '', 'Total expense', rupees(r.totalExpense)], ['', '', 'Profit (income less expense)', rupees(r.profit)]]))
  }, { auth: 'user' })
  router.add('GET', '/accounts/reports/balance-sheet', async (ctx) => {
    await need(s, ctx, 'view')
    const r = await balanceSheet(db(), qDate(ctx, 'asOf') ?? today())
    if (!wantsCsv(ctx)) return r
    return csvResponse(`balance-sheet-${r.asOf}`, toCsv(['Section', 'Code', 'Account', 'Amount'], [
      ...r.assets.map((x) => ['Assets', x.code, x.name, rupees(x.amount)]), ['Assets', '', 'Total assets', rupees(r.totalAssets)],
      ...r.liabilities.map((x) => ['Liabilities', x.code, x.name, rupees(x.amount)]), ['Liabilities', '', 'Total liabilities', rupees(r.totalLiabilities)],
      ...r.equity.map((x) => ['Equity', x.code, x.name, rupees(x.amount)]), ['Equity', '', 'Profit to date, not closed', rupees(r.profitToDate)], ['Equity', '', 'Total equity', rupees(r.totalEquity)]]))
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- documents */

  router.add('GET', '/accounts/documents', async (ctx) => {
    await need(s, ctx, 'view')
    return listDocuments(db(), { docType: ctx.query.get('type'), state: ctx.query.get('state'), from: qDate(ctx, 'from'), to: qDate(ctx, 'to'), ...paging(ctx) })
  }, { auth: 'user' })
  router.add('GET', '/accounts/documents/:id', async (ctx) => {
    await need(s, ctx, 'view')
    const doc = await getDocument(db(), ctx.params.id)
    if (!doc) throw notFound('Document')
    return { document: doc }
  }, { auth: 'user' })
  router.add('POST', '/accounts/documents', async (ctx) => {
    const level = await need(s, ctx, 'post')
    const doc = await createDraft(db(), readDocInput(bodyOf(ctx)), who(ctx, level))
    await audit(s, ctx, 'accounts.document.draft', { docType: doc.docType, date: doc.date }, doc.id)
    return { document: doc }
  }, { auth: 'user' })
  router.add('PATCH', '/accounts/documents/:id', async (ctx) => {
    await need(s, ctx, 'post')
    return { document: await updateDraft(db(), ctx.params.id, bodyOf(ctx)) }
  }, { auth: 'user' })
  router.add('DELETE', '/accounts/documents/:id', async (ctx) => {
    await need(s, ctx, 'post')
    await deleteDraft(db(), ctx.params.id)
    await audit(s, ctx, 'accounts.document.draft-delete', {}, ctx.params.id)
    return { ok: true }
  }, { auth: 'user' })
  router.add('POST', '/accounts/documents/:id/issue', async (ctx) => {
    const level = await need(s, ctx, 'post')
    const doc = await guarded(() => issueDocument(db(), ctx.params.id, who(ctx, level)))
    await audit(s, ctx, 'accounts.document.issue', { docType: doc.docType, number: doc.number, date: doc.date, total: rupees(doc.totals.total), placeOfSupply: doc.placeOfSupply, rule: doc.snapshot?.rule, journal: doc.journalId, manualPlaceOfSupply: doc.snapshot?.rule === 'manual' ? doc.input.supply.manualReason : undefined }, doc.id)
    return { document: doc }
  }, { auth: 'user' })
  router.add('POST', '/accounts/documents/:id/cancel', async (ctx) => {
    const level = await need(s, ctx, 'post')
    const b = bodyOf(ctx)
    const doc = await cancelDocument(db(), ctx.params.id, { date: optionalDate(b.date, 'Date', 'date') ?? today(), reason: text(b.reason, 300) }, who(ctx, level))
    await audit(s, ctx, 'accounts.document.cancel', { docType: doc.docType, number: doc.number, reason: doc.cancelReason, journal: doc.cancelJournalId }, doc.id)
    return { document: doc }
  }, { auth: 'user' })
  router.add('POST', '/accounts/documents/:id/record', async (ctx) => {
    await need(s, ctx, 'post')
    const r = await recordOnIssued(db(), ctx.params.id, bodyOf(ctx))
    await audit(s, ctx, 'accounts.document.record', { number: r.doc.number, changed: r.changed }, r.doc.id)
    return { document: r.doc }
  }, { auth: 'user' })
  router.add('GET', '/accounts/documents/:id/pdf', async (ctx) => {
    await need(s, ctx, 'view')
    const doc = await getDocument(db(), ctx.params.id, false)
    if (!doc) throw notFound('Document')
    if (doc.state === 'draft') throw invalid('A draft has no number yet: issue it first, then print it.')
    if (!(PRINTABLE as readonly string[]).includes(doc.docType)) throw invalid(`There is no print layout for a ${doc.title.toLowerCase()} in this version.`)
    const bytes = await documentPdf(doc, (await thresholdsOn(db(), doc.date)).text('other_country_code') ?? '')
    return { raw: true as const, status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${(doc.number ?? 'document').replace(/[^A-Za-z0-9._-]/g, '-')}.pdf"`, 'Cache-Control': 'no-store' }, body: bytes }
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- return summaries (data and CSV only) */

  router.add('GET', '/accounts/returns', async (ctx) => {
    await need(s, ctx, 'view')
    return { items: Object.entries(RETURN_SUMMARIES).map(([name, title]) => ({ name, title })), notice: 'These are summaries for your accountant. Appbuilder does not prepare, check or file any return.' }
  }, { auth: 'user' })
  router.add('GET', '/accounts/returns/:name', async (ctx) => {
    await need(s, ctx, 'view')
    const r = await returnSummary(db(), ctx.params.name, qDate(ctx, 'from', true)!, qDate(ctx, 'to', true)!)
    return wantsCsv(ctx) ? csvResponse(`${r.name}-${r.from}-${r.to}`, toCsv(r.columns, r.rows)) : r
  }, { auth: 'user' })
}
