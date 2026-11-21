/**
 * GST documents (docs/plan/gst-spec-draft.md section 7; a DRAFT no accountant has reviewed): tax invoice, bill of
 * supply, credit note, debit note, receipt / refund / payment voucher, purchase invoice.
 *
 *   draft    the user's input as entered (`input`); no number, no postings; may be changed and deleted
 *   issued   prepare() ran on the reference data of the document date, the number was taken from the series INSIDE the
 *            issuing transaction (G7.6: no gaps from abandoned drafts), the lines and the journal were written in the
 *            same transaction, a snapshot of the business and the party was frozen for the print. After issue only the
 *            recorded-elsewhere fields change (IRN, e-way bill, payment status, notes: recordOnIssued), each audited
 *   cancelled  G7.9: only without IRN, payment or later notes and in an open period; keeps its number; its journal is
 *            reversed by a dated reversal
 * Corrections of an issued document are credit and debit notes (G7.8, G7.9), never an edit.
 *
 * prepare() is the one place that turns input into figures: it reads the dated data, asks the engine (engine.ts) for the
 * place of supply, the rates and the amounts, and returns what issue() stores and postings.ts posts.
 */
import type { SqlDb } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { rowUid } from '../util.ts'
import { T, conflict, dateOf, invalid, isObj, notFound, oneOf, optionalDate, text, type Level } from '../ledger/core.ts'
import { accountsByKey, assertPostable, postJournal, reverseJournal } from '../ledger/service.ts'
import { DecimalError, decimalText, paise, parseDecimal, rupees, PRICE_SCALE, QTY_SCALE, RATE_SCALE, type Paise } from './money.ts'
import {
  DOC_TITLES, DOC_TYPES, StopError, computeDocument, consignmentValue, creditNoteDeadline, creditProblem, determineSupply, financialYearOf, findRate, hsnDigitsRequired, hsnProblem,
  inEinvoiceClass, nearRateChange, outwardDocumentProblem, seriesNumber,
  type CalcLine, type CalcOutput, type DocType, type ItemKind, type SupplyClass, type TaxKind,
} from './engine.ts'
import { ITC_FLAGS, allRates, getBusiness, getParty, listItems, listSeries, statesOn, thresholdsOn, type Business, type ItcFlag, type Item, type Party } from './reference.ts'
import { postingLines, type PostingDoc } from './postings.ts'

/* ------------------------------------------------------------------ input */

export interface DocLineInput {
  itemId: string
  description: string
  quantity: string
  unitPrice: string
  discountPercent: string | null
  discountAmount: string | null
  /** purchases (G6.10, G6.3) */
  itc: ItcFlag | null
  itcReason: string
  reverseCharge: boolean
  accountId: string | null
}
export interface DocInput {
  docType: DocType
  date: string
  partyId: string | null
  seriesId: string | null
  lines: DocLineInput[]
  charges: { description: string; amount: string; line: number | null }[]
  documentDiscount: string | null
  taxInclusive: boolean
  supply: {
    shipToAddress: string; shipToState: string; shipToCountry: string; billToShipTo: boolean; goodsMove: 'yes' | 'no' | 'unknown'; installedAtSite: boolean; siteState: string
    addressRecorded: boolean; zeroRated: 'lut' | 'with_payment' | null; exportConditionsConfirmed: boolean
    continuousSupply: boolean; saleOnApproval: boolean; onBoardConveyance: boolean; importOrBonded: boolean
    manualState: string; manualReason: string
  }
  originalId: string | null
  reason: string
  itcReversalConfirmed: 'yes' | 'no' | 'na' | null
  rateDateConfirmed: boolean
  /** purchases */
  supplierInvoiceNo: string
  supplierInvoiceDate: string | null
  inwardTax: 'intra' | 'inter' | 'none' | null
  roundOffAmount: string | null
  /** vouchers */
  moneyAccount: 'bank' | 'cash'
  amount: string | null
  notes: string
}
export const CREDIT_REASONS = ['return', 'post-sale discount', 'deficiency', 'price revision', 'other'] as const

const dec = (v: unknown, scale: number, what: string, field: string): string => {
  try { return decimalText(parseDecimal(v, scale, what), scale) } catch (e) { throw invalid((e as Error).message, field) }
}
const optDec = (v: unknown, scale: number, what: string, field: string): string | null => (v === undefined || v === null || v === '' ? null : dec(v, scale, what, field))

