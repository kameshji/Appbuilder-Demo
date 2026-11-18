# Data API v1

This is the HTTP contract between the browser and a backend. The local Node server implements it today
(`/home/claude/appbuilder-demo/server/core/*`, `/home/claude/appbuilder-demo/server/routes/meta/*`). **The planned PHP gateway for
shared hosting (decision D12 in `/home/claude/appbuilder-demo/docs/decisions.md`) must implement exactly this contract**:
same paths, same JSON shapes, same status codes and error codes, same cookie and CSRF rules. The client does not know which
backend it talks to; `GET /api/v1/status` reports `backend: 'node' | 'php'`.

Sources of truth, in order: the code in `server/core/router.ts` and the `router.add(...)` registrations, then the types in
`/home/claude/appbuilder-demo/src/platform/http.ts` and `/home/claude/appbuilder-demo/src/platform/contracts.ts`. This page was
written by hand from them. Where a doc comment in `http.ts` disagrees with the code, the code is described here (see the
"Known differences" list at the end).

What is not supported: there is no API for per-row sharing, no bulk update, no server-side aggregation (`GroupBy`, `Sum` run in the
browser over at most 5,000 rows), no websockets or server push, no pagination cursors (use `skip` and `top`), and no API tokens
(session cookie only).

## Conventions

- **Base path** `/api/v1`. Routes in the code may be written with or without the prefix; the router strips it
  (`server/core/router.ts`).
- **Bodies.** JSON with `Content-Type: application/json`, except the raw upload routes (attachments, data files). A non-raw
  request with another content type gets 415 `invalid`; invalid JSON gets 422 `invalid`. JSON bodies are limited to 2 MB (413
  `invalid` above that). Raw routes default to 25 MB (`/attachments` allows 200 MB, see below).
- **Cookie.** `ab_session`: HttpOnly, `SameSite=Strict`, `Path=/`, `Secure` when the connection is TLS. The value is a random
  token; the server stores only its SHA-256 (`ab_sessions.id_hash`). Lifetime 7 days, sliding (touched at most every 10 minutes).
  No tokens appear in URLs or in `localStorage`.
- **CSRF.** Every request other than `GET`/`HEAD` must send the header `X-Appbuilder: 1`, otherwise 403 `denied`. If an `Origin`
  header is sent it must be the same origin as `Host`; a `Sec-Fetch-Site: cross-site` request is refused. `Host` must be
  `localhost`, `127.0.0.1` or `::1` (DNS-rebinding guard) unless the server is configured otherwise. A PHP gateway behind a real
  host name has to keep the equivalent checks (same-origin `Origin`, the custom header, `SameSite=Strict`).
- **Security headers** on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `X-Frame-Options: SAMEORIGIN`; JSON responses also carry `Cache-Control: no-store`.
- **Errors.** HTTP status plus `{ "error": { "code", "message", "field"? } }`. Messages are written for makers and never contain
  SQL, passwords or stack traces. Codes:

  | Status | `code` | Meaning |
  | --- | --- | --- |
  | 401 | `unauthenticated` | No valid session (also a wrong login) |
  | 403 | `denied` | Signed in but not allowed; also CSRF header missing; also 429 login/password throttle |
  | 404 | `not-found` | Unknown route, or the object does not exist **or the caller may not know it exists** |
  | 405 | `invalid` | Known path, wrong method |
  | 409 | `conflict` | Duplicate name or key, object in use, setup already done |
  | 413 / 415 / 422 | `invalid` | Body too large, wrong content type, validation failure (`field` names the offending input) |
  | 429 | `denied` | Throttled (8 failed attempts per email+IP, or per user for password changes, in 15 minutes; in memory) |
  | 503 | `unavailable` | The database is not configured or not reachable |
  | 500 | `storage` | Unexpected error; the message is always `Internal server error.` |

- **Auth levels** used below: `none` (a cookie, if present, is still resolved), `user` (any signed-in user), `maker` (role with
  `isMaker` or `isAdmin`), `admin` (`isAdmin`). Missing session: 401. Insufficient level: 403.
