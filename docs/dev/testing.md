# Testing

Tests run with **Vitest** (`npm test` runs `vitest run`). The configuration is in `vite.config.ts` at the repository root:
environment `node` (there is no DOM test environment, so React components are not rendered in unit tests) and these include
globs:

```
src/**/*.test.ts   server/**/*.test.ts   scripts/**/*.test.ts
```

## Layout

| Area | Files | What they cover | Needs a database |
| --- | --- | --- | --- |
| Formula engine | `src/fx/*.test.ts` (`functions`, `functions2`, `behaviour`, `behaviour2`, `tables`, `tables2`, `udf`, `syntax`, `lang2`, `signature`, `api`, `perf`, `animatedIcons`) with helpers in `src/fx/testutil.ts` | Lexing, parsing, every function, behaviour functions against a fake host, user-defined functions, rename and reference analysis, performance checks, the generated animated-icon list | no |
| Engine sharing and layering | `src/fx/engine.test.ts`, `src/fx/layering.test.ts`, `server/core/fx.test.ts` | Engine instances (own user functions and named formulas), the AST printer, src/fx imports only allowed files (relative `.ts`), the engine and translator load under plain Node | no |
| Query v2 translator | `src/fx/query/parity.test.ts`, `src/fx/query/translate.test.ts` (data in `testdata.ts`) | Engine vs plan parity on a generated corpus (~650 formulas), exact plans, diagnostics, keyset cursors and paging | no |
| Runtime | `src/runtime/{evaluator,submit,attachments}.test.ts` | Dependency tracking and invalidation, form submit flow, attachment helpers | no |
| Platform (client) | `src/platform/{platform,demo,remote}.test.ts` | Demo-mode core, the remote platform's optimistic cache, rollback and mirrored checks (against a fake `fetch`) | no |
| Server core | `server/core/unit.test.ts`, `server/core/env-context.test.ts` | Router guards, auth, security engine, DataService, values, conditions, with in-memory fakes; the environment resolver and the environment-keyed security and connection caches | no |
| Server hardening | `server/core/hardening.test.ts`, `server/routes/meta/hardening.test.ts` | Loopback-only setup routes (a real LAN socket when the machine has one), host list, setup code, CSP hashes, Secure cookie, `password_change_required` gate, CSV escaping, per-email backoff, audit diffs; table delete/column unmap on linked tables, owners of imported rows, assign-owner, audit entries | no |
| Server metadata routes | `server/routes/meta/{meta,connections,files,migrate,security,solutions,tables}.test.ts` | Apps, tables, columns, connections, roles and users, solutions, packages, legacy migration, data files. They use the in-memory `FakeMetaStore` harness `server/routes/meta/testing.ts` with the **real** `SecurityEngine`, `DataService` and `ConnectionManager` | no |
| Connectors | `server/connectors/postgres/sql.test.ts` and `server/connectors/mysql/sql.test.ts` (pure SQL builders, error mapping), `files/files.test.ts` (temp directory), `gsheets/gsheets.test.ts` (injected fake Google API) | Each connector in isolation | no |
| Integration (PostgreSQL) | `server/connectors/postgres/postgres.integration.test.ts`, `server/core/{integration,fixes,hardening,admin,transactions,environments}.integration.test.ts`, `server/routes/meta/meta.integration.test.ts` | The PostgreSQL connector against a real server including SQL-versus-reference **parity**, pooled-connection settings and transactions; the whole HTTP API end to end (cookie jars per user, RBAC/RLS/CLS, attachments); units of work (a failed import or schema change leaves nothing behind); the metadata API; environments (access by header, isolation of same-named objects, create/copy/delete, locked production, in-place solution upgrade with rollback, per-environment boot migration, the upgrade from a version 4 database, `_env_` and `_v4_` databases) | **yes**, `APPBUILDER_TEST_DB` |
| Integration (MySQL connector) | `server/connectors/mysql/mysql.integration.test.ts` | The MySQL connector (external databases) against MySQL/MariaDB including parity | **yes**, `APPBUILDER_TEST_MYSQL` |
| Generated docs | `scripts/docs/generate.test.ts` | Staleness of `docs/reference/*.md` (below), the redirect stub `controls.md` | no |
| Docs and naming guards (package M) | `scripts/docs-links.test.ts`, `scripts/naming.test.ts` | Every relative link and image in `docs/` and the top-level Markdown files exists; no "control" in user-facing text (registry labels, function signatures and summaries, the reference's hand-written parts, string literals and JSX text in `src/` and `server/`) | no |
| Phase close (package M) | `server/core/phase-close.integration.test.ts`, `server/core/alm-model.integration.test.ts`, `src/platform/delete-rules.test.ts`, `src/portal/lookupSearch.test.ts` | Sign-in and email log retention, the schedule policy, directory visibility, export environment data, grouped aggregates over collaboration tables; solution upgrade in place and environment copies carrying unique pairs, reporting views, date dimensions, summary schedules and relationship changes; demo-mode delete behaviours; the lookup type-ahead plan | partly (`APPBUILDER_TEST_DB`) |
| Security re-check (package M) | `server/core/security-p0.integration.test.ts`, `server/core/security-p0.test.ts` | Environment selection tampering, Query v2 plan and cursor tampering, hidden-column inference, collaboration spoofing, system-table writes, outbound host policy, crafted archives, zip bombs, DBML abuse, export escaping, API key reach (docs/internal/security-review-p0.md) | partly |
| Security re-check of Phase 1 (package E) | `server/core/security-p1.test.ts`, `server/core/security-p1.integration.test.ts` | IPv4 inside IPv6 and other address encodings, userinfo / IDN / trailing-dot tricks, header injection, prototype pollution, regular expressions with nested repeats, the evaluation budget, OpenAPI alias bombs and remote `$ref`; child-flow escalation, drafts, test runs, owners, run-as, resubmit, locked production for flows and policies, bulk answers with required comments, two approvers at once, delegation to the requester, trigger storms and the environment run limit, notification HTML escaping, webhook enumeration, SMTP OAuth secrets (docs/internal/security-review-p1.md) | partly (`APPBUILDER_TEST_DB`) |
| Phase 1 close (package E) | `src/approvals/definitionKit.test.ts`, `src/runtime/runflow.test.ts`, additions to `flows.integration.test.ts` (resubmit from a step), `flows-durability.integration.test.ts` (notify once), `approvals.integration.test.ts` (per-stage due dates, the visual step), `templates.test.ts` (dynamic content), `identity/smtp.test.ts` (XOAUTH2), `diagnostics/ops.integration.test.ts` (health alerts); `scripts/exit-check/p1.mjs` (the exit check, headless) | The nine gaps of the phase close | partly |
| Backups (P0 package J, handles in P2 close) | `server/core/backup/backup.test.ts` (tar and encrypted container, COPY parsing, retention, and the **file handle** tests: every refused or damaged archive leaves no handle open, an archive handed to queued work is closed when the work cannot start), `backup.integration.test.ts`, `backup.large.integration.test.ts` (opt-in: `APPBUILDER_TEST_LARGE=1`, 1,000,000 rows and 500 MB of attachments, minutes and about 2.5 GB of temp space) | Backup now with both methods, verification, encryption, tampering, restore (new, in place, selected tables), browsing | integration: **yes** |
| Phone (P2-A) | `src/phone/{phone,capture}.test.ts`, `src/phone/offline/outbox.test.ts`, `src/phone/scan/{decode1d,qr}.test.ts`, `server/core/pwa.test.ts`, `src/studio/phoneFrame.test.ts` | Signature and bottom-sheet logic, offline tables and form drafts, the outbox (idempotency keys, scripted failures, no duplicate), the 1D and QR decoders on generated images, the PWA manifest and icons, phone preview frames. The browser parts are `scripts/exit-check/p2-phone.mjs` | no |
| Print and PDF (P2-B) | `server/core/print/{print,svgops}.test.ts`, `src/print/share.test.ts`, `server/core/print/print.integration.test.ts` | Our own PDF renderer (layout, pagination, Devanagari shaping against HarfBuzz, barcodes, determinism, a 50-page budget), charts in PDFs (golden text positions), sharing a file; templates end to end (security-trimmed generation, `GeneratePdf`, flow step `document.generate`, scheduled reports with PDFs, bulk jobs, Word templates) with a fake SMTP server. Barcode decoding in the unit tests needs poppler and zxing-cpp and is skipped when they are missing | integration: **yes** |
| Dashboards and charts (P2-C) | `src/dashboards/{dashboards,editor,grid,kiosk,mtbf,screens}.test.ts`, `src/charts/charts.test.ts`, `server/core/dashboards/dashboards-wave2.test.ts`, `server/core/dashboards/{dashboards,dashboards-wave2,pins}.integration.test.ts` | Date presets, the measure builder through the reference executor, OEE and MTBF against hand computation, the tile editor's logic, the grid arithmetic, the kiosk page's token handling, drill-through; the batch endpoint under the viewer's rights, hidden columns, the cache, view tokens, snapshots, pins | integration: **yes** |
| Auto apps and templates (P2-D) | `src/autoapp/generate.test.ts`, `src/templates/templates.test.ts`, `server/core/templates/catalogue.test.ts`, `server/core/templates/templates.integration.test.ts` | Apps generated from a table or model, the template package format, binding and formula rewrite, the safety rule, the built-in catalogue (sealed, manifest, signatures, release build ships every file); the four kinds installed through plan and install, name clashes, nothing existing changed | integration: **yes** |
| WhatsApp (P2-E) | `server/core/whatsapp/whatsapp.test.ts`, `whatsapp.integration.test.ts` (fake Graph API in `mock-graph.ts`) | Phone numbers, the webhook signature, keywords, payloads, the refusal of Meta's host by the HTTP connector; opt-in, no send without it, a retried step sends once, status webhooks, STOP. Never contacts Meta | integration: **yes** |
| Phase 2 exit checks | `scripts/exit-check/p2.mjs` and the scripts it runs (below) | The seven exit checks of `docs/plan/p2-spec.md`, headless | **yes** (they create their own) |
| Licence classifier | `scripts/licences.test.ts` | The licence allow-list logic used by `npm run licences` and `npm run notices` (SPDX expressions, arrays, missing, exceptions, forbidden imports) | no |

Test data: `server/routes/meta/fixtures.ts` is the legacy sample fixture; seed data is in `server/routes/meta/seed.ts` with
`sample-app.json` (a test checks that it matches `src/runtime/sample.ts`).

## Running unit tests

```bash
npm test                              # everything; integration tests are skipped when APPBUILDER_TEST_DB / _MYSQL are unset
npx vitest run src/fx                 # a folder
npx vitest run server/core/unit.test.ts
npx vitest run -t "Switch"            # by test name
npx vitest                            # watch mode
npm run typecheck                     # tsc -b --noEmit (client) and tsc -p tsconfig.server.json (server)
npm run lint                          # oxlint
```

Skipped integration suites print a line such as `skipped: set APPBUILDER_TEST_DB=postgres://...`; a green `npm test` without the
databases therefore does **not** exercise real SQL. Run the integration tests before merging any change to `server/connectors/`,
`server/core/meta-store.ts`, `server/core/data.ts`, `server/core/security.ts` or the routes.

## Running integration tests against PostgreSQL (and the MySQL connector against MariaDB)

Two variables, both URLs of **sandbox** servers with throw-away accounts; never a database with real data:

- `APPBUILDER_TEST_DB=postgres://user:password@host:port/appbuilder_test`: the system store and the default connection (every
  integration suite except the MySQL connector's). The database named in the URL must exist; the suites use it as the maintenance
  database.
- `APPBUILDER_TEST_MYSQL=mysql://user:password@host:port/appbuilder_test`: only `server/connectors/mysql/mysql.integration.test.ts`.

```bash
export APPBUILDER_TEST_DB='postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test'
export APPBUILDER_TEST_MYSQL='mysql://abdev:abdev-sandbox-only@127.0.0.1:3306/appbuilder_test'
npx vitest run server/connectors/postgres  # connector + parity + transactions
npx vitest run server/connectors/mysql     # the MySQL connector + its parity
npx vitest run server/core                 # end-to-end over HTTP (also runs unit.test.ts)
npx vitest run server/routes/meta          # metadata API (also runs the unit tests there)
```

On Windows (PowerShell), with a sandbox PostgreSQL on another port, for example 5435 (the ports in this document are examples; use
the ones of your sandbox servers, and never the port of a real installation):

```powershell
$env:APPBUILDER_TEST_DB    = 'postgres://abdev:abdev-sandbox-only@127.0.0.1:5435/appbuilder_test'
$env:APPBUILDER_TEST_MYSQL = 'mysql://abdev:abdev-sandbox-only@127.0.0.1:3307/appbuilder_test'
npx vitest run server/core/backup
```

(`abdev` / `abdev-sandbox-only` is the sandbox account used by the project's documentation; any account with the rights below
works. `server/core/testdb.ts` holds the helpers: `withPg`, `createDatabase`, `dropDatabase` (`WITH (FORCE)`), `pgQuery`,
`testDatabaseName`.) A `mysql://` URL in `APPBUILDER_TEST_DB` is refused with a message.

What each suite creates and needs:

- `server/core/integration.test.ts` runs the setup wizard's endpoint with `createDatabase: true`, so the server creates a fresh
  database `appbuilder_test_s1_<8 hex>`; the suite drops it afterwards. Likewise `server/routes/meta/meta.integration.test.ts`
  (`_s2_`), `server/core/fixes.integration.test.ts` (`_fx_`: body limits, RLS WITH CHECK, atomic deletes and imports, attachment
  limits, row order, throttle codes, lowercase emails, refusal of MySQL-era schema versions), `server/core/hardening.integration.test.ts`
  (`_hd_`: setup code and setup lock, anonymous status, forced password change, linking tables of the default database with and
  without consent, assign owner, the layout of schemas `ab`/`env_default`, boot retry, downgrade guard, Secure cookie),
  `server/core/admin.integration.test.ts` and `server/core/transactions.integration.test.ts` (`_tx_`: units of work).
- Integration tests create the app with `createApp({ ..., printSetupCode: false })` and send `app.services.setupCode.current()`
  as `setupCode` to `/setup/database` and `/setup/admin`.
- `server/connectors/postgres/postgres.integration.test.ts` works in a fresh schema `tst<hex>` of the URL's database and drops it
  with `CASCADE` afterwards.
- `server/connectors/mysql/mysql.integration.test.ts` uses the MySQL database named in its URL, which must exist, and creates and
  drops its own tables inside it with a random `tst<hex>_` prefix. It needs `ALL` on that database.

Required rights on the sandbox PostgreSQL (run as a superuser): a login role with **CREATEDB** (no superuser needed) that may
connect to and create schemas in the URL's database:

```sql
CREATE ROLE abdev LOGIN CREATEDB PASSWORD 'abdev-sandbox-only';
CREATE DATABASE appbuilder_test OWNER abdev ENCODING 'UTF8' TEMPLATE template0;
```

and on the sandbox MySQL/MariaDB:

```sql
CREATE DATABASE IF NOT EXISTS appbuilder_test;
CREATE USER 'abdev'@'%' IDENTIFIED BY 'abdev-sandbox-only';
GRANT ALL PRIVILEGES ON `appbuilder\_test%`.* TO 'abdev'@'%';
```

The escaped underscore matters: an unescaped `_` is a single-character wildcard in MySQL grants.

Verified status: PostgreSQL 16 passes (sandbox and CI), also with a non-superuser CREATEDB role; PostgreSQL 15 and 17 are supported
targets not yet run in CI. The MySQL connector passes on MariaDB 10.11; MySQL 8.4 is pending.

## What to test for each kind of change

| Change | Test it with |
| --- | --- |
| New Fx function | A case in the matching `src/fx/*.test.ts` using `val`/`err` (blank, error, laziness). Then `npm run docs:gen`. |
| New UI component | Logic helpers in a unit test; manual check in the Studio (design and run mode, light and dark); `npm run docs:gen`. |
| Condition semantics (`condition.ts` or a `sql.ts`) | Unit tests in `postgres/sql.test.ts` (and `mysql/sql.test.ts`), **and a new case in the parity lists** of `postgres.integration.test.ts` and `mysql.integration.test.ts`. |
| Security rule (`security.ts`, `data.ts`) | A role table with expected rows in `unit.test.ts` or `security.test.ts`, and a flow in `server/core/integration.test.ts` over HTTP. |
| New route | A route test in `server/routes/meta/*.test.ts` through the harness (status codes and error codes for each auth level), then `data-api.md`. |
| Schema change | `schema.md`, `meta.integration.test.ts`, and a run against a real server. |
| Client platform | `src/platform/remote.test.ts` (fake `fetch`): optimistic apply, rollback, ordering, 401 handling. |

Write fakes for external systems and inject them (`ConnectorEnv.fetch`, temp directories, `FakeMetaStore`); tests must not use the
network except the sandbox database, and must not depend on the clock or random values unless seeded or injected.

## Licence gate

`npm run licences` (`scripts/check-licences.mjs`) runs in CI right after `npm ci`. It reads the installed `node_modules` tree and exits 1 when:

1. A **production** dependency (direct or transitive, everything reachable from `dependencies`) has a licence outside the allow-list:
   MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, BlueOak-1.0.0, CC0-1.0, Unlicense, Python-2.0, PSF-2.0, Zlib,
   CC-BY-4.0 (data and fonts only) and MPL-2.0 (allowed, reported as "file-level copyleft: do not modify in place").
   `A OR B` passes when one side is allowed and the report records which side we rely on (for example `jszip` -> MIT);
   `A AND B` needs both sides; `X WITH exception` is judged on `X`.
2. The licence is on the explicit deny list: AGPL, GPL, LGPL (unless one side of a dual licence is allowed), SSPL, BUSL, Elastic,
   Commons Clause, Sustainable Use, fair-code, UNLICENSED, or missing. Anything else that is not on the allow-list, such as
   `SEE LICENSE IN ...`, fails too, because nobody has reviewed it.
3. A production dependency is on the do-not-embed list in `DENIED_PACKAGES` (`n8n*`, `nocodb*`, `@directus/*`, `handsontable`,
   `tldraw`, `pm2`, `@univerjs-pro/*`, each with a one-line reason). Exceptions do not apply to this list.
4. Our own source (`src/`, `server/`, `scripts/`, test files excluded) imports from a path containing `/ee/` or `/enterprise/`, or from
   `@univerjs-pro`.

5. Font files bundled in `server/core/print/fonts/` (P2-B print templates; not npm packages) have no SIL Open Font License 1.1
   text next to them. OFL 1.1 is accepted **for fonts only**: it allows embedding in documents and bundling with software
   (the fonts may not be sold on their own); `npm run notices` lists them with the licence text.

Development dependencies are **reported, never failed**, because they are not shipped. AGPL dev tools and do-not-embed names get a
warning: keep them separate, unmodified tools and never bundle or import them into the product.

Licence detection lives in `scripts/lib/licences.mjs` and is shared with `npm run notices` (`scripts/gen-notices.mjs`, which
regenerates `THIRD-PARTY-NOTICES.md`), so the two cannot disagree. Run `npm run notices` after changing production dependencies.

### Adding an exception

Prefer replacing the package. If it is genuinely needed and someone with authority has read the licence, add an entry to
`scripts/licence-exceptions.json` in the same change:

```json
{ "exceptions": [
  { "name": "some-package", "versions": "^2.1.0", "reason": "Licence text is MIT in LICENSE but package.json only says SEE LICENSE IN LICENSE; checked 2026-11-18",
    "approvedBy": "name of the reviewer" }
] }
```

`versions` is a range (`*`, `1.2.3`, `1.x`, `^1.2.0`, `~1.2.0`, `>=1 <2`, `a || b`), so a new major version is checked again. All four fields
are required. The reason must say why the licence is acceptable, not just that it is needed. An exception that no production
package uses any more is reported; delete it. The file starts empty and an exception is a visible, reviewed decision, never a way to
get a build green. A real denied licence (AGPL, GPL, and so on) is not a candidate for an exception: remove or replace the dependency.

## Generated documentation and staleness tests

Reference pages that can come from the code are generated, and a test fails when they are out of date:

- `npm run docs:gen` (which is `vitest run scripts/docs`) writes `docs/reference/formulas.md` and `docs/reference/ui-components.md` from
  `fx.functions()`, `fx.enums()` and the UI component registry, using the hand-maintained parts in
  `scripts/docs/formulas.ts` (function categories) and `scripts/docs/controls.ts` (one-line descriptions and notes). Write mode is on when `DOCS_WRITE=1` or the
  command is started through `npm run docs:gen`.
- `npm test` runs `scripts/docs/generate.test.ts` in check mode: it fails with "`docs/reference/... is stale. Run npm run docs:gen`
  and commit the result" plus the first differing line, fails when a UI component has no description, and checks that generation is
  deterministic.
- Never edit a generated file by hand (it starts with a `GENERATED FILE` notice). Change the code or the hand-written part in
  `scripts/docs/` and regenerate.
- `src/fx/animatedIcons.ts` is generated by `node scripts/gen-animated-icons.mjs`; `src/fx/animatedIcons.test.ts` fails if it drifts
  from `react-useanimations/catalog.json`.
- `THIRD-PARTY-NOTICES` is produced by `npm run notices` (`scripts/gen-notices.mjs`).
- Screenshots are regenerated by running `node scripts/docs-shots/capture.mjs` directly (there is no npm script; see below).

## Browser checks (developer tools, not part of the product)

Unit tests cannot show what a maker sees. Two kinds of browser checks are used:

1. **Manual** (always): build (`npm run build`) or `npm run dev`, open the app, and exercise the changed screens in server mode
   and, if the change touches shared code, demo mode (open `dist/index.html` without the server). Check light and dark themes and the
   Studio in design and Preview.
2. **Scripted with puppeteer** (optional): `scripts/docs-shots/capture.mjs` drives a real server in a
   headless Chrome to produce the documentation screenshots. **Puppeteer and Chrome are not dependencies of this repository** and are
   not installed by `npm install`; the scripts import `puppeteer-core` from `PUPPETEER_CORE` (the folder `.../node_modules/puppeteer-core`;
   install it once anywhere with `npm install puppeteer-core` and point the variable there) and start Chrome from `CHROME_PATH`.
   The exit-check and benchmark scripts look in the usual places when the variables are unset (`scripts/exit-check/browser-env.mjs`);
   the `docs-shots` scripts still default to the Linux paths of the original sandbox (`/tmp/pgcheck/...`, `/usr/bin/google-chrome`), so
   set both variables for them. Its header explains the two sandbox servers it needs
   (one with a database, one for the setup wizard). Treat any puppeteer script you write as a developer tool in `scripts/`, with
   sandbox values only (a test email such as `admin@example.test`, an obviously fake password), never against real data, and never
   as a replacement for a unit test. `window.__ab` (store, ui, evaluator) is available in the page for assertions.

## Installers, releases and the updater (package L)

- `npx vitest run server/core/update server/core/diagnostics scripts/install`: ZIP writer/reader, checksums, Ed25519
  signatures, version order, the updater flow with fake service control (swap, rollback, refusals), redaction (every
  secret shape), the rotating file log, the diagnostics bundle, the manifest; `ops.integration.test.ts` runs the health,
  logs, usage, diagnostics and updates routes against PostgreSQL.
- Windows installer (any OS with PowerShell 7 and Pester 5): `pwsh -NoProfile -Command "Invoke-Pester -Path
  scripts/install/windows/tests"`; set `APPBUILDER_RELEASE_DIR=release/appbuilder-<version>` (after `npm run release`) to
  include the full `-WhatIf` run of `install.ps1`/`uninstall.ps1` with stubbed Windows commands. Lint with
  PSScriptAnalyzer (`PSUseCompatibleSyntax`/`Commands`/`Types` for Windows PowerShell 5.1).
- Linux installer end to end (Docker with privileged containers): `bash scripts/install/tests/linux-e2e.sh ubuntu:24.04`
  (also `ubuntu:22.04`, `debian:12`); behind an intercepting proxy set `https_proxy` and `E2E_CA_FILE`. About 3 minutes.
- Screens: `scripts/docs-shots/operations.mjs` (Server logs, Usage, Updates with an uploaded release).

## Phase exit checks

The exit checks of a phase (the numbered list in `docs/plan/pN-spec.md`) are developer scripts in `scripts/exit-check/`. Each starts
its own server on an **empty database it creates and drops** (names starting with `appbuilder_exit...`), checks what a person
would, prints PASS / FAIL lines and exits 1 when a check fails. Sandbox values only; none of them touches real data.

| Script | What it runs | Needs |
| --- | --- | --- |
| `p0.mjs` | Phase 0: a million rows through the API with time limits, the headless browser check (`scripts/bench/browser-check.mjs`), the delegation error, the restore drill (`scripts/drill/restore-drill.mjs`), reset + TOTP + sessions against `server/core/identity/fake-smtp.ts`, a second environment. Prints the Markdown table that `docs/plan/p0-spec.md` records | `npm run build`, puppeteer-core, Chrome; about 2.5 minutes |
| `p1.mjs` | Phase 1: the approvals and flows exit-check tests (vitest), `p1-designer.mjs` (a flow built by clicking only), approvals from inbox, bell and email link, a scheduled report, solutions with flows, restricted flows and run-as, the docs tests, the kill switch, the recycle bin | `npm run build`, puppeteer-core, Chrome; about 2 minutes |
| `p2.mjs` | **All seven Phase 2 checks in one run** (below) | everything above; about 30 minutes and about 1 GB of database space at 1,000,000 rows (dropped afterwards) |
| `p2-phone.mjs` (check 1) | The phone: Chrome with Android emulation, a fake camera playing a generated barcode and QR video, photo through `<input capture>`, the home-screen start address, offline toggling, a slow-3G profile and a flapping connection, the outbox without duplicates | build, puppeteer-core, Chrome |
| `p2-pdf.mjs` (check 2) | A flow with a schedule trigger emails the daily OEE PDF; a template built by clicking; printing a record from an app (Print button, `Print`, `GeneratePdf` into a file column, the timeline's Document action) | build, puppeteer-core, Chrome; `pdftotext` (poppler) is optional and adds a text check of the PDFs |
| `p2-dashboard.mjs` (check 3) | The built-in "Production overview" (7 tiles) on 1,000,000 production rows and 200,000 downtime rows for a user who may read only own rows: API timing of the batch endpoint cold and cached, the OEE tile against SQL over that user's rows, a headless browser timing from navigation to every tile drawn, cross-filter, arrow keys, a Pareto table view, the phone layout. **Needs a running server on an empty database** (its header has the commands; `p2.mjs` starts one) | build, puppeteer-core, Chrome, a running server and `PG_URL` |
| `p2-tile-editor.mjs`, `p2-dashboard-layout.mjs` (check 3, supporting) | The visual tile editor and the dashboard layout, viewer roles, settings and drill-through, in demo mode from `dist/index.html` (no server); the tile editor also against a server when `BASE`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set | build, puppeteer-core, Chrome |
| `p2-dashboard-screens.mjs` (check 3, supporting) | View tokens, the kiosk page (what the server really received), email snapshots with PDFs, pins, settings, viewer roles, drill-through, against a real server with a fake SMTP server | build, puppeteer-core, Chrome; PyMuPDF (`python -m pip install pymupdf`, variable `PYTHON`) is optional and renders page 1 of the snapshot PDF |
| `p2-autoapp.mjs` (check 4) | "Create app from table" for desktop and phone, edited in the Studio, a user without the Maker role, demo mode | build, puppeteer-core, Chrome |
| `p2-templates.mjs` (check 5) | The four template kinds installed through the binding step and the plan screen; a blocked install; the environment before and after compared byte by byte | build, puppeteer-core, Chrome |
| `p2-whatsapp.mjs` (check 6) | A template message from a flow to the mock Graph API, opt-in, no send without it, signed webhooks, STOP. No browser | a sandbox PostgreSQL only |

**`p2.mjs`** runs the other scripts as child processes, one after the other (the timings are part of the evidence), saves each
one's output and prints one table with the seven checks (check number, what, PASS / FAIL / PENDING / SKIP, evidence with counts and
timings) and a second table with every script. Check 3 is `p2-dashboard.mjs` plus the three supporting scripts; the server it needs
is started by `p2.mjs` itself on a free port with its own database. Check 7 runs `p0.mjs`, `p1.mjs`, the docs link, naming and
generated-reference tests, and looks for `docs/internal/security-review-p2.md` (PENDING while the file does not exist). The exit
code is 1 when anything fails, 3 when nothing failed but the security review is still pending, 0 otherwise.

```powershell
. .\.sandbox\env.ps1                  # this repository's Windows sandbox variables; any APPBUILDER_TEST_DB will do
$env:PUPPETEER_CORE = "$PWD\.sandbox\s1\tools\node_modules\puppeteer-core"   # the folder of puppeteer-core
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:OUT = "$PWD\.sandbox\c3\p2-run"  # the children's output, screenshots, summary.md
npm run build
node scripts/exit-check/p2.mjs
```

```bash
export APPBUILDER_TEST_DB='postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test'
export PUPPETEER_CORE=$HOME/pgcheck/node_modules/puppeteer-core CHROME_PATH=/usr/bin/google-chrome OUT=/tmp/p2-run
npm run build && node scripts/exit-check/p2.mjs
```

(The paths above are examples: `/home/claude/...`, `/tmp/pgcheck` and port 5433 in the older scripts' headers come from the
original Linux sandbox. Use the folders and ports of your own sandbox, and never the port of a real installation.)

Settings (the scripts agree on these names; every one is optional):

| Variable | Meaning | Default |
| --- | --- | --- |
| `EXIT_DB_HOST`, `EXIT_DB_PORT`, `EXIT_DB_USER`, `EXIT_DB_PASSWORD` | the sandbox PostgreSQL; the role needs `CREATEDB`, no superuser | `p2.mjs`: the parts of `APPBUILDER_TEST_DB`. The other scripts: `127.0.0.1`, port `5433` (a few `5435`), `abdev`, `abdev-sandbox-only`; **set the port when your sandbox is elsewhere**, the default may be a real installation |
| `EXIT_MAINT_DB` | an existing database to connect to for `CREATE` / `DROP DATABASE` | `appbuilder_test` |
| `EXIT_DB_NAME`, `EXIT_PORT`, `EXIT_WORKSPACE` | database, port and workspace folder of one script (each has its own default; `p2.mjs` sets all three per script, ports from 5270 up) | per script |
| `PUPPETEER_CORE`, `CHROME_PATH` | where puppeteer-core and Chrome are. `p0`, `p1`, `p1-designer`, `p2.mjs`, `p2-dashboard` and the bench script look in the usual places of Windows, macOS and Linux when unset; `p2-phone`, `p2-pdf`, `p2-dashboard-screens` and the `docs-shots` scripts still default to the Linux paths of the original machine, so set both variables | none |
| `SHOTS`, `OUT` | where screenshots and received files go (`p2.mjs`: `OUT` is its own output folder and it gives each script a subfolder) | a temp folder; `p2-dashboard.mjs` falls back to `docs/images` when both are unset |
| `EXIT_ROWS` | rows of the big tables in `p0.mjs` and `p2.mjs` (`ROWS` for `p2-dashboard.mjs`). A smaller number is fine to try a script out, but the browser part of `p0.mjs` expects exactly 1,000,000 | `1000000` |
| `EXIT_SKIP` | comma list. `p0.mjs`: `browser`, `drill`. `p1.mjs`: `browser`, `designer`, `suites`. `p2.mjs`: the step names `phone`, `pdf`, `dashboard`, `tile-editor`, `dashboard-layout`, `dashboard-screens`, `autoapp`, `templates`, `whatsapp`, `p0`, `p1`, `docs`, `security-review`, or `check1` to `check7`, or the parts `p0-browser`, `p0-drill`, `p1-browser`, `p1-designer`, `p1-suites`, `dashboard-browser`. A skipped step is printed as SKIP, never as PASS | none |
| `EXIT_ONLY` | `p2.mjs`: run only these steps (same names) | all |
| `EXIT_RETRY=1` | `p2.mjs`: run a failed script once more; when it then passes, the evidence says it passed only on the second attempt (a flaky check should be seen, not hidden) | off |
| `KEEP=1` | keep the databases (they are large) | dropped |
| `EXIT_STEP_TIMEOUT_MIN` | `p2.mjs`: stop a step after this many minutes (only the process tree it started) | `40` |

The restore drill (`scripts/drill/restore-drill.mjs`) reads `DRILL_DB_*` and falls back to the `EXIT_DB_*` variables. It uses the
`pg_dump` and `pg_restore` that the product finds (`server/core/backup/pgtools.ts`).

What these checks are **not**: they are not a real phone or iOS Safari (Chrome's phone emulation and a fake camera), not the real
WhatsApp Cloud API (a mock of the Graph API; the shapes come from Meta's documentation and nothing was recorded from an account),
not a real mail provider (a fake SMTP relay), and their timings come from a developer PC with a sandbox database (`fsync` may be
off), so they are **not production numbers**. `docs/dev/phone-test-script.md` is the manual script for real phones.

## Isolation suite (hosting exit check 2)

`node scripts/exit-check/h-isolation.mjs` (also `npx vitest run server/core/hosting/isolation`) starts three installs of
this tree as separate processes (`node --import scripts/fleet/testing/dns-shim.mjs server/main.ts`), each with its own
database and PostgreSQL role set up as the fleet tool will (no superuser, `CREATEDB` or `CREATEROLE`; `CONNECT` only to
its own database; `PUBLIC` revoked there and on `postgres` / `template1`; `CONNECTION LIMIT 12` on role and database;
`statement_timeout` 60 s), its own folder, workspace, secret key and locked `https://<key>.hb.test.invalid` address,
hosted settings on and `APPBUILDER_OUTBOUND_DENY=*.hb.test.invalid`. They sit behind an in-process proxy on
127.0.0.1:5300 that routes like the Caddy site template (exact host names, catch-all 404, canonical `Host`,
`X-Forwarded-Host` removed, `X-Forwarded-For` replaced, `X-Forwarded-Proto: https`; no TLS). The DNS shim answers only
for the test names (`*.hb.test.invalid` -> the server, `*.hb-dns.test.invalid` -> loopback, private, IPv6, metadata) and
changes nothing in the product. Loopback canaries on 5310/5311 record any connection an outbound attempt makes.

| File | What |
| --- | --- |
| `scripts/fleet/testing/fleet.mjs` | the fleet: PostgreSQL, roles, installs (seed-config, migrate, admin invite, start), proxy, canaries, cleanup (also on Ctrl-C) |
| `scripts/fleet/testing/isolation.mjs` | the checks, the leak scan of every answer and of A's logs, the Markdown report |
| `scripts/fleet/testing/dns-shim.mjs` | test-only DNS answers for the installs' processes |
| `scripts/exit-check/h-isolation.mjs` | prints the table (also `.sandbox/hb/h-isolation.md`); exit 1 on any failed check, 2 when the fleet cannot start |
| `server/core/hosting/isolation.integration.test.ts` | the same suite under vitest, one test per area plus the negative controls |

PostgreSQL: `APPBUILDER_HB_ADMIN_DB=postgres://<superuser>:<pw>@host:port/postgres` for a cluster the suite may change
(CI), otherwise a **private cluster** made with `initdb` / `pg_ctl` from `APPBUILDER_HB_PG_BIN` (default
`.sandbox/pg/pgsql/bin`) on 127.0.0.1:`APPBUILDER_HB_PG_PORT` (5319), password authentication, removed afterwards. Not the
shared sandbox cluster: revoking `CONNECT` on `postgres` / `template1` there breaks every other suite that creates
databases through them. `APPBUILDER_HB_SHARED_CLUSTER=1` leaves those two grants alone (two checks then show "not run").
Ports 5300-5319; 5174 and 5433 are refused. Everything is named `ab_hb_*` and removed; `HB_KEEP=1` keeps the folders.
About 2.5 minutes on the development PC (start-up of three installs is most of it). On Linux the installs listen on Unix
sockets; on Windows on TCP 127.0.0.1 (the socket check shows "not run"). A hard kill (not Ctrl-C) can leave install
processes running; the next run stops a leftover private cluster in `.sandbox/hb`.

Every check asserts the refusal and that nothing of B (marker row, administrator and user email, database password,
secret key, folders, session, API key, view token, invitation) is in the answer; at the end A's console and log files are
searched for B and for A's own secrets. Database and role names are not secrets: every role reads them in the catalogue
(they are opaque `ab_hb_o<8>` ids). Negative controls, each must be detected: a database with PostgreSQL's default grants
is reachable by A's role; `postgres` is reachable before the cluster preparation; the on-premises outbound policy reaches
the loopback canary.

Not covered here (a Linux server with systemd, one OS user per install and Caddy, later packages): file permissions between
installs (every install here runs as the same OS user, so A's process could read B's folder), systemd CPU, memory and task
limits, disk quotas, real TLS and Caddy's admin API and rate limits, the licence service, `abfleet` itself, an install
restore of another install's archive through the CLI (H-F).

## Fleet checks (hosting exit checks 1, 3, 4, 5, 10; packages H-D to H-K)

Three levels, from cheapest to most real:

1. **Unit tests on the recording fake** (`npx vitest run scripts/fleet`; `scripts/fleet/test/`): every command runs
   through the real CLI entry against `FakeSystem`, an in-memory machine that records each call. They check the order
   of effects (user, folders, database with its REVOKEs, key, env, seed-config with the password on standard input,
   migrate, invitation, unit, site), that `org create` leaves NOTHING after a failure injected at each of its steps in
   turn, `--dry-run` changes nothing, delete's scan, the update rule (canary, batches, a schema-changing failure
   restored from its snapshot, a code-only rollback, a failed canary stopping the fleet), backups off the machine and
   retention, restore of one install, operator access and its expiry, rotation (and its undo), limits, doctor. Under a
   second; platform-neutral.
2. **`node scripts/exit-check/h-fleet.mjs`** (local test mode, about 6 to 8 minutes on the development PC): the real
   tool, real installs of this tree as child processes on TCP ports 5360-5397, the real licence service on 5399, a fake
   SMTP relay on 5398 (the operator's summary), a private PostgreSQL cluster from `APPBUILDER_FLEET_PG_BIN` (default
   `.sandbox/pg/pgsql/bin`) on 127.0.0.1:5350. Two signed local packages stand for two releases (checksums and
   signature verified for real; both run this source tree). Prints a Markdown table (also `.sandbox/fleet/h-fleet.md`,
   transcript `.sandbox/fleet/h-fleet-transcript.txt`); everything under `.sandbox/fleet/run-*`, databases and roles
   `ab_fleet_*`, removed afterwards (`FLEET_KEEP=1` keeps the folder). Not shown: OS users and file permissions (one OS
   user runs everything), the template unit and its limits, Caddy and TLS, reboot survival.
3. **CI job `fleet`** (`scripts/fleet/ci/fleet-ci.sh` on `ubuntu-latest`, with sudo): two real release builds signed
   with a throwaway key, the fleet installer, systemd units, one OS user per install, Unix sockets with group caddy,
   Caddy's local CA and HTTPS by host name, OS-level isolation checks (folders, sockets, mount namespace, roles), update
   with a canary and a forced failure, backups and restore, access expiry, rotation, delete with a scan. Skips (printed):
   public DNS and real certificates, disk project quotas (the runner's file system has none), reboot survival,
   resource limits under pressure, mail deliverability.

The fleet folder is type-checked with `npx tsc -p scripts/fleet/tsconfig.json` (not yet part of `npm run typecheck`).

## CI

`.github/workflows/ci.yml` runs on every push and pull request to `main`, on `ubuntu-latest` with Node 22.18 (the lowest version
allowed by `engines`, needed for native type stripping). Steps, in order:

1. Two **service containers** with throwaway root passwords that exist only for the job: **PostgreSQL 16** (`postgres:16`, database
   `appbuilder_test`, port 5432) for the system store and the default connection, and **MariaDB 10.11** (database `appbuilder_test`,
   port 3306) for the MySQL connector.
2. **Create the CI roles** `abci`: on PostgreSQL a login role with `CREATEDB` (no superuser) and `ALL` on the database
   `appbuilder_test` (the suites create and drop one database each, and the connector test a schema); on MariaDB a user with
   `GRANT ALL` on `appbuilder\_test%`. They have no rights anywhere else.
3. `npm ci`, then `npm run licences` (the licence gate, above), then `npm run typecheck` (client and server projects).
4. `npm test` with `APPBUILDER_TEST_DB=postgres://abci:...@127.0.0.1:5432/appbuilder_test` and
   `APPBUILDER_TEST_MYSQL=mysql://abci:...@127.0.0.1:3306/appbuilder_test`. This runs the whole suite: unit tests, the docs staleness
   tests, the PostgreSQL integration tests and the MySQL connector tests (each skipped when its variable is unset).
5. `npm run build`.

A second job, **isolation**, runs the cross-instance isolation suite (below) with its own `postgres:16` container and that
container's superuser in `APPBUILDER_HB_ADMIN_DB` (the suite creates roles and revokes `CONNECT` on `postgres` and
`template1` from `PUBLIC`, which the `test` job must not see). The `test` job skips the suite.

A third job, **fleet**, runs the fleet checks above (unit tests, `h-fleet.mjs` with the runner's PostgreSQL binaries,
then `scripts/fleet/ci/fleet-ci.sh` as the real thing on the runner: it installs packages and changes the runner's
PostgreSQL, so it is a job of its own).

The credentials in the workflow are for the disposable service container only; never put real credentials in it. The screenshot
script is not run in CI, and `npm run lint` is not part of the workflow yet. Not covered: a matrix over `postgres:15` and
`postgres:17` (and `mysql:8.4` for the connector) to turn the version targets into tested facts (add it as a `strategy.matrix` over the
service image).

## Known gaps

- No component rendering tests in the repository, and no end-to-end browser tests inside `npm test`: the browser checks are the
  exit-check and docs-shots scripts above, which need puppeteer-core and Chrome (not dependencies) and are not run in CI.
- No real phone and no iOS Safari: the phone checks are Chrome's emulation with a fake camera; `docs/dev/phone-test-script.md` is
  the manual script. Headless Chrome has no `BarcodeDetector` on desktop, so the scan goes through our own decoders; the native
  detector is not exercised.
- WhatsApp is tested against a mock of the Graph API only (shapes from Meta's documentation, nothing recorded from a real account);
  the PDF tests need poppler and zxing-cpp for the barcode round trip and skip it without them; SMTP is a fake relay.
- Exit-check timings come from a developer PC with a sandbox database; they are not production numbers and the million-row checks
  are not run in CI. `scripts/bench/orgsec-bench.mjs` and `seed-million.mjs` are manual tools.
- Several older scripts still carry Linux defaults in their headers or code (`/tmp/pgcheck`, `/usr/bin/google-chrome`, port 5433),
  notably `scripts/docs-shots/*` and `p2-phone`, `p2-pdf`, `p2-dashboard-screens`: set `PUPPETEER_CORE` and `CHROME_PATH`. P0 and P1
  exit checks use `networkidle2`, not `networkidle0`: since the service worker of the installable app, Chrome never reports an idle
  network on a first visit (cause not investigated further).
- Import-boundary rules (`architecture.md`) are not checked by a tool.
- The integration tests run in CI against PostgreSQL 16 and (MySQL connector) MariaDB 10.11 only; other versions are tested by hand.
- Node 24 and later turn a `FileHandle` that is closed by the garbage collector into an uncaught error (Vitest reports it as an
  unhandled error and exits 1). Any code that opens a file with `fs.promises.open` must close the handle on every path; the backup
  code is covered by the "file handles" tests, other code is not audited by a tool. CI runs Node 22.18, where the same mistake would only warn.
- `scripts/docs/generate.test.ts` is matched by the `scripts/**/*.test.ts` glob; the other scripts have no tests, except
  `scripts/docs-links.test.ts`, `naming.test.ts`, `licences.test.ts` and `scripts/install/manifest.test.ts`.

## The environments walkthrough (headless browser)

`scripts/docs-shots/environments.mjs` drives a real server through the environments flow (create a sandbox copied from
Default, switch, change an app and a table there, Default unchanged, deploy with the plan dialog, lock Default, edits refused,
delete the sandbox) and writes the screenshots of `docs/admin/environments.md`. It needs puppeteer-core, Chrome and an empty
sandbox database; the header of the script has the commands. It exits 1 on the first failed check.