/** shape-checks a request body into a DocInput (the content is checked by prepare) */
export function readDocInput(b: Record<string, unknown>, cur?: DocInput): DocInput {
  const g = <K extends keyof DocInput>(k: K): unknown => (b[k] !== undefined ? b[k] : cur?.[k])
  const docType = cur ? cur.docType : oneOf(b.docType, DOC_TYPES, 'Document type', 'docType')
  const rawLines = g('lines')
  if (rawLines !== undefined && !Array.isArray(rawLines)) throw invalid('lines is a list.', 'lines')
  const lines = ((rawLines as unknown[] | undefined) ?? []).slice(0, 200).map((x, i): DocLineInput => {
    const o = isObj(x) ? x : {}
    const n = `Line ${i + 1}`
    return {
      itemId: text(o.itemId, 80), description: text(o.description, 300), quantity: dec(o.quantity === '' ? '1' : o.quantity ?? '1', QTY_SCALE, `${n}: quantity`, 'lines'), unitPrice: dec(o.unitPrice === '' ? '0' : o.unitPrice ?? '0', PRICE_SCALE, `${n}: unit price`, 'lines'),
      discountPercent: optDec(o.discountPercent, RATE_SCALE, `${n}: discount percent`, 'lines'), discountAmount: optDec(o.discountAmount, 2, `${n}: discount`, 'lines'),
      itc: o.itc === undefined || o.itc === null || o.itc === '' ? null : oneOf(o.itc, ITC_FLAGS, `${n}: ITC flag`, 'lines'), itcReason: text(o.itcReason, 200), reverseCharge: o.reverseCharge === true,
      accountId: text(o.accountId, 80) || null,
    }
  })
  const rawCharges = g('charges')
  const charges = (Array.isArray(rawCharges) ? rawCharges : []).slice(0, 20).map((x, i) => {
    const o = isObj(x) ? x : {}
    return { description: text(o.description, 120) || 'Charge', amount: dec(o.amount ?? '0', 2, `Charge ${i + 1}`, 'charges'), line: typeof o.line === 'number' && Number.isInteger(o.line) ? o.line : null }
  })
  const sb = isObj(b.supply) ? b.supply : {}
  const sc = cur?.supply
  const sg = <K extends keyof DocInput['supply']>(k: K): unknown => (sb[k] !== undefined ? sb[k] : sc?.[k])
  const zr = sg('zeroRated')
  const itcRev = g('itcReversalConfirmed')
  const inwardTax = g('inwardTax')
  return {
    docType, date: dateOf(g('date'), 'Date', 'date'), partyId: text(g('partyId'), 80) || null, seriesId: text(g('seriesId'), 80) || null, lines, charges,
    documentDiscount: optDec(g('documentDiscount'), 2, 'Document discount', 'documentDiscount'), taxInclusive: g('taxInclusive') === true,
    supply: {
      shipToAddress: text(sg('shipToAddress'), 500), shipToState: text(sg('shipToState'), 2), shipToCountry: (text(sg('shipToCountry'), 2) || '').toUpperCase(), billToShipTo: sg('billToShipTo') === true,
      goodsMove: oneOf(sg('goodsMove') ?? 'yes', ['yes', 'no', 'unknown'], 'Movement of goods', 'supply'), installedAtSite: sg('installedAtSite') === true, siteState: text(sg('siteState'), 2),
      addressRecorded: sg('addressRecorded') !== false, zeroRated: zr === 'lut' || zr === 'with_payment' ? zr : null, exportConditionsConfirmed: sg('exportConditionsConfirmed') === true,
      continuousSupply: sg('continuousSupply') === true, saleOnApproval: sg('saleOnApproval') === true, onBoardConveyance: sg('onBoardConveyance') === true, importOrBonded: sg('importOrBonded') === true,
      manualState: text(sg('manualState'), 2), manualReason: text(sg('manualReason'), 300),
    },
    originalId: text(g('originalId'), 80) || null, reason: text(g('reason'), 60),
    itcReversalConfirmed: itcRev === 'yes' || itcRev === 'no' || itcRev === 'na' ? itcRev : null, rateDateConfirmed: g('rateDateConfirmed') === true,
    supplierInvoiceNo: text(g('supplierInvoiceNo'), 40), supplierInvoiceDate: optionalDate(g('supplierInvoiceDate'), 'Supplier invoice date', 'supplierInvoiceDate'),
    inwardTax: inwardTax === 'intra' || inwardTax === 'inter' || inwardTax === 'none' ? inwardTax : null, roundOffAmount: optDec(g('roundOffAmount'), 2, 'Round-off', 'roundOffAmount'),
    moneyAccount: g('moneyAccount') === 'cash' ? 'cash' : 'bank', amount: optDec(g('amount'), 2, 'Amount', 'amount'), notes: text(g('notes'), 2000),
  }
}

/* ------------------------------------------------------------------ prepare: input -> figures */

export interface PreparedLine {
  itemId: string | null; description: string; kind: ItemKind; hsn: string; uqc: string; quantity: string; unitPrice: string; supplyClass: SupplyClass
  gross: Paise; discount: Paise; charges: Paise; taxable: Paise; igstRate: string; cgstRate: string; sgstRate: string; cessRate: string
  cgst: Paise; sgst: Paise; igst: Paise; cess: Paise; taxed: boolean; reverseCharge: boolean; itc: string; itcReason: string; accountId: string | null
}
export interface Snapshot {
  business: Pick<Business, 'gstin' | 'legalName' | 'tradeName' | 'address' | 'stateCode' | 'regType' | 'pan' | 'phone' | 'email' | 'footer'> & { stateName: string }
  party: (Pick<Party, 'name' | 'gstin' | 'regType' | 'stateCode' | 'country' | 'address'> & { stateName: string }) | null
  rule: string
  placeOfSupplyName: string
  utgst: boolean
  zeroRated: 'lut' | 'with_payment' | null
  composition: boolean
  lutReference: string
  original: { id: string; number: string; date: string; docType: DocType } | null
  shipTo: { address: string; stateCode: string; stateName: string; country: string } | null
  charges: { description: string; amount: Paise }[]
  taxInclusive: boolean
  consignmentValue: Paise
  ewayRequired: boolean
  irnRequired: boolean
  itcReversalConfirmed: string | null
  supplierInvoiceNo: string
  supplierInvoiceDate: string | null
  moneyAccount: string
  warnings: string[]
}
export interface Prepared {
  fy: string
  fyShort: string
  placeOfSupply: string | null
  taxKind: TaxKind
  supplyType: string
  lines: PreparedLine[]
  totals: { taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise; cess: Paise; roundOff: Paise; total: Paise }
  posting: PostingDoc
  snapshot: Snapshot
}

const OUTWARD: DocType[] = ['tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note', 'receipt_voucher', 'refund_voucher']
const rateText = (v: unknown): string => decimalText(parseDecimal(String(v ?? '0'), RATE_SCALE), RATE_SCALE)
const stop = (rule: string, message: string) => new StopError(rule, message)

