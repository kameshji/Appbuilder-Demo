# Authoring solution templates (P3 package M1)

A **solution template** (a *pack*) is a template of kind `solution`, package format version 2: tables with their
relationships, validation rules and formula columns, apps for desktop and phone, flows, approval policies, dashboards,
print templates, roles with row rules, number sequences, reference rows and optional SAMPLE rows, and dependencies on
other packs (the common business model). It installs as a **Linked, versioned solution** through the plan screen, in one
transaction, with a pre-install backup; it upgrades in place with local changes listed and kept (or replaced) by choice;
it uninstalls without touching anything it did not create.

This page is the contract for authors of packs (manufacturing, CRM, ERP-lite). It is precise enough to write a pack
without reading the code. Background: [templates.md](templates.md) (format 1, the binding step, integrity), master plan
11.3 (the eight rules), [p3-spec.md](../plan/p3-spec.md) 5.11 to 5.13. The worked example is
`server/core/templates/builtin/visitor-log.json` (every component kind, kept deliberately small); the common business
model is `builtin/business-model.json`.

## 1. Files and how a pack ships

| File | What |
| --- | --- |
| `server/core/templates/builtin/<name>.json` | the pack, one JSON document (pretty-printed; the manifest tool rewrites it) |
| `server/core/templates/builtin/index.ts` | one line per built-in file: `{ file: '<name>.json', url: new URL('./<name>.json', import.meta.url) }` (the literal `new URL` is what the release build copies; anything else is not shipped) |
| `server/core/templates/builtin/manifest.json` | the digest of every built-in file; generated, never edited by hand |
| `server/core/templates/testdata/*.ts` | later versions of a pack for upgrade tests (not built in, not shipped; registered by tests with `registerTestTemplates`) |
| `scripts/exit-check/p3-<pack>.mjs` | the pack's browser exit check (copy `p3-templates.mjs`) |
| `docs/guide/maker/<pack>.md` | the maker page, with the **who sees what** table of its roles |

After every edit of a built-in file: `node server/core/templates/manifest.ts --write` (seals the file: `signature.digest`
and the manifest). `node server/core/templates/manifest.ts --check` is what CI runs; `catalogue.test.ts` fails while a
digest or the manifest is stale. A built-in file whose digest does not match is listed as **damaged** and cannot be used.

## 2. The header

```json
{
  "format": "appbuilder/template", "formatVersion": 2,
  "id": "builtin.manufacturing", "version": "1.0.0", "kind": "solution",
  "name": "Manufacturing", "shortName": "Manufacturing", "prefix": "Mfg",
  "description": "...", "publisher": "Appbuilder", "tags": ["oee", "quality"],
  "minPlatformVersion": "0.7.0", "modes": ["copy", "linked"],
  "dependencies": [{ "id": "builtin.business-model", "minVersion": "1.0.0" }],
  "slots": [ ... ],
  "payload": { "apps": [], "flows": [], "approvalPolicies": [], "dashboards": [], "printTemplates": [], "roles": [], "sequences": [], "reference": {}, "sample": {} }
}
```

