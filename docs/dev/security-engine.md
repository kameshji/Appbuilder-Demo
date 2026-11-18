# Security engine

Appbuilder enforces three layers of access control on the server, for every data request, regardless of what the browser claims:

- **RBAC**: which tables a user may create in, read, update and delete from, and which apps they may run.
- **RLS** (row-level security): which rows of a table they may touch (`own` rows, or rows that match a filter).
- **CLS** (column-level security): which columns they may see and which they may write.

The implementation is `/home/claude/appbuilder-demo/server/core/security.ts` (pure computation: `buildUserContext`,
`createSecurityEngine`) and its enforcement points in `/home/claude/appbuilder-demo/server/core/data.ts`,
`/home/claude/appbuilder-demo/server/core/attachments.ts` and `/home/claude/appbuilder-demo/server/core/data-routes.ts`. The data
model is in `/home/claude/appbuilder-demo/src/platform/contracts.ts` (`RoleDef`, `TablePrivilege`, `RowCondition`, `AccessScope`,
`ColumnAccess`) and is stored in `ab_roles`, `ab_user_roles`, `ab_role_tables` (see `schema.md`).

**Every statement on this page must keep matching the code.** If you change `security.ts` or its callers, change this page in the same
commit (see `/home/claude/appbuilder-demo/CONTRIBUTING.md`).

Since P0 package F the engine also knows the **organisation** (departments, managers, teams), **relationship rules**
(conditions through lookup columns and junction tables) and **record sharing**; see "Organisation scopes, rules and sharing"
below. The predicate building lives in `/home/claude/appbuilder-demo/src/platform/orgsec.ts`, shared with demo mode.

What is not supported: no deny rules (access only ever grows when roles are added), no field-level
security on formulas or app definitions (an app definition is readable by anyone allowed to run the app; do not put secrets in it),
no time-limited grants, and no security on `files`-connector tables beyond the same engine (it applies uniformly).

## Concepts

| Term | Meaning |
| --- | --- |
| Role | A named set of table privileges, an app list and two flags: `isAdmin`, `isMaker`. Built in: `role_admin`, `role_maker`, `role_viewer`. |
| User | Holds zero or more roles (`roleIds`). The effective rights are the **union** over the user's roles. |
| Table privilege | Per role and table: `create` (boolean), `read`, `update`, `delete` (each `none`, `own` or `all`), optional `columns` (CLS map), optional `rowFilter` (RLS conditions). |
| Scope | `none`, `own`, `team`, `manager`, `managerTree`, `department`, `departmentTree`, `all`. `own` means rows whose `owner` column equals the user id; the organisation scopes compare `owner` with a set (below). The reported maximum uses the order none < own < manager < managerTree < team < department < departmentTree < all. |
| System columns | `id`, `createdOn`, `modifiedOn`, `createdBy`, `owner`. Server-assigned; never writable by clients (except `owner` on `teamOwnership` tables, below). |
| Row filter | A list of `RowCondition` (rule AST, below), ANDed together. Tokens: `@me`, `@myEmail`, `@myDepartment`, `@myDepartmentCode`, `@myManager`, lists `@myDepartmentTree`, `@myTeams`, `@myReports`, `@myReportsTree`, by code `@team:<c>`, `@department:<c>`, `@departmentTree:<c>`, and inside `exists` `@this` / `@this.<Column>`. |
| Share | `TablePrivilege.share` (a scope) and per-row shares (`ab_shares`) on tables with `sharing: true`. |

## Environments, install administrators

Roles, privileges and the security cache belong to an **environment** (`ab_roles`, `ab_user_roles`, `ab_role_tables` live in its
schema `env_<id>`). The engine always works on the roles and tables of the request's environment (`currentEnvironment()`), and the
`UserContext` carries its `environmentId`. Before roles are read, the session resolver checks that the user may enter the
environment the request names (`ab.environment_access`, see `schema.md`): unknown 404, not granted 403.

- **Install administrator** (`ab.users.is_install_admin`, `privileges.isInstallAdmin`): `buildUserContext` treats them as admin in
  every environment (whatever their roles there), and they enter every environment without an access row. The install-level
  routes (environments, accounts, install audit) check this flag, not `isAdmin`.
- **Environment administrator**: a user with an `isAdmin` role in that environment; `privileges.isAdmin` in requests there.
  `ab.environment_access.is_env_admin` mirrors it for the install-level views.

## Admin and maker

