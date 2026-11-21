/**
 * The GST rules of the ledger package as PURE functions (no database, no clock). Functional specification:
 * docs/plan/gst-spec-draft.md, a DRAFT that no accountant has reviewed; every rule here cites its number there (G3.4,
 * G5.6, W7 ...) so a correction is a small change in one place. Nothing in this file is a statement of law.
 *
 *   determineSupply      section 3: place of supply and tax type from the decision table T1 to T13; STOP cases throw
 *   findRate             section 4: the rate row for an HSN/SAC code on a date (longest prefix, effective dates)
 *   computeDocument      section 5: discounts, charges, tax-inclusive prices, tax per line or per rate, round-off
 *   the small rules      numbering (G7.6), HSN digits (G7.7), credit note deadline (G5.17), consignment value (G8.5),
 *                        e-invoice class (G8.3), composition tax (G6.7), GSTIN shape (G2.6), financial year (G9.9)
 *
 * Rates, States, thresholds and dates are DATA passed in by the caller (server/core/gst/reference.ts reads them from
 * the dated tables). No rate, State code or threshold is written in this file.
 */
import { RATE_SCALE, QTY_SCALE, PRICE_SCALE, apportion, exclusiveOf, lineGross, paise, parseDecimal, percentOf, roundToRupee, type Paise } from './money.ts'

/* ------------------------------------------------------------------ vocabulary */

/** G2.2: registration types of the business; the last group is recognised but refused (STOP) */
export const BUSINESS_REG_TYPES = ['regular', 'composition', 'composition-services', 'unregistered'] as const
export const BUSINESS_REG_STOP = ['sez_unit', 'sez_developer', 'casual', 'non_resident', 'isd', 'tds_deductor', 'tcs_collector', 'uin_holder'] as const
export type BusinessRegType = (typeof BUSINESS_REG_TYPES)[number] | (typeof BUSINESS_REG_STOP)[number]
/** G2.5: registration types of a customer or supplier */
export const PARTY_REG_TYPES = ['regular', 'composition', 'sez_unit', 'sez_developer', 'uin', 'unregistered', 'overseas'] as const
export type PartyRegType = (typeof PARTY_REG_TYPES)[number]
/** G2.10 */
export const SUPPLY_CLASSES = ['taxable', 'nil-rated', 'exempt', 'zero-rated-capable', 'non-gst'] as const
export type SupplyClass = (typeof SUPPLY_CLASSES)[number]
export type ItemKind = 'goods' | 'service'
/** how a document is taxed: CGST + SGST/UTGST, IGST, zero-rated (IGST 0 with the endorsement), or no tax shown at all */
export type TaxKind = 'intra' | 'inter' | 'zero' | 'none'

/** the software refuses to compute and says why (G1.2, G3.9, G4.3, G4.9) */
export class StopError extends Error {
  rule: string
  constructor(rule: string, message: string) {
    super(message)
    this.rule = rule
  }
}
const posStop = (rule: string, reason: string) => new StopError(rule, `Place of supply needs the accountant: ${reason}`)

/* ------------------------------------------------------------------ dates and the financial year */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
const pad2 = (n: number) => String(n).padStart(2, '0')

export interface FinancialYear { start: string; end: string; name: string; short: string }
/** G9.9: the financial year of a date; the start month is data (threshold `financial_year_start_month`, 4 in the draft) */
export function financialYearOf(date: string, startMonth: number): FinancialYear {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const sy = m >= startMonth ? y : y - 1
  const start = `${sy}-${pad2(startMonth)}-01`
  const end = addDays(`${sy + 1}-${pad2(startMonth)}-01`, -1)
  const two = (n: number) => pad2(n % 100)
  return startMonth === 1
    ? { start, end, name: String(sy), short: String(sy) }
    : { start, end, name: `${sy}-${two(sy + 1)}`, short: `${two(sy)}-${two(sy + 1)}` }
}
/** the calendar months of a financial year (G9.10: periods are calendar months) */
export function monthsOf(fy: FinancialYear): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = []
  let y = Number(fy.start.slice(0, 4))
  let m = Number(fy.start.slice(5, 7))
  for (let i = 0; i < 12; i++) {
    const start = `${y}-${pad2(m)}-01`
    m += 1
    if (m > 12) { m = 1; y += 1 }
    out.push({ start, end: addDays(`${y}-${pad2(m)}-01`, -1) })
  }
  return out
}

