# Core data model: system tables, the regarding rule, NextNumber

P0 package N, decision D23. Maker view: [docs/guide/maker/core-data-model.md](../guide/maker/core-data-model.md);
administrators: [docs/admin/reference-data.md](../admin/reference-data.md).

| Where | What |
| --- | --- |
| `src/platform/system-tables.ts` | The specs of the 40 system tables (P1-C added the six of the group Approvals, [approvals.md](approvals.md)) (ids `sys_*`, groups, columns, policy), `systemTableDef`, the built-in row predicates (`systemPredicate`, `regardingCondition`), rich-text sanitising and mention extraction, financial year and number formatting, seeded units / Indian states / settings. Shared by the server and demo mode. |
| `src/platform/system-reference-data.ts` | Countries (249) and currencies (159), generated once from CLDR 48.0 (Node 22, ICU 78.3). |
| `server/core/system-tables.ts` | Provisioning of an environment schema: views, tables, `ab_tables` registrations, extra indexes, seeds, attachment links; `copySystemData` for environment copies. |
| `server/core/collab.ts` | Write hooks (regarding normalisation and checks, mentions, cascades), the timeline, NextNumber, the mention / follow notification job, the orphan sweep. |
| `server/core/collab-routes.ts` | `/collab/*` routes (see [data-api.md](data-api.md#core-data-model-collab)). |
| `src/fx/functions/collab.ts` | Formula functions: macros (`Comments`, `Activities`, `MyTasks`, `Mentions`, `Setting`, `Convert`) and behaviour functions. |
| `src/controls/display/collab.tsx`, `src/portal/TasksPage.tsx` | Record timeline, Person picker, Tag input, Activity list; the Tasks and Mentions pages. |
| `src/platform/demo-collab.ts` | The same API in demo mode (in-memory, no security). |

## Tables

`TableDef` carries `system: true`, `systemGroup` (`people`, `collaboration`, `files`, `communication`, `logging`,
`reference`), `systemKind` (`table`, `projection`, `placeholder`), `systemPolicy`, `extensible` (custom columns allowed)
and `regarding` (the table has the polymorphic pair). Built-in columns are `locked`.

| Group | Real tables | Projections (views, read-only) | Placeholders (real, unused) |
| --- | --- | --- | --- |
| people | | Users (`ab.users` + environment access), Departments, Teams, Team members, Roles, Role assignments | |
| collaboration | Activities, Comments, Mentions, Follows, Tags, Tag links | Shares (`ab_shares`), Notifications (`ab.notifications`, own rows) | |
| files | Documents, Document versions, Attachment links | | |
| communication | | | Channels, Channel members, Messages, Message reactions |
| logging | | Audit entries, Sign-in log (`ab.signin_log` of package I when it exists, else an empty view), Job runs, Event runs, Flow runs (P1: a view over `ab_flow_runs`, see [flows.md](flows.md)) | |
| reference | Currencies, Units of measure, Countries, States, Calendars, Holidays, Number sequences, Settings | | |
| approvals (P1-C) | | Approval requests, Approval stages, Approval assignments, Approval history, Approval delegations, Approval policies (views over `ab_approval_*`; policy `approvals`, see [approvals.md](approvals.md#security)) | |

Projections are `CREATE VIEW` in `env_<id>` over `ab.*` and the environment's metadata tables; they select only safe
columns (never password hashes, MFA secrets, tokens, session data). They are dropped and created again at every
provisioning run, which is why every migration step starts with `dropSystemViews` (a step that alters a table a view
depends on would otherwise fail).

**Provisioning** (`provisionSystemTables`) runs inside the environment's migration transaction on create, on every
upgrade (both branches of `migrateEnvironmentSchema`) and after an environment copy. It is idempotent: tables are created
with the platform's own DDL (`createTableSql`) and completed with `ADD COLUMN IF NOT EXISTS`; `ab_tables` rows are upserted
with the stored definition merged with the platform columns (a maker's custom columns survive); `ab_role_tables` rows
for `sys_*` are deleted (roles never govern system tables); seeds run once per table (`sys.seed.<id>` markers in
`ab_counters`). A maker table that already had a system table's name keeps it; the system table becomes `Sys<Name>`.
The schema version stays 7 (shared number; this is an independent step).

**Extra indexes**: `(regardingId, createdOn DESC, id DESC)` on Comments, Activities, Documents, Mentions, Follows, Tag
links, Attachment links (the timeline and the per-record probes); `(AssignedTo, Status)` on Activities (My tasks);
`(MentionedUser, IsRead, createdOn DESC)` on Mentions (the inbox). The `createdBy` and `owner` columns of every table are
lookups to Users, so `createdBy.FullName` works in formulas and Query v2.

**Recycle bin** ([recycle-bin.md](recycle-bin.md)): when a record of a table that keeps deleted rows is deleted, the
collaboration rows about it are removed as before but handed to its deletion batch in full (`afterDelete(def, ids,
capture)`: `DELETE ... RETURNING to_jsonb(...)`; detached documents, channels and messages with their old link) and put back
by a restore. Activities, Comments and Documents may have their own recycle bin (off by default); the timeline leaves their
deleted rows out. The orphan sweep treats a record in a recycle bin as existing.

## The regarding rule (polymorphic security predicate)

A collaboration row is readable when the record it is about is readable. `regardingCondition(collab, env)` builds one
`Condition` (the same AST as role rules, compiled by `sql.ts` into the statement's WHERE):

```
  regardingTable IN (<tables the user reads entirely>)
  OR (regardingTable = 'tbl_a' AND EXISTS (SELECT 1 FROM env.tbl_a s WHERE s.id = outer.regardingId AND <tbl_a read predicate>))
  OR (regardingTable = 'tbl_b' AND EXISTS (...))
  ...
```

- Tables the user cannot read contribute nothing; tables with a row predicate in **another store** (linked MySQL, data
  files) contribute nothing either: fail closed. `MAX_REGARDING_TABLES` (500) caps the branches.
- Collaboration rows about collaboration rows only for Activities and Documents, one level deep (`depth`).
- `regardingTable` / `regardingId` are compared **exactly** (`LeafCtx.exact`): the write hook normalises them (table id,
  lower-case UUID), so no `lower()` per row and the indexes apply.
- The semi-join is **correlated** (`SemiJoin.correlated`): PostgreSQL plans it as a hashed subplan per table (the
  matching ids of a table are computed once) or a primary-key probe.
- Per-table policies (`systemPredicate`): Comments read/create = about; update/delete = about AND author. Activities read
  = about OR assigned to me / my teams OR my own unregarded ones (an assignee sees the task, not the record). Mentions
  read = about. Documents: about OR my own unregarded ones. Administrators: TRUE except Notifications (own rows). `share`
  is never allowed. Projections are never writable.
- Directory rule (Users, Departments, Teams): read only; Users of this environment (members of `ab.environment_access`
  or install administrators) with `Status = active` for non-administrators, and of Users only `FullName` and `Email` (department, manager, job
  title, phone, employee code and status are `adminColumns`, removed by column security; Departments' and Teams'
  descriptions likewise).
- The rule is hooked into `orgsec.rowPredicateFor` (server and demo), so every read path uses it: v1 query, Query v2
  (rows, count, aggregates, search, keyset paging), CSV export, the live hub's ticks, the timeline.

**Writes.** `collab.beforeWrite` normalises `regardingTable` (from the id alone when missing: ids are UUIDs unique
across tables), refuses a regarding id the writer cannot read with the same 422 as a missing record ("There is no record
with the id ..."), sanitises rich text (an allow-list of tags) and extracts mentions; a mention of someone who cannot
read the record is refused. `afterWrite` writes Mentions rows and enqueues `collab.notify`, which re-checks access when
it runs (a follower who lost access is skipped). Deleting a record (`afterDelete`) deletes its comments, mentions,
follows, tag links, activities and attachment links in the same unit of work; deleting a table deletes all of them for
the table. The `collab.orphan-sweep` job (schedule `sched_collab_sweep`, 03:47) removes rows about records deleted
outside Appbuilder.

### Leak tests

`server/core/core-data-model.integration.test.ts`, "LEAK": Cy cannot read Bo's order. For Comments, Mentions, Tag links,
Activities, Follows, Attachment links and Shares, Cy gets 0 rows and count 0 through Query v2, a v2 `count` aggregate and
v1 `count`; a search for the activity's subject returns nothing; the CSV export does not contain the comments; the
timeline answers 404; a comment about the order is refused exactly like a comment about a missing id; the live hub sends
Cy at most a "table changed" tick without row ids or the actor; no notification reaches Cy. Bo (own scope) sees the
comments about his order and not about Di's. Further tests: an assignee who cannot read the record sees the task only;
mention of a non-reader refused; followers that lost access are not notified; the directory rule (members, active,
columns). The headless walkthrough `scripts/docs-shots/core-data-model.mjs` repeats it in a browser (Raj: timeline 404,
Comments query 0 rows, no mention, nothing on his page).

## NextNumber

`collab.nextNumber(name)` runs inside the write's transaction: `SELECT ... FROM sys_number_sequences WHERE lower(Name) =
lower($1) ... FOR UPDATE`, computes the period (`never` / `yearly` / `financialYear` with `FinancialYearStartMonth`),
restarts at 1 in a new period, formats (`{FY}`, `{YYYY}`, `{YY}`, `{MM}`, padding) and updates `NextValue`. The row lock
is held until commit, so concurrent writers serialise on the sequence and a rolled-back write returns its number: the
sequence is gap-free for committed rows. A column default `=NextNumber("name")` is evaluated by `data.ts` in `buildRow`;
before/after table events get numbers through `setNextNumberProvider` (pre-allocated in the event's transaction).
Pinned by "NextNumber: gap-free and unique under parallel writers" (24 parallel inserts, 4 of them failing a required
column: 20 rows numbered 1..20, no duplicates, no gap, `NextValue` 21).

## Formulas and Query v2

Table functions are macros expanded in `analyze()` (`expandMacros`), so the delegation analysis and the translator see
plain `Filter` / `SortByColumns` / `LookUp` over the system tables (e.g. `Comments(r)` is
`SortByColumns(Filter(Comments, regardingId = RecordId(r)), "createdOn", SortOrder.Descending)`). `setSystemTableNames`
follows a `Sys<Name>` rename.

Query v2 gained the **`via` condition** (a lookup path: `{ via: { col: 'createdBy', table: 'sys_users', cond: ... } }`),
used for `createdBy.FullName = "Ada"` and for reading fields through a lookup. PostgreSQL compiles it to a sub-select on
the target with the target's own row predicate (and column security on the target's columns); the reference executor
uses `ExecuteOptions.related`. A path into another store is refused (no fallback that could leak). See
[query-v2.md](query-v2.md#4c-lookup-paths-via).

## Performance

`server/core/core-data-model-scale.integration.test.ts` (run with `APPBUILDER_BENCH=1`; `APPBUILDER_BENCH_SCALE` scales
it, `APPBUILDER_BENCH_EXPLAIN=1` prints plans): 50 user tables x 2,000 rows (100,000 records), 600,000 comments and
400,000 activities (1,000,000 collaboration rows) spread over all tables; user Bo reads his own rows of every table (an
`own` predicate, so all 50 tables are correlated branches). Medians over the HTTP API on the sandbox (PostgreSQL 16):

| Request | Bo (row-level on 50 tables) | Administrator |
| --- | --- | --- |
| Timeline of one record (30 items) | 24.6 ms | 12.5 ms |
| My tasks (200 tasks) | 88.6 ms | |
| Comments, newest 50, with total count (30,000 visible of 600,000) | 580 ms | 48 ms |
| Comments of one record through Query v2 | 30.5 ms | |

Two changes got there (before: generic query 53 s, my tasks 17.7 s, per-record 25.6 s):

1. exact comparison of the regarding columns (no ICU `lower()` per row and per branch; the timeline index applies);
2. **`jit=off`** for every pooled connection (`SESSION_OPTIONS` in `server/connectors/postgres/db.ts`): the predicate's
   cost estimate triggered JIT compilation with inlining of a very large expression, which took about 22 s per
   statement while executing it took under a second.

The generic query is dominated by checking every candidate row (a count over everything Bo may see). Apps should filter
by record (`Comments(record)`) or by user (`MyTasks()`), which use the indexes and stay in the tens of milliseconds.

## Solutions, environments, demo mode

- Packages never contain system tables. A custom column on a system table is exported as a column of the table
  (`tableEntry` with `system: true`) and added on import; locked columns are ignored by the ALM diff; a system table
  missing in the target is a problem, never "removed". Collaboration rows are not package data.
- `copyEnvironment` with data copies the collaboration and files tables (`COPYABLE_SYSTEM_TABLES`); a schema copy gets
  fresh seeds.
- The common business model (Accounts, Contacts, Addresses, Tax codes, Products, Price lists, Price list items) is a
  solution package (`sol_core_business_model` 1.0.0), served by `GET /api/v1/templates/business-model`, not provisioned.
- Demo mode creates the same tables in memory (`ensureSystemTables`, projections refreshed from the demo users), with
  the same hooks and NextNumber; it has no security, as everywhere in demo mode.

## Tasks, reminders, repeats and shares (P3 package T)

Details in [tasks.md](tasks.md). What the system tables gained, with **no schema version change** (`provisionSystemTables`
adds columns with `ADD COLUMN IF NOT EXISTS`):

- **Activities** columns: `Recurrence` (JSON text, tasks only), `RecurrenceParent` (lookup to Activities: the task this one
  was created from), `ReminderSentOn` (datetime), `Body` (limited rich text, notes), `Files` (file, multiple, 25 MB).
  Indexes: `ReminderOn`; a UNIQUE partial index on `RecurrenceParent` (one next occurrence per task, whatever happens).
- **ActivityShares** (`sys_activity_shares`, policy `parent`): `Activity` (the activity id, as *text*: a lookup would make
  deleting an activity wait for its shares), `PrincipalType` (`user` or `team`), `Principal` (the id), `Access` (`read` or
  `edit`); one row per activity and principal. Whoever can read the activity reads its shares; **only the activity's owner**
  (and administrators) create, change or delete them. Index on `(PrincipalType, Principal)`.
- **Activities read rule** is now: about OR assigned to me / my teams OR my own unregarded OR **shared with me or one of my
  teams** (the teams are the current ones, so leaving a team ends the share at once). Update additionally allows an `edit`
  share. Delete never follows a share. Comments about a shared activity follow the activity.
- Hooks (collab.ts calls `server/core/tasks/service.ts`): `beforeWrite` normalises `Recurrence`, sanitises `Body` and checks a
  share's target; `afterWrite` creates the next occurrence when a repeating task becomes Done; deleting an activity deletes
  its shares (recycle-bin aware).

## Not done (later packages)

Chat screens (the chat server exists since Phase 3 package A: [chat.md](chat.md); the communication tables are written by the chat service only), Documents UI beyond the timeline (folders,
check-out), editing a comment from the timeline, currency rates
from outside, a template gallery button for the business model.
