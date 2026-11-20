# Templates catalogue (P2 package D, P3 package M1)

Master plan 11.3 (the spec: kinds, and the eight rules that keep installs from breaking anything), Phase 2 exit check 5.
Maker view: [guide/maker/templates.md](../guide/maker/templates.md). **Solution templates** (kind `solution`, package
format 2, P3 package M1): the authoring guide is [solution-templates.md](solution-templates.md); this page keeps the
shared mechanics and the format 1 kinds.

| Module | What it does |
| --- | --- |
| `src/templates/format.ts` | The package format (types, `validateTemplate`, canonical JSON for the digest), HTTP shapes, words for "contains" / "needs" |
| `src/templates/rewrite.ts` | Slot tokens in formulas, found and rewritten through the formula parser (`src/fx`) |
| `src/templates/bind.ts` | The binding step: default bindings, `resolveBindings` (report, problems in words, token map), binding the payload, the definitions of created tables, `checkTemplateFormulas` |
| `src/templates/safety.ts` | Rule 8: secrets, people and foreign payload parts stripped with warnings; run-as-system events listed for approval |
| `src/templates/insert.ts` | Use actions in the Studio: fresh ids, free names, renames followed inside the inserted part (`renameIdentifier`) |
| `src/templates/api.ts`, `UseTemplateDialog.tsx`, `TemplatesPage.tsx` | Browser: the calls, the binding step + plan screen, the Templates page (catalogue, detail, installed list, uninstall, upgrade) |
| `src/studio/StudioTemplates.tsx` | Studio entry points: Insert pane, screen tabs, `#studio-<app>?template=<id>` |
| `server/core/templates/builtin/*.json`, `builtin/index.ts`, `builtin/manifest.json` | The built-in catalogue (ships with the install) |
| `server/core/templates/catalogue.ts`, `manifest.ts` | Loading and integrity; sealing the built-ins |
| `server/core/templates/service.ts`, `routes.ts`, `ddl.ts` | Plan, install, uninstall, upgrade, Switch on these flows, Remove sample data; the routes; the register (schema versions 13 and 14) |
| `server/core/templates/packs.ts` | Format 2: binding a pack's components (component tokens, number sequence clash rule, prefixed names), its solution document parts, hashes of delivered components, reference and SAMPLE rows, privileges of its roles on mapped tables |
| `server/core/templates/sequences.ts` | The `numberSequence` solution component kind (used by `server/routes/meta/alm.ts` and `solutions.ts`) |
| `server/core/templates/testdata/` | Later versions of the Visitor log pack for upgrade tests (not built in, not shipped) |

`src/templates/{format,rewrite,bind,safety,insert}.ts` are shared with the server like `src/model`: relative `.ts`
imports, erasable TypeScript, no React, DOM or packages.

## Package format (version 1; version 2 adds the kind `solution`, see [solution-templates.md](solution-templates.md))

One JSON document:

```json
{
  "format": "appbuilder/template", "formatVersion": 1,
  "id": "builtin.request-tracker", "version": "1.0.0", "kind": "app",
  "name": "Request tracker", "description": "...", "publisher": "Appbuilder", "tags": ["requests"],
  "minPlatformVersion": "0.6.0", "modes": ["copy", "linked"],
  "slots": [{
    "id": "Requests", "label": "Requests table", "required": true, "defaultMode": "create",
    "create": { "name": "Requests", "displayName": "Requests", "primaryColumn": "Title" },
    "columns": [
      { "id": "Title", "label": "Title", "types": ["text"], "required": true, "create": { "type": "text", "required": true } },
      { "id": "Customer", "label": "Customer", "types": ["lookup"], "lookupSlot": "Customers", "required": true, "create": { "onDelete": "restrict" } }
    ],
    "events": [{ "name": "...", "kind": "validation", "condition": "Slot_Requests_Title <> \"\"", "message": "...", "field": "Slot_Requests_Title", "runAs": "caller" }]
  }],
  "payload": { "app": { "...AppDef..." }, "roles": [{ "name": "...", "tables": { "Requests": { "create": true, "read": "all", "update": "all", "delete": "own" } } }] },
  "signature": { "alg": "sha256", "digest": "<hex>" }
}
```

- **kind** `component` (payload `controls`: UI components inserted into the current screen), `screen` (payload `screen`:
  a node of type Screen), `app` (payload `app`, optional `roles`), `dataModel` (its tables are its slots, all creatable;
  payload `sample`: SAMPLE rows per slot, `_id` local ids, lookups name local ids).
