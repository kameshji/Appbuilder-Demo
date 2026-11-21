/**
 * Return summaries as DATA and CSV (docs/plan/gst-spec-draft.md section 10). The software does NOT prepare, validate or
 * file any return and has no connection to any portal (G10.1): these are registers and totals the business's accountant
 * reads. The column sets follow the draft's table G10.2, which itself is unverified against the notified forms.
 *
 * Sign convention in the aggregated summaries (B2C others, HSN, nil / exempt, the GSTR-3B helper, composition): a credit
 * note subtracts, a debit note adds. Registers list each document with positive amounts and its type (G5.13).
 * Cancelled documents appear in the registers and the documents-issued summary with their status, and count as zero
 * elsewhere (G7.9).
 */
import type { SqlDb } from '../contracts.ts'
import { T, notFound } from '../ledger/core.ts'
import { rupees, type Paise } from './money.ts'
import { compositionTax, DOC_TITLES, type DocType } from './engine.ts'
import { getBusiness, thresholdsOn } from './reference.ts'

export const RETURN_SUMMARIES: Record<string, string> = {
  'outward-register': 'Outward register (one row per document line)',
  b2b: 'B2B summary per document',
  'b2c-large': 'B2C large inter-State invoices',
  'b2c-others': 'B2C others, aggregated',
  notes: 'Credit and debit notes',
  exports: 'Exports and SEZ',
  'nil-exempt': 'Nil-rated, exempt and non-GST',
  advances: 'Advances',
  hsn: 'HSN summary',
  'documents-issued': 'Documents issued',
  'inward-register': 'Inward register',
  'gstr3b-helper': 'GSTR-3B helper',
  'composition-helper': 'Composition helper',
}
export interface Summary { name: string; title: string; from: string; to: string; columns: string[]; rows: (string | number)[][]; notes: string[] }

interface L {
  id: string; docType: DocType; state: string; number: string; date: string; fy: string; seriesId: string; pos: string; taxKind: string; supplyType: string; total: Paise; reason: string
  irn: string; irnAckDate: string; ewayNo: string; originalId: string; snap: Record<string, any>; input: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  lineNo: number; description: string; kind: string; hsn: string; uqc: string; quantity: string; supplyClass: string; taxable: Paise; igstRate: string; cgst: Paise; sgst: Paise; igst: Paise; cess: Paise
  taxed: boolean; reverseCharge: boolean; itc: string; itcReason: string
}
const n = (v: unknown): number => Number(v ?? 0)
const rate = (v: unknown): string => String(Number(v ?? 0))