interface StoredDoc { row: Record<string, unknown>; lines: Record<string, unknown>[] }
async function stored(db: SqlDb, id: string): Promise<StoredDoc | null> {
  const r = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_documents')} WHERE id = $1`, [id])
  if (!r.length) return null
  return { row: r[0], lines: await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_document_lines')} WHERE document_id = $1 ORDER BY line_no`, [id]) }
}
const num = (v: unknown): number => Number(v ?? 0)

export async function prepare(db: SqlDb, input: DocInput, selfId?: string): Promise<Prepared> {
  const business = await getBusiness(db)
  if (!business) throw invalid('Enter the business registration first (Accounts > Settings).')
  const th = await thresholdsOn(db, input.date)
  const fyMonth = th.requiredInt('financial_year_start_month')
  const fy = financialYearOf(input.date, fyMonth)
  const states = await statesOn(db, input.date)
  const stateName = (code: string | null | undefined): string => (code === 'OTHER' ? 'Outside India' : states.find((s) => s.code === code)?.name ?? '')
  const home = states.find((s) => s.code === business.stateCode)
  if (!home) throw stop('G2.7', `The business's State code ${business.stateCode} is not in the reference data on ${input.date}. Add the States in Accounts > Reference data.`)
  const composition = business.regType === 'composition' || business.regType === 'composition-services'
  const party = input.partyId ? await getParty(db, input.partyId) : null
  if (input.partyId && !party) throw invalid('The customer or supplier does not exist.', 'partyId')
  const items = new Map((await listItems(db)).map((i) => [i.id, i]))
  const warnings: string[] = []
  const type = input.docType
  const outward = OUTWARD.includes(type)
  if (outward && party && party.role === 'supplier') throw invalid(`${party.name} is a supplier, not a customer.`, 'partyId')
  if (!outward && party && party.role === 'customer') throw invalid(`${party.name} is a customer, not a supplier.`, 'partyId')

  const snapshotBase = (): Snapshot => ({
    business: { gstin: business.gstin, legalName: business.legalName, tradeName: business.tradeName, address: business.address, stateCode: business.stateCode, regType: business.regType, pan: business.pan, phone: business.phone, email: business.email, footer: business.footer, stateName: home.name },
    party: party ? { name: party.name, gstin: party.gstin, regType: party.regType, stateCode: party.stateCode, country: party.country, address: party.address, stateName: stateName(party.stateCode) } : null,
    rule: '', placeOfSupplyName: '', utgst: false, zeroRated: null, composition, lutReference: '', original: null, shipTo: null, charges: [], taxInclusive: input.taxInclusive, consignmentValue: 0,
    ewayRequired: false, irnRequired: false, itcReversalConfirmed: input.itcReversalConfirmed, supplierInvoiceNo: input.supplierInvoiceNo, supplierInvoiceDate: input.supplierInvoiceDate,
    moneyAccount: input.moneyAccount, warnings,
  })

  /* ---- payment voucher: an amount paid to a supplier, no tax lines (rule 52 is not reviewed in the draft, G7.3a) */
  if (type === 'payment_voucher') {
    if (!party) throw invalid('Choose the supplier.', 'partyId')
    const total = input.amount ? paise(input.amount) : 0
    if (total <= 0) throw invalid('Enter the amount paid.', 'amount')
    const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, roundOff: 0, total }
    return { fy: fy.name, fyShort: fy.short, placeOfSupply: null, taxKind: 'none', supplyType: 'PAYMENT', lines: [], totals, posting: { docType: type, utgst: false, zeroRated: false, totals, lines: [], moneyAccount: input.moneyAccount }, snapshot: snapshotBase() }
  }

  if (!input.lines.length) throw stop('G5.5', 'The document has no lines.')
  const lineItems = input.lines.map((l, i): Item => {
    const it = items.get(l.itemId)
    if (!it) throw invalid(`Line ${i + 1}: choose an item or service.`, 'lines')
    return it
  })

  /* ---- credit note, debit note, refund voucher: tax type, place of supply and rates of the original (G5.12) */
  let original: StoredDoc | null = null
  if (type === 'credit_note' || type === 'debit_note' || type === 'refund_voucher') {
    if (!input.originalId) throw invalid(type === 'refund_voucher' ? 'Choose the receipt voucher this refund is for.' : 'Choose the invoice this note is for.', 'originalId')
    original = await stored(db, input.originalId)
    const allowed: DocType[] = type === 'refund_voucher' ? ['receipt_voucher'] : ['tax_invoice', 'bill_of_supply']
    if (!original || original.row.state !== 'issued' || !allowed.includes(original.row.doc_type as DocType)) throw invalid('The original document must be an issued ' + (type === 'refund_voucher' ? 'receipt voucher.' : 'tax invoice or bill of supply.'), 'originalId')
    if ((original.row.party_id ?? null) !== (input.partyId ?? null)) throw invalid('The note must be for the same customer as the original document.', 'partyId')
    if (input.date < String(original.row.date)) throw invalid('A note cannot be dated before its original document.', 'date')
  }

  const snapshot = snapshotBase()
  let taxKind: TaxKind = 'none'
  let placeOfSupply: string | null = null
  let supplyType = ''
  let calcLines: CalcLine[] = []
  let rcm: boolean[] = input.lines.map(() => false)
  let itc: string[] = input.lines.map(() => '')
  let lineSource: { hsn: string; uqc: string; kind: ItemKind; supplyClass: SupplyClass; description: string }[] = lineItems.map((it, i) => ({ hsn: it.hsn, uqc: it.uqc, kind: it.kind, supplyClass: it.supplyClass, description: input.lines[i].description || it.name }))
  const baseLine = (i: number) => ({ quantity: input.lines[i].quantity, unitPrice: input.lines[i].unitPrice, discountPercent: input.lines[i].discountPercent, discountAmount: input.lines[i].discountAmount })
  const rates = await allRates(db)
  const confirmDays = th.number('rate_change_confirm_days')
  const rateFor = (it: Item, date: string, n: number) => {
    const code = it.rateCode || it.hsn
    const r = findRate(rates, code, it.rateCondition, date, it.kind)
    // G4.4: near a rate change the user confirms the rate date
    if (confirmDays !== null && !input.rateDateConfirmed && nearRateChange(rates, code, it.rateCondition, date, Number(confirmDays))) {
      throw new HttpError(422, 'invalid', `Line ${n}: the rate of HSN/SAC ${code} changed within the last ${confirmDays} days before ${date}. Check that the rate of ${date} applies to this supply (section 14), then confirm the rate date.`, 'rateDateConfirmed', { confirm: 'rateDate' })
    }
    return { igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cessAdValorem ?? '0' }
  }
  let calc: CalcOutput
  let roundOffOverride: Paise | null = null

  if (original) {
    const o = original
    taxKind = o.row.tax_kind as TaxKind
    placeOfSupply = o.row.place_of_supply ? String(o.row.place_of_supply) : null
    supplyType = String(o.row.supply_type ?? '')
    const os = (o.row.snapshot ?? {}) as Partial<Snapshot>
    snapshot.utgst = os.utgst === true
    snapshot.zeroRated = os.zeroRated ?? null
    snapshot.rule = os.rule ?? ''
    snapshot.lutReference = os.lutReference ?? ''
    snapshot.original = { id: String(o.row.id), number: String(o.row.number), date: String(o.row.date), docType: o.row.doc_type as DocType }
    const origLines = input.lines.map((l, i) => {
      const ol = o.lines.find((x) => x.item_id === l.itemId)
      if (!ol) throw invalid(`Line ${i + 1}: ${lineItems[i].name} is not on ${String(o.row.number)}. Each line of a note names a line of its original document (G5.17).`, 'lines')
      return ol
    })
    lineSource = origLines.map((ol, i) => ({ hsn: String(ol.hsn), uqc: String(ol.uqc), kind: ol.kind as ItemKind, supplyClass: ol.supply_class as SupplyClass, description: input.lines[i].description || String(ol.description) }))
    calcLines = origLines.map((ol, i) => ({ ...baseLine(i), supplyClass: ol.supply_class as SupplyClass, rate: ol.taxed ? { igst: rateText(ol.igst_rate), cgst: rateText(ol.cgst_rate), sgst: rateText(ol.sgst_rate), cess: rateText(ol.cess_rate) } : null }))
    const refund = type === 'refund_voucher'
    calc = computeDocument({ lines: calcLines, tax: taxKind, taxInclusive: refund, taxMode: business.settings.taxMode, roundOff: refund ? false : business.settings.roundOff })
    snapshot.taxInclusive = refund
    if (type !== 'debit_note') {
      if (type === 'credit_note') {
        oneOf(input.reason, CREDIT_REASONS, 'The reason of a credit note', 'reason')
        // W9: the field for the accountant must be filled before the note is posted
        if (!input.itcReversalConfirmed) throw invalid('Say whether the recipient confirmed the reversal of input tax credit: yes, no or not applicable (G4.13).', 'itcReversalConfirmed')
        // G5.17: the 30 November deadline (a dated value; the accountant may set an earlier date per financial year)
        const md = th.text('credit_note_deadline')
        if (!md) warnings.push('The credit note deadline is not set in the reference data, so it was not checked (G5.17).')
        else {
          const ofy = financialYearOf(String(o.row.date), fyMonth)
          const deadline = creditNoteDeadline(String(o.row.date), fyMonth, md, th.text(`credit_note_deadline:${ofy.name}`))
          if (input.date > deadline) throw stop('G5.17', `A GST credit note for a supply of ${ofy.name} cannot be dated after ${deadline}. A commercial credit note without GST is not available in this version: ask the accountant.`)
        }
      }
      // G5.12: not more than the original still has after earlier notes of the same kind
      const earlier = await db.query<Record<string, unknown>>(
        `SELECT COALESCE(sum(taxable), 0)::bigint AS taxable, COALESCE(sum(cgst), 0)::bigint AS cgst, COALESCE(sum(sgst), 0)::bigint AS sgst, COALESCE(sum(igst), 0)::bigint AS igst, COALESCE(sum(cess), 0)::bigint AS cess
           FROM ${T('ab_gst_documents')} WHERE original_id = $1 AND doc_type = $2 AND state = 'issued' AND id <> $3`, [input.originalId, type, selfId ?? ''])
      const p = creditProblem(
        { taxable: num(o.row.taxable), cgst: num(o.row.cgst), sgst: num(o.row.sgst), igst: num(o.row.igst), cess: num(o.row.cess) },
        { taxable: num(earlier[0].taxable), cgst: num(earlier[0].cgst), sgst: num(earlier[0].sgst), igst: num(earlier[0].igst), cess: num(earlier[0].cess) }, calc.totals)
      if (p) throw stop('G5.12', refund ? p.replace('credit note credits', 'refund voucher refunds').replace('original invoice', 'receipt voucher') : p)
    }
  } else if (type === 'purchase_invoice') {
    /* ---- inward: the supplier's document as it is, ITC flag per line (G6.10), reverse charge by G5.10 */
    if (!party) throw invalid('Choose the supplier.', 'partyId')
    if (!input.supplierInvoiceNo) throw invalid("Enter the supplier's invoice number.", 'supplierInvoiceNo')
    const rateDate = input.supplierInvoiceDate ?? input.date
    if (rateDate > input.date) throw invalid("The supplier's invoice date cannot be after the posting date.", 'supplierInvoiceDate')
    if (input.charges.length || input.documentDiscount) throw invalid('Enter charges and discounts of a purchase as lines or line discounts.', 'charges')
    rcm = input.lines.map((l, i) => l.reverseCharge || !!lineItems[i].rcmCategory)
    const abroad = party.regType === 'overseas'
    if (abroad && rcm.some((r, i) => !r || lineItems[i].kind === 'goods')) throw stop('G1.11', 'Imports of goods are not handled by this version; a service from outside India is entered as a reverse charge line.')
    const sameState = !!party.stateCode && party.stateCode === business.stateCode
    const supplierCharges = party.regType === 'regular' || party.regType === 'sez_unit' || party.regType === 'sez_developer' || party.regType === 'uin'
    const normalTax: TaxKind = input.inwardTax ?? (supplierCharges ? (sameState ? 'intra' : 'inter') : 'none')
    const rcmTax: TaxKind = abroad ? 'inter' : !party.stateCode || sameState ? 'intra' : 'inter'
    taxKind = rcm.every(Boolean) ? rcmTax : normalTax
    placeOfSupply = business.stateCode
    supplyType = 'INWARD'
    snapshot.utgst = home.usesUtgst
    itc = input.lines.map((l, i) => (composition ? 'ineligible' : l.itc ?? lineItems[i].itcDefault))
    if (itc.includes('undecided')) throw invalid('Decide the input tax credit flag of every line (eligible or ineligible) before the purchase is posted (G6.10).', 'lines')
    const one = (reverse: boolean, tax: TaxKind): CalcOutput | null => {
      const idx = input.lines.map((_, i) => i).filter((i) => rcm[i] === reverse)
      if (!idx.length) return null
      return computeDocument({ tax, taxMode: 'line', roundOff: false, lines: idx.map((i) => ({ ...baseLine(i), supplyClass: lineItems[i].supplyClass, rate: (tax === 'intra' || tax === 'inter') && (lineItems[i].supplyClass === 'taxable' || lineItems[i].supplyClass === 'zero-rated-capable') ? rateFor(lineItems[i], rateDate, i + 1) : null })) })
    }
    const a = one(false, normalTax)
    const r = one(true, rcmTax)
    let ai = 0
    let ri = 0
    const merged = input.lines.map((_, i) => (rcm[i] ? r!.lines[ri++] : a!.lines[ai++]))
    if (merged.some((l, i) => rcm[i] && l.cess)) throw stop('G9.5', 'Cess under reverse charge is not handled by this version.')
    const sumOf = (k: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'cess') => merged.reduce((s, l) => s + l[k], 0)
    roundOffOverride = input.roundOffAmount ? paise(input.roundOffAmount) : 0
    if (Math.abs(roundOffOverride) >= 100) throw invalid('A round-off is less than one rupee.', 'roundOffAmount')
    const t = { taxable: sumOf('taxable'), cgst: sumOf('cgst'), sgst: sumOf('sgst'), igst: sumOf('igst'), cess: sumOf('cess') }
    // the document total is what the supplier is owed: value + the tax the supplier charged (reverse charge tax is not paid to the supplier)
    const supplierTax = merged.reduce((s, l, i) => s + (rcm[i] ? 0 : l.cgst + l.sgst + l.igst + l.cess), 0)
    calc = { lines: merged, totals: { ...t, tax: t.cgst + t.sgst + t.igst + t.cess, exact: t.taxable + supplierTax, roundOff: roundOffOverride, total: t.taxable + supplierTax + roundOffOverride } }
    for (const [i, l] of input.lines.entries()) if (itc[i] === 'ineligible' && !composition && !l.itcReason) warnings.push(`Line ${i + 1}: no reason for the ineligible input tax credit.`)
  } else {
    /* ---- tax invoice, bill of supply, receipt voucher: the decision table of section 3 */
    const recipient = { regType: party?.regType ?? ('unregistered' as const), state: party?.stateCode || null, country: party?.country || 'IN' }
    const lut = business.luts.find((l) => l.fy === fy.name)
    if (lineItems.some((it) => it.rcmCategory)) throw stop('G6.3', 'An outward supply under reverse charge needs the accountant: the draft specification does not say what such a document shows.')
    const s = input.supply
    const advance = type === 'receipt_voucher'
    if (advance && !party) throw invalid('Choose the customer.', 'partyId')
    if (advance && new Set(lineItems.map((it) => it.kind)).size > 1) throw invalid('A receipt voucher is for goods or for services, not both (G5.15).', 'lines')
    const goodsAdvance = advance && lineItems[0].kind === 'goods'
    const supply = determineSupply({
      supplierState: business.stateCode, lineKinds: lineItems.map((it) => ({ kind: it.kind, posCategory: it.posCategory })), recipient,
      shipToState: s.shipToState || null, shipToCountry: s.shipToCountry || null, billToShipTo: s.billToShipTo, goodsMove: s.goodsMove, installedAtSite: s.installedAtSite, siteState: s.siteState || null,
      addressRecorded: s.addressRecorded && !!party?.stateCode, zeroRated: s.zeroRated, lutValid: !!lut, exportConditionsConfirmed: s.exportConditionsConfirmed,
      flags: { continuousSupply: s.continuousSupply, saleOnApproval: s.saleOnApproval, onBoardConveyance: s.onBoardConveyance, importOrBonded: s.importOrBonded },
      manual: s.manualState ? { state: s.manualState, reason: s.manualReason } : null, manualAllowed: business.settings.manualPlaceOfSupply,
    }, states)
    placeOfSupply = supply.placeOfSupply
    snapshot.rule = supply.rule
    snapshot.utgst = supply.utgst
    snapshot.zeroRated = supply.tax === 'zero' || supply.sez ? supply.zeroRated : null
    snapshot.lutReference = supply.zeroRated === 'lut' ? lut?.reference ?? '' : ''
    const classes = lineItems.map((it) => it.supplyClass)
    if (!advance) {
      const p = outwardDocumentProblem(type as 'tax_invoice' | 'bill_of_supply', business.regType, classes, supply.tax === 'zero')
      if (p) throw stop('G7.3', p)
    } else if (business.regType === 'unregistered') throw stop('G6.9', 'An unregistered business issues no GST receipt voucher.')
    // G6.7: a composition person makes no inter-State outward supply
    if (composition && supply.tax !== 'intra') throw stop('G6.7', 'A composition taxable person may not make an outward supply whose place of supply is in another State.')
    taxKind = composition || type === 'bill_of_supply' || goodsAdvance ? 'none' : supply.tax
    const registered = recipient.regType !== 'unregistered' && recipient.regType !== 'overseas'
    supplyType = advance ? 'ADVANCE' : supply.tax === 'zero' && !supply.sez ? 'EXPWOP' : supply.sez ? (supply.zeroRated === 'lut' ? 'SEZWOP' : 'SEZWP') : registered ? 'B2B' : 'B2C'
    const taxed = taxKind === 'intra' || taxKind === 'inter'
    calcLines = lineItems.map((it, i) => ({ ...baseLine(i), supplyClass: it.supplyClass, rate: taxed && (it.supplyClass === 'taxable' || it.supplyClass === 'zero-rated-capable') ? rateFor(it, input.date, i + 1) : null }))
    // G7.7: HSN digits by turnover and recipient
    const digitsSmall = th.number('hsn_digits_small'), digitsLarge = th.number('hsn_digits_large'), limit = th.money('hsn_turnover_limit')
    if (digitsSmall === null || digitsLarge === null || limit === null) warnings.push('The HSN digit rule is not set in the reference data, so HSN/SAC codes were not checked (G7.7).')
    else if (!advance) {
      const prev = financialYearOf(`${Number(fy.start.slice(0, 4)) - 1}-${fy.start.slice(5)}`, fyMonth).name
      const need = hsnDigitsRequired({ digitsSmall: Number(digitsSmall), digitsLarge: Number(digitsLarge), turnoverLimit: limit, optionalForUnregistered: th.number('hsn_optional_unregistered') === '1' }, business.turnovers[prev] ? paise(business.turnovers[prev]) : 0, registered)
      for (const [i, it] of lineItems.entries()) {
        const p = hsnProblem(it.hsn, need)
        if (p) throw stop('G7.7', `Line ${i + 1}: ${p}`)
      }
    }
    // G5.15: an advance is the amount received, treated as tax-inclusive, never rounded
    calc = computeDocument({ lines: calcLines, charges: advance ? [] : input.charges.map((c) => ({ amount: c.amount, line: c.line })), documentDiscount: advance ? null : input.documentDiscount,
      taxInclusive: advance ? true : input.taxInclusive, taxMode: business.settings.taxMode, roundOff: advance ? false : business.settings.roundOff, tax: taxKind })
    snapshot.taxInclusive = advance ? true : input.taxInclusive
    snapshot.charges = advance ? [] : input.charges.map((c) => ({ description: c.description, amount: paise(c.amount) }))
    if (s.shipToAddress || s.shipToState || s.shipToCountry) snapshot.shipTo = { address: s.shipToAddress, stateCode: s.shipToState, stateName: stateName(s.shipToState), country: s.shipToCountry || 'IN' }
    // G3.11 / rule 46(e): an unregistered recipient from the threshold value needs name, address and State
    const detailsFrom = th.money('unregistered_details_value')
    if (!advance && !registered && supply.tax !== 'zero' && detailsFrom !== null && calc.totals.taxable >= detailsFrom && (!party || !party.address || !party.stateCode)) {
      throw stop('G3.11', `An unregistered recipient needs a name, an address and a State on a document of ${rupees(detailsFrom)} or more.`)
    }
    if (!advance) {
      // G8.6: consignment value against the dated threshold (a prompt; the number is entered from the portal)
      const eway = th.money('eway_consignment_value')
      const goods = calc.lines.map((l, i) => ({ kind: lineItems[i].kind, ...l }))
      snapshot.consignmentValue = s.goodsMove === 'yes' ? consignmentValue(goods) : 0
      snapshot.ewayRequired = eway !== null && snapshot.consignmentValue > eway
      // G8.3: B2B documents of a business in the e-invoice class need an IRN from the IRP (entered, never generated)
      const einv = th.money('einvoice_turnover_threshold')
      const turnovers = Object.fromEntries(Object.entries(business.turnovers).map(([k, v]) => [k, paise(v)]))
      snapshot.irnRequired = einv !== null && type === 'tax_invoice' && registered && inEinvoiceClass(turnovers, fy.name, einv)
    }
  }
  if (original && type !== 'refund_voucher') {
    const einv = th.money('einvoice_turnover_threshold')
    const turnovers = Object.fromEntries(Object.entries(business.turnovers).map(([k, v]) => [k, paise(v)]))
    snapshot.irnRequired = einv !== null && supplyType === 'B2B' && inEinvoiceClass(turnovers, fy.name, einv)
  }
  snapshot.placeOfSupplyName = stateName(placeOfSupply)

  const lines: PreparedLine[] = calc.lines.map((l, i) => {
    const r = calcLines[i]?.rate
    const inward = type === 'purchase_invoice'
    const rr = inward && l.taxed ? rateFor(lineItems[i], input.supplierInvoiceDate ?? input.date, i + 1) : r
    return {
      itemId: input.lines[i].itemId, description: lineSource[i].description, kind: lineSource[i].kind, hsn: lineSource[i].hsn, uqc: lineSource[i].uqc, quantity: input.lines[i].quantity, unitPrice: input.lines[i].unitPrice,
      supplyClass: lineSource[i].supplyClass, gross: l.gross, discount: l.discount + l.documentDiscount, charges: l.charges, taxable: l.taxable,
      igstRate: l.taxed && rr ? rateText(rr.igst) : '0', cgstRate: l.taxed && rr ? rateText(rr.cgst) : '0', sgstRate: l.taxed && rr ? rateText(rr.sgst) : '0', cessRate: l.taxed && rr ? rateText(rr.cess ?? '0') : '0',
      cgst: l.cgst, sgst: l.sgst, igst: l.igst, cess: l.cess, taxed: l.taxed, reverseCharge: rcm[i], itc: itc[i], itcReason: input.lines[i].itcReason, accountId: input.lines[i].accountId ?? (inward ? lineItems[i].expenseAccount : null),
    }
  })
  const totals = { taxable: calc.totals.taxable, cgst: calc.totals.cgst, sgst: calc.totals.sgst, igst: calc.totals.igst, cess: calc.totals.cess, roundOff: calc.totals.roundOff, total: calc.totals.total }
  const posting: PostingDoc = {
    docType: type, utgst: snapshot.utgst, zeroRated: taxKind === 'zero', totals, reason: input.reason, moneyAccount: input.moneyAccount,
    lines: lines.map((l) => ({ supplyClass: l.supplyClass, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, cess: l.cess, reverseCharge: l.reverseCharge, itcEligible: l.itc === 'eligible', accountId: l.accountId, goods: l.kind === 'goods' })),
  }
  return { fy: fy.name, fyShort: fy.short, placeOfSupply, taxKind, supplyType, lines, totals, posting, snapshot }
}