- **Values.** Rows travel as flat JSON objects that always contain `id`. Numbers, booleans, strings and `null` only.
  `date` columns are `"YYYY-MM-DD"` (UTC midnight), `datetime` columns are ISO-8601 strings (millisecond precision, UTC),
  `currency` is rounded to 4 decimals, `number` must be an integer, `decimal` is a double. Booleans accept `true/false/1/0/yes/no/y/n`
  on input. `text`, `email`, `phone`, `choice`, `url` are limited to 255 chars (`url` 1024), `multiline` to 16,000,000. Attachment cells
  hold an attachment id or a JSON array of ids. Details: `/home/claude/appbuilder-demo/server/core/values.ts`.
- **Row cap.** A query returns at most `DEFAULT_ROW_CAP` = 5000 rows. If more rows match, the server returns 5000 and
  `truncated: true`. The client never pages through; it works on the first 5,000 rows (decision D10).
- **Timestamps in metadata** (`createdOn`, `modifiedOn`, `lastLogin`, `expiresOn`) are ISO-8601 strings.

### curl setup used by every example

```bash
BASE=http://127.0.0.1:5174/api/v1
JAR=/tmp/ab.jar
H='X-Appbuilder: 1'
JSON='Content-Type: application/json'
# sign in once; the cookie jar keeps ab_session
curl -sS -c $JAR -H "$H" -H "$JSON" -d '{"email":"admin@example.test","password":"a-long-password"}' $BASE/auth/login
```

Every later example uses `-b $JAR` (and `-c $JAR` where the cookie changes).

## First run and session

| Method and path | Auth | Request body | Response |
| --- | --- | --- | --- |
| `GET /status` | none | none | `StatusResponse`: `{ app: 'appbuilder', apiVersion: 1, backend, setup: { needsDatabase, needsAdmin }, storage: { kind: 'mysql', location } \| null, databaseError?, session: Session \| null }` |
| `POST /setup/database` | none, but see below | `{ host, port, database, user, password, createDatabase?, ssl? }` | `{ ok: true }` |
| `POST /setup/admin` | none, only while there are no users | `{ name, email, password }` | `Session` and sets the cookie |
| `POST /auth/login` | none | `{ email, password }` | `Session` and sets the cookie |
| `POST /auth/logout` | none | none | `{ ok: true }` and clears the cookie |
| `GET /auth/session` | user | none | `Session` |
| `POST /auth/password` | user | `{ current, next }` | `Session` (a new cookie; every other session of that user is removed) |

`Session` is `{ user: UserDef, privileges: EffectivePrivileges, expiresOn }`.
`EffectivePrivileges` is `{ isAdmin, isMaker, tables: { [tableId]: { create, read, update, delete, columns, filtered } }, apps: string[] | 'all' }` where
`columns` lists only columns whose effective access is not `update`, and `filtered` is true when a granting role carries a row filter.

Errors and rules:

- `/setup/database`: allowed when the database is not configured, or when no user exists yet, or for an admin. Otherwise 403.
  `port` defaults to 3306 and must be 1..65535, `database` must match `^[A-Za-z0-9_$]{1,64}$`. `ssl` is accepted by the server but is
  not declared in the `SetupDatabaseRequest` type. The connection is tested, the metadata tables are created or upgraded
  (`ab_*`, see `schema.md`), and `workspace/server.json` is written with the password sealed. A failure is 422 or 503 with a
  friendly message (never the password).
- `/setup/admin`: 503 when the database is not configured, 409 when a user already exists, 422 for a weak password (minimum 10
  characters, maximum 1024, must not equal the email). It also seeds the sample data or migrates a phase-2 workspace.
- `/auth/login`: 401 `Invalid email or password.` (the same message for unknown email, wrong password and disabled user, with a
  dummy hash comparison so timing does not reveal which); 429 when throttled. The previous session cookie, if any, is removed
  (rotation).
- `/auth/password`: 422 with `field: 'current'` for a wrong current password, 422 with `field: 'next'` for a weak or unchanged one.

