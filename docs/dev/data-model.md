# Data model designer (P0 package K)

The visual schema designer: Dev mode > Data model. Decision D21 in `docs/decisions.md`. Maker view:
`docs/guide/maker/data-model.md`.

| Module | What it does |
| --- | --- |
| `src/model/types.ts` | Shared types: `RelationshipDef`, `DeleteBehaviour`, `ReportingDef` (view, summary, date), `ModelOp`, `ModelPlan`, drafts, layouts |
| `src/model/ops.ts` | Pure editing helpers (add/remove tables and columns, relationships incl. junction tables), `diffModels`, `applyOps`, `checkOps`, `withImplicitRelationships` |
| `src/model/layout.ts` | Card geometry, layered auto-layout (`autoLayout`, `autoLayoutByArea`), relationship paths |
| `src/model/lint.ts` | Model checks |
| `src/model/patterns.ts` | Pattern generators (transactional, reporting, industry starters) |
| `src/model/dbml.ts`, `infer.ts`, `datedim.ts`, `svg.ts` | DBML export/import, spreadsheet inference, date dimension rows, the standalone SVG (export SVG/PNG) |
| `server/core/model/store.ts` | `ab_relationships`, `ab_model_layouts`, `ab_model_drafts`; version 7 step |
| `server/core/model/engine.ts` | Live model, plan, transactional apply |
| `server/core/model/delete-rules.ts` | Which relationships act on a delete (used by `data.ts`) |
| `server/core/model/summary.ts` | Summary tables: refresh SQL and the `model.summary.refresh` job |
| `server/core/model/introspect.ts` | Tables and foreign keys of a PostgreSQL/MySQL connection into a draft |
| `server/core/model/packages.ts` | Relationships, reporting settings and unique pairs in solution packages |
| `server/routes/meta/model.ts` | `/api/v1/model/*` routes |
| `src/portal/model/*` | The page: SVG canvas (no third-party canvas library), inspector, checks, dialogs, the zustand store, server/demo backends |

`src/model` is shared with the server like `src/fx`: relative imports with `.ts` extensions, only types from
`src/platform`, no React, DOM or packages (`src/model/model.test.ts` checks it).

## Drafts, ops, plans, apply

The browser keeps the **draft** as `{ base, model, past, future, layout }`: `base` is the live model when the draft
started, `model` the edited copy, `past`/`future` the undo stacks (30 each). It is saved (debounced) to
`ab_model_drafts` per user (demo mode: `localStorage`). The changes are always `diffModels(base, model)`, a list of
**ModelOps** (`createTable`, `updateTable`, `dropTable`, `addColumn`, `updateColumn`, `dropColumn`, `putRelationship`,
`dropRelationship`). Diffing against the draft's own base (not against the live schema) means another maker's change is
never reverted by a stale draft; `applyOps(live, ops)` replays a draft on a newer schema ("Rebase draft") and lists ops
that no longer fit.

Patterns, imports and (P2) data model **templates** produce a model; the diff produces ops; the same plan and apply
install them. A template install is `planModel` + `applyModel` with the ops of its fragment (master-plan 11.3 rule 3).

**Plan** (`POST /model/plan`, `planModel`): `checkOps` (consistency of the resulting model: names, lookups to existing
tables, unique pairs, view lineage, required-lookup circles, set blank on required) plus server checks: system tables
(only extra columns, when `extensible`), read-only links, reporting views only over default-database tables, columns
read by a view cannot be dropped. Items carry row counts (`connector.select count`), destructive flags (managed table or
column with values; lossy conversions), **conversion pre-checks** (every value, up to 200,000, through the same
`tryCoerce` the column route uses; lookup values checked against the target's ids; duplicates for a new unique flag or
unique pair), index notes and warnings. The **token** is a hash of ops, the live fingerprint, environment and user.

**Apply** (`POST /model/apply { ops, token, layout?, layoutScope?, clearDraft? }`, `applyModel`): plan again (problems:
422 with the plan; other token: 409 with the plan), `backup.snapshot(env, 'Data model change')` when available, then
**one unit of work** (`s.transaction`) that plans once more inside the transaction and executes:

1. relationship records that go; columns that go (calculated, then lookups, then others); tables that go (views first,
   then tables nothing else points at);
2. new tables in dependency order through the **same route handlers** the table designer uses (captured in-process by
   registering `registerTableRoutes` / `registerConnectionRoutes` on a recording router and called with a derived `Ctx`),
   so every validation, audit entry, default privilege and kernel job is identical; lookups to tables not yet created
   and calculated columns are deferred (lookups, then formula columns, then rollups); links go through `POST
   /connections/:id/link`;
3. added and changed columns, table settings, unique pairs (`CREATE UNIQUE INDEX` from `TableDef.uniqueTogether`);
4. date dimension rows (`importCsv`), summary tables (privileges, schedule, first refresh job), reporting views;
5. relationship records with draft ids mapped, then `sync()` so every lookup has a record.