/* ------------------------------------------------------------------ reading */

export interface DocView {
  id: string; docType: DocType; title: string; state: 'draft' | 'issued' | 'cancelled'; number: string | null; fy: string | null; date: string; partyId: string | null; partyName: string
  input: DocInput; placeOfSupply: string | null; taxKind: string | null; supplyType: string | null; originalId: string | null; reason: string
  totals: { taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise; cess: Paise; roundOff: Paise; total: Paise }
  lines: PreparedLine[]; snapshot: Snapshot | null; journalId: string | null; cancelJournalId: string | null; cancelReason: string | null
  irn: string | null; irnAckNo: string | null; irnAckDate: string | null; irnQr: string | null; ewayNo: string | null; ewayDate: string | null; ewayValidUntil: string | null
  vehicleNo: string | null; transporterId: string | null; notes: string; paymentStatus: string; issuedOn: string | null
  /** what a draft would look like if issued now, or why it cannot be issued */
  problem?: string | null
}
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const toLine = (l: Record<string, unknown>): PreparedLine => ({
  itemId: s(l.item_id), description: String(l.description), kind: l.kind as ItemKind, hsn: String(l.hsn), uqc: String(l.uqc), quantity: decimalText(parseDecimal(String(l.quantity), QTY_SCALE), QTY_SCALE),
  unitPrice: decimalText(parseDecimal(String(l.unit_price), PRICE_SCALE), PRICE_SCALE, 2), supplyClass: l.supply_class as SupplyClass, gross: num(l.gross), discount: num(l.discount), charges: num(l.charges), taxable: num(l.taxable),
  igstRate: rateText(l.igst_rate), cgstRate: rateText(l.cgst_rate), sgstRate: rateText(l.sgst_rate), cessRate: rateText(l.cess_rate), cgst: num(l.cgst), sgst: num(l.sgst), igst: num(l.igst), cess: num(l.cess),
  taxed: l.taxed === true, reverseCharge: l.reverse_charge === true, itc: String(l.itc), itcReason: String(l.itc_reason), accountId: s(l.account_id),
})
function toView(r: Record<string, unknown>, lines: Record<string, unknown>[], partyName: string): DocView {
  return {
    id: String(r.id), docType: r.doc_type as DocType, title: DOC_TITLES[r.doc_type as DocType], state: r.state as DocView['state'], number: s(r.number), fy: s(r.fy), date: String(r.date), partyId: s(r.party_id), partyName,
    input: r.input as DocInput, placeOfSupply: s(r.place_of_supply), taxKind: s(r.tax_kind), supplyType: s(r.supply_type), originalId: s(r.original_id), reason: String(r.reason ?? ''),
    totals: { taxable: num(r.taxable), cgst: num(r.cgst), sgst: num(r.sgst), igst: num(r.igst), cess: num(r.cess), roundOff: num(r.round_off), total: num(r.total) },
    lines: lines.map(toLine), snapshot: (r.snapshot as Snapshot | null) ?? null, journalId: s(r.journal_id), cancelJournalId: s(r.cancel_journal_id), cancelReason: s(r.cancel_reason),
    irn: s(r.irn), irnAckNo: s(r.irn_ack_no), irnAckDate: s(r.irn_ack_date), irnQr: s(r.irn_qr), ewayNo: s(r.eway_no), ewayDate: s(r.eway_date), ewayValidUntil: s(r.eway_valid_until),
    vehicleNo: s(r.vehicle_no), transporterId: s(r.transporter_id), notes: String(r.notes ?? ''), paymentStatus: String(r.payment_status ?? ''), issuedOn: r.issued_on ? new Date(r.issued_on as string).toISOString() : null,
  }
}