```bash
curl -sS $BASE/status
curl -sS -c $JAR -H "$H" -H "$JSON" -d '{"host":"127.0.0.1","port":3306,"database":"appbuilder","user":"abdev","password":"secret","createDatabase":true}' $BASE/setup/database
curl -sS -c $JAR -H "$H" -H "$JSON" -d '{"name":"Admin","email":"admin@example.test","password":"a-long-password"}' $BASE/setup/admin
curl -sS -b $JAR $BASE/auth/session
curl -sS -b $JAR -c $JAR -H "$H" -H "$JSON" -d '{"current":"a-long-password","next":"another-long-password"}' $BASE/auth/password
curl -sS -b $JAR -H "$H" -X POST $BASE/auth/logout
```

## Workspace

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /workspace` | user | none | `WorkspaceResponse`: `{ apps, tables, roles, users, connections, solutions, dataFiles, session, storage }` |

What each field contains depends on the caller:

- `apps`: all apps for makers; for others only apps they may run.
- `tables`: all tables for makers; for others only tables on which they hold some privilege (`hasAnyTableAccess`). Each table is the
  caller's *visible* definition: columns with column access `none` are removed.
- `roles`: all roles for admins, otherwise only the caller's own roles. `users`: all users for admins, otherwise only the caller.
- `connections`, `solutions`, `dataFiles`: makers only; others get `[]`. Connections never include secrets (`hasSecret` only).

```bash
curl -sS -b $JAR $BASE/workspace
```

## Data (RBAC, RLS and CLS enforced)

A table is addressed by **id or name** (`:table`). A caller who has no privilege on a table at all gets 404, not 403, so table
names do not leak (`ensureTableVisible` in `/home/claude/appbuilder-demo/server/core/data-routes.ts`). Semantics of the checks are in
`security-engine.md`.

### `POST /data/:table/query` (user)

Body (`Query`, every field optional): `{ select?: string[], where?: Condition, orderBy?: [{ col, dir: 'asc'|'desc' }], top?, skip?, count? }`.

- `where` is the `Condition` tree described in `connectors.md` (ops `eq ne lt le gt ge in contains startsWith endsWith isBlank notBlank`,
  plus `and`, `or`, `not`, `const`). Limits: 2000 nodes, depth 32, at most 1000 values in `in`. Larger or malformed trees: 422.
- `top`, `skip`: non-negative integers. If `top` is absent or larger than 5000, 5000 rows are returned and `truncated` says
  whether more matched. If `top` is 5000 or less, exactly that many rows are returned at most, and `truncated` is false.
- `count: true` adds `total` (rows matching `where` and the caller's row filter).
- A column in `select`, `where` or `orderBy` that does not exist: 422. A column the caller may not read (column access `none`): 403.
- The caller's row filter and row scope are ANDed into `where` on the server. Blanks sort last for both directions in the
  in-memory connectors and in MySQL (MySQL sorts `(col IS NULL)` first, then the value); see `connectors.md`.

Response `QueryResponse`: `{ rows, truncated, total? }`.

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" \
  -d '{"where":{"col":"Status","op":"eq","value":"Open"},"orderBy":[{"col":"createdOn","dir":"desc"}],"top":50,"count":true}' \
  $BASE/data/Tickets/query
```

### `POST /data/:table/rows` (user)

Body `{ values: { [column]: value } }` -> `{ row }`.

- Needs the table privilege `create`. System columns (`id`, `createdOn`, `modifiedOn`, `createdBy`, `owner`) in `values` are
  ignored, except that a client may supply a valid UUID `id` (the optimistic client does, so it can reconcile); an `id` that already
  exists is 409. `createdBy` and `owner` are the caller, `createdOn` and `modifiedOn` are now.
- Check order: required columns, unique columns, lookup targets (the referenced row must exist; read access to it is not needed),
  attachments, then the connector insert. Autonumber columns are assigned by the server (`prefix` + a zero-padded 4-digit counter
  from `ab_counters`).
