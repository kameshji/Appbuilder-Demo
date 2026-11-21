/**
 * The journals of docs/plan/gst-spec-draft.md section 9 (postings.ts), as pure data: every example journal of G9.1 to
 * G9.7, the UTGST accounts, a negative round-off, and "always balanced" over mixed purchases. The draft's section 9 is
 * "for the accountant to confirm": these tests pin the software to the draft.
 */
import { describe, expect, it } from 'vitest'
import { postingLines, type PostingDoc } from './postings.ts'

const R = (n: number) => Math.round(n * 100)
const totals = (taxable: number, cgst = 0, sgst = 0, igst = 0, roundOff = 0, cess = 0) => ({ taxable: R(taxable), cgst: R(cgst), sgst: R(sgst), igst: R(igst), cess: R(cess), roundOff: R(roundOff), total: R(taxable + cgst + sgst + igst + cess + roundOff) })
const one = (taxable: number, cgst = 0, sgst = 0, igst = 0, extra: Partial<PostingDoc['lines'][number]> = {}): PostingDoc['lines'][number] => ({ supplyClass: 'taxable', taxable: R(taxable), cgst: R(cgst), sgst: R(sgst), igst: R(igst), cess: 0, ...extra })
const doc = (d: Partial<PostingDoc> & Pick<PostingDoc, 'docType' | 'totals' | 'lines'>): PostingDoc => ({ utgst: false, zeroRated: false, ...d })
const show = (d: PostingDoc): string[] => {
  const ls = postingLines(d)
  expect(ls.reduce((s, l) => s + (l.debit ?? 0), 0), 'debits = credits').toBe(ls.reduce((s, l) => s + (l.credit ?? 0), 0))
  return ls.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.accountId ?? l.key}${l.party ? '*' : ''} ${(((l.debit ?? 0) + (l.credit ?? 0)) / 100).toFixed(2)}`)
}

describe('journals of draft section 9', () => {
  it('G9.1 W1 intra-State invoice', () => {
    expect(show(doc({ docType: 'tax_invoice', totals: totals(12500, 1125, 1125), lines: [one(12500, 1125, 1125)] })))
      .toEqual(['Dr receivables* 14750.00', 'Cr sales_taxable 12500.00', 'Cr output_cgst 1125.00', 'Cr output_sgst 1125.00'])
  })
  it('G9.2 W3 round-off credit; a negative round-off is a debit (W7)', () => {
    expect(show(doc({ docType: 'tax_invoice', totals: totals(11779, 904.31, 904.31, 0, 0.38), lines: [one(9382, 844.38, 844.38), one(2397, 59.93, 59.93)] })))
      .toEqual(['Dr receivables* 13588.00', 'Cr sales_taxable 11779.00', 'Cr output_cgst 904.31', 'Cr output_sgst 904.31', 'Cr round_off 0.38'])
    expect(show(doc({ docType: 'tax_invoice', totals: totals(101, 2.53, 2.53, 0, -0.06), lines: [one(101, 2.53, 2.53)] })))
      .toEqual(['Dr receivables* 106.00', 'Cr sales_taxable 101.00', 'Cr output_cgst 2.53', 'Cr output_sgst 2.53', 'Dr round_off 0.06'])
  })
  it('G9.2a W2 inter-State; G9.2b W14 export under LUT; W20 a Union territory posts UTGST', () => {
    expect(show(doc({ docType: 'tax_invoice', totals: totals(12500, 0, 0, 2250), lines: [one(12500, 0, 0, 2250)] }))).toEqual(['Dr receivables* 14750.00', 'Cr sales_taxable 12500.00', 'Cr output_igst 2250.00'])
    expect(show(doc({ docType: 'tax_invoice', zeroRated: true, totals: totals(325000), lines: [one(325000)] }))).toEqual(['Dr receivables* 325000.00', 'Cr sales_zero_rated 325000.00'])
    expect(show(doc({ docType: 'tax_invoice', utgst: true, totals: totals(10000, 900, 900), lines: [one(10000, 900, 900)] }))).toEqual(['Dr receivables* 11800.00', 'Cr sales_taxable 10000.00', 'Cr output_cgst 900.00', 'Cr output_utgst 900.00'])
  })
  it('G9.3 credit notes W8 and W9, debit note W10', () => {
    expect(show(doc({ docType: 'credit_note', reason: 'return', totals: totals(2500, 225, 225), lines: [one(2500, 225, 225)] })))
      .toEqual(['Dr sales_returns 2500.00', 'Dr output_cgst 225.00', 'Dr output_sgst 225.00', 'Cr receivables* 2950.00'])
    expect(show(doc({ docType: 'credit_note', reason: 'post-sale discount', totals: totals(625, 0, 0, 112.5, 0.5), lines: [one(625, 0, 0, 112.5)] })))
      .toEqual(['Dr sales_discounts 625.00', 'Dr output_igst 112.50', 'Dr round_off 0.50', 'Cr receivables* 738.00'])
    expect(show(doc({ docType: 'credit_note', reason: 'other', totals: totals(100, 9, 9), lines: [one(100, 9, 9)] }))[0]).toBe('Dr sales_taxable 100.00')
    expect(show(doc({ docType: 'debit_note', totals: totals(500, 45, 45), lines: [one(500, 45, 45)] }))).toEqual(['Dr receivables* 590.00', 'Cr sales_taxable 500.00', 'Cr output_cgst 45.00', 'Cr output_sgst 45.00'])
  })
  it('G9.4 purchases: eligible credit to the input accounts; W29 ineligible tax joins the expense', () => {
    const t = { ...totals(20000, 500, 500), total: R(21000) }
    expect(show(doc({ docType: 'purchase_invoice', totals: t, lines: [one(20000, 500, 500, 0, { itcEligible: true, goods: true })] })))
      .toEqual(['Dr purchases 20000.00', 'Dr input_cgst 500.00', 'Dr input_sgst 500.00', 'Cr payables* 21000.00'])
    expect(show(doc({ docType: 'purchase_invoice', totals: { ...totals(2000, 50, 50), total: R(2100) }, lines: [one(2000, 50, 50, 0, { itcEligible: false, goods: false })] })))
      .toEqual(['Dr expenses 2100.00', 'Cr payables* 2100.00'])
  })
  it('G9.5 W11 reverse charge, eligible and ineligible; mixed documents stay balanced', () => {
    const t = { ...totals(25000, 2250, 2250), total: R(25000) }
    expect(show(doc({ docType: 'purchase_invoice', totals: t, lines: [one(25000, 2250, 2250, 0, { reverseCharge: true, itcEligible: true, goods: false, accountId: 'LEGAL' })] })))
      .toEqual(['Dr LEGAL 25000.00', 'Cr rcm_cgst 2250.00', 'Cr rcm_sgst 2250.00', 'Dr input_cgst_rcm 2250.00', 'Dr input_sgst_rcm 2250.00', 'Cr payables* 25000.00'])
    expect(show(doc({ docType: 'purchase_invoice', totals: t, lines: [one(25000, 2250, 2250, 0, { reverseCharge: true, itcEligible: false, goods: false, accountId: 'LEGAL' })] })))
      .toEqual(['Dr LEGAL 29500.00', 'Cr rcm_cgst 2250.00', 'Cr rcm_sgst 2250.00', 'Cr payables* 25000.00'])
    // a supplier line with eligible credit, one with ineligible, a reverse charge import of services (IGST), a round-off
    const mixed = doc({ docType: 'purchase_invoice', utgst: true, totals: { taxable: R(1600), cgst: R(27), sgst: R(27), igst: R(180), cess: 0, roundOff: -R(0.4), total: R(1653.6) }, lines: [
      one(100, 9, 9, 0, { itcEligible: true }), one(500, 18, 18, 0, { itcEligible: false }), one(1000, 0, 0, 180, { reverseCharge: true, itcEligible: true, goods: false }),
    ] })
    const ls = show(mixed)
    expect(ls).toContain('Dr input_utgst 9.00')
    expect(ls).toContain('Cr rcm_igst 180.00')
    expect(ls).toContain('Dr input_igst_rcm 180.00')
    expect(ls).toContain('Cr round_off 0.40')
    expect(ls).toContain('Cr payables* 1653.60')
  })
  it('G9.6 W16 receipt voucher, its refund, and a payment voucher', () => {
    const t = { ...totals(100000, 9000, 9000), total: R(118000) }
    const rv = doc({ docType: 'receipt_voucher', totals: t, lines: [one(100000, 9000, 9000)] })
    expect(show(rv)).toEqual(['Dr bank 118000.00', 'Cr customer_advances* 118000.00', 'Dr advance_gst_suspense 18000.00', 'Cr output_cgst 9000.00', 'Cr output_sgst 9000.00'])
    expect(show({ ...rv, docType: 'refund_voucher', moneyAccount: 'cash' })).toEqual(['Cr cash 118000.00', 'Dr customer_advances* 118000.00', 'Cr advance_gst_suspense 18000.00', 'Dr output_cgst 9000.00', 'Dr output_sgst 9000.00'])
    expect(show(doc({ docType: 'payment_voucher', totals: totals(2100), lines: [] }))).toEqual(['Dr payables* 2100.00', 'Cr bank 2100.00'])
  })
  it('G9.7 W13 composition bill of supply; exempt, nil-rated and non-GST sales go to their own accounts', () => {
    expect(show(doc({ docType: 'bill_of_supply', totals: totals(50000), lines: [one(50000)] }))).toEqual(['Dr receivables* 50000.00', 'Cr sales_taxable 50000.00'])
    expect(show(doc({ docType: 'bill_of_supply', totals: totals(600), lines: [one(100, 0, 0, 0, { supplyClass: 'exempt' }), one(200, 0, 0, 0, { supplyClass: 'nil-rated' }), one(300, 0, 0, 0, { supplyClass: 'non-gst' })] })))
      .toEqual(['Dr receivables* 600.00', 'Cr sales_exempt 100.00', 'Cr sales_nil 200.00', 'Cr sales_non_gst 300.00'])
  })
})
