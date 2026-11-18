# Database schema

Appbuilder keeps everything in one **PostgreSQL** database (15 or newer; 17 is what we install, CI and the sandbox run 16).
Decision D14 in `/home/claude/appbuilder-demo/docs/decisions.md` records the move from MySQL. The database holds:

1. **Schema `ab`**: install-wide objects (settings, users, sessions, the environment registry, the licence placeholder).
2. **One schema per environment**, `env_<id>`. Today there is exactly one, `env_default`. It holds the environment's
   metadata tables (`ab_roles`, `ab_tables`, `ab_apps`, `ab_audit`, ...) **and** the data tables of the default connection
   (`t_orders`, `t_contacts`, ...).

Defined in `/home/claude/appbuilder-demo/server/core/meta-store.ts` (`INSTALL_DDL`, `environmentDdl()`, `SCHEMA_VERSION = 4`)
and, for data tables, `/home/claude/appbuilder-demo/server/connectors/postgres/sql.ts` (`createTableSql`, `sqlType`).

Everything not on this page is not stored in the database: the workspace folder holds `server.json` (database connection,
password sealed), `.secret-key` (when `APPBUILDER_SECRET_KEY` is not set), `attachments/` (file bytes) and `files/` (data files).
See `architecture.md`.

## Environments, schemas and how a request finds its schema

- A request carries an **environment id**. `resolveEnvironment(req)` in `/home/claude/appbuilder-demo/server/core/env-context.ts`
  decides it (today it always answers `default`); `environmentSchema(id)` turns it into the schema name `env_<id>` (the id is
  validated: `^[a-z][a-z0-9_]{0,39}$`, so the schema name is always a safe identifier).