- Columns the caller cannot write (column access below `update`): 403. Unknown column: 422. Wrong type: 422.
- Create does not apply the caller's row filter, so a user may create a row that their own read filter then hides.

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"values":{"Title":"Printer is down","Status":"Open"}}' $BASE/data/Tickets/rows
```

### `PATCH /data/:table/rows/:id` (user)

Body `{ changes: { [column]: value } }` -> `{ row }`. `changes.id`, if present, must equal `:id` (else 422). `modifiedOn` is set.

- A row the caller can read but not update: 403. A row the caller cannot read at all: 404.
- Writing a column the caller may only read, or an unknown column: 403 / 422 as for insert.

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -X PATCH -d '{"changes":{"Status":"Closed"}}' $BASE/data/Tickets/rows/3b1f6f7a-2c1e-4c5e-9d3a-0f7c9d2e8a11
```

### `POST /data/:table/delete` (user)

Body `{ ids: string[] }` -> `{ deleted: number }`. Ids are processed in chunks of 500. If a chunk contains a row the caller can read
but not delete: 403 for that chunk (earlier chunks stay deleted; the operation is not atomic across chunks). Deleting a single id
that deletes nothing is 404. Attachments of deleted rows are removed.

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"ids":["3b1f6f7a-2c1e-4c5e-9d3a-0f7c9d2e8a11"]}' $BASE/data/Tickets/delete
```

### `POST /data/:table/import` (user)

Body `{ csv: string, mode?: 'append' | 'replace' }` (default `append`) -> `{ imported: number }`. `mode` anything else: 422
(`field: 'mode'`); `csv` not text: 422.

- The header row is matched to columns by `name`, then by `displayName`, case-insensitively. Unknown, system, hidden and read-only
  columns are ignored.
- Every row is validated before anything changes; a bad row gives 422 `Row N: ...`.
- `replace` deletes the existing rows the caller may delete, then inserts row by row. That is **not atomic**: a failure in the middle
  leaves a partial import, and the message then ends with `(n rows were imported before this one)`.
- The table privileges needed are the same as for insert (and delete for `replace`).

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" --data-binary @- $BASE/data/Tickets/import <<'EOF'
{"csv":"Title,Status\nPaper jam,Open\n","mode":"append"}
EOF
```

### `GET /tables/:id/csv` (user)

Returns `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="<name>.csv"`: the rows the caller may read, visible
columns only, UTF-8 BOM, CRLF line ends, at most 1,000,000 rows.

```bash
curl -sS -b $JAR -o tickets.csv $BASE/tables/Tickets/csv
```

## Attachments (user)

Attachment cells (`file`, `image`) hold ids of the form `att_<random>`. Bytes live in the attachment store
(`workspace/attachments/<xx>/<key>`), metadata in `ab_attachments`.

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /attachments?table=&column=&rowId=&name=` | raw body, `Content-Type` = file MIME | `AttachmentRef` `{ id, fileName, mime, sizeBytes, url }` |
| `POST /attachments/resolve` | `{ ids: string[] }` | `{ items: AttachmentRef[] }` |
| `GET /attachments/:id` | none; `?download=1` for a download | file bytes |
| `DELETE /attachments/:id` | none | `{ ok: true }` |

- Upload needs `update` column access on that column and the right to update that row (a row the caller cannot read: 404; read but not
  update: 403; a read-only table or column: 403). The column's
  `accept` patterns and `maxSizeMB` (default 25) are enforced; violation: 422. The route accepts up to 200 MB of body, but
  `maxSizeMB` is validated to 1..25 when a column is defined, so 25 MB is the effective limit.
- Reading needs read access to the row that owns the attachment. `GET` answers with the stored MIME, `nosniff`, and a strict
  sandbox CSP; `?download=1` sets `Content-Disposition: attachment`.
- Attachments not linked to a row after the grace period of one hour are removed by a sweep at server start.

```bash
curl -sS -b $JAR -H "$H" -H 'Content-Type: application/pdf' --data-binary @manual.pdf \
  "$BASE/attachments?table=Tickets&column=Scan&rowId=3b1f6f7a-2c1e-4c5e-9d3a-0f7c9d2e8a11&name=manual.pdf"
