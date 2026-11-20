<!-- GENERATED FILE. Do not edit by hand: change the code (or the hand-written parts in scripts/docs/) and run `npm run docs:gen`. -->

# Print templates reference

The blocks of a print template, the names and functions its formulas see, page sizes and limits. Guide: [print templates for makers](../guide/maker/print-templates.md); design: [docs/dev/pdf.md](../dev/pdf.md).

Every text property accepts formulas in `{...}` (write `{{` and `}}` for literal braces). Properties named rows, value, label, visible and the values of key-value entries are formulas themselves. Sizes are millimetres, font sizes points.

## Blocks

### Text

#### Heading (`heading`)

A title line in one of three sizes, in the heading colour.

| Property | What it is |
| --- | --- |
| `text` | Text with {formula} parts |
| `level` | 1, 2 or 3 |
| `align` | left, center, right |
| `color` | Colour (#rrggbb); blank: the template's heading colour |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Rich text (`text`)

Paragraphs with **bold**, *italic*, __underline__, [color=#c00]colour[/color], bullet ("- ") and numbered ("1. ") lists and {formula} parts.

| Property | What it is |
| --- | --- |
| `text` | The text; a blank line starts a new paragraph |
| `align` | left, center, right, justify |
| `size` | Font size in points |
| `color` | Colour (#rrggbb) |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

### Data

#### Key-value grid (`keyValue`)

Labels and values in 1 to 4 columns (record fields, totals, KPIs).

| Property | What it is |
| --- | --- |
| `items` | Label and value formula (with an optional format) per entry |
| `columns` | 1 to 4 |
| `labelWidth` | Label width in mm |
| `boxed` | Draw a box around each entry (KPI tiles) |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Table (`table`)

Rows from a related list, a query or a formula; column widths, header repeated on every page, zebra rows, totals, grouping with subtotals; a row is never split across pages.

| Property | What it is |
| --- | --- |
| `rows` | Formula returning the rows: Related.<name>, Rows, or a delegable Filter(...) |
| `columns` | Header, value formula over ThisItem, width (mm) or share, alignment, format (number, currency, percent, date ...) and total (sum, count, avg, min, max, label) |
| `repeatHeader` | Header row on every page (default on) |
| `style` | grid, lines, zebra or plain |
| `groupBy` | Formula over ThisItem; rows are grouped by its value |
| `groupHeader` | Group header text: {Group}, {Count} |
| `subtotals` | A subtotal row after each group |
| `totals` | A totals row at the end |
| `avoidRowBreak` | Keep each row on one page (default on) |
| `emptyText` | Shown when there are no rows |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Repeated section (`repeat`)

Its blocks once per child row (ThisItem is the row), optionally a page per row.

| Property | What it is |
| --- | --- |
| `rows` | Formula returning the rows |
| `blocks` | The blocks of one section |
| `pageBreakBetween` | Start every section on a new page |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Approval history (`approvals`)

Who decided what and when on the record's approval requests (stage, person, decision, comment, date), as far as the generating identity may read them.

| Property | What it is |
| --- | --- |
| `title` | Heading above the table |
| `emptyText` | Shown when there was no approval |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

### Graphics

#### Image (`image`)

The letterhead logo, an image kept in the template, or photos from an image or file column (several in a grid).

| Property | What it is |
| --- | --- |
| `source` | logo, static (uploaded into the template) or attachment |
| `value` | attachment: formula returning image values, e.g. Photos |
| `width` | mm |
| `height` | mm (blank: keep the aspect ratio) |
| `align` | left, center, right |
| `perRow` | Images per row for several images |
| `caption` | Text under each image |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Chart (`chart`)

Bar, line, pie or gauge chart drawn as vectors.

| Property | What it is |
| --- | --- |
| `chartType` | bar, line, pie or gauge |
| `rows` | Formula returning the rows (bar, line, pie) |
| `label` | Category formula over ThisItem |
| `values` | Series: name, value formula over ThisItem, colour; gauge: the first value formula is the value |
| `min` | Gauge minimum |
| `max` | Gauge maximum |
| `bands` | Gauge band limits as fractions, e.g. 0.6, 0.85 |
| `height` | mm |
| `title` | Title above the chart |
| `unit` | Unit after values, e.g. % |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Barcode or QR code (`barcode`)

Code 128 barcode or QR code drawn as vectors (scannable on paper).

| Property | What it is |
| --- | --- |
| `symbology` | code128 or qr |
| `value` | Formula: the encoded text |
| `width` | mm |
| `height` | mm |
| `showText` | Print the text under a barcode |
| `align` | left, center, right |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

### Layout

#### Columns (`columns`)

Two to four side-by-side columns, each with its own blocks.

| Property | What it is |
| --- | --- |
| `columns` | Width (mm, blank: share) and the blocks of each column |
| `gap` | Space between columns in mm |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Signature lines (`signature`)

One to four signature lines with labels and an optional date line.

| Property | What it is |
| --- | --- |
| `labels` | One label per line, e.g. Inspected by, Approved by |
| `showDate` | A "Date" line under each |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Spacer (`spacer`)

Empty vertical space.

| Property | What it is |
| --- | --- |
| `height` | mm |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Line (`line`)

A horizontal rule.

| Property | What it is |
| --- | --- |
| `thickness` | Points |
| `color` | Colour |
| `dashed` | Dashed line |

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

#### Page break (`pageBreak`)

The next block starts on a new page.

Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).

## Names in formulas

| Name | What it is |
| --- | --- |
| `ThisRecord, Record, or a column name` | The record (record source; a formula source returning a record). Lookups print the target's primary column. |
| `Related.<name>` | A related list of the record source (child rows whose lookup points at the record). |
| `Rows` | The rows of a query source, or of a formula source returning a table. |
| `ThisItem` | The row inside a table column, a repeated section, a chart, a group header. |
| `Company` | The letterhead: Name, Address, Phone, Email, Website, GSTIN. |
| `User()` | The identity the document is generated as: FullName, Email, Id. |
| `{PageNumber}, {PageCount}` | Header and footer texts only: the page number and the number of pages. |
| `{Group}, {Count}` | Group header texts of tables: the group's value and its number of rows. |

## Functions of print templates

Besides every pure formula function (and delegable table reads such as LookUp and Filter, read as the generating identity):

| Function | What it does |
| --- | --- |
| `FormatNumber(value [, decimals])` | A number with the environment's digit grouping: Indian (12,34,567.50) or international (1,234,567.50). |
| `FormatCurrency(value [, currency [, decimals]])` | An amount with the currency symbol, e.g. ₹12,34,567.00 (currency: the environment's, else a code such as "USD"). |
| `FormatPercent(value [, decimals])` | A fraction (0.785) or a percentage (78.5) as 78.5%. |
| `FormatDate(value [, pattern])` | A date in the environment's date format, or a pattern: yyyy, yy, MMMM, MMM, MM, M, dd, d, HH, H, hh, h, mm, ss, a; text in single quotes is literal. |
| `Now(), Today()` | The date and time of the generation (the time zone of the print settings). |

## Page sizes

| Size | Width x height (mm, portrait) |
| --- | --- |
| `A4` | 210 x 297 |
| `A5` | 148 x 210 |
| `Letter` | 215.9 x 279.4 |
| `Legal` | 215.9 x 355.6 |

`custom`: 50 to 1,200 mm each way. Orientation portrait or landscape; margins 0 to 100 mm.

## Limits

| Limit | Value |
| --- | --- |
| `maxPages` | 500 |
| `maxRows` | 20000 |
| `timeoutSeconds` | 60 |
| `maxImageMB` | 10 |
| `maxImagesMB` | 60 |
| `maxBlocks` | 400 |
| `maxNesting` | 6 |
| `maxDocBytes` | 2097152 |
| `maxStaticImageBytes` | 614400 |
| `bulkMaxRecords` | 2000 |
| `fileTokenHours` | 24 |
| `docxMaxMB` | 10 |

## The flow step `document.generate`

Makes a PDF (or Word file) from a print template as the run-as identity: for a record, or from the template's own query. Keep it as a file (attach it to an email with {fileToken: Steps.<name>.Output.FileToken}), put it in a file column of the record, or store it in the record's Documents.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `template` | text | yes | The print template (name or id); its published version is used. |
| `record` | Fx |  | The record id (templates with a record source), e.g. Trigger.Record.id. |
| `output` | file \| record \| documents |  | file (default): only the generated file; record: into the file column `column` of the record; documents: a Documents entry about the record. |
| `column` | text |  | output record: the file column. |
| `numberSequence` | text |  | output documents: the number sequence that numbers the document. |

**Output:** { FileToken, FileName, Pages, Warnings, AttachmentId?, DocumentId? }

**Guarantee:** At least once: a retry makes the same file again under the same token (key run:step); a retry after the record was changed adds the file again.
