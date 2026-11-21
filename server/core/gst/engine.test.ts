/**
 * The GST engine (server/core/gst/engine.ts, money.ts) against docs/plan/gst-spec-draft.md: every worked example of
 * section 5.5 (W1 to W32) with the draft's figures, the decision table of section 3.4, rates by date (section 4) and
 * the small rules. The draft is NOT reviewed by an accountant: these tests pin the software to the draft, they do not
 * say the figures are right in law. State codes and rates below are test data, as in the draft's examples.
 */
import { describe, expect, it } from 'vitest'
import { apportion, decimalText, divRound, exclusiveOf, groupIN, lineGross, paise, parseDecimal, percentOf, roundToRupee, rupees, rupeesIN } from './money.ts'
import {
  StopError, compositionTax, computeDocument, consignmentValue, creditNoteDeadline, creditProblem, determineSupply, financialYearOf, findRate, gstinProblem,
  hsnDigitsRequired, hsnProblem, inEinvoiceClass, monthsOf, nearRateChange, outwardDocumentProblem, rateRowProblem, ratesOverlap, seriesNumber, seriesProblem,
  type CalcInput, type CalcLine, type RateRow, type StateInfo, type SupplyInput,
} from './engine.ts'

const STATES: StateInfo[] = [
  { code: '23', name: 'Madhya Pradesh', usesUtgst: false }, { code: '27', name: 'Maharashtra', usesUtgst: false }, { code: '24', name: 'Gujarat', usesUtgst: false },
  { code: '08', name: 'Rajasthan', usesUtgst: false }, { code: '29', name: 'Karnataka', usesUtgst: false }, { code: '04', name: 'Chandigarh', usesUtgst: true },
]
const R18 = { igst: '18', cgst: '9', sgst: '9' }
const R5 = { igst: '5', cgst: '2.5', sgst: '2.5' }
const R12 = { igst: '12', cgst: '6', sgst: '6' }
const line = (quantity: string, unitPrice: string, rate: CalcLine['rate'] = R18, extra: Partial<CalcLine> = {}): CalcLine => ({ quantity, unitPrice, supplyClass: 'taxable', rate, ...extra })
const calc = (lines: CalcLine[], tax: CalcInput['tax'] = 'intra', extra: Partial<CalcInput> = {}) => computeDocument({ lines, tax, ...extra })
const rs = (p: number) => rupees(p)
const supply = (o: Partial<SupplyInput>): SupplyInput => ({ supplierState: '23', lineKinds: [{ kind: 'goods', posCategory: 'general' }], recipient: { regType: 'regular', state: '23' }, goodsMove: 'yes', ...o })
const stop = (fn: () => unknown): StopError => {
  try { fn() } catch (e) { if (e instanceof StopError) return e; throw e }
  throw new Error('expected a STOP')
}

