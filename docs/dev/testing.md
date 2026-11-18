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
| Runtime | `src/runtime/{evaluator,submit,attachments}.test.ts` | Dependency tracking and invalidation, form submit flow, attachment helpers | no |
| Platform (client) | `src/platform/{platform,demo,remote}.test.ts` | Demo-mode core, the remote platform's optimistic cache, rollback and mirrored checks (against a fake `fetch`) | no |
| Server core | `server/core/unit.test.ts` | Router guards, auth, security engine, DataService, values, conditions, with in-memory fakes | no |
| Server metadata routes | `server/routes/meta/{meta,connections,files,migrate,security,solutions,tables}.test.ts` | Apps, tables, columns, connections, roles and users, solutions, packages, legacy migration, data files. They use the in-memory `FakeMetaStore` harness `server/routes/meta/testing.ts` with the **real** `SecurityEngine`, `DataService` and `ConnectionManager` | no |
| Connectors | `server/connectors/mysql/sql.test.ts` (pure SQL builder), `files/files.test.ts` (temp directory), `gsheets/gsheets.test.ts` (injected fake Google API) | Each connector in isolation | no |
| Integration | `server/connectors/mysql/mysql.integration.test.ts`, `server/core/integration.test.ts`, `server/routes/meta/meta.integration.test.ts` | The MySQL connector against a real server including SQL-versus-reference **parity**, the whole HTTP API end to end (cookie jars per user, RBAC/RLS/CLS, attachments), the metadata API | **yes** |
| Generated docs | `scripts/docs/generate.test.ts` | Staleness of `docs/reference/*.md` (below) | no |

Test data: `server/routes/meta/fixtures.ts` is the legacy sample fixture; seed data is in `server/routes/meta/seed.ts` with
`sample-app.json` (a test checks that it matches `src/runtime/sample.ts`).

## Running unit tests

```bash
npm test                              # everything; integration tests are skipped when APPBUILDER_TEST_DB is unset
npx vitest run src/fx                 # a folder
npx vitest run server/core/unit.test.ts
npx vitest run -t "Switch"            # by test name
npx vitest                            # watch mode
npm run typecheck                     # tsc -b --noEmit (client) and tsc -p tsconfig.server.json (server)
npm run lint                          # oxlint
```

Skipped integration suites print a line such as `APPBUILDER_TEST_DB is not set: integration tests are SKIPPED`; a green `npm test`
without a database therefore does **not** exercise real SQL. Run the integration tests before merging any change to
`server/connectors/mysql/`, `server/core/meta-store.ts`, `server/core/data.ts`, `server/core/security.ts` or the routes.

## Running integration tests against MySQL or MariaDB

Set `APPBUILDER_TEST_DB` to a URL: `mysql://user:password@host:port/appbuilder_test`. Use a **sandbox** server and a throw-away
account; never a database with real data. Then:

```bash
export APPBUILDER_TEST_DB='mysql://abdev:abdev-sandbox-only@127.0.0.1:3306/appbuilder_test'
npx vitest run server/connectors/mysql     # connector + parity
npx vitest run server/core                 # end-to-end over HTTP (also runs unit.test.ts)
npx vitest run server/routes/meta          # metadata API (also runs the unit tests there)
```

(`abdev` / `abdev-sandbox-only` is the sandbox account used by the project's documentation; any account with the grants below
works.)

What each suite creates and needs:

- `server/core/integration.test.ts` creates a fresh database `appbuilder_test_s1_<8 hex>` and drops it afterwards, so the account
  needs `CREATE` and `DROP` on `appbuilder_test%`.
- `server/routes/meta/meta.integration.test.ts` does the same with `appbuilder_test_s2_<8 hex>`, and
  `server/core/fixes.integration.test.ts` (body limits, RLS WITH CHECK, atomic deletes and imports, attachment limits, row order,
  throttle codes, email migration) with `appbuilder_test_fx_<8 hex>`.