export async function getDocument(db: SqlDb, id: string, withPreview = true): Promise<DocView | null> {
  const d = await stored(db, id)
  if (!d) return null
  const party = d.row.party_id ? await getParty(db, String(d.row.party_id)) : null
  const view = toView(d.row, d.lines, (d.row.snapshot as Snapshot | null)?.party?.name ?? party?.name ?? '')
  if (view.state === 'draft' && withPreview) {
    // a draft shows the figures it would get if issued now, or the reason it cannot be issued
    try {
      const p = await prepare(db, view.input, id)
      view.lines = p.lines
      view.totals = p.totals
      view.placeOfSupply = p.placeOfSupply
      view.taxKind = p.taxKind
      view.snapshot = p.snapshot
      view.problem = null
    } catch (e) {
      if (e instanceof StopError || e instanceof DecimalError || (e instanceof HttpError && e.status === 422)) view.problem = (e as Error).message
      else throw e
    }
  }
  return view
}

export async function listDocuments(db: SqlDb, f: { docType?: string | null; state?: string | null; from?: string | null; to?: string | null; limit: number; offset: number }): Promise<{ items: Omit<DocView, 'lines' | 'input' | 'snapshot'>[]; total: number }> {
  const where = `($1::text IS NULL OR d.doc_type = $1) AND ($2::text IS NULL OR d.state = $2) AND ($3::date IS NULL OR d.date >= $3::date) AND ($4::date IS NULL OR d.date <= $4::date)`
  const p = [f.docType || null, f.state || null, f.from || null, f.to || null]
  const rows = await db.query<Record<string, unknown>>(
    `SELECT d.*, p.name AS party_name FROM ${T('ab_gst_documents')} d LEFT JOIN ${T('ab_gst_parties')} p ON p.id = d.party_id WHERE ${where} ORDER BY d.date DESC, d.created_on DESC LIMIT $5 OFFSET $6`, [...p, f.limit, f.offset])
  const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T('ab_gst_documents')} d WHERE ${where}`, p)
  return {
    total: Number(total[0].n),
    items: rows.map((r) => {
      const { lines: _l, input: _i, snapshot: _s, ...rest } = toView(r, [], String(r.party_name ?? ''))
      return rest
    }),
  }
}

/* ------------------------------------------------------------------ writing */

export interface Who { userId: string | null; level: Level }

export async function createDraft(db: SqlDb, input: DocInput, who: Who): Promise<DocView> {
  const id = rowUid()
  await db.exec(
    `INSERT INTO ${T('ab_gst_documents')} (id, doc_type, state, date, party_id, input, original_id, reason, notes, created_by, created_on, modified_on) VALUES ($1, $2, 'draft', $3, $4, $5::jsonb, $6, $7, $8, $9, now(), now())`,
    [id, input.docType, input.date, input.partyId, JSON.stringify(input), input.originalId, input.reason, input.notes, who.userId])
  return (await getDocument(db, id))!
}

/** G7.8: only a draft changes */
export async function updateDraft(db: SqlDb, id: string, body: Record<string, unknown>): Promise<DocView> {
  return db.tx(async (tx) => {
    const r = await tx.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_documents')} WHERE id = $1 FOR UPDATE`, [id])
    if (!r.length) throw notFound('Document')
    if (r[0].state !== 'draft') throw conflict(`${DOC_TITLES[r[0].doc_type as DocType]} ${String(r[0].number)} has been issued and cannot be changed. Correct it with a credit note or a debit note.`)
    const input = readDocInput(body, r[0].input as DocInput)
    await tx.exec(`UPDATE ${T('ab_gst_documents')} SET date = $2, party_id = $3, input = $4::jsonb, original_id = $5, reason = $6, notes = $7, modified_on = now() WHERE id = $1`, [id, input.date, input.partyId, JSON.stringify(input), input.originalId, input.reason, input.notes])
    return (await getDocument(tx, id))!
  })
}

