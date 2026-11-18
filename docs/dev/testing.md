# Testing

Tests run with **Vitest** (`npm test` runs `vitest run`). The configuration is in `/home/claude/appbuilder-demo/vite.config.ts`:
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
| Integration (PostgreSQL) | `server/connectors/postgres/postgres.integration.test.ts`, `server/core/{integration,fixes,hardening,admin,transactions}.integration.test.ts`, `server/routes/meta/meta.integration.test.ts` | The PostgreSQL connector against a real server including SQL-versus-reference **parity**, pooled-connection settings and transactions; the whole HTTP API end to end (cookie jars per user, RBAC/RLS/CLS, attachments); units of work (a failed import or schema change leaves nothing behind); the metadata API | **yes**, `APPBUILDER_TEST_DB` |
| Integration (MySQL connector) | `server/connectors/mysql/mysql.integration.test.ts` | The MySQL connector (external databases) against MySQL/MariaDB including parity | **yes**, `APPBUILDER_TEST_MYSQL` |
| Generated docs | `scripts/docs/generate.test.ts` | Staleness of `docs/reference/*.md` (below) | no |
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
| New control | Logic helpers in a unit test; manual check in the Studio (design and run mode, light and dark); `npm run docs:gen`. |
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

- `npm run docs:gen` (which is `vitest run scripts/docs`) writes `docs/reference/formulas.md` and `docs/reference/controls.md` from
  `fx.functions()`, `fx.enums()` and the control registry, using the hand-maintained parts in
  `/home/claude/appbuilder-demo/scripts/docs/formulas.ts` (function categories) and
  `/home/claude/appbuilder-demo/scripts/docs/controls.ts` (one-line descriptions and notes). Write mode is on when `DOCS_WRITE=1` or the
  command is started through `npm run docs:gen`.
- `npm test` runs `scripts/docs/generate.test.ts` in check mode: it fails with "`docs/reference/... is stale. Run npm run docs:gen`
  and commit the result" plus the first differing line, fails when a control has no description, and checks that generation is
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
2. **Scripted with puppeteer** (optional): `/home/claude/appbuilder-demo/scripts/docs-shots/capture.mjs` drives a real server in a
   headless Chrome to produce the documentation screenshots. **Puppeteer and Chrome are not dependencies of this repository** and are
   not installed by `npm install`; the script imports `puppeteer-core` from `PUPPETEER_CORE` (default
   `/tmp/pgcheck/node_modules/puppeteer-core`) and Chrome from `CHROME_PATH`. Its header explains the two sandbox servers it needs
   (one with a database, one for the setup wizard). Treat any puppeteer script you write as a developer tool in `scripts/`, with
   sandbox values only (a test email such as `admin@example.test`, an obviously fake password), never against real data, and never
   as a replacement for a unit test. `window.__ab` (store, ui, evaluator) is available in the page for assertions.

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

The credentials in the workflow are for the disposable service container only; never put real credentials in it. The screenshot
script is not run in CI, and `npm run lint` is not part of the workflow yet. Not covered: a matrix over `postgres:15` and
`postgres:17` (and `mysql:8.4` for the connector) to turn the version targets into tested facts (add it as a `strategy.matrix` over the
service image).

## Known gaps

- No component rendering tests and no end-to-end browser tests in the repository.
- Import-boundary rules (`architecture.md`) are not checked by a tool.
- The integration tests run in CI against PostgreSQL 16 and (MySQL connector) MariaDB 10.11 only; other versions are tested by hand.
- `scripts/docs/generate.test.ts` is matched by the `scripts/**/*.test.ts` glob; other scripts have no tests.
