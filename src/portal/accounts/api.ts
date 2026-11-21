/**
 * Server calls of the Accounts area (P3 package L: ledgers and India GST; server/core/ledger/routes.ts). Server mode
 * only. Amounts from the server are integer paise; amounts sent are decimal rupees as text. Nothing is computed in the
 * browser: every figure shown comes from the server.
 */
import { API_BASE } from '@/platform/http'
import { withEnvironment } from '@/platform/environments'
import { idCall } from '../identityApi'

export type Level = 'none' | 'view' | 'post' | 'admin'
export type DocType = 'tax_invoice' | 'bill_of_supply' | 'credit_note' | 'debit_note' | 'receipt_voucher' | 'refund_voucher' | 'payment_voucher' | 'purchase_invoice'

export interface Business {
  gstin: string; legalName: string; tradeName: string; address: string; stateCode: string; regType: string; effectiveFrom: string | null; pan: string; phone: string; email: string
  turnovers: Record<string, string>; luts: { fy: string; reference: string; filedOn: string | null }[]; composition: { category: string; from: string } | null
  settings: { taxMode: 'line' | 'document'; roundOff: boolean; manualPlaceOfSupply: boolean }; footer: string
}
export interface AccountsState {
  level: Level; notice: string; business?: Business | null; isInstallAdmin?: boolean
  setup?: { business: boolean; chart: boolean; years: number; series: boolean; states: number; rates: number; thresholds: number }
  docTypes?: { type: DocType; title: string; printable: boolean }[]
}
export interface Account { id: string; code: string; name: string; kind: string; systemKey: string | null; active: boolean }
export interface Period { id: string; start: string; end: string; state: 'open' | 'soft_locked' | 'locked'; reason: string | null; changedOn: string | null }
export interface Year { id: string; name: string; start: string; end: string; periods: Period[] }
export interface JournalLine { lineNo: number; accountId: string; accountCode: string; accountName: string; partyId: string | null; debit: number; credit: number; memo: string }
export interface Journal { id: string; number: number; date: string; narration: string; sourceKind: string; sourceId: string | null; reverses: string | null; reversedBy: string | null; total: number; lines: JournalLine[] }
export interface Party { id: string; role: 'customer' | 'supplier' | 'both'; name: string; gstin: string; regType: string; stateCode: string; country: string; address: string; pan: string; active: boolean }
export interface Item { id: string; name: string; kind: 'goods' | 'service'; hsn: string; uqc: string; rateCode: string; rateCondition: string; supplyClass: string; posCategory: string; rcmCategory: string; itcDefault: string; unitPrice: string | null; expenseAccount: string | null; active: boolean }
export interface Series { id: string; docType: DocType; name: string; prefix: string; suffix: string; padding: number; isDefault: boolean; active: boolean }
export type RefRow = Record<string, string | boolean | null> & { id: string; effectiveFrom: string; effectiveTo: string | null; source: string; approvedBy: string; approvedOn: string | null }
export interface Totals { taxable: number; cgst: number; sgst: number; igst: number; cess: number; roundOff: number; total: number }
export interface DocLine {
  itemId: string | null; description: string; kind: string; hsn: string; uqc: string; quantity: string; unitPrice: string; supplyClass: string; gross: number; discount: number; charges: number; taxable: number
  igstRate: string; cgstRate: string; sgstRate: string; cessRate: string; cgst: number; sgst: number; igst: number; cess: number; taxed: boolean; reverseCharge: boolean; itc: string; itcReason: string
}
export interface DocInput {
  docType: DocType; date: string; partyId: string | null; seriesId: string | null
  lines: { itemId: string; description: string; quantity: string; unitPrice: string; discountPercent: string | null; discountAmount: string | null; itc: string | null; itcReason: string; reverseCharge: boolean; accountId: string | null }[]
  charges: { description: string; amount: string; line: number | null }[]; documentDiscount: string | null; taxInclusive: boolean
  supply: { shipToAddress: string; shipToState: string; shipToCountry: string; billToShipTo: boolean; goodsMove: 'yes' | 'no' | 'unknown'; installedAtSite: boolean; siteState: string; addressRecorded: boolean; zeroRated: 'lut' | 'with_payment' | null; exportConditionsConfirmed: boolean; continuousSupply: boolean; saleOnApproval: boolean; onBoardConveyance: boolean; importOrBonded: boolean; manualState: string; manualReason: string }
  originalId: string | null; reason: string; itcReversalConfirmed: 'yes' | 'no' | 'na' | null; rateDateConfirmed: boolean; supplierInvoiceNo: string; supplierInvoiceDate: string | null
  inwardTax: 'intra' | 'inter' | 'none' | null; roundOffAmount: string | null; moneyAccount: 'bank' | 'cash'; amount: string | null; notes: string
}
export interface DocSummary {
  id: string; docType: DocType; title: string; state: 'draft' | 'issued' | 'cancelled'; number: string | null; fy: string | null; date: string; partyId: string | null; partyName: string; placeOfSupply: string | null
  taxKind: string | null; supplyType: string | null; originalId: string | null; reason: string; totals: Totals; journalId: string | null; cancelReason: string | null
  irn: string | null; irnAckNo: string | null; irnAckDate: string | null; irnQr: string | null; ewayNo: string | null; ewayDate: string | null; ewayValidUntil: string | null; vehicleNo: string | null; transporterId: string | null
  notes: string; paymentStatus: string
}
export interface Doc extends DocSummary {
  input: DocInput; lines: DocLine[]; problem?: string | null
  snapshot: { rule: string; placeOfSupplyName: string; utgst: boolean; zeroRated: string | null; consignmentValue: number; ewayRequired: boolean; irnRequired: boolean; warnings: string[]; original: { number: string; date: string } | null } | null
}
export interface TrialBalance { from: string | null; to: string; balanced: boolean; rows: { accountId: string; code: string; name: string; kind: string; opening: number; debit: number; credit: number; closing: number }[]; totals: { debit: number; credit: number; closingDebit: number; closingCredit: number } }
export interface StatementRow { accountId: string; code: string; name: string; amount: number }
export interface ProfitLoss { from: string; to: string; income: StatementRow[]; expense: StatementRow[]; totalIncome: number; totalExpense: number; profit: number }
export interface BalanceSheet { asOf: string; assets: StatementRow[]; liabilities: StatementRow[]; equity: StatementRow[]; totalAssets: number; totalLiabilities: number; totalEquity: number; profitToDate: number; balanced: boolean }
export interface LedgerView { account: Account; opening: number; closing: number; truncated: boolean; entries: { journalId: string; number: number; date: string; narration: string; memo: string; debit: number; credit: number; balance: number }[] }
export interface Summary { name: string; title: string; from: string; to: string; columns: string[]; rows: (string | number)[][]; notes: string[] }