/** a dated reference row applies on `date` (inclusive both ends; open-ended when `effectiveTo` is blank) */
export const isEffective = (row: { effectiveFrom: string; effectiveTo?: string | null }, date: string): boolean =>
  row.effectiveFrom <= date && (!row.effectiveTo || row.effectiveTo >= date)

/* ------------------------------------------------------------------ GSTIN (G2.6) */

/**
 * G2.6: only the length, the character set and the State code prefix are checked. The check character is NOT
 * verified (draft Q31: unconfirmed). Returns the problem in plain words, or null.
 */
export function gstinProblem(gstin: string, stateCode?: string | null): string | null {
  if (gstin.length !== 15) return 'A GSTIN has 15 characters.'
  if (!/^[0-9A-Z]{15}$/.test(gstin)) return 'A GSTIN has only digits and capital letters.'
  if (!/^\d{2}/.test(gstin)) return 'A GSTIN starts with the two-digit State code.'
  if (stateCode && gstin.slice(0, 2) !== stateCode) return `The GSTIN starts with ${gstin.slice(0, 2)} but the State code is ${stateCode}.`
  return null
}

/* ------------------------------------------------------------------ section 3: place of supply and tax type */

export interface StateInfo { code: string; name: string; usesUtgst: boolean }

export interface SupplyInput {
  /** the business's State (its registration, G2.1) */
  supplierState: string
  /** kinds of the lines of the document (a document may mix goods and services only when they give one answer) */
  lineKinds: { kind: ItemKind; posCategory: string }[]
  recipient: {
    regType: PartyRegType
    /** the State on its GSTIN or billing address; blank when not recorded */
    state?: string | null
    /** ISO country of the billing address; blank or 'IN' = India */
    country?: string | null
  }
  /** State of the delivery (ship-to) address when one is given */
  shipToState?: string | null
  /** country of the ship-to address; blank or 'IN' = India */
  shipToCountry?: string | null
  /** goods are delivered to another person on the direction of the bill-to party (T3) */
  billToShipTo?: boolean
  /** "movement of goods: yes / no"; 'unknown' is a STOP (G3.9) */
  goodsMove?: 'yes' | 'no' | 'unknown'
  /** goods assembled or installed at a site (T13) with the site's State */
  installedAtSite?: boolean
  siteState?: string | null
  /** the State of the unregistered recipient is recorded on the document (T4 / T8); false: no address (T5 / T9) */
  addressRecorded?: boolean
  /** zero-rated form asked for (T10 optional, T11, T12) */
  zeroRated?: 'lut' | 'with_payment' | null
  /** the registration has an LUT entry for the document's financial year (G3.7) */
  lutValid?: boolean
  /** the user confirmed "conditions of export of services are met" (G3.8) */
  exportConditionsConfirmed?: boolean
  /** special situations that are always STOP (G3.9, G7.2b) */
  flags?: { continuousSupply?: boolean; saleOnApproval?: boolean; onBoardConveyance?: boolean; importOrBonded?: boolean }
  /** manual place of supply: only when an administrator enabled it, with a reason (G3.9) */
  manual?: { state: string; reason: string } | null
  manualAllowed?: boolean
}

export interface SupplyResult {
  /** decision table row (T1..T13) or 'manual' */
  rule: string
  /** place of supply: a State code, or 'OTHER' for outside India (G3.10: the code to print is data, threshold text `other_country_code`) */
  placeOfSupply: string
  tax: TaxKind
  /** intra-State in a Union territory that uses UTGST (G3.4) */
  utgst: boolean
  /** zero-rated: which endorsement of G7.2 */
  zeroRated: 'lut' | 'with_payment' | null
  sez: boolean
}

const abroad = (c?: string | null): boolean => !!c && c.toUpperCase() !== 'IN'
const SEZ: PartyRegType[] = ['sez_unit', 'sez_developer']

