/**
 * The journals of docs/plan/gst-spec-draft.md section 9 as ONE pure function per document shape: computed document in,
 * balanced journal lines out. Accounts are named by the system keys of the default chart (ledger/service.ts
 * DEFAULT_ACCOUNTS); the caller resolves them to account ids. Section 9 of the draft is "for the accountant to
 * confirm": a correction of a journal is a change in this file only.
 *
 * Not posted by this version (draft Q25): the set-off of input tax credit against output tax, and tax payments.
 */
import type { Paise } from './money.ts'
import type { DocType, SupplyClass } from './engine.ts'

export interface PostLine { key: string; accountId?: string | null; party?: boolean; debit?: Paise; credit?: Paise; memo?: string }

export interface PostingDoc {
  docType: DocType
  /** intra-State in a Union territory with UTGST: the State half goes to the UTGST accounts (G3.4) */
  utgst: boolean
  zeroRated: boolean
  totals: { taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise; cess: Paise; roundOff: Paise; total: Paise }
  lines: {
    supplyClass: SupplyClass; taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise; cess: Paise
    /** purchases */
    reverseCharge?: boolean; itcEligible?: boolean; accountId?: string | null; goods?: boolean
  }[]
  /** credit note: where the value goes (G9.3) */
  reason?: string
  /** receipt, refund and payment vouchers: 'bank' or 'cash' */
  moneyAccount?: 'bank' | 'cash'
}

const SALES: Record<SupplyClass, string> = { taxable: 'sales_taxable', 'zero-rated-capable': 'sales_taxable', exempt: 'sales_exempt', 'nil-rated': 'sales_nil', 'non-gst': 'sales_non_gst' }

/** merges lines of the same account and side, drops zero lines */
function tidy(lines: PostLine[]): PostLine[] {
  const out: PostLine[] = []
  for (const l of lines) {
    const d = l.debit ?? 0
    const c = l.credit ?? 0
    if (!d && !c) continue
    const same = out.find((o) => o.key === l.key && (o.accountId ?? null) === (l.accountId ?? null) && !!o.party === !!l.party && !!(o.debit ?? 0) === !!d)
    if (same) { same.debit = (same.debit ?? 0) + d; same.credit = (same.credit ?? 0) + c } else out.push({ ...l, debit: d, credit: c })
  }
  return out
}
/** a signed amount on its natural side: positive = `side`, negative = the other side */
const signed = (key: string, amount: Paise, side: 'debit' | 'credit'): PostLine =>
  amount >= 0 ? { key, [side]: amount } : { key, [side === 'debit' ? 'credit' : 'debit']: -amount }
const flip = (lines: PostLine[]): PostLine[] => lines.map((l) => ({ ...l, debit: l.credit ?? 0, credit: l.debit ?? 0 }))

/** the output (or input) tax lines of a document on `side` */
function taxLines(prefix: 'output' | 'input', d: PostingDoc, side: 'debit' | 'credit'): PostLine[] {
  const t = d.totals
  return [
    { key: `${prefix}_cgst`, [side]: t.cgst }, { key: d.utgst ? `${prefix}_utgst` : `${prefix}_sgst`, [side]: t.sgst },
    { key: `${prefix}_igst`, [side]: t.igst }, { key: `${prefix}_cess`, [side]: t.cess },
  ]
}

/** G9.1, G9.2, G9.2a, G9.2b, G9.7: Dr customer; Cr sales by class; Cr output taxes; round-off (a negative one is a debit) */
function outward(d: PostingDoc): PostLine[] {
  return [
    { key: 'receivables', party: true, debit: d.totals.total },
    ...d.lines.map((l) => ({ key: d.zeroRated ? 'sales_zero_rated' : SALES[l.supplyClass], credit: l.taxable })),
    ...taxLines('output', d, 'credit'),
    signed('round_off', d.totals.roundOff, 'credit'),
  ]
}

/** G9.3: Dr Sales returns / Sales discounts / Sales; Dr output taxes; Dr round-off; Cr customer */
function creditNote(d: PostingDoc): PostLine[] {
  const value = d.reason === 'return' ? 'sales_returns' : d.reason === 'post-sale discount' ? 'sales_discounts' : null
  return [
    ...d.lines.map((l) => ({ key: value ?? (d.zeroRated ? 'sales_zero_rated' : SALES[l.supplyClass]), debit: l.taxable })),
    ...taxLines('output', d, 'debit'),
    signed('round_off', d.totals.roundOff, 'debit'),
    { key: 'receivables', party: true, credit: d.totals.total },
  ]
}

/**
 * G9.4 and G9.5. A line with supplier tax: Dr purchases or the line's expense account; eligible ITC to the input
 * accounts, otherwise the tax joins the expense; Cr supplier. A reverse charge line: the supplier is credited the value
 * only; the tax is Cr RCM payable and Dr Input (RCM) when eligible, else Dr the expense.
 */
function purchase(d: PostingDoc): PostLine[] {
  const out: PostLine[] = []
  let payable = d.totals.roundOff
  const sgst = d.utgst ? 'utgst' : 'sgst'
  for (const l of d.lines) {
    const tax = l.cgst + l.sgst + l.igst + l.cess
    const expense: PostLine = { key: l.goods === false ? 'expenses' : 'purchases', accountId: l.accountId ?? null }
    out.push({ ...expense, debit: l.taxable + (l.itcEligible ? 0 : tax) })
    payable += l.taxable
    if (l.reverseCharge) {
      // G9.5 (cess under reverse charge is not handled: the document service refuses it)
      out.push({ key: 'rcm_cgst', credit: l.cgst }, { key: `rcm_${sgst}`, credit: l.sgst }, { key: 'rcm_igst', credit: l.igst })
      if (l.itcEligible) out.push({ key: 'input_cgst_rcm', debit: l.cgst }, { key: `input_${sgst}_rcm`, debit: l.sgst }, { key: 'input_igst_rcm', debit: l.igst })
    } else {
      payable += tax
      if (l.itcEligible) out.push({ key: 'input_cgst', debit: l.cgst }, { key: `input_${sgst}`, debit: l.sgst }, { key: 'input_igst', debit: l.igst }, { key: 'input_cess', debit: l.cess })
    }
  }
  out.push(signed('round_off', d.totals.roundOff, 'debit'), { key: 'payables', party: true, credit: payable })
  return out
}

/** G9.6: Dr bank; Cr customer advance (the whole receipt); Dr GST on advances suspense; Cr output taxes */
function receipt(d: PostingDoc): PostLine[] {
  const t = d.totals
  const tax = t.cgst + t.sgst + t.igst + t.cess
  return [
    { key: d.moneyAccount ?? 'bank', debit: t.total }, { key: 'customer_advances', party: true, credit: t.total },
    { key: 'advance_gst_suspense', debit: tax }, ...taxLines('output', d, 'credit'),
  ]
}

/** the journal lines of a document (not yet resolved to account ids); always balanced */
export function postingLines(d: PostingDoc): PostLine[] {
  switch (d.docType) {
    case 'tax_invoice': case 'bill_of_supply': case 'debit_note': return tidy(outward(d))
    case 'credit_note': return tidy(creditNote(d))
    case 'purchase_invoice': return tidy(purchase(d))
    case 'receipt_voucher': return tidy(receipt(d))
    case 'refund_voucher': return tidy(flip(receipt(d)))
    case 'payment_voucher': return tidy([{ key: 'payables', party: true, debit: d.totals.total }, { key: d.moneyAccount ?? 'bank', credit: d.totals.total }])
  }
}