- `server/connectors/mysql/mysql.integration.test.ts` uses the database named in the URL (`appbuilder_test`), which must exist, and
  creates and drops its own tables inside it with a random `tst<hex>_` prefix. It needs `ALL` on that database. Besides
  parity it covers DDL, indexes, transactions (a failing multi-row insert rolls everything back) and error mapping.

Required grants (run as an administrator on the sandbox server):

```sql
CREATE DATABASE IF NOT EXISTS appbuilder_test;
CREATE USER 'abdev'@'%' IDENTIFIED BY 'abdev-sandbox-only';
GRANT ALL PRIVILEGES ON `appbuilder\_test%`.* TO 'abdev'@'%';
```

The escaped underscore matters: an unescaped `_` is a single-character wildcard in grants. On MariaDB the same statements work.

Verified status: MariaDB 10.11 passes. MySQL 8.4 is pending (decision D7). MySQL 5.7 and MariaDB 10.4 are design targets that have not
been run; see `schema.md` for the compatibility rules. If you can run the suite on another version, record it in the decision log.

## What to test for each kind of change

| Change | Test it with |
| --- | --- |
| New Fx function | A case in the matching `src/fx/*.test.ts` using `val`/`err` (blank, error, laziness). Then `npm run docs:gen`. |
| New control | Logic helpers in a unit test; manual check in the Studio (design and run mode, light and dark); `npm run docs:gen`. |
| Condition semantics (`condition.ts` or `sql.ts`) | Unit tests in `sql.test.ts`, **and a new case in the parity list** of `mysql.integration.test.ts`. |
| Security rule (`security.ts`, `data.ts`) | A role table with expected rows in `unit.test.ts` or `security.test.ts`, and a flow in `server/core/integration.test.ts` over HTTP. |
| New route | A route test in `server/routes/meta/*.test.ts` through the harness (status codes and error codes for each auth level), then `data-api.md`. |
| Schema change | `schema.md`, `meta.integration.test.ts`, and a run against a real server. |
| Client platform | `src/platform/remote.test.ts` (fake `fetch`): optimistic apply, rollback, ordering, 401 handling. |

Write fakes for external systems and inject them (`ConnectorEnv.fetch`, temp directories, `FakeMetaStore`); tests must not use the
network except the sandbox database, and must not depend on the clock or random values unless seeded or injected.

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

1. A **MariaDB 10.11 service container** with a database `appbuilder_test` and a throwaway root password that exists only for the job.
2. **Create the CI user** `abci` with `GRANT ALL` on `appbuilder\_test%`. The integration tests create one database per run
   (`appbuilder_test_s1_<hex>` in `server/core/integration.test.ts`, `appbuilder_test_s2_<hex>` in
   `server/routes/meta/meta.integration.test.ts`) and drop it afterwards, so the user needs rights on every database with that prefix,
   not only on `appbuilder_test`. It has no rights anywhere else.
3. `npm ci`, then `npm run typecheck` (client and server projects).
4. `npm test` with `APPBUILDER_TEST_DB=mysql://abci:...@127.0.0.1:3306/appbuilder_test`. This runs the whole suite: unit tests,
   the docs staleness tests and the MariaDB integration tests (which are skipped when that variable is unset).
5. `npm run build`.

The credentials in the workflow are for the disposable service container only; never put real credentials in it. The screenshot
script is not run in CI, and `npm run lint` is not part of the workflow yet. Not covered: a matrix over `mysql:8.4`, `mysql:5.7` and
`mariadb:10.4` to turn the compatibility targets into tested facts (add it as a `strategy.matrix` over the service image).

## Known gaps

- No component rendering tests and no end-to-end browser tests in the repository.
- Import-boundary rules (`architecture.md`) are not checked by a tool.
- The integration tests run in CI against MariaDB 10.11 only; other database versions are tested by hand.
- `scripts/docs/generate.test.ts` is matched by the `scripts/**/*.test.ts` glob; other scripts have no tests.