/**
 * The decision table of draft section 3.4. Throws StopError for every STOP case (the caller shows the message and
 * issues nothing). `states` is the dated State list valid on the document date.
 */
export function determineSupply(inp: SupplyInput, states: StateInfo[]): SupplyResult {
  const state = (code: string | null | undefined, what: string): StateInfo => {
    const s = states.find((x) => x.code === code)
    if (!s) throw new StopError('G2.7', code ? `There is no State with code ${code} in the reference data on this date (${what}).` : `${what} has no State.`)
    return s
  }
  const supplier = state(inp.supplierState, 'the business registration')
  const f = inp.flags ?? {}
  if (f.continuousSupply) throw new StopError('G7.2b', 'Continuous supply is not handled: it needs the accountant.')
  if (f.saleOnApproval) throw new StopError('G7.2b', 'Goods sent on approval are not handled: they need the accountant.')
  if (f.onBoardConveyance) throw posStop('G3.9', 'supplies on board a conveyance.')
  if (f.importOrBonded) throw posStop('G3.9', 'imported goods and bonded warehouse transactions.')
  if (!inp.lineKinds.length) throw new StopError('G5.5', 'The document has no lines.')
  const sez = SEZ.includes(inp.recipient.regType)
  const finish = (rule: string, pos: string, zero: SupplyResult['zeroRated'] = null): SupplyResult => {
    if (pos === 'OTHER') return { rule, placeOfSupply: pos, tax: 'zero', utgst: false, zeroRated: zero ?? 'lut', sez }
    const p = state(pos, 'the place of supply')
    // T10: SEZ is always inter-State (IGST), also inside the supplier's State
    if (sez) return { rule: 'T10', placeOfSupply: p.code, tax: zero === 'lut' ? 'zero' : 'inter', utgst: false, zeroRated: zero ?? 'with_payment', sez }
    const intra = p.code === supplier.code
    return { rule, placeOfSupply: p.code, tax: intra ? 'intra' : 'inter', utgst: intra && p.usesUtgst, zeroRated: null, sez }
  }

  if (inp.manual) {
    if (!inp.manualAllowed) throw new StopError('G3.9', 'A manual place of supply is switched off. An Accounts administrator can allow it in the settings.')
    if (!inp.manual.reason.trim()) throw new StopError('G3.9', 'A manual place of supply needs a reason.')
    return finish('manual', inp.manual.state, sez && inp.zeroRated === 'lut' ? 'lut' : null)
  }

  // G3.7: the zero-rated form needs an LUT entry for the financial year
  const lut = (): 'lut' => {
    if (!inp.lutValid) throw new StopError('G3.7', 'A supply without payment of integrated tax needs an LUT entry for this financial year in the business registration.')
    return 'lut'
  }
  const sezZero = (): SupplyResult['zeroRated'] => (sez ? (inp.zeroRated === 'lut' ? lut() : 'with_payment') : null)

  const one = (kind: ItemKind, posCategory: string): SupplyResult => {
    const r = inp.recipient
    if (kind === 'service') {
      // G3.9: every special category of s.12(3) to (14) and s.13(3) to (13)
      if (posCategory && posCategory !== 'general') throw posStop('G3.9', `services in the "${posCategory}" category have a special place of supply rule.`)
      if (r.regType === 'overseas' || abroad(r.country)) {
        if (!inp.exportConditionsConfirmed) throw new StopError('G3.8', 'Confirm that the conditions of export of services are met, or ask the accountant.')
        return finish('T12', 'OTHER', lut())
      }
      if (r.regType !== 'unregistered') return finish('T7', state(r.state, 'the recipient').code, sezZero())
      return inp.addressRecorded && r.state ? finish('T8', r.state) : finish('T9', supplier.code)
    }
    // goods
    if (inp.goodsMove === 'unknown' || !inp.goodsMove) throw posStop('G3.9', 'say whether the goods move (yes or no).')
    if (abroad(inp.shipToCountry)) {
      if (inp.billToShipTo && !abroad(r.country) && r.regType !== 'overseas') throw posStop('G3.9', 'bill-to / ship-to where the delivery is outside India.')
      // T11: exports with payment of IGST are out of scope (G1.11)
      if (inp.zeroRated === 'with_payment') throw new StopError('G1.11', 'Exports with payment of integrated tax are not handled by this version.')
      return finish('T11', 'OTHER', lut())
    }
    if (r.regType === 'overseas' || abroad(r.country)) throw posStop('G3.9', 'goods for a recipient outside India that are delivered in India.')
    if (inp.installedAtSite) return finish('T13', state(inp.siteState, 'the installation site').code, sezZero())
    if (r.regType === 'unregistered') return inp.addressRecorded && r.state ? finish('T4', r.state) : finish('T5', supplier.code)
    if (inp.billToShipTo) return finish('T3', state(r.state, 'the bill-to party').code, sezZero())
    if (inp.goodsMove === 'no') return finish('T6', supplier.code, sezZero())
    const delivery = state(inp.shipToState || r.state, 'the delivery address').code
    return finish(delivery === supplier.code ? 'T1' : 'T2', delivery, sezZero())
  }

  const results = inp.lineKinds.map((l) => one(l.kind, l.posCategory))
  const first = results[0]
  if (results.some((r) => r.placeOfSupply !== first.placeOfSupply || r.tax !== first.tax)) {
    throw new StopError('G3.4', 'The lines of this document have different places of supply. Issue separate documents for the goods and the services.')
  }
  return first
}