const q = (o: Record<string, string | null | undefined>): string => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const accountsApi = {
  state: () => idCall<AccountsState>('GET', '/accounts/state'),
  saveBusiness: (b: Partial<Business>) => idCall<{ business: Business }>('PUT', '/accounts/business', b),
  access: () => idCall<{ roles: { id: string; name: string; level: Level; fixed: boolean }[] }>('GET', '/accounts/access'),
  saveAccess: (access: Record<string, Level>) => idCall<unknown>('PUT', '/accounts/access', { access }),
  accountantRole: () => idCall<{ role: { id: string; name: string } }>('POST', '/accounts/access/accountant-role', {}),
  setup: () => idCall<{ added: { accounts: number; series: number } }>('POST', '/accounts/setup', {}),
  examples: () => idCall<{ added: { states: number; values: number } }>('POST', '/accounts/reference/examples', {}),
  reference: (kind: string) => idCall<{ items: RefRow[] }>('GET', `/accounts/reference/${kind}`),
  saveReference: (kind: string, id: string | null, row: Record<string, unknown>) => idCall<{ item: RefRow }>(id ? 'PATCH' : 'POST', `/accounts/reference/${kind}${id ? `/${id}` : ''}`, row),
  removeReference: (kind: string, id: string) => idCall<unknown>('DELETE', `/accounts/reference/${kind}/${id}`),
  parties: () => idCall<{ items: Party[] }>('GET', '/accounts/parties'),
  saveParty: (id: string | null, p: Record<string, unknown>) => idCall<{ item: Party }>(id ? 'PATCH' : 'POST', `/accounts/parties${id ? `/${id}` : ''}`, p),
  items: () => idCall<{ items: Item[] }>('GET', '/accounts/items'),
  saveItem: (id: string | null, p: Record<string, unknown>) => idCall<{ item: Item }>(id ? 'PATCH' : 'POST', `/accounts/items${id ? `/${id}` : ''}`, p),
  series: () => idCall<{ items: Series[] }>('GET', '/accounts/series'),
  saveSeries: (id: string | null, p: Record<string, unknown>) => idCall<{ item: Series }>(id ? 'PATCH' : 'POST', `/accounts/series${id ? `/${id}` : ''}`, p),
  chart: () => idCall<{ items: Account[] }>('GET', '/accounts/chart'),
  addAccount: (a: { code: string; name: string; kind: string }) => idCall<{ item: Account }>('POST', '/accounts/chart', a),
  saveAccount: (id: string, a: Partial<Account>) => idCall<{ item: Account }>('PATCH', `/accounts/chart/${id}`, a),
  years: () => idCall<{ items: Year[] }>('GET', '/accounts/years'),
  addYear: (date: string) => idCall<{ item: Year }>('POST', '/accounts/years', { date }),
  lockPeriod: (id: string, state: 'soft_locked' | 'locked') => idCall<{ item: Period }>('POST', `/accounts/periods/${id}/lock`, { state }),
  unlockPeriod: (id: string, reason: string) => idCall<{ item: Period }>('POST', `/accounts/periods/${id}/unlock`, { reason }),
  journals: (from?: string, to?: string) => idCall<{ items: Journal[]; total: number }>('GET', `/accounts/journals${q({ from, to })}`),
  journal: (id: string) => idCall<{ journal: Journal }>('GET', `/accounts/journals/${id}`),
  postJournal: (j: { date: string; narration: string; lines: { accountId: string; debit?: string; credit?: string; memo?: string }[] }) => idCall<{ journal: Journal }>('POST', '/accounts/journals', j),
  reverseJournal: (id: string, date: string, reason: string) => idCall<{ journal: Journal }>('POST', `/accounts/journals/${id}/reverse`, { date, reason }),
  ledger: (account: string, from: string, to: string) => idCall<LedgerView>('GET', `/accounts/ledger${q({ account, from, to })}`),
  trialBalance: (from: string, to: string) => idCall<TrialBalance>('GET', `/accounts/reports/trial-balance${q({ from, to })}`),
  profitLoss: (from: string, to: string) => idCall<ProfitLoss>('GET', `/accounts/reports/profit-loss${q({ from, to })}`),
  balanceSheet: (asOf: string) => idCall<BalanceSheet>('GET', `/accounts/reports/balance-sheet${q({ asOf })}`),
  documents: (type?: string, state?: string) => idCall<{ items: DocSummary[]; total: number }>('GET', `/accounts/documents${q({ type, state, limit: '200' })}`),
  document: (id: string) => idCall<{ document: Doc }>('GET', `/accounts/documents/${id}`),
  createDocument: (d: Record<string, unknown>) => idCall<{ document: Doc }>('POST', '/accounts/documents', d),
  saveDocument: (id: string, d: Record<string, unknown>) => idCall<{ document: Doc }>('PATCH', `/accounts/documents/${id}`, d),
  deleteDocument: (id: string) => idCall<unknown>('DELETE', `/accounts/documents/${id}`),
  issue: (id: string) => idCall<{ document: Doc }>('POST', `/accounts/documents/${id}/issue`, {}),
  cancel: (id: string, reason: string) => idCall<{ document: Doc }>('POST', `/accounts/documents/${id}/cancel`, { reason }),
  record: (id: string, b: Record<string, unknown>) => idCall<{ document: Doc }>('POST', `/accounts/documents/${id}/record`, b),
  returns: () => idCall<{ items: { name: string; title: string }[]; notice: string }>('GET', '/accounts/returns'),
  returnSummary: (name: string, from: string, to: string) => idCall<Summary>('GET', `/accounts/returns/${name}${q({ from, to })}`),
}

/** a GET address that opens in a new tab or downloads (the PDF of a document, a CSV export) */
export const downloadUrl = (path: string, params: Record<string, string | null | undefined> = {}): string => withEnvironment(`${API_BASE}${path}${q(params)}`)

/** paise -> "1,00,000.00" (Indian digit grouping), with whole-number arithmetic only */
export function inr(p: number): string {
  const a = Math.abs(Math.trunc(p))
  const int = String(Math.floor(a / 100))
  const head = int.length > 3 ? int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : ''
  return `${p < 0 ? '-' : ''}${head}${int.slice(-3)}.${String(a % 100).padStart(2, '0')}`
}
export const today = (): string => new Date().toISOString().slice(0, 10)
export const PERIOD_STATE: Record<Period['state'], string> = { open: 'Open', soft_locked: 'Soft-locked', locked: 'Locked' }
export const DOC_STATE: Record<DocSummary['state'], string> = { draft: 'Draft', issued: 'Issued', cancelled: 'Cancelled' }