- **slots**: the tables the template needs. A slot column accepts the listed `types` when mapped to an existing column
  (the first one is used when the table is created); `lookupSlot` says which slot's table a lookup must point at; `create`
  carries the settings used when the table is created (choices, default, unique, a formula column, the delete behaviour
  of a lookup). `required: false` slots and columns may be left out.
- **modes**: `copy` always; `linked` only for app, data model and solution templates (`LINKED_KINDS`).
- **formatVersion**: 1 or 2 (`TEMPLATE_FORMAT_VERSIONS`); kind `solution` needs 2; `shortName`, `prefix`, `dependencies`,
  `from` (shared slots), `lookupSystem`, `create.uniqueTogether` and the pack payload parts are format 2.
- **minPlatformVersion**: compared with the running server's version (`serverVersion()`); older servers refuse.

### Slot tokens

Formulas never name a table or column directly. They use `Slot_<slot>` for the table and `Slot_<slot>_<column>` for a
column, as a free identifier, a member name (`ThisItem.Slot_Items_Title`), a record field name (`{Slot_Items_Status: "x"}`),
or the whole of a text value / every piece of a comma list (`DataSource ="Slot_Items"`, `Fields ="Slot_Items_Title, Slot_Items_Status"`).
`rewrite.ts` parses the formula (`src/fx/parser.ts`), collects those nodes (free identifiers via `freeIdentifiers`, so a
name bound by `As` is left alone; members; record fields; string nodes) and replaces their source spans; the result must
parse again and hold no token. A token mapped to `null` (left out) becomes `Blank()` (an identifier or the whole member
access), is dropped from a comma list, and is a problem as a record field (the template writes it, so it must be mapped).
A text that mixes tokens with other words is not rewritten and is reported. The catalogue refuses a package whose
formulas name undeclared tokens or do not parse (`checkTemplateFormulas`), and `validateTemplate` refuses ambiguous tokens
(`Slot_A_B_C` from slot `A` column `B_C` and slot `A_B` column `C`). Covered in `src/templates/templates.test.ts`.

App definitions are bound everywhere a table or column can appear: control properties, `App.OnStart` and other app
properties (`App.Formulas` is parsed with a leading `=`), `dataSources`, offline tables and their filters. Event
conditions and actions, `field`, and formula columns of created tables too.

## Integrity: digest, manifest, signature

Chosen: **verified against a built-in manifest of hashes**, the manifest itself covered by the signed release.

- `signature.digest` = SHA-256 of the canonical JSON of the package without `signature` (keys sorted, no whitespace), so
  line endings and formatting of a checkout do not matter.
- `server/core/templates/builtin/manifest.json` lists `{ file, id, version, sha256 }` of every built-in package. A
  built-in package is usable only when its digest is right **and** equals the manifest's entry; otherwise the catalogue
  lists it as **damaged** and every plan refuses it.
- The manifest is a file of the release, so it is in `SHA256SUMS`, which the vendor signs with the Ed25519 release key
  (`release-process.md`). The updater checks that signature against the keys of the installed release.
- A package that is not built in (not loaded by anything yet: an online catalogue is later) is usable only with
  `signature.ed25519 = { keyId, signature }` over the digest by a key in `release-keys.json` (`checkEd25519`, tested with
  a throwaway key, an untrusted key and a forged signature).
- After editing a built-in template: `node server/core/templates/manifest.ts --write` (`--check` for CI);
  `catalogue.test.ts` fails while the digests or the manifest are stale.

What this does **not** protect against: someone who can write to the install folder can change a template and the
manifest together (as they could change the server's code); a malicious or buggy template from the vendor itself (the
binding, the safety check and the plan screen still apply); formulas inside a template are not sandboxed beyond the
platform's usual rules (they run with the rights of the person using the app, like any formula). An unsigned release
(`release-keys.json` empty, as today) gives no signature over the manifest at all: then the digests only detect accidental
damage.

**Release build.** `scripts/release/build.mjs` copies data files only when a shipped module names them with a literal
`new URL('./file', import.meta.url)`. `builtin/index.ts` does exactly that for each template and the manifest, and is
imported from `server/main.ts` (through `app.ts` -> `templates/routes.ts` -> `service.ts` -> `catalogue.ts`), so the files
are in the release without any change to `scripts/release/`. `catalogue.test.ts` checks that every file in `builtin/` is
referenced that way (with the build's own regular expression). Adding a template: add the file, a line in `index.ts`,
run the manifest tool. (Verified by reading the build script and by the test; a full `npm run release` was not run.)

## Plan and install

`POST /templates/:id/plan` (dry run) and `/install` run the same `planTemplate`:

1. the catalogue entry (damaged or too new: a problem); `checkSafety` (stripped parts become warnings);
2. a locked environment is a problem (and the install route is a design route: 403);
3. `resolveBindings` against the environment's tables: the report per slot (columns, candidates with the reason a column
   does not fit, the clash and a free name), problems for unmapped required slots and columns, clashes, invalid names;