/* ------------------------------------------------------------------ section 4: rates */

export interface RateRow {
  id?: string
  code: string
  kind: ItemKind
  condition: string
  igst: string
  cgst: string
  sgst: string
  cessAdValorem?: string | null
  cessSpecificAmount?: string | null
  effectiveFrom: string
  effectiveTo?: string | null
  source?: string
}
const rate = (v: unknown, what: string): bigint => {
  const r = parseDecimal(v ?? '0', RATE_SCALE, what)
  if (r < 0n || r > 100n * 10n ** BigInt(RATE_SCALE)) throw new StopError('G4.1', `${what} must be between 0 and 100.`)
  return r
}

/** G4.2: a rate row's own problems (null when fine): CGST + SGST/UTGST = IGST, a source, sane dates */
export function rateRowProblem(r: RateRow): string | null {
  try {
    if (!/^[0-9]{2,8}$/.test(r.code)) return 'The HSN or SAC code is 2 to 8 digits.'
    if (rate(r.cgst, 'CGST rate') + rate(r.sgst, 'SGST/UTGST rate') !== rate(r.igst, 'IGST rate')) return 'CGST rate + SGST/UTGST rate must equal the IGST rate.'
    if (r.cessAdValorem) rate(r.cessAdValorem, 'Cess rate')
  } catch (e) {
    return (e as Error).message
  }
  if (!isDate(r.effectiveFrom)) return 'Effective from is a date.'
  if (r.effectiveTo && (!isDate(r.effectiveTo) || r.effectiveTo < r.effectiveFrom)) return 'Effective to is a date on or after effective from.'
  if (!r.source?.trim()) return 'Every rate row needs its source (notification number, date, schedule and serial number).'
  return null
}
/** G4.2: two rows for the same code and condition may not overlap in time */
export const ratesOverlap = (a: RateRow, b: RateRow): boolean =>
  a.code === b.code && a.kind === b.kind && (a.condition || '') === (b.condition || '') && a.effectiveFrom <= (b.effectiveTo || '9999-12-31') && b.effectiveFrom <= (a.effectiveTo || '9999-12-31')

/**
 * G4.3: the rate for a line. The item's rate reference (a code) and condition at `date`; the longest matching code
 * prefix wins; no match is a STOP. A specific (per unit) cess is a STOP until the method is confirmed (G4.9).
 */
export function findRate(rates: RateRow[], code: string, condition: string, date: string, kind?: ItemKind): RateRow {
  let best: RateRow | null = null
  for (const r of rates) {
    if (!code.startsWith(r.code) || (r.condition || '') !== (condition || '') || !isEffective(r, date)) continue
    if (kind && r.kind !== kind) continue
    if (!best || r.code.length > best.code.length) best = r
  }
  if (!best) throw new StopError('G4.3', `No approved rate for HSN/SAC ${code || '(blank)'} on ${date}.`)
  if (best.cessSpecificAmount && parseDecimal(best.cessSpecificAmount, 4, 'Specific cess') !== 0n) {
    throw new StopError('G4.9', `HSN/SAC ${best.code} carries a specific (per unit) cess, which this version does not compute.`)
  }
  return best
}

