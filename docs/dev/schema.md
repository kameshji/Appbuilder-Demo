# Database schema

Appbuilder keeps everything in one **PostgreSQL** database (15 or newer; 17 is what we install, CI and the sandbox run 16).
Decision D14 in `/home/claude/appbuilder-demo/docs/decisions.md` records the move from MySQL. The database holds:

1. **Schema `ab`**: install-wide objects (settings, users, sessions, the environment registry, who may enter which environment,
   the install-level audit log, the licence placeholder).
2. **One schema per environment**, `env_<id>`: the built-in `env_default` and one per environment created in the Admin console
   (at most `APPBUILDER_MAX_ENVIRONMENTS`, default 5). Each holds the environment's metadata tables (`ab_roles`, `ab_tables`,
   `ab_apps`, `ab_audit`, ...) **and** the data tables of its default connection (`t_orders`, `t_contacts`, ...).

Defined in `/home/claude/appbuilder-demo/server/core/meta-store.ts` (`INSTALL_DDL`, `environmentDdl()`, `SCHEMA_VERSION = 8`),
`/home/claude/appbuilder-demo/server/core/install-store.ts` (the `ab` registry, access and install audit)
and, for data tables, `/home/claude/appbuilder-demo/server/connectors/postgres/sql.ts` (`createTableSql`, `sqlType`).

Everything not on this page is not stored in the database: the workspace folder holds `server.json` (database connection,
password sealed), `.secret-key` (when `APPBUILDER_SECRET_KEY` is not set), and per environment `env/<id>/attachments/` (file
bytes) and `env/<id>/files/` (data files). See `architecture.md`.

## Environments, schemas and how a request finds its schema

- A request names its environment: the header `X-Appbuilder-Environment: <id>`, or `?env=<id>` on a GET (attachment links in
  `<img src>`), never both with different values (400). `requestedEnvironment(req, url)` in
  `/home/claude/appbuilder-demo/server/core/env-context.ts` reads and validates it (`^[a-z][a-z0-9_]{0,39}$`, so the schema name
  `env_<id>` is always a safe identifier).
- The **session resolver** (`userContextFor` in `/home/claude/appbuilder-demo/server/core/auth.ts`) checks it against the user's
  access (`EnvironmentManager.resolveFor` in `/home/claude/appbuilder-demo/server/core/environments.ts`): unknown id 404, not
  granted 403, not ready 503 (with the reason). Without one it uses the user's last environment (`ab.users.last_environment_id`),
  else Default, else the first one they may enter; a user who may enter none gets 403 except on routes marked `noEnvironment`
  (their session, password, the environment list, an empty workspace). Roles are then read **in** that environment.