- **Admin** (`isAdmin` on any of the user's roles in the environment, or install administrator): everything is allowed. Row predicate is `{ const: true }`, scopes are all `all`,
  create is allowed, every non-system column has access `update`, system columns `read`. Privileges stored on an admin role are
  ignored (the API stores an empty list for admin roles).
- **Maker** (`isMaker` on any role, or admin): may use the metadata API (apps, tables, columns, solutions, data files, connection
  tests and links). Being a maker grants **no data rights by itself**: a maker role still needs table privileges to read rows through
  `/data/...`. In the `GET /workspace` response a maker sees all tables (`isMaker ? all : hasAnyTableAccess`), but the data routes
  still apply `ensureTableVisible` only to non-makers and then the normal row, column and create checks to everyone who is not an
  admin.
- New tables get default privileges for existing roles (`grantDefaults` in `server/routes/meta/tables-core.ts`): admin-like and
  maker-like roles get full access, viewer-like roles get read, other roles none.

## Union rules (multiple roles)

Let a user hold roles R1..Rn. For one table `T` the engine combines the privileges as follows (`buildUserContext`).

1. **Scope per operation** (`read`, `update`, `delete`): the maximum over the roles that have a privilege row for `T`
   (`none` < `own` < `all`). This is what `EffectivePrivileges.tables[T].read/update/delete` reports.
2. **Create**: true if any role has `create: true`.
3. **Row predicate for an operation** (`rowPredicate(T, op)`), used as the filter ANDed into every query and as the `guard` of every
   write. It is the OR over roles of that role's term:
   - skip roles with no privilege row for `T` or whose scope for `op` is `none`;
   - the role's base is `TRUE` for scope `all`, or `owner = <user id>` for scope `own`;
   - the role's filter is its `rowFilter` list converted to conditions (tokens resolved) and ANDed; no filter means `TRUE`;
   - if the filter names a column that does not exist on the table (or one listed in `missingSystem`), **that role grants
     nothing** (it is skipped);
   - an `own` scope on a linked table without an `owner` column (`missingSystem` contains `owner`) grants nothing;
   - the term is `base AND filter`; if it simplifies to `TRUE`, the whole predicate is `TRUE` immediately;
   - if no role contributes a term the predicate is `{ const: false }` (no rows).
4. **Column access** (`columnAccess(T, column)`): the maximum (`none` < `read` < `update`) over the *granting roles* of the value in that
   role's `columns` map, where a column missing from the map means `update`. Granting roles are those with read scope other than
   `none`; if there are none, roles with `create` or an update scope other than `none` are used instead (so a create-only role still
   restricts which columns may be written). `id` is always `read`. System columns are at best `read`.
5. **Visible definition** (`visibleDef(T)`): the table without the columns whose access is `none`; if the primary column is gone it
   becomes the first non-system visible column, or `id`.
6. **Apps**: `canRunApp(id)` is true for admins, for any role with `apps: 'all'`, otherwise if the id is in the union of the roles'
   app lists.
7. **`filtered`** in the effective privileges is true when a role with read scope other than `none` has a non-empty row filter. It
   tells the client that it cannot fully mirror the row predicate.

Effective scopes are a **per-operation maximum**, but row predicates are a **per-role combination**: a user cannot combine "read all"
from one role with "update own" from another into something broader than each role allows. Each operation uses its own predicate.

### Examples

Table `Tickets` with columns `Title`, `Status`, `Internal`.

| Roles held | Result |
| --- | --- |
| Role A: read `all`. Role B: read `own`, filter `Status = Open` | Read scope `all`. Predicate is `TRUE OR (...)`, so `TRUE`: all rows. |
| Role A: read `own`. Role B: read `own`, filter `Status = Open` | Predicate `owner = me OR (owner = me AND Status = Open)`: the user's own rows. |
| Role A: read `all`, filter `Status = Open`. Role B: read `all`, filter `Status = Closed` | Rows that are Open or Closed (the OR of the two). |
| Role A: read `all`, filter `Region = @myEmail` on a table with no `Region` column | That role grants nothing; if it was the only role the predicate is `{ const: false }` and queries return no rows. |
| Role A: read `all`, `Internal: none`. Role B: read `all`, no column map | `Internal` is `update` (the max): visible and writable. A hidden column is only hidden when every granting role hides it. |
| Role A: read `all`, `Internal: none`. Role B: read `own` (no column map) | `Internal` is `update` (role B does not restrict it). Column access is a maximum over roles and does not depend on which rows each role may read, so the user sees `Internal` in every row role A lets them read. |
| Role A: create only (no read). Columns map `Status: read` | No granting role by read; role A is used for columns: `Status` is `read`, so an insert that sets `Status` is refused (403). |
| Role A: update `own`. Role B: update `all`, filter `Status = Open` | Update predicate `owner = me OR Status = Open`: rows that are mine **or** Open. The reported scope is `all` (the maximum), which is why `filtered`/the server decide rows, not the scope. |

## Organisation scopes, rules and sharing (P0 package F)

Code: `/home/claude/appbuilder-demo/src/platform/orgsec.ts` (pure, shared by server and demo mode),
`/home/claude/appbuilder-demo/server/core/security.ts` (engine, caches), `/home/claude/appbuilder-demo/server/core/org-store.ts`
(storage), `/home/claude/appbuilder-demo/server/routes/meta/org.ts` (API), the SQL in `server/connectors/postgres/sql.ts` and
`server/connectors/mysql/sql.ts` (`semi` nodes).

### Organisation context

`orgContextFor(directory, userId, environmentId)` computes, per user: department and its subtree (ids), the users of the
department and of the subtree, manager, direct reports, the reporting line below the user, the user's teams counting in the
environment (`environmentId` NULL or equal) and their members, and code-to-id maps for teams and departments. Trees and reporting
lines are walked breadth-first with a `seen` set (a cycle is followed once) and at most `MAX_ORG_DEPTH` = 32 levels. Writes refuse
cycles (`managerCycle`, `departmentCycle`).

### Scopes compile to an owner list

| Scope | Condition |
| --- | --- |
| `own` | `owner = me` (unchanged) |
| `team` | `owner IN (me, members of my teams, my team ids)` (team-owned rows hold the team id in `owner`) |
| `manager` | `owner IN (me, direct reports)` |
| `managerTree` | `owner IN (me, reporting line)` |
| `department` | `owner IN (users of my department)`; without a department `owner = me` |
| `departmentTree` | `owner IN (me, users of my department and every department below)` |

These are plain v1 `in` leaves: PostgreSQL `lower(owner) = ANY($n::text[])` (the owner index `ix_<table>_owner` is on
`lower(owner)`), MySQL `IN (...)`, and the in-memory evaluators. A table without an `owner` column grants nothing to them.
User ids and team ids are both UUID-like text from disjoint registries (`ab.users`, `ab.teams`), so `owner` needs no type column:
a team id never equals a user id, and `own` keeps its meaning.

### The rule AST

```ts
type RowCondition =
  | { column: string; op; value? }                          // column of the table, or a lookup path "Section.Teacher" (<= 2 hops)
  | { exists: { table: string; where: RowCondition[] } }     // junction: exactly one `X eq @this` / `@this.Col` correlation
  | { any: RowCondition[] }                                  // OR group
```

`filterFor(table, rowFilter, env)` turns it into the v1 `Condition`, adding one server-internal node (`src/platform/http.ts`):

```ts
{ semi: { col, table: TableDef, key, where: Condition } }   // col IN (SELECT key FROM table WHERE where)
```

- **Lookup path** `Line.Supervisor = @me` on *Production*: `{ semi: { col: 'Line', table: Lines, key: 'id', where: Supervisor = me } }`.
  Two hops nest two semis. The path must follow `lookup` columns to tables of the same connection (`sameStore`: same
  `connectionId` and a SQL connector); the comparison holds when the referenced row exists and matches.
- **Junction** `exists(Enrolments where Student = @this and Section.Teacher = @me)` on *Students*:
  `{ semi: { col: 'id', table: Enrolments, key: 'Student', where: <Section.Teacher = me> } }`; `@this.Student` correlates on an
  outer column instead of `id`.
- **Tokens** are resolved per request: a list token turns `eq` into `in` and `ne` into `not in`; a token the user has no value for
  (no department, no manager, an unknown code) becomes `FALSE` (never matches; fail closed). At most 3 nested semis per rule.
- **Invalid rules** (unknown column, non-lookup path, another connection, more than 2 hops, list token with an ordering operator,
  `exists` without exactly one correlation) make the role grant nothing (`null` from `filterFor`); `ruleProblems()` gives the
  messages the API (422) and the rule builder show.
- Clients can never send a `semi` node: the v1 query validator (`checkCondition` in `data.ts`) only accepts `and/or/not/const`
  and column leaves, and Query v2 plans have their own AST.

SQL (PostgreSQL, `semiJoin` in `sql.ts`): `(<outer> IN (SELECT <inner> FROM "env_x"."t_target" WHERE <inner> IS NOT NULL AND
<where>))`, both sides compared as the indexes are built (text kinds `lower(...)`, the managed `id` as stored), so the lookup
index on the outer side (`ix_<table>_<lookup>` on `lower(col)`) and the target's own indexes serve it; the planner makes it a
(hashed) semi-join. MySQL wraps the sub-select in a derived table so `UPDATE`/`DELETE` may use it on their own table (error 1093).

### Shares

`ab_shares` rows (per environment) whose principal is the user or one of their teams are loaded once per request
(cached 5 s per user and environment, dropped by every share change and by `invalidate()`), only when a table has
`sharing: true`. For a role set with a non-`none` read (update) scope on the table, the predicate ORs
`id IN (<shared row ids>)` (read: read and update shares; update: update shares). Shares never apply to delete or create.
`rowPredicate(table, 'share')` = OR over roles with a `share` scope of (scope AND filter), plus `owner = me` for users with any
read scope; `FALSE` when the table has sharing off (administrators: `TRUE` when on). `POST /api/v1/shares` requires the share
predicate on the row and, for `update` access, the update predicate.

### Team ownership

On tables with `teamOwnership: true` the DataService accepts `owner` in an insert or an update when it is the user or a team
of theirs in the environment (administrators: any user or team), then applies the usual update guard and WITH CHECK, so a user
whose update scope is `own` cannot give a row away (the row would leave their scope).

### Caches and invalidation

`createSecurityEngine` keeps, with the TTL (5 s): roles, tables and the SQL connection ids per environment; the organisation
directory (install-wide); shares per environment and user. Organisation routes call `invalidateOrg()` and `invalidate('all')`,
share routes `invalidateShares()`; `invalidate()` also drops shares. A change made by another server process or directly in the
database applies within 5 s.

### The explainer

`UserContext.reasons(table, op)` returns the terms that make up a predicate (`admin`, one per granting role with its scope and
whether it has rules, `share`, `owner`). `GET /api/v1/security/explain?table=&row=` builds every active user's context and
evaluates each term on the row in memory, answering `semi` nodes with one cached lookup query each
(`evaluateWithSemi`). The security preview (`GET /security/preview`) adds `why` per table from the same reasons.

### Performance

`scripts/bench/orgsec-bench.mjs`: PostgreSQL 16, 1,000,000 rows, 500 users in 50 departments (5 sites x 9), 25 teams, a 4-level
manager tree; median of 5 runs of the SQL the connectors run (Query v2 first page of 50 with the exact count; v1 page of 50):

| Case | Rows visible | v2 first page + count (ms) | v1 page (ms) |
| --- | ---: | ---: | ---: |
| all rows (no predicate) | 1,000,000 | 47.7 | 197.6 |
| own | 2,000 | 16.9 | 2.9 |
| team (20 members) | 40,000 | 75.2 | 76.0 |
| manager (direct reports) | 22,000 | 67.4 | 67.8 |
| managerTree (site head, ~100 people) | 200,000 | 76.8 | 107.7 |
| department (10 people) | 20,000 | 67.7 | 69.2 |
| departmentTree (site, 100 people) | 200,000 | 84.2 | 101.2 |
| rule `Line.Supervisor = @me` | 30,000 | 66.1 | 82.5 |
| rule `exists(Assignments: Line = this.Line, Member = @me)` | 10,000 | 409.7 | 355.0 |
| own + 1,000 shared rows | 3,000 | 23.1 | 8.5 |
| departmentTree AND a lookup rule | 200,000 | 253.2 | 264.5 |

The row filter is ANDed into the v2 WHERE without `COALESCE` (it was wrapped before P0-F, which hid every index from the planner:
own scope 285 ms -> 17 ms). The junction rule correlated on a lookup column runs as a hash semi-join over the table (the planner
does not trust the small estimate); it is the slowest form, still under half a second at a million rows.
`server/core/orgsec.integration.test.ts` checks with `EXPLAIN` that the owner list uses `ix_<table>_owner` and that rules become
one statement with sub-selects over the lookup index.

## Where the engine is enforced (`data.ts`)

All data routes call `DataService`, which receives the `UserContext`.

**Query**
1. Every referenced column (select, where, orderBy) must exist (422) and not be `none` for the user (403).
2. The read predicate is ANDed into `where`. If it is `{ const: false }` the answer is empty rows immediately (`total` 0 when
   `count`).
3. If `select` is empty and some columns are hidden, the select list is narrowed to the visible columns; rows are then filtered
   through `rowOut` so hidden columns never leave the server.
4. Cap and `truncated` as in `data-api.md`.

**Query v2** (`queryV2`, `POST /api/v1/query`)
1. The plan is validated against every column of the table (`checkPlan`, 422); then every column it reads (select, filter including
   `cmpCol` and calculation columns, search, sort, groupBy, measures and measure filters) must not be `none` for the user (403 naming
   the column). `id` is always readable.
2. The read predicate (`rowPredicate(T, 'read')`, a v1 `Condition`) is handed to the connector, which ANDs it into the WHERE of the one
   statement (PostgreSQL: translated by the v1 builder, so row filters keep their v1 semantics). `{ const: false }` becomes `FALSE`:
   empty rows, count 0, and an aggregate without groups still returns its one row (sum 0). Counts and aggregates therefore never
   include rows the user may not read.
3. Without `select`, the returned columns are the visible ones. Connectors without `queryV2` read through `select` with the same
   predicate (at most 5,000 rows, `truncated`) and run the reference executor; the same checks apply.

**Insert**
1. `canCreate(T)` else 403. The table and connector must be writable (`readOnly` tables and non-`write` connectors: 403).
2. Each supplied column: system columns are ignored (except a client-supplied UUID `id`); autonumber is server-assigned; any other
   column needs access `update` (hidden: 403, read-only: 403).
3. `createdBy` = `owner` = the user (or a team of theirs on `teamOwnership` tables). **WITH CHECK**: the complete new row (with
   defaults) must satisfy `rowPredicate(T, 'create')` = OR over the roles granting `create` of that role's row filter (tokens
   resolved; no owner term, because the creator owns the row; a granting role without a filter allows any row; admins: `TRUE`).
   Otherwise 403, nothing written. Evaluated in memory with `evaluateWithSemi` (`server/core/condition.ts`): relationship rules
   (`semi` nodes) are answered by one query each against the rule's table.