/** G4.4: the document date is within `days` after a rate change for this code (the user confirms the rate date) */
export function nearRateChange(rates: RateRow[], code: string, condition: string, date: string, days: number): boolean {
  return rates.some((r) => code.startsWith(r.code) && (r.condition || '') === (condition || '') && r.effectiveFrom <= date && addDays(r.effectiveFrom, days) >= date
    && rates.some((o) => o !== r && o.code === r.code && (o.condition || '') === (r.condition || '') && o.effectiveTo && addDays(o.effectiveTo, 1) === r.effectiveFrom))
}

/* ------------------------------------------------------------------ section 5: calculation and rounding */

export interface CalcRate { igst: string; cgst: string; sgst: string; cess?: string | null }
export interface CalcLine {
  quantity: string
  unitPrice: string
  /** a percentage, or an amount; not both (G5.5) */
  discountPercent?: string | null
  discountAmount?: string | null
  supplyClass: SupplyClass
  /** required for lines that carry tax */
  rate?: CalcRate | null
}
export interface CalcCharge {
  amount: string
  /** index of the goods line it belongs to; absent = the whole document (G4.15) */
  line?: number | null
}
export interface CalcInput {
  lines: CalcLine[]
  charges?: CalcCharge[]
  /** document-level discount amount (G4.13) */
  documentDiscount?: string | null
  /** prices include tax (G4.16) */
  taxInclusive?: boolean
  /** G5.6: tax per line (default) or once per rate per document */
  taxMode?: 'line' | 'document'
  /** G5.7: round the payable total to the rupee */
  roundOff?: boolean
  tax: TaxKind
}
export interface CalcLineOut {
  gross: Paise
  discount: Paise
  documentDiscount: Paise
  charges: Paise
  /** G5.5: the taxable value (for lines without tax: their value) */
  taxable: Paise
  cgst: Paise
  sgst: Paise
  igst: Paise
  cess: Paise
  /** this line carries tax on this document */
  taxed: boolean
}
export interface CalcTotals { taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise; cess: Paise; tax: Paise; exact: Paise; roundOff: Paise; total: Paise }
export interface CalcOutput { lines: CalcLineOut[]; totals: CalcTotals }

const carriesTax = (c: SupplyClass): boolean => c === 'taxable' || c === 'zero-rated-capable'
const sum = (xs: Paise[]): Paise => xs.reduce((a, b) => a + b, 0)

/**
 * Section 5.2 of the draft. Order per line: gross (G5.5) -> line discount -> document discount share (G4.13) ->
 * charges (G4.15) -> taxable value (for tax-inclusive prices by G4.16) -> each tax component from the taxable value
 * (G5.6, G5.8: never a split of a total). Totals by G5.7.
 */
