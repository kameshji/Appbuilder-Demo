# PDF and documents out: print templates (P2 package B)

Print templates turn a record, the rows of a query or a formula's result into a PDF (or a Word file) on the server. This
page is the design: the template model, the engine, fonts and shaping, data and security, generated files, the API
surfaces and the limits. Makers: [guide/maker/print-templates.md](../guide/maker/print-templates.md); administrators:
[admin/printing.md](../admin/printing.md); people: [help/printing.md](../help/printing.md); every block and function:
[reference/print-templates.md](../reference/print-templates.md) (generated). Decision: [decisions.md](../decisions.md), "Print templates" (P2 package B).

| Module | What it does |
| --- | --- |
| `src/platform/print.ts` | The template model (shared): page setup, source, styles, header/footer, the 14 block kinds, the block catalogue, `docProblems`, `normaliseDoc`, the rich text markup parser, `{formula}` splitting |
| `src/platform/print-format.ts` | Number (Indian / international grouping), currency, percent and date formatting (pure, deterministic) |
| `server/core/print/text.ts` | Fonts (bundled Noto Sans, Noto Sans Devanagari), script runs, measurement with fontkit's shaping |
| `server/core/print/layout.ts` | The layout engine: resolved blocks -> boxes -> pages of drawing operations |
| `server/core/print/pdf.ts` | Pages -> PDF with pdfkit (subset embedded fonts, vectors, images, ActualText for Devanagari lines) |
| `server/core/print/barcode.ts`, `chart.ts`, `images.ts` | Code 128 encoder and QR (qrcode-generator); bar/line/pie/gauge charts as vector shapes (+ `printChartSvg`); PNG/JPEG sniffing |
| `server/core/print/bind.ts` | Data binding: the source read as the generating identity, every formula evaluated, blocks resolved, warnings |
| `server/core/print/docx.ts` | Word output with the free core of docxtemplater |
| `server/core/print/service.ts`, `routes.ts`, `ddl.ts`, `alm.ts`, `builtins.ts` | Templates, versions, settings, generation, the log, generated files, bulk jobs, the API, schema 11 tables, solutions, built-in templates |
| `src/print/**` | The designer page (Dev mode > Print templates), the client API, `Print`/`GeneratePdf`/`GenerateDocx`, the timeline action |
| `src/controls/inputs/PrintButton.tsx` | The Print button UI component |

## Libraries and licences

| Library | Licence | Used for |
| --- | --- | --- |
| pdfkit 0.20.2 | MIT | Writing the PDF (objects, content streams, font subsetting and embedding, images) |
| fontkit 2.0.4 (and restructure, unicode-properties, unicode-trie, dfa, brotli, tiny-inflate, clone, fast-deep-equal: MIT; @swc/helpers: Apache-2.0) | MIT | OpenType parsing and shaping (GSUB/GPOS, the Indic shaper) |
| linebreak, png-js (MIT, LICENSE file; exception entry because package.json declares none), fflate, @noble/ciphers, @noble/hashes | MIT | pdfkit dependencies |
| docxtemplater 3.71.1 (core only) | MIT (dual MIT/GPL-3; we use MIT) | Word templates |
| pizzip 3.3.0 | MIT (dual MIT/GPL-3; we use MIT) | The .docx zip |
| qrcode-generator (already a dependency) | MIT | QR matrices |
| Noto Sans, Noto Sans Devanagari (font files in `server/core/print/fonts/` with their `OFL-*.txt`) | SIL OFL 1.1 | The only fonts; embedded (subset) in every PDF, which the OFL allows |

No headless browser and no HTML renderer: the engine lays out its own block model. `npm run licences` checks the npm
packages; the fonts are not npm packages, so the licence gate does not see them: their OFL texts ship next to them (the
release build copies files named with `new URL(...)`) and THIRD-PARTY-NOTICES should list them (owner action at phase close).

## The template model

A document (`PrintTemplateDoc`, `version: 1`): `page` (A4, A5, Letter, Legal or custom mm; portrait or landscape;
margins in mm), `source`, `styles` (font size, text, heading and accent colours, table style, line height), `header` and
`footer` (blocks, a left/center/right line, the letterhead on the first page / every page / none, "Page X of Y"), `body`
(blocks), `fileName` and `metadata` (title, subject, keywords; formulas allowed).

