# Ledgers and India GST (P3 package L)

Status: **a working prototype on an unsigned draft.** The functional specification is
[plan/gst-spec-draft.md](../plan/gst-spec-draft.md) (0.1-draft), which no practising accountant has reviewed; the owner
decided on 21 November 2026 to build on it and send corrections later. Never call the result compliant, certified or
correct in law, in the UI, in docs or on documents. The module's own short spec is
[plan/ledgers-gst-spec.md](../plan/ledgers-gst-spec.md). People: [guide/accounts.md](../guide/accounts.md);
administrators: [admin/accounts.md](../admin/accounts.md).

## Where things are

| File | What it does |
| --- | --- |
| `server/core/gst/money.ts` | Decimal arithmetic: integer paise, BigInt while multiplying, half away from zero, apportioning (G5.4) |
| `server/core/gst/engine.ts` | The rules as pure functions: `determineSupply` (decision table T1 to T13 and every STOP case), `findRate`, `computeDocument`, numbering, HSN digits, credit note deadline and limit, consignment value, e-invoice class, composition tax, GSTIN shape, financial year |
| `server/core/gst/postings.ts` | The journals of draft section 9: computed document in, balanced journal lines out (by account system key) |
| `server/core/gst/reference.ts` | Business registration, the dated reference tables, parties, items, number series, the example data |
| `server/core/gst/documents.ts` | `prepare` (input to figures), drafts, `issueDocument`, `cancelDocument`, `recordOnIssued` |
| `server/core/gst/pdf.ts` | Tax invoice, bill of supply, credit and debit note as resolved blocks for the print engine (`print/layout.ts`, `print/pdf.ts`) |
| `server/core/gst/returns.ts` | The 13 return summaries as rows (data and CSV) |
| `server/core/ledger/ddl.ts` | Schema version 15: `ab_led_*`, `ab_gst_*` |
| `server/core/ledger/service.ts` | Chart, years and periods, `postJournal`, `reverseJournal`, trial balance, ledger, profit and loss, balance sheet |
| `server/core/ledger/core.ts`, `routes.ts` | Access levels, settings, audit, CSV; every `/accounts/...` route |
| `src/portal/accounts/**` | The Accounts page (`#u-accounts`): Documents, Journals, Ledger, Reports, Return summaries, masters, Periods, Reference data, Settings |
| `scripts/exit-check/p3-ledgers.mjs` | The exit checks against a real server and browser |

## Rules for changing it

1. **A value the draft marks as data stays data.** Rates, State codes, thresholds, the financial-year month, the credit
   note deadline, composition rates: dated rows in `ab_gst_*` with `effective_from`, `effective_to`, `source`,
   `approved_by`, `approved_on`. Nothing of that kind is a constant in `engine.ts`; it receives them as arguments. The
   product ships the tables empty; `loadExamples` adds States and the values of draft 11.2 marked "EXAMPLE, NOT
   APPROVED", never rates.
2. **One rule, one place.** A correction from the accountant should be a change in `money.ts` (rounding), `engine.ts`
   (a decision or a formula) or `postings.ts` (a journal), with its test. Tests name the rule (`G5.6`, `W7`).
3. **STOP means stop.** `StopError(rule, message)` becomes a 422 with `stop: { rule }` in the body; the draft keeps its
   state and no number is taken. Do not add a default where the draft says STOP.
4. **Money is integer paise** (`bigint` columns, JavaScript safe integers), quantities `numeric(18,3)`, prices
   `numeric(18,4)`, rates `numeric(7,3)`, all parsed from text by `parseDecimal`. No `Number` arithmetic on amounts.
5. **No wording about the draft on customer documents** (`pdf.ts`); the notice lives in `DRAFT_NOTICE` (`ledger/core.ts`)
   and is shown by Settings and Reference data.

## How a document is issued

`issueDocument` runs in one transaction: lock the draft row (and the original of a note, so two notes cannot both take
what it still has) → `assertPostable` (the period row `FOR SHARE`; a period lock takes it `FOR UPDATE`) → `prepare` on
the reference data of the document date → refuse a back-dated number → take the number
(`INSERT ... ON CONFLICT DO UPDATE` on `ab_gst_series_counters`, the row stays locked until commit, so numbers are
consecutive and a failed issue takes none) → write the lines → `postJournal` (lines from `postingLines`) → mark the
document issued with its frozen `snapshot`. `postJournal` checks debits = credits on the input and again on the stored
rows, the period, and that accounts exist and are active. There is no code path that updates or deletes a posted
journal, a journal line or an issued document's figures; a correction is `reverseJournal` (at most one per journal: a
unique index on `reverses`) or a credit or debit note.

Enforced by the database itself: a ledger line is a debit or a credit, not both, not zero (CHECK); document numbers are
unique per financial year whatever the letter case; one reversal per journal; one default series per document type.
Enforced by the service inside the transaction (not by triggers): debits = credits per journal, no posting into a
locked period, immutability. Triggers were left out to keep the tables plain: backup, restore and environment copy
were not tested with triggers or functions in an environment schema.

## Access

