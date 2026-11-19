# Connectors

A **connector** is the server-side adapter that stores and fetches the rows of a table (table connectors, this page's
first half) or that offers **actions** other parts call (action connectors, P1: [Connector actions](#connector-actions)).
Four table connectors ship:
`postgres` (the default database, and external PostgreSQL databases), `mysql` (external MySQL/MariaDB databases), `files` (CSV,
Excel and JSON data files copied into the workspace) and `gsheets` (Google Sheets through a service account). A planned PHP
gateway is a *backend* for the whole Data API, not a connector (see `data-api.md`; on hold since D14).

Connectors know nothing about users or security. The `DataService`
(`/home/claude/appbuilder-demo/server/core/data.ts`) hands a connector a fully security-augmented `Condition` (row-level filter
already ANDed in) and validates and strips columns (column-level security) before and after. Never add permission checks inside a
connector; add them to `security.ts`/`data.ts` (see `security-engine.md`).

What is not supported: connectors cannot be added at run time or by makers (they are compiled into the server and registered in one
file), there are no joins at all (a `lookup` column stores the target row id; formulas resolve it in the browser), and only a
`postgres` connection can be the default store for new tables.

## The interface

Defined in `/home/claude/appbuilder-demo/server/core/contracts.ts`:

```ts
interface Connector {
  readonly kind: ConnectorKind
  readonly capabilities: ConnectorCapabilities   // { ddl, write, pushdown, transactions }
  test(): Promise<{ ok: true; message: string } | { ok: false; message: string }>
  /** optional (PostgreSQL): run a Query v2 plan as one statement; others are served by the DataService fallback */
  queryV2?(def: TableDef, input: QueryV2Input): Promise<QueryV2Raw>
  listSourceTables(): Promise<{ source: string; columns: SourceColumn[]; rowCount?: number }[]>
  describe(source: string): Promise<SourceColumn[]>
  createTable(def: TableDef): Promise<void>
  addColumn(def: TableDef, col: ColumnDef): Promise<void>
  alterColumn(def: TableDef, before: ColumnDef, after: ColumnDef): Promise<void>   // values already verified to convert
  dropColumn(def: TableDef, name: string): Promise<void>
  dropTable(def: TableDef): Promise<void>
  select(def: TableDef, q: Query): Promise<{ rows: RawRow[]; total?: number }>
  insert(def: TableDef, rows: RawRow[]): Promise<void>
  update(def: TableDef, id: string, changes: RawRow, guard?: Condition): Promise<number>
  delete(def: TableDef, ids: string[], guard?: Condition): Promise<number>
  transaction?<T>(fn: (tx: Connector) => Promise<T>): Promise<T>               // capabilities.transactions only
  ensureSystemColumns?(source: string): Promise<{ added: string[]; filled: number }>  // SQL connectors with ddl
  close(): Promise<void>
}
type RawRow = Record<string, string | number | boolean | Date | null>
type ConnectorFactory = (conn: ConnectionRecord, env: ConnectorEnv) => Connector
interface ConnectorEnv {
  environment?: { id: string; schema: string }  // the environment this instance serves
  systemDb?: () => SqlDb | null                 // the system database (used by conn_default)
  workspaceDir: string; filesDir: string; fetch: typeof fetch; log(level, msg): void
}
```

Contract points an implementer must honour:

- **One instance per environment and connection.** The `ConnectionManager` (`server/core/connections.ts`) caches instances per
  `<environment id>:<connection id>`, keyed by a SHA-256 fingerprint of `[connector, settings, secret]`; changing any of them builds a
  fresh instance and closes the old one. The factory gets a `ConnectorEnv` naming the environment. `ConnectionRecord` carries the
  decrypted secret in memory only.
- **`def.source` is always set** when a connector sees a table (the physical name; for `files` it is `<fileId>/<sheet>`).
- **Typed rows.** `select` returns `Date` objects for `date` (UTC midnight) and `datetime` columns, numbers for number types,
  booleans for `boolean`, `null` for blank. The service converts to the JSON wire format.
- **`update` and `delete` take a `guard`** (the row-level filter) and return the affected count. `0` means "not found or not
  allowed"; the service then decides between 403 and 404 by re-reading with the read filter. A connector must apply the guard
  atomically with the write where it can (the SQL connectors do it in the `WHERE`).
- **`where` references only columns of `def`.** Identifiers come from the def, never from the request; a connector must still
  validate or quote them.
- **Errors** are `HttpError(status, code, message, field?)` with friendly text. Never put a password, key, SQL text or file path in
  a message. `mapPgError` / `friendlyConnectionError` in `server/connectors/postgres/db.ts` and `mapDbError` in
  `server/connectors/mysql/index.ts` show the pattern. The router maps raw driver errors with the same functions.
- **Capabilities.**

  | Connector | `ddl` | `write` | `pushdown` | `transactions` |
  | --- | --- | --- | --- | --- |
  | `postgres` | yes | yes | yes | yes (DDL too) |
  | `mysql` | yes | yes | yes | yes (data statements) |
  | `files` | yes | yes | no | no |
  | `gsheets` | yes | yes | no | no |

  `pushdown: false` means the connector loads the sheet or file and runs `applyQuery` from `server/core/condition.ts` itself.
  `transactions: true` means multi-row `insert`/`delete` are all-or-nothing (the integration tests assert a failing chunk rolls
  everything back) and the connector implements the optional `transaction(fn)`: `fn` gets a connector whose statements run on one
  transaction (BEGIN/COMMIT, ROLLBACK when `fn` throws). On PostgreSQL the DDL methods take part too; on MySQL only data statements
  (MySQL commits DDL implicitly). The DataService uses it for a CSV import in `replace` mode (delete + inserts).
- **Atomicity without transactions** (`files`, `gsheets`). The DataService validates everything first (every import row is built
  and checked, every delete target's permission is checked) and then issues one `delete` and one `insert` call. Those two calls are
  still separate writes: on the files connector they land in memory together and are persisted by the next debounced save, so a
  crash in between is the only window; on Google Sheets they are separate API requests, so a failure of the insert request after
  the delete request (network, quota) leaves the replaced rows deleted. Re-run the import in that case.
- **Default order.** A `select` without `orderBy` returns rows in insertion order: the SQL connectors order by `createdOn, id` (row
  ids are time-ordered UUIDv7 from `rowUid()` in `server/core/util.ts`, so `id` breaks ties within a millisecond; only columns the
  def lists are used, so a linked table without system columns gets no default order) and use the same keys as the tie-breaker of an
  explicit sort; the in-memory connectors keep file/sheet order and sort stably.

## Condition semantics (the reference)

`/home/claude/appbuilder-demo/server/core/condition.ts` is the reference implementation (`evaluateCondition`, `applyQuery`,
`conditionColumns`, `and`). Every connector must produce the same answers. The client mirror `src/platform/rowfilter.ts` follows the
same rules. The rules:

- `Condition` is `{ and: [...] } | { or: [...] } | { not: c } | { col, op, value? } | { const: boolean }`. An empty `and` is true, an
  empty `or` is false.
- **Blank** means `null`, `undefined` or `''`. `isBlank` and `notBlank` test that. `eq`/`ne` with `null` (or no value) mean
  `isBlank`/`notBlank`.
- **Text is compared case-insensitively**: both sides lowercased (`toLowerCase()`), then compared exactly; ordering by code unit.
  `contains`, `startsWith`, `endsWith` are text operations on the cell's string form, case-insensitive; a blank cell never matches
  them. `in` takes an array and is true if any element compares equal.
- **Ordering** (`lt le gt ge`) on a blank cell is false. Dates compare by time (a Date against text parsed by `Date.parse`).
  Numbers compare numerically; a number cell against numeric-looking text compares numerically (and vice versa).
- A **number against non-numeric text is not comparable**: `eq` is false, `ne` is true, ordering is false. Booleans compare as
  equal or as true greater than false; a boolean against a non-boolean (either side) is never equal and orders by the truthiness
  of the cell (`x === y ? 0 : x ? 1 : -1`).
- `ne` is true for a blank cell (when the value is not null).
- **`applyQuery`** (used by non-pushdown connectors): filter, `total` (if `count`) is the filtered count before paging, sort by
  `orderBy` with **blanks last in both directions** (blanks tie with each other), then `skip`/`top`, then `select` (the `id` column
  is always kept).

The DataService also validates the tree before it reaches a connector: at most 2000 nodes, depth 32, at most 1000 values per `in`,
known ops, known columns.

## PostgreSQL connector

Files: `server/connectors/postgres/index.ts` (the connector), `sql.ts` (pure SQL builder, unit-testable), `db.ts` (pool,
transactions, units of work, error mapping).

Two uses of the same code:

- **The default connection** (`conn_default`, "Default database"): its tables live in the **environment schema** of the system
  database (`env_default`), and the connector uses the **system pool** (`ConnectorEnv.systemDb`) instead of its own, so its DDL and
  rows take part in a unit of work (`Services.transaction`) together with the metadata. Its settings are rewritten from the setup
  at every start and cannot be edited.
- **External PostgreSQL databases** (a customer's): an own pool, tables in `settings.schema` (default `public`). The schemas `ab`,
  `env_*`, `pg_*` and `information_schema` are refused so a second connection to the system database cannot reach its tables.

Details:

- Pool: `pg`, `max: 10`, 10 s connect timeout, keep-alive, `application_name=appbuilder`, startup options
  `search_path=pg_catalog,pg_temp` and `TimeZone=UTC` (see `schema.md`). With `ssl` set the pool requires TLS 1.2+ and verifies the
  certificate. Type parsers are per pool: `int8` -> number, `numeric` -> string (converted per column), `date` -> `YYYY-MM-DD`
  (never shifted to local time), `timestamp` (without time zone) read as UTC, `timestamptz` -> Date.
- Everything that reaches SQL text is a validated, double-quoted, schema-qualified identifier or a literal fragment from `sql.ts`;
  every value travels as a `$n` parameter with an explicit cast. Identifier rule `^[A-Za-z_][A-Za-z0-9_]{0,62}$`; names starting with
  `ab_` are refused (403) and hidden from `listSourceTables`.
- DDL generation, the type map and index naming are documented in `schema.md`. Each DDL method runs in one transaction (a savepoint
  inside a unit of work); `alterColumn` converts in SQL with `ALTER COLUMN ... TYPE ... USING ...` (`alterUsing`: text to number
  rounds, `yes/no/true/false/1/0/t/f` to boolean, numbers to text like JavaScript's `String(number)`, dates to `YYYY-MM-DD`, datetimes
  to ISO text in UTC). A failing conversion leaves the column unchanged.
- `ensureSystemColumns` adds the missing system columns of a linked table in one transaction; a missing `id` is filled with UUIDv7
  values in physical row order and gets a unique index.
- Inserts are chunked to stay below PostgreSQL's 65,535 parameters per statement (at most 500 rows); deletes use `id = ANY($1)` in
  chunks of 5,000. Several chunks run in one transaction.
- `listSourceTables` excludes `ab_%` tables and counts rows exactly only when there are 50 tables or fewer (otherwise
  `pg_class.reltuples`).
- **Query v2** (`queryV2(def, { plan, rowFilter, visible, maxUnpagedRows, maxGroups, timeoutMs })`, P0 package D): the validated
  plan becomes one statement (`query-v2.ts`, `buildV2`), run in a short transaction with `SET LOCAL statement_timeout` and
  `extra_float_digits = 1`. The caller's row filter (a v1 `Condition`) is translated by `buildWhere` into the same `WHERE`, so v1
  and v2 lowercase and compare identically (`fold()`). Returns typed rows plus the type of each output column, the count and the
  next cursor. Statement shapes, the sort-key trick and the limits: `query-v2.md` sections 12-13.
- **Indexes for Query v2** (created with the table and by column changes; names per schema): `ix_<t>_natural` on
  `(COALESCE("createdOn", '-infinity'), id COLLATE "C")`; `kx_<t>_<col>` on `(sort key, natural)` for lookup, unique and
  **indexed** columns; `kd_<t>_<col>` (descending key) and, for text with `pg_trgm` available, `tg_<t>_<col>` (GIN trigram) for indexed
  columns. `ColumnDef.indexed` changes go through `alterColumn` (indexes dropped and created in its transaction). Managed tables
  created before package D get the natural index in the background (`CREATE INDEX CONCURRENTLY`) on their first v2 query. The
  connector installs `pg_trgm` (`CREATE EXTENSION IF NOT EXISTS pg_trgm`, in a savepoint) when the first indexed text column needs it
  and the database user may; otherwise it logs once and searches scan.

### Parity with the reference

The PostgreSQL translation is held to the reference by the `describe('parity: SQL vs evaluateCondition')` block in
`/home/claude/appbuilder-demo/server/connectors/postgres/postgres.integration.test.ts`: 14 rows with nasty values (blank vs `''`
vs `NULL`, `%`, `_`, `!` and backslash, numeric-looking text in several notations (` 42 `, `1e3`, `+7`, `1.`, `Infinity`), non-ASCII
case pairs (`Ärger`, `İstanbul`, final sigma `ΣΑΣ`, `straße`), dates and datetimes at millisecond precision, tiny and huge decimals,
mixed-case choices) and **162 named conditions**, each run through `connector.select` (SQL), through `evaluateCondition`, and again
on a managed table (exact id comparison); the id sets must be equal, and so must the counts. Further blocks compare
`orderBy`/`skip`/`top` sequences with `applyQuery` (blanks last in both directions, text sorted by code point, ties on the id
tie-breaker), and repeat every ASCII condition with the non-ICU lowercasing. **When you change `sql.ts` or `condition.ts`, extend this
list** with the case that motivated the change.

How `sql.ts` matches the reference:

- **Decided in JavaScript where the reference decides on the value**: its type, whether text is numeric-looking (the reference's
  own test `x.trim() !== '' && !isNaN(Number(x))` on the lowercased value), `Date.parse`, booleans against non-booleans. Values that
  can never compare equal become `FALSE`/`TRUE` constants; values outside PostgreSQL's date range become "below/above every cell".
- **Text** is compared on lowercased forms: the cell with `lower((col) COLLATE "und-x-icu")` when the server has the ICU root
  collation (detected once per connector; the official PostgreSQL builds for Windows, Debian/Ubuntu and the Docker image have it),
  otherwise with `lower(col)`; the value is lowercased in JavaScript. Ordering adds `COLLATE "C"` (code point order). No `LIKE`
  and no `ILIKE`: `contains`/`startsWith`/`endsWith` are `strpos`, `starts_with` and `right(...) =` on the lowercased string form, so
  `%`, `_` and `\` need no escaping.
- **String form** for `contains` on non-text columns: numbers exactly like JavaScript's `String(number)` (`jsNumberText`: plain digits
  between 1e-6 and 1e21, exponent form outside, `12.5000` reads as `12.5`), booleans `true`/`false`.
- **Blanks**: `''` is blank for text kinds (`col IS NULL OR col = ''`), only `NULL` otherwise; `ne` is `blank OR col <> v`; ordering
  needs a non-blank cell; under `NOT` every leaf is `COALESCE(..., FALSE)`.
- **Numbers**: integer values against `bigint` as `$n::bigint` (index-friendly), fractions as `numeric`; `double precision` and
  `numeric(19,4)` against `float8`/`numeric` parameters.
- **Dates**: a midnight value against a `date` column compares as `date` (uses an index), other instants compare the column at UTC
  midnight with a `timestamptz`.
- **Sort**: `(blank) ASC`, then the value (`NULLIF(lower(col), '') COLLATE "C"` for text, so `''` and `NULL` tie), then the
  `createdOn, id` tie-breaker.
- **id on managed tables**: compared exactly (`"id" = $1`, `"id" = ANY($1)`) with the lowercased value: Appbuilder's ids are
  lowercase UUIDs, so the answer is the same and row lookups use the primary key. Linked tables compare `id` like other text.

Documented differences that remain (each has a test that pins it down):

- `contains`/`startsWith`/`endsWith` on **date and datetime** columns test ISO text (`2024-02-20`, `2024-02-20T12:30:45.123Z`);
  the reference uses `String(Date)`, which depends on the server's time zone.
- **Numeric-looking text** in SQL is decimal notation with at most 250 characters and a two-digit exponent; JavaScript also reads
  `0x10`, `0o7`, `0b1` and larger exponents as numbers (`"0x10" = 16` is true only in the reference).
- **Code points vs code units**: SQL orders by code point, JavaScript by UTF-16 code unit; they differ only for characters above
  U+FFFF compared with U+E000..U+FFFF.
- Without ICU, non-ASCII lowercasing follows the database's `LC_CTYPE` (`C.UTF-8` lowercases ASCII only). Create the database with a
  real locale or keep ICU available.

Compared with the MySQL store (before D14) these behaviours changed: comparison is no longer accent- or width-insensitive and no longer
ignores trailing spaces (`utf8mb4_unicode_ci` and `PAD SPACE`), text ordering is by code point instead of by collation, and
`contains` on numbers uses JavaScript's number formatting. All of these now agree with the reference and with the browser.

### Query v2 on connectors without `queryV2`

MySQL, files and Google Sheets do not implement `queryV2`. `DataService.queryV2` reads at most `QUERY_FALLBACK_ROW_CAP` (5,000) rows
the caller may see through `select` (MySQL pushes the row filter into SQL; files and Sheets apply it in memory), runs the reference
executor (`src/fx/query/reference.ts`; files and Sheets keep file / sheet order as the natural order) and marks the answer
`truncated: true` when more rows exist. The same validation and column security apply. A connector that wants full support implements
`queryV2` (translate the plan, AND the row filter in, return typed rows, count and cursor) and runs the parity corpus against it the
way `server/connectors/postgres/query-v2.integration.test.ts` does.

## MySQL connector (external databases)

Files: `server/connectors/mysql/index.ts` (the connector), `sql.ts` (pure SQL builder, unit-testable), `db.ts` (pool, transactions).
Used to link tables of a customer's MySQL or MariaDB, or to create tables there; never for the system store.

- Pool: `mysql2/promise`, `connectionLimit: 10`, `timezone: 'Z'`, charset `utf8mb4_unicode_ci`, `dateStrings: false`,
  `supportBigNumbers: true`, `multipleStatements: false`, `connectTimeout: 10000`. With `ssl` set the pool requires TLS 1.2+ and
  verifies the certificate (`rejectUnauthorized`).
- Everything that reaches SQL text is a validated, backtick-quoted identifier or a literal fragment from `sql.ts`; every value
  travels as a `?` parameter. Identifier rule `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; names starting with `ab_` are refused (403).
- Type map (`sqlType`): `VARCHAR(255)` for text kinds, `VARCHAR(1024)`/`VARCHAR(768)` for urls, `MEDIUMTEXT`, `BIGINT`, `DOUBLE`,
  `DECIMAL(19,4)`, `TINYINT(1)`, `DATE`, `DATETIME(3)` (UTC), `CHAR(36)` for ids and lookups; tables `ENGINE=InnoDB DEFAULT
  CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`; indexes `ix_owner`, `ix_<col>`, `uq_<col>` (per table in MySQL). The SQL stays
  portable to MySQL 5.7+/8.x and MariaDB 10.4+ (no JSON type, no CHECK, no CTEs, `VALUES()` in `ON DUPLICATE KEY`).
- `listSourceTables` excludes `ab_%` tables and computes exact row counts only when there are 50 tables or fewer.
- Parity: the same kind of test in `/home/claude/appbuilder-demo/server/connectors/mysql/mysql.integration.test.ts` (100 conditions).
  The translation puts `COLLATE utf8mb4_unicode_ci` on every string literal, treats `''` as blank for text, escapes `%`, `_` and `!`
  for `LIKE ... ESCAPE '!'`, and wraps leaves in `COALESCE(..., 0)` under `NOT`. Remaining differences (see the header of its
  `sql.ts`): accent and width insensitivity and `PAD SPACE` in `eq`/`in`/`ne`, collation ordering for `lt/le/gt/ge` on text, `contains`
  on date columns compares the SQL text form. These only affect tables in an external MySQL.

## Files connector

`server/connectors/files/{index,cells,formats}.ts`. A data file (CSV, XLSX or JSON) is copied into
`workspace/files/<fileId>/data.<csv|xlsx|json>` with a `meta.json`; the original is never touched. One sheet is one table; the table
source is `<fileId>/<sheet>`.

- Sheets are held in memory and re-read when the file's mtime or size changes. Writes are debounced (300 ms), serialised per file,
  and replace the file atomically (temp file plus rename). `flushFiles()` waits for pending writes; the server calls it on shutdown.
- A module-level store is shared per files folder, so several connector instances see the same data.
- Type inference (`cells.ts`) scans the sheet and assigns `text`, `number`, `decimal`, `boolean`, `date`, `datetime`, `email`, etc.;
  identifiers are made from headers (`toIdentifier`: `"Sales orders (2024)"` becomes `SalesOrders2024`).
- Module API used by the routes (`server/routes/meta/files.ts`): `inspectDataFile`, `storeDataFile`, `replaceDataFile`,
  `readDataFile`, `removeDataFile`, `flushFiles`.
- `dropTable` refuses to remove the last sheet of a file ("remove the file instead").
- Files are **device-only** (decision D8): the connection has scope `device` and is left out of a hosted deployment unless a file is
  packaged into a solution. `modifiedSinceImport` records that apps edited rows since the file was added.
- Not part of a unit of work: a failed import undoes its file changes with compensating code.

## Google Sheets connector

`server/connectors/gsheets/index.ts` (class `GSheets`). One tab is one table; row 1 holds column names; rows are located by the `id`
column (`ensureIdColumn` adds it).

- No Google packages. The service-account JSON key is parsed by `parseServiceAccountKey` (error messages never contain key text), a
  signed RS256 JWT is built with `node:crypto` (`buildJwtAssertion`) and exchanged for a bearer token; Sheets API v4 calls go
  through the injected `env.fetch`. Scope `https://www.googleapis.com/auth/spreadsheets`.
- A 15 s read cache per spreadsheet, writes serialised per spreadsheet, up to 4 attempts with exponential backoff on 429 and 5xx
  (`Retry-After` honoured, capped at 30 s).
- Writes use `valueInputOption=RAW`, so nothing a user types can become a formula. Dates are written as ISO text and read back from
  ISO text or serial numbers (`serialToDate`).
- Exported helpers used by tests: `parseSpreadsheetId` (accepts a URL or an id), `parseServiceAccountKey`, `buildJwtAssertion`,
  `serialToDate`, `ensureIdColumn`.
- Settings: `settings.spreadsheetId` (an id or a URL), the service-account key as the connection secret.

## Registering a connector

1. Create `server/connectors/<kind>/index.ts` exporting a `ConnectorFactory` (see `createPostgresConnector`,
   `createMySqlConnector`, `createFilesConnector`, `createGSheetsConnector`). Follow the server TypeScript rules: relative imports
   with the `.ts` extension, `import type` for types, no enums, no runtime import of `@/...` (see `architecture.md`).
2. Add the kind to `ConnectorKind` in `/home/claude/appbuilder-demo/src/platform/contracts.ts` if it is not there.
3. Register it in `/home/claude/appbuilder-demo/server/connectors/index.ts`:

   ```ts
   manager.register('postgres', createPostgresConnector)
   manager.register('mysql', createMySqlConnector)
   manager.register('files', createFilesConnector)
   manager.register('gsheets', createGSheetsConnector)
   ```

   An unknown kind makes `ConnectionManager.get` answer 503 `unavailable`.
4. Allow the kind in `POST /connections` validation (`server/routes/meta/connections.ts`; today `postgres`, `mysql`, `files`,
   `gsheets`) and give the Connections screen a form for its settings (`/home/claude/appbuilder-demo/src/portal/Connections.tsx`).
5. Add tests (below) and update this page and `schema.md` if the connector stores anything in the system tables.

## Testing a connector

- **Fakes.** Connectors take everything external through injection: `ConnectorEnv.fetch` for HTTP, directories for files. The
  Google tests (`gsheets.test.ts`) use a `FakeGoogle` that implements the parts of the Sheets API the connector calls and is passed
  as `env.fetch`; no network is used. The files tests (`files.test.ts`) work in a temp directory. Unit tests of the SQL builders
  (`postgres/sql.test.ts`, `mysql/sql.test.ts`) need no database at all because `sql.ts` is pure.
- **Route and service tests** use the in-memory `FakeMetaStore` harness `/home/claude/appbuilder-demo/server/routes/meta/testing.ts`
  together with the real `SecurityEngine`, `DataService` and `ConnectionManager`, and an in-memory connector registered for
  `postgres` and `mysql`.
- **Parity.** A pushdown connector must be added to a parity test like the PostgreSQL one: same dataset, same condition list,
  compare with `evaluateCondition`. A non-pushdown connector should use `applyQuery`/`evaluateCondition` directly, which makes
  parity automatic.
- **Integration** tests run against a real PostgreSQL when `APPBUILDER_TEST_DB` is set and against MySQL/MariaDB when
  `APPBUILDER_TEST_MYSQL` is set (see `testing.md`).

## Connector actions

P1 package D, decision D26. Flows (package A), table after-events (`RunConnector`) and the "Test action" form call
**actions** of a connection: named operations with JSON Schemas. Two action connectors ship: `http` (generic REST, custom
actions, OpenAPI import) and `email` (send through the install's relay). Table connectors offer no actions yet (flows use
data steps; no raw SQL from makers in this phase). Maker view: [connections and actions](../guide/maker/connections-and-actions.md);
administrator view: [connections](../admin/connections.md); generated list of built-in actions:
[reference/connector-actions.md](../reference/connector-actions.md).

| File | What |
| --- | --- |
| `server/core/actions/contracts.ts` | Shared with package A: `ActionDef`, `ActionResult`, `ActionError`, `ActionRunOptions`, `ActionsService`, `VerifiedWebhookPayload`, `FlowWebhookTarget`, `JsonSchema` |
| `server/core/actions/service.ts` | `createActionsService`: providers, `run` pipeline, grants, custom action store, activity, breaker, rate limit, idempotency, retention job |
| `server/core/actions/schema.ts` | JSON Schema subset validator, `checkSchema` for maker schemas, `inferSchema` from a sample |
| `server/core/actions/outbound.ts` | `safeRequest`: allow-list, address policy, pinned DNS answers, redirects, limits, TLS; `setLookupForTests` |
| `server/core/actions/template.ts` | `{{input}}` templates for paths (encoded segments), text, headers, JSON bodies |
| `server/core/actions/http.ts`, `email.ts` | The two providers; `builtin-defs.ts` holds their action definitions (pure data, used by `npm run docs:gen`) |
| `server/core/actions/openapi.ts` | OpenAPI 3 import (subset listed in its header) |
| `server/core/actions/webhooks.ts` | Inbound webhooks: management routes, the verified `POST /hooks/:env/:flowId/:token` |
| `server/core/actions/routes.ts`, `wiring.ts` | HTTP API; wiring from `app.ts` (also the `RunConnector` sink, notification delivery, reports) |
| `server/core/actions/suppressions.ts`, `solution-parts.ts` | Mail suppression list; custom actions in solution packages |
| `src/portal/ConnectionActions.tsx`, `actionsApi.ts` | Connection details: Tables / Actions / Access / Activity, the schema form, custom action form, OpenAPI import |

### The contract

```ts
interface ActionDef { id; title; description; inputs: JsonSchema; outputs: JsonSchema; idempotent: boolean;
                      sideEffect: 'none' | 'external'; timeoutMs: number; origin?: 'builtin' | 'custom' }
type ActionResult = { ok: true; output; runId?; durationMs?; replayed? }
                  | { ok: false; error: { code, message, retryable, status? }; runId?; durationMs? }
services.actions.kinds()                                  // action-capable kinds + built-in actions
services.actions.list(kindOrConnectionId)                 // kind: built-in; connection: built-in + custom
services.actions.describe(connectionId, actionId)
services.actions.run(env, connectionId, actionId, inputs, identity /* UserContext | null */,
                     { idempotencyKey?, correlationId?, timeoutMs?, source?, signal? })
services.actions.canUse(user, id) / canManage(user, id) / assertCanUse(user, id) / state(env, id)
```

`run` never throws for action problems: it answers `{ ok: false, error }` with a code from the table in the reference
page (`retryable` tells a flow whether to retry with backoff). It does **not** check the identity's "use" right: callers
check it when a maker attaches the connection (`assertCanUse` at save time: table events in `kernel-routes.ts`, flows in
package A). The identity is what the action runs as (which attachments the email action may open; the activity entry).

### The run pipeline (in order)

1. Connection (404 `not_found`), provider, action (built-in first, then custom by id, case-insensitive).
2. Inputs: at most 1 MB of JSON (15 MB for email, because of attachments), validated against `inputs` with defaults filled
   (`invalid_input`, never retried, nothing sent).
3. Circuit breaker per environment and connection: 5 failures in a row that a retry could fix (network, timeout, 5xx,
   408, 429) open it for 30 s, doubling to 5 minutes; then one trial call (half-open). `circuit_open` is retryable. The
   state shows on the Actions tab and at `GET /connections/:id/state`; managers resume calls (`POST .../state/reset`).
4. Rate limit (token bucket, `perMinute`, default 60) and concurrency cap (`maxConcurrent`, default 4; a call waits up to
   5 s for a slot). Both answer `rate_limited` (retryable).
5. Idempotency (only `idempotent: false` and `sideEffect: 'external'`, with a key): `ab_action_idempotency` keyed by the
   SHA-256 of environment, connection, action and key. A finished key returns the stored result with `replayed: true` (24
   hours); a running one answers `in_progress` unless it is older than twice the time limit plus 10 s (taken over). A
   retryable failure deletes the key so the retry runs; success and permanent failures are stored. HTTP actions also send
   the key as `Idempotency-Key`.
6. The provider runs with a deadline (the smallest of the caller's, the action's and the connection's limit) and an abort
   signal. Output: at most 1 MB of JSON (`too_large`).
7. Redaction: every secret value of the connection, plus its URL-encoded and base64 forms (and the basic-auth token), is
   replaced by `[hidden]` in the output, the error message and the activity details.
8. Activity: one `ab_action_runs` row (who, source such as `event:<id>`, `flow:<id>` or `test`, status, error code,
   message, HTTP status, duration, replayed, details such as method, host, path or recipient count). Never inputs, outputs
   or secrets. Retention 90 days (`actions.retention`, built-in schedule).

### Writing an action connector

1. Implement `ActionProvider` (`service.ts`): `kind`, `label`, `description`, `tables`, `builtin()` (the action
   definitions, ideally in `builtin-defs.ts` so the reference generator needs no Node modules), `checkSettings(settings,
   secret)` (create and edit), `test(...)` (the Test button), `invoke(call)`, `secrets(connection)` (every value to redact)
   and `limits(connection)`.
2. `invoke` gets `ProviderCall`: validated `inputs`, the decrypted connection, the identity, `signal`, `timeoutMs`, a
   per-connection `cache` (dropped when settings or secret change: DNS pins, OAuth tokens) and `note(details)` for the
   activity row. Throw `OutboundError(code, message, retryable, status?)`; anything else becomes `internal`.
3. Any network access goes through `safeRequest` with the connection's policy (`policyOf` in `http.ts`), never `fetch`.
4. Register it in `wiring.ts`, add the kind to `ConnectorKind` (`src/platform/contracts.ts`), `KINDS` / `ACTION_KINDS` in
   `server/routes/meta/connections.ts`, `PACKAGE_CONNECTORS` (`solution-parts.ts`), `CONNECTOR_INFO` and the dialog form
   in the Connections page, and run `npm run docs:gen`.

### HTTP connector

Settings: `baseUrl`, `allowedHosts` (default: the base URL's host; `*`, schemes, ports and paths refused),
`authMode` (`none`, `apiKey` with `apiKeyIn` header|query and `apiKeyName`, `basic` with `username`, `bearer`,
`oauth2cc` with `tokenUrl`, `clientId`, `scope`, `audience`, `clientAuth` body|basic), `defaultHeaders` (JSON),
`allowPrivateNetwork`, `verifyTls`, `maxRedirects` (3, at most 10), `timeoutMs` (30 s, at most 120 s), `maxResponseKB`
(5 MB, at most 20 MB), `perMinute`, `maxConcurrent`. Secret (sealed): one JSON object `{ apiKey?, password?, token?,
clientSecret?, headers?: { name: value } }`; replacing it replaces every part.

OAuth 2.0 **client credentials**: the token is fetched from `tokenUrl` (on the allow-list, no redirects), cached in the
connection's cache until 30 s before `expires_in`, one fetch at a time; a 401 from the API fetches a new token once and
repeats the call. **Authorization code with user consent is not supported** (needs per-user connections and a redirect
endpoint; later phase).

`request` inputs: `method`, `path` (relative to the base URL, `{{name}}` placeholders filled from `pathParams` as encoded
segments, `..` cannot climb above the base path; or an absolute URL on an allowed host), `query`, `headers` (hop-by-hop,
`Host`, `Content-Length` refused), `bodyType` (json, text, form), `body`, `expectStatus` (default any 2xx). Output:
`{ status, headers (no cookies), body (JSON, text, or base64 with bodyEncoding), url (key-like query values hidden) }`.

Custom actions (`HttpActionSpec` in `http.ts`): `method`, `path` template, `params` (inputs sent as query or header, left out
when missing), fixed `query`/`headers` templates, `bodyFields` (inputs as JSON fields), `bodyInput` (one input is the
body; OpenAPI), `bodyTemplate`, `expectStatus`, `outputPath` (return part of the answer), `sample` (the output schema is
inferred from it). `checkCustomAction` validates them (schemas with `checkSchema`, placeholders must be inputs). They
return the response body (or the `outputPath` part), not the status envelope.

### Outbound policy for actions

`outbound.ts`, tested in `actions.test.ts` against local servers:

| Rule | Test |
| --- | --- |
| http/https only; no credentials in URLs | "calls an allowed host and refuses other hosts, schemes and credentials in URLs" |
| Host allow-list on every hop, redirects re-checked, https -> http refused, at most `maxRedirects` | "redirects: re-checked at every hop" |
| Link-local, unspecified, multicast, broadcast and metadata names always refused; loopback and private only with `allowPrivateNetwork` (never with `APPBUILDER_OUTBOUND_PRIVATE=deny`) | "refuses private and loopback addresses ..." |
| A name is refused when ANY address of its answer is refused; the answer is pinned 60 s per connection and host and the socket connects to it (`lookup` hook) | "DNS rebinding: ..." (custom lookup hook) and the integration test "DNS rebinding" |
| Sensitive headers (Authorization, Cookie, API-key and secret headers) dropped on a redirect to another host | "redirects: ..." |
| Total deadline across hops; response size from Content-Length, while streaming and after gzip/deflate/br decoding | "timeouts, response size (also unpacked) and TLS verification" |
| TLS 1.2+, certificate verified unless `verifyTls: false` | same |

### Email connector

`send`: `to` (one or a list), `cc`, `bcc`, `subject`, `text`, `html` (sanitised like rich text; text made from it when
missing), `replyTo`, `attachments` (at most 10 and 10 MB: `attachmentId` the run-as identity can open, checked like the
download route, or generated `{ fileName, text | base64, contentType }`). Settings: `fromName`, `replyTo`, `perHour`,
`perDay`. Sent through the mail service (`identity/mail.ts`, queued job with retries; messages above 150 KB sealed are kept
in `ab.mail_log.sealed_message` instead of the job payload). Suppressed addresses are dropped (`denied` when none is left);
when only blind copies are left, each gets its own message. Environment limits count recipients over all Email
connections: `APPBUILDER_EMAIL_PER_HOUR` (200) and `APPBUILDER_EMAIL_PER_DAY` (1000); a connection may set lower ones.
`limit` is retryable.

### Grants

`ab_connection_access (connection_id, principal_kind role|user, principal_id, level use|manage)`. Administrators always
manage. "Use": list and test actions, attach the connection to events and flows, see one's own activity. "Manage": also
custom actions, OpenAPI import, everybody's activity, resume calls. Only administrators change grants and connection
settings; nobody reads secrets (`GET /connections/:id/state` lists which secret parts are set, never values).

### RunConnector in table events

`TableEventDef.connections` lists the connection ids attached to an after-event (at most 20; before-events and validation
rules cannot have any: external calls never run inside a write). Saving an event that adds a connection needs "use" on it
(`kernel-routes.ts`). At run time the sink in `wiring.ts` finds the connection by id or name, refuses one that is not
attached (permanent failure in the run log), converts the inputs from formula values to JSON and calls
`services.actions.run` as the event's identity with the idempotency key `<job id>:c<n>` and source `event:<id>`. A
retryable error fails the job for a retry; a permanent one is logged.

### Webhooks in

See [webhooks for makers](../guide/maker/webhooks.md) and [webhook security](../admin/webhook-security.md). The route is
registered with `auth: 'none', raw: true, streamBody: true, csrfExempt: true`: the token is checked before the body is read
(`ctx.readBody(limit)`), then the signature, replay, content type, and finally `services.flows.triggerWebhook(env,
flowId, payload)`. `RouteOptions.csrfExempt` only applies to `auth: 'none'` routes (router.ts).

### Tests

`server/core/actions/actions.test.ts` (no database: schema, templates, outbound policy, HTTP provider auth modes and OAuth,
custom actions, webhook signatures, OpenAPI import of two real public documents in `testdata/`, notification rules,
digest scheduling, report CSV) and `actions.integration.test.ts` (PostgreSQL: use vs manage, secrets never in answers,
activity, audit or job payloads, custom actions and OpenAPI import, solutions, idempotency, circuit breaker, rate limit,
DNS rebinding, the Email connector, RunConnector, the webhook verification matrix, notification delivery and reports).
Headless run with screenshots: `scripts/docs-shots/actions.mjs`.
