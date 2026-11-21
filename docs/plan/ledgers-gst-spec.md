# Package L: ledgers and India GST (working prototype)

Status: **prototype built on an unsigned draft.** The functional specification is
[gst-spec-draft.md](gst-spec-draft.md) (version 0.1-draft), which a practising accountant has **not** reviewed. The
owner decided on 21 November 2026 to build on the draft now and send corrections later. Nothing here may be described
as compliant, certified or correct in law. Rule numbers (`G5.6`, `W3`) are the draft's.

Design rules that follow from that decision:

1. Every value the draft marks as data is a dated row an Accounts administrator edits (rates, States, thresholds, units,
   reverse charge categories). Nothing of that kind is a constant in code. Reference tables ship **empty**; "Load example
   data" adds rows marked `not approved` (States and the thresholds of draft section 11.2, no rates).
2. Every rule lives in one place: `server/core/gst/money.ts` (decimal arithmetic), `server/core/gst/engine.ts` (pure
   functions: place of supply, rate lookup, computation, rounding, numbering, HSN digits, deadlines) and
   `server/core/gst/postings.ts` (journals of draft section 9). Tests cite the rule numbers.
3. Where the draft says "to be confirmed" the draft's stated default is implemented. The list is in
   [docs/dev/ledgers-gst.md](../dev/ledgers-gst.md).

## 1. Data model (schema version 15, per environment, own tables)

| Table | Holds |
| --- | --- |
| `ab_led_accounts` | chart of accounts: code, name, kind (asset, liability, equity, income, expense), `system_key` for accounts the postings use |
| `ab_led_years`, `ab_led_periods` | financial years and their monthly periods; period state `open`, `soft_locked`, `locked` |
| `ab_led_journals`, `ab_led_lines` | posted journals and their lines (integer paise; a line is a debit or a credit, never both) |
| `ab_led_settings` | key/value: the business registration, module settings, which role has which Accounts level |
| `ab_gst_states`, `ab_gst_rates`, `ab_gst_thresholds`, `ab_gst_units`, `ab_gst_rcm` | reference data with `effective_from`, `effective_to`, `source`, `approved_by`, `approved_on` |
| `ab_gst_parties`, `ab_gst_items` | customers and suppliers with GST fields; items and services with HSN/SAC, rate reference and supply class |
| `ab_gst_series`, `ab_gst_series_counters` | number series per document type; one counter per series and financial year |
| `ab_gst_documents`, `ab_gst_document_lines` | documents (draft, issued, cancelled) and their computed lines |

Money is `bigint` paise; quantities `numeric(18,3)`, unit prices `numeric(18,4)`, rates `numeric(7,3)`. No floats.
The tables are not copied with an environment and do not travel in solutions.

## 2. Access

Levels: `view` (read everything), `post` (drafts, issue, journals), `admin` (settings, reference data, lock periods,
post into a soft-locked period). Environment administrators are `admin`. Other roles get a level in Accounts > Settings
(stored in `ab_led_settings`); "Create the Accountant role" adds a role named Accountant with the `admin` level.
Unlocking a locked period needs an install administrator and a typed reason (G9.10). Every change is audited
(`accounts.*`).

## 3. Routes (`/api/v1/accounts/...`)

`GET state`; `GET|PUT business`; `GET|PUT access`, `POST access/accountant-role`; `POST setup` (seed the default chart
and series); `GET|POST reference/:kind`, `PATCH|DELETE reference/:kind/:id`, `POST reference/examples`;
`GET|POST parties`, `PATCH parties/:id`; `GET|POST items`, `PATCH items/:id`; `GET|POST series`, `PATCH series/:id`;
`GET|POST chart`, `PATCH chart/:id`; `GET|POST years`; `POST periods/:id/lock`, `POST periods/:id/unlock`;
`GET|POST journals`, `GET journals/:id`, `POST journals/:id/reverse`; `GET ledger`;
`GET reports/trial-balance|profit-loss|balance-sheet` (`format=csv`);
`GET|POST documents`, `GET|PATCH|DELETE documents/:id`, `POST documents/:id/issue`, `POST documents/:id/cancel`,
`POST documents/:id/record` (IRN, e-way bill, notes), `GET documents/:id/pdf`; `GET returns/:name` (`format=csv`).

All reads are GET; every other method is refused while the install is read-only (the router's default).

## 4. Postings (draft section 9)

Tax invoice, bill of supply, debit note: Dr Trade receivables (party); Cr Sales by supply class; Cr Output CGST / SGST /
UTGST / IGST / Cess; round-off to Round-off (G9.1, G9.2). Credit note: the reverse, with Sales returns or Sales
discounts by reason (G9.3). Purchase invoice: Dr Purchases or the line's expense account; Dr Input taxes when the line's
ITC flag is `eligible`, otherwise the tax goes into the expense; Cr Trade payables (G9.4). Reverse charge lines: Dr Input
(RCM) or expense; Cr RCM payable (G9.5). Receipt voucher: Dr Bank; Cr Customer advances; for services also Dr GST on
advances suspense; Cr Output taxes (G9.6). Refund voucher: the reverse of its receipt voucher. Payment voucher: Dr Trade
payables; Cr Bank. Cancellation posts a reversal journal dated the cancellation date (G7.9).

Journal rules, checked inside the posting transaction: at least two lines, debits equal credits, the date lies in a
period that exists and is open (soft-locked: Accounts admin only; locked: nobody), posted journals and lines are never
updated or deleted, a correction is a reversal journal. The document, its number and its journal commit together.

## 5. In and out

In: draft sections 2 to 10 as far as listed above; PDF for tax invoice, bill of supply and credit note; 13 return
summaries as data and CSV. Out (not built): filing or any portal connection, IRN or e-way bill generation (numbers are
recorded only), TDS/TCS, more than one GSTIN, foreign currency, exports with payment of IGST, delivery challan fields,
self-invoices, commercial (non-GST) credit notes, specific (per unit) cess, set-off of ITC and tax payment postings,
year-end closing entries, the composition services-turnover counter, automatic posting of the composition tax,
spreadsheet export (CSV only), the INV-01 export file.

## 6. Exit checks (`scripts/exit-check/p3-ledgers.mjs`)

1. Setup: business registration saved, default chart seeded with the GST accounts of draft 9.1, a financial year with 12
   periods, reference data entered through the API.
2. An intra-State tax invoice (W1) is issued: number from the series, CGST = SGST, journal balanced (G9.1).
3. An inter-State tax invoice (W2) is issued with IGST (G9.2a).
4. A credit note against the first invoice (W8) is issued; a second one above the remaining value is refused (G5.12).
5. The trial balance balances and shows the expected output tax and receivable balances.
6. The PDFs of the two invoices and the credit note exist (`%PDF`, more than 1 kB) and an issued document cannot be edited.
7. A locked period refuses an issue and a journal; unlocking needs a reason.
8. A STOP case (a service in a special place-of-supply category) refuses to issue and names the reason.
9. The Accounts area in the real UI: settings show the "draft, not reviewed" notice, the document list shows the issued
   documents, the trial balance page shows equal totals.
10. Return summaries answer as data and as CSV.