The route's own `s.transaction` calls become savepoints, so a failure anywhere rolls back DDL, metadata and rows
(`model.integration.test.ts`, "a failing apply leaves nothing behind"). The audit entry is `model.apply` with the op list.

## Relationships and delete behaviours

`ab_relationships` (`id`, `from_table`, `from_column` (unique together), `to_table`, `kind` oneToMany | oneToOne | self,
`on_delete` restrict | cascade | setBlank, `def` jsonb: `preventCycles`, `junction.group`). A relationship always rests on
a lookup column. System columns (`createdBy`, `owner`, lookups to the system User table) are never relationships.

**Migration** (schema version 7, `upgradeEnvironmentTo7Model`): every existing lookup gets a record, required ones
`restrict`, optional ones `setBlank`. Before version 7 a deleted parent left children with a dangling id, which apps
showed as blank; now set blank clears it, and restrict protects required lookups. A lookup added later outside the
designer has the same default until it is recorded (`delete-rules.ts`).

**Enforcement** (`data.ts del()`, before the parent rows go, inside the delete's unit of work):

| Behaviour | What the DataService does |
| --- | --- |
| restrict | counts child rows pointing at the targets (every row, security ignored: integrity) and answers 409 with the count; rows of the same table deleted together do not count |
| cascade | the caller must be allowed to delete **every** child row (checked with their delete predicate, including rows they cannot read): otherwise 403 and nothing is deleted. Then `del()` recurses for the children with the caller's context: their before-events, outbox rows, audit entries, attachments, shares and their own relationships; at most 8 levels; a seen-set stops loops |
| setBlank | each child row is updated as the **system** (`update(null, ...)`): before-events, formula columns, outbox row, audit |

Self relationships with `preventCycles`: an update of the lookup walks the parent chain (at most 1,000 steps) and
answers 422 when it reaches the row; a new row cannot name itself.

## Reporting views and their security

A reporting view is a registered table (`ab_tables`) with `readOnly: true` and `reporting: { kind: 'view', role, base,
baseSource, columns: [{ name, source, expr? }] }`. The PostgreSQL connector creates it (`createViewSql`) **from the
lineage only**: `SELECT b.id, b.createdOn, b.modifiedOn, b.createdBy, b.owner, <mapped columns> FROM <base> AS b`, with
expressions limited to `value`, `dateKey`, `year`, `month`, `quarter`; never SQL text from a client or a package. One
base table per view: a star is a fact view plus dimension views; dashboards join them on the keys, each side secured.

Our row and column security lives in the application layer, so `security_barrier` views would not help. Instead
`buildUserContext` (`server/core/security.ts`) treats a view through its lineage:

- **rows**: `rowPredicate(view, 'read')` = `{ semi: { col: 'id', table: base, key: 'id', where: rowPredicate(base, 'read') } }`
  (const true/false pass through): the view's rows are exactly the base rows the reader may read, including
  organisation scopes, row rules, relationship rules and shares; the semi-join runs inside the one Query v2 statement;
- **columns**: a view column is `none` when its source column is `none` for the reader, else `read` (system columns map
  to themselves); a column not in the lineage is `none`;
- **writes**: never (create false, update/delete none; the table is read-only); share none;
- a view over a view, or whose base is gone, shows nothing.

The session's privileges mirror this (`filtered` when the base predicate is not constant). Tested in
`model.integration.test.ts` ("reporting views: a restricted user ...": own rows only, hidden measure absent, 403 on
select / filter / aggregate of it, aggregates over readable rows only, dimension views hide the dimension's hidden
column) and in the headless run (`scripts/docs-shots/datamodel.mjs`).

**Summary tables** are real tables (`reporting.kind 'summary'`) refreshed as the system by `model.summary.refresh`
(`DELETE` + `INSERT ... SELECT ... GROUP BY` in one transaction, one `bulk` outbox row), scheduled per table. Aggregates
cannot be filtered per reader, so access is decided at creation: non-admin roles get read only when they read **every**
row of the source (scope all, no row filter) and none of the used columns is hidden for them. **Date dimensions** are
read-only tables filled at apply time.

## Solutions, environment copy

- Package table entries carry `relationships` (child side); `TableDef.reporting` and `uniqueTogether` travel in the
  schema and are validated on import (`sanitizeReporting`, `sanitizeUniqueTogether`); `baseSource` is never exported and
  is re-derived (`prepareViewDef`) from the base table of the target environment; views are created after their base.
  The import plan lists new relationships and delete behaviour changes; install, upgrade and copy restore them.
- Environment copy copies `ab_relationships` and `ab_model_layouts`, creates views after tables and copies no rows into
  them. Summary schedules (`ab_schedules`) are not copied, and a schema-only copy has an empty date dimension.

## Layouts

`ab_model_layouts`: `user_id ''` is the shared layout, a user id a personal one (`PUT /model/layout { layout, scope }`).
`{ positions: { tableId: { x, y } }, areas: [{ id, name, color, tables }] }`. Positions of draft tables travel in the
draft and are mapped to real ids by apply.

## Routes

See `data-api.md`, "Data model". All maker routes; writes are design routes (403 in a locked production environment).
