# Data API v1 (and the v2 query)

This is the HTTP contract between the browser and a backend. The local Node server implements it today
(`/home/claude/appbuilder-demo/server/core/*`, `/home/claude/appbuilder-demo/server/routes/meta/*`). **The planned PHP gateway for
shared hosting (decision D12 in `/home/claude/appbuilder-demo/docs/decisions.md`) must implement exactly this contract**:
same paths, same JSON shapes, same status codes and error codes, same cookie and CSRF rules. The client does not know which
backend it talks to; `GET /api/v1/status` reports `backend: 'node' | 'php'`.

Sources of truth, in order: the code in `server/core/router.ts` and the `router.add(...)` registrations, then the types in
`/home/claude/appbuilder-demo/src/platform/http.ts` and `/home/claude/appbuilder-demo/src/platform/contracts.ts`. This page was
written by hand from them. Where a doc comment in `http.ts` disagrees with the code, the code is described here (see the
"Known differences" list at the end).

What is not supported: there is no API for per-row sharing, no bulk update, no websockets or server push, and no API tokens (session
cookie only). Filtering, sorting, search, keyset paging, exact counts and aggregates run on the server through
[`POST /api/v1/query`](#post-query-user-data-api-v2) (Query v2, P0 package D); `POST /data/:table/query` (v1) stays for one phase.

## Conventions

- **Base path** `/api/v1`. Routes in the code may be written with or without the prefix; the router strips it
  (`server/core/router.ts`).
- **Bodies.** JSON with `Content-Type: application/json`, except the raw upload routes (attachments, data files). A non-raw
  request with another content type gets 415 `invalid`; invalid JSON gets 422 `invalid`. Bodies are limited by the route's `maxBodyMB`
  (JSON and raw alike; 413 `invalid` above it): 2 MB for JSON and 25 MB for raw routes unless the route sets more
  (`POST /apps/import` and `POST /tables/from-csv` 25 MB, `POST /solutions/import` 40 MB). A declared `Content-Length` above the
  limit is refused before the body is read; a body that grows past it is cut off, and after a 413 the server closes the connection.
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
  | 403 | `denied` | Signed in but not allowed (including a row filter a new or changed row would not match); also CSRF header missing, wrong setup code, setup from another computer |
  | 403 | `password_change_required` | The signed-in user must change the password an administrator set; only `GET /auth/session`, `POST /auth/password`, `POST /auth/logout` and `GET /status` work |
  | 401 | `mfa_required` | `POST /auth/login`: the password was right; the body also has `mfa: { methods, rememberDays }`; finish with `POST /auth/login/verify` ([auth.md](auth.md)) |
  | 403 | `reauth_required` | A sensitive action needs `POST /auth/reauth` first |
  | 403 | `mfa_enrolment_required` | The policy requires two-step verification: only the enrolment routes work |
  | 404 | `not-found` | Unknown route, or the object does not exist **or the caller may not know it exists** |
  | 405 | `method_not_allowed` | Known path, wrong method |
  | 409 | `conflict` | Duplicate name or key, object in use, setup already done |
  | 413 / 415 / 422 | `invalid` | Body too large, wrong content type, validation failure (`field` names the offending input) |
  | 429 | `rate_limited` | Throttled: login 8 failures per email+IP in 15 minutes, plus a per-email backoff (from 10 failures in an hour 1 s, 2 s, 4 s ... up to 5 minutes between attempts, 50 block for the hour); password changes 8 per user in 15 minutes; 20 wrong setup codes in 15 minutes. In memory |
  | 503 | `unavailable` | The database is not configured or not reachable |
  | 500 | `storage` | Unexpected error; the message is always `Internal server error.` |

- **Auth levels** used below: `none` (a cookie, if present, is still resolved), `user` (any signed-in user), `maker` (role with
  `isMaker` or `isAdmin`), `admin` (`isAdmin`). Missing session: 401. Insufficient level: 403.
- **Values.** Rows travel as flat JSON objects that always contain `id`. Numbers, booleans, strings and `null` only.
  `date` columns are `"YYYY-MM-DD"` (UTC midnight), `datetime` columns are ISO-8601 strings (millisecond precision, UTC),
  `currency` is rounded to 4 decimals, `number` must be an integer, `decimal` is a double. Booleans accept `true/false/1/0/yes/no/y/n`
  on input. `text`, `email`, `phone`, `choice`, `url` are limited to 255 chars (`url` 1024), `multiline` to 16,000,000. Attachment cells
  hold an attachment id or a JSON array of ids. Details: `/home/claude/appbuilder-demo/server/core/values.ts`.
- **Row cap (v1 only).** A v1 query returns at most `DEFAULT_ROW_CAP` = 5000 rows. If more rows match, the server returns 5000 and
  `truncated: true`. Since package D the browser uses v1 only to hold small tables (at most 2,000 readable rows) whole; everything
  else goes through `POST /query`, which pages with a keyset cursor (decision D10 is superseded by D15).
- **Timestamps in metadata** (`createdOn`, `modifiedOn`, `lastLogin`, `expiresOn`) are ISO-8601 strings.
- **Environment.** Every request works in one [environment](../admin/environments.md). Name it with the header
  `X-Appbuilder-Environment: <id>` (or `?env=<id>` on a `GET`, for links such as attachment URLs; both with different values: 400).
  The server checks it against the session: an unknown id 404, one the user may not enter 403, one that is not ready (failed,
  being created or deleted) 503 with the reason, a malformed id 400. Without it the server uses the user's last environment
  (`POST /environments/:id/select`), else Default, else the first one they may enter. A user who may enter no environment gets 403
  except on `GET /auth/session`, `POST /auth/password`, `GET /environments`, `POST /environments/:id/select`, `GET /workspace` (an
  empty workspace) and the environment admin routes. `Session.environmentId` says which one the privileges belong to.
- **Locked environments.** In a locked production environment the routes that change its design (apps, tables, columns, roles,
  solutions and their components, data files, linking a table; `DESIGN_ROUTES` in `server/core/router.ts`) answer 403 `denied`
  ("This environment is locked ..."), for everybody. Data, users, connections, `POST /solutions/import` and deploying into it work.

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
| `GET /status` | none | none | `StatusResponse`: `{ app: 'appbuilder', apiVersion: 1, backend, setup: { needsDatabase, needsAdmin, unavailable?, incompatible? }, ok, session: Session \| null }`; plus `storage: { kind: 'postgres', location } \| null` (e.g. `PostgreSQL 16.4 at 127.0.0.1:5432/appbuilder`), `databaseError?` and `server: { version, node, database?, schemaVersion }` **for a signed-in administrator only** |
| `POST /setup/database` | none + loopback + setup code, or an admin from loopback; see below | `{ host, port, database, user, password, createDatabase?, ssl?, setupCode? }` | `{ ok: true }` |
| `POST /setup/admin` | none + loopback + setup code, only while there are no users | `{ name, email, password, setupCode? }` | `Session` and sets the cookie |
| `POST /auth/login` | none | `{ email, password }` | `Session` and sets the cookie |
| `POST /auth/login/verify` | none (pending cookie `ab_mfa`) | `{ code, method?: 'totp'\|'recovery_code'\|'email_code', remember? }` | `Session` and sets the cookie. Every other identity route (reset, invitations, MFA, sessions, policy, email, service accounts): list in `server/core/identity/routes.ts`, design in [auth.md](auth.md) |
| `POST /auth/logout` | none | none | `{ ok: true }` and clears the cookie |
| `GET /auth/session` | user | none | `Session` |
| `POST /auth/password` | user | `{ current, next }` | `Session` (a new cookie; every other session of that user is removed) |
| `PATCH /auth/profile` | user | `{ name }` | `UserDef`. Self-service: only the caller's own display name (1-100 characters, trimmed); any other field is refused with 422. Audited as `user.profile` when the name changed |
| `GET /environments` | user | none | `{ items: EnvironmentDef[], max, canCreate, createBlocked? }`: see [Environments](#environments). `GET /workspace` carries the same list as `environments` |

`Session` is `{ user: UserDef, privileges: EffectivePrivileges, expiresOn, environmentId }`.
`EffectivePrivileges` is `{ isAdmin, isInstallAdmin?, isMaker, tables: { [tableId]: { create, read, update, delete, columns, filtered } }, apps: string[] | 'all' }`
(`isAdmin`: administrator of the session's environment; `isInstallAdmin`: install administrator) where
`columns` lists only columns whose effective access is not `update`, and `filtered` is true when a granting role carries a row filter.

Errors and rules:

- Both setup routes accept only connections whose TCP peer is loopback (127.0.0.0/8, `::1`, `::ffff:127.*`); others get 403
  whatever headers they send. Without an admin session they need the one-time setup code the server prints on its console
  (`setupCode` in the body or header `X-Appbuilder-Setup-Code`, case/space/dash-insensitive), else 403 with `field: 'setupCode'`;
  20 wrong codes in 15 minutes give 429. The code rotates when the administrator is created.
- `/setup/database`: allowed for an admin, or (with the code) while no administrator exists. Once `server.json` records
  `setupComplete`, it is refused without an admin session: 403 while the database is reachable, 409 while it is not (the database
  is then changed on disk). 409 also when the database is incompatible (schema too new), 503 when the user count cannot be read.
  The fields describe a **PostgreSQL** database: `host`, `port` (default 5432, 1..65535), `database` (must match
  `^[A-Za-z_][A-Za-z0-9_$]{0,62}$`), `user`, `password`, `ssl` (TLS 1.2+, certificate verified) and `createDatabase` (`CREATE
  DATABASE ... ENCODING 'UTF8'` through the `postgres` maintenance database when it is missing; needs `CREATEDB`, skipped with a log
  line when the role lacks it). The connection is tested, schema `ab` and the environment schema `env_default` are created or
  upgraded (see `schema.md`), and `workspace/server.json` is written with the password sealed. Failures are 422 with a friendly
  message that never contains the password: wrong user name or password, database does not exist, connection refused, no
  `pg_hba.conf` entry, SSL not supported, the role may not create schemas in the database (`field: 'user'`, with the `GRANT` /
  `ALTER DATABASE ... OWNER` to run), the database is not UTF8 or holds an old MySQL-era schema (`field: 'database'`); 503 when the
  schema is newer than this server.
- `/setup/admin`: 503 when the database is not configured, 409 when a user already exists, 422 for a weak password (minimum 10
  characters, maximum 1024, must not equal the email). It also seeds the sample data or migrates a phase-2 workspace.
- `/auth/login`: 401 `Invalid email or password.` (the same message for unknown email, wrong password and disabled user, with a
  dummy hash comparison so timing does not reveal which); 429 when throttled. The previous session cookie, if any, is removed
  (rotation).
- `/auth/password`: 422 with `field: 'current'` for a wrong current password, 422 with `field: 'next'` for a weak or unchanged one.

```bash
curl -sS $BASE/status
curl -sS -c $JAR -H "$H" -H "$JSON" -d '{"host":"127.0.0.1","port":5432,"database":"appbuilder","user":"appbuilder","password":"secret","createDatabase":true}' $BASE/setup/database
curl -sS -c $JAR -H "$H" -H "$JSON" -d '{"name":"Admin","email":"admin@example.test","password":"a-long-password"}' $BASE/setup/admin
curl -sS -b $JAR $BASE/auth/session
curl -sS -b $JAR -c $JAR -H "$H" -H "$JSON" -d '{"current":"a-long-password","next":"another-long-password"}' $BASE/auth/password
curl -sS -b $JAR -H "$H" -X POST $BASE/auth/logout
```

## API keys (bearer authentication)

Service accounts (Admin console > Service accounts, [admin guide](../admin/sign-in-and-identity.md#service-accounts-and-api-keys))
call the Data API with `Authorization: Bearer abk_<prefix>_<secret>`:

- Reachable: `POST /query`, `/data/...`, `/attachments...`, `GET /tables` and `GET /tables/:id`, `GET /auth/session`.
  Anything else: 403.
- No `X-Appbuilder` header needed (a bearer token is never attached by a browser on its own, so there is no CSRF risk).
  Cookies are ignored when the header is present: the request is the service account's, never the browser user's.
- The environment is the key's; `X-Appbuilder-Environment` naming another one is 403.
- 401 for an unknown, revoked or expired key (same message), 403 outside the allow-list, 429 with `Retry-After` past the
  key's rate (default 600 a minute), 429 after 30 invalid keys from one address in 5 minutes.

```bash
KEY=abk_XXXXXXXX_...           # shown once when the key was created
BASE=http://localhost:5174/api/v1
# who am I
curl -sS -H "Authorization: Bearer $KEY" $BASE/auth/session
# read rows (Query v2)
curl -sS -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"plan":{"version":2,"table":"Readings","sort":[{"col":"createdOn","dir":"desc"}],"page":{"size":50}}}' \
  $BASE/query
# add a row (needs Create on the table through the account's roles)
curl -sS -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"values":{"Value":42}}' $BASE/data/Readings/rows
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

### `POST /query` (user): Data API v2

Body `{ plan: QueryPlan }` (`src/platform/query.ts`; semantics in `query-v2.md`). The table is `plan.table` (name or id); a caller
with no privilege on it gets 404 as for v1. Response `QueryV2Response`: `{ rows, count?, nextCursor?, truncated? }`.

- **Plan.** `filter` (ConditionV2: `isNull`, `eq ne lt le gt ge` with a literal of the column's kind, `in`, `contains`, `startsWith`,
  `endsWith`, `cmpCol`, `cmpExpr` over computed numbers, `and`, `or`, `not`, `const`), `search { text, columns }`, `sort [{ col, dir }]`,
  `take { n, from }`, `aggregate { groupBy, measures, sort?, as? }` (measures `sum avg min max` over a number column or an expression,
  `count` with an optional filter), `select`, `count`, `single`, `page { size, cursor? }`. Stages: filter and search, sort, take,
  aggregate, select, count / single / page.
- **Rows.** Values as in v1 (dates `YYYY-MM-DD`, datetimes ISO). Rows plans always include `id`; without `select` every column the
  caller may read. Aggregate rows have the group columns (renamed by `as`) and the measures (numbers; `avg` of nothing is `null`).
- **Paging.** `page.size` 0..500; `nextCursor` is the opaque cursor of the next page or `null` on the last one. Send the same plan with
  `page.cursor` for the next page. `count: true` adds the exact number of result rows (after take and aggregate, before paging).
- **Security.** RBAC, the caller's row scope and role row filters are part of the one SQL statement on PostgreSQL, so rows, counts
  and aggregates only cover rows the caller may read. A column the caller may not read (column access `none`) named anywhere in the
  plan (select, filter, sort, search, groupBy, measures, measure filters) is 403 `denied` with `field` = the column.
- **Errors.** 422 `invalid` for a malformed plan (unknown column or operator, a literal of the wrong kind, `page.size` above 500, a
  cursor for another sort or a forged one), an unpaged rows plan with more than 5,000 rows, an aggregate with more than 5,000 groups,
  division by zero or an out-of-range number ("That result isn't a valid number"); 503 `unavailable` when the query runs longer than
  the statement timeout (15 s, `APPBUILDER_QUERY_TIMEOUT_MS`).
- **Connectors.** PostgreSQL tables (the default connection and external PostgreSQL connections) run the plan in the database. MySQL,
  data files and Google Sheets run it over at most the first 5,000 readable rows and say `truncated: true` when there were more
  (`query-v2.md` section 14).

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" \
  -d '{"plan":{"version":2,"table":"Tickets","filter":{"col":"Status","op":"eq","value":"open"},"sort":[{"col":"Due","dir":"asc"}],"count":true,"page":{"size":50}}}' \
  $BASE/query
# next page: the same plan with "page":{"size":50,"cursor":"<nextCursor>"}
curl -sS -b $JAR -H "$H" -H "$JSON" \
  -d '{"plan":{"version":2,"table":"Orders","aggregate":{"groupBy":["Region"],"measures":[{"name":"Revenue","fn":"sum","expr":{"fn":"mul","args":[{"col":"Qty"},{"col":"Price"}]}}]}}}' \
  $BASE/query
```

### `POST /data/:table/query` (user)

Body (`Query`, every field optional): `{ select?: string[], where?: Condition, orderBy?: [{ col, dir: 'asc'|'desc' }], top?, skip?, count? }`.

- `where` is the `Condition` tree described in `connectors.md` (ops `eq ne lt le gt ge in contains startsWith endsWith isBlank notBlank`,
  plus `and`, `or`, `not`, `const`). Limits: 2000 nodes, depth 32, at most 1000 values in `in`. Larger or malformed trees: 422.
- `top`, `skip`: non-negative integers. If `top` is absent or larger than 5000, 5000 rows are returned and `truncated` says
  whether more matched. If `top` is 5000 or less, exactly that many rows are returned at most, and `truncated` is false.
- `count: true` adds `total` (rows matching `where` and the caller's row filter).
- A column in `select`, `where` or `orderBy` that does not exist: 422. A column the caller may not read (column access `none`): 403.
- Without `orderBy` rows come in insertion order (SQL connectors: `ORDER BY createdOn, id`; row ids are time-ordered UUIDv7; the
  file and Google Sheets connectors keep file/sheet order). The same keys break ties of an explicit sort.
- The caller's row filter and row scope are ANDed into `where` on the server. Blanks sort last for both directions in every
  connector (SQL sorts the blank test first, then the value); text compares and sorts case-insensitively by code point on
  PostgreSQL and in memory; see `connectors.md`.

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
- Row filters apply to create like `WITH CHECK` in Postgres RLS: the new row (after defaults) must match the row filter of at least
  one role that grants `create` (OR over those roles; `@me`/`@myEmail` resolved); otherwise 403 and nothing is written. A role
  granting create without a row filter allows any row. Administrators are not checked.

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"values":{"Title":"Printer is down","Status":"Open"}}' $BASE/data/Tickets/rows
```

### `PATCH /data/:table/rows/:id` (user)

Body `{ changes: { [column]: value } }` -> `{ row }`. `changes.id`, if present, must equal `:id` (else 422). `modifiedOn` is set.

- A row the caller can read but not update: 403. A row the caller cannot read at all: 404.
- The row must match the caller's update predicate before **and after** the change (`WITH CHECK`); a change that would move it out
  of that predicate is 403 and nothing is written. Leaving the caller's *read* filter is allowed (the row then disappears for them).
- Writing a column the caller may only read, or an unknown column: 403 / 422 as for insert.
- **Optimistic concurrency** (optional): `ifModifiedOn` = the row's `modifiedOn` the caller started from (ISO time). When the row
  was saved since (by anyone), the answer is **409** `{ error: { code: 'conflict', field: 'modifiedOn', message }, current, changedBy? }`:
  `current` is the row as the caller may see it now (hidden columns left out), `changedBy` `{ id, name }` who saved it last when the
  server knows. The check runs after the permission checks (a 409 never reveals a row the caller may not change) and the write is
  guarded by the same version, so two saves racing each other cannot both win. Malformed `ifModifiedOn`: 422. Forms send it.

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -X PATCH -d '{"changes":{"Status":"Closed"}}' $BASE/data/Tickets/rows/3b1f6f7a-2c1e-4c5e-9d3a-0f7c9d2e8a11
# only if nobody saved it since the version I loaded
curl -sS -b $JAR -H "$H" -H "$JSON" -X PATCH -d '{"changes":{"Status":"Closed"},"ifModifiedOn":"2026-11-18T09:30:12.345Z"}' $BASE/data/Tickets/rows/3b1f6f7a-2c1e-4c5e-9d3a-0f7c9d2e8a11
```

Writes may carry `X-Appbuilder-Live: <connection id>` (the browser's live socket): the resulting `table` message reaches that
socket marked `self` (see `live.md`).

### `POST /data/:table/delete` (user)

Body `{ ids: string[] }` -> `{ deleted: number }`. All or nothing: the permission of every target row is checked first; if any row
the caller can read may not be deleted, the answer is 403 and nothing is deleted. The rows are then deleted in one connector call
(PostgreSQL: chunks of 5,000 ids, MySQL: chunks of 500, inside one transaction). Ids the caller cannot read are skipped. Deleting a single id that deletes nothing is 404. Attachments of deleted rows are removed.

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"ids":["3b1f6f7a-2c1e-4c5e-9d3a-0f7c9d2e8a11"]}' $BASE/data/Tickets/delete
```

When the table keeps deleted rows ([recycle-bin.md](recycle-bin.md)) the rows go to its recycle bin and the answer also
carries `batch` (`{ id, tableId, tableName, rows, rootIds, deletedBy, deletedOn, expiresOn, daysLeft, source, state,
finalRows }`: what "Undo" restores); attachments then stay until the purge. Without a recycle bin there is no `batch`.

### Recycle bin (user unless noted)

| Route | Body / query | Answer |
| --- | --- | --- |
| `GET /data/:table/deleted` | `?limit` (1-500, default 100) `&skip` `&batch` | `{ rows, total, batches }`: rows the caller could delete and can see (administrators: all), newest first, each with `__deleted { on, by, byName, batch, expiresOn, daysLeft, rootTable, rootTableName, cascaded, batchRows, source }` |
| `POST /data/:table/restore` | `{ batch }` or `{ rowId }` | `{ restored, batch, tables: [{ tableId, rows }], warnings }`; 409 when a unique value is used again, a parent is in another batch or gone, or (non-administrators) the delete removed rows of a table without a bin; 403/404 for rows the caller may not restore |
| `POST /recycle/restore` | `{ batch }` | as above, by batch id alone (the batch's table decides) |
| `POST /data/:table/purge` | `{ batch }` or `{ all: true, confirm: "<table name>" }` | administrators: `{ rows }` / `{ batches, rows }`, deleted for good now |
| `GET /data/:table/recycle` | `?batch` | `{ enabled, keepDays }`; makers and administrators also `deletedRows`, `bytes`, `batches`; with `batch`: `{ batch }` |

The table setting is `PATCH /tables/:id { recycleDays }` (0 = off, 1-3,650; `POST /tables` takes it too, default 30 on the
default database).

### `POST /data/:table/import` (user)

Body `{ csv: string, mode?: 'append' | 'replace' }` (default `append`) -> `{ imported: number }`. `mode` anything else: 422
(`field: 'mode'`); `csv` not text: 422.

- The header row is matched to columns by `name`, then by `displayName`, case-insensitively. Unknown, system, hidden and read-only
  columns are ignored.
- Every row is built and checked (types, required, unique within the file and against the table, lookups, the create row filter)
  before anything changes; a bad row gives `Row N: ... (nothing was imported)` with the status of the failed check.
- `replace` deletes the existing rows the caller may delete and inserts the new rows; the new rows may reuse ids and unique values
  of the rows they replace. On PostgreSQL and MySQL the delete and the inserts run in one transaction. On connectors without transactions
  (files, Google Sheets) the delete and the insert are two writes, see `connectors.md`.
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

Attachment cells (`file`, `image`) hold ids of the form `att_<random>`. Bytes live in the attachment store of the environment
(`workspace/env/<environment>/attachments/<xx>/<key>`), metadata in its `ab_attachments`. `AttachmentRef.url` names the environment
(`/api/v1/attachments/<id>?env=<environment>`), so a link opened without the header reads from the right one; an id from another
environment answers 404.

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /attachments?table=&column=&rowId=&name=` | raw body, `Content-Type` = file MIME | `AttachmentRef` `{ id, fileName, mime, sizeBytes, url }` |
| `POST /attachments/resolve` | `{ ids: string[] }` | `{ items: AttachmentRef[] }` |
| `GET /attachments/:id` | none; `?download=1` for a download | file bytes |
| `DELETE /attachments/:id` | none | `{ ok: true }` |

- Upload needs `update` column access on that column and the right to update that row (a row the caller cannot read: 404; read but not
  update: 403; a read-only table or column: 403). The column's
  `accept` patterns are enforced (422). The size limit is the column's `maxSizeMB` (validated to at most 25 when the column is
  defined; default 25), and the route never accepts more than 25 MB. A `Content-Length` above the column limit is refused with 413
  before the body is read; a streamed body is cut off with 413 as soon as it passes the limit (the connection is then closed).
  Permission is checked before the body is read.
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
  in use: 409. `PUT` with a definition whose name collides with another app: 409 as well (nothing is saved).
- `PUT` stores the whole definition; `AppDef` is described in `architecture.md`. The definition is validated structurally; formulas
  are strings and are **not** evaluated by the server.
- `package` produces a YAML document with `kind: appbuilder/app`, `packageVersion: 1`; with `data=1` the rows of the tables the app
  uses are included (only the rows the caller may read). Import always creates a new app (unique name), reuses tables by name, and
  loads rows only into tables it creates. See `/home/claude/appbuilder-demo/server/routes/meta/packages.ts`.
- `POST /apps/import` accepts bodies up to 25 MB (`maxBodyMB: 25`).

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
| `POST /tables/:id/assign-owner` | admin | `{ userId? }` (default: the caller) | `{ updated }` |
| `POST /tables/:id/columns` | maker | `ColumnInput` (`displayName`, `type`, ...) | `TableDef` |
| `PATCH /tables/:id/columns/:name` | maker | `Partial<ColumnDef>` | `TableDef` |
| `DELETE /tables/:id/columns/:name` | maker | none | `TableDef` |
| `POST /tables/:id/move` | maker | `{ connectionId }` | `TableDef` |

Rules that clients and a gateway must reproduce:

- `name` must be an identifier (`^[A-Za-z_][A-Za-z0-9_]*$`, unique, not reserved); without it one is derived from `displayName`.
  The physical name is `t_<lowercase name>` on PostgreSQL and MySQL (de-duplicated with `_2`, `_3`; on the default connection inside
  the environment schema, `env_default.t_orders`) and is stored in `source`. The prefix `ab_` is reserved.
- Table and column changes on the default connection are one transaction each (metadata, `CREATE`/`ALTER TABLE` and indexes): a
  failure leaves nothing behind. App and solution imports likewise.
- A new table gets the system columns `id`, `createdOn`, `modifiedOn`, `createdBy`, `owner` plus the requested columns
  (default one `text` column named Name). At most 200 columns.
- Tables on the `files` connection are created by adding a data file, not through `POST /tables`.
- Column edits: the name cannot change (only `displayName`); changing the type checks that existing values convert; a change to
  `autonumber` needs an empty table; `file`/`image` columns cannot be converted; adding a `unique` or `required` column to a table
  with more than one row is refused unless valid; deleting a column that is the target of a `lookup` elsewhere is refused (409).
- `DELETE /tables/:id` also removes the table's role privileges, solution links and file links. By default the physical table
  stays. `dropSource=1` also drops it, and is refused (422) unless Appbuilder created it (`TableDef.managed`, or a data-file
  table): linked tables are never dropped.
- `DELETE /tables/:id/columns/:name` on a linked table (not `managed`) only removes the column from the definition (no
  `ALTER TABLE`); on other tables it drops the physical column.
- `POST /tables/:id/assign-owner` sets `owner` on every row whose owner is blank (rows of a linked table that existed before);
  422 for read-only tables and tables without an `owner` column, 404 for an unknown user.
- Rows created by `POST /tables/from-csv`, `POST /data/:table/import` and app/solution imports with data get the importing user as
  `owner` and `createdBy`.
- `POST /tables/from-csv` accepts bodies up to 25 MB (`maxBodyMB: 25`); the rows are stored in CSV order and read back in that order.

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"displayName":"Tickets","columns":[{"displayName":"Title","type":"text","required":true},{"displayName":"Status","type":"choice","choices":["Open","Closed"]}]}' $BASE/tables
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"displayName":"Priority","type":"number"}' $BASE/tables/tbl_1a2b3c/columns
curl -sS -b $JAR -H "$H" -X DELETE "$BASE/tables/tbl_1a2b3c"              # keeps the physical table
curl -sS -b $JAR -H "$H" -X DELETE "$BASE/tables/tbl_1a2b3c?dropSource=1"  # also drops it (tables Appbuilder created only)
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
| `POST /connections/:id/link` | maker | `{ source, displayName?, name?, readOnly?, ensureIdColumn? }` | `TableDef` |

- `connector` is one of `postgres`, `mysql`, `files`, `gsheets`, `http`, `email` (the last two offer actions, see
  [Connector actions](#connector-actions); their settings are checked by the provider and their test calls the API or checks
  the mail relay). An `http` secret is one JSON object (`apiKey`, `password`, `token`, `clientSecret`, `headers`). The `files` connection is built in and unique. The two built-in
  connections are `conn_default` (`postgres`: the system database, tables in the environment schema) and `conn_files` (data files,
  scope `device`).
- `postgres` settings: `host`, `port` (default `5432`), `database`, `user`, `ssl`, `schema` (default `public`; `ab`, `env_*`, `pg_*`
  and `information_schema` are refused with 422 `field: 'settings.schema'`). `mysql` settings: the same without `schema`, port
  `3306`.
- Secrets (database password, service-account key) are write-only: on `PATCH`, omitted keeps the stored secret, `''` clears it. They
  are stored AES-256-GCM sealed in `ab_connections.secret_sealed` and are never returned.
- Delete is refused (409) for the default connection and while tables or data files use it. `PATCH` on `conn_default` is refused
  (400): it is rewritten from `server.json` / `APPBUILDER_DB_*` at every start.
- `default` is only valid for a `postgres` connection that tests successfully (422 otherwise: "Only a PostgreSQL connection can be
  the default store for new tables").
- `link` registers an existing physical table or sheet as a table (read from `source-tables`). 409 when that source is already
  linked through this connection or another one to the same store (same host, port and database, and for PostgreSQL the same schema;
  `localhost` = `127.0.0.1` = `::1`; same spreadsheet id); the message names the existing table. `source-tables` leaves such tables out.
- A source lacking system columns (`id`, `createdOn`, `modifiedOn`, `createdBy`, `owner`): with `ensureIdColumn: true` they are
  added (PostgreSQL and MySQL: `ALTER TABLE ... ADD COLUMN`, a missing `id` is filled with UUIDv7 and gets a unique key, on
  PostgreSQL in one transaction; Google Sheets: the `id`
  column is added and filled, the others as headers) and the table is writable; without it the table is `readOnly` with
  `missingSystem` listing what is missing, and no query names those columns.

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"name":"Warehouse","connector":"postgres","settings":{"host":"db.internal","database":"wh","user":"app","schema":"sales"},"secret":"pw"}' $BASE/connections
curl -sS -b $JAR -H "$H" -X POST $BASE/connections/conn_abc/test
```

## Connector actions

P1 package D ([connectors.md](connectors.md#connector-actions)). "use" and "manage" are the connection's grants;
administrators have both.

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /actions/kinds` | maker | none | `{ items: { kind, label, description, tables, actions: ActionDef[] }[] }` |
| `GET /actions/connections` | user | none | `{ items: { id, name, connector, status, canManage }[] }` the caller may use |
| `GET /connections/:id/actions` | use | none | `{ items: ActionDef[] }` (built-in, then custom) |
| `GET /connections/:id/actions/:action` | use | none | `ActionDef` |
| `POST /connections/:id/actions/:action/test` | use | `{ inputs, idempotencyKey? }` | `ActionResult` (`{ ok, output }` or `{ ok: false, error: { code, message, retryable, status? } }`, plus `runId`, `durationMs`, `replayed`) |
| `PUT /connections/:id/custom-actions/:action` | manage | `{ id?, title, description, inputs, outputs?, idempotent?, sideEffect?, timeoutMs?, http: { method, path, params?, query?, headers?, bodyFields?, bodyInput?, bodyTemplate?, expectStatus?, outputPath?, sample? } }` | `ActionDef` (outputs inferred from `sample` when not given) |
| `DELETE /connections/:id/custom-actions/:action` | manage | none | `{ ok: true }` |
| `POST /connections/:id/custom-actions/openapi` | manage | `{ text, apply?, replace?, only?: string[] }` (3 MB) | preview `{ title, version, baseUrl, auth, warnings, actions: { id, title, method, path, sideEffect, exists }[], applied, imported? }` |
| `GET /connections/:id/access` | manage | none | `{ items: { principalKind, principalId, level, grantedBy, grantedOn }[] }` |
| `PUT /connections/:id/access` | admin | `{ grants: { principalKind: 'role'\|'user', principalId, level: 'use'\|'manage' }[] }` | the new list (audited `connection.access`) |
| `GET /connections/:id/activity?limit&before` | use | none | `{ items, all }` (all: managers see everyone's calls, others their own) |
| `GET /connections/:id/state` | use | none | `{ circuit, failures, retryAt, inFlight, maxConcurrent, perMinute, maxTimeoutMs, lastError, secretParts }` |
| `POST /connections/:id/state/reset` | manage | none | the state (circuit closed) |
| `GET /admin/mail-suppressions?search&offset&limit`, `POST /admin/mail-suppressions` `{ address, note? }`, `DELETE /admin/mail-suppressions/:address` | install administrator | | `{ items, total }` / `{ ok: true }` |

Error codes of actions are listed in [reference/connector-actions.md](../reference/connector-actions.md).

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"inputs":{"id":"C-1"}}' $BASE/connections/conn_abc/actions/getCustomer/test
```

### Webhooks

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /flows/:flowId/webhooks` | may change the flow | none | `{ items: WebhookInfo[] }` (token hint only) |
| `POST /flows/:flowId/webhooks` | may change the flow | `{ name?, requireSignature? (true), toleranceSeconds? (300), maxBodyKB? (256), perMinute? (60), enabled? }` | `{ hook, token, secret, url, note }`: token and secret shown once |
| `PATCH /webhooks/:id` | may change the flow | same fields | `WebhookInfo` |
| `POST /webhooks/:id/rotate` | may change the flow | `{ token?: true, secret?: true }` | `{ hook, token?, secret?, url? }` |
| `DELETE /webhooks/:id` | may change the flow | none | `{ ok: true }` |
| `POST /hooks/:env/:flowId/:token` | none (token, signature) | JSON, form or text body; `X-Appbuilder-Signature: t=..,v1=..`; optional `X-Appbuilder-Delivery` | 202 `{ accepted: true, id }`; 401, 404, 409, 413, 415, 429, 503 ([webhook security](../admin/webhook-security.md)) |

### Scheduled reports

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /reports` | user | none | `{ items: ReportInfo[] }`: own, received, all for administrators |
| `POST /reports/preview` | user | `{ def }` | `{ columns, rows (50), total, truncated }` computed as the caller |
| `POST /reports` | user | `ReportDef` (`name`, `source: { kind: 'table', tableId, plan, builder? } \| { kind: 'formula', formula }`, `schedule: { frequency, time?, weekday?, day?, minute?, cron?, timeZone }`, `recipients: { userIds, teamIds }`, `runAs: 'recipient' \| { serviceAccount }` (administrators), `inlineRows`, `csvRows`, `onEmpty`, `enabled`) | `ReportInfo`; other recipients than oneself need maker; a dry run as the caller must work (422/403) |
| `PATCH /reports/:id` | owner or admin | same fields | `ReportInfo` |
| `DELETE /reports/:id` | owner or admin | none | `{ ok: true }` |
| `POST /reports/:id/run` | recipient, owner, admin | none | `{ jobId }` (owner/admin: everyone; a recipient: their own copy) |
| `GET /reports/:id/runs` | recipient, owner, admin | none | `{ items }` (recipients see their own line) |

## Security administration (admin)

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /roles` | `{ name, description?, isAdmin?, isMaker?, privileges?, apps? }` | `RoleDef` |
| `PATCH /roles/:id` | any of the same fields | `RoleDef` |
| `DELETE /roles/:id` | none | `{ ok: true }` |
| `POST /users` | `{ name, email, roleIds?, status?, password?, isInstallAdmin? }` (install admin) | `UserDef` |
| `PATCH /users/:id` | `{ name?, email?, roleIds?, status?, isInstallAdmin? }` | `UserDef` |
| `DELETE /users/:id` | none | `{ ok: true }` |
| `POST /users/:id/password` | `{ password }` | `{ ok: true }` |
| `GET /security/preview?user=<userId>` | none | `{ user, isAdmin, isMaker, status, items, tables }` |
| `GET /audit?action=&user=&from=&to=&page=&pageSize=` | none | `{ items, total, page, pageSize, actions }`, newest first |

- `privileges` is a list of `TablePrivilege` (`table` id, `create`, `read`, `update`, `delete` scopes `none|own|all`, optional `columns`
  access map and `rowFilter` conditions). Validation: table ids must exist, scopes and column access must be valid, the `id` column
  cannot be hidden, `rowFilter` columns must exist, and the tokens must be exactly `@me` or `@myEmail`. Admin roles store no
  privileges. `apps` is `'all'` or a list of existing app ids.
- Accounts are install-wide: `POST /users`, `DELETE /users/:id`, setting someone else's password, and changing `name`, `email`,
  `status` or `isInstallAdmin` need an **install administrator** (403 otherwise). `roleIds` are the roles in the request's
  environment and need its administrator (the route's `admin` level); giving a user a role there also gives them access to it.
- Guards: `assertAdminRemains`, after any change at least one active user must still hold an admin role in the environment;
  `assertInstallAdminRemains`, at least one active install administrator must remain (409 otherwise); a user cannot disable or
  delete themselves or remove their own install-admin flag. Role and user names/emails are unique (409).
- A password set by an admin removes all sessions of that user (unless it is the admin's own).
- `audit`: `action` is an exact action name or a prefix ending in `.` (`auth.`); `user` a user id; `from` (inclusive) and
  `to` (exclusive) a date (`2026-11-18`) or an ISO timestamp; `page` from 1; `pageSize` 1-200 (default 50). Bad values
  give 422. Each item is `{ id, at, userId, userName?, userEmail?, action, tableId, rowId, details }` (details parsed
  from JSON); `actions` lists every action name in the log, for a filter.
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
| `POST /solutions/import/plan` | `{ yaml, asCopy? }` | `SolutionPlan` (nothing is changed) |
| `POST /solutions/import` | `{ yaml, filesAs?: 'database' \| 'file', confirm?, asCopy? }` (default `database`) | `SolutionImportResult`: the `SolutionDef`, `warnings?`, `plan`, `backup?: { taken, message }` |
| `POST /solutions/:id/deploy` | `{ target, plan?: true, confirm?, includeData?, filesAs? }` | `plan: true`: the `SolutionPlan` in `target`; otherwise `SolutionImportResult` |

**Stable ids** (`server/routes/meta/alm.ts`). A package carries the solution's id (`solution.id`) and its components' ids. Importing
matches them in the request's environment:

- nothing matches: **install** (`plan.mode: 'install'`), components are created with the package's ids; no `confirm` needed;
- the solution or any app or table matches by id: **upgrade in place** (`'upgrade'`). The request needs `confirm` equal to
  `plan.token` of a plan computed for the same package and the same state of the environment (409 `conflict` without it or when
  something changed meanwhile), and an administrator of the environment (a problem in the plan otherwise). Roles matching by id do
  not make it an upgrade (the built-in ones have the same ids everywhere).

`SolutionPlan` is `{ mode, solution: { id, name, displayName, version, fromVersion? }, target: { id, name, type, locked? }, items,
destructive, problems, warnings, backup: { available, message }, token }`. Each item `{ kind, id, name, change: 'new' | 'changed' |
'unchanged' | 'removed', destructive?, note?, columns? }`; `columns` (tables) are `{ name, change: 'added' | 'removed' | 'type' |
'changed', from?, to?, destructive? }`. Dropped tables and columns are `destructive`. `removed` comes from the previous version of
the solution in that environment (its components the package no longer has). Any `problems` refuse the import with 422.

Applying runs in **one transaction** (`Services.transaction`; PostgreSQL DDL included): new tables are created (rows from the
package only into them), changed tables get their columns dropped, added (with defaults and autonumbers filled), and converted
(every value is checked first; one that does not convert stops everything, 422), apps are replaced, roles get their privileges on
the solution's tables and their apps replaced (others kept, the admin flag never imported), removed apps, roles and tables are
deleted. Before it, `backup.snapshot(environment, reason, { trigger: 'pre-upgrade' })` takes a backup of the target
(`server/core/backup/service.ts`); `result.backup` is `{ taken, message, id?, failed? }`. When that backup **fails** the
import answers **409 with `field: "backup"`** and nothing changes; sending `proceedWithoutBackup: true` (import and deploy
bodies) goes on without it. With automatic backups off, `plan.backup.available` is false and the import goes on with the
message as a warning. Audited as `solution.install` / `solution.upgrade` in the environment and, for a deployment, `solution.deploy`
in `ab.audit`.

`asCopy: true`, and packages without a solution id (exported before 0.5), keep the old behaviour: new instances only (new ids, unique
names, tables reused by name), audited as `solution.import`. Roles and connections are imported only when the caller is an admin
(the admin flag is not imported, and connections arrive without secrets, with a warning). Bodies up to 40 MB (`maxBodyMB: 40`).

`deploy` exports the solution from the request's environment (`includeData`: rows for tables the deployment creates) and imports it
into `target` in one request; the caller needs access to the target and the Maker role there (an upgrade: its administrator).

```bash
curl -sS -b $JAR "$BASE/solutions/sol_abc/package?data=1" -o pkg.json
```

## Environments

| Method and path | Who | Request | Response |
| --- | --- | --- | --- |
| `GET /environments` | user | none | `{ items: EnvironmentDef[], max, canCreate, createBlocked? }`: only the environments the caller may enter (install admins: all) |
| `POST /environments/:id/select` | user with access | none | `EnvironmentDef`; stored as the user's last environment |
| `POST /environments` | install admin | `{ name, type, description?, sampleData?, copyFrom?, copy?: 'schema' \| 'data' }` | `EnvironmentDef` |
| `GET /environments/:id` | install admin or its environment admin | none | `EnvironmentDetails`: the def plus `sizes: { tables, rowEstimate, databaseBytes, attachmentBytes, attachments, files }`, `accessCount` |
| `PATCH /environments/:id` | install admin | `{ name?, description?, type?, locked? }` | `EnvironmentDef` |
| `DELETE /environments/:id` | install admin | `{ confirmName }` (the environment's name, exactly) | `{ ok: true }` |
| `GET /environments/:id/access` | install admin or its environment admin | none | `{ items: EnvironmentAccessEntry[] }` (`userId, name, email, isEnvAdmin, isInstallAdmin?, grantedOn?, grantedBy?, status`; install admins are listed without `grantedOn`) |
| `PUT /environments/:id/access/:userId` | same | `{ isEnvAdmin? }` | `{ ok: true }` |
| `DELETE /environments/:id/access/:userId` | same | none | `{ ok: true }` |
| `GET /install/audit?action=&user=&environment=&from=&to=&page=&pageSize=` | install admin | none | like `GET /audit`; items also carry `environmentId` |

`EnvironmentDef` is `{ id, name, type: 'production' | 'sandbox' | 'developer', builtIn, createdOn?, description?, state?
('creating' | 'deleting' | 'failed'; absent: ready), locked?, canManage?, details?: { database, schemaVersion, schema, createdBy?,
error? } }` (`details` for install admins and the environment's admins).

- **Create**: the id is a slug of the name (unique; the schema is `env_<id>`). 409 for a duplicate name or at the limit
  (`APPBUILDER_MAX_ENVIRONMENTS`, default 5); 404 for an unknown `copyFrom`. The schema, built-in roles and connections, the copy
  (`INSERT ... SELECT` inside the database; files copied with the data) or the sample, and the creator's Administrator role are
  made in one transaction; on failure nothing is left and the environment is listed as `failed` with the reason. A copy takes no
  user roles, no audit and no secrets of connections to other systems.
- **Patch**: the last production environment cannot change type (409); `locked` only for production (422); a type other than
  production unlocks.
- **Delete**: refused (409) for Default, the last production environment, an environment that is being created or deleted, and
  from a request that works in it (switch first). Drops the schema, removes the folder `workspace/env/<id>/` and the access rows.
- **Access**: `PUT` adds the access row; `isEnvAdmin: true` gives the user the Administrator role there, `false` takes their admin
  roles there away (the last one is guarded). `DELETE` removes the row and every role the user held there.
- Every change is audited in `ab.audit` (`environment.*`).

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -d '{"name":"Sales test","type":"sandbox","copyFrom":"default","copy":"schema"}' $BASE/environments
curl -sS -b $JAR -H "$H" -H 'X-Appbuilder-Environment: sales_test' $BASE/workspace
curl -sS -b $JAR -H "$H" -H "$JSON" -H 'X-Appbuilder-Environment: sales_test' -d '{"target":"default","plan":true}' $BASE/solutions/sol_abc/deploy
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

## Table events, jobs and schedules

Package G (`server/core/kernel-routes.ts`; design and guarantees in [events-and-jobs.md](events-and-jobs.md)). Types in
`src/platform/events.ts`.

**Writes and refusals.** Every row write may be refused by a validation rule or a before-event: `422 invalid` with the rule's
message and `field` = the column it names (the client shows it on that form field and as a toast). A before-event that fails
or runs over its time budget is a `422` too. Columns with `computed` (formula, rollup) are ignored in `values` / `changes`;
the stored row in the answer carries their new value (rollups follow a moment later, after commit).

| Route | Level | Body / answer |
| --- | --- | --- |
| `GET /tables/:id/events` | maker | `{ items: TableEventDef[] }` |
| `POST /tables/:id/events` | maker, design | `TableEventInput` -> `{ event }`. 422 with `problems: FormulaProblem[]` for formula errors (`field` = condition or actions). `runAs: "system"` needs an administrator (403) and is audited |
| `PATCH /tables/:id/events/:eventId` | maker, design | partial `TableEventInput` -> `{ event }`; an event running as system can only be changed by an administrator |
| `DELETE /tables/:id/events/:eventId` | maker, design | `{ ok: true }` |
| `POST /tables/:id/events/test` | maker | `{ event, sample, op?, old? }` -> `EventTestResult` (changes, writes it would make, rejection, error, rows read). Nothing is written; reads use the event's identity |
| `POST /tables/:id/formula/check` | maker | `{ formula, role: condition / validation / formulaColumn / before / after }` -> `{ problems }` |
| `GET /tables/:id/event-runs?status=&eventId=&limit=&before=` | maker | `{ items: EventRunEntry[] }`, newest first |
| `GET /admin/jobs?state=&type=&limit=&offset=` | admin | `{ items: JobInfo[], total }`; `state` one of queued, running, succeeded, failed, dead, cancelled, or `active` |
| `GET /admin/jobs/metrics` | admin | `JobMetrics`: counts per state, depth per type, oldest waiting age, failures in 24 h, dead, running jobs, the worker, outbox backlog, job types |
| `GET /admin/jobs/:id` | admin | `JobInfo` |
| `POST /admin/jobs/:id/retry` | admin | failed / dead / cancelled -> queued now, attempts from 0; audited `job.retry` |
| `POST /admin/jobs/:id/cancel` | admin | queued / failed (or running in this process) -> cancelled; audited `job.cancel` |
| `GET /admin/schedules` | admin | `{ items: ScheduleInfo[] }` |
| `POST /admin/schedules`, `PATCH /admin/schedules/:id` | admin | `{ name, cron or intervalSeconds, timeZone, jobType, payload, enabled, misfire }`; 422 for a bad cron, interval, time zone or payload. New schedules only for job types with `schedule: 'custom'` in `GET /admin/jobs/metrics` `types` (422 otherwise). Built-in schedules can be changed (enabled, timing, payload such as retention `days`) but not deleted. Schedules of install-wide job types (`schedule: 'install'`) answer 403 to anyone but an install administrator |
| `DELETE /admin/schedules/:id` | admin | custom schedules only (403 for install-wide ones unless install administrator) |
| `POST /admin/schedules/:id/run` | admin | enqueue the schedule's job now -> `{ id }` (403 for install-wide ones unless install administrator) |
| `POST /admin/export-data/ticket` | admin, recent sign-in | `{ url }`: a one-use, one-minute download link of the environment's data (403 `reauth_required` after an old sign-in) |
| `GET /admin/export-data[?ticket=]` | admin, recent sign-in or ticket | `application/zip`, streamed: `tables/<Table>.csv`, `attachments.csv`, `manifest.json`; audited `environment.export_data` |
| `GET /environment/directory`, `PUT /environment/directory` | admin | `{ visibility: 'everyone' \| 'department' \| 'admins' }`: who non-administrators see in the Users system table and pickers; audited |
| `GET /admin/event-runs?tableId=&status=&limit=&before=` | admin | run log of the environment |

Solution plans (`POST /solutions/import/plan`, deploy with `plan: true`) list table events as items of kind `event`, and
`systemEvents` (names) when the package brings new or changed events that run as the system: then only an administrator
may import, and `POST /solutions/import` answers 409 until `confirm` carries the plan's token (also for an install).

Column definitions (`POST/PATCH /tables/:id/columns`) accept `computed: { kind: "formula", formula }` or
`{ kind: "rollup", table, via, fn: count | sum | min | max, column? }`; invalid ones are 422 with `field: "computed"`. A column
read by a formula column or a rollup, or a table read by a rollup, cannot be removed (409). Changing only `indexed` on the
default database queues an `index.sync` job instead of building the index inside the request.

## Flows

P1 package A (`server/core/flows/routes.ts`; design and guarantees in [flows.md](flows.md)). Types in `src/platform/flows.ts`.
Errors of a definition: `422 invalid` with `problems: ValidationProblem[]` (`{ step, field, message, severity, start?, end? }`).

| Route | Level | Body / answer |
| --- | --- | --- |
| `GET /flows` | maker | `{ items: FlowListItem[] (with health, canEdit, canRun), settings }` |
| `GET /flows/catalog` | user | `{ steps: StepKindDoc[], triggers: TriggerTypeDoc[], limits, approvals }` (the designer's palette; `approvals`: an approvals service is registered) |
| `POST /flows/schedule-preview` | maker | `{ cron? \| everyMinutes?, timeZone }` -> `{ next: ISO[5], description? }` or `{ next: [], error }` (the designer's schedule builder; the server's own cron code) |
| `POST /flows/validate` | maker | `{ id?, name, description?, runAs?, trigger, steps, variables?, settings?, connections? }` -> `{ problems }` (nothing saved) |
| `POST /flows` | maker, design | the same plus `enabled?`, `ownerId?` (administrators), `confirmRunAs?`, `note?` -> `{ flow: FlowDef, problems }` (warnings). `connections`: `{ <ref>: <connection id> }` or `[{ ref, connectionId }]`; a new or changed reference needs the right to use the connection (403). `runAs: { serviceAccount }` needs an administrator (403); a new service-account flow, a changed runAs or owner answers 409 (`field: confirmRunAs`) until `confirmRunAs: true` |
| `GET /flows/:id` | maker | `{ flow, canEdit, canRun }` |
| `PUT /flows/:id` | maker, design | partial document -> a new version `{ flow, problems }`; owner or administrator (403); a flow that runs as a service account: administrators only |
| `DELETE /flows/:id` | maker, design | cancels active runs, removes the flow (history kept) -> `{ ok, cancelledRuns }` |
| `POST /flows/:id/enable`, `/disable` | maker | `{ flow }`; enabling validates first (422) and needs an active owner (409); arms or removes the schedule. In a locked environment administrators only |
| `GET /flows/:id/draft` | maker | `{ draft: { doc, connections, baseVersion, savedBy, savedByName, savedOn } \| null }` (P1-B, the designer's unpublished draft; `null` for people who cannot change the flow) |
| `PUT /flows/:id/draft` | maker, design | `{ flow, connections?, baseVersion? }` -> `{ draft }`. Not validated (a draft may have problems); owner or administrator (403); a new or changed connection reference needs the right to use it (403 with the reason). `PUT /flows/:id` (publish) clears the draft unless `keepDraft: true` |
| `DELETE /flows/:id/draft` | maker, design | discards the draft -> `{ ok }` |
| `GET /flows/:id/versions` | maker | `{ items: FlowVersionInfo[], current }` |
| `GET /flows/:id/versions/:v` | maker | `{ version, doc }` |
| `POST /flows/:id/versions/:v/restore` | maker, design | `{ confirmRunAs? }` -> `{ flow, problems }` (a new version with the old document) |
| `GET /flows/:id/permissions`, `PUT` | maker (PUT: owner or admin, design) | `{ roleIds }`: roles that may run the flow by hand |
| `GET /flows/permissions/all`, `PUT` | admin | `{ roleIds }`: roles that may run every flow |
| `GET /flows/settings`, `PUT` | maker / admin | `{ paused, pausedBy?, pausedOn?, environmentRunsPerMinute }`; PUT `{ paused?, environmentRunsPerMinute? }` (kill switch), audited |
| `POST /flows/:id/run` | user (run permission) | `{ inputs?, runId?, wait?, timeoutSeconds? (<= 30), source? }` -> `{ runId, status, response?, error? }`. 403 without permission, 409 when the flow is off, suspended or paused, 422 for a missing or mistyped input. A `runId` of your own (`run_<8-40 letters>`) makes the call idempotent |
| `POST /flows/run` | user | `{ flow: name or id, ... }` as above (RunFlow() in apps) |
| `POST /flows/:id/test` | maker, owner or admin | `{ trigger? (sample payload), inputs?, dryRun = true, definition? (unsaved draft), approvalOutcome? }` -> `{ runId, dryRun }`; a test run (mode `test`) |
| `GET /flows/runs?flowId=&status=a,b&mode=&trigger=&regarding=&after=&before=&limit=` | user | `{ items: FlowRunInfo[], nextBefore }`; administrators all runs, others the runs of their flows and the runs they started |
| `GET /flows/runs/:runId` | user | `{ run: FlowRunDetail }` (steps with input, output, error, attempt, timings; waits) for the flow's owner and administrators; `{ run, summaryOnly: true }` for the person who started it; 404 otherwise |
| `POST /flows/runs/:runId/cancel` | maker, owner or admin | `{ ok }`; 409 when it ended |
| `POST /flows/runs/:runId/resubmit` | maker, owner or admin | `{ from: 'start' \| 'failed' }` -> `{ runId }` |
| `POST /flows/callback/:env/:run/:key/:token` | none (the token is the authority; no CSRF header) | any body (JSON parsed) -> 202 `{ ok, state: 'resumed' \| 'kept' }`; 404 bad address, 409 used or ended |

Solutions: component kind `flow`; the package carries `flows: [{ id, name, description?, runAs, enabled, definition,
connections: [{ ref, connectionId, connectionName?, connector? }], runRoles }]`. Plans list flows as items of kind `flow`,
`serviceFlows` (names; then `confirm` is always needed) and `flowConnections` (the mapping of each source connection to a
connection here, `to: null` = choose one, a problem). `POST /solutions/import/plan`, `/solutions/import` and
`/solutions/:id/deploy` take `connectionMap: { <source connection id>: <connection id here> }` and
`enableFlows: true | [<flow id>]` (new flows arrive turned off otherwise).

## Approvals

P1 package C (`server/core/approvals/routes.ts`; design in [approvals.md](approvals.md)). Types in `src/platform/approvals.ts`.
A request someone may not see answers 404 like a missing one.

| Route | Level | Body / answer |
| --- | --- | --- |
| `GET /approvals?view=toApprove\|sentByMe\|involved\|all&status=open\|decided\|<status>&q=&policy=&regarding=&before=&limit=` | user (`all`: administrators) | `{ items: ApprovalRequestInfo[], nextBefore }` |
| `POST /approvals` | user | `{ id?, policy? \| approvers, type?, options?, title, details?, fields?, regarding?: { table?, rowId }, dueMinutes? }` -> `{ id, created }` (a client `id` makes it idempotent) |
| `GET /approvals/:id` | user | `{ request: ApprovalDetail }` (record summary as the viewer may read it, or `recordHidden`) |
| `POST /approvals/:id/respond` | user (asked now) | `{ response, comment? }` -> `{ status, outcome }`; 403 not asked, 409 decided / already answered / waiting for info, 422 comment required |
| `POST /approvals/respond-many` | user | `{ ids, response, comment? }` -> `{ results: [{ id, ok, status?, error? }] }` |
| `POST /approvals/:id/info` | requester | `{ comment }` answers "Need more info" |
| `POST /approvals/:id/cancel` | requester, administrators | `{ reason? }` |
| `POST /approvals/:id/reassign` | person asked, administrators | `{ to, assignmentId?, comment? }` |
| `GET /approvals/record/:table/:row` | user (reads the record) | `{ items }` the requests about a record the user may see |
| `POST /approvals/links/inspect` | user | `{ token }` -> `{ ok, response, kind, requireComment, request }` or `{ ok: false, code, reason, environmentId? }`; changes nothing |
| `POST /approvals/links/use` | user (the link's person) | `{ token, comment? }` -> `{ status, outcome, requestId }`; single use |
| `GET /approvals/delegations?all=1`, `POST /approvals/delegations`, `DELETE /approvals/delegations/:id` | user (others' delegations: administrators) | `{ toUser, fromUser?, startsOn?, endsOn?, policies?, note? }` |
| `GET /approvals/policies` | user | `{ items: ApprovalPolicy[] }` |
| `POST /approvals/policies`, `PUT /approvals/policies/:id`, `DELETE /approvals/policies/:id` | maker | `{ name, description?, definition }` (422 with the field of the first problem) |
| `GET\|PUT /approvals/settings` | administrators | `{ viewerRoles, retentionDays, linkHours }` |
| `GET /approvals/catalog` | user | types, approver references, escalation actions, step outputs, statuses |

**Request ids.** Every API answer has the header `X-Request-Id` (the client's `X-Request-Id` when well-formed, else a new
one); error bodies carry it as `error.requestId`. The UI shows it as "Reference: ..." in error messages.

## Print templates

P2 package B (`server/core/print/routes.ts`; design in [pdf.md](pdf.md)). Types in `src/platform/print.ts`. Generation
reads as the caller (or the template's service account); a record the caller cannot read answers 404.

| Route | Level | Body / answer |
| --- | --- | --- |
| `GET /print/catalog` | user | `{ blocks, functions, builtins, limits, empty }` |
| `GET /print/settings`, `PUT /print/settings` | user / administrator | `{ settings: PrintSettings }` |
| `GET /print/templates?table=` | user (non-makers: published only) | `{ items: PrintTemplateInfo[] }` |
| `POST /print/templates` | maker (design) | `{ name, description?, kind?, doc, runAs?, docxBase64?, docxFileName?, publish? }` -> `{ template }`; 422 with the path of the first problem |
| `POST /print/builtins` | maker (design) | `{ key, table?, name?, publish? }` -> `{ template }` |
| `GET /print/templates/:id` | user | `{ template: PrintTemplateFull }` (non-makers: the published document) |
| `PUT /print/templates/:id` | owner, makers for built-ins, administrators (design) | `{ name?, description?, doc?, runAs?, docxBase64?, publish?, note? }` |
| `DELETE /print/templates/:id`, `POST .../publish`, `GET .../versions`, `POST .../restore { version }`, `POST .../copy { name }` | maker (design, except versions) | |
| `POST /print/templates/:id/preview` | maker | `{ recordId?, doc? }` -> the PDF; headers `X-Print-Pages`, `X-Print-Warnings` (URI-encoded JSON), `X-Print-Run`, `X-Print-Token` |
| `GET /print/templates/:id/pdf?recordId=&download=1` | user | the published template's PDF (or .docx); header `X-Print-Token` |
| `POST /print/generate` | user | `{ template, recordId?, token? }` -> `{ file: GeneratedFile }` (`token`, `fileName`, `mime`, `sizeBytes`, `url`, `pages`, `warnings`, `runId`) |
| `POST /print/templates/:id/documents` | user | `{ recordId, numberSequence? }` -> `{ documentId, attachmentId, name, file }` |
| `POST /print/bulk` | user | `{ template, recordIds, mode: zip \| merged }` -> `{ runId, jobId }` |
| `GET /print/runs?templateId=`, `GET /print/runs/:id` | user (makers: all; others: their own) | `{ items: PrintRunInfo[] }`, `{ run }` |
| `GET /print/files/:token?download=1` | the creator, administrators | the file |

A `gen_...` token written into a file or image column (insert or update) becomes an attachment of that cell; another
person's token is refused with 422. The email action's attachments accept `{ fileToken }`.

## Notifications (user)

The signed-in user's in-app notifications (install-wide; usable without an environment unless noted). Items:
`{ id, kind, title, body, link, environmentId, createdOn, readOn, source, from? }`; `link` is a deep link inside Appbuilder
(`#...`). New ones and unread counts are also pushed on the live socket (`user:<me>`, see `live.md`).

| Route | Answer |
| --- | --- |
| `GET /notifications?limit=30&cursor=&unread=1` | `{ items, nextCursor, unread }`, newest first (keyset paging; `limit` at most 100) |
| `GET /notifications/unread-count` | `{ unread }` |
| `POST /notifications/:id/read`, `POST /notifications/read-all` | `{ unread }` |
| `DELETE /notifications/:id` | `{ unread }`; someone else's or unknown: 404 |
| `GET /notifications/settings`, `PUT /notifications/settings` | `{ kinds: { [kind]: boolean }, desktop, dnd: { start, end } \| null, hidePresence, email?: { [kind]: 'off'\|'immediate'\|'digest' }, digest?: { frequency, time }, timeZone?, quietEmail? }` (unknown fields dropped). A kind set to false in `kinds` is not stored in the app for this user; email follows `email` (P1). |
| `GET /notifications/channels` | Effective channels per kind (with administrator locks and reasons), digest, time zone, whether email works ([notifications-delivery.md](notifications-delivery.md)) |
| `GET /notifications/deliveries` | The caller's delivery log ("why did I get this"); `GET /admin/notifications/deliveries?userId` for install administrators |
| `GET/PUT /admin/notifications/policy` | Install administrators: defaults and locks per kind, logo, per-recipient limit |
| `GET/POST /notifications/unsubscribe?t=` | No sign-in: the signed link of an email mutes a kind (or a report) |
| `POST /notifications/send` (environment) | `SendNotification` from apps: body `{ to, title, body?, link?, app? }`; `to` = user id or email of someone who may enter the request's environment (others, and unknown people: 404); title at most 200, body 2,000 characters; `link` must start with `#` (422 otherwise). Rate limit per sender: 30 a minute, 300 an hour (429). Stored with kind `app` and the sender's name. |

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -X POST -d '{"to":"bea@example.com","title":"Order 1042 approved","link":"#u-app_0193"}' $BASE/notifications/send
curl -sS -b $JAR $BASE/notifications?unread=1
```

## Core data model (collab)

The system tables (`docs/dev/core-data-model.md`) are ordinary tables for the data routes: comments, activities,
documents, tags and the rest are read through `POST /query` and written through `/data/:table/rows` with
`regardingId` (and optionally `regardingTable`) naming the record. A `regardingId` the caller cannot read is answered like
a missing record (422 "There is no record with the id ..."). Projections (Users, Roles, the logs ...) answer 403 to
writes. NextNumber defaults are filled by the server. These routes add what is not a plain table read (every signed-in
user; security is the engine's):

| Route | Answer |
| --- | --- |
| `GET /collab/timeline?row=<id>&table=&cursor=&limit=30` | `{ table, row, title, items, nextCursor, following, followers, tags, canComment }`; items `{ kind: comment \| activity \| file \| event, id, at, by, byName, data }` newest first. 404 when the caller cannot read the record (or it does not exist). `table` is optional (row ids are unique). |
| `GET /collab/mentionable?table=&row=&q=` | `{ users: [{ id, name, email }] }`: people who can read the record (at most 20) |
| `POST /collab/follow` `{ row, table?, on }` | `{ following }` |
| `POST /collab/tags` `{ row, table?, tag, on }` | `{ tagged, tag? }`; a new tag name creates the tag |
| `GET /collab/my-tasks?status=open\|all&limit=` | `{ items }`: tasks assigned to me or my teams, and my own unassigned ones, by due date, with the record's label |
| `GET /collab/mentions?limit=` | `{ items }`: mentions of me, newest first, with the comment, its author and the record's label |
| `GET /templates/business-model` (maker) | `{ yaml, id, version }`: the common business model solution package |

```bash
curl -sS -b $JAR -H "$H" -H "$JSON" -X POST -d '{"values":{"Body":"<p>Call back</p>","regardingId":"<order id>"}}' $BASE/data/Comments/rows
curl -sS -b $JAR "$BASE/collab/timeline?row=<order id>&limit=30"
```

## Realtime (WebSocket)

`GET /api/v1/live` with `Upgrade: websocket` (same origin, the session cookie, an `Origin` header naming this origin). The protocol,
topics, limits and security rules are in `live.md`.

## Data model (maker)

The data model designer (`docs/dev/data-model.md`). Types in `src/model/types.ts`. Writes are design routes.

| Route | Body / answer |
| --- | --- |
| `GET /model` | `ModelResponse`: `model` (tables + relationships, lookups without a record shown with their default), `layout` (shared), `myLayout?`, `draft` (the caller's), `locked`, `version` |
| `PUT /model/draft` | `{ draft: { base, model, past?, future?, layout? } }` (16 MB) |
| `DELETE /model/draft` | discards the caller's draft |
| `PUT /model/layout` | `{ layout, scope: 'shared' \| 'mine' }`; `DELETE /model/layout` forgets the caller's own |
| `POST /model/plan` | `{ ops: ModelOp[] }` -> `ModelPlan` (`items` with rows, conversion pre-checks, destructive flags; `problems`, `warnings`, `backup`, `token`) |
| `POST /model/apply` | `{ ops, token, layout?, layoutScope?, clearDraft? }` -> `{ ids, plan, backup }`; 422 with `plan` while there are problems, 409 with `plan` when the schema changed since |
| `POST /model/introspect` | `{ connectionId, mode: 'link' \| 'copy', into?, tables? }` -> `{ model, tables, warnings, found }` (PostgreSQL / MySQL connections) |
| `POST /model/sheets?name=` | raw `.xlsx` or `.csv` body -> `{ sheets: [{ name, headers, rows }] }` (2,000 rows per sheet; nothing stored) |
| `GET /model/stats` | text columns with how many values look numeric or like dates (first 5,000 rows per table), for the checks |
| `GET /model/views` | the reporting views registry: `{ items: [{ id, name, role, base, baseName, columns }] }` |
| `POST /model/package` | `{ tables?, displayName?, version? }` -> `{ fileName, yaml }`: a solution package of the tables (no rows) |

Data routes: deleting rows now applies the relationships' delete behaviours (409 for restrict with
`relationship: { table, column, rows, onDelete }` in the body; 403 when a cascade reaches rows the caller may not delete),
and a self lookup with loop prevention answers 422 on a loop. Reporting views answer reads only.

## Backups (install administrators)

P0 package J; shapes in `src/platform/backup.ts` (which also lists every route), design in `docs/dev/backup.md`. All routes
need an install administrator (403 otherwise). Backups and restores run in the background; poll `GET /backups/ops/:id` or
`GET /backups/:id`, or listen on the user topic (live event `backup` with `backup` / `op`).

| Route | Body | Answer |
| --- | --- | --- |
| `GET /backups` | | `{ items: BackupInfo[], health, ops }` (items with `retention`: why kept / pruned next) |
| `POST /backups` | `{ scope: 'install' \| <environment id>, passphrase?, includeKey?, note? }` | `BackupInfo` (queued as a `backup.run` job in Default) |
| `GET /backups/health`, `GET\|PUT /backups/settings` | `BackupSettingsInput` | `BackupHealth`, `BackupSettings` |
| `GET\|PATCH\|DELETE /backups/:id` | `{ pinned?, note? }` | `BackupInfo` / `{ ok }` |
| `POST /backups/:id/verify` | `{ passphrase? }` | `BackupOp` |
| `POST /backups/:id/contents` | `{ passphrase? }` | `BackupContents` (422 field `passphrase` when it is needed or wrong) |
| `POST /backups/:id/browse` | `{ environment, table, offset?, limit? (≤500), passphrase? }` | `BackupRowsPage` (COPY text decoded, strings) |
| `POST /backups/:id/restore` | `RestoreRequest` (`mode: 'new' \| 'in-place'`, `confirmName` for in place) | `BackupOp`; 409 for a backup of a newer version |
| `POST /backups/:id/restore-tables/plan` | `{ environment, tables, mode: 'new' \| 'replace' }` (into the request's environment) | `TableRestorePlan` with `token` |
| `POST /backups/:id/restore-tables` | same + `confirm: token` | `BackupOp` (409 on a stale token) |
| `POST /backups/:id/download-ticket` | | `{ ticket, url }` after `requireRecentAuth` (403 `reauth_required`) |
| `GET /backups/:id/download?ticket=` | | the archive, streamed (without a ticket: needs a recent sign-in) |
| `POST /backups/upload?name=` | raw body, streamed to disk (limit `APPBUILDER_BACKUP_MAX_UPLOAD_GB`, 50) | `BackupInfo` (`uploaded`; checked in the background) |
| `POST /backups/restore-test`, `GET /backups/ops/:id` | | `BackupOp` |

`DELETE /environments/:id` takes a backup first: its answer is `{ ok, backup? }`; a failed backup answers 409 field `backup`
unless the body has `proceedWithoutBackup: true`. `GET /environments/:id` has `lastBackup` for install administrators.

## Health, logs, usage, diagnostics and updates

P0 package L; shapes and the route list in `src/platform/ops.ts`, design in `docs/dev/release-process.md`.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /health` | anyone (no session) | `{ status: 'ok' \| 'starting' \| 'degraded' }`, HTTP 200 only for `ok` (503 otherwise), `Cache-Control: no-store`. No versions, names or error text |
| `GET /admin/health` | install administrators | `DetailedHealth`: checks (database, clock, environments, disk, backups, jobs, mail, log file), versions, database latency, clock skew, live sockets, process |
| `GET /admin/logs?level=&from=&to=&q=&limit=` | install administrators | `LogPage`: the file log, newest first (≤ 5000; `q` matches the message and request ids) |
| `GET /admin/logs/download` | install administrators | the log files as text, secrets removed |
| `PUT /admin/logs/settings` | install administrators | `{ level }` (`info \| warn \| error`); 409 when `APPBUILDER_LOG_LEVEL` sets it |
| `GET /admin/usage` | install administrators | `UsageReport` |
| `POST /admin/diagnostics` | install administrators | a ZIP (`application/zip`), secrets removed; audited `diagnostics.bundle` |
| `GET /admin/updates` | install administrators | `UpdatesInfo` (installed release, trusted keys, staged package, history, the apply command) |
| `POST /admin/updates/upload` | install administrators | raw ZIP body (≤ 1 GB) -> `StagedUpdate` (checksums, signature, problems, release notes); 422 when it is not a release ZIP; audited `update.stage` |
| `DELETE /admin/updates/staged` | install administrators | `{ ok }` |

Setup routes (`/setup/database`, `/setup/admin`) also refuse requests that carry proxy headers (`X-Forwarded-For`,
`Forwarded`, `X-Real-IP`, `Via`, `X-Forwarded-Host`), even from 127.0.0.1: a reverse proxy on the same machine is not
"this computer".

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
- The doc comment for `Query.top` says "default and maximum: DEFAULT_ROW_CAP"; the code returns the cap when `top` is larger, as
  described above.