Sources: `record` (a table and related lists: child table, the lookup column pointing at the record, optional delegable
filter, sort, top), `query` (a table, a delegable filter formula, sort, top), `formula` (returns a table or a record),
`none`. Block kinds: heading, rich text, key-value grid, table, repeated section, approval history, image, chart,
barcode/QR, columns, signature lines, spacer, line, page break. Every block has `visible` (a formula), `keepTogether`,
`spaceBefore`, `spaceAfter`. Text properties take `{formula}` parts; rich text adds `**bold**`, `*italic*`,
`__underline__`, `[color=#rrggbb]...[/color]`, `- ` bullets and `1. ` numbers (values of formulas are never parsed as
markup). The designer edits this JSON; the server validates it with the same `docProblems`.

## The engine

**Binding** (`bind.ts`, async) reads the source as the generating identity through Query v2 (pages of 500 rows, at most
`maxRows`), fills hidden columns with blank, expands lookups to the target's primary column (read with the same identity;
a lookup table it cannot read leaves the ids), and evaluates formulas. Plain field paths (`Qty`, `ThisItem.Qty`) are read
directly (tables of thousands of rows); other formulas are analysed once per text: pure ones are evaluated by the engine,
ones that read tables go through the flows' evaluator (delegated reads as the identity, with limits). Print functions:
FormatNumber, FormatCurrency, FormatPercent, FormatDate, and Now/Today fixed to the generation time. Formula errors print
blank and add a warning; a missing record (or one the identity cannot read) is a 404; a malformed source filter is an error.

**Layout** (`layout.ts`, pure and synchronous): blocks become boxes. A paragraph is one box per line (greedy line
breaking at spaces; a word longer than a line is cut between grapheme clusters, so a conjunct with its matras stays
together); a table is a header box and one box per row (cells wrap; group header, subtotal and total rows); a key-value
grid one box per row of entries; images one box per row of images; columns one box (stacked when taller than a page).
Pagination places boxes on pages:

- a box that does not fit goes to the next page; one taller than a page is sliced over pages with a clip;
- widows and orphans: at least 2 lines of a paragraph on each side of a break;
- headings, table headers and group headers stay with what follows (`keepWithNext`); a subtotal or total row takes the
  row before it along (`keepWithPrev`);
- a table's header is repeated at the top of each page it continues on;
- `keepTogether` moves a block to the next page when it fits on one page; a page break block starts a new page;
- space at the top of a page is dropped (a spacer block is not: it is content).

Header and footer are laid out per page after the body (page numbers are placeholders ``/`` replaced per
page), their heights measured once per page kind (the first page may carry the letterhead). The output is pages of
operations: text (x, baseline, face, size, colour), rect, line, path (SVG path data), image, clip.

**Writing** (`pdf.ts`): pdfkit with `autoFirstPage: false`; the six faces are registered from the bundled files and
embedded as subset CIDFontType2 fonts with ToUnicode maps; text is placed at its baseline (`baseline: 'alphabetic'`);
Devanagari lines are wrapped in a marked-content span with ActualText (the glyphs are in visual order, the span gives copy,
search and extraction the logical text: verified with poppler's pdftotext). Pages are drawn as the stream is read.
Document information: Title, Author (the identity), Subject, Keywords, Creator, Producer, CreationDate. **Deterministic:**
with a fixed time (`services.print.setFixedTime`, tests) the bytes are identical run after run (the file ID is derived
from the information dictionary).

**Performance** (sandbox, one process): 2,200 table rows -> 63 pages, 180 KB in about 1.2 s (unit test, layout and
writing); 2,515 rows -> 91 pages, 260 KB in 0.8 to 1.7 s over HTTP with the heap growing by about 20 to 25 MB
(integration test). The whole document's operations are kept until the page count is known (a compact list: about
2 KB per page); pdfkit writes each page as it is drawn. Limits bound the rest (below).