async function fetchLines(db: SqlDb, from: string, to: string): Promise<L[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT d.id, d.doc_type, d.state, d.number, d.date, d.fy, d.series_id, d.place_of_supply, d.tax_kind, d.supply_type, d.total, d.reason, d.irn, d.irn_ack_date, d.eway_no, d.original_id, d.snapshot, d.input,
            l.line_no, l.description, l.kind, l.hsn, l.uqc, l.quantity, l.supply_class, l.taxable, l.igst_rate, l.cgst, l.sgst, l.igst, l.cess, l.taxed, l.reverse_charge, l.itc, l.itc_reason
       FROM ${T('ab_gst_documents')} d LEFT JOIN ${T('ab_gst_document_lines')} l ON l.document_id = d.id
      WHERE d.state <> 'draft' AND d.date >= $1::date AND d.date <= $2::date ORDER BY d.date, d.number, l.line_no`, [from, to])
  return rows.map((r) => ({
    id: String(r.id), docType: r.doc_type as DocType, state: String(r.state), number: String(r.number ?? ''), date: String(r.date), fy: String(r.fy ?? ''), seriesId: String(r.series_id ?? ''), pos: String(r.place_of_supply ?? ''),
    taxKind: String(r.tax_kind ?? ''), supplyType: String(r.supply_type ?? ''), total: n(r.total), reason: String(r.reason ?? ''), irn: String(r.irn ?? ''), irnAckDate: String(r.irn_ack_date ?? ''), ewayNo: String(r.eway_no ?? ''),
    originalId: String(r.original_id ?? ''), snap: (r.snapshot as Record<string, unknown>) ?? {}, input: (r.input as Record<string, unknown>) ?? {},
    lineNo: n(r.line_no), description: String(r.description ?? ''), kind: String(r.kind ?? ''), hsn: String(r.hsn ?? ''), uqc: String(r.uqc ?? ''), quantity: String(Number(r.quantity ?? 0)), supplyClass: String(r.supply_class ?? ''),
    taxable: n(r.taxable), igstRate: rate(r.igst_rate), cgst: n(r.cgst), sgst: n(r.sgst), igst: n(r.igst), cess: n(r.cess), taxed: r.taxed === true, reverseCharge: r.reverse_charge === true, itc: String(r.itc ?? ''), itcReason: String(r.itc_reason ?? ''),
  }))
}

const OUT: DocType[] = ['tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note']
const sign = (l: L): number => (l.docType === 'credit_note' || l.docType === 'refund_voucher' ? -1 : 1)
const gstin = (l: L): string => l.snap.party?.gstin || 'unregistered'
const amounts = (a: { taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise; cess: Paise }): string[] => [rupees(a.taxable), rupees(a.igst), rupees(a.cgst), rupees(a.sgst), rupees(a.cess)]
const AMOUNT_COLS = ['Taxable value', 'IGST', 'CGST', 'SGST/UTGST', 'Cess']
interface Acc { taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise; cess: Paise; qty: number }
const zero = (): Acc => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, qty: 0 })
function add(a: Acc, l: L, s = 1): Acc {
  a.taxable += s * l.taxable; a.igst += s * l.igst; a.cgst += s * l.cgst; a.sgst += s * l.sgst; a.cess += s * l.cess; a.qty += s * Number(l.quantity)
  return a
}
/** groups lines by a key, keeping the first line of each group for its labels */
function group(lines: L[], key: (l: L) => string, signed = false): { first: L; acc: Acc }[] {
  const m = new Map<string, { first: L; acc: Acc }>()
  for (const l of lines) {
    const k = key(l)
    if (!m.has(k)) m.set(k, { first: l, acc: zero() })
    add(m.get(k)!.acc, l, signed ? sign(l) : 1)
  }
  return [...m.values()]
}

export async function returnSummary(db: SqlDb, name: string, from: string, to: string): Promise<Summary> {
  const title = RETURN_SUMMARIES[name]
  if (!title) throw notFound('Summary')
  const all = (await fetchLines(db, from, to)).filter((l) => l.lineNo > 0 || l.docType === 'payment_voucher')
  const live = all.filter((l) => l.state === 'issued')
  const out = live.filter((l) => OUT.includes(l.docType))
  const notes: string[] = []
  const done = (columns: string[], rows: (string | number)[][]): Summary => ({ name, title, from, to, columns, rows, notes })
  const business = await getBusiness(db)
  const th = await thresholdsOn(db, to)
  const large = th.money('b2c_large_value')
  const isLarge = (l: L): boolean => large !== null && l.docType === 'tax_invoice' && l.supplyType === 'B2C' && l.taxKind === 'inter' && l.total > large

  switch (name) {
    case 'outward-register':
      return done(
        ['Document type', 'Number', 'Date', 'Status', 'Recipient GSTIN', 'Recipient name', 'Recipient State code', 'Place of supply', 'Supply type', 'Reverse charge', 'HSN/SAC', 'Description', 'UQC', 'Quantity', 'Taxable value', 'Rate', 'IGST', 'CGST', 'SGST/UTGST', 'Cess', 'Supply class', 'IRN', 'IRN date', 'E-way bill no.', 'Original number', 'Original date'],
        all.filter((l) => OUT.includes(l.docType)).map((l) => [DOC_TITLES[l.docType], l.number, l.date, l.state, gstin(l), l.snap.party?.name ?? '', l.snap.party?.stateCode ?? '', l.pos, l.supplyType, 'N', l.hsn, l.description, l.uqc, l.quantity,
          rupees(l.taxable), l.taxed ? l.igstRate : '0', rupees(l.igst), rupees(l.cgst), rupees(l.sgst), rupees(l.cess), l.snap.zeroRated ? 'zero-rated' : l.supplyClass, l.irn, l.irnAckDate, l.ewayNo, l.snap.original?.number ?? '', l.snap.original?.date ?? '']))
    case 'b2b':
      return done(['Recipient GSTIN', 'Document number', 'Date', 'Document value', 'Place of supply', 'Reverse charge', 'Invoice type', 'Rate', ...AMOUNT_COLS],
        group(out.filter((l) => (l.docType === 'tax_invoice' || l.docType === 'bill_of_supply') && ['B2B', 'SEZWP', 'SEZWOP'].includes(l.supplyType)), (l) => `${l.id}|${l.taxed ? l.igstRate : '0'}`)
          .map(({ first: l, acc }) => [gstin(l), l.number, l.date, rupees(l.total), l.pos, 'N', l.supplyType, l.taxed ? l.igstRate : '0', ...amounts(acc)]))
    case 'b2c-large':
      if (large === null) notes.push('The value "b2c_large_value" is not set in the reference data, so no invoice counts as large.')
      return done(['Document number', 'Date', 'Document value', 'Place of supply', 'Rate', ...AMOUNT_COLS],
        group(out.filter(isLarge), (l) => `${l.id}|${l.igstRate}`).map(({ first: l, acc }) => [l.number, l.date, rupees(l.total), l.pos, l.igstRate, ...amounts(acc)]))
    case 'b2c-others':
      return done(['Place of supply', 'Rate', ...AMOUNT_COLS],
        group(out.filter((l) => l.supplyType === 'B2C' && l.taxed && !isLarge(l)), (l) => `${l.pos}|${l.igstRate}`, true).map(({ first: l, acc }) => [l.pos, l.igstRate, ...amounts(acc)]))
    case 'notes':
      return done(['Note type', 'Number', 'Date', 'Original number', 'Original date', 'Recipient GSTIN', 'Registered', 'Place of supply', 'Rate', ...AMOUNT_COLS, 'Reason', 'ITC reversal confirmed'],
        group(out.filter((l) => l.docType === 'credit_note' || l.docType === 'debit_note'), (l) => `${l.id}|${l.taxed ? l.igstRate : '0'}`)
          .map(({ first: l, acc }) => [DOC_TITLES[l.docType], l.number, l.date, l.snap.original?.number ?? '', l.snap.original?.date ?? '', gstin(l), l.snap.party?.gstin ? 'Y' : 'N', l.pos, l.taxed ? l.igstRate : '0', ...amounts(acc), l.reason, l.snap.itcReversalConfirmed ?? '']))
    case 'exports':
      return done(['Invoice number', 'Date', 'Invoice value', 'Type', 'With or without payment', 'LUT reference', 'Port code', 'Shipping bill number', 'Shipping bill date', 'Rate', 'Taxable value', 'IGST'],
        group(out.filter((l) => l.docType === 'tax_invoice' && ['EXPWOP', 'SEZWP', 'SEZWOP'].includes(l.supplyType)), (l) => `${l.id}|${l.taxed ? l.igstRate : '0'}`)
          .map(({ first: l, acc }) => [l.number, l.date, rupees(l.total), l.supplyType.startsWith('SEZ') ? 'SEZ' : 'Export', l.supplyType.endsWith('WOP') ? 'without payment' : 'with payment', l.snap.lutReference ?? '', '', '', '', l.taxed ? l.igstRate : '0', rupees(acc.taxable), rupees(acc.igst)]))
    case 'nil-exempt': {
      const home = business?.stateCode ?? ''
      const rows = group(out.filter((l) => ['nil-rated', 'exempt', 'non-gst'].includes(l.supplyClass)),
        (l) => `${l.pos && l.pos !== home ? 'Inter-State' : 'Intra-State'}|${l.snap.party?.gstin ? 'registered' : 'unregistered'}|${l.supplyClass}`, true)
      return done(['Supply', 'Recipient', 'Supply class', 'Value'], rows.map(({ first: l, acc }) => [l.pos && l.pos !== home ? 'Inter-State' : 'Intra-State', l.snap.party?.gstin ? 'registered' : 'unregistered', l.supplyClass, rupees(acc.taxable)]))
    }
    case 'advances':
      return done(['Place of supply', 'Rate', 'Advance received less refunded (taxable value)', 'IGST', 'CGST', 'SGST/UTGST', 'Cess'],
        group(live.filter((l) => l.docType === 'receipt_voucher' || l.docType === 'refund_voucher'), (l) => `${l.pos}|${l.taxed ? l.igstRate : '0'}`, true).map(({ first: l, acc }) => [l.pos, l.taxed ? l.igstRate : '0', ...amounts(acc)]))
    case 'hsn':
      return done(['HSN/SAC', 'Description', 'UQC', 'Total quantity', 'Total value', 'Rate', ...AMOUNT_COLS],
        group(out, (l) => `${l.hsn}|${l.uqc}|${l.taxed ? l.igstRate : '0'}`, true)
          .map(({ first: l, acc }) => [l.hsn, l.description, l.uqc, String(Math.round(acc.qty * 1000) / 1000), rupees(acc.taxable + acc.igst + acc.cgst + acc.sgst + acc.cess), l.taxed ? l.igstRate : '0', ...amounts(acc)]))
    case 'documents-issued': {
      const series = new Map((await db.query<{ id: string; name: string }>(`SELECT id, name FROM ${T('ab_gst_series')}`)).map((s) => [s.id, s.name]))
      const docs = new Map<string, L>()
      for (const l of all) docs.set(l.id, l)
      const g = new Map<string, L[]>()
      for (const l of docs.values()) g.set(`${l.docType}|${l.seriesId}|${l.fy}`, [...(g.get(`${l.docType}|${l.seriesId}|${l.fy}`) ?? []), l])
      return done(['Document type', 'Series', 'Financial year', 'First number', 'Last number', 'Total issued', 'Cancelled', 'Net'],
        [...g.values()].map((ds) => {
          const sorted = [...ds].sort((a, b) => (a.number < b.number ? -1 : 1))
          const cancelled = ds.filter((d) => d.state === 'cancelled').length
          return [DOC_TITLES[ds[0].docType], series.get(ds[0].seriesId) ?? '', ds[0].fy, sorted[0].number, sorted[sorted.length - 1].number, ds.length, cancelled, ds.length - cancelled]
        }))
    }
    case 'inward-register':
      return done(['Supplier GSTIN', 'Supplier name', 'Our number', 'Supplier invoice number', 'Supplier invoice date', 'Posting date', 'Status', 'Place of supply', 'Reverse charge', 'HSN/SAC', 'Description', 'Rate', ...AMOUNT_COLS, 'ITC flag', 'ITC reason'],
        all.filter((l) => l.docType === 'purchase_invoice').map((l) => [gstin(l), l.snap.party?.name ?? '', l.number, l.snap.supplierInvoiceNo ?? '', l.snap.supplierInvoiceDate ?? '', l.date, l.state, l.pos, l.reverseCharge ? 'Y' : 'N', l.hsn, l.description,
          l.taxed ? l.igstRate : '0', ...amounts(l), l.itc, l.itcReason]))
    case 'gstr3b-helper': {
      const pick = (f: (l: L) => boolean, src = out, signed = true): string[] => amounts(src.filter(f).reduce((a, l) => add(a, l, signed ? sign(l) : 1), zero()))
      const inward = live.filter((l) => l.docType === 'purchase_invoice')
      return done(['Section', ...AMOUNT_COLS], [
        ['Outward taxable supplies (other than zero-rated, nil-rated and exempt)', ...pick((l) => l.taxed && !l.snap.zeroRated)],
        ['Outward taxable supplies (zero-rated)', ...pick((l) => !!l.snap.zeroRated)],
        ['Other outward supplies (nil-rated, exempt)', ...pick((l) => !l.snap.zeroRated && (l.supplyClass === 'nil-rated' || l.supplyClass === 'exempt'))],
        ['Inward supplies liable to reverse charge', ...pick((l) => l.reverseCharge, inward, false)],
        ['Non-GST outward supplies', ...pick((l) => l.supplyClass === 'non-gst')],
        ['ITC: inward supplies liable to reverse charge', ...pick((l) => l.reverseCharge && l.itc === 'eligible', inward, false)],
        ['ITC: all other ITC', ...pick((l) => !l.reverseCharge && l.taxed && l.itc === 'eligible', inward, false)],
        ['Ineligible ITC', ...pick((l) => l.taxed && l.itc !== 'eligible', inward, false)],
      ])
    }
    case 'composition-helper': {
      if (!business?.composition) notes.push('The business is not registered under the composition scheme; the turnover below is the value of its bills of supply and tax invoices.')
      const turnover = out.reduce((s, l) => s + sign(l) * l.taxable, 0)
      const cat = business?.composition?.category ?? ''
      const c = cat ? th.number(`composition_rate_cgst:${cat}`) : null
      const sg = cat ? th.number(`composition_rate_sgst:${cat}`) : null
      if (cat && (c === null || sg === null)) notes.push(`The composition rates for the category "${cat}" are not set in the reference data.`)
      const tax = c !== null && sg !== null ? compositionTax(turnover, c, sg) : null
      const rcm = live.filter((l) => l.docType === 'purchase_invoice' && l.reverseCharge).reduce((a, l) => add(a, l), zero())
      notes.push('Which supplies belong in the turnover of the composition computation is for the accountant (draft Q10): this is every outward document of the period, credit notes subtracted.')
      return done(['Item', 'Value'], [
        ['Category', cat], ['Turnover in the State for the period', rupees(turnover)], ['Composition tax rate, central share (%)', c ?? ''], ['Composition tax rate, State share (%)', sg ?? ''],
        ['Composition tax, CGST', tax ? rupees(tax.cgst) : ''], ['Composition tax, SGST', tax ? rupees(tax.sgst) : ''],
        ['Inward supplies under reverse charge: taxable value', rupees(rcm.taxable)], ['Inward supplies under reverse charge: tax', rupees(rcm.igst + rcm.cgst + rcm.sgst)],
      ])
    }
  }
  throw notFound('Summary')
}