describe('money (G5.4)', () => {
  it('parses decimals exactly and refuses what it cannot keep', () => {
    expect(parseDecimal('1,250.00', 2)).toBe(125000n)
    expect(parseDecimal('2.525', 3)).toBe(2525n)
    expect(parseDecimal(0.1, 2)).toBe(10n)
    expect(parseDecimal('-0.005', 3)).toBe(-5n)
    expect(() => parseDecimal('1.005', 2)).toThrow(/more than 2 decimals/)
    expect(() => parseDecimal('1e3', 2)).toThrow()
    expect(() => parseDecimal('abc', 2)).toThrow()
    expect(() => parseDecimal(Number.NaN, 2)).toThrow()
    expect(paise('1250')).toBe(125000)
  })
  it('rounds half away from zero', () => {
    expect(divRound(5n, 10n)).toBe(1n)
    expect(divRound(-5n, 10n)).toBe(-1n)
    expect(divRound(4n, 10n)).toBe(0n)
    expect(divRound(15n, 10n)).toBe(2n)
    expect(divRound(-15n, 10n)).toBe(-2n)
    // 0.005 -> 0.01 and -0.005 -> -0.01
    expect(percentOf(1, parseDecimal('50', 3))).toBe(1)
    expect(percentOf(-1, parseDecimal('50', 3))).toBe(-1)
  })
  it('gross, tax-inclusive division, the rupee, text', () => {
    expect(lineGross(parseDecimal('4', 3), parseDecimal('2345.50', 4))).toBe(938200)
    expect(lineGross(parseDecimal('0.333', 3), parseDecimal('10.0005', 4))).toBe(333)
    expect(exclusiveOf(99900, parseDecimal('18', 3))).toBe(84661)
    expect(roundToRupee(982350)).toBe(982400)
    expect(roundToRupee(982349)).toBe(982300)
    expect(rupees(-5)).toBe('-0.05')
    expect(rupeesIN(1000000000)).toBe('1,00,00,000.00')
    expect(rupeesIN(32500000)).toBe('3,25,000.00')
    expect(rupeesIN(99900)).toBe('999.00')
    expect(decimalText(2500n, 3)).toBe('2.5')
    expect(decimalText(18000n, 3)).toBe('18')
  })
  it('apportions with the remainder on the largest share (G4.13)', () => {
    expect(apportion(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(apportion(1000, [300, 700])).toEqual([300, 700])
    expect(apportion(10, [1, 5, 1])).toEqual([1, 8, 1])
    expect(apportion(0, [5, 5])).toEqual([0, 0])
    expect(apportion(50, [0, 0])).toEqual([0, 0])
  })
})

describe('worked examples W1 to W19 (draft 5.5)', () => {
  it('W1 intra-State, one rate', () => {
    const d = calc([line('10', '1250.00')])
    expect([d.totals.taxable, d.totals.cgst, d.totals.sgst, d.totals.igst].map(rs)).toEqual(['12500.00', '1125.00', '1125.00', '0.00'])
    expect([d.totals.exact, d.totals.roundOff, d.totals.total].map(rs)).toEqual(['14750.00', '0.00', '14750.00'])
    expect(determineSupply(supply({}), STATES)).toMatchObject({ rule: 'T1', placeOfSupply: '23', tax: 'intra', utgst: false })
  })
  it('W2 inter-State, one rate', () => {
    expect(determineSupply(supply({ recipient: { regType: 'regular', state: '27' } }), STATES)).toMatchObject({ rule: 'T2', placeOfSupply: '27', tax: 'inter' })
    const d = calc([line('10', '1250.00')], 'inter')
    expect([d.totals.taxable, d.totals.igst, d.totals.cgst, d.totals.total].map(rs)).toEqual(['12500.00', '2250.00', '0.00', '14750.00'])
  })
  it('W3 two rates on one invoice, 59.925 becomes 59.93', () => {
    const d = calc([line('4', '2345.50'), line('3', '799.00', R5)])
    expect(d.lines.map((l) => [rs(l.taxable), rs(l.cgst), rs(l.sgst)])).toEqual([['9382.00', '844.38', '844.38'], ['2397.00', '59.93', '59.93']])
    expect([d.totals.taxable, d.totals.cgst, d.totals.sgst, d.totals.exact, d.totals.roundOff, d.totals.total].map(rs)).toEqual(['11779.00', '904.31', '904.31', '13587.62', '0.38', '13588.00'])
  })
  it('W4 discount on the invoice; fifty paise goes up', () => {
    const d = calc([line('20', '450.00', R18, { discountPercent: '7.5' })])
    expect([d.lines[0].gross, d.lines[0].discount, d.totals.taxable, d.totals.cgst, d.totals.sgst].map(rs)).toEqual(['9000.00', '675.00', '8325.00', '749.25', '749.25'])
    expect([d.totals.exact, d.totals.roundOff, d.totals.total].map(rs)).toEqual(['9823.50', '0.50', '9824.00'])
  })
  it('W5 tax-inclusive price: taxes forward from the taxable value, CGST = SGST', () => {
    const d = calc([line('1', '999.00')], 'intra', { taxInclusive: true })
    expect([d.totals.taxable, d.totals.cgst, d.totals.sgst, d.totals.exact, d.totals.roundOff, d.totals.total].map(rs)).toEqual(['846.61', '76.19', '76.19', '998.99', '0.01', '999.00'])
  })
  it('W6 per line against per rate per document', () => {
    const three = [line('1', '10.10', R5), line('1', '10.10', R5), line('1', '10.10', R5)]
    const a = calc(three)
    expect([a.totals.cgst, a.totals.sgst, a.totals.exact, a.totals.roundOff, a.totals.total].map(rs)).toEqual(['0.75', '0.75', '31.80', '0.20', '32.00'])
    const b = calc(three, 'intra', { taxMode: 'document' })
    expect([b.totals.cgst, b.totals.sgst, b.totals.exact, b.totals.roundOff, b.totals.total].map(rs)).toEqual(['0.76', '0.76', '31.82', '0.18', '32.00'])
    // the document tax is shared out to the lines and still adds up
    expect(b.lines.reduce((s, l) => s + l.cgst, 0)).toBe(76)
  })
  it('W7 exact half paisa: 2.525 becomes 2.53 (binary floating point gives 2.52)', () => {
    const d = calc([line('1', '101.00', R5)])
    expect([d.totals.cgst, d.totals.sgst, d.totals.exact, d.totals.roundOff, d.totals.total].map(rs)).toEqual(['2.53', '2.53', '106.06', '-0.06', '106.00'])
  })
  it('W8 credit note for goods returned, and what the invoice still has', () => {
    const inv = calc([line('10', '1250.00')])
    const cn = calc([line('2', '1250.00')])
    expect([cn.totals.taxable, cn.totals.cgst, cn.totals.sgst, cn.totals.total].map(rs)).toEqual(['2500.00', '225.00', '225.00', '2950.00'])
    const none = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 }
    expect(creditProblem(inv.totals, none, cn.totals)).toBeNull()
    // remaining after it: 10,000.00 / 900.00 / 900.00; a note for 9 more units is too much
    expect(inv.totals.taxable - cn.totals.taxable).toBe(1000000)
    expect(inv.totals.cgst - cn.totals.cgst).toBe(90000)
    expect(creditProblem(inv.totals, cn.totals, calc([line('9', '1250.00')]).totals)).toMatch(/more taxable value/)
    expect(creditProblem(inv.totals, cn.totals, calc([line('8', '1250.00')]).totals)).toBeNull()
  })
  it('W9 credit note for a post-sale discount (inter-State)', () => {
    const d = calc([line('1', '625.00')], 'inter')
    expect([d.totals.taxable, d.totals.igst, d.totals.exact, d.totals.roundOff, d.totals.total].map(rs)).toEqual(['625.00', '112.50', '737.50', '0.50', '738.00'])
  })
  it('W10 debit note for an upward price revision', () => {
    const d = calc([line('10', '50.00')])
    expect([d.totals.taxable, d.totals.cgst, d.totals.sgst, d.totals.total].map(rs)).toEqual(['500.00', '45.00', '45.00', '590.00'])
  })
  it('W11 reverse charge, inward service: tax computed on the supplier value (G5.10)', () => {
    const d = calc([line('1', '25000.00')])
    expect([d.totals.taxable, d.totals.cgst, d.totals.sgst].map(rs)).toEqual(['25000.00', '2250.00', '2250.00'])
  })
  it('W12 exempt and taxable lines: figures, and two documents (rule 46A unconfirmed)', () => {
    const d = calc([line('1', '5000.00'), line('1', '1200.00', R18, { supplyClass: 'exempt', rate: null })])
    expect(d.lines.map((l) => [rs(l.taxable), rs(l.cgst), l.taxed])).toEqual([['5000.00', '450.00', true], ['1200.00', '0.00', false]])
    expect(rs(d.totals.total)).toBe('7100.00')
    expect(outwardDocumentProblem('tax_invoice', 'regular', ['taxable', 'exempt'], false)).toMatch(/only taxable lines/)
    expect(outwardDocumentProblem('bill_of_supply', 'regular', ['taxable', 'exempt'], false)).toMatch(/only exempt/)
    expect(outwardDocumentProblem('tax_invoice', 'regular', ['taxable'], false)).toBeNull()
    expect(outwardDocumentProblem('bill_of_supply', 'regular', ['exempt', 'nil-rated'], false)).toBeNull()
  })
  it('W13 composition: bill of supply without tax; the period tax on turnover', () => {
    const d = calc([line('1', '50000.00')], 'none')
    expect([d.totals.taxable, d.totals.tax, d.totals.total].map(rs)).toEqual(['50000.00', '0.00', '50000.00'])
    expect(outwardDocumentProblem('tax_invoice', 'composition', ['taxable'], false)).toMatch(/bill of supply/)
    expect(outwardDocumentProblem('bill_of_supply', 'composition', ['taxable'], false)).toBeNull()
    expect(outwardDocumentProblem('bill_of_supply', 'composition', ['non-gst'], false)).toMatch(/not leviable/)
    expect(compositionTax(paise('840000.00'), '0.5', '0.5')).toEqual({ cgst: 420000, sgst: 420000 })
  })
  it('W14 export of goods under LUT; with payment of IGST is a STOP', () => {
    const exp = supply({ recipient: { regType: 'overseas', country: 'DE' }, shipToCountry: 'DE', lutValid: true })
    expect(determineSupply(exp, STATES)).toMatchObject({ rule: 'T11', placeOfSupply: 'OTHER', tax: 'zero', zeroRated: 'lut' })
    const d = calc([line('1', '325000.00')], 'zero')
    expect([d.totals.igst, d.totals.total].map(rs)).toEqual(['0.00', '325000.00'])
    expect(stop(() => determineSupply({ ...exp, lutValid: false }, STATES)).rule).toBe('G3.7')
    expect(stop(() => determineSupply({ ...exp, zeroRated: 'with_payment' }, STATES)).rule).toBe('G1.11')
  })
  it('W15 SEZ unit in the same State: IGST, never CGST + SGST', () => {
    const r = determineSupply(supply({ recipient: { regType: 'sez_unit', state: '23' } }), STATES)
    expect(r).toMatchObject({ rule: 'T10', tax: 'inter', zeroRated: 'with_payment', sez: true })
    const d = calc([line('1', '100000.00')], r.tax)
    expect([d.totals.igst, d.totals.cgst, d.totals.total].map(rs)).toEqual(['18000.00', '0.00', '118000.00'])
    // under LUT it is zero-rated, and needs the LUT entry
    expect(determineSupply(supply({ recipient: { regType: 'sez_unit', state: '23' }, zeroRated: 'lut', lutValid: true }), STATES)).toMatchObject({ tax: 'zero', zeroRated: 'lut' })
    expect(stop(() => determineSupply(supply({ recipient: { regType: 'sez_developer', state: '27' }, zeroRated: 'lut' }), STATES)).rule).toBe('G3.7')
  })
  it('W16 advance for services treated as tax-inclusive', () => {
    const d = calc([line('1', '118000.00')], 'intra', { taxInclusive: true })
    expect([d.totals.taxable, d.totals.cgst, d.totals.sgst, d.totals.total].map(rs)).toEqual(['100000.00', '9000.00', '9000.00', '118000.00'])
    const full = calc([line('1', '200000.00')])
    expect([full.totals.cgst, full.totals.sgst].map(rs)).toEqual(['18000.00', '18000.00'])
  })
  it('W17 freight linked to the goods line joins its taxable value', () => {
    const d = calc([line('1', '40000.00')], 'intra', { charges: [{ amount: '1500.00', line: 0 }] })
    expect([d.totals.taxable, d.totals.cgst, d.totals.sgst, d.totals.total].map(rs)).toEqual(['41500.00', '3735.00', '3735.00', '48970.00'])
  })
  it('W18 bill-to in Gujarat, ship-to in MP: place of supply Gujarat, IGST', () => {
    expect(determineSupply(supply({ recipient: { regType: 'regular', state: '24' }, shipToState: '23', billToShipTo: true }), STATES)).toMatchObject({ rule: 'T3', placeOfSupply: '24', tax: 'inter' })
    const d = calc([line('1', '200000.00')], 'inter')
    expect([d.totals.igst, d.totals.total].map(rs)).toEqual(['36000.00', '236000.00'])
  })
  it('W19 rate change by document date', () => {
    const rates: RateRow[] = [
      { code: '8414', kind: 'goods', condition: '', ...R12, effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21', source: 'test' },
      { code: '8414', kind: 'goods', condition: '', ...R5, effectiveFrom: '2025-09-22', source: 'test' },
    ]
    const on = (date: string) => calc([line('1', '10000.00', findRate(rates, '84145100', '', date))])
    expect([on('2025-09-21').totals.cgst, on('2025-09-21').totals.sgst, on('2025-09-21').totals.total].map(rs)).toEqual(['600.00', '600.00', '11200.00'])
    expect([on('2025-09-22').totals.cgst, on('2025-09-22').totals.sgst, on('2025-09-22').totals.total].map(rs)).toEqual(['250.00', '250.00', '10500.00'])
    // G4.4: within 30 days after the change the user confirms the rate date
    expect(nearRateChange(rates, '84145100', '', '2025-10-10', 30)).toBe(true)
    expect(nearRateChange(rates, '84145100', '', '2025-11-10', 30)).toBe(false)
    expect(nearRateChange(rates, '84145100', '', '2025-09-10', 30)).toBe(false)
  })
})

describe('worked examples W20 to W32 (draft 5.5 table)', () => {
  it('W20 Union territory with UTGST', () => {
    expect(determineSupply(supply({ supplierState: '04', recipient: { regType: 'regular', state: '04' } }), STATES)).toMatchObject({ tax: 'intra', utgst: true })
    const d = calc([line('1', '10000.00')])
    expect([d.totals.cgst, d.totals.sgst, d.totals.total].map(rs)).toEqual(['900.00', '900.00', '11800.00'])
  })
  it('W21 unregistered buyer, State recorded: that State', () => {
    expect(determineSupply(supply({ recipient: { regType: 'unregistered', state: '08' }, addressRecorded: true }), STATES)).toMatchObject({ rule: 'T4', placeOfSupply: '08', tax: 'inter' })
    const d = calc([line('1', '8000.00')], 'inter')
    expect([d.totals.igst, d.totals.total].map(rs)).toEqual(['1440.00', '9440.00'])
  })
  it('W22 unregistered buyer, nothing recorded: the supplier State', () => {
    expect(determineSupply(supply({ recipient: { regType: 'unregistered' } }), STATES)).toMatchObject({ rule: 'T5', placeOfSupply: '23', tax: 'intra' })
    const d = calc([line('1', '8000.00')])
    expect([d.totals.cgst, d.totals.sgst, d.totals.total].map(rs)).toEqual(['720.00', '720.00', '9440.00'])
  })
  it('W23 bill-to in MP, ship-to its customer in Gujarat: place of supply MP', () => {
    expect(determineSupply(supply({ recipient: { regType: 'regular', state: '23' }, shipToState: '24', billToShipTo: true }), STATES)).toMatchObject({ rule: 'T3', placeOfSupply: '23', tax: 'intra' })
    const d = calc([line('1', '100000.00', R5)])
    expect([d.totals.cgst, d.totals.sgst, d.totals.total].map(rs)).toEqual(['2500.00', '2500.00', '105000.00'])
  })
  const service = (o: Partial<SupplyInput>) => supply({ lineKinds: [{ kind: 'service', posCategory: 'general' }], goodsMove: undefined, ...o })
  it('W24 general service to a registered client in Karnataka', () => {
    expect(determineSupply(service({ recipient: { regType: 'regular', state: '29' } }), STATES)).toMatchObject({ rule: 'T7', placeOfSupply: '29', tax: 'inter' })
    expect(rs(calc([line('1', '50000.00')], 'inter').totals.igst)).toBe('9000.00')
  })
  it('W25 the same to an unregistered client with an address in Karnataka; T9 without one', () => {
    expect(determineSupply(service({ recipient: { regType: 'unregistered', state: '29' }, addressRecorded: true }), STATES)).toMatchObject({ rule: 'T8', placeOfSupply: '29', tax: 'inter' })
    const d = calc([line('1', '20000.00')], 'inter')
    expect([d.totals.igst, d.totals.total].map(rs)).toEqual(['3600.00', '23600.00'])
    expect(determineSupply(service({ recipient: { regType: 'unregistered' } }), STATES)).toMatchObject({ rule: 'T9', placeOfSupply: '23', tax: 'intra' })
  })
  it('W26 a service in a special place-of-supply category is a STOP', () => {
    const e = stop(() => determineSupply(service({ lineKinds: [{ kind: 'service', posCategory: 'immovable property' }], recipient: { regType: 'regular', state: '29' } }), STATES))
    expect(e.rule).toBe('G3.9')
    expect(e.message).toMatch(/^Place of supply needs the accountant: /)
  })
  it('W27 credit note after the 30 November deadline is refused', () => {
    expect(creditNoteDeadline('2025-03-15', 4, '11-30')).toBe('2025-11-30')
    expect('2025-12-05' > creditNoteDeadline('2025-03-15', 4, '11-30')).toBe(true)
    expect(creditNoteDeadline('2025-04-01', 4, '11-30')).toBe('2026-11-30')
    // the accountant may set an earlier date for a year (the annual return date)
    expect(creditNoteDeadline('2025-03-15', 4, '11-30', '2025-10-20')).toBe('2025-10-20')
    expect(creditNoteDeadline('2025-03-15', 4, '11-30', '2025-12-31')).toBe('2025-11-30')
  })
  it('W28 a small invoice is still issued and rounded', () => {
    const d = calc([line('1', '150.00', R5)])
    expect([d.totals.cgst, d.totals.sgst, d.totals.exact, d.totals.roundOff, d.totals.total].map(rs)).toEqual(['3.75', '3.75', '157.50', '0.50', '158.00'])
  })
  it('W29 purchase with ineligible ITC: the supplier tax is computed (the posting puts it in the expense)', () => {
    const d = calc([line('1', '2000.00', R5)], 'intra', { roundOff: false })
    expect([d.totals.cgst, d.totals.sgst, d.totals.total].map(rs)).toEqual(['50.00', '50.00', '2100.00'])
  })
  it('W30 consignment value against the e-way bill threshold (data)', () => {
    const value = (taxable: string) => {
      const d = calc([line('1', taxable)])
      return consignmentValue(d.lines.map((l) => ({ kind: 'goods' as const, ...l })))
    }
    const threshold = paise('50000')
    expect(rs(value('45000.00'))).toBe('53100.00')
    expect(value('45000.00') > threshold).toBe(true)
    expect(rs(value('42000.00'))).toBe('49560.00')
    expect(value('42000.00') > threshold).toBe(false)
    // exempt goods on a document with taxable goods are left out; services never count (G8.5)
    const mixed = calc([line('1', '1000.00'), line('1', '500.00', R18, { supplyClass: 'exempt', rate: null }), line('1', '300.00')])
    expect(rs(consignmentValue(mixed.lines.map((l, i) => ({ kind: i === 2 ? 'service' as const : 'goods' as const, ...l }))))).toBe('1180.00')
  })
  it('W31 export of services under LUT needs the confirmation and the LUT', () => {
    const e = service({ recipient: { regType: 'overseas', country: 'US' }, exportConditionsConfirmed: true, lutValid: true })
    expect(determineSupply(e, STATES)).toMatchObject({ rule: 'T12', placeOfSupply: 'OTHER', tax: 'zero', zeroRated: 'lut' })
    expect(rs(calc([line('1', '200000.00')], 'zero').totals.total)).toBe('200000.00')
    expect(stop(() => determineSupply({ ...e, exportConditionsConfirmed: false }, STATES)).rule).toBe('G3.8')
    expect(stop(() => determineSupply({ ...e, lutValid: false }, STATES)).rule).toBe('G3.7')
  })
  it('W32 one inclusive price for a bundle entered as one line', () => {
    const d = calc([line('1', '1180.00')], 'intra', { taxInclusive: true })
    expect([d.totals.taxable, d.totals.cgst, d.totals.sgst, d.totals.total].map(rs)).toEqual(['1000.00', '90.00', '90.00', '1180.00'])
  })
})

describe('decision table and STOP cases (draft 3.4, G3.9)', () => {
  it('T6 no movement, T13 installed at site', () => {
    expect(determineSupply(supply({ recipient: { regType: 'regular', state: '27' }, goodsMove: 'no' }), STATES)).toMatchObject({ rule: 'T6', placeOfSupply: '23', tax: 'intra' })
    expect(determineSupply(supply({ installedAtSite: true, siteState: '29' }), STATES)).toMatchObject({ rule: 'T13', placeOfSupply: '29', tax: 'inter' })
  })
  it('stops instead of guessing', () => {
    expect(stop(() => determineSupply(supply({ goodsMove: 'unknown' }), STATES)).rule).toBe('G3.9')
    expect(stop(() => determineSupply(supply({ flags: { onBoardConveyance: true } }), STATES)).rule).toBe('G3.9')
    expect(stop(() => determineSupply(supply({ flags: { importOrBonded: true } }), STATES)).rule).toBe('G3.9')
    expect(stop(() => determineSupply(supply({ flags: { continuousSupply: true } }), STATES)).rule).toBe('G7.2b')
    expect(stop(() => determineSupply(supply({ flags: { saleOnApproval: true } }), STATES)).rule).toBe('G7.2b')
    expect(stop(() => determineSupply(supply({ recipient: { regType: 'regular', state: '99' } }), STATES)).rule).toBe('G2.7')
    expect(stop(() => determineSupply(supply({ supplierState: '77' }), STATES)).rule).toBe('G2.7')
    // bill-to in India, delivery outside India
    expect(stop(() => determineSupply(supply({ billToShipTo: true, shipToCountry: 'AE', lutValid: true }), STATES)).rule).toBe('G3.9')
    // an overseas recipient with delivery in India
    expect(stop(() => determineSupply(supply({ recipient: { regType: 'overseas', country: 'US' } }), STATES)).rule).toBe('G3.9')
    expect(stop(() => determineSupply(supply({ lineKinds: [] }), STATES)).rule).toBe('G5.5')
  })
  it('goods and services on one document must give one place of supply', () => {
    const both = [{ kind: 'goods' as const, posCategory: 'general' }, { kind: 'service' as const, posCategory: 'general' }]
    expect(determineSupply(supply({ lineKinds: both, recipient: { regType: 'regular', state: '27' } }), STATES).tax).toBe('inter')
    // goods collected at the supplier (T6: MP), the service follows the recipient (T7: Maharashtra)
    expect(stop(() => determineSupply(supply({ lineKinds: both, recipient: { regType: 'regular', state: '27' }, goodsMove: 'no' }), STATES)).rule).toBe('G3.4')
  })
  it('manual place of supply only when allowed and with a reason', () => {
    expect(stop(() => determineSupply(supply({ manual: { state: '29', reason: 'x' } }), STATES)).rule).toBe('G3.9')
    expect(stop(() => determineSupply(supply({ manual: { state: '29', reason: ' ' }, manualAllowed: true }), STATES)).rule).toBe('G3.9')
    expect(determineSupply(supply({ manual: { state: '29', reason: 'accountant said so' }, manualAllowed: true }), STATES)).toMatchObject({ rule: 'manual', placeOfSupply: '29', tax: 'inter' })
  })
})

describe('rates as data (draft section 4)', () => {
  const row = (o: Partial<RateRow>): RateRow => ({ code: '8414', kind: 'goods', condition: '', ...R18, effectiveFrom: '2025-09-22', source: 'test notification', ...o })
  it('longest prefix wins; conditions and dates are matched; no match is a STOP', () => {
    const rates = [row({ code: '84', ...R5 }), row({}), row({ code: '841451', ...R12 }), row({ condition: 'without ITC', ...R5 })]
    expect(findRate(rates, '84145100', '', '2026-01-01').igst).toBe('12')
    expect(findRate(rates, '84149000', '', '2026-01-01').igst).toBe('18')
    expect(findRate(rates, '84990000', '', '2026-01-01').igst).toBe('5')
    expect(findRate(rates, '84149000', 'without ITC', '2026-01-01').igst).toBe('5')
    const e = stop(() => findRate(rates, '84149000', '', '2025-09-21'))
    expect(e.rule).toBe('G4.3')
    expect(e.message).toBe('No approved rate for HSN/SAC 84149000 on 2025-09-21.')
    expect(stop(() => findRate(rates, '9983', '', '2026-01-01')).rule).toBe('G4.3')
    expect(stop(() => findRate(rates, '84149000', '', '2026-01-01', 'service')).rule).toBe('G4.3')
  })
  it('a specific cess is a STOP; an ad valorem cess is computed', () => {
    expect(stop(() => findRate([row({ cessSpecificAmount: '4170' })], '8414', '', '2026-01-01')).rule).toBe('G4.9')
    const d = calc([line('1', '1000.00', { igst: '40', cgst: '20', sgst: '20', cess: '12' })])
    expect([d.totals.cgst, d.totals.sgst, d.totals.cess, d.totals.total].map(rs)).toEqual(['200.00', '200.00', '120.00', '1520.00'])
  })
  it('validates a row (G4.2)', () => {
    expect(rateRowProblem(row({}))).toBeNull()
    expect(rateRowProblem(row({ cgst: '9', sgst: '8' }))).toMatch(/must equal the IGST rate/)
    expect(rateRowProblem(row({ source: ' ' }))).toMatch(/source/)
    expect(rateRowProblem(row({ code: '84A' }))).toMatch(/2 to 8 digits/)
    expect(rateRowProblem(row({ effectiveTo: '2025-01-01' }))).toMatch(/on or after/)
    expect(rateRowProblem(row({ igst: '118', cgst: '59', sgst: '59' }))).toMatch(/between 0 and 100/)
    // any rate with a source is valid: 0.25 %, 3 %, 40 % (G4.8)
    expect(rateRowProblem(row({ igst: '0.25', cgst: '0.125', sgst: '0.125' }))).toBeNull()
    expect(ratesOverlap(row({ effectiveTo: '2026-01-31' }), row({ effectiveFrom: '2026-02-01' }))).toBe(false)
    expect(ratesOverlap(row({}), row({ effectiveFrom: '2026-02-01' }))).toBe(true)
    expect(ratesOverlap(row({}), row({ condition: 'x' }))).toBe(false)
  })
})

describe('discounts, charges and refusals (G4.13, G4.15, G5.5)', () => {
  it('spreads a document discount over the taxable lines by value', () => {
    const d = calc([line('1', '300.00'), line('1', '700.00', R5), line('1', '100.00', R18, { supplyClass: 'exempt', rate: null })], 'intra', { documentDiscount: '100.01' })
    expect(d.lines.map((l) => rs(l.documentDiscount))).toEqual(['30.00', '70.01', '0.00'])
    expect(d.lines.map((l) => rs(l.taxable))).toEqual(['270.00', '629.99', '100.00'])
  })
  it('apportions a whole-document charge by value, each share at its line rate', () => {
    const d = calc([line('1', '300.00'), line('1', '700.00', R5)], 'intra', { charges: [{ amount: '100.00' }] })
    expect(d.lines.map((l) => [rs(l.charges), rs(l.taxable), rs(l.cgst)])).toEqual([['30.00', '330.00', '29.70'], ['70.00', '770.00', '19.25']])
  })
  it('refuses nonsense in plain words', () => {
    expect(stop(() => calc([])).rule).toBe('G5.5')
    expect(stop(() => calc([line('0', '10')])).message).toMatch(/quantity must be more than zero/)
    expect(stop(() => calc([line('1', '-1')])).message).toMatch(/cannot be negative/)
    expect(stop(() => calc([line('1', '10', R18, { discountPercent: '5', discountAmount: '1' })])).message).toMatch(/not both/)
    expect(stop(() => calc([line('1', '10', R18, { discountAmount: '11' })])).message).toMatch(/more than the line value/)
    expect(stop(() => calc([line('1', '10')], 'intra', { documentDiscount: '11' })).rule).toBe('G4.13')
    expect(stop(() => calc([line('1', '10')], 'intra', { charges: [{ amount: '5', line: 3 }] })).rule).toBe('G4.15')
    expect(stop(() => calc([line('1', '10', R18, { rate: null })])).rule).toBe('G4.3')
    expect(stop(() => calc([line('1', '10', { igst: '18', cgst: '9', sgst: '8' })])).rule).toBe('G4.2')
    expect(() => calc([line('1', '10.00001')])).toThrow(/more than 4 decimals/)
    expect(() => calc([line('1.0001', '10')])).toThrow(/more than 3 decimals/)
  })
  it('round-off can be switched off; taxes are never changed by it (G5.7)', () => {
    const d = calc([line('4', '2345.50'), line('3', '799.00', R5)], 'intra', { roundOff: false })
    expect([d.totals.roundOff, d.totals.total, d.totals.cgst].map(rs)).toEqual(['0.00', '13587.62', '904.31'])
  })
})

describe('the small rules', () => {
  it('financial year and its months (G9.9, G9.10)', () => {
    expect(financialYearOf('2026-03-31', 4)).toEqual({ start: '2025-04-01', end: '2026-03-31', name: '2025-26', short: '25-26' })
    expect(financialYearOf('2026-04-01', 4)).toEqual({ start: '2026-04-01', end: '2027-03-31', name: '2026-27', short: '26-27' })
    expect(financialYearOf('1999-12-31', 4).name).toBe('1999-00')
    expect(financialYearOf('2026-06-01', 1)).toMatchObject({ start: '2026-01-01', end: '2026-12-31', name: '2026' })
    const m = monthsOf(financialYearOf('2027-06-01', 4))
    expect(m).toHaveLength(12)
    expect(m[0]).toEqual({ start: '2027-04-01', end: '2027-04-30' })
    expect(m[10]).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(m[11]).toEqual({ start: '2028-03-01', end: '2028-03-31' })
  })
  it('numbering (G7.6)', () => {
    expect(seriesProblem({ prefix: 'INV/{FY}/', suffix: '', padding: 5 })).toBeNull()
    expect(seriesNumber({ prefix: 'INV/{FY}/', suffix: '', padding: 5 }, '26-27', 1)).toBe('INV/26-27/00001')
    expect(seriesProblem({ prefix: 'INV_', suffix: '', padding: 5 })).toMatch(/letters, digits, the hyphen and the slash/)
    expect(seriesProblem({ prefix: 'INVOICE/{FY}/', suffix: '', padding: 5 })).toMatch(/limit is 16/)
    expect(seriesProblem({ prefix: 'A', suffix: '', padding: 0 })).toMatch(/1 to 10 digits/)
    expect(seriesNumber({ prefix: 'EXP-', suffix: '/X', padding: 3 }, '26-27', 42)).toBe('EXP-042/X')
    expect(() => seriesNumber({ prefix: 'INV/{FY}/', suffix: '', padding: 5 }, '26-27', 1234567)).toThrow(/longer than 16/)
  })
  it('HSN digits by turnover and recipient (G7.7)', () => {
    const rule = { digitsSmall: 4, digitsLarge: 6, turnoverLimit: paise('50000000'), optionalForUnregistered: true }
    expect(hsnDigitsRequired(rule, paise('40000000'), true)).toBe(4)
    expect(hsnDigitsRequired(rule, paise('40000000'), false)).toBe(0)
    expect(hsnDigitsRequired(rule, paise('50000000.01'), false)).toBe(6)
    expect(hsnProblem('8414', 6)).toMatch(/shorter than the 6 digits/)
    expect(hsnProblem('841451', 6)).toBeNull()
    expect(hsnProblem('', 0)).toBeNull()
    expect(hsnProblem('', 4)).toMatch(/blank/)
  })
  it('GSTIN shape only (G2.6)', () => {
    expect(gstinProblem('23ABCDE1234F1Z5', '23')).toBeNull()
    expect(gstinProblem('23ABCDE1234F1Z5', '27')).toMatch(/starts with 23/)
    expect(gstinProblem('23ABCDE1234F1Z', '23')).toMatch(/15 characters/)
    expect(gstinProblem('23abcde1234f1z5', '23')).toMatch(/capital letters/)
    expect(gstinProblem('AB3456789012345')).toMatch(/State code/)
  })
  it('e-invoice class from any earlier year (G8.3)', () => {
    const t = { '2022-23': paise('60000000'), '2025-26': paise('1000000') }
    expect(inEinvoiceClass(t, '2026-27', paise('50000000'))).toBe(true)
    expect(inEinvoiceClass(t, '2022-23', paise('50000000'))).toBe(false)
    expect(inEinvoiceClass({ '2025-26': paise('50000000') }, '2026-27', paise('50000000'))).toBe(false)
  })
  it('business types that are refused (G2.2, G6.9)', () => {
    expect(outwardDocumentProblem('tax_invoice', 'sez_unit', ['taxable'], false)).toMatch(/no tax documents/)
    expect(outwardDocumentProblem('tax_invoice', 'unregistered', ['taxable'], false)).toMatch(/commercial invoice/)
    expect(outwardDocumentProblem('bill_of_supply', 'regular', ['exempt'], true)).toMatch(/tax invoice with the endorsement/)
  })
})

describe('groupIN (unit prices on printed documents)', () => {
  it('groups the integer part the Indian way and keeps the decimals as typed', () => {
    expect(groupIN('1250.00')).toBe('1,250.00')
    expect(groupIN('40')).toBe('40')
    expect(groupIN('1234567.125')).toBe('12,34,567.125')
    expect(groupIN('-100000')).toBe('-1,00,000')
    expect(groupIN('n/a')).toBe('n/a')
  })
})