curl -sS -b $JAR -o out.pdf "$BASE/attachments/att_0123abcd?download=1"
```

## Apps

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /apps/:id` | user (must be allowed to run the app, or maker) | none | `{ meta: AppMeta, definition: AppDef }` |
| `POST /apps` | maker | `{ name, width, height, template?: 'blank' \| 'sample' }` | `AppMeta` |
| `PUT /apps/:id` | maker | `{ definition: AppDef }` | `AppMeta` |
| `PATCH /apps/:id` | maker | `{ name }` | `AppMeta` |
| `POST /apps/:id/duplicate` | maker | none | `AppMeta` |
| `DELETE /apps/:id` | maker | none | `{ ok: true }` |
| `GET /apps/:id/package?data=1` | maker | none | `{ yaml }` |
| `POST /apps/import` | maker | `{ yaml }` | `AppMeta` |

- `width` and `height` must be 200..16000. A duplicate name on create gets a unique label (`Name (2)`). `PATCH` with a name already
  in use: 409. `PUT` with a name that collides keeps the old name silently (it does not return 409).
- `PUT` stores the whole definition; `AppDef` is described in `architecture.md`. The definition is validated structurally; formulas
  are strings and are **not** evaluated by the server.
- `package` produces a YAML document with `kind: appbuilder/app`, `packageVersion: 1`; with `data=1` the rows of the tables the app
  uses are included (only the rows the caller may read). Import always creates a new app (unique name), reuses tables by name, and
  loads rows only into tables it creates. See `/home/claude/appbuilder-demo/server/routes/meta/packages.ts`.
- `POST /apps/import` sets `maxBodyMB: 25` in the code, but the router applies the 2 MB JSON limit to non-raw routes, so a larger
  package gets 413 (see "Known differences").

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"name":"Help desk","width":1920,"height":1080,"template":"blank"}' $BASE/apps
curl -sS -b $JAR "$BASE/apps/app_1a2b3c/package?data=1"
```

## Tables, columns, connections' source tables (maker unless noted)

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `POST /tables` | maker | `{ displayName, name?, description?, columns?, connectionId? }` | `TableDef` |
| `POST /tables/from-csv` | maker | `{ displayName, csv }` (plus optional `connectionId`) | `TableDef` |
| `PATCH /tables/:id` | maker | `{ displayName?, description?, primaryColumn? }` | `TableDef` |
| `DELETE /tables/:id?dropSource=1` | maker | none | `{ ok: true }` |
| `POST /tables/:id/columns` | maker | `ColumnInput` (`displayName`, `type`, ...) | `TableDef` |
| `PATCH /tables/:id/columns/:name` | maker | `Partial<ColumnDef>` | `TableDef` |
| `DELETE /tables/:id/columns/:name` | maker | none | `TableDef` |
| `POST /tables/:id/move` | maker | `{ connectionId }` | `TableDef` |

Rules that clients and a gateway must reproduce:

- `name` must be an identifier (`^[A-Za-z_][A-Za-z0-9_]*$`, unique, not reserved); without it one is derived from `displayName`.
  The physical name is `t_<lowercase name>` on MySQL (de-duplicated with `_2`, `_3`) and is stored in `source`. The prefix `ab_`
  is reserved.
- A new table gets the system columns `id`, `createdOn`, `modifiedOn`, `createdBy`, `owner` plus the requested columns
  (default one `text` column named Name). At most 200 columns.
- Tables on the `files` connection are created by adding a data file, not through `POST /tables`.
- Column edits: the name cannot change (only `displayName`); changing the type checks that existing values convert; a change to
  `autonumber` needs an empty table; `file`/`image` columns cannot be converted; adding a `unique` or `required` column to a table
  with more than one row is refused unless valid; deleting a column that is the target of a `lookup` elsewhere is refused (409).
- `DELETE /tables/:id` also removes the table's role privileges, solution links and file links; `dropSource=1` also drops the
  physical table or sheet.
- `POST /tables/from-csv` sets `maxBodyMB: 25` in the code but is subject to the 2 MB JSON limit (see "Known differences").

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"displayName":"Tickets","columns":[{"displayName":"Title","type":"text","required":true},{"displayName":"Status","type":"choice","choices":["Open","Closed"]}]}' $BASE/tables
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"displayName":"Priority","type":"number"}' $BASE/tables/tbl_1a2b3c/columns
curl -sS -b $JAR -H "$H" -X DELETE "$BASE/tables/tbl_1a2b3c?dropSource=1"
```

