# Printing and PDFs: administration

Letterhead, formats, fonts, limits and the service identity of print templates. Makers:
[guide/maker/print-templates.md](../guide/maker/print-templates.md); design: [dev/pdf.md](../dev/pdf.md).

## Letterhead and formats (per environment)

Dev mode > Print templates > **Letterhead and formats** (administrators; audited `print.settings`):

| Setting | Default | |
| --- | --- | --- |
| Company name, address, phone, email, website | blank | Printed at the top right of templates with a letterhead |
| GSTIN | blank | Printed as text ("GSTIN: ..."). Appbuilder does **no** tax calculation. |
| Logo | none | PNG or JPEG, at most 500 KB, printed at the top left (14 mm high) |
| Digit grouping | Indian (12,34,567.89) | or international (1,234,567.89) |
| Date format | dd-MM-yyyy | also dd/MM/yyyy, d MMM yyyy, yyyy-MM-dd, MM/dd/yyyy |
| Currency | the Settings table's DefaultCurrency (INR) | three-letter code |
| Time zone | the Settings table's TimeZone (Asia/Kolkata) | for dates with a time and `Now()` |

API: `GET/PUT /api/v1/print/settings`.

## Fonts

Bundled, nothing to install: **Noto Sans** (regular, bold, italic, bold italic; Latin, Greek, Cyrillic, ₹) and **Noto
Sans Devanagari** (regular, bold; Hindi, Marathi, Sanskrit ...), under the SIL Open Font License 1.1 (files and licence
texts in `server/core/print/fonts/`). Fonts are embedded (only the characters used) in every PDF. Other fonts cannot be
added yet; text in scripts these fonts do not cover prints as empty boxes.

## Limits

| Limit | Value | Change |
| --- | --- | --- |
| Pages per document | 500 | lower in the settings (`limits.maxPages`) |
| Rows read per document | 20,000 | lower (`limits.maxRows`) |
| Time per document | 60 s | 5 to 300 s (`limits.timeoutSeconds`) |
| Image size | 10 MB each, 60 MB per document | PNG and JPEG only |
| Records per bulk run | 2,000 | |
| Generated files kept | 24 hours | then deleted by the hourly job "Generated documents cleanup" (`sched_print_sweep`), unless a record kept a copy |
| Generation log | 90 days | same job |

Generation runs in the server process; bulk runs are a background job (`print.bulk`, one at a time). On the sandbox a
90-page table report takes 1 to 2 seconds.

## Service identity

By default a document is made with the access of the person printing (or the flow's identity, or each report recipient).
An administrator can make a template **run as a service account** (the template's API `runAs`), for example so that a
shop-floor role can print an inspection report that includes data they cannot open themselves. It is shown in red in the
list, audited when set (`print.run_as_service`) and for every document made that way (`print.generate_as_service`); only
administrators can change such a template afterwards.

## Locked production environments

Templates change only through solutions (design routes are refused); printing, the timeline action, flows and reports
work as usual.

## Troubleshooting

- **"The record was not found, or you may not read it"**: the person printing cannot read that record.
- **Blank values with a warning in the log** (designer > Log): a column is hidden from the person printing.
- **"The document has more than N pages"**: print fewer rows (a filter), or raise the limit.
- **Hindi prints as boxes**: the text is in another script, or the font of a Word template is missing on the reader's
  computer (Word files keep Word's fonts).