- The router runs every handler inside `runInEnvironment(id, ...)` (Node's `AsyncLocalStorage`), and `ctx.environmentId` carries the
  id. The MetaStore, the security cache, the connection cache and the default connector read `currentEnvironment()`; code that runs
  outside a request (boot, timers, tests) works in the default environment.
- Caches are keyed by environment id: the security engine keeps one roles/tables cache per environment, the ConnectionManager one
  connector instance per `<environment>:<connection>`.
- `ab.environments` is the registry (`id`, `name`, `schema_name`, `type`, `built_in`, `created_on`). `migrate()` creates the built-in
  `default` row and every registered environment schema. P0 package E adds create/switch/delete on top of `migrateEnvironment()`.

### Fully qualified names, never `search_path`

Every statement names its tables **fully qualified**: `"ab"."users"`, `"env_default"."ab_tables"`, `"env_default"."t_orders"`. The
schema part comes from the environment resolver (MetaStore: `tableName()` and the `E()`/`A()` helpers; connector: the `Dialect`
passed to `sql.ts`), never from `search_path`. We chose this over `SET LOCAL search_path` in a transaction because:

- **Nothing can leak between requests.** Pooled connections carry no per-request state at all, so a connection returned to the pool
  in any state cannot make the next request see another environment. With `SET LOCAL` every statement would have to run inside a
  transaction (three extra round trips per single read) and one forgotten `SET`, a plain `SET`, or a code path outside a transaction
  would silently read the wrong schema.
- **Mistakes fail loudly.** Every pooled connection starts with the startup options `search_path=pg_catalog,pg_temp` and
  `TimeZone=UTC` (`SESSION_OPTIONS` in `/home/claude/appbuilder-demo/server/connectors/postgres/db.ts`), so an unqualified table name
  is an error (`42P01`) instead of resolving to `public` or another schema. It also means a table or function someone creates in
  `public` can never shadow a built-in function.
- Logs, `EXPLAIN` output and `pg_dump --schema=env_x` all name the real schema.

The integration test `postgres connector > SqlDb` checks the startup settings on every pooled connection, that a `SET` made inside a
rolled-back or `SET LOCAL` transaction never reaches the next user of the connection, and that unqualified names fail.

## Transactions and units of work

- `SqlDb.tx(fn)` runs `fn` on one pooled client inside `BEGIN`/`COMMIT` (`ROLLBACK` when `fn` throws). A nested `tx()` is a
  `SAVEPOINT`, so a failing inner block rolls back only its own statements.
- While `tx()` runs, the pool-level `SqlDb` **joins** it for code in the same async context (`AsyncLocalStorage`). That is how a
  **unit of work** works: `Services.transaction(fn)` opens one transaction on the system pool, and everything inside it, MetaStore
  writes and the default connector's DDL and row statements (it uses the same pool, `ConnectorEnv.systemDb`), lands in that one
  transaction. Such *ambient* statements are each wrapped in a savepoint: a failing statement that the caller catches does not abort
  the transaction (PostgreSQL otherwise refuses every later statement with `25P02`). Statements of one transaction are serialised on
  its client.
- PostgreSQL DDL is transactional (`CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`): these routes run as one unit of work, so a failure
  leaves **nothing** behind (no physical table, column, row, definition, role privilege or audit entry):
  `POST /tables`, `POST /tables/from-csv`, `PATCH /tables/:id`, `DELETE /tables/:id`, `POST|PATCH|DELETE /tables/:id/columns...`,
  `POST /tables/:id/move`, `POST /connections/:id/link`, `POST /apps/import`, `POST /solutions/import`. Their compensating undo code
  stays for the parts a database transaction cannot cover: other connectors (files, Google Sheets, external databases) and files in
  the workspace folder. `/home/claude/appbuilder-demo/server/core/transactions.integration.test.ts` proves it with the undo code
  switched off.
- Inside a unit of work the new tables are invisible to other connections until `COMMIT`; the security cache is dropped afterwards
  (it may have been filled with rows that were rolled back).
- Each connector DDL method (`createTable`, `alterColumn`, ...) is itself one transaction (a savepoint inside a unit of work).

## Migrations

`migrate()` is idempotent. It first reads `ab.settings` `schemaVersion` (0 when schema `ab` does not exist):

- **above `SCHEMA_VERSION`**: `SchemaTooNewError` before any statement runs (downgrade guard: the server keeps the database closed,
  reports `setup.incompatible` and does not retry);
- **1 to 3**: those were the MySQL system store. There is no migration from MySQL (decision D14); such a database is refused
  (`UnsuitableDatabaseError`, "use an empty database");
- the database encoding must be `UTF8`, otherwise it is refused before anything is created.

Then, in **one transaction** holding `pg_advisory_xact_lock(hashtext('appbuilder.migrate'))` (two servers starting together wait for
each other), it runs `INSTALL_DDL`, registers and creates `env_default`, completes every other registered environment schema, and
writes `schemaVersion`. The summary `{ from, to, steps }` is logged and written to the audit log as `schema.migrate` when something
changed. Future upgrade steps go into that transaction, ordered by version.

## Types and conventions

| Kind of value | PostgreSQL type | Notes |
| --- | --- | --- |
| ids (users, roles, tables, apps, rows) | `text` | generated by the server: `uid()`, row ids UUIDv7 from `rowUid()` (`server/core/util.ts`) |
| timestamps | `timestamptz` (`timestamptz(3)` in data tables) | the API carries ISO strings in UTC |
| metadata documents | `jsonb` | role apps, privileges' columns and row filters, table and app definitions, connection settings, solution components, data file table ids, audit details |
| flags | `boolean` | |
| currency | `numeric(19,4)` | read back as a JavaScript number |
| names that must be unique | unique index on `lower(name)` | case-insensitive like the MySQL `_ci` collations were |

Notes on `jsonb`: PostgreSQL normalises key order (shorter keys first) and refuses the NUL character (`\u0000`). The audit writer
strips NUL characters; a table or app definition containing one is refused with 422. Lists are ordered by `lower(name) COLLATE "C"`
(code point order), so the order does not depend on the database locale. Metadata index names start with `ab_` (index names are
per schema in PostgreSQL; user tables can never start with `ab_`, see below). There are no foreign keys: integrity is kept by the
service layer, as before.

## Schema `ab` (install-wide)

### `ab.settings`: key/value

| Column | Type | Notes |
| --- | --- | --- |
| `k` | `text` | primary key. `schemaVersion` |
| `v` | `text` | |

### `ab.users`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` | primary key |
| `name` | `text NOT NULL` | |
| `email` | `text NOT NULL` | unique index `ab_ux_users_email`; always trimmed lowercase (the MetaStore write path) |
| `password_hash` | `text` | `scrypt$32768$8$1$<salt>$<hash>`; NULL = no password set |
| `status` | `text NOT NULL DEFAULT 'active'` | `active` or `disabled` |
| `must_change_password` | `boolean NOT NULL DEFAULT false` | true after an administrator set the password |
| `created_on` | `timestamptz NOT NULL` | |
| `last_login` | `timestamptz` | |

Users are install-wide; their **roles are per environment** (`ab_user_roles` in each environment schema). Deleting a user removes
their role assignments in every registered environment and their sessions.

### `ab.sessions`

| Column | Type | Notes |
| --- | --- | --- |
| `id_hash` | `text` | primary key; SHA-256 hex of the cookie token (the token itself is never stored) |
| `user_id` | `text NOT NULL` | index `ab_ix_sessions_user` |
| `created_on`, `expires_on`, `last_seen` | `timestamptz NOT NULL` | index `ab_ix_sessions_expires` on `expires_on` |
| `user_agent` | `text` | at most 255 characters |

Expired rows are purged hourly by the server.

### `ab.environments`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` | primary key (`default`) |
| `name` | `text NOT NULL` | `Default` |
| `schema_name` | `text NOT NULL UNIQUE` | `env_default` |
| `type` | `text NOT NULL DEFAULT 'production'` | `production`, `sandbox`, `developer` |
| `built_in` | `boolean NOT NULL DEFAULT false` | |
| `created_on` | `timestamptz NOT NULL` | |

### `ab.licence`

Placeholder for the signed licence file (`docs/plan/master-plan.md` section 9): at most one row (`id smallint` primary key,
`CHECK (id = 1)`), `document jsonb`, `installed_on timestamptz`. Nothing reads it yet.

## Environment schema `env_<id>`: metadata tables

### `ab_roles`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` | primary key. Built-in: `role_admin`, `role_maker`, `role_viewer` |
| `name` | `text NOT NULL` | unique `ab_ux_roles_name` on `lower(name)` |
| `description` | `text` | |
| `is_admin`, `is_maker` | `boolean NOT NULL DEFAULT false` | |
| `apps` | `jsonb` | `"all"` or an array of app ids |

### `ab_user_roles`

`user_id text`, `role_id text`, primary key `(user_id, role_id)`, index `ab_ix_user_roles_role`.

### `ab_role_tables`: one row per role and table (the privilege matrix)

| Column | Type | Notes |
| --- | --- | --- |
| `role_id`, `table_id` | `text` | primary key; index `ab_ix_role_tables_table` |
| `can_create` | `boolean NOT NULL DEFAULT false` | |
| `read_scope`, `update_scope`, `delete_scope` | `text NOT NULL DEFAULT 'none'` | `none`, `own`, `all` |
| `columns` | `jsonb` | map column name to `none`/`read`/`update` (CLS) |
| `row_filter` | `jsonb` | array of `RowCondition` (RLS) |

### `ab_tables`: table definitions (the catalogue)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` | primary key |
| `name` | `text NOT NULL` | identifier used in formulas; unique `ab_ux_tables_name` on `lower(name)`; lookups by name are case-insensitive |
| `connection_id` | `text` | |
| `source` | `text` | physical name in the connection (table, `<fileId>/<sheet>`, sheet tab) |
| `def` | `jsonb NOT NULL` | `TableDef` (columns, display names, primary column, origin, `managed`, `missingSystem`, `readOnly`) |
| `created_on`, `modified_on` | `timestamptz NOT NULL` | |

### `ab_apps`

`id text` primary key, `name text` (unique on `lower(name)`), `description text`, `width`/`height integer` (default 1920/1080),
`definition jsonb NOT NULL` (the `AppDef`, see `architecture.md`), `created_on`/`modified_on timestamptz`, `modified_by text`.

### `ab_connections`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` | primary key. Built-in: `conn_default` (postgres, the system database), `conn_files` (files) |
| `name` | `text NOT NULL` | unique on `lower(name)` |
| `connector` | `text NOT NULL` | `postgres`, `mysql`, `files`, `gsheets` |
| `settings` | `jsonb` | non-secret settings (`host`, `port`, `database`, `user`, `ssl`, `schema`, `spreadsheetId`, ...) |
| `secret_sealed` | `text` | `v1:<iv>:<tag>:<ciphertext>` AES-256-GCM |
| `status` | `text NOT NULL DEFAULT 'not-configured'` | `connected`, `error`, `not-configured` |
| `last_error` | `text` | |
| `is_default` | `boolean NOT NULL DEFAULT false` | exactly one postgres connection is the default store for new tables |
| `scope` | `text NOT NULL DEFAULT 'server'` | `device` for the files connection |
| `created_on`, `modified_on` | `timestamptz NOT NULL` | |

The key for `secret_sealed` comes from `APPBUILDER_SECRET_KEY` (64 hex characters) or from `workspace/.secret-key` (mode 0600,
created on first use). Losing the key makes stored secrets unreadable; there is no recovery. `conn_default` is rewritten from
`server.json` / `APPBUILDER_DB_*` at every start; its tables live in the environment schema of the system database (see below).

### `ab_solutions`

`id text` primary key, `name text` (unique on `lower(name)`), `display_name text NOT NULL`, `publisher text`, `version text`,
`description text`, `components jsonb` (array of `{ kind, id }`), `created_on`/`modified_on timestamptz`.

### `ab_data_files`: files managed by the files connector

`id text` primary key, `connection_id text NOT NULL`, `file_name text NOT NULL`, `original_name text`, `kind text NOT NULL`
(`csv`, `xlsx`, `json`), `size_bytes bigint`, `checksum text`, `storage_key text`, `imported_on timestamptz NOT NULL`,
`table_ids jsonb` (array of table ids), `modified_since_import boolean NOT NULL DEFAULT false`.

### `ab_attachments`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` | primary key (`att_...`) |
| `table_id`, `col`, `row_id` | `text NOT NULL` | index `ab_ix_attachments_row (table_id, row_id)` (`column` is a reserved word, hence `col`) |
| `file_name`, `mime`, `sha256`, `storage_key` | `text NOT NULL` | file on disk: `workspace/attachments/<key[0..1]>/<key>` |
| `size_bytes` | `bigint NOT NULL` | |
| `created_by` | `text` | |
| `created_on` | `timestamptz NOT NULL` | index `ab_ix_attachments_created` (orphan sweep) |

### `ab_counters`

`k text` primary key (`<tableId>:<column>` for autonumber), `v bigint NOT NULL` (last number issued). `nextCounter` is one atomic
statement: `INSERT ... ON CONFLICT (k) DO UPDATE SET v = c.v + 1 RETURNING v`.

### `ab_audit`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigint GENERATED ALWAYS AS IDENTITY` | primary key |
| `at` | `timestamptz NOT NULL` | index `ab_ix_audit_at` |
| `user_id` | `text` | |
| `action` | `text NOT NULL` | e.g. `auth.login`, `table.create`, `role.create`; index `ab_ix_audit_action` |
| `table_id`, `row_id` | `text` | |
| `details` | `jsonb` | at most 60,000 characters of JSON (longer details are kept as a truncated JSON string). Never holds passwords |

The audit log is per environment (sign-ins of install-wide users are written to the environment the request ran in).

## Data tables (default connection, PostgreSQL)

A table created through the API on the default connection becomes the physical table `"env_<id>"."<source>"`, where `source` is
`def.source` or `t_<lowercase name>`. `pickSource` in `/home/claude/appbuilder-demo/server/routes/meta/tables-core.ts` de-duplicates
with `_2`, `_3`. Identifiers: `^[A-Za-z_][A-Za-z0-9_]{0,62}$`, always double-quoted (so `createdOn` keeps its case). **Any name
starting with `ab_` is refused** (403): the metadata tables are not reachable through a connector, and `listSourceTables` hides them.

### System columns (every table)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text NOT NULL` | primary key; a UUIDv7 (lowercase) |
| `createdOn`, `modifiedOn` | `timestamptz(3)` | |
| `createdBy`, `owner` | `text` | user ids; `owner` has an index and drives the `own` scope |

All other columns are nullable. `required`, defaults and so on are enforced by the service layer; `unique` by an index too.

### Column type map (`sqlType`)

| Column type | SQL type |
| --- | --- |
| `text`, `email`, `phone`, `choice` | `varchar(255)` |
| `url` | `varchar(1024)` (`varchar(768)` when `unique`: btree entries are limited to about 2,700 bytes) |
| `multiline` | `text` |
| `number` | `bigint` |
| `decimal` | `double precision` |
| `currency` | `numeric(19,4)` |
| `boolean` | `boolean` |
| `date` | `date` |
| `datetime` | `timestamptz(3)` |
| `lookup` | `text` (the target row id) |
| `image`, `file` | `text` (an attachment id or a JSON array of ids) |
| `autonumber` | `varchar(64)` (prefix plus a 4-digit counter) |

Reading an existing table (`describe`, linking) maps types back with `mapSqlType`: `boolean`, integer types to `number`,
`numeric(19,4)` to `currency`, `numeric(p,0)` to `number`, other numerics and floats to `decimal`, `date`, both timestamp types to
`datetime` (a `timestamp without time zone` is read as UTC), `text`/`json`/`jsonb`/`xml` to `multiline`, enums to `choice`, everything
else (`varchar`, `uuid`, `time`, arrays, ...) to `text`.

### Indexes

`wantedIndex(col)` decides; index names are unique per **schema** in PostgreSQL, so they carry the table name
(`indexName(table, kind, col)`: `uq_<table>_<col>` / `ix_<table>_<col>`, shortened with a hash past 63 characters):

| Column | Index |
| --- | --- |
| `id` | primary key (`<table>_pkey`) |
| `owner` | `ix_<table>_owner` |
| `unique: true` (not `multiline`, `image`, `file`) | `uq_<table>_<col>` (unique) |
| `lookup` | `ix_<table>_<col>` |

Text-kind columns are indexed on their **lowercased** form (`lower(("col") COLLATE "und-x-icu")`, see `connectors.md`), which is
what conditions compare: uniqueness is case-insensitive, and `owner = @me` row filters and lookups use the index. When a column is
altered, its two possible index names are dropped first (an expression index cannot survive a type change) and the wanted one is
created again; indexes a DBA created by hand with other names are left alone.

### Queries against data tables

The select builder always appends `createdOn, id` as the default order / tie-breaker, sorts blanks last (`(col IS NULL) ASC`, for text
`(col IS NULL OR col = '')`), parameterises every value with an explicit cast (`$1::text`, `$2::bigint`, ...), and neutralises
three-valued logic under `NOT` with `COALESCE(..., FALSE)`. On a managed table (`def.managed`) the `id` column is compared exactly
(its ids are lowercase UUIDs), so row lookups use the primary key. Details and the remaining differences from the in-memory semantics
are in `connectors.md`.

## Changing the schema

1. Add the change to `INSTALL_DDL` or `environmentDdl()` in `meta-store.ts` (keep `IF NOT EXISTS`, name indexes `ab_...`).
2. For existing installations add an ordered upgrade step to `migrate()` (inside its transaction) and bump `SCHEMA_VERSION`.
3. Qualify every table: `A('x')` for schema `ab`, `E('x')` for the environment schema. Never rely on `search_path`.
4. Update the `MetaStore` repository code, the `FakeMetaStore` in `/home/claude/appbuilder-demo/server/routes/meta/testing.ts`, the
   contract in `server/core/contracts.ts` if the interface changes, and this page.
5. Run the integration tests against a real server (see `testing.md`). Unit tests cannot catch SQL problems.
