# Auto apps: generating an app from tables

Status: implemented (P2 package D, exit check 4). Maker guide: [Create an app from a table or the data model](../guide/maker/apps.md#create-an-app-from-a-table-or-the-data-model).

"Create app from table" turns table definitions into an ordinary `AppDef` (list / detail / edit screens for desktop or
phone) and creates it through the normal app-creation path. Nothing marks the result as generated: the Studio edits it
like any other app, and generating again makes a new app.

| File | What |
| --- | --- |
| `src/autoapp/plan.ts` | `planAutoApp(tables, options)`: what will be made (per table: title column, form fields, list and card columns, related lists, parent links, timeline, undo) and every issue. Pure |
| `src/autoapp/generate.ts` | `generateApp(tables, options)`: the `AppDef` from the plan. Pure (no React, DOM or platform; relative `.ts` imports, like `src/fx`) |
| `src/autoapp/names.ts` | quoting (`ident`, `str`), readable unique names (`Names`, `stemOf`) |
| `src/autoapp/create.ts` | browser side: `readableFor(session)`, `createAutoApp(options)` (`platform.apps.create` + `platform.apps.save`) |
| `src/autoapp/AutoAppDialog.tsx` | the dialog: name, device, tables, preview, issues |
| `src/autoapp/generate.test.ts`, `testdata.ts` | unit tests and table shapes |
| `src/portal/actions.ts` | Home's "Start with data" calls the same generator (`startWithDataOptions`) |
| `scripts/exit-check/p2-autoapp.mjs` | browser check on a real server and in demo mode |

Entry points: `TableDesigner.tsx` (one table), `Tables.tsx` and `Apps.tsx` ("From the data model": several tables),
`Apps.tsx` ("From a table"), `Home.tsx` / `dialogs.tsx` ("Start with data"). All are shown to makers only (`useCaps().isMaker`);
the dialog lists only tables the maker can read (`readableFor`: administrators and demo mode all, others the tables
with a read privilege; system tables are not offered). The server enforces everything as for any app.

## Options and layout

`AutoAppOptions`: `name`, `device` (`desktop` 1920x1080, `phone` 360x800), optional `width` / `height` (Start with data
passes the picked size), `tables` (names; the first is the main one), `readable(table)`, `newId()` (tests).

`layout` is `compact` when the width is under 700 px or the size is portrait, else `wide`.

| Screen | wide | compact |
| --- | --- | --- |
| `Home` (2+ tables) | header, a tile per table (Button, `Navigate`), `CountRows(T)` under it | the same, one column |
| `<T>List` | header (Home, title, + New), `DataTable` stretched both ways | header, `DataTable` full width (cards on touch) |
| `<T>Detail` | header (Back, title, Open parent x2, Delete), `Form` (2 or 3 columns) stretched, right panel (anchored End): `Tabs` with Activity (`RecordTimeline`) and one `DataTable` per related list | header (Back, title, Delete), `Form` (1 column; 2 from 600 px), a "Related: ..." button anchored to the bottom |
| `<T>Related` | - | header, `Tabs`, timeline and related lists |
| delete confirmation | `Dialog` (a bottom sheet on touch phones) with Cancel / Delete | same |

Anchors: header bars, titles, lists and forms stretch horizontally; right-hand buttons and the side panel use `End`;
lists, forms and the timeline stretch vertically. So a desktop app fills any window and a phone app follows the fluid
rule (`docs/dev/phone.md`): nothing is wider than the design, and wider phones widen the parts.

## What each column type becomes

| Type | Form field (Form UI component) | List | Phone card |
| --- | --- | --- | --- |
| text, email, phone, url | input (validated) | yes | subtitle if no choice column |
| autonumber | read-only, after required fields; left out in New | yes | - |
| choice | select | yes | subtitle |
| lookup | searchable picker over the server (the target is added as a data source) | yes, by label when the target is readable; sortable by that label on the server (P3-C) when both tables are in the default database | subtitle when required |
| number, decimal, currency | numeric input | yes | a line (numbers and dates first) |
| date, datetime | date picker (native on touch) | yes | a line |
| boolean | switch | yes | - |
| multiline | text area (full width) | no | no |
| image | attachment field; **Take photo** on touch | last | no |
| file | attachment field | no | no |
| calculated (`computed`) | read-only | if short | - |
| system (id, createdOn, modifiedOn, createdBy, owner) | left out | no | no |

Order of form fields: the title column, required columns, then by kind (short text, autonumber, choice, lookup, numbers,
dates, yes/no, long text, images, files, calculated), table order within a kind. The title column is the primary column
when it can be shown as text, else the first text column.

## Formulas it writes (all delegable)

| Where | Formula |
| --- | --- |
| list Items | `Sort(T, createdOn, SortOrder.Descending)` (or `T` without createdOn); the DataTable's search box and header sort re-plan it on the server (`ListView` in `src/runtime/delegation.ts`) |
| related list Items | `Filter(Child, ThisRecord.Lookup = Coalesce(varT.id, "-"))` ("-" never matches an id, so nothing shows while no record is open; a blank would match rows with an empty lookup) |
| home tile | `Text(CountRows(T)) & " records"` (a count plan) |
| row opens | `Set(varT, TTable.Selected); EditForm(TForm); Navigate(TDetail)` (ViewForm for read-only tables) |
| + New | `Set(varT, Blank()); NewForm(TForm); Navigate(TDetail)` |
| + Add (child) | `Set(varChild, {Lookup: varT.id}); NewForm(ChildForm); Navigate(ChildDetail)` (New-mode starting values of the Form) |
| Open parent | `Set(varP, LookUp(P, id = varT.Lookup)); EditForm(PForm); Navigate(PDetail)` |
| Delete | `Set(varDeleteT, true)` opens the Dialog; its Delete: `Remove(T, varT); Set(varDeleteT, false); Back()` |
| App.OnStart | `Set(varT, Blank()); Set(varDeleteT, false); ...` (the Studio runs OnStart, so the variable names are known while editing) |

Names in formulas go through `ident()`: a table or column named like a word of the language (`In`, `And`, `true`, `As`)
is quoted (`'In'`, `ThisRecord.'As'`). UI component, screen and variable names are made from the table's formula name
(at most 24 characters) plus a role (`CustomersList`, `CustomersForm`, `varCustomers`), unique ignoring case, never equal
to a table name, an enum or a reserved name (`Names`). Undo after a delete is the runtime's existing toast for tables
that keep deleted rows (`src/runtime/UndoDelete.tsx`); the dialog text says whether a delete can be undone.

## Honesty: issues

`plan.issues` (`blocked`, `skipped`, `limited`, `note`), most serious first, shown in the dialog: tables not found, not
readable or named like a built-in enum (`Color`); tables without columns; unknown column types; lookups to missing or
unreadable tables; how lookups are picked, listed and sorted (by label; "cannot be sorted" only for a target or table outside the default database, or a target without a sortable name column); long text and files only in the form; calculated columns; no text column
(no search box); child tables that cannot be read; junction tables (their related list shows their own columns only);
lookups to the table itself; more than two parent links; tables in connections that cannot run queries (lists capped at
5,000 rows); read-only tables (no New, no Delete, a view form).

## Tests

- `src/autoapp/generate.test.ts`: for desktop and phone over shapes with every column type, child tables (two lookups
  from one child), a table with no text column, names needing quotes (a table named `In`, columns `And`, `true`, `As`,
  `Not`, `Self`, `Parent`), a lookup to itself, long names, 60 columns, and all of them at once: every name unique and
  readable, every property exists on its UI component (`controls.propsOf`), every name a formula reads exists, every
  formula passes `fx.check`, and every formula that reads a table translates with `analyze()` without an error (no
  table held in the browser, 1,000,000 rows; action formulas step by step, as `prepareAction` does). Layout (nothing
  wider than the design, anchors), and the app running in a runtime store without a DOM (home, list, New, Back, the
  delete confirmation, the related screen, OnStart variables).
- `scripts/exit-check/p2-autoapp.mjs`: see its header. Lookups (this package): Products has 2,500 rows; a new order
  picks Customer and Product by typing (server search), the list shows both by name and never an id, the list search
  finds orders by the customer's name, the desktop pick is done with the keyboard only, and with no connection the picker
  says "Products is not available offline". Sorting by a lookup (P3-C): the Customer and Product headers are sortable;
  sorting by Product (the 36 seeded orders point at products spread over the 2,500) orders the list by the product names
  both ways; the phone card's "Sort by Customer" orders the cards by the customer's name; and (section G) the user without
  the Maker role, who may read only the products named below "Product 0600", sorts orders by Product: the 28 orders whose
  product they cannot read (shown "Not available") or that have none come first ascending, no hidden name reaches the
  screen or the HTTP answer, and the same plan over HTTP is timed (median 15.8 ms for a page of 100 on the sandbox).
  Last run: 52 checks pass (server mode desktop and phone, the Studio, the table page, a user without the Maker role,
  demo mode). Phones are Chrome's emulation, not real devices.

## Lookups

The Form's lookup field is a searchable picker that queries the target on the server as you type, and DataTable /
Gallery / phone cards show a lookup as the target row's primary column (batched label requests): see
[frontend.md "Lookup fields and labels"](frontend.md#lookup-fields-and-labels). So the generator lists lookup columns
whose target the maker can read (`listColumnsOf(..., lookupOk)`, `relatedColumnsOf`: a related list leaves out only the
lookup back to the record), makes a required lookup the phone card's subtitle, and says in the dialog (a note) that lists
sort by the lookup's name on the server, as each viewer may read it (a record they cannot read sorts as blank), and that
the search box finds it by that name (P3-C, `lookupSortSupport` in `src/controls/lookups.ts`). When the table or the
target is stored outside the default database, or the target has no sortable name column, the note says the list cannot
be sorted by it and why; the screen summary then says "sort by any column but some lookups". Lookups to tables the maker
cannot read stay out of lists (they could only show "Not available").

## Known gaps (UI components and runtime, not changed here)

- Sorting by a lookup whose table and target live in an external PostgreSQL connection works on the server, but the
  generator's note and a non-maker's DataTable cannot tell that connection is PostgreSQL (only makers see connections),
  so they say it cannot be sorted there.
- Generated colours are fixed (no theme-aware colour tokens in formulas).
- Phone related lists are on their own screen rather than in tabs over the form, so the Form is never hidden while it
  holds unsaved edits (whether a hidden Form keeps them was not checked).