## Connections

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `POST /connections` | admin | `{ name, connector, settings?, secret? }` | `ConnectionRef` |
| `PATCH /connections/:id` | admin | `{ name?, settings?, secret?, status? }` | `ConnectionRef` |
| `DELETE /connections/:id` | admin | none | `{ ok: true }` |
| `POST /connections/:id/test` | maker | none | `{ ok, message }` |
| `POST /connections/:id/default` | admin | none | `ConnectionRef` |
| `GET /connections/:id/source-tables` | maker | none | `{ items: SourceTableInfo[] }` |
| `POST /connections/:id/link` | maker | `{ source, displayName?, name? }` | `TableDef` |

- `connector` is one of `mysql`, `files`, `gsheets`. The `files` connection is built in and unique. The two built-in connections are
  `conn_default` (MySQL, the metadata database) and `conn_files` (data files, scope `device`).
- Secrets (database password, service-account key) are write-only: on `PATCH`, omitted keeps the stored secret, `''` clears it. They
  are stored AES-256-GCM sealed in `ab_connections.secret_sealed` and are never returned.
- Delete is refused (409) for the default connection and while tables or data files use it.
- `default` is only valid for a `mysql` connection that tests successfully.
- `link` registers an existing physical table or sheet as a table (read from `source-tables`).

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"name":"Warehouse","connector":"mysql","settings":{"host":"db.internal","port":"3306","database":"wh","user":"app"},"secret":"pw"}' $BASE/connections
curl -sS -b $JAR -H "$H" -X POST $BASE/connections/conn_abc/test
```

## Security administration (admin)

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /roles` | `{ name, description?, isAdmin?, isMaker?, privileges?, apps? }` | `RoleDef` |
| `PATCH /roles/:id` | any of the same fields | `RoleDef` |
| `DELETE /roles/:id` | none | `{ ok: true }` |
| `POST /users` | `{ name, email, roleIds?, status?, password? }` | `UserDef` |
| `PATCH /users/:id` | `{ name?, email?, roleIds?, status? }` | `UserDef` |
| `DELETE /users/:id` | none | `{ ok: true }` |
| `POST /users/:id/password` | `{ password }` | `{ ok: true }` |
| `GET /security/preview?user=<userId>` | none | `{ user, isAdmin, isMaker, status, items, tables }` |

- `privileges` is a list of `TablePrivilege` (`table` id, `create`, `read`, `update`, `delete` scopes `none|own|all`, optional `columns`
  access map and `rowFilter` conditions). Validation: table ids must exist, scopes and column access must be valid, the `id` column
  cannot be hidden, `rowFilter` columns must exist, and the tokens must be exactly `@me` or `@myEmail`. Admin roles store no
  privileges. `apps` is `'all'` or a list of existing app ids.
- Guard (`assertAdminRemains`): after any change at least one active user must still hold an admin role (409 otherwise); a user
  cannot disable or delete themselves. Role and user names/emails are unique (409).