4. the payload bound with the token map; app templates: an app-name clash is a problem (with a suggestion);
5. run-as-system events (on tables the install creates): a problem for non-administrators, `plan.systemEvents` for
   administrators (the plan screen's existing approval tick; the install needs `approveSystem: true`, audited
   `event.run_as_system`);
6. roles: administrators only (a taken name gets ` (2)`, said in a warning); never the administrator flag;
7. **Copy**: `createTable` and `putRelationship` model ops (fixed draft ids and a fixed time, so the token is stable) go
   through `planModel` (the data model designer's checks); **Linked**: a solution document with stable ids
   (`linkedIds`: hashed from the template id and the install number) goes through `readSolutionPkg` + `planSolution`;
8. the plan (`SolutionPlan`, shown by `src/portal/SolutionPlan.tsx`'s `PlanView`): new tables / app / roles / rules,
   mapped tables "unchanged", the edited app "changed" for UI components and screens, never "removed"; the backup line;
9. the token: SHA-256 over the template digest, the resolved bindings, the app name, sample, target, the model or solution
   plan token, the problems.

Install: problems -> 422 (with the plan), another token -> 409 (with the plan), approval missing -> 409
(`field: approveSystem`); the **backup** (`backup.snapshot`, when available and the install creates anything on the server;
a failed backup -> 409 `field: backup` unless `proceedWithoutBackup`); then **one unit of work** (`s.transaction`):

- Copy: `applyModel` (tables through the table route handlers, relationships; its own transaction is a savepoint, its own
  backup is skipped because the install took one), table events via `kernel.putEvent`, the app (fresh node ids) via
  `meta.apps.upsert`, roles (none on other tables, the template's on its slots), SAMPLE rows (`importRowsSystem`, fresh
  row ids, lookups mapped), the register row, the audit entry `template.install`;
- Linked: `applySolution` (install of the solution), SAMPLE rows, the register row with the delivered hashes and ids, the
  audit entry.

UI component and screen templates come back bound (`controls` / `screen` + `dataSources`); the Studio inserts them as one
undo step (`insert.ts`), after waiting (up to 8 s) for the new tables to reach the page through the live metadata refresh.

Inside the unit of work the services are wrapped (`inUnit`): `security.invalidate` is deferred to the outer transaction's
end, and nested transactions are plain savepoints. Reason: the live hub re-checks subscriptions on a timer armed by
`security.invalidate()`; armed inside a unit of work, that timer inherits the transaction's async context and fires on an
ended transaction, which made the hub drop the browser's environment subscription (seen in the exit check: no metadata
refresh after a data model install). The same pattern exists wherever `security.invalidate()` runs inside
`s.transaction` (data model apply, solution import); it should be fixed in `server/core/live/hub.ts` (arm the timer outside
the async context). Not changed here.

## Nothing that exists is overwritten (rule 1)

- created tables never take a taken name (case-insensitive, system tables included): the binding refuses the clash until
  it is resolved by mapping or another name; the same for the app name; role names get ` (2)`;
- mapped tables are only referenced (their definition, columns and rows are not touched; SAMPLE rows never go into them);
- existing roles get the default privilege rows for the **new** tables only (the same `grantDefaults` as creating a table
  by hand); nothing they had changes;
- UI components and screens: the app being edited gets new nodes appended; existing nodes, screens and app properties
  are not changed (`insert.ts`, tested);
- proven by snapshot comparisons (apps, tables with their definitions, physical columns and rows, roles, privileges, user
  roles, flows and versions, relationships, table events, solutions, connections; byte-equal `jsonb::text`) in
  `templates.integration.test.ts` and in the browser check `scripts/exit-check/p2-templates.mjs`.

## Uninstall (app and data model templates)

`POST /templates/installed/:iid/uninstall/plan { deleteTables }` lists: apps, roles, flows the install created (removed),
its tables (removed when empty; with data kept unless `deleteTables`; always kept when a table it did not create points at
it, a reporting view or summary reads it, or an app it did not create uses it), the Linked solution record. Roles need an
administrator; deleting tables with data needs an administrator and `confirmText` equal to the install's name (typed).
`/uninstall { confirm: token, deleteTables, confirmText }`: backup, then one unit of work (apps + `forgetApp`, flows via
`applyFlows`, roles, table drops through `applyModel` `dropTable` ops, the solution record, the register row set to
`uninstalled`, audit `template.uninstall`). Mapped tables are never touched.

## Linked upgrade

Solution templates extend this to every component kind (roles, flows, approval policies, dashboards, print templates,
number sequences, reference rows), never drop a column or a table, and keep data rows unchanged: the table in
[solution-templates.md](solution-templates.md) "Install, upgrade, uninstall". The P2 kinds behave as below.

`POST /templates/installed/:iid/upgrade/plan { choices }`: the newest catalogue version, bound with the install's stored
bindings and its stable ids; **local changes**: every created app and table whose current hash differs from the one
delivered (`delivered`) is listed; `keep` (default) puts the current definition into the package (so the plan leaves it),
`replace` takes the new version's. Then `planSolution` -> the solution upgrade-in-place plan (administrators only, backup
by `applySolution`). `/upgrade { confirm, choices }` applies it in one unit of work and records the new version and the
delivered hashes (a component kept local keeps its old delivered hash, so it is listed again next time).