export function computeDocument(inp: CalcInput): CalcOutput {
  if (!inp.lines.length) throw new StopError('G5.5', 'The document has no lines.')
  const base = inp.lines.map((l, i) => {
    const n = `Line ${i + 1}`
    const qty = parseDecimal(l.quantity, QTY_SCALE, `${n}: quantity`)
    const price = parseDecimal(l.unitPrice, PRICE_SCALE, `${n}: unit price`)
    if (qty <= 0n) throw new StopError('G5.5', `${n}: the quantity must be more than zero.`)
    if (price < 0n) throw new StopError('G5.5', `${n}: the unit price cannot be negative.`)
    const gross = lineGross(qty, price)
    const hasPct = l.discountPercent !== undefined && l.discountPercent !== null && l.discountPercent !== ''
    const hasAmt = l.discountAmount !== undefined && l.discountAmount !== null && l.discountAmount !== ''
    if (hasPct && hasAmt) throw new StopError('G5.5', `${n}: give the discount as a percentage or as an amount, not both.`)
    const discount = hasPct ? percentOf(gross, rate(l.discountPercent, `${n}: discount percent`)) : hasAmt ? paise(l.discountAmount, `${n}: discount`) : 0
    if (discount < 0 || discount > gross) throw new StopError('G5.5', `${n}: the discount cannot be negative or more than the line value.`)
    const taxed = (inp.tax === 'intra' || inp.tax === 'inter') && carriesTax(l.supplyClass)
    if (taxed && !l.rate) throw new StopError('G4.3', `${n}: no rate.`)
    const r = taxed
      ? { igst: rate(l.rate!.igst, `${n}: IGST rate`), cgst: rate(l.rate!.cgst, `${n}: CGST rate`), sgst: rate(l.rate!.sgst, `${n}: SGST/UTGST rate`), cess: rate(l.rate!.cess ?? '0', `${n}: cess rate`) }
      : { igst: 0n, cgst: 0n, sgst: 0n, cess: 0n }
    if (taxed && r.cgst + r.sgst !== r.igst) throw new StopError('G4.2', `${n}: CGST rate + SGST/UTGST rate must equal the IGST rate.`)
    return { gross, discount, value: gross - discount, taxed, r, carries: carriesTax(l.supplyClass) }
  })

  // G4.13: the document discount is spread over the taxable lines by value (all lines when none carries tax)
  const docDisc = inp.documentDiscount ? paise(inp.documentDiscount, 'Document discount') : 0
  if (docDisc < 0) throw new StopError('G4.13', 'The document discount cannot be negative.')
  const pool = base.some((b) => b.carries) ? base.map((b) => (b.carries ? b.value : 0)) : base.map((b) => b.value)
  if (docDisc > sum(pool)) throw new StopError('G4.13', 'The document discount is more than the value of the lines.')
  const discShare = apportion(docDisc, pool)

  // G4.15: a charge linked to a line joins that line; a whole-document charge is apportioned by value
  const chargeShare = base.map(() => 0)
  for (const [i, c] of (inp.charges ?? []).entries()) {
    const amt = paise(c.amount, `Charge ${i + 1}`)
    if (amt < 0) throw new StopError('G4.15', `Charge ${i + 1} cannot be negative.`)
    if (c.line !== undefined && c.line !== null) {
      if (!Number.isInteger(c.line) || c.line < 0 || c.line >= base.length) throw new StopError('G4.15', `Charge ${i + 1} is linked to a line that does not exist.`)
      chargeShare[c.line] += amt
    } else apportion(amt, base.map((b) => b.value)).forEach((s, j) => { chargeShare[j] += s })
  }

  const mode = inp.taxMode ?? 'line'
  const lines: CalcLineOut[] = base.map((b, i) => {
    const amount = b.value - discShare[i] + chargeShare[i]
    // G4.16: tax-inclusive: taxable = round2(inclusive / (1 + total rate / 100)); taxes are then computed forward
    const taxable = inp.taxInclusive && b.taxed ? exclusiveOf(amount, b.r.igst + b.r.cess) : amount
    const t = { cgst: 0, sgst: 0, igst: 0, cess: 0 }
    if (b.taxed && mode === 'line') {
      // G5.6 / G5.8: each component from the taxable value at its own rate
      if (inp.tax === 'intra') { t.cgst = percentOf(taxable, b.r.cgst); t.sgst = percentOf(taxable, b.r.sgst) } else t.igst = percentOf(taxable, b.r.igst)
      t.cess = percentOf(taxable, b.r.cess)
    }
    return { gross: b.gross, discount: b.discount, documentDiscount: discShare[i], charges: chargeShare[i], taxable, ...t, taxed: b.taxed }
  })

  if (mode === 'document') {
    // G5.6 alternative: per rate per document; the group's tax is then shared out to its lines for the registers
    const groups = new Map<string, number[]>()
    base.forEach((b, i) => { if (b.taxed) groups.set(`${b.r.igst}|${b.r.cgst}|${b.r.sgst}|${b.r.cess}`, [...(groups.get(`${b.r.igst}|${b.r.cgst}|${b.r.sgst}|${b.r.cess}`) ?? []), i]) })
    for (const idx of groups.values()) {
      const r = base[idx[0]].r
      const w = idx.map((i) => lines[i].taxable)
      const total = sum(w)
      const put = (k: 'cgst' | 'sgst' | 'igst' | 'cess', pct: bigint) => apportion(percentOf(total, pct), w).forEach((s, j) => { lines[idx[j]][k] = s })
      if (inp.tax === 'intra') { put('cgst', r.cgst); put('sgst', r.sgst) } else put('igst', r.igst)
      put('cess', r.cess)
    }
  }

  // G5.7
  const totals: CalcTotals = { taxable: sum(lines.map((l) => l.taxable)), cgst: sum(lines.map((l) => l.cgst)), sgst: sum(lines.map((l) => l.sgst)), igst: sum(lines.map((l) => l.igst)), cess: sum(lines.map((l) => l.cess)), tax: 0, exact: 0, roundOff: 0, total: 0 }
  totals.tax = totals.cgst + totals.sgst + totals.igst + totals.cess
  totals.exact = totals.taxable + totals.tax
  // G4.16: with tax-inclusive prices the customer's inclusive amount is the target; the few paise go to the round-off
  const target = inp.taxInclusive ? sum(base.map((b, i) => b.value - discShare[i] + chargeShare[i])) : totals.exact
  totals.total = inp.roundOff === false ? target : roundToRupee(target)
  totals.roundOff = totals.total - totals.exact
  return { lines, totals }
}