- `id`: lowercase, dots and hyphens, **never changes** (the install's stable ids are hashed from it).
- `version`: semantic version. Raise it for every change that ships (section 9).
- `shortName` (required, at most 40): put before the names of the pack's flows, approval policies, dashboards and print
  templates in this environment ("Manufacturing: Daily OEE"), so they are recognisable and do not clash.
- `prefix` (required, a capitalised word of at most 8 letters and digits): proposed for a table name that is taken
  (`Mfg` + `ProductionLog` = `MfgProductionLog`). Shared tables of the business model use `Cbm`.
- `minPlatformVersion`: the oldest Appbuilder that runs the pack (`0.7.0` until a pack needs something newer).
- `modes`: always `["copy", "linked"]`. Linked is the default in the UI; Copy gives an unlinked copy (no solution record,
  no upgrades).
- `dependencies`: other packs, by id and minimum version. Missing ones are installed first in the same transaction
  (each its own install, Linked); an installed one that is too old is a plan problem ("upgrade it first"). Three levels
  at most. A pack another installed pack depends on cannot be uninstalled.

Validation of all this: `validateTemplate` in `src/templates/format.ts` (the catalogue refuses a pack with any problem).

## 3. Tables: slots

Every table is a **slot** (format 1, [templates.md](templates.md) "Package format"), with these format 2 additions:

```json
{ "id": "Visits", "label": "Visits", "required": true, "defaultMode": "create",
  "create": { "name": "Visits", "displayName": "Visits", "primaryColumn": "PassNumber", "description": "...", "uniqueTogether": [["Line", "Shift"]] },
  "columns": [
    { "id": "PassNumber", "label": "Pass number", "types": ["text"], "required": false, "create": { "type": "text", "unique": true, "default": "=NextNumber(\"Slot_Seq_Passes\")" } },
    { "id": "Visitor", "label": "Visitor", "types": ["lookup"], "required": true, "lookupSlot": "Visitors", "create": { "type": "lookup", "required": true, "onDelete": "restrict" } },
    { "id": "Host", "label": "Host", "types": ["lookup"], "required": false, "lookupSystem": "Users", "create": { "type": "lookup" } },
    { "id": "Minutes", "label": "Minutes on site", "types": ["number"], "required": false, "create": { "type": "number", "computed": { "kind": "formula", "formula": "DateDiff(Slot_Visits_Arrival, Slot_Visits_Departure, \"Minutes\")" } } }
  ],
  "events": [{ "name": "...", "kind": "validation", "timing": "before", "operations": ["create", "update"], "condition": "...", "message": "...", "field": "Slot_Visits_Departure", "runAs": "caller", "enabled": true }] }
```

- **Ids**: slot ids and column ids are identifiers; a column id is the column's name when the pack creates the table.
  They are **stable across versions** (renaming one is dropping a table or column and adding another). Slot ids `App`,
  `Role`, `Flow`, `Policy`, `Dashboard`, `Print`, `Seq` are reserved. Column ids may not be the name of a system
  column in any case (`id`, `createdOn`, `modifiedOn`, `createdBy`, `owner`: `SYSTEM_COLUMN_NAMES` of
  `src/model/names.ts`; `validateTemplate` refuses `Owner` with a plain message): call it `ReportedBy`, `MachineOwner` ...
- **Names are plain words** (`ProductionLog`, `Opportunities`, default 20). A taken name is a **clash**: the binding step
  shows it with two ways out, use the existing table or install under the proposed prefixed name; the install is
  blocked until the maker chooses. Nothing is ever renamed or overwritten silently.
- `defaultMode: "map"` (shared tables such as the business model's Accounts): the same-named table is used when its
  required columns fit; otherwise the table is created under the prefixed name, without asking. Use it only for tables
  that are meant to be shared.
- `lookupSlot`: a lookup to another slot of the pack (a relationship is created with `onDelete`: `restrict`, `cascade`,
  `setBlank`). `lookupSystem` (format 2): a lookup to a table of the core data model (`Users`, `Teams`, `Departments`,
  `Currencies`, `UnitsOfMeasure`, `Countries`, `States` ...), by its name; no relationship row is needed.
- **Shared slots** (`from`): the table of a slot of a pack this one depends on. It has no `create`; its column ids are
  the dependency's column ids (the binding follows the dependency's own mapping). The maker does not bind it: the plan
  shows "shared with <pack>".
  ```json
  { "id": "Companies", "label": "Companies (Accounts)", "required": true, "from": { "template": "builtin.business-model", "slot": "Accounts" },
    "columns": [{ "id": "Name", "label": "Name", "types": ["text"], "required": true }] }
  ```
- A pack never adds a column to a table it maps, and never changes one (rule 1). If it needs a column on a shared table,
  the dependency must have it (raise the dependency's version).
- Column defaults that start with `=` are formulas and are bound like any formula (number sequences: section 6).
- Formula columns (`computed.kind: formula`) and rollups (`computed.kind: rollup`, its `table`, `via`, `column` as
  tokens) are recomputed by the platform's jobs.

## 4. Tokens: how a pack names tables, columns and its own components

Nothing in a pack names a table, a column or a component directly; everything goes through **tokens**, rewritten when
the pack is bound (through the formula parser for formulas, never by text replacement):

| Token | Becomes |
| --- | --- |
| `Slot_<slot>` | the table's name here |
| `Slot_<slot>_<column>` | the column's name here |
| `Slot_App_<key>` | the id of the pack's app |
| `Slot_Role_<key>` | the id of the pack's role |
| `Slot_Flow_<key>` | the id of the pack's flow |
| `Slot_Policy_<key>` | the id of the pack's approval policy |
| `Slot_Dashboard_<key>` | the id of the pack's dashboard |
| `Slot_Print_<key>` | the id of the pack's print template |
| `Slot_Seq_<key>` | the **name** of the pack's number sequence here (it may be prefixed, section 6) |

Where a token may stand:

- **in formulas** (UI component properties, app formulas, event conditions and actions, formula columns, flow
  expressions, print formulas): as an identifier, a member (`ThisItem.Slot_Visits_Status`), a record field
  (`{Slot_Visits_Status: "Done"}`), the whole of a text value (`DataSource ="Slot_Visits"`, `NextNumber("Slot_Seq_Passes")`)
  or every piece of a comma list (`Fields ="Slot_Visits_A, Slot_Visits_B"`); a piece may carry a header after a colon,
  as the DataTable's `Columns` allow (`Columns ="Slot_Visits_PassNumber:Pass number, Slot_Visits_Arrival:Arrived"`: the
  token is rewritten, the header kept; a header may not hold a token; a left-out column drops its piece). Give the main
  lists of a pack headers, or they show the spaced-out column names;
- **in the JSON of flows, approval policies, dashboards, print documents and row rules**: as the whole of a string
  (`"table": "Slot_Visits"`), a comma list of tokens, `<word>:<token>` (`"role:Slot_Role_Reception"`), an object key
  (`"values": { "Slot_Visits_Approval": "..." }`), inside `{...}` of print text (`"Pass {Slot_Visits_PassNumber}"`), or a
  formula string (with or without the leading `=`).

A text that mixes a token with other words outside a formula or `{...}` is not rewritten and refuses the pack. Tokens
must be declared (the catalogue refuses undeclared ones, and formulas with tokens that do not parse:
`checkTemplateFormulas`). Ambiguous tokens are refused (`Slot_A_B_C` from slot `A` column `B_C` and slot `A_B` column `C`).

## 5. Components (payload)

Every component has a `key` (letters and digits, starting with a letter; **stable across versions**: the install's id of
the component is hashed from it) and a `name` (at most 100).

**Apps** (`payload.apps`): `{ key, name, description?, phone?, app }`, `app` an app definition (format 2 of
`src/contracts.ts`): screens, `dataSources` (tokens), `appProps`. A phone app is portrait (`width: 390, height: 844` or
another phone preset), `phone: true`, and usually `offline: { entry: true, tables: [{ table: "Slot_..." , filter? }] }`
(works offline (entry); the listed tables kept on the device). Use only UI components and properties of the registry
(docs/reference); the pack test runs the apps' formulas through the parser, not through the screens. Every role of the
pack may use every app of the pack.

**Flows** (`payload.flows`): `{ key, name, description?, definition, runRoles? }`. `definition` is a flow definition
([flows.md](flows.md)): `trigger`, `steps`, `variables?`, `settings`. Rules:
- flows **arrive turned off**; after the install an administrator is offered **Switch on these flows** (rule 8). They run
  as their owner, the administrator who installed the pack. What that means and what stops it from mattering
  ([flows.md](flows.md) "Identity and security"):
  - an **approval** step is on behalf of the person whose change started the run: they are never asked (nor the
    installer), and the fallback is their manager. Add `"requester": "Trigger.Record.owner"` (or another person the flow
    reads) when the request is about someone else too (the NCR's inspector when the quality head sends it);
  - a `data.create` gives the row to the installer unless it says `"owner": "Trigger.User"` (the person whose change
    started the run): use it whenever an own-rows role should see what a flow raised for them;
  - **notify a role** with `"roles": ["Slot_Role_<key>"]` (no formula over `RoleAssignments`; a role nobody holds yet is
    not an error);
- never `runAs` a service account and never connection references (the safety check strips both, with a warning): use
  steps that need no connection (data, approval, notify, email through the platform's mail, document.generate);
- name tables, columns, the policy (`"policy": "Slot_Policy_<key>"`), the print template (`"template": "Slot_Print_<key>"`)
  and the number sequence (`"numberSequence": "Slot_Seq_<key>"`) by token;
- `runRoles`: role tokens that may run a manual flow;
- an upgrade that changes a flow keeps it on if it was on, and off if it was off.

```json
{ "key": "ApproveVisits", "name": "Approve visits",
  "definition": {
    "trigger": { "type": "table", "table": "Slot_Visits", "on": ["create"], "condition": "Trigger.Record.Slot_Visits_Approval = \"Pending\"" },
    "steps": [
      { "id": "ask", "name": "Ask", "kind": "approval", "title": "\"Visitor pass \" & Trigger.Record.Slot_Visits_PassNumber", "policy": "Slot_Policy_VisitApproval", "regarding": { "table": "Slot_Visits", "rowId": "Trigger.Record" } },
      { "id": "set", "name": "SetApproval", "kind": "data.update", "table": "Slot_Visits", "rowId": "Trigger.Record", "values": { "Slot_Visits_Approval": "If(Steps.Ask.Output.Outcome = \"Approve\", \"Approved\", \"Rejected\")" } }
    ],
    "settings": { "concurrency": "perRecord", "timeoutMinutes": 10080, "retentionDays": 30, "onError": "fail" } },
  "runRoles": ["Slot_Role_Reception"] }
```

**Approval policies** (`payload.approvalPolicies`): `{ key, name, description?, definition }`, an approval definition
([approvals.md](approvals.md)). Approvers are `role:Slot_Role_<key>`, `team:`, `department:`, `manager`, `manager-chain:<n>`
... **never named people** (`user:` and emails are stripped: packs carry no users).

**Dashboards** (`payload.dashboards`): `{ key, name, def, roles? }`, `def` a dashboard definition
([dashboards.md](dashboards.md)): `version: 1`, `title` (replaced by the prefixed name), `range` (`all` shows SAMPLE rows
whatever their dates), `tiles` with `query.table`, `groupBy`, `measures[].col`, `dateColumn.col`, `visual.category` as
tokens. `roles`: viewer role tokens.

**Print templates** (`payload.printTemplates`): `{ key, name, description?, doc }`, a print document
([pdf.md](pdf.md)): `source: { kind: "record", table: "Slot_..." }` (or `query`), blocks whose formula properties
(`value`, `rows`, `visible`, `items`) are formulas and whose texts carry `{formula}` parts, all with tokens. Imported as
published, running as the person who prints. Only PDF documents in packs (a Word template needs its file in the pack:
not supported yet).

**Roles** (`payload.roles`): `{ key, name, description?, isMaker?, tables }`, `tables` keyed by slot id:
`{ create, read, update, delete, share? }` with the scopes `none`, `own`, `team`, `manager`, `managerTree`, `department`,
`departmentTree`, `all`; `columns` (slot column id -> `none` / `read` / `update`: column security); `rowFilter`
(relationship row rules, tokens allowed). Never the administrator flag. A taken name gets ` (2)`. The pack's roles get
privileges on the tables it maps too (shared and your own tables): that is a new role, so nothing existing changes.
**Assigning people stays a manual step** (rule 8). Document every role in the maker page's **who sees what** table and
prove one restricted role end to end in the exit script (spec 5.13).

**Number sequences** (`payload.sequences`): see section 6.

## 6. Number sequences

`{ key, name, prefix?, suffix?, padding? (1-12, default 4), resetRule? (never | yearly | financialYear), description? }`.
Never `nextValue` (refused). Use them through a column default or a before-event: `=NextNumber("Slot_Seq_Passes")`. At
install (default 23):

- the name is free: the sequence is created (next value 1);
- a sequence of the same name **and the same format** exists: it is reused (not created, never removed);
- a sequence of the same name with another format exists: the pack's is created as `<shortName> <name>` and the token
  becomes that name (the plan says so).

It is a solution component (kind `numberSequence`). An upgrade may change the format; **it never changes the next
value**. A sequence a newer version no longer has is kept. Uninstall removes it only when it was never used.

## 7. Reference and SAMPLE rows

**Reference rows** (`payload.reference`, slot -> rows): rows the pack needs to work (stages, reasons, purposes). Always
loaded into tables the pack creates. Every row has an `_id` (a local id, **stable across versions**). Lookups between
rows name the `_id` of the target row. An upgrade adds new reference rows, updates the ones the customer did not change,
keeps (by default) the ones they changed, and does not bring back the ones they deleted. Use text, choice, number and
yes/no values (dates compare as text).

**SAMPLE rows** (`payload.sample`, slot -> rows): optional at install ("Add the SAMPLE rows"). The display column
(`create.primaryColumn`) of every SAMPLE row **starts with `SAMPLE`** (refused otherwise). Lookups may name `_id`s of
SAMPLE or reference rows. They go only into tables the pack creates, never into mapped or shared tables (rows for those
are left out, with a warning). Every SAMPLE row is recorded in the install register by id; **Remove sample data**
deletes exactly those rows (children first); a SAMPLE row that a row people added still points at (restrict) is kept
and reported. Write SAMPLE rows so that the dashboards and print templates show something (for example `range: all`).

## 8. Install, upgrade, uninstall (what the platform does)

**Install** (`POST /templates/:id/plan`, `/install`, design routes): administrators only for packs; refused in a locked
environment (install in a sandbox, then Deploy the template's solution); dependencies planned and installed first; one
binding step for the whole pack; the plan grouped by kind; one transaction; a pre-install backup when backups exist; the
install register row with what was created, the hashes of everything delivered, the SAMPLE and reference row ids and
the dependencies; audit `template.install`. Then **Switch on these flows** (`POST /templates/installed/:iid/flows`,
administrators, audit `template.flows.enable`).

**Upgrade** (Linked; `POST /templates/installed/:iid/upgrade/plan`, `/upgrade`): the newest catalogue version, bound with
the install's bindings and stable ids, applied as a solution upgrade in place (administrators, backup, one transaction).
Per component, the platform compares what is here with the hash of what it delivered:

| Component | Local change found by | Keep (default) | Replace |
| --- | --- | --- | --- |
| App, flow, approval policy, dashboard, print template | its definition | yours stays | the new version's |
| Role | name, flags, apps and privileges on the pack's tables | yours stays | the new version's |
| Number sequence | name and format (never the next value) | yours stays | the new format (next value kept) |
| Table | display name, columns and their settings | your settings win; new columns are still added | the new settings win |
| Reference row | its values | yours stays | the new values |

Always, whatever the choice: **data rows are never changed**; new columns are added; a column (or a table, or a
sequence) the new version no longer has is **kept** and listed as "no longer used by the template"; relationships are
never removed. A kept component keeps its old delivered hash, so it is listed again at the next upgrade. Components of
other kinds that the new version no longer has (an app, a flow) are removed by the upgrade plan, like any solution
upgrade (the plan says so). Choices are keyed `<kind>:<id>` (`app:app_tpl_…`, `referenceRow:<slot>:<_id>`).

**Uninstall** (`POST /templates/installed/:iid/uninstall/plan`, `/uninstall`): removes the pack's apps, flows (active runs
cancelled), roles, approval policies, dashboards (with their tokens and snapshots), print templates, unused number
sequences and the solution record; tables it created are removed when empty, kept with data unless an administrator
ticks "Delete tables with data" and types the install's name; an empty table of the pack that a kept table of the pack
looks up (a reporting view or summary of it too) is **kept as well**, and the plan says which table looks it up (after
"Remove sample data" the masters are often empty while the entries are kept); tables it mapped or shares are never
touched; refused while another installed pack depends on it. Backup first; audit `template.uninstall`.

**Remove sample data** (`POST /templates/installed/:iid/sample/remove`, design route): section 7; audit
`template.sample.remove`.

**Copy**: the same install without the solution record (the components are not part of a solution); no upgrades;
uninstall works the same way.

## 9. Versions and how to ship a change

- Raise `version` for every change that reaches customers: patch for wording and SAMPLE rows, minor for new components,
  columns, reference rows or tiles, major when the pack drops things (they stay at customers' installs, listed).
- **Never** change: the pack `id`, slot ids, column ids, component `key`s, reference row `_id`s. Renaming one of them is
  dropping the old thing (kept at the customer, "no longer used") and adding a new one.
- Raising a dependency's `minVersion` is fine; installs with an older dependency get a plan problem ("upgrade it first").
- Old versions are not kept in `builtin/` (the catalogue offers the newest only); test upgrades from the previous version
  with a fixture in `testdata/` that reproduces it (see `testdata/visitor-log-next.ts`, which derives later versions from
  the built-in file).
- Seal: `node server/core/templates/manifest.ts --write`, then run the tests of section 10.

## 10. The pack test (every pack must pass it)

1. `npx vitest run src/templates server/core/templates/catalogue.test.ts`: the pack is valid, sealed, in the manifest,
   shipped by the release build, its formulas and JSON parts bind, and the safety check strips nothing from it
   (`src/templates/packs.test.ts` picks up every built-in pack by itself).
2. `npx vitest run server/core/templates/builtin-packs.integration.test.ts` (PostgreSQL): **every built-in solution
   template is picked up automatically**: the default plan has no problem; the Linked install with SAMPLE rows succeeds;
   nothing it created still holds a token; every flow arrived off and switches on (it validates against the
   environment); every print template generates a PDF for a SAMPLE row; every SAMPLE row is labelled and "Remove sample
   data" removes all of them; uninstall (dependencies last, deleting tables) leaves nothing of the pack behind.
3. The pack's own integration test for what is specific to it (formulas equal to a reference computation, the
   restricted role, its flows end to end), modelled on `packs.integration.test.ts`.
4. Its exit script `scripts/exit-check/p3-<pack>.mjs`, modelled on `p3-templates.mjs`: install by clicking (a clash
   resolved), use each part once, a local change, an upgrade from the previous version keeping one change and replacing
   another, Remove sample data, uninstall keeping tables, and a byte-equal before/after snapshot of everything that
   existed.

## 11. Things that are not obvious

- The Templates page installs a pack's **dependency with its default bindings** (the maker cannot bind a dependency's
  slots in the dialog). That is why shared tables use `defaultMode: "map"` (a misfit is created under the prefix
  instead of blocking).
- Two installs of the same pack (a Linked and a Copy, or two Copies) get different component ids and, where names are
  taken, `(2)` names; table names clash and must be resolved.
- A pack's role sees the shared table (Accounts) only as far as its privileges on that slot say; it never changes what
  other roles see there.
- The flows of a pack run as the administrator who installed it. Write them so that this is acceptable (they act on the
  pack's own tables, notify roles, never mail outside), and use `owner` and `requester` (section 5) so that the rows
  they raise and the approvals they ask for belong to the person who caused them.
- `checkSafety` strips, with a visible warning, anything a pack may not carry (secrets, people, connections, service
  accounts, unknown payload parts); a built-in pack must not trigger any of it (the pack test would show the warning).
- An environment copy **with data** copies the install register (`ab_template_installs` in `COPY_DATA_META` of
  `server/core/environment-ops.ts`, p3-spec 5.11): the copy's Templates page lists its packs and upgrades, removes the
  sample data of and uninstalls them (its flows arrive off, like every copy). A schema-only copy does not (its SAMPLE and
  reference rows are not there): there the pack's parts are ordinary components.
- Scheduled reports are not a pack component yet (no solution hook exists for them): set them up after the install.