## Routes

Makers. Install, uninstall and upgrade are design routes (`DESIGN_ROUTES` in `server/core/router.ts`: 403 in a locked
environment; clients reload their metadata after them).

| Route | |
| --- | --- |
| `GET /templates` | the catalogue (newest version of each id): kind, name, integrity, contains, needs |
| `GET /templates/installed` | the register (`upgradeTo` when a newer Linked version exists, `canUninstall`) |
| `GET /templates/:id` | detail: slots, default bindings, roles, SAMPLE row count, digest |
| `POST /templates/:id/plan` | `{ mode, bindings, appName, sample, target }` -> `{ plan, slots, bindings, appName, stripped, systemItems }` |
| `POST /templates/:id/install` | the same plus `confirm`, `approveSystem`, `proceedWithoutBackup` -> `{ install, controls?, screen?, dataSources, appId?, backup, warnings }` |
| `POST /templates/installed/:iid/uninstall/plan`, `/uninstall` | see above |
| `POST /templates/installed/:iid/upgrade/plan`, `/upgrade` | see above |
| `POST /templates/installed/:iid/flows` | format 2: `{ enable: [flow ids] }` "Switch on these flows" (administrators; only the install's flows; audit `template.flows.enable` and `flow.enable`) |
| `POST /templates/installed/:iid/sample/remove` | format 2: "Remove sample data" (design route): `{ install, removed, kept: [{ table, id, reason }] }` |

## The register

`ab_template_installs` (schema version 13, [schema.md](schema.md); version 14 adds `sample_rows`, `reference_rows`,
`depends_on`). Not copied by environment copies; never in solutions.

## Tests

- `src/templates/templates.test.ts`: format checks, the rewrite (identifiers, members, record fields, text lists, `As`,
  look-alike names, Blank()), binding (mismatch words, clashes, lookups, a whole app), safety, insert (no existing node
  changes, renames followed).
- `server/core/templates/catalogue.test.ts`: every built-in valid and sealed, manifest up to date, release build pattern,
  tampering, Ed25519.
- `server/core/templates/templates.integration.test.ts` (PostgreSQL): the four kinds, mapping with other column names, a
  mismatch, blocked installs, clashes both ways, a maker's copy, rule 8, a damaged template, a locked environment, Linked
  install / local change / upgrade, uninstall with the typed confirmation, the audit log, the before/after snapshot, the
  12 -> 13 step.
- `scripts/exit-check/p2-templates.mjs` (headless Chrome, server mode): the exit check, clicking through each kind.
- Format 2: `src/templates/packs.test.ts` (validation, tokens, bindJson, shared tables, rule 8 for packs),
  `server/core/templates/packs.integration.test.ts` (the Visitor log end to end: dependency, every component, a restricted
  role, upgrades with keep and replace, Remove sample data, uninstall, Copy, the byte-equal snapshot, 13 -> 14),
  `builtin-packs.integration.test.ts` (the pack test, every built-in pack), `scripts/exit-check/p3-templates.mjs` (the
  browser check of Linked install, upgrade and uninstall).

## Not done

- Flow, dashboard, role set, theme and document template kinds on their own (master plan 11.3 table): they travel inside
  solution templates.
- Linked for UI components and screens: dropped (p3-spec default 31: they become part of the app; Copy only).
- An online catalogue, importing a template file, and authoring templates from your own apps.
- Environment copies do not copy the register (p3-spec 5.11 decided: a copy with data should copy it, a schema-only copy
  not; this needs `ab_template_installs` in the data-copy list of `server/core/environment-ops.ts`, which is not this
  package's file).
- Scheduled reports in packs (no solution hook for them yet), Word print templates in packs.
- Binding a dependency's slots in the dialog (a dependency is installed with its default bindings).
