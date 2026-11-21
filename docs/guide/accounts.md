# Accounts: ledgers and GST documents

Accounts keeps your books (chart of accounts, journals, trial balance) and issues GST documents (tax invoice, bill of
supply, credit and debit notes, vouchers, purchase invoices). It is in the menu as **Accounts**, in Dev mode and in User
mode, for people whose role has an Accounts level.

> **The GST calculation rules in Accounts are a draft that has not yet been reviewed by a practising accountant.** Check
> every figure with your accountant before you rely on it. Appbuilder does not prepare or file any return, does not
> create an IRN or an e-way bill, and has no connection to any government system. It gives no tax advice.

Setting it up (the business registration, reference data, who may use it) is in the
[administrator page](../admin/accounts.md).

## What you can do, by level

| Level | You can |
| --- | --- |
| Read | open every section, download CSV files and PDFs |
| Post | also create drafts, issue and cancel documents, record an IRN or e-way bill number, post and reverse journals, add customers, suppliers and items |
| Accounts administrator | also change settings, reference data, the chart of accounts and number series, add financial years, lock periods |

## Documents

1. **Documents > New**: choose the kind, then the customer (or supplier), the items, quantities and prices. Items carry
   their HSN or SAC code and supply class; the rate comes from the reference data on the document date.
2. **Save draft**. The server computes the figures and shows what the document would look like if issued now: the place
   of supply, intra-State (CGST + SGST or UTGST) or inter-State (IGST), each tax, the round-off and the total. Nothing
   is computed in the browser.
3. If the draft **cannot be issued**, the page says why. Some situations are deliberately not decided by the software
   ("Place of supply needs the accountant: ..."): services with special place-of-supply rules, goods where you cannot say
   whether they move, exports with payment of integrated tax, and others. Ask your accountant; do not work around it.
4. **Issue**. The number is taken from the series at this moment (drafts have no number, so abandoned drafts leave no
   gaps), the journal is posted, and the document is frozen. **Open PDF** prints the tax invoice, bill of supply, credit
   note or debit note.

After issue a document **cannot be edited or deleted**. To correct it, issue a **credit note** or a **debit note** from
its page. You can still record on it: the IRN with its acknowledgement number and date (once), the e-way bill number and
date, the vehicle number, the payment status and internal notes. **Cancel** works only when the document has no IRN, no
payment and no later note, and its period is open; the number stays used and the journal is reversed.

Other things the page tells you:

- **IRN required**: your turnover puts the business in the e-invoice class. Get the IRN and QR code from the invoice
  registration portal or your e-invoice tool and enter them.
- **E-way bill**: the consignment value is above the value in the reference data. Enter the number from the e-way bill
  portal.
- **Credit notes** take the tax type and rates of their invoice, cannot credit more than the invoice still has, and
  cannot be dated after the deadline for the invoice's financial year.
- **Purchases**: each line needs its input tax credit flag (eligible or ineligible) before posting. Ineligible tax goes
  into the expense. A reverse charge line records the tax as payable by you.
- **Receipt voucher**: an advance for a service is treated as including tax; an advance for goods carries no tax.

## Journals, ledger and reports

- **Journals**: every issued document posts one. You can post a manual journal (debits must equal credits) and
  **Reverse** a manual journal. A posted journal is never changed.
- **Ledger**: the entries of one account between two dates with a running balance.
- **Reports**: trial balance, profit and loss, balance sheet, each with a **CSV** button. There are no year-end closing
  entries in this version: the balance sheet shows the profit to date as one line under equity.

## Return summaries

**Return summaries** shows 13 registers and totals for a date range (outward register, B2B, B2C, credit and debit notes,
exports and SEZ, nil-rated and exempt, advances, HSN summary, documents issued, inward register, a GSTR-3B helper and a
composition helper), on screen and as CSV. They are working papers for your accountant. Appbuilder does not check them
against the forms and files nothing.

## Periods

Periods are calendar months. An Accounts administrator can **soft-lock** a month (only Accounts administrators can post)
or **lock** it (nobody can post, issue or cancel in it). Corrections of a locked month are credit or debit notes dated in
an open month. See the [administrator page](../admin/accounts.md#period-locks).

## What Accounts does not do

Returns, IRN and e-way bill generation, TDS and TCS, more than one GSTIN, foreign currency, exports with payment of
integrated tax, delivery challans, self-invoices under reverse charge, commercial credit notes without GST, per-unit
cess, the monthly set-off of input tax credit and tax payments, year-end closing. The ERP-lite pack's commercial invoice
is separate and stays without tax.
