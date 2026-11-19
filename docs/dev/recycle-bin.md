# Recycle bin for deleted rows: design (not implemented)

Status: **design only** (P1 package C, Part 2 d). The support review asked for a recycle bin: deleted rows kept for N
days, restorable by people who could delete them. Doing it safely touches every read path, the delete path with its
relationship behaviours and collaboration cleanup, unique constraints, events, solutions and backups. It was not built
alongside approvals so that it does not land half-done; this page is the design to build it from.

## Requirements

- Per table: **Keep deleted rows for N days** (`TableDef.recycleDays`; default 30 on new tables, off on existing ones until
  enabled; 0 or absent = off, the delete is final as today).
- A deleted row disappears **immediately** from every query, count, aggregate, search, lookup, rollup, rule, formula,
  export, live tick and the timeline, exactly as if it were gone.
- People with delete rights on the row (the delete predicate at the time of the restore) and administrators list
  deleted rows (portal grid view **Deleted**) and restore them; `Restore(record)` in apps; `POST /data/:table/restore`.
- What the delete did (cascades, set-blank, collaboration cleanup, shares, attachment links) is undone by the restore.
- A purge job deletes for good after N days; unique constraints ignore deleted rows; outbox/events fire for delete
  (as today) and restore (new operation); solutions and backups are aware.

## Storage: a deletion batch, rows stay in place

Columns added to every recycle-enabled data table (default connection only; linked databases and data files keep final
deletes): `"deletedOn" timestamptz NULL`, `"deletedBy" text NULL`, `"deleteBatch" text NULL`. A **deletion batch**
records what one delete call did:

```
ab_delete_batches (id, table_id, root_ids jsonb, deleted_by, deleted_on, expires_on, state: 'deleted' | 'restored' | 'purged')
ab_delete_effects (batch_id, seq, kind, table_id, row_id, column_name, old_value jsonb, extra jsonb)
  kind: 'row' (soft-deleted: own or cascaded), 'setBlank' (a child lookup cleared: old value kept),
        'collab' (comments, activities, mentions, follows, tag links, attachment links moved aside), 'share' (ab_shares rows),
        'final' (rows of tables without a recycle bin that the cascade deleted for good: refuses the restore, see below)
```

The delete (`data.ts del` and `onParentDelete`) runs as today inside one unit of work, but for a recycle-enabled table it
`UPDATE ... SET "deletedOn" = now(), "deleteBatch" = $batch` instead of `DELETE`, and every side effect appends an effect
row: cascaded children (soft-deleted the same way when their table has a bin; otherwise deleted for good and recorded as
`final`), set-blank children (the old lookup value), collaboration rows (moved to `ab_recycled_collab` with their full
row instead of deleted, by `collab.afterDelete`), shares (copied before removal). Attachment files are not swept while a
batch that references them is not purged (the orphan sweep checks `ab_delete_effects`).

**Restore** = undo the batch, newest effect first, in one transaction: restore cascaded rows, put set-blank values back
**only where the child still has blank** (a value someone set since wins; reported), re-insert collaboration rows and
shares, clear the three columns of the root rows. Refused (409, nothing changes) when: the batch was purged; a `final`
effect exists and the caller is not an administrator (an administrator may restore anyway, with a warning that some
children are gone); a unique value was taken by another row since (the conflicting value is named); a restored lookup
would point at a row that no longer exists (cleared, reported). Required lookups to a parent that was itself deleted in
another batch: restore that batch first (the error says which).

## Reads: one predicate in one place

The deleted filter belongs to the security engine's row predicate, not to each caller: `rowPredicateFor` ANDs
`"deletedOn" IS NULL` into every operation's predicate for recycle-enabled tables (also for administrators and for
`ctx = null` system reads through a `liveRows` wrapper), so Query v2, v1, counts, aggregates, search, keyset paging, CSV
export, the live hub, lookups (`via` sub-selects use the target's predicate), the regarding rule (EXISTS probes) and
formula reads all inherit it. Paths that bypass the predicate and must be changed: `findRow` (the predicate is optional;
it gets a mandatory `includeDeleted` flag, default false), rollups and formula-column recomputation in `table-events.ts`
(they read with raw SQL), `NextNumber` (unaffected), reports (go through Query v2), the timeline's audit read (by row id:
fine), flows' data steps (DataService: fine). The **Deleted** view uses a separate read with `"deletedOn" IS NOT NULL AND
<delete predicate as of now>`.

**Unique constraints** become partial: `CREATE UNIQUE INDEX ... WHERE "deletedOn" IS NULL` (an in-place migration per
table when the bin is enabled; composite `uniqueTogether` likewise). Restore checks the value is free.

**Indexes**: a partial index `("deletedOn") WHERE "deletedOn" IS NOT NULL` for the Deleted view and purge; queries keep
their indexes (PostgreSQL uses the existing ones and filters `deletedOn IS NULL` cheaply). Expected cost at 1M rows: the
extra `IS NULL` filter on every scan, about 1-3 % on sequential scans, nothing measurable on index probes; to be
measured with `core-data-model-scale.integration.test.ts` extended to 1M rows with 10 % deleted, before and after.

## Events, flows, sync

Delete fires the outbox `delete` event as today (with the snapshot), plus `deleteBatch` in the payload. Restore fires a
new operation `restore` (table events and flow table triggers gain `restore` in `on`; default off so existing flows do
not change). The live hub sends a "table changed" tick.

## Who may

Restore needs the delete predicate on the row now (`ctx.rowPredicate(t, 'delete')` evaluated on the deleted row with
`includeDeleted`), so you cannot restore what you could not delete or cannot see; administrators always. Purging early
("Delete for good" in the Deleted view): administrators. Audit: `row.delete` gains `batch`, new `row.restore`,
`row.purge`.

## Purge, solutions, backups

Job `data.recycle-purge` (hourly): batches past `expires_on` are purged (rows deleted for good, effects and recycled
collaboration rows dropped, attachment files released) in chunks. Solutions: `recycleDays` is a table property (travels);
deleted rows never travel in data packages (exported with `deletedOn IS NULL`). Backups contain everything, batches
included; a restore keeps the bins. Environment copy with data: deleted rows are not copied.

## Work packages and tests

1. Columns, batches and effects, the delete path writing effects (cascade, set blank, collab, shares), restore and its
   conflicts. 2. The predicate in `rowPredicateFor` + `findRow` flag + rollups; partial unique indexes. 3. API, portal
   Deleted view, `Restore(record)`, table setting. 4. Events/flows `restore`, purge job, solutions/backups/copy.
5. Tests: every read path hides deleted rows (counts, aggregates, search, export, live, lookup via, regarding probe,
   rules, formulas); restore undoes cascade + set blank + collab exactly; conflicts (unique taken, value changed since,
   parent gone, final effects); security (a user who could not delete or see the row cannot list or restore it);
   events fire once; purge; 1M-row performance report.