4. Required, unique, lookup and attachment checks, then insert. A lookup value must point at a row the user can **read** (the
   target's read predicate is ANDed into the existence check); an unreadable row answers 422 "no row with id" exactly like a
   missing one. A row the user may create but not read afterwards is allowed
   (for example a create filter wider than the read filter).

**Update**
1. The row must exist (404). Each changed column needs access `update`; `autonumber` and system columns are ignored for non-service
   callers; `id` in the changes must equal the row id.
2. The update predicate is the `guard`. If it is `{ const: false }`, or the row does not satisfy it, the answer is **403 if the user can
   read the row, else 404** (so a user cannot probe for rows they cannot see).
3. The guard is passed to the connector, which applies it atomically with the write (`WHERE id = ? AND <guard>`); `0` affected rows
   gives the same 403-or-404 decision.
4. **WITH CHECK**: the guard is evaluated again on the row as it would be after the change (`{ ...existing, ...changes }`); if the
   changed row no longer satisfies it the answer is 403 and nothing is written. Only the update predicate is re-checked: an update
   may move a row out of the user's *read* predicate when another role grants the update (the row then disappears for the user).
   Attachment uploads and removals (`writeCells`) apply the same check.

**Delete** (all or nothing)
1. Before anything is deleted the service selects (in chunks of 500 ids) the ids readable under the read predicate and those
   deletable under the delete predicate. If any readable id is not deletable the whole request is refused with 403 and nothing is
   deleted. Ids the user cannot read are silently skipped. The deletable ids then go to one `connector.delete` call (PostgreSQL and
   MySQL: one transaction over the chunks). If exactly one id was requested and nothing was deleted the answer is 404.
2. Deleting also removes the attachments of those rows.

**Import** (`/data/:table/import`): needs create; columns the user cannot update are ignored (not errors); every row passes the
insert checks above (including the create WITH CHECK) before anything is written; `replace` deletes the rows under the delete
predicate and inserts the new ones, in one transaction on PostgreSQL and MySQL.

**Export** (`/tables/:id/csv`): visible columns, rows under the read predicate.

**Attachments** (`attachments.ts`): upload needs `update` column access plus the update guard on the row (403 or 404 as above); read
and `resolve` need row read access; delete needs `update` column access and the update guard.

**Visibility** (`data-routes.ts`): a non-maker with no privilege at all on a table (`hasAnyTableAccess` false: no read, create, update
or delete) gets 404 for every data route on that table, and the table is absent from `GET /workspace`.

## Sessions and cache

- `createSecurityEngine(getMeta, ttlMs = 5000)` caches the roles and tables **per environment** for 5 seconds; `invalidate()` clears
  the current environment's cache (`'all'`: every environment; `{ environment: id }`: one, used when it is deleted) and is called by
  every role, user and table change route in the same process. In `services.ts` it also drops the environment registry and access
  cache (access follows roles). The per-request context is rebuilt from the cached roles
  each time, so a role edit takes effect on the next request (not on the next login). A change made behind the server's back
  (directly in the database) is seen after at most 5 seconds.
- The session cookie identifies the user; on every request the session row and the user record (including `roleIds`, `status`
  and `mustChangePassword`) are read from the database. A disabled user's session stops working immediately, a role assignment
  change applies to the next request, and a password set by an admin removes that user's sessions and sets
  `must_change_password`: until the user changes it, the router answers every route not marked `allowPendingPasswordChange`
  (`/auth/session`, `/auth/password`; `/auth/logout` and `/status` are `auth: 'none'`) with 403 `password_change_required`,
  before the handler runs.

## Where the client mirrors it (user experience only)

The browser **never** decides security. It mirrors the rules so that buttons are disabled, edits are refused before a round trip and
optimistic rows are not shown when they would certainly fail. The server remains authoritative and its answer wins (the optimistic
change is rolled back and `onDataError` fires; see `architecture.md`).

| Place | What it mirrors |
| --- | --- |
| `/home/claude/appbuilder-demo/src/platform/remote.ts`: `grantOf`, `rowOk`, `assertWritable` | Pre-validation of insert, update, delete using `Session.privileges`. Checks `create`, scopes and column access. The `own` scope is checked against the row's `owner`; `all`, the organisation scopes, rules and shares **are not mirrored** (`filtered` is true for organisation scopes, rules and tables with shares), the server decides. |
| `/home/claude/appbuilder-demo/src/platform/rowfilter.ts` | `matchesCondition` for `RowCondition` lists, shared by the demo-mode simulation and the remote client. Same rules as `condition.ts` for text, blanks and dates. |
| `/home/claude/appbuilder-demo/src/portal/security.ts` | `useMyAccess(table)` and `useCaps()` drive the portal: hide or disable create/edit/delete and read-only columns; admin and maker menus. `enforced` is false in demo mode (everything allowed). |
| `/home/claude/appbuilder-demo/src/platform/core.ts` | Demo mode: builds the same predicates with `src/platform/orgsec.ts` (organisation, rules, shares stored in `workspace.yaml`) and evaluates them in memory (`evaluateSync`, `memorySemi`, `rowfilter.ts matchesLeaf`). A **simulation** of roles for a single person at the keyboard. It is explicitly **not a security boundary** (everything is in the browser's storage). Never rely on it for protection. |

Differences between the mirror and the server to keep in mind: the client treats a missing `owner` on a row as "mine" for `own`
scope (new optimistic rows); demo mode treats a role named `Maker` as a maker even without the flag, while the server uses the
`is_maker` flag only; the client's `cmp` in `rowfilter.ts` does not include the server's "number against non-numeric text is not
comparable" rule.

## Testing the engine

- `/home/claude/appbuilder-demo/src/platform/orgsec.test.ts` runs the shared corpus `src/platform/testdata/orgsec-corpus.json`
  (organisation, tables, rows, shares, cases with expected rows) through the demo-mode evaluator and the server's in-memory
  evaluator; `/home/claude/appbuilder-demo/server/core/orgsec.integration.test.ts` runs the same corpus through the real engine and
  the PostgreSQL SQL (v1 and v2), plus the education and manufacturing examples over HTTP and the EXPLAIN checks.
- `/home/claude/appbuilder-demo/server/core/unit.test.ts` and `/home/claude/appbuilder-demo/server/routes/meta/security.test.ts`
  cover the union rules, row predicates, CLS, the 403 versus 404 decisions and the last-admin guard with in-memory fakes.
- `/home/claude/appbuilder-demo/server/core/integration.test.ts` runs the same flows against a real database when
  `APPBUILDER_TEST_DB` is set (see `testing.md`).
- When you add a rule, write the test first with a table of roles and expected rows; every union example above should stay covered.
