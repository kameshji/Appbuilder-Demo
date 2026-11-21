# Accounts: setup, reference data and period locks

For administrators and Accounts administrators. What people do in Accounts day to day is in the
[guide](../guide/accounts.md); how it is built is in [dev/ledgers-gst.md](../dev/ledgers-gst.md).

> **The GST calculation rules in Accounts are a draft that has not yet been reviewed by a practising accountant.** The
> functional specification is [plan/gst-spec-draft.md](../plan/gst-spec-draft.md), unsigned. Do not describe an install
> as GST compliant. Have your accountant check the reference data you enter and the documents the software produces.
> Appbuilder files no return, creates no IRN or e-way bill, and connects to no government system.

## First setup (Accounts > Settings)

1. **Set up the books**: adds the default chart of accounts (a small general chart and the GST accounts: output and
   input CGST, SGST, UTGST, IGST and cess, reverse charge payable and input, advances, composition, round-off) and one
   number series per document type. It only adds what is missing; run it again any time.
2. **Reference data**. Appbuilder ships **no** rates, State codes or thresholds. Enter them in **Reference data** from a
   source your accountant approved. Every row has an effective-from date, an optional effective-to date, its source
   (notification number, date, schedule, serial number) and who approved it. **Load example data (not approved)** adds
   the State list and the values named in the draft specification, each marked "EXAMPLE, NOT APPROVED" with nobody as
   approver; it adds no rates. Replace or confirm those rows with your accountant.
3. **Business registration**: legal name, address, State code, registration type, GSTIN (only the length, the
   characters and the State code are checked), turnover per financial year (decides the HSN digits and the e-invoice
   class), LUT reference per financial year (needed for exports and SEZ supplies without payment of integrated tax),
   and three settings: tax per line or per rate per document, round the total to the rupee, allow a manual place of
   supply. One GSTIN per install.
4. **Periods > Add financial year**: creates the year with its 12 monthly periods. Nothing can be posted on a date
   without a period.
5. **Customers and suppliers**, **Items**: registration type, GSTIN and State code for parties; HSN or SAC code, supply
   class and rate reference for items.

## Reference data

| Section | What it holds |
| --- | --- |
| Rates | per HSN or SAC code or prefix: IGST, CGST, SGST/UTGST and cess rates. CGST + SGST/UTGST must equal IGST; rows for the same code and condition may not overlap in time; the longest matching code wins on the document date. A rate change is a new row: end the old one the day before |
| States | code, name, kind, whether intra-territory supplies use UTGST |
| Values | dated numbers and texts the calculations read, by key (below) |
| Units | unit codes for quantities |
| Reverse charge | categories of inward supplies under reverse charge |

Keys in **Values** that the software reads:

| Key | Meaning |
| --- | --- |
| `financial_year_start_month` | first month of the financial year (required before a year can be added) |
| `credit_note_deadline` | last day for a GST credit note after the financial year of the supply, as month-day (`11-30`); `credit_note_deadline:2025-26` (a date) sets an earlier day for one year |
| `rate_change_confirm_days` | days after a rate change in which the user must confirm the rate date |
| `hsn_digits_small`, `hsn_digits_large`, `hsn_turnover_limit`, `hsn_optional_unregistered` | HSN digits required by the previous year's turnover |
| `einvoice_turnover_threshold` | turnover of any earlier year above which B2B documents are marked "IRN required" |
| `eway_consignment_value` | consignment value above which the document asks for an e-way bill number |
| `unregistered_details_value` | taxable value from which an unregistered recipient needs name, address and State |
| `b2c_large_value` | invoice value for the "B2C large" summary |
| `other_country_code` | place-of-supply code printed for supplies outside India |
| `composition_rate_cgst:<category>`, `composition_rate_sgst:<category>` | composition tax rates (manufacturer, restaurant, other, services) |

A value that is missing switches its check off (the document shows a note), except the financial year month, the States
and the rates, without which nothing is issued.

## Who may use Accounts

Administrators of the environment are Accounts administrators. For other roles choose a level in **Settings > Who may
use Accounts**: Read, Post or Accounts administrator. **Create the Accountant role** adds a role named Accountant with
the Accounts administrator level; give it to people in Users. The levels are enforced by the server on every request.

## Period locks

| State | Who can post, issue or cancel on dates in the month |
| --- | --- |
| Open | everyone with the Post level |
| Soft-locked | Accounts administrators only |
| Locked | nobody |

An Accounts administrator sets Soft-locked or Locked in **Periods**. A soft lock is removed by an Accounts
administrator; a **lock is removed only by an install administrator**, and both need a typed reason. Every change is in
the audit log (`accounts.period.lock`, `accounts.period.unlock`). Corrections of a locked month are credit or debit
notes dated in an open month. Appbuilder does not know your filing dates: lock a month when your accountant has
finished it.

## What is recorded and what cannot be undone

- Every change in Accounts is in the environment's audit log under `accounts.*` (documents issued and cancelled, journals,
  reference data with before and after, settings, access).
- Issued documents, posted journals and their lines are never edited or deleted. The recycle bin does not apply to them.
- A read-only install refuses every change in Accounts; reading, CSV downloads and PDFs keep working.
- Copying an environment does not copy the books: the copy starts with empty Accounts.
- Backups cover the environment's database schema, which holds the Accounts tables. Restoring Accounts data from a
  backup has not been tested yet: test a restore before you depend on it.
