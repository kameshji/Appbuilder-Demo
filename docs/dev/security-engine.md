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

What is not supported: there is no per-row sharing or ACL, no deny rules (access only ever grows when roles are added), no field-level
security on formulas or app definitions (an app definition is readable by anyone allowed to run the app; do not put secrets in it),
no time-limited grants, and no security on `files`-connector tables beyond the same engine (it applies uniformly).

## Concepts

| Term | Meaning |
| --- | --- |
| Role | A named set of table privileges, an app list and two flags: `isAdmin`, `isMaker`. Built in: `role_admin`, `role_maker`, `role_viewer`. |
| User | Holds zero or more roles (`roleIds`). The effective rights are the **union** over the user's roles. |
| Table privilege | Per role and table: `create` (boolean), `read`, `update`, `delete` (each `none`, `own` or `all`), optional `columns` (CLS map), optional `rowFilter` (RLS conditions). |
| Scope | `none` < `own` < `all`. `own` means rows whose `owner` column equals the user id. |
| System columns | `id`, `createdOn`, `modifiedOn`, `createdBy`, `owner`. Server-assigned; never writable by clients. |
| Row filter | A list of `RowCondition { column, op, value? }`, ANDed together. Value tokens: `@me` (the user's id) and `@myEmail` (the user's email). |

## Admin and maker

- **Admin** (`isAdmin` on any of the user's roles): everything is allowed. Row predicate is `{ const: true }`, scopes are all `all`,
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

## Where the engine is enforced (`data.ts`)

All data routes call `DataService`, which receives the `UserContext`.

**Query**
1. Every referenced column (select, where, orderBy) must exist (422) and not be `none` for the user (403).
2. The read predicate is ANDed into `where`. If it is `{ const: false }` the answer is empty rows immediately (`total` 0 when
   `count`).
3. If `select` is empty and some columns are hidden, the select list is narrowed to the visible columns; rows are then filtered
   through `rowOut` so hidden columns never leave the server.
4. Cap and `truncated` as in `data-api.md`.

**Insert**
1. `canCreate(T)` else 403. The table and connector must be writable (`readOnly` tables and non-`write` connectors: 403).
2. Each supplied column: system columns are ignored (except a client-supplied UUID `id`); autonumber is server-assigned; any other
   column needs access `update` (hidden: 403, read-only: 403).
3. `createdBy` = `owner` = the user. **WITH CHECK**: the complete new row (with defaults) must satisfy
   `rowPredicate(T, 'create')` = OR over the roles granting `create` of that role's row filter (tokens resolved; no owner term,
   because the creator owns the row; a granting role without a filter allows any row; admins: `TRUE`). Otherwise 403, nothing
   written. Evaluated in memory with `evaluateCondition` (`server/core/condition.ts`).
4. Required, unique, lookup and attachment checks, then insert. A row the user may create but not read afterwards is allowed
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
   deleted. Ids the user cannot read are silently skipped. The deletable ids then go to one `connector.delete` call (MySQL: one
   transaction over the chunks). If exactly one id was requested and nothing was deleted the answer is 404.
2. Deleting also removes the attachments of those rows.

**Import** (`/data/:table/import`): needs create; columns the user cannot update are ignored (not errors); every row passes the
insert checks above (including the create WITH CHECK) before anything is written; `replace` deletes the rows under the delete
predicate and inserts the new ones, in one transaction on MySQL.

**Export** (`/tables/:id/csv`): visible columns, rows under the read predicate.

**Attachments** (`attachments.ts`): upload needs `update` column access plus the update guard on the row (403 or 404 as above); read
and `resolve` need row read access; delete needs `update` column access and the update guard.

**Visibility** (`data-routes.ts`): a non-maker with no privilege at all on a table (`hasAnyTableAccess` false: no read, create, update
or delete) gets 404 for every data route on that table, and the table is absent from `GET /workspace`.

## Sessions and cache

- `createSecurityEngine(getMeta, ttlMs = 5000)` caches the roles and tables for 5 seconds; `invalidate()` clears the cache and is
  called by every role, user and table change route in the same process. The per-request context is rebuilt from the cached roles
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
| `/home/claude/appbuilder-demo/src/platform/remote.ts`: `grantOf`, `rowOk`, `assertWritable` | Pre-validation of insert, update, delete using `Session.privileges`. Checks `create`, scopes and column access. The `own` scope is checked against the row's `owner`; the `all` scope and RLS **filters are not mirrored** (flagged by `filtered`), the server decides. |
| `/home/claude/appbuilder-demo/src/platform/rowfilter.ts` | `matchesCondition` for `RowCondition` lists, shared by the demo-mode simulation and the remote client. Same rules as `condition.ts` for text, blanks and dates. |
| `/home/claude/appbuilder-demo/src/portal/security.ts` | `useMyAccess(table)` and `useCaps()` drive the portal: hide or disable create/edit/delete and read-only columns; admin and maker menus. `enforced` is false in demo mode (everything allowed). |
| `/home/claude/appbuilder-demo/src/platform/core.ts` | Demo mode: a **simulation** of roles for a single person at the keyboard. It is explicitly **not a security boundary** (everything is in the browser's storage). Never rely on it for protection. |

Differences between the mirror and the server to keep in mind: the client treats a missing `owner` on a row as "mine" for `own`
scope (new optimistic rows); demo mode treats a role named `Maker` as a maker even without the flag, while the server uses the
`is_maker` flag only; the client's `cmp` in `rowfilter.ts` does not include the server's "number against non-numeric text is not
comparable" rule.

## Testing the engine

- `/home/claude/appbuilder-demo/server/core/unit.test.ts` and `/home/claude/appbuilder-demo/server/routes/meta/security.test.ts`
  cover the union rules, row predicates, CLS, the 403 versus 404 decisions and the last-admin guard with in-memory fakes.
- `/home/claude/appbuilder-demo/server/core/integration.test.ts` runs the same flows against a real database when
  `APPBUILDER_TEST_DB` is set (see `testing.md`).
- When you add a rule, write the test first with a table of roles and expected rows; every union example above should stay covered.