export async function deleteDraft(db: SqlDb, id: string): Promise<void> {
  const r = await db.query<{ state: string }>(`SELECT state FROM ${T('ab_gst_documents')} WHERE id = $1`, [id])
  if (!r.length) throw notFound('Document')
  // G7.10: issued documents and their postings are never deleted
  if (r[0].state !== 'draft') throw conflict('An issued document cannot be deleted. Cancel it or correct it with a credit or debit note.')
  await db.exec(`DELETE FROM ${T('ab_gst_documents')} WHERE id = $1 AND state = 'draft'`, [id])
}

/** issue: figures, number, lines, journal and the frozen snapshot commit together or not at all */
export async function issueDocument(db: SqlDb, id: string, who: Who): Promise<DocView> {
  return db.tx(async (tx) => {
    const r = await tx.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_documents')} WHERE id = $1 FOR UPDATE`, [id])
    if (!r.length) throw notFound('Document')
    if (r[0].state !== 'draft') throw conflict('This document has been issued already.')
    const input = r[0].input as DocInput
    // the original of a note is locked, so two notes cannot both take what it still has (G5.12)
    if (input.originalId) await tx.query(`SELECT 1 FROM ${T('ab_gst_documents')} WHERE id = $1 FOR UPDATE`, [input.originalId])
    await assertPostable(tx, input.date, who.level, 'issue a document')
    const p = await prepare(tx, input, id)
    const all = await listSeries(tx)
    const series = input.seriesId ? all.find((x) => x.id === input.seriesId && x.docType === input.docType && x.active) : all.find((x) => x.docType === input.docType && x.isDefault && x.active)
    if (!series) throw invalid(input.seriesId ? 'The number series does not exist for this kind of document.' : `There is no default number series for a ${DOC_TITLES[input.docType].toLowerCase()}. Set up the books in Accounts > Settings.`, 'seriesId')
    // G7.2b / G7.6: a number is never back-dated within its series
    const later = await tx.query<{ date: string; number: string }>(`SELECT date, number FROM ${T('ab_gst_documents')} WHERE series_id = $1 AND fy = $2 AND date > $3::date ORDER BY date DESC LIMIT 1`, [series.id, p.fy, input.date])
    if (later.length) throw invalid(`${later[0].number} of this series is dated ${later[0].date}. A number cannot be back-dated: use that date or a later one.`, 'date')
    // G7.6: the number is taken here, inside the transaction (the counter row stays locked until commit)
    const c = await tx.query<{ v: number }>(
      `INSERT INTO ${T('ab_gst_series_counters')} (series_id, fy, last_value) VALUES ($1, $2, 1) ON CONFLICT (series_id, fy) DO UPDATE SET last_value = ${T('ab_gst_series_counters')}.last_value + 1 RETURNING last_value AS v`, [series.id, p.fy])
    const number = seriesNumber(series, p.fyShort, Number(c[0].v))
    for (const [i, l] of p.lines.entries()) {
      await tx.exec(
        `INSERT INTO ${T('ab_gst_document_lines')} (document_id, line_no, item_id, description, kind, hsn, uqc, quantity, unit_price, supply_class, gross, discount, charges, taxable, igst_rate, cgst_rate, sgst_rate, cess_rate, cgst, sgst, igst, cess, taxed, reverse_charge, itc, itc_reason, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
        [id, i + 1, l.itemId, l.description, l.kind, l.hsn, l.uqc, l.quantity, l.unitPrice, l.supplyClass, l.gross, l.discount, l.charges, l.taxable, l.igstRate, l.cgstRate, l.sgstRate, l.cessRate, l.cgst, l.sgst, l.igst, l.cess, l.taxed, l.reverseCharge, l.itc, l.itcReason, l.accountId])
    }
    const acct = await accountsByKey(tx)
    const journal = await postJournal(tx, {
      date: input.date, narration: `${DOC_TITLES[input.docType]} ${number}${p.snapshot.party ? `, ${p.snapshot.party.name}` : ''}`, sourceKind: 'document', sourceId: id,
      lines: postingLines(p.posting).map((l) => ({ accountId: l.accountId || acct(l.key), partyId: l.party ? input.partyId : null, debit: l.debit, credit: l.credit, memo: l.memo })),
    }, who)
    try {
      await tx.exec(
        `UPDATE ${T('ab_gst_documents')} SET state = 'issued', number = $2, series_id = $3, fy = $4, snapshot = $5::jsonb, place_of_supply = $6, tax_kind = $7, supply_type = $8, reverse_charge = $9,
                taxable = $10, cgst = $11, sgst = $12, igst = $13, cess = $14, round_off = $15, total = $16, journal_id = $17, issued_by = $18, issued_on = now(), modified_on = now() WHERE id = $1`,
        [id, number, series.id, p.fy, JSON.stringify(p.snapshot), p.placeOfSupply, p.taxKind, p.supplyType, p.lines.some((l) => l.reverseCharge), p.totals.taxable, p.totals.cgst, p.totals.sgst, p.totals.igst, p.totals.cess, p.totals.roundOff, p.totals.total, journal.id, who.userId])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict(`The number ${number} exists already in ${p.fy} (numbers are unique per financial year, whatever the letter case). Change the series.`)
      throw e
    }
    return (await getDocument(tx, id))!
  })
}

/** G7.9 */
export async function cancelDocument(db: SqlDb, id: string, o: { date: string; reason: string }, who: Who): Promise<DocView> {
  if (!o.reason.trim()) throw invalid('Give the reason for the cancellation.', 'reason')
  return db.tx(async (tx) => {
    const r = await tx.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_documents')} WHERE id = $1 FOR UPDATE`, [id])
    if (!r.length) throw notFound('Document')
    const d = r[0]
    if (d.state === 'draft') throw invalid('A draft is deleted, not cancelled.')
    if (d.state === 'cancelled') throw conflict('This document is cancelled already.')
    if (d.irn) throw conflict('This document has an IRN: it cannot be cancelled here. Issue a credit note.')
    if (d.payment_status) throw conflict('This document has a payment recorded: it cannot be cancelled. Issue a credit note.')
    if ((await tx.query(`SELECT 1 FROM ${T('ab_gst_documents')} WHERE original_id = $1 AND state <> 'draft' AND state <> 'cancelled' LIMIT 1`, [id])).length) throw conflict('A later note or voucher refers to this document: it cannot be cancelled.')
    // the document's own period must be open, and the reversal is dated in an open period too
    await assertPostable(tx, String(d.date), who.level, 'cancel a document')
    if (o.date < String(d.date)) throw invalid('The cancellation cannot be dated before the document.', 'date')
    const j = await reverseJournal(tx, String(d.journal_id), { date: o.date, reason: `cancelled: ${o.reason}`.slice(0, 300), force: true }, who)
    await tx.exec(`UPDATE ${T('ab_gst_documents')} SET state = 'cancelled', cancel_journal_id = $2, cancelled_on = now(), cancelled_by = $3, cancel_reason = $4, modified_on = now() WHERE id = $1`, [id, j.id, who.userId, o.reason.slice(0, 300)])
    return (await getDocument(tx, id))!
  })
}

/**
 * G7.8, G8.3, G8.6: what may still be entered on an issued document: the IRN with its acknowledgement and QR text
 * (once), the e-way bill, vehicle and transporter, the payment status, internal notes. Returns the changed fields.
 */
export async function recordOnIssued(db: SqlDb, id: string, b: Record<string, unknown>): Promise<{ doc: DocView; changed: string[] }> {
  return db.tx(async (tx) => {
    const r = await tx.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_documents')} WHERE id = $1 FOR UPDATE`, [id])
    if (!r.length) throw notFound('Document')
    const d = r[0]
    if (d.state !== 'issued') throw conflict(d.state === 'draft' ? 'Issue the document first.' : 'A cancelled document cannot be changed.')
    const set: Record<string, unknown> = {}
    if (b.irn !== undefined) {
      if (d.irn) throw conflict('The IRN of this document has been entered already and cannot be changed.', 'irn')
      const irn = text(b.irn, 64)
      if (!/^[0-9a-fA-F]{64}$/.test(irn)) throw invalid('An IRN is 64 characters (0-9, a-f), as shown by the invoice registration portal.', 'irn')
      set.irn = irn.toLowerCase()
      set.irn_ack_no = text(b.irnAckNo, 30) || null
      if (!set.irn_ack_no) throw invalid('Enter the acknowledgement number with the IRN.', 'irnAckNo')
      set.irn_ack_date = dateOf(b.irnAckDate, 'Acknowledgement date', 'irnAckDate')
      set.irn_qr = text(b.irnQr, 4000) || null
    }
    if (b.ewayNo !== undefined) {
      const n = text(b.ewayNo, 12)
      if (n && !/^\d{12}$/.test(n)) throw invalid('An e-way bill number is 12 digits.', 'ewayNo')
      set.eway_no = n || null
      set.eway_date = n ? dateOf(b.ewayDate, 'E-way bill date', 'ewayDate') : null
      set.eway_valid_until = n ? optionalDate(b.ewayValidUntil, 'E-way bill validity date', 'ewayValidUntil') : null
    }
    if (b.vehicleNo !== undefined) set.vehicle_no = text(b.vehicleNo, 20) || null
    if (b.transporterId !== undefined) set.transporter_id = text(b.transporterId, 20) || null
    if (b.paymentStatus !== undefined) set.payment_status = oneOf(b.paymentStatus === null ? '' : b.paymentStatus, ['', 'unpaid', 'part-paid', 'paid'], 'Payment status', 'paymentStatus')
    if (b.notes !== undefined) set.notes = text(b.notes, 2000)
    const keys = Object.keys(set)
    if (!keys.length) throw invalid('Nothing to record.')
    await tx.exec(`UPDATE ${T('ab_gst_documents')} SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')}, modified_on = now() WHERE id = $1`, [id, ...keys.map((k) => set[k])])
    return { doc: (await getDocument(tx, id))!, changed: keys }
  })
}