- A password set by an admin removes all sessions of that user (unless it is the admin's own).
- `security/preview` runs the real security engine for the chosen user and counts visible rows per table. `items` is the compact
  form (`tableId`, `visibleRows`, `hiddenColumns`, `readOnlyColumns`); `tables` is the detailed form (`table`, `name`, `displayName`,
  `create`, `read`, `update`, `delete`, `filtered`, `hiddenColumns`, `readOnlyColumns`, `rowCount`, `truncated`, `error?`).

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"name":"Agents","privileges":[{"table":"tbl_1a2b3c","create":true,"read":"all","update":"own","delete":"none"}],"apps":"all"}' $BASE/roles
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"name":"Ann","email":"ann@example.test","roleIds":["role_abc"],"password":"a-long-password"}' $BASE/users
curl -sS -b $JAR "$BASE/security/preview?user=user_abc"
```

## Solutions (maker)

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /solutions` | `{ name, displayName, publisher?, version?, description? }` | `SolutionDef` |
| `PATCH /solutions/:id` | same fields | `SolutionDef` |
| `DELETE /solutions/:id` | none | `{ ok: true }` |
| `POST /solutions/:id/components` | `{ kind: 'app'\|'table'\|'role'\|'connection'\|'file', id }` | `SolutionDef` |
| `DELETE /solutions/:id/components/:kind/:cid` | none | `SolutionDef` |
| `GET /solutions/:id/package?data=1` | none | `{ yaml }` (file components embed the file as base64) |
| `POST /solutions/import` | `{ yaml, filesAs?: 'database' \| 'file' }` (default `database`) | `SolutionDef`, plus `warnings` when something was skipped |

Import creates new instances only; roles and connections are imported only when the caller is an admin (the admin flag is not
imported, and connections arrive without secrets, with a warning). `POST /solutions/import` sets `maxBodyMB: 40` in the code but is
subject to the 2 MB JSON limit.

```bash
curl -sS -b $JAR "$BASE/solutions/sol_abc/package?data=1" -o pkg.json
```

## Data files (maker, device only)

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `POST /files?name=&displayName=` | maker | raw file body (CSV, xlsx or JSON), 25 MB max | `DataFileDef` (one table per sheet is created) |
| `POST /files/:id/replace?name=` | maker | raw file body | `DataFileDef` |
| `GET /files/:id/download` | maker who can read the whole table(s) | none | file bytes (current contents incl. edits) |
| `DELETE /files/:id?dropTables=1` | maker | none | `{ ok: true }` |

```bash
curl -sS -b $JAR -H "$H" -H 'Content-Type: application/octet-stream' --data-binary @people.xlsx "$BASE/files?name=people.xlsx"
```

A PHP gateway on shared hosting does not need to implement these: data files are a device-only feature (decision D8) and the
`files` connection has scope `device`.

## Implementing the contract in another backend

A gateway is conformant when:

1. every path above answers with the same shapes and status codes (the `ApiError` code list above is part of the contract);
2. it enforces RBAC, RLS and CLS exactly as `security-engine.md` describes, server side, on every data route; the client mirror
   is advisory only;
3. it keeps the cookie, CSRF and same-origin rules above;
4. `GET /status` returns `backend: 'php'` and the same `setup` flags so the setup screens work;
5. `Query`/`Condition` semantics match `/home/claude/appbuilder-demo/server/core/condition.ts` (the reference) and the values rules in
   `/home/claude/appbuilder-demo/server/core/values.ts`.

The client detects the backend by calling `GET /api/v1/status` (800 ms timeout); if it does not answer with
`{ app: 'appbuilder' }` the browser falls back to demo mode (see `architecture.md`).

## Known differences between comments, types and code

- `http.ts` comments `POST /api/v1/data/:table/from-csv (on /api/v1/tables/from-csv)`; the real route is `POST /api/v1/tables/from-csv`.
- `http.ts` comments "connections (admins; makers may read)". In code `test`, `source-tables` and `link` are maker-level and the rest
  are admin-only; there is no `GET /connections` (connections come from `GET /workspace`).
- `SetupDatabaseRequest` lacks the `ssl` flag that `/setup/database` accepts.
- `maxBodyMB` on non-raw routes (`/apps/import`, `/tables/from-csv`, `/solutions/import`) is not applied; the 2 MB JSON limit is.
- `GET /tables/:id/csv` is registered twice (in `server/core/data-routes.ts` and `server/routes/meta/tables.ts`); the core one is
  registered first and wins, so the second is dead code.
- The doc comment for `Query.top` says "default and maximum: DEFAULT_ROW_CAP"; the code returns the cap when `top` is larger, as
  described above.
