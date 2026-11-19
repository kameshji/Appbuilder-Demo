# Recycle bin for deleted rows

Status: **built** (P1, schema version 10). Maker view: [data.md](../guide/maker/data.md#deleted-rows-the-recycle-bin);
administrators: [operations.md](../admin/operations.md#recycle-bins); end users: [records.md](../help/records.md#i-deleted-something-by-mistake).
The original design is kept at the end of this page as "Deviations from the design".

| Module | What it does |
| --- | --- |
| `server/connectors/postgres/sql.ts` | `liveRowsSql` (the deleted-row predicate), `buildWhere` scopes (`live` / `deleted` / `all`), partial indexes, expression statistics, `enableRecycleSql`, soft delete / restore / purge statements |
| `server/connectors/postgres/query-v2.ts` | `where()` and `via()` always go through `buildWhere` |
| `server/connectors/postgres/index.ts` | `capabilities.recycle` and `connector.recycle` (enable, softDelete, restore, purge, stats): default connection only |
| `server/core/recycle-ddl.ts` | `ab_delete_batches`, `ab_delete_effects`, version 10 step |
| `server/core/recycle.ts` | batches, the store, restore, purge, the Deleted view, `setRecycleDays`, the purge job |
| `server/core/data.ts` | the delete path writes the batch (`del`, `onParentDelete`, `importCsv` replace), `deleteRows`, `restore` |
| `server/core/collab.ts` | collaboration rows removed with a record are handed to the batch (`afterDelete(def, ids, capture)`) |
| `server/core/data-routes.ts` | `GET /data/:table/deleted`, `POST /data/:table/restore`, `POST /recycle/restore`, `POST /data/:table/purge`, `GET /data/:table/recycle` |
| `src/platform/recycle-api.ts` | client API (`platform.recycle`), remote implementation, the demo batch log |
| `src/platform/core.ts` | demo mode: the same batches in memory |
| `src/portal/RecycleBin.tsx`, `src/portal/DataGrid.tsx` | table setting, storage note, Empty now; the grid's **Deleted** view |
| `src/runtime/UndoDelete.tsx` | the Undo toast (running apps and the portal grid) |
| `src/fx/functions/recycle.ts`, `src/runtime/data.ts` | `DeletedRows(Table)`, `Restore(row or batch)` |

## The setting

`TableDef.recycleDays` (0 or absent: off; 1 to 3,650) is the maker's setting; `TableDef.recycleBin` is **server-owned**: the
physical table has the three columns and the partial indexes, so every statement leaves deleted rows out. It is never taken
from a client or a package (`plainTableDef` strips it, `createPhysical` derives it).

- **New tables** of the default database start with 30 days (`POST /tables`, from CSV, data model designer; `recycleDays`
  in the body overrides). Tables from before version 10, tables from packages without the setting, linked tables and
  tables of other connections stay off: an upgrade changes nothing (tested from schema 9).
- **Turning it on** (`PATCH /tables/:id { recycleDays }`, `setRecycleDays`): `connector.recycle.enable` adds the columns
  (nullable, no rewrite) and rebuilds every live-row index as a partial index under the same name, then `ANALYZE`; reporting
  views over the table are created again with the live-row filter (`baseRecycle`). 1,000,000 rows: 17 s.
- **Turning it off** makes future deletes final. `recycleBin` stays: rows already in the bin stay hidden and restorable
  until their batch expires (the expiry is fixed at delete time; a changed number of days applies to new deletes).
- **Who may have one**: tables of the default database that Appbuilder manages; not reporting views, summary tables, date
  dimensions, read-only or linked tables. System tables: **Activities, Comments, Documents** may (off by default,
  `RECYCLABLE_SYSTEM_TABLES`; the only setting `PATCH` accepts for a system table); Mentions, Follows, Tag links,
  Attachment links and Document versions never have their own bin (bookkeeping rows: they go and come back with the
  record they are about); reference data and projections never.
- MySQL, external PostgreSQL databases, data files and Google Sheets: unchanged hard delete (`capabilities.recycle`
  false); the table designer says so.

## Storage

Rows stay in their table: `"deletedOn" timestamptz(3)`, `"deletedBy" text`, `"deleteBatch" text` (`RECYCLE_COLUMNS`, never
in `TableDef.columns`, never shown by the API: they are not in the DataService's column list, so `select` and conditions
on them are refused). Per environment (version 10):

```
ab_delete_batches (id, table_id, root_ids jsonb (first 1,000), row_count, deleted_by, deleted_on, expires_on,
                   source: user | flow | event | import | system, state: deleted | partial | restored | purged,
                   restored_by, restored_on, purged_on, details jsonb { keepDays, final, rootCount })
ab_delete_effects (batch_id, seq, kind, table_id, row_id, column_name, old_value jsonb)   PK (batch_id, seq)
  row       a row soft-deleted by this operation (own or cascaded)
  setBlank  a child lookup cleared by set blank: old_value = the parent id it had
  collab    a collaboration row removed with its record (comment, activity, mention, follow, tag link, attachment
            link): old_value = the full row (to_jsonb)
  detach    a document, channel or message that lost its regarding link: old_value = { table, id }
  share     an ab_shares row of a deleted row: old_value = the full row
  final     a row of a table WITHOUT a recycle bin that the cascade deleted for good (cannot come back)
```

Indexes of a table with a bin: `uq_` (unique), `ix_` (lookup, owner), `kx_` / `kd_` (Query v2 keys), `ix_<t>_natural` and
unique pairs are **partial** `WHERE "deletedOn" IS NULL`; `ix_<t>_deletedOn ("deletedOn" DESC, id)` and
`ix_<t>_deleteBatch` are partial `WHERE ... IS NOT NULL` (Deleted view, purge, restore). PostgreSQL keeps no statistics on
the expressions of a partial index (the planner looks only at non-partial indexes for them), so expression statistics
stand in: `CREATE STATISTICS stk_<t>_<col> ON (<sort key>)`, `stf_<t>_<col> ON (lower(col))` for unique, lookup and owner
columns, and `stk_<t>__natural` on the natural-order expression (`liveStatsSql`, `naturalStatsSql`). Without them a
grouped aggregate doubled (a hash join instead of 11 index probes) and equality filters estimated 0.5 % of the table.

## Reads: one predicate in one place

`liveRowsSql(def, ref?, scope)` returns `"deletedOn" IS NULL` for a table with a bin (`TRUE` otherwise). It is applied in
**`buildWhere`**, the only function that turns a table's row condition into SQL: it is ANDed in front of every condition
(also none and `const: true`). Everything goes through it:

- v1: `buildSelect` (rows and `count`), `buildUpdate`, `buildCountById`, `buildDeletes`: so the DataService's queries,
  CSV export, lookups by id (labels), restrict/cascade child counts, row locks by condition, writes to a deleted row (404);
- Query v2: `V2Builder.where()` always calls `buildWhere` (with or without a row filter): rows, counts, aggregates
  (natural and sorted), taken subsets, search; `via()` builds the target's sub-selects with `buildWhere`, so a lookup path
  to a deleted row finds nothing and counts as missing for `orMissing`;
- security: relationship rules and the regarding rule are semi-joins built by `semiJoin` inside `translate`, which ANDs
  the rule table's `liveRowsSql` (a deleted parent grants nothing);
- formulas and flows read through the DataService (LookUp, Filter, CountRows, data steps); scheduled reports run Query v2.

Raw SQL elsewhere calls `liveRowsSql`: rollups (`table-events.ts`, deleted children do not count), summary refresh
(`model/summary.ts`), reporting views (`createViewSql` with `baseRecycle`), the timeline (`collab.ts`, Comments,
Activities and Documents with a bin), export environment data, environment copy and system data copy. A unit test
(`recycle-sql.test.ts`, "no raw SQL against data tables without the predicate") scans the server's source for SQL against
data tables and fails for a file nobody reviewed. Reads that must see deleted rows say so: the Deleted view and restore
(`rows: 'deleted'`), the attachment orphan sweep (`findRow(..., { rows: 'all' })`: files stay until the purge), purge.

Tests: `recycle.integration.test.ts` "every read path leaves the deleted rows out" (v1 rows, count, ids, filters; Query v2
count, aggregates, grouped, search, pages, `via` and `orMissing`; CSV export; rollups drop and come back; formulas reading
other tables; timeline 404; a lookup to a deleted row refused; attachment download 404), reporting view and summary SQL
(`recycle-sql.test.ts`), EXPLAIN parity (same index for point lookups, unique keys, sorted and natural pages, Query v2
equality; estimates stay right).

## Deleting: one batch per operation

`data.ts del()` decides at the **first table** of the operation: when it keeps deleted rows (`recycleBin` and
`recycleDays > 0`, default connection, batch store available) a `BatchCtx` is created and travels down the cascade. Every
step records its effect:

- the rows: `UPDATE ... SET "deletedOn", "deletedBy", "deleteBatch" WHERE id = ANY(...) AND "deletedOn" IS NULL AND
  <delete permission> RETURNING id`: exactly the rows this statement deleted (a concurrent delete of the same row deletes
  it once; the second caller gets the rest, or 404 for a single row);
- cascade into a table with a bin: soft-deleted in the same batch; into a table without one: deleted for good as before,
  recorded as `final`;
- set blank: the child update runs as before (events, outbox) and the old parent id is recorded;
- attachments: nothing happens (records and files stay until the purge);
- shares: removed and recorded in full; collaboration rows: removed by `collab.afterDelete` with `capture`, recorded in
  full (comments take their mentions, activities their own collaboration rows); documents, channels and messages are
  detached and their old link recorded;
- before-delete events run as before (they may Reject); outbox rows as before (`delete` with the snapshot, or `bulk` with
  `action: delete`) with `batch` in `details`; audit `row.delete` with `batch`.

The root writes `ab_delete_batches` and the effects at the end, in the same unit of work. `importCsv(mode: replace)`
soft-deletes the replaced rows as one batch with source `import` (their unique values are free at once: the partial index).
When the first table keeps no deleted rows, everything is final as before (even cascades into tables that have a bin).

`source`: `user` (a person's request), `flow` (a flow data step: the work chain's last entry is `flow:`), `event` (a
table event or a job acting for a user), `import`, `system`.

## Restore

`restore(ctx, table, { batch } | { rowId })` in **one transaction** (the batch row is locked `FOR UPDATE`: two restores of
one batch restore it once, the second answers 409):

1. **What comes back**: the whole batch, or one row **and the rows its delete took along** (rows of the batch whose lookups
   point at it, transitively). A row whose parent waits in the same batch cannot come back alone ("Restore the whole
   batch").
2. **Permission**: administrators always; others must be able to **delete and see** every row they bring back of the
   batch's own table (or of the row's table for one row), checked on the deleted rows (403, or 404 when they see none:
   someone else's batch answers like a missing one) and again on the restored rows before commit (relationship rules see
   their restored parents). Cascaded rows follow their parent, as the delete required the permission on them.
3. **Unique values**: a live row using a unique value or unique pair since refuses the restore (409, naming that row by
   its primary column and id).
4. **Parents**: a required, restrict or cascade lookup must point at a live row or at a row of this batch; a parent in
   another open batch: 409 "restore that first" (with its batch id in `extra.needs`); a parent gone for good: 409. An
   optional set-blank lookup to a parent that is gone is cleared (warning).
5. **Final rows**: a batch with `final` effects: administrators may restore the rest (warning), others get 409.
6. The undo, newest effect first: rows back (`buildRestore`), cleared lookups, set-blank values back **only where still
   blank** (a value set since wins: warning), collaboration rows and shares put back (`jsonb_populate_record`, `ON CONFLICT
   DO NOTHING`: a row whose key is in use stays out, warning), detached links back where still blank.
7. **Not re-run**: validation rules, before-events, formula columns and required checks of the restored rows (they come
   back as they were). The effects done are dropped; the batch becomes `restored` or `partial`.
8. Audit `row.restore` (batch, count, ids); per table an outbox row `bulk` with `details.action = 'restore'`: rollups
   reconcile (they include the rows again), the live hub tells open screens (as an import-like change), after-events and
   flow table triggers see operation `restore`.

`POST /recycle/restore { batch }` restores by batch id alone (the formula `Restore(batch)`); the batch's own table decides
who may.

## Events and flows

`TableEventOperation` and flow `TableOperation` gain `restore`. It is **opt-in**: existing events and triggers list
create/update/delete and never fire on a restore. Only after-events may list it (a before-event with `restore` is refused:
nothing to check or refuse). `Trigger.Operation` is `"restore"`, `Trigger.Old` is blank. Deletes fire exactly as before.

## Purge

`data.recycle-purge` (built-in schedule `sched_recycle_purge`, hourly at :23; payload `{ batches: 50 }`): expired open
batches, each in its own transaction: rows deleted for good in chunks of 5,000 (`buildPurge`), then their attachment
records (files by the existing after-commit job), the effects dropped, the batch `purged`, audit `row.purge` (batch, rows,
reason `expired`). Collaboration rows and shares went at delete time. A safety net purges deleted rows whose batch is not
open any more (a table restored from a backup) once they are older than the table's retention.

Administrators: `POST /data/:table/purge { batch }` (delete for good now, reason `admin`) and `{ all: true, confirm: <table
name> }` (**Empty now**: every open batch with rows of the table, reason `empty`, audited `table.recycle.empty`).
Purging works per batch, so no batch is left half restorable.

`GET /data/:table/recycle`: `{ enabled, keepDays }` for everyone who can use the table; makers and administrators also get
`deletedRows`, `bytes` (`pg_column_size` of the deleted rows; attachment files not counted) and `batches` (the table
designer's storage note).

## The Deleted view, Undo, formulas

- `GET /data/:table/deleted?limit&skip&batch`: deleted rows the caller could delete and can see (administrators: all),
  newest first, columns as in any query (column security applies) plus `__deleted { on, by, byName, batch, expiresOn,
  daysLeft, rootTable, rootTableName, cascaded, batchRows, source }`.
- Portal grid: **Rows / Deleted** toggle for tables with a bin: restore a row (with what it took along) or the whole
  batch, delete for good (administrators). The delete confirmation says where the rows go.
- Running apps and the portal grid: after a delete that kept rows, "N rows deleted (with related rows). Kept for N days.
  Undo (10)": Undo restores that batch. Deletes of tables without a bin show nothing (they are final). No UI component.
- `DeletedRows(Table)` (security-trimmed on the server, cached per session, at most 500 rows, refreshed after deletes,
  restores and purges in the session and when the table's queries change) and `Restore(row or batch)` let makers build
  their own recycle bin screen. Both appear in the formula reference.

## ALM and operations

- `recycleDays` travels in solutions (plan line when it changes; an upgrade that turns it on adds the columns);
  `recycleBin` and `baseRecycle` never travel. Deleted rows never travel in solution data (packages read through the
  DataService).
- Export environment data: deleted rows only when the administrator ticks **Include deleted rows** (then with the three
  columns; `manifest.json` says `includesDeletedRows`).
- Environment copy with data: deleted rows are not copied; `ab_delete_batches` / `ab_delete_effects` are not copied.
- Backups contain everything (rows in bins and the batch tables); restoring an environment restores its bins. Restoring
  single tables from a backup brings their deleted rows back without batches: the purge's safety net removes them after
  the retention.
- Dropping a table is unchanged and not covered by the bin (backups are); the table designer says so.

## Demo mode

`createDemoRecycleLog` in the browser store: same semantics (one batch per delete, cascade and set blank recorded,
restore a batch or a row with what it took along, unique values checked, administrators purge), kept **in memory**: a
reload of the page empties the bins (the CSV files hold live rows only). Collaboration rows of a deleted record stay where
they are in demo mode (hidden with the record) and go at purge.

## Performance

Sandbox, 2 vCPUs, PostgreSQL 16, `scripts/bench/seed-million.mjs` over HTTP, 1,000,000 rows. Two tables with the same
rows: one without a bin, one with the bin and 10 % of its rows deleted (99,790). Medians of 7 runs, two interleaved
rounds (round 1 / round 2, ms). The machine's noise between rounds is up to 30 %.

| Query | Without bin | With bin, 10 % deleted |
| --- | ---: | ---: |
| First page (100 rows, natural order) + exact count | 50 / 47 | 45 / 57 |
| Filtered page, indexed column (0.1 %) | 7 / 11 | 9 / 11 |
| Filtered page, indexed column (25 %) + count | 186 / 263 | 205 / 311 |
| Filtered page, non-indexed column (2 %) | 9 / 9 | 7 / 12 |
| Filtered page, non-indexed text (contains) | 26 / 47 | 20 / 32 |
| Search in Title, City (trigram) + count | 32 / 41 | 22 / 26 |
| Search in Note (not indexed) + count | 977 / 1120 | 759 / 940 |
| Sorted page (Amount desc), first page | 7 / 7 | 11 / 13 |
| Sorted page (Amount desc), deep cursor (90 %) | 7 / 7 | 8 / 16 |
| Exact count, whole table | 52 / 45 | 27 / 52 |
| Exact count, Due in 2024 (indexed range) | 112 / 81 | 81 / 116 |
| Grouped aggregate: by City, count + sum | 571 / 440 | 352 / 564 |
| Grouped aggregate: by Status, sum(Amount * Qty) | 646 / 473 | 487 / 626 |
| Sum over the whole table | 119 / 114 | 123 / 137 |

No regression beyond noise. Before the expression statistics and the partial `ix_` indexes, the whole-table count took
113 ms (a sequential scan instead of an index-only scan of the owner index) and the grouped aggregate 885 ms.

Cascade batch of 10,001 rows (1 parent, 10,000 children, cascade): delete 0.81 s (a final delete of the same: 0.35 s),
restore 1.30 s, purge 0.11 s. Turning the bin on for 1,000,000 rows: 17 s (index rebuild); soft-deleting 99,790 rows by
SQL: 3.5 s.

## Deviations from the design

- **Predicate place**: the design put `"deletedOn" IS NULL` into the security engine's `rowPredicateFor`. Built in the SQL
  builder's `buildWhere` instead: system reads (`ctx = null`), administrators (constant-true predicates), counts and
  updates all pass there without a wrapper, and no Condition can drop it. The security engine is unchanged.
- **Key and natural-order indexes partial** (the design kept them full): asked for by the package; done, with expression
  statistics (not in the design) because partial expression indexes lose PostgreSQL's statistics. `ix_` (lookup, owner)
  indexes became partial too, so a whole-table count stays index-only.
- **Collaboration rows**: the design moved them to an `ab_recycled_collab` table; built as full-row effects
  (`to_jsonb`) in `ab_delete_effects`, put back with `jsonb_populate_record`. Comments with their own bin are captured the
  same way when their record is deleted (not soft-deleted twice).
- **Single-row restore** brings the rows the row's delete took along (the design restored only the row).
- **`final` effects** are refused for non-administrators and restored around (with a warning) for administrators, as
  designed; the design's "a restored lookup to a parent that no longer exists is cleared" applies only to optional
  set-blank lookups; required, restrict and cascade lookups refuse.
- **Turning the setting off** keeps `recycleBin` and the rows already in bins (the design did not say).
- **Purge granularity** is the batch ("Empty now" purges every batch with rows of the table, including rows of other
  tables in those batches), so no batch is left half restorable.
- **Solutions**: deleted rows never travel in solution data (no "include deleted" there: a package would turn them into
  live rows); the option exists for export environment data only.
- **Demo mode** keeps the bins in memory only.
