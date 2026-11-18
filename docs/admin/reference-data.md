# Reference data, number sequences and the financial year

Every environment has a set of reference tables that all apps share: **Currencies, Units of measure, Countries, States,
Calendars, Holidays, Number sequences and Settings**. They are filled in when the environment is created (or upgraded) and
are yours to maintain afterwards: administrators add, change and deactivate rows in Dev mode > Tables > System tables >
Reference data, like any table. Everyone else can read them. Makers can add columns to them (for example a `Region` on
States).

Each environment has its own copy: a change in the sandbox does not change production. Solutions do not carry reference
rows; a copy of an environment carries them (a schema-only copy takes the freshly seeded ones).

The seed runs once per table and environment. If you delete seeded rows they are not put back on the next upgrade.

## What is seeded, and where it comes from

| Table | Rows | Source |
| --- | --- | --- |
| Currencies | 159 currencies: ISO 4217 code, English name, narrow symbol (₹, $), decimal places. **INR is the default** (exchange rate 1); the others have no rate. | Unicode CLDR 48.0 (as shipped in Node.js 22, ICU 78.3), read through `Intl.DisplayNames` and `Intl.NumberFormat` when the list was generated; funds and precious-metal codes are left out. |
| Countries | 249 countries and territories: ISO 3166-1 alpha-2 code and English short name. | Unicode CLDR 48.0, as above. |
| States | The 36 Indian states and union territories with their **GST state code** (01 to 38), plus codes 25 (Daman and Diu, July 2017 to January 2020) and 28 (Andhra Pradesh before its division) as **inactive** rows, so old invoices still resolve. | The GST state code list published by the Nagaland Taxes Department (`nagalandtax.nic.in/docs/GST/Statistics/GST_State_Code_List.pdf`), checked on 18 Nov 2026. |
| Units of measure | 33 units in seven dimensions (count, mass, length, area, volume, time) with a conversion factor to the base unit of their dimension (NOS, KG, M, SQM, L, SEC). Codes follow the units used on Indian GST invoices where there is one (NOS, PCS, KG, QTL ...). | Factors are the exact SI definitions (1 lb = 0.45359237 kg, 1 ft = 0.3048 m). |
| Calendars | One calendar, **Standard**: Asia/Kolkata, Monday to Saturday, 09:30 to 18:00. | |
| Holidays | Empty. Holidays differ by state and by year; add yours (name, date, optional, region) for each calendar. | |
| Number sequences | Empty. Add one per document type (see below). | |
| Settings | `FinancialYearStartMonth` = 4, `DefaultCurrency` = INR, `DefaultCountry` = IN, `TimeZone` = Asia/Kolkata. | |

Exchange rates are not fetched from anywhere: Appbuilder makes no outside calls. If your apps convert currencies, keep
the `ExchangeRate` column up to date yourself (the rate of one unit of the currency in the default currency), or from a
flow when flows arrive.

To use another default currency, set `IsDefault` on that currency (and clear it on INR) and change the
`DefaultCurrency` setting.

## Settings

Settings is a key/value table. Apps read a value with `Setting("key")`, for example `Setting("DefaultCurrency")`. Add your
own keys (a support email, a GST number, a default price list); keys are unique.

## The financial year

`FinancialYearStartMonth` is the month the financial year starts, 1 to 12. The default, **4 (April)**, is the Indian
financial year: 1 April 2026 to 31 March 2027 is "2026-27". With 1 the financial year is the calendar year ("2026").
Number sequences that reset every financial year, and `{FY}` in their prefixes, use this setting.

## Number sequences

A number sequence hands out document numbers such as `INV/2026-27/0042`. Add a row to **Number sequences**:

| Column | Meaning |
| --- | --- |
| Name | The name apps use: `NextNumber("Invoices")`. Unique. |
| Prefix, Suffix | Text before and after the number. `{FY}` becomes the financial year (2026-27), `{YYYY}` the year, `{YY}` its last two digits, `{MM}` the month. |
| Padding | Digits, filled with zeros (4 gives 0042). |
| Next value | The next number to hand out (1 for a new sequence). Change it to start somewhere else, for example after migrating old invoices. |
| Reset | **Never**, **Yearly** (1 January) or **Financial year** (the first day of the financial year): the first number of a new period is 1. |

Example: Name `Invoices`, Prefix `INV/{FY}/`, Padding 4, Reset Financial year gives `INV/2026-27/0001`,
`INV/2026-27/0002` ... and `INV/2027-28/0001` from 1 April 2027.

Makers use a sequence as the default of a column, `=NextNumber("Invoices")`, or call `NextNumber("Invoices")` in a
formula or a table event.

**Guarantees.** Numbers are handed out by the server inside the transaction that saves the row: the sequence row is
locked until the save commits, so two people saving at the same moment get different numbers, and a save that fails (a
validation rule, a lost connection) gives its number back. The numbers are therefore **gap-free** for saves that succeed,
which is what GST invoice numbering needs. The price is that saves using the same sequence wait for each other for the
few milliseconds a save takes. A row deleted later leaves its number unused (Appbuilder never reuses a number).

GST rules to keep in mind (your accountant has the final word): an invoice number may have at most 16 characters, may use
letters, digits, `-` and `/`, and must be unique within a financial year. Keep prefixes short (`INV/{FY}/` with padding 4
is 15 characters).
