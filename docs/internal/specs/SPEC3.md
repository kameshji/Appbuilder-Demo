# Appbuilder phase 3: connectors, connections, server-side data and security

Read first: `src/platform/contracts.ts` (extended), `src/platform/http.ts` (Data API v1), `server/core/contracts.ts`
(server internals), `server/core/condition.ts` (reference semantics). Then `docs/internal/specs/SPEC2.md` for context.

## 0. What changes and why
- Data moves server-side. The browser no longer owns rows or rules: the local Node server talks to MySQL
  (and other connectors) and enforces **RBAC + RLS + CLS** on every request for the **signed-in** user.
- Default store = on-device MySQL (the owner's MySQL 8.4.3; sandbox tests use MariaDB 10.11). Write SQL that
  works on MySQL 5.7+, 8.x and MariaDB 10.4+ (shared hosting next phase): no JSON column type (use LONGTEXT),
  no CHECK-dependent logic, no `AS alias` in ON DUPLICATE KEY, utf8mb4 / utf8mb4_unicode_ci everywhere,
  DATETIME(3) stored in UTC, InnoDB.
- The next phase reimplements Data API v1 in PHP over the same `ab_*` schema for shared hosting, so: the API
  contract (http.ts) and the schema (section 3) are the compatibility surface. Keep logic portable (no
  MySQL stored procedures/triggers/events).
- The browser-only demo mode (IndexedDB, simulated security) stays for the hosted demo page.
- Server code is TypeScript run directly by Node 22.18+/26 (type stripping, `node server/main.ts`); see the
  header of server/core/contracts.ts for the syntax rules. Dependencies available: `mysql2`, `exceljs`, `papaparse`,
  `js-yaml`. Nothing else without asking the architect. Do not run git. Do not run `npm install`.

## 1. Workspace on disk (server)
```
workspace/
  server.json          { defaultConnection: { host, port, database, user, ssl? , passwordSealed } }  (written by setup)
  .secret-key          32 random bytes (hex), created on first start, file mode 0600; overridable by env APPBUILDER_SECRET_KEY (64 hex)
  files/               designated data-files folder (files connector), one sub-folder per file id
  attachments/         attachment store: attachments/<id[0..1]>/<id>   (no extensions, no client names in paths)
  (legacy, phase 2)    workspace.yaml, apps/*.app.yaml, tables/*.csv|*.schema.yaml  -> migrated once (section 8)
```
Env: `PORT` (5174), `APPBUILDER_HOST` (127.0.0.1), `APPBUILDER_WORKSPACE`, `APPBUILDER_SECRET_KEY`,
`APPBUILDER_DB_*` (HOST, PORT, NAME, USER, PASSWORD: optional bootstrap that skips the setup screen; used by tests).

## 2. HTTP server (S1)
- `server/main.ts` builds Services, registers all RouteModules, serves `/api/v1/*` and static `dist/` (SPA fallback);
  `server/vite-plugin.mjs` mounts the same request handler in `npm run dev`. **Remove the old unauthenticated
  `/api/fs/*` API** from both (the browser demo mode does not use the server).
- Router: path params `:id`, JSON body limit 2 MB (raw upload routes: `maxBodyMB`, default 25), Host/Origin must be
  localhost/127.0.0.1/::1 (keep phase-2 DNS-rebinding guard), non-GET requires `X-Appbuilder: 1`, security headers on
  every response (`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cache-Control: no-store` for API,
  a CSP for HTML: `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'`).
- Errors -> ApiError JSON; never leak stack traces, SQL or secrets (log server-side).
- package.json scripts: `"start": "node server/main.ts"`, `"typecheck:server": "tsc -p tsconfig.server.json"`;
  `typecheck` should run both projects. Keep `npm run build` = client build.

## 3. System schema (S1 owns DDL; all repos in MetaStore)
All `id` columns VARCHAR(64) (prefixed ids like `user_x1y2`, `tbl_…`) except data row ids (CHAR(36) UUID).
```
ab_meta          (k VARCHAR(64) PK, v TEXT)                                  -- schemaVersion
ab_users         (id PK, name, email UNIQUE (lowercased), password_hash NULL, status ENUM-like VARCHAR(16),
                  created_on DATETIME(3), last_login DATETIME(3) NULL)
ab_sessions      (id_hash CHAR(64) PK, user_id, created_on, expires_on, last_seen, user_agent VARCHAR(255)) idx(user_id), idx(expires_on)
ab_roles         (id PK, name UNIQUE, description, is_admin TINYINT, is_maker TINYINT, apps LONGTEXT /* json */)
ab_user_roles    (user_id, role_id, PK(user_id, role_id))
ab_role_tables   (role_id, table_id, can_create, read_scope, update_scope, delete_scope VARCHAR(8),
                  columns LONGTEXT /* json Record<col, ColumnAccess> */, row_filter LONGTEXT /* json RowCondition[] */,
                  PK(role_id, table_id))
ab_tables        (id PK, name UNIQUE, connection_id, source, def LONGTEXT /* json TableDef */, created_on, modified_on)
ab_apps          (id PK, name UNIQUE, description, width, height, definition LONGTEXT, created_on, modified_on, modified_by)
ab_connections   (id PK, name UNIQUE, connector, settings LONGTEXT, secret_sealed TEXT NULL, status, last_error TEXT NULL,
                  is_default TINYINT, scope VARCHAR(8), created_on, modified_on)
ab_solutions     (id PK, name UNIQUE, display_name, publisher, version, description, components LONGTEXT, created_on, modified_on)
ab_data_files    (id PK, connection_id, file_name, original_name, kind, size_bytes, checksum, storage_key,
                  imported_on, table_ids LONGTEXT, modified_since_import TINYINT)
ab_attachments   (id PK, table_id, col VARCHAR(64), row_id CHAR(36), file_name VARCHAR(255), mime VARCHAR(127), size_bytes BIGINT,
                  sha256 CHAR(64), storage_key VARCHAR(128), created_by, created_on) idx(table_id,row_id)
ab_counters      (k VARCHAR(191) PK, v BIGINT)
ab_audit         (id BIGINT AUTO_INCREMENT PK, at DATETIME(3), user_id NULL, action VARCHAR(64), table_id NULL, row_id NULL, details LONGTEXT NULL) idx(at)
```
`ab_role_tables` is the normalised form of `RoleDef.privileges`; the MetaStore maps both ways. A role has
`is_maker` (may create/edit apps, tables, connections). Built-in roles on setup: Administrator (is_admin),
Maker (is_maker, full on all tables), Viewer (read all). New tables get default privileges: Maker full, Viewer read,
others none (phase-2 rule).

## 4. Auth (S1)
- Passwords: `crypto.scrypt` N=32768 r=8 p=1 keylen 64, 16-byte salt, stored `scrypt$32768$8$1$<salt b64>$<hash b64>`;
  verify with timingSafeEqual; min length 10; reject passwords equal to the email.
- Sessions: 32 random bytes base64url token in cookie `ab_session` (HttpOnly; SameSite=Strict; Path=/; Secure when the
  request is https); store sha256(token) hex. Lifetime 7 days, sliding (touch at most once per 10 minutes). Logout
  deletes; password change deletes all other sessions of that user; disabling a user deletes all sessions.
- Login throttle (in memory): 8 failures per (email, ip) per 15 min -> 429-like `denied` "Too many attempts".
  Same error text for unknown email and wrong password.
- Setup: `needsDatabase` = no usable default connection; `needsAdmin` = ab_users empty. `/setup/database` tests the
  credentials (optionally `CREATE DATABASE IF NOT EXISTS`), seals the password into server.json, runs `migrate()`.
  `/setup/admin` creates the user + built-in roles + Admin role membership, runs migration of legacy data
  (section 8) or seeds the sample (Contacts, Orders, Contacts app) when there is nothing to migrate, sets the cookie.
- Auth levels: user = any active signed-in user; maker = isAdmin or a role with is_maker; admin = an admin role.

## 5. Security semantics (S1: server/core/security.ts) - the heart of this phase
For user U and table T (admins: everything allowed, all columns 'update', predicate {const:true}):
- **RBAC**: `create` = OR over U's roles; scope(op) = max over roles (none < own < all).
- **RLS**: `rowPredicate(T, op)` = OR over roles R with scope_R(op) != none of
  `( scope_R(op) == all ? TRUE : owner == U.id ) AND rowFilter_R` (rowFilter conditions ANDed; '@me' -> U.id,
  '@myEmail' -> U.email; a rowFilter on a column the table no longer has makes that role grant nothing).
  No granting role -> `{const:false}`.
- **CLS**: access(col) = max over roles that grant read on T of columns_R[col] (missing = 'update').
  'none' columns: removed from the TableDef sent to the client, from query results, cannot appear in where/orderBy/select
  (-> 403), cannot be written. 'read' columns: visible, writes rejected (403 field-specific). System columns
  (id, createdOn, modifiedOn, createdBy, owner) are never writable by clients; id is always visible.
- Writes: insert needs create; the server sets id (client UUID accepted if valid and unused), createdOn, modifiedOn,
  createdBy = owner = U.id. update/delete: the target row must satisfy rowPredicate(T, 'update'|'delete') (pass it as
  the connector `guard`; 0 affected -> 404 if the row does not exist for read, else 403). After update, a row the user
  could see may become invisible (allowed; response still returns the visible projection).
- Lookups: a lookup value must reference a row that exists (system check), independent of the user's read access.
- App access: GET app definition requires `canRunApp` (or maker). The workspace response lists only runnable apps for
  non-makers.
- Everything the client mirrors (EffectivePrivileges) is for UX only. Never trust client-side checks.
- Audit: every insert/update/delete/import, login success/failure, role/user change -> ab_audit (no secrets, no passwords).

## 6. DataService (S1: server/core/data.ts)
- Validates and coerces values against the TableDef (types, required, unique (query through the connector),
  choice membership, lookup existence, file/image cells must be attachment ids belonging to that table/column/row),
  autonumber via `meta.nextCounter(table.id + ':' + col)` (MySQL default store) - for other connectors also the counter.
- Converts between JSON (http) and RawRow (Date objects) at the boundary: date -> 'YYYY-MM-DD', datetime -> ISO.
- Query: CLS checks on the incoming Query, `where = and(rowPredicate(read), client where)`, cap `top` to
  DEFAULT_ROW_CAP and set `truncated` (fetch cap+1). Pushdown when the connector supports it, else `applyQuery`.
- File columns on delete/update: attachments no longer referenced are deleted (store + metadata).
- Data files: any successful write to a table with `origin.kind == 'file'` sets the file's `modified_since_import`.

## 7. Connectors
Registry: `server/connectors/index.ts` exports `registerConnectors(manager)` (architect writes; each agent exports
`createXConnector: ConnectorFactory` from its folder's `index.ts`).

### 7.1 MySQL (C1, server/connectors/mysql)
- settings: host, port, database, user, ssl ('true'|'false'); secret = password. Pool per connection (mysql2/promise,
  `dateStrings: false`, `timezone: 'Z'`, `supportBigNumbers: true`, `bigNumberStrings: false`, connectionLimit 10,
  `namedPlaceholders: false`, `multipleStatements: false`).
- Also export `createSqlDb(settings, password): SqlDb` (used by S1 for the system store on the default connection).
- DDL from TableDef: physical table `def.source` (default `t_` + lowercase name), columns per type map:
  text/email/url/phone VARCHAR(255) (VARCHAR(1024) for url), multiline MEDIUMTEXT, number BIGINT, decimal DOUBLE,
  currency DECIMAL(19,4), boolean TINYINT(1), date DATE, datetime DATETIME(3), choice VARCHAR(255), lookup CHAR(36),
  image/file TEXT, autonumber VARCHAR(64); system: id CHAR(36) PK, createdOn/modifiedOn DATETIME(3), createdBy/owner VARCHAR(64).
  Indexes: owner, every lookup column, every unique column (UNIQUE). All columns NULL-able (the service validates).
- Identifiers: validate `^[A-Za-z_][A-Za-z0-9_]{0,63}$` then backtick-quote; never interpolate values.
- Condition -> SQL must match `server/core/condition.ts` semantics exactly (case-insensitive text via collation,
  blank = NULL or '', `contains` with LIKE and escaped `%`/`_`/`\`). Ship a parity test that runs the same conditions
  through evaluateCondition and through MariaDB.
- listSourceTables / describe: information_schema of the database, mapping SQL types back to ColumnType; linking a table
  without the system columns: the service adds them via ALTER when `ddl` is allowed (ask the user in the UI first),
  `id` must be a CHAR(36)/VARCHAR primary key or the table is linked read-only.
- Integration tests against the sandbox MariaDB: `APPBUILDER_TEST_DB=mysql://abdev:abdev-sandbox-only@127.0.0.1:3306/appbuilder_test`
  (tests create and drop their own tables with a random prefix; skip with a clear message when the env var is unset).

### 7.2 Files (C2, server/connectors/files) - the owner's design, refined
- Purpose: work offline with a data file from the device. The user picks a .csv, .xlsx or .json file in the browser; it
  is uploaded and **copied** into `workspace/files/<fileId>/data.<ext>` (the original is never modified). One table per
  sheet (xlsx) / one per csv / one per top-level array (json). Header row = column names (sanitised to identifiers;
  display names keep the original header); types inferred (number, decimal, boolean, date, datetime, email, url, text,
  multiline). The connector adds an `id` column (UUID) and the other system columns to its copy on first import.
- Read/write through apps like any table; writes go to the copy (debounced, serialised, atomic replace of the file).
  xlsx is written with exceljs (sheet per table, keeps other sheets untouched), csv with papaparse, json pretty-printed.
- Replace: a newer version of the file replaces the copy; rows are matched by `id` when present, otherwise replaced.
- Download: the current copy (with edits).
- **Device-only**: the files connection has `scope: 'device'`. It is never synced or exposed beyond this machine. To take
  file data online it must be part of a **solution**: solution packages embed the file (base64) as a `file` component,
  and importing such a package on a server offers "Import as database tables" (materialise into the default MySQL) or
  "Keep as file" (device only). Locally, "Move to database" (tables.moveToConnection) converts a file table into a MySQL
  table with the same name so app formulas keep working.
- In-memory evaluation via `applyQuery` (capabilities.pushdown = false). Hold parsed sheets in memory with an mtime check.
- One files connection exists by default ("Data files", id `conn_files`).

### 7.3 Google Sheets (C3, server/connectors/gsheets)
- settings: spreadsheetId (or a full URL; extract the id); secret = service-account key JSON (client_email, private_key).
  `test()` reports the service-account email the user must share the sheet with when access is denied.
- Auth: OAuth 2.0 JWT bearer flow with node:crypto RS256 (`https://oauth2.googleapis.com/token`, scope
  `https://www.googleapis.com/auth/spreadsheets`), token cached until 60 s before expiry. No googleapis package.
- Tables = tabs; header row = column names; values via Sheets API v4 `values.get` (`valueRenderOption=UNFORMATTED_VALUE`,
  `dateTimeRenderOption=SERIAL_NUMBER`, convert serials to Dates for date columns), writes via `values.append` /
  `values.update` / `batchUpdate` deleteDimension for deletes (descending row order). An `id` column is added to the tab
  (with the user's consent via the link flow) when missing; rows located by id.
- Cache sheet values for 15 s; serialise writes per spreadsheet; retry 429/5xx with exponential backoff (max 4).
- Tests with an injected fake `fetch` (no network): token flow, read, append, update, delete, id column creation,
  429 retry, serial-date conversion.

## 8. Metadata API (S2: server/routes/meta/*)
Implement the endpoints listed in http.ts for apps, tables (incl. DDL through the connector + TableDef in ab_tables),
columns, connections (+ test, default, source-tables, link, moving tables between connections with a copy of rows),
roles (with CLS/RLS fields), users (+ set password; last-admin guard; disabling), solutions (+ components incl. 'file'),
packages (port the phase-2 YAML package logic from src/platform/core.ts: app and solution packages, import creates new
instances; file components embed the file base64 and import offers database vs file; table rows only into newly
created tables), files routes (wire to the files connector), tables/from-csv, data import/export routes may live in S1.
Validation of names, uniqueness, and the security rules on who may call what.
**Legacy migration** (`server/routes/meta/migrate.ts`, called by S1 after the first admin is created): if
`workspace/workspace.yaml` exists: import apps; import each phase-2 table as a **files-connector table** (copy its CSV
into the files folder as a data file, keep ids) per the owner's wish; import roles; import users without passwords
(status active, they cannot sign in until an admin sets a password); report a summary; rename the legacy files to
`workspace/legacy-phase2/` afterwards (never delete). Seed sample data into MySQL only when there is nothing to migrate.

## 9. Browser client (W1: src/platform)
- `RemotePlatform` implementing PlatformApi over Data API v1 (fetch with `credentials: 'same-origin'` and the CSRF
  header). Selected at startup when `GET /api/v1/status` answers `app: 'appbuilder'`; otherwise the existing demo-mode
  platform (core.ts), which must also be updated to the extended contract (auth no-ops, attachments as data URLs kept in
  IndexedDB, files parsed client-side into normal tables, connections.test returns "Available with the local server").
- Row cache per table, loaded lazily (`ensureLoaded`), refreshed on `reload`, after writes, and on window focus if older
  than 30 s. rows() returns typed values (Date for date/datetime) with `__id`.
- Writes are optimistic (see contract): pre-validate with the TableDef + mirrored EffectivePrivileges, apply to the cache,
  send; on failure roll back, bump dataVersion, emit DataErrorEvent. `flush()` awaits all in-flight writes.
- 401 anywhere -> session = null (UI shows login). Never store credentials or tokens client-side.

## 10. Portal (W2: src/portal)
- Startup gates: setup wizard (step 1 database: host 127.0.0.1, port 3306, database `appbuilder`, user `appbuilder`,
  password field typed by the user, "Create database if missing", Test + Continue; step 2 first admin: name, email,
  password + confirm, strength hint), then login screen; the user menu gets "Change password" and "Sign out"; the
  run-as switcher only in demo mode.
- Connections page becomes real: list with status, kind icons, default badge, device-only badge; create/edit dialogs per
  kind (MySQL: host/port/database/user/password(write-only)/ssl; Google Sheets: spreadsheet URL + service-account JSON
  upload/paste with the service-account email shown and "share your sheet with this email" instructions; Files: link to
  Data files), Test button with result, Set as default (mysql), "Browse tables" (source tables) with Link.
- Data files page (new nav item "Data files"): add file (drop zone; csv/xlsx/json), list with tables per file, modified
  badge, Replace, Download, Remove, "Move to database" per table.
- Tables: connection column + badge; New table picks the connection (default preselected); table designer gets a
  Security tab (read-only summary of who can see what) and attachment column types (file/image with multiple/accept/max size).
- Security roles: role editor adds Maker flag, per-table **Columns** access grid (none/read/update per column, CLS) and
  **Row filter** builder (column, operator, value or "Current user"/"Current user's email") with a plain-language preview
  ("Sales reps see rows where Owner is the current user AND Region = West"). Users: status, set/reset password dialog,
  last login. A "Test as user" preview (admin only: shows row counts and hidden columns per table for a chosen user,
  computed by the server: add `GET /api/v1/security/preview?user=` in S2).
- Data grid: renders attachment cells (thumbnails for images, chips for files) with upload/remove; hides CLS-hidden
  columns automatically (they are absent from the TableDef); read-only columns not editable.

## 11. Studio + runtime (W3: src/runtime, src/studio, controls only where needed)
- Login gate for #studio-/#run- routes in server mode (portal login component reused).
- Use `ensureLoaded` for the app's dataSources on open; show loading state; truncated warning in the Studio error list.
- Writes: `Patch/Collect/Remove/...` use the optimistic API; subscribe to onDataError -> toast in run mode + Studio
  error list + Trace entry; Form `__submit`: insert/update, then upload pending FileUpload files for file/image columns
  (Form fields of type file/image become an upload field), then LastSubmit.
- Image and file columns in DataTable/Gallery/Image controls: attachment ids resolve to `platform.attachments.url(id)`.
- New Fx-facing host helper: `UploadFile(Table, Row, "Column", FileUpload1.Files)` is optional; prefer Form + a
  FileUpload `OnChange` pattern documented in the report.
- Data pane: shows each data source's connection and a device-only badge; Add data lists tables grouped by connection.

## 12. Quality bar
`npm run typecheck` (app + server), `npm test` (all), `npm run build` clean. Server integration tests run against the
sandbox MariaDB (`APPBUILDER_TEST_DB`, see 7.1). No secrets or passwords in logs, errors, audit details or test
snapshots. Report: files, what is verified and how, deviations, and anything another agent must know.