`levelOf` (`ledger/core.ts`): environment administrators are `admin`; other roles get `view`, `post` or `admin` from the
`access` setting (role id to level). The role model has no custom permissions, so the mapping lives in
`ab_led_settings`. Every route calls `need(level)`. Unlocking a locked period also needs an install administrator.

## Draft defaults chosen where the draft says "to be confirmed"

| Question (draft 11.1) | What the code does |
| --- | --- |
| Q1 tax per line or per document | Per line by default; "per rate per document" is a business setting (not dated) |
| Q2, Q26 round-off | Total rounded to the rupee (50 paise up), a round-off line and posting; the same on credit and debit notes; a setting switches it off |
| Q3 CGST / SGST | Each computed from the taxable value at its own rate, never a split of a total |
| Q4 credit notes | Tax type, place of supply and rates of the original; limited to what the invoice still has (per component, by earlier credit notes); **one** original invoice per note |
| Q5 advances | Services only, treated as tax-inclusive, the G9.6 suspense journal; the reversal of the suspense on the final invoice is **not** posted; advances for goods carry no tax |
| Q6, Q9 reverse charge | Categories are data; an inward line is reverse charge when its item has a category or the line is ticked; rate from the rate table; no self-invoice |
| Q7 rule 46A | Taxable and exempt lines are refused on one document: two documents |
| Q8, Q10 composition | State share = central share as data; turnover = every outward document of the period, credit notes subtracted; helper only, nothing posted; no services-limit counter |
| Q11 switching composition / regular | Not guarded: the registration type is whatever the setting says on the day of issue |
| Q12 rate change | Rate at the document date; within `rate_change_confirm_days` after a change the user confirms the rate date |
| Q13 cess | Ad valorem computed; a specific (per unit) cess is a STOP |
| Q14 freight | A charge linked to a line joins its taxable value; a whole-document charge is apportioned by value (the UI offers one whole-document charge) |
| Q15 document discount | Spread over the taxable lines by value, remainder on the largest |
| Q16 commercial credit note | Not built; a late GST credit note is refused |
| Q18 tax-inclusive | taxable = inclusive / (1 + rate), taxes forward, difference to round-off; the payable total is the rounded inclusive amount |
| Q19 commercial invoice by a registered business | Not enforced: ERP-lite is untouched |
| Q20 number uniqueness | Case-insensitive per financial year |
| Q21 gaps | None can arise from a failed issue (the counter rolls back); nothing is reported |
| Q22 cancellation | Allowed without IRN, payment and later notes, in an open period; reversal dated the cancellation date |
| Q23 INV-01 export | Not built |
| Q24 rule 46(s) declaration | Not printed |
| Q25 set-off and payment | Not posted |
| Q27 ITC on reverse charge | Posted with the purchase when the flag is eligible |
| Q28 periods | Calendar months; open, soft-locked, locked |
| Q29 one GSTIN | One registration per environment |
| Q30, Q32 States, units | Data; the example State list is marked not approved; "outside India" is stored as `OTHER`, printed with the `other_country_code` value |
| Q31 GSTIN check digit | Not applied |
| Q33 STOP list | As in G3.9; installation at site (T13) is computed |
| Q34 export of services | A per-document confirmation by the user; who confirmed is the issuer in the audit log |
| Q38 B2C large | The `b2c_large_value` value; the HSN summary is not split B2B / B2C |
| Q40 financial year | The `financial_year_start_month` value (the example says 4) |

Other choices the draft does not settle: an outward supply of an item with a reverse charge category is a STOP; an
inward document's tax type follows the supplier's State against the business's State unless `inwardTax` overrides it; a
purchase cannot be posted with an "undecided" ITC flag (so the flag never changes after posting); HSN digits use the
turnover of the financial year before the document's; the recipient-details check of rule 46(e) is not applied to
zero-rated documents.

## Not built

Filing and any portal connection; IRN and e-way bill generation; TDS / TCS; several GSTINs; foreign currency; exports
with payment of IGST; delivery challan fields; self-invoice; commercial credit note; per-unit cess; ITC set-off and
payment postings; year-end closing; the composition services counter and posting; spreadsheet (XLSX) export; INV-01
file; the 20-day IRN warning; the service-invoice time-limit warning; several original invoices per note; the
ERP-lite sales invoice as a GST tax invoice; a solution pack. The module's States table duplicates the core data
model's (undated) States reference data on purpose: GST reference rows are dated and carry a source.

## Tests

| Command | What it proves |
| --- | --- |
| `npx vitest run server/core/gst/engine.test.ts` | W1 to W32, the decision table, STOP cases, rates by date, discounts and charges, the small rules |
| `npx vitest run server/core/gst/postings.test.ts` | Every journal of G9.1 to G9.7, always balanced |
| `npx vitest run server/core/ledger/ledger.integration.test.ts` (needs `APPBUILDER_TEST_DB`) | Over HTTP as real users: migration 14 to 15, access levels, journals, period locks, documents, numbering under parallel issues, credit note limits, purchases, vouchers, cancellation, PDFs, summaries |
| `node scripts/exit-check/p3-ledgers.mjs` (after `npm run build`) | The exit checks of the spec against a real server and the real page |