/* ------------------------------------------------------------------ documents: kind, numbering, HSN, deadlines */

export const DOC_TYPES = ['tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note', 'receipt_voucher', 'refund_voucher', 'payment_voucher', 'purchase_invoice'] as const
export type DocType = (typeof DOC_TYPES)[number]
export const DOC_TITLES: Record<DocType, string> = {
  tax_invoice: 'Tax invoice', bill_of_supply: 'Bill of supply', credit_note: 'Credit note', debit_note: 'Debit note',
  receipt_voucher: 'Receipt voucher', refund_voucher: 'Refund voucher', payment_voucher: 'Payment voucher', purchase_invoice: 'Purchase invoice',
}

/**
 * Which outward document a set of lines may be for this business (G5.9, G6.7, G6.9, G7.3, W12). Returns the problem in
 * plain words, or null. Taxable and exempt lines on one document are refused: rule 46A is unconfirmed (draft Q7).
 */
export function outwardDocumentProblem(type: 'tax_invoice' | 'bill_of_supply', business: BusinessRegType, classes: SupplyClass[], zeroRated: boolean): string | null {
  if ((BUSINESS_REG_STOP as readonly string[]).includes(business)) return `This version issues no tax documents for a business registered as "${business}".`
  if (business === 'unregistered') return 'An unregistered business issues no tax invoice or bill of supply. Use a commercial invoice (not a tax invoice).'
  const composition = business === 'composition' || business === 'composition-services'
  if (composition) {
    if (type !== 'bill_of_supply') return 'A composition taxable person issues a bill of supply, not a tax invoice.'
    if (classes.includes('non-gst')) return 'A composition taxable person may not supply goods or services that are not leviable to GST.'
    return null
  }
  const taxed = classes.filter((c) => c === 'taxable' || c === 'zero-rated-capable').length
  if (type === 'tax_invoice') {
    if (taxed !== classes.length) return 'A tax invoice has only taxable lines. Issue a bill of supply for the exempt, nil-rated and non-GST lines.'
    return null
  }
  if (zeroRated) return 'A zero-rated supply (export or SEZ) is issued as a tax invoice with the endorsement, not as a bill of supply.'
  if (taxed) return 'A bill of supply has only exempt, nil-rated or non-GST lines. Issue a tax invoice for the taxable lines.'
  return null
}