## Fonts and shaping

Text is split into runs per script: Devanagari characters (U+0900-097F, A8E0-A8FF, 1CD0-1CFF, 11B00-11B5F, plus ZWJ/ZWNJ
and combining marks next to them) use Noto Sans Devanagari, everything else Noto Sans (Latin, Greek, Cyrillic, ₹ ...). A
character neither font has prints as the missing-glyph box (CJK, Arabic, emoji are not covered). Devanagari has no italic
face: italic is a slant applied when drawing; bold uses Noto Sans Devanagari Bold.

**Shaping is fontkit's** (its Indic shaper with the font's GSUB/GPOS). Verified: `print.test.ts` "Devanagari shaping"
compares fontkit's glyph ids and positions with HarfBuzz 15.0.0 (via uharfbuzz) for 35 strings with conjuncts (क्ष, ज्ञ,
त्र, द्ध, ह्म, स्त्र), reph (र्क, कर्म, पूर्ण), pre-base matras (ि), nukta (ड़, फ़), anusvara and candrabindu, below-base
forms (ट्रक, कृपया), in Regular and Bold: **identical for all 35 in both faces**. The rendered pages (poppler) were
checked by eye. Limits: no shaping of other Indic scripts (no fonts bundled), no bidirectional text.

## Data and security

Generation runs as an identity:

| Started by | Identity |
| --- | --- |
| A person (app, API, Print button, timeline, designer preview) | That person, unless the template runs as a service account |
| A flow (`document.generate`) | The flow's run-as identity |
| A scheduled report (PDF attached) | Each recipient (or the report's service account), the same identity as the email's data |
| A template with `runAs: {serviceAccount}` | The service account; set by administrators only, audited `print.run_as_service`; each such generation audited `print.generate_as_service`; the log says "service account X for Y" |

Rows and columns the identity cannot read are absent: a record it cannot read is "not found" (404), related rows are
trimmed by row security, a hidden column prints blank and the generation log (and the API answer) gets a warning
"the column C of T is not visible to <name>; it prints blank". Images are read only when the identity may open the
attachment. The approval history block reads the Approval requests and Approval history system tables as the identity.
Drafts are previewed by makers only; everyone else generates the published version.

## Generated files

`ab_print_files`: a token (`gen_` + 24 letters and digits), the bytes in the environment's attachment store, state
(pending, ready, failed), the creator, 24-hour expiry (`print.sweep`, hourly, schedule `sched_print_sweep`). A token is
readable by its creator and by administrators (`GET /print/files/:token`). `GeneratePdf` chooses the token in the
browser and returns it at once; the server registers it as pending and fills it. **A token in a file or image column**
(insert or update through the data service, e.g. `Patch(T, r, {Report: GeneratePdf("Inspection report", r)})`) is
claimed by `setGeneratedFileClaimer` (data.ts): the server waits up to 90 s for a pending token, refuses another person's
token (422), copies the bytes into a new attachment of that row and column and writes its id. A claimed file left in an
unsaved row is removed by the attachment orphan sweep. The email action accepts `{fileToken}` attachments (the run-as
identity must be the token's creator).

## Surfaces

- **Apps**: `Print(template [, record])` opens `GET /print/templates/:id/pdf` in a new tab (inside the click, so pop-up
  blockers allow it); on phones (coarse pointer, narrow screen) it downloads instead (the browser offers to open or share
  it; the Web Share API is not used because it needs the original click and the file arrives later). `GeneratePdf`,
  `GenerateDocx` return a token (above). The **Print button** UI component (Template, Record, Text) calls Print.
- **Record timeline**: "Document" lists the published templates of the record's table; the PDF is stored in Documents
  regarding the record (`POST /print/templates/:id/documents`, optional number sequence prefix), its file becoming
  version 1.
- **Flows**: step `document.generate` (template, record, output `file` / `record` (a file column) / `documents`); the
  token is derived from the run and step, so a retry overwrites the same file. Output `{FileToken, FileName, Pages,
  Warnings, AttachmentId?, DocumentId?}`. Email attachments: `Table({fileToken: Steps.Pdf.Output.FileToken})`.
- **Scheduled reports**: `pdf: {mode: 'auto'}` (an automatic table layout of the report's rows) or `{mode: 'template',
  template}` (a template with a query, formula or no source, generated as the recipient).
- **Bulk**: `POST /print/bulk` starts the job `print.bulk` (one at a time per process): a zip with one file per record
  (names deduplicated) or one merged PDF (page numbers per record); progress in the run row; a notification when ready;
  records that fail are listed as warnings.
- **Word**: `kind: 'docx'` templates store the uploaded .docx (bytea, versioned with the template). Tags are formulas:
  values, `{#rows}...{/rows}` loops, `{#cond}...{/cond}` and `{^cond}` conditions, evaluated with the same scope (pure
  formulas only: no table reads inside Word tags). Word's curly quotes inside tags are read as straight quotes. **There
  is no conversion of .docx to PDF** (that needs an office engine; the office add-on of the master plan is P5).

## Schema (version 11, independent step)

`ab_print_templates` (draft `doc`, `published`, `version`, kind, table, run_as, docx bytea, built_in, owner, solution),
`ab_print_template_versions` (every publish), `ab_print_runs` (the generation log; kept 90 days), `ab_print_files`,
`ab_print_settings` (`settings`: letterhead, grouping, date format, currency, time zone, limits). Environment copies take
templates, versions and settings (never the log or files). Backups include them (they are environment tables).

## Solutions

Component kind `printTemplate`. The package carries the published document (the draft when never published), the Word
file (base64) and whether it ran as a service account (never which one: an imported template runs as the caller and the
plan warns). The plan lists new / changed / unchanged / removed and warns about source tables missing in the target.
Apply writes the template as published, as a new version, inside the import's transaction.

## Limits (`PRINT_LIMITS`; administrators may lower pages, rows and time in the settings)

500 pages, 20,000 rows, 60 s per document; images 10 MB each and 60 MB per document (PNG and JPEG only; others are left
out with a warning); 400 blocks, nesting 6, 2 MB per template (static images 600 KB each); bulk 2,000 records; files 24 h;
Word templates 10 MB. A document over the page limit fails with a clear message.

## Tests

`print.test.ts` (no database): formatting, the model, Devanagari against HarfBuzz, barcodes (Code 128 values; both
symbologies decoded from a rasterised PDF with zxing-cpp when `APPBUILDER_TEST_PYTHON` has it), layout (wrapping,
pagination, header repeat, row integrity, groups and totals, widows/orphans, keepTogether, page breaks, slicing, page
limit), golden text positions (`testdata/golden-layout.json`, tolerance 0.5 pt; `UPDATE_GOLDEN=1` rewrites it),
determinism and PDF structure, the 50-page budget. `print.integration.test.ts` (PostgreSQL, fake SMTP): the six
built-ins, photos, security trimming and warnings, the service identity, tokens and claims, Documents with numbers, the
flow step and the emailed PDF, scheduled report PDFs, bulk zip and merge, Word templates, drafts/versions/visibility,
solutions round trip into another environment, locked environments, the large report. PNG renders for review:
`APPBUILDER_PRINT_RENDERS=docs/images/print`. Exit check: `scripts/exit-check/p2-pdf.mjs`.

## Not done / limitations

- No arbitrary HTML or CSS; no custom fonts (only the bundled Noto fonts); no other scripts than Latin/Greek/Cyrillic
  and Devanagari; no right-to-left text.
- No PDF/A, no digital signatures, no form fields, no tagged-PDF structure tree (only ActualText spans).
- The designer's canvas is an approximation (page breaks estimated); the server PDF is the real preview.
- Charts are a small own renderer (bar, line, pie, gauge) drawn straight as PDF vectors. Package C's `renderChartSvg`
  (`src/charts/svg.ts`, 15 kinds, the dashboards' look) returns SVG; using it needs an SVG-to-PDF step (groups, transforms,
  text anchors) that was not built in this package: duplication to remove later (charts in PDFs then match dashboards).
- Word templates: no images, HTML, charts or table-building (docxtemplater paid modules), no PDF conversion.