- The router runs the handler inside `runInEnvironment(id, ...)` (Node's `AsyncLocalStorage`), and `ctx.environmentId` carries the
  id. The MetaStore, the security cache, the connection cache, the default connector and the workspace folders read
  `currentEnvironment()`; code that runs outside a request (boot, timers, tests) works in the default environment unless it calls
  `runInEnvironment` itself (boot migration, orphan sweep, environment creation and copy, deploy).
- Caches are keyed by environment id: the security engine keeps one roles/tables cache per environment, the ConnectionManager one
  connector instance per `<environment>:<connection>` (`closeEnvironment(id)` drops them when it is deleted), the files connector
  one store per folder. The registry and access rows are cached for 2 seconds and dropped on every change (and with every security
  cache invalidation, since access follows roles).
- `ab.environments` is the registry; `migrateEnvironment()` creates a schema and registers it; `environment-ops.ts` creates, copies,
  changes and deletes environments.

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
- Concurrency inside one transaction is safe (`server/connectors/postgres/db.ts`): every statement goes through one wire lock
  per client; each level (the transaction, every savepoint) has a queue, so `Promise.all` branches and sibling `tx()` calls run
  one after another and never interleave with a sibling's savepoint. When `fn` returns or throws, statements it started but
  did not await finish first, then the level closes: a statement issued later (an un-awaited query, a branch that outlived
  the transaction) fails with `TransactionEndedError` and never reaches the client, which may already serve another
  transaction. Two statements on one client at once would throw `TransactionOverlapError` (an assertion).
  `server/connectors/postgres/tx.integration.test.ts`.
- Every DataService write on the default database is a unit of work too (the event and job kernel, `events-and-jobs.md`).

## Migrations

`migrate()` is idempotent. It first reads `ab.settings` `schemaVersion` (0 when schema `ab` does not exist):

- **above `SCHEMA_VERSION`**: `SchemaTooNewError` before any statement runs (downgrade guard: the server keeps the database closed,
  reports `setup.incompatible` and does not retry);
- **1 to 3**: those were the MySQL system store. There is no migration from MySQL (decision D14); such a database is refused
  (`UnsuitableDatabaseError`, "use an empty database");
- the database encoding must be `UTF8`, otherwise it is refused before anything is created.

Then two phases:

1. In **one transaction** holding `pg_advisory_xact_lock(hashtext('appbuilder.migrate'))` (two servers starting together wait for
   each other) it runs `INSTALL_DDL` (`CREATE ... IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), registers and
   creates `env_default` when missing, runs the install-level steps by version (`upgradeInstallTo5`), marks environments left in
   `creating`/`deleting` by a stopped server as `failed`, and writes `schemaVersion`.
2. Then **every registered environment** in **its own transaction** (`migrateEnvironmentSchema`, advisory lock
   `appbuilder.migrate.<id>`): downgrade guard on its `schema_version` (above `SCHEMA_VERSION`: refused, nothing touched), then
   `environmentDdl()`, the `ENVIRONMENT_STEPS` it has not had, and its new `schema_version`. A failure marks only that environment
   `failed` (`last_error` starts with `Migration failed:`, cleared by the next successful run); the others go on. Environments whose
   creation never finished (`failed` with `schema_version` 0) are skipped.

The summary `{ from, to, steps, environments: [{ id, from, to, ok, error? }] }` is logged and written to the Default audit log and
`ab.audit` as `schema.migrate` when something changed. Future upgrade steps go into phase 1 (install) or `ENVIRONMENT_STEPS`
(per environment), ordered by version.

**4 to 5** (`upgradeInstallTo5`): users holding an `is_admin` role in `env_default` get `is_install_admin = true`; every user gets
an `ab.environment_access` row for `default` (`is_env_admin` = holds an admin role there); existing environments get
`schema_version = 4`. At the first start after it, `services.ts` moves `workspace/attachments/*` and `workspace/files/*` into
`workspace/env/default/` (`moveLegacyWorkspace`: only entries not there yet; nothing is overwritten or deleted).

**6 to 7, package K** (environment step `upgradeEnvironmentTo7Model`, independent of the other version 7 steps): checks
that `ab_relationships`, `ab_model_layouts` and `ab_model_drafts` exist, then records every existing lookup column (not the
system columns) as a relationship: required lookups `restrict`, optional ones `setBlank` (`docs/dev/data-model.md`).

**7 to 8, package D** (P1; shared number, independent steps): schema `ab` gets `mail_suppressions`,
`notification_deliveries`, `notification_digest` and the column `mail_log.sealed_message` (all from `INSTALL_DDL`,
idempotent); the environment step checks that `ab_connection_access`, `ab_custom_actions`, `ab_action_runs`,
`ab_action_idempotency`, `ab_webhooks`, `ab_webhook_replays`, `ab_report_subscriptions` and `ab_report_runs` exist. No
data is converted.

**7 to 8, package A** (P1; independent environment step `upgradeEnvironmentTo8Flows`, `server/core/flows/ddl.ts`): checks
that the flow tables exist (`ab_flows`, `ab_flow_versions`, `ab_flow_runs`, `ab_flow_steps`, `ab_flow_waits`,
`ab_flow_connections`, `ab_flow_run_grants`, `ab_flow_settings`, `ab_flow_alerts`) and drops the empty placeholder table
`sys_flow_runs` of version 7 (kept as `sys_flow_runs_placeholder_v7` if it holds rows); `provisionSystemTables` then creates
`sys_flow_runs` as a view over `ab_flow_runs` (it also converts a leftover placeholder at any later start).

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

Because `jsonb` reorders keys, code that compares a stored definition with one from a package or a client compares them with
sorted keys (`canonical()` in `server/routes/meta/alm.ts`), never with a plain `JSON.stringify`.

**Collation.** `CREATE DATABASE` takes the server's default locale: `C.UTF-8` in the sandbox, `en_US.utf8` in the CI image,
often `English_India.1252` on Windows. A plain `ORDER BY name` therefore orders differently on different installs
(`Documents` / `DocumentVersions` swap between `en_US` and `C`). Every ordering the product shows uses `COLLATE "C"` on a
lower-cased key, and tests that compare database order with JavaScript order sort both sides the same way. (This was the
cause of a transactions test that failed once in CI: it compared `ORDER BY name` under `en_US` with a code-point sort in
JavaScript. The product was not affected; `server/core/transactions.integration.test.ts` now also checks that the table
list is in code-point order.)

## Connection settings: `jit=off`

Every pooled connection starts with `-c search_path=pg_catalog,pg_temp -c TimeZone=UTC -c jit=off` (`SESSION_OPTIONS` in
`server/connectors/postgres/db.ts`). PostgreSQL's JIT compiles expressions of queries whose estimated cost is above
`jit_above_cost` (100,000 by default). Row-security predicates make big expressions with high estimates, so JIT kicked in
on queries that run in milliseconds and spent seconds compiling them. Measured on PostgreSQL 16 (sandbox, median of 5):

| Query (1,000,000 rows) | JIT on (ms) | JIT off (ms) |
| --- | ---: | ---: |
| Comments, "own" scope on 50 tables (regarding predicate): page of 50 + exact count | 42,350 | 518 |
| Comments, same predicate: count by regarding table | 41,600 | 735 |
| Comments, administrator (no predicate): count by regarding table | 318 | 285 |
| Production, no predicate: Query v2 SUM(Qty) by Line | 456 | 347 |
| Production, no predicate: page of 50 + exact count | 66 | 65 |
| Production, department-tree scope (200,000 rows): SUM by Line | 142 | 139 |
| Production, exists rule (10,000 rows): page of 50 + exact count | 278 | 349 |
| Production, department tree AND rule: SUM by Line | 204 | 229 |

JIT off is neutral or better for most aggregate queries; a few organisation-scope cases are 10 to 70 ms slower with it
off (at most 25 %), against an 80x regression of the collaboration predicate with it on. It stays off for every
connection; scoping it with `jit_above_cost` would not help, because the slow case is exactly the one with the highest
cost estimate. Reproduce: `JIT=compare node scripts/bench/orgsec-bench.mjs`
(organisation scopes and Query v2 aggregates) and `APPBUILDER_BENCH=1 APPBUILDER_BENCH_JIT=1 npx vitest run
server/core/core-data-model-scale.integration.test.ts` (collaboration). Database tools outside Appbuilder (psql, pg_dump)
keep the server's own JIT setting.

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
| `is_install_admin` | `boolean NOT NULL DEFAULT false` | install administrator (version 5): environments, accounts, install audit; administrator of every environment |
| `last_environment_id` | `text` | the environment the user last switched to (`POST /environments/:id/select`); requests without a header go there |
| `department_id` | `text` | organisation (P0-F): `ab.departments.id`; index `ab_ix_users_department`; cleared when the department is deleted |
| `manager_id` | `text` | direct manager (`ab.users.id`); index `ab_ix_users_manager`; cleared when the manager is deleted; no cycles (checked on write) |
| `job_title`, `phone`, `employee_code` | `text` | organisation fields (shown in the console; `User().JobTitle`) |

Users are install-wide; their **roles are per environment** (`ab_user_roles` in each environment schema). Deleting a user removes
their role assignments in every registered environment, their access rows and their sessions.

### `ab.departments`, `ab.teams`, `ab.team_members`: the organisation (P0 package F)

Install-wide, written by `/home/claude/appbuilder-demo/server/core/org-store.ts` (`ORG_INSTALL_DDL`, appended to `INSTALL_DDL`).

| Table | Columns | Notes |
| --- | --- | --- |
| `ab.departments` | `id text` PK, `code text NOT NULL`, `name text NOT NULL`, `parent_id text`, `description text`, `created_on timestamptz` | unique `ab_ux_departments_code` on `lower(code)`; index on `parent_id`. A tree: no cycles (checked on write), a department with children cannot be deleted |
| `ab.teams` | `id text` PK, `code text NOT NULL`, `name text NOT NULL`, `description text`, `environment_id text`, `created_on timestamptz` | unique `ab_ux_teams_code` on `lower(code)`; `environment_id` NULL = counts in every environment |
| `ab.team_members` | `team_id text`, `user_id text`, PK `(team_id, user_id)` | index `ab_ix_team_members_user`; rows of a deleted user or team are removed |

Codes are the stable references of rules and solutions (`@team:<code>`, `@department:<code>`). The security engine reads the
whole directory (departments, users' department and manager, teams with members) in three statements and caches it for 5 s
(`docs/dev/security-engine.md`).

### `ab.notifications`, `ab.user_settings`: in-app notifications (P0 package H)

Install-wide, written by `/home/claude/appbuilder-demo/server/core/notifications.ts` (DDL in `notifications-ddl.ts`, appended to
`INSTALL_DDL`). See `live.md`.

| Table | Columns | Notes |
| --- | --- | --- |
| `ab.notifications` | `id text` PK (`ntf_...`), `user_id text NOT NULL` FK `ab.users` ON DELETE CASCADE, `environment_id text` (NULL: install-wide), `kind text`, `title text`, `body text`, `link text`, `source text` (`app:<id>`, `user:<id>`, `table:<id>`, `system`), `sender_id text`, `sender_name text`, `created_on timestamptz`, `read_on timestamptz` | indexes `ab_ix_notifications_user (user_id, created_on DESC, id DESC)` (keyset paging) and partial `ab_ix_notifications_unread (user_id) WHERE read_on IS NULL`; the newest 500 per user are kept |
| `ab.user_settings` | `user_id text` FK `ab.users` ON DELETE CASCADE, `key text`, `value jsonb`, `modified_on timestamptz`, PK `(user_id, key)` | key `notifications`: `{ kinds, desktop, dnd, hidePresence }` |

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
| `id` | `text` | primary key: a slug of the name at creation (`default`, `sales_test`), never changes |
| `name` | `text NOT NULL` | unique on `lower(name)` (`ab_ux_environments_name`) |
| `schema_name` | `text NOT NULL UNIQUE` | `env_<id>` |
| `type` | `text NOT NULL DEFAULT 'production'` | `production`, `sandbox`, `developer` |
| `built_in` | `boolean NOT NULL DEFAULT false` | Default only |
| `created_on` | `timestamptz NOT NULL` | |
| `description` | `text` | |
| `created_by` | `text` | user id |
| `state` | `text NOT NULL DEFAULT 'ready'` | `ready`, `creating`, `deleting`, `failed` |
| `schema_version` | `integer NOT NULL DEFAULT 0` | the `SCHEMA_VERSION` the schema was last migrated to (0: creation never finished) |
| `locked` | `boolean NOT NULL DEFAULT false` | production only: design routes answer 403 (`DESIGN_ROUTES` in `router.ts`) |
| `last_error` | `text` | why `state` is `failed` |

### `ab.environment_access`: who may enter which environment

| Column | Type | Notes |
| --- | --- | --- |
| `environment_id`, `user_id` | `text` | primary key; index `ab_ix_environment_access_user` |
| `is_env_admin` | `boolean NOT NULL DEFAULT false` | holds an `is_admin` role there. Kept in step by the MetaStore (one `UPDATE ... EXISTS` after every role assignment and role change in that environment); never set directly |
| `granted_on` | `timestamptz NOT NULL` | |
| `granted_by` | `text` | user id; NULL for rows made by the version 5 upgrade or by a role assignment |

Install administrators enter every environment without a row. Assigning a role to a user in an environment adds the row
(`setUserRoles`); revoking access deletes the row and the user's `ab_user_roles` there.

### `ab.audit`: the install-level audit log

`id bigint GENERATED ALWAYS AS IDENTITY` primary key, `at timestamptz NOT NULL` (index `ab_ix_install_audit_at`), `user_id text`,
`action text NOT NULL` (index `ab_ix_install_audit_action`), `environment_id text` (the environment the action was about),
`details jsonb` (same size and NUL rules as `ab_audit`). Actions: `docs/admin/audit-log.md`.

### Identity (P0 package I)

Install-wide, from `IDENTITY_INSTALL_DDL` in `/home/claude/appbuilder-demo/server/core/identity/ddl.ts` (appended to
`INSTALL_DDL`). Version 7's install step `upgradeInstallTo7Identity` checks they exist before the database is stamped 7
(other wave 4 packages add their own independent steps under the same number). Design: [auth.md](auth.md).

Added columns: `ab.users.kind text NOT NULL DEFAULT 'person'` (`service` for service accounts), `ab.users.password_changed_on
timestamptz`; `ab.sessions.ip`, `public_id` (index `ab_ix_sessions_public`), `absolute_expires_on timestamptz`, `auth_on
timestamptz` (last password or code proof), `mfa boolean NOT NULL DEFAULT false`, `restricted text` (`mfa_enrol`).

| Table | Columns | Notes |
| --- | --- | --- |
| `ab.user_mfa` | `user_id` PK FK users ON DELETE CASCADE, `totp_secret_sealed`, `totp_enabled_on`, `totp_last_step bigint`, `totp_pending_sealed`, `totp_pending_on`, `email_enabled boolean`, `recovery jsonb` (`[{h, used}]`, SHA-256), `recovery_created_on`, `modified_on` | secrets sealed with the secret box |
| `ab.auth_tokens` | `id` PK, `kind` (`reset`, `invite`, `email_change`, `mfa_pending`, `email_code`, `email_setup`), `user_id` FK CASCADE, `token_hash` (unique `ab_ux_auth_tokens_hash`; SHA-256 of `kind:token`), `created_on`, `expires_on` (index), `used_on`, `created_by`, `attempts int`, `data jsonb` | single use: `UPDATE ... SET used_on = now() WHERE used_on IS NULL` |
| `ab.trusted_devices` | `id` PK, `user_id` FK CASCADE (index), `created_on`, `expires_on`, `last_used_on`, `user_agent`, `ip` | "remember this device" |
| `ab.password_history` | `user_id` FK CASCADE, `hash`, `created_on`; index `(user_id, created_on DESC)` | at most 24 per user |
| `ab.signin_log` | `id bigint identity` PK, `at` (index DESC), `user_id` (no FK; index `(user_id, at DESC)`), `email`, `outcome` (`success`/`failure`), `reason`, `method`, `ip`, `user_agent`, `session_id` (public id), `device_hash`, `new_device boolean` | no retention yet |
| `ab.mail_log` | `id` PK, `created_on` (index DESC), `sent_on`, `status` (`queued`/`sent`/`retrying`/`failed`), `attempts`, `to_address`, `subject`, `template`, `user_id`, `job_id`, `message_id`, `last_error` | never the body |
| `ab.api_keys` | `id` PK, `user_id` FK CASCADE (index), `environment_id`, `name`, `prefix` (unique), `secret_hash`, `created_on`, `created_by`, `expires_on`, `last_used_on`, `last_used_ip`, `revoked_on`, `revoked_by`, `ip_allow jsonb`, `rate_per_minute int` | |

Settings rows (`ab.settings`): `identity.policy` (JSON `SecurityPolicy`), `identity.smtp` (JSON; `passwordSealed`).

### `ab.backups`, `ab.backup_ops`: the backup catalogue (P0 package J, version 7)

Written by `server/core/backup/service.ts` (DDL in `backup/ddl.ts`, appended to `INSTALL_DDL`; step `upgradeInstallTo7Backup`).
Their rows are never part of a backup: the archives in the backup folder are the source of truth, and the folder scan at start
adds archives it does not know (reading their manifests) and marks rows whose file is gone `missing`. See `backup.md`.

| Table | Columns | Notes |
| --- | --- | --- |
| `ab.backups` | `id` PK (`bk_...`), `file_name` (unique), `kind` (`install`, `environment`), `environment_id`, `environment_name`, `trigger` (`manual`, `schedule`, `pre-upgrade`, `pre-delete`, `pre-restore`, `pre-migration`, `upload`), `state` (`queued`, `running`, `verifying`, `ok`, `failed`, `missing`, `uploaded`), `method` (`pg_dump`, `builtin`), `encrypted`, `includes_key`, `size_bytes`, `sha256` (of the file), `manifest_sha256`, `created_on`, `finished_on`, `created_by`, `app_version`, `schema_version`, `summary` jsonb (environments with tables, rows, attachments; warnings), `error`, `verified_on`, `verify_error`, `restore_tested_on`, `restore_test_error`, `offsite` jsonb, `pinned`, `note`, `job_id`, `progress` jsonb | indexes on `created_on` and `(kind, environment_id, created_on)` |
| `ab.backup_ops` | `id` PK (`bop_...`), `kind` (`restore`, `restore-tables`, `restore-test`, `verify`), `backup_id`, `mode`, `source_environment`, `target_environment`, `state` (`running`, `succeeded`, `failed`), `phase`, `progress` jsonb, `started_on`, `finished_on`, `created_by`, `error`, `result` jsonb | interrupted operations are closed at the next start (an in-place restore's folder swap is finished when its database part had committed) |

The backup settings are the `ab.settings` row `backup.config` (JSON; a saved passphrase sealed with the SecretBox). The
environment state `restoring` (in `ab.environments.state`) marks an in-place restore; a server start resets it to `ready`.

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
| `read_scope`, `update_scope`, `delete_scope` | `text NOT NULL DEFAULT 'none'` | `none`, `own`, `team`, `manager`, `managerTree`, `department`, `departmentTree`, `all` |
| `share_scope` | `text` | P0-F: the share privilege (same values; NULL = none); added by `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` |
| `columns` | `jsonb` | map column name to `none`/`read`/`update` (CLS) |
| `row_filter` | `jsonb` | array of `RowCondition` (RLS): compare (column or lookup path), `exists` (junction), `any` (OR); see `security-engine.md` |

### `ab_shares`: record sharing (P0 package F)

| Column | Type | Notes |
| --- | --- | --- |
| `table_id`, `row_id` | `text NOT NULL` | the shared row |
| `principal_type` | `text NOT NULL` | `user` or `team` |
| `principal_id` | `text NOT NULL` | `ab.users.id` or `ab.teams.id`; index `ab_ix_shares_principal (principal_id, table_id)` |
| `access` | `text NOT NULL` | `read` or `update` (read and change) |
| `shared_by` | `text` | user id |
| `shared_on` | `timestamptz NOT NULL` | |

Primary key `(table_id, row_id, principal_type, principal_id)`. Rows go with the shared row (row delete), the user (user delete,
every environment) and the team (team delete). Copied with the data of an environment. Turning sharing off for a table keeps them
(inert).

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
| `file_name`, `mime`, `sha256`, `storage_key` | `text NOT NULL` | file on disk: `workspace/env/<environment>/attachments/<key[0..1]>/<key>` |
| `size_bytes` | `bigint NOT NULL` | |
| `created_by` | `text` | |
| `created_on` | `timestamptz NOT NULL` | index `ab_ix_attachments_created` (orphan sweep) |

### `ab_counters`

`k text` primary key (`<tableId>:<column>` for autonumber), `v bigint NOT NULL` (last number issued). `nextCounter` is one atomic
statement: `INSERT ... ON CONFLICT (k) DO UPDATE SET v = c.v + 1 RETURNING v`.

Also `sys.seed.<table id>` (core data model, P0 package N): set once when the reference data of that system table was
seeded, so deleted seed rows are not put back. `v` is 1.

### System tables `sys_*` (core data model, P0 package N)

Every environment schema also holds the 34 system tables of `docs/dev/core-data-model.md`, registered in `ab_tables` with
stable ids `sys_*` (`system: true`). Real tables (Activities, Comments, Mentions, Follows, Tags, Tag links, Documents,
Document versions, Attachment links, the communication placeholders, Flow runs and the reference tables) are ordinary
managed tables created with the platform DDL (system columns, `text` uuids, the same index rules), plus the indexes
`ix_<table>_timeline (regardingId, createdOn DESC, id DESC)`, `(AssignedTo, Status)` on Activities and
`(MentionedUser, IsRead, createdOn DESC)` on Mentions. Projections (Users, Departments, Teams, Team members, Roles, Role
assignments, Shares, Notifications, Audit entries, Sign-in log, Job runs, Event runs) are **views** over `ab.*` and the
environment's metadata tables. Views hold no data and are dropped and created again by every provisioning run;
migration steps therefore start with `dropSystemViews` (a migration that alters a table under a view must not fail on
the dependency). Provisioning (`server/core/system-tables.ts`) runs in the environment's migration transaction after
the steps, on every start, and is idempotent. It is not a numbered step: the schema version stays 7.

### `ab_audit`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigint GENERATED ALWAYS AS IDENTITY` | primary key |
| `at` | `timestamptz NOT NULL` | index `ab_ix_audit_at` |
| `user_id` | `text` | |
| `action` | `text NOT NULL` | e.g. `auth.login`, `table.create`, `role.create`; index `ab_ix_audit_action` |
| `table_id`, `row_id` | `text` | |
| `details` | `jsonb` | at most 60,000 characters of JSON (longer details are kept as a truncated JSON string). Never holds passwords |

The audit log is per environment (sign-ins of install-wide users are written to the environment the request ran in: the user's
environment for a signed-in request, Default for an anonymous one such as a sign-in). Install-level actions go to `ab.audit`.

### Event and job kernel: `ab_outbox`, `ab_jobs`, `ab_schedules`, `ab_table_events`, `ab_event_runs` (P0 package G)

Created by `kernelDdl()` (`server/core/kernel-ddl.ts`) as part of every environment schema; column lists, indexes and the
guarantees built on them are in [events-and-jobs.md](events-and-jobs.md#tables-per-environment-schema). In short:

| Table | Purpose |
| --- | --- |
| `ab_outbox` | one row per data change, written in the change's transaction; `id` bigint identity in commit order per table; `dispatched_on` set by the dispatcher (partial index on pending rows) |
| `ab_jobs` | the job queue: `state`, `run_at`, `attempts`/`max_attempts`, `backoff`, `locked_by`/`heartbeat_at`, `idempotency_key` (unique when set), `run_as`, `result`/`error` jsonb |
| `ab_schedules` | cron or interval schedules with time zone, misfire policy and the built-in maintenance schedules |
| `ab_table_events` | validation rules and before/after events (`def` jsonb = `TableEventDef`) |
| `ab_event_runs` | the events run log |

Formula and rollup columns are ordinary physical columns; their definition is `ColumnDef.computed` inside `ab_tables.def`.
They arrived with schema version 6 (with F's organisation and `ab_shares` and H's notifications): the tables are
`CREATE ... IF NOT EXISTS` statements of `environmentDdl()` / `INSTALL_DDL`, and the version 6 step checks they all exist
before the schema is stamped 6, so an older server (version 5) refuses a database that has them (downgrade guard).

### Data model designer: `ab_relationships`, `ab_model_layouts`, `ab_model_drafts` (P0 package K, version 7)

Created by `modelEnvironmentDdl()` (`server/core/model/store.ts`). Copied with an environment copy (drafts are not).

| Table | Columns | Notes |
| --- | --- | --- |
| `ab_relationships` | `id text` PK, `from_table`, `from_column`, `to_table text NOT NULL`, `kind` (`oneToMany`, `oneToOne`, `self`), `on_delete` (`restrict`, `cascade`, `setBlank`), `def jsonb` (`preventCycles`, `junction.group`), `created_on`, `modified_on` | unique `ab_ux_relationships_from (from_table, from_column)` (one relationship per lookup column); index `ab_ix_relationships_to` (the delete path reads by parent) |
| `ab_model_layouts` | `user_id text` PK (`''` = the shared layout), `layout jsonb`, `modified_on` | `{ positions, areas }` |
| `ab_model_drafts` | `user_id text` PK, `draft jsonb`, `modified_on` | one draft per user: `{ base, model, past, future, layout }` |

Reporting settings live in the table definition: `TableDef.reporting` (a view's lineage, a summary table's source,
groups, measures and schedule, a date dimension's range and fiscal start) and `TableDef.uniqueTogether` (composite
unique indexes `uq_<table>_pair_<cols>`, created by `createTableSql` and by the designer). A reporting view's physical
object is a PostgreSQL `VIEW` named `v_<name>` in the environment schema.

### Connector actions, webhooks, reports (P1 package D, version 8)

Created by `actionsEnvironmentDdl()` (`server/core/actions/ddl.ts`). Not copied with an environment copy except the
definitions a solution carries (custom actions travel inside the connection entry of a package).

| Table | Columns | Notes |
| --- | --- | --- |
| `ab_connection_access` | `connection_id`, `principal_kind` (`role`, `user`), `principal_id`, `level` (`use`, `manage`), `granted_by`, `granted_on`; PK (connection_id, principal_kind, principal_id) | grants of action connections; administrators need none |
| `ab_custom_actions` | `id` PK, `connection_id`, `action_id`, `def jsonb` (`ActionDef` + `http` spec), `created_by`, `created_on`, `modified_on` | unique (connection_id, lower(action_id)); removed with the connection |
| `ab_action_runs` | `id` PK, `at`, `connection_id`, `action_id`, `user_id`, `source` (`flow:<id>`, `event:<id>`, `test`), `correlation_id`, `status` (`ok`, `failed`), `error_code`, `message`, `http_status`, `duration_ms`, `replayed`, `details jsonb` (method, host, path, recipients; never inputs, outputs or secrets) | activity; indexes (connection_id, at DESC), (at); 90 days (`actions.retention`) |
| `ab_action_idempotency` | `key_hash` PK (SHA-256 of environment, connection, action, key), `connection_id`, `action_id`, `state` (`running`, `done`), `result jsonb` (redacted), `created_on`, `expires_on` (24 h) | |
| `ab_webhooks` | `id` PK, `flow_id`, `name`, `token_hash` (SHA-256), `token_hint` (4 characters), `secret_sealed` (secret box), `require_signature`, `tolerance_seconds`, `max_body_kb`, `per_minute`, `enabled`, `created_by`, `created_on`, `rotated_on`, `last_used_on`, `calls`, `rejected` | index (flow_id) |
| `ab_webhook_replays` | `hook_id`, `sig_hash`, `seen_on`; PK (hook_id, sig_hash) | signatures seen; older than a day removed by `actions.retention` |
| `ab_report_subscriptions` | `id` PK, `name`, `owner_id`, `def jsonb` (`ReportDef`: source, runAs, schedule, recipients, inlineRows, csvRows, onEmpty, optOut), `enabled`, `schedule_id` (its `ab_schedules` row, job `report.run`), `created_on`, `modified_on` | |
| `ab_report_runs` | `id` PK (`rrun_<job id>`), `report_id`, `started_on`, `finished_on`, `status` (`running`, `succeeded`, `partial`, `failed`), `trigger` (`schedule`, `manual`), `job_id`, `recipients jsonb` (per recipient: status, rows, mail id, reason), `message` | index (report_id, started_on DESC); 400 days |

Install-wide (schema `ab`, `DELIVERY_INSTALL_DDL`):

| Table | Columns | Notes |
| --- | --- | --- |
| `ab.mail_suppressions` | `address` PK (lowercase), `reason` (`manual`, `unsubscribed`, ...), `note`, `added_by`, `added_on` | checked by the Email connector, notification email and reports |
| `ab.notification_deliveries` | `id` PK, `at`, `user_id`, `notification_id`, `environment_id`, `kind`, `title`, `channel` (`in_app`, `email`), `status` (`delivered`, `skipped`, `queued`, `digest`, `sent`, `failed`), `reason`, `mail_id` | indexes (user_id, at DESC), (at); 90 days |
| `ab.notification_digest` | `id` PK, `user_id` FK users ON DELETE CASCADE, `kind`, `title`, `body`, `link`, `environment_id`, `created_on`, `reason`, `hold_until` (quiet hours or the hourly limit), `delivery_id` | emails waiting for a digest |
| `ab.mail_log.sealed_message` | `text NULL` | a queued message above 150 KB sealed (attachments), cleared when sent or failed for good |

**Rule for every package:** a change that adds or alters tables or columns of `ab` or of the environment schemas bumps
`SCHEMA_VERSION` to the next number and adds an upgrade step (install: phase 1 of `migrate()`; environment:
`ENVIRONMENT_STEPS`), even when the DDL itself is idempotent. Several packages landing in the same release share one
number.

### Flows: `ab_flows`, `ab_flow_versions`, `ab_flow_runs`, `ab_flow_steps`, `ab_flow_waits`, `ab_flow_connections`, `ab_flow_run_grants`, `ab_flow_settings`, `ab_flow_alerts` (P1 package A, version 8)

DDL in `server/core/flows/ddl.ts` (`flowsEnvironmentDdl`, appended to `environmentDdl`). Columns and purpose:
[flows.md](flows.md#tables-per-environment-schema-version-8). Keys and indexes: `ab_flows.id`, unique `lower(name)`;
`ab_flow_versions (flow_id, version)`; `ab_flow_runs.id`, unique `trigger_key` (where set: one run per trigger event),
partial indexes on active runs (`state`), on `(concurrency_key, seq)` of active runs, on `deadline_at` of active runs, on
`(flow_id, created_on DESC)`, `(flow_id, finished_on)`, `parent_run_id`, `regarding_id`; `ab_flow_steps (run_id, step_key)`
with `(run_id, scope)` and an identity `ord` (execution order); `ab_flow_waits.id`, unique `(run_id, step_key)`, partial
indexes on `wake_at` and `timeout_at` of waiting rows, `token_hash`, `approval_id`; `ab_flow_connections (flow_id, ref)`;
`ab_flow_run_grants (flow_id, role_id)`; `ab_flow_settings.k`; `ab_flow_alerts.flow_id`. Timestamps `timestamptz`,
documents `jsonb`. Environment copies copy `ab_flows`, `ab_flow_versions`, `ab_flow_connections`, `ab_flow_run_grants`
(flows turned off); restores cancel active runs.

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
2. For existing installations add an ordered upgrade step and bump `SCHEMA_VERSION`: install-level steps in phase 1 of `migrate()`
   (inside its transaction), environment steps in `ENVIRONMENT_STEPS` (each environment runs them in its own transaction).
3. Qualify every table: `A('x')` for schema `ab`, `E('x')` for the environment schema. Never rely on `search_path`.
4. Update the `MetaStore` repository code, the `FakeMetaStore` in `/home/claude/appbuilder-demo/server/routes/meta/testing.ts`, the
   contract in `server/core/contracts.ts` if the interface changes, and this page.
5. Run the integration tests against a real server (see `testing.md`). Unit tests cannot catch SQL problems.