export interface SeriesFormat { prefix: string; suffix: string; padding: number }
const SERIES_CHARS = /^[A-Za-z0-9/-]*$/
/** G7.6: allowed characters and the 16-character limit for the largest counter the padding allows; `{FY}` is the short year (26-27) */
export function seriesProblem(s: SeriesFormat): string | null {
  const fixed = (s.prefix + s.suffix).replace(/\{FY\}/g, '')
  if (!SERIES_CHARS.test(fixed)) return 'A number series may contain letters, digits, the hyphen and the slash only.'
  if (!Number.isInteger(s.padding) || s.padding < 1 || s.padding > 10) return 'The counter has 1 to 10 digits.'
  const length = (s.prefix + s.suffix).replace(/\{FY\}/g, '00-00').length + s.padding
  if (length > 16) return `This series gives numbers of ${length} characters; the limit is 16.`
  return null
}
/** G7.6: the number of a document; refuses a number longer than 16 characters (a counter that outgrew its padding) */
export function seriesNumber(s: SeriesFormat, fyShort: string, counter: number): string {
  const n = `${s.prefix}${String(counter).padStart(s.padding, '0')}${s.suffix}`.replace(/\{FY\}/g, fyShort)
  if (n.length > 16) throw new StopError('G7.6', `The next number of this series (${n}) is longer than 16 characters. Define a shorter series.`)
  return n
}

export interface HsnRule { digitsSmall: number; digitsLarge: number; turnoverLimit: Paise; optionalForUnregistered: boolean }
/**
 * G7.7: digits of HSN/SAC required on a document. `turnover` is the aggregate turnover of the preceding financial year.
 * Returns the number of digits (0: may be omitted).
 */
export function hsnDigitsRequired(rule: HsnRule, turnover: Paise, recipientRegistered: boolean): number {
  if (turnover > rule.turnoverLimit) return rule.digitsLarge
  return !recipientRegistered && rule.optionalForUnregistered ? 0 : rule.digitsSmall
}
export const hsnProblem = (code: string, required: number): string | null =>
  required > 0 && (code.length < required || !/^\d+$/.test(code)) ? `HSN/SAC "${code || '(blank)'}" is shorter than the ${required} digits required.` : null

/**
 * G5.17: the last day a GST credit note may be dated for a supply invoiced on `invoiceDate`. `monthDay` ("11-30") is the
 * dated rule; `override` is the accountant's earlier date for that financial year (the annual return date), if any.
 */
export function creditNoteDeadline(invoiceDate: string, fyStartMonth: number, monthDay: string, override?: string | null): string {
  const fy = financialYearOf(invoiceDate, fyStartMonth)
  const rule = `${fy.end.slice(0, 4)}-${monthDay}`
  const d = rule > fy.end ? rule : `${Number(fy.end.slice(0, 4)) + 1}-${monthDay}`
  return override && override < d ? override : d
}

/**
 * G8.5: consignment value = value of the goods including every tax, excluding exempt goods on a document that has
 * both. Lines: the computed lines of the goods that move.
 */
export function consignmentValue(lines: { kind: ItemKind; taxed: boolean; taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise; cess: Paise }[]): Paise {
  const goods = lines.filter((l) => l.kind === 'goods')
  const mixed = goods.some((l) => l.taxed) && goods.some((l) => !l.taxed)
  return sum(goods.filter((l) => !mixed || l.taxed).map((l) => l.taxable + l.cgst + l.sgst + l.igst + l.cess))
}

/** G8.3: in the e-invoice class when the turnover of ANY financial year before the document's exceeded the threshold */
export function inEinvoiceClass(turnovers: Record<string, Paise>, documentFy: string, threshold: Paise): boolean {
  return Object.entries(turnovers).some(([fy, t]) => fy < documentFy && t > threshold)
}

/** G6.7: composition tax for a period: turnover x the dated rate, each component rounded to the paisa */
export function compositionTax(turnover: Paise, cgstRate: string, sgstRate: string): { cgst: Paise; sgst: Paise } {
  return { cgst: percentOf(turnover, rate(cgstRate, 'Composition CGST rate')), sgst: percentOf(turnover, rate(sgstRate, 'Composition SGST rate')) }
}

/** G5.12: what an invoice still has to credit after earlier credit notes, per component */
export interface Creditable { taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise; cess: Paise }
export function creditProblem(original: Creditable, alreadyCredited: Creditable, note: Creditable): string | null {
  for (const k of ['taxable', 'cgst', 'sgst', 'igst', 'cess'] as const) {
    if (note[k] > original[k] - alreadyCredited[k]) {
      return `This credit note credits more ${k === 'taxable' ? 'taxable value' : k.toUpperCase()} than the original invoice still has (G5.12).`
    }
  }
  return null
}
