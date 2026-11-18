# Decision log

Why things are the way they are. Newest last. Each entry: decision, why, consequences, status.
Add an entry whenever a choice would surprise a new developer or would be expensive to reverse.

## D1. Own the experience, not Microsoft's artifacts (Nov 2026)
**Decision.** Rebuild the maker experience of Power Apps (formula per property, reactive canvas, metadata-driven tables,
role security, trigger/action flows) as our own product. No Microsoft code, docs text, icons, colours or names.
**Why.** The value for small businesses is the experience; the Microsoft stack is licensed per user and cloud-bound.
**Consequences.** Apps are not compatible with Power Apps (no import/export). Function names are familiar but our own.
**Status.** Active.

## D2. React + TypeScript everywhere, not Flutter (Nov 2026)
**Decision.** Studio, runtime and server are TypeScript; UI is React with shadcn-style components.
**Why.** The formula engine must run in the Studio, the running app, the server and (later) flows; one language means one
engine. The formula editor needs DOM text-editing tooling. Flutter would only win for native-widget mobile apps.
**Consequences.** Desktop and Android packaging will be shells (Tauri / Capacitor) around the same web runtime.
**Status.** Active. Packaging not built yet.

## D3. Own formula engine ("Fx"), Power Fx only as behavioural reference (Nov 2026)
**Decision.** A TypeScript engine with Excel-style syntax and familiar function names, written from documented behaviour.
**Why.** Microsoft's Power Fx is MIT-licensed but C#-only and heavy to embed in a browser and Android WebView.
**Consequences.** Simplifications: no full static type inference, one locale for syntax, `;` chaining only in action
properties, two-argument and multi-pair IfError, enum names shadow variables (Size, Icon, Layout...). 151 built-in functions (see docs/reference/formulas.md),
user-defined functions and named formulas. Behaviour differences must be documented in the formula reference.
**Status.** Active.

## D4. Desktop-first, landscape only (Nov 2026)
**Decision.** Apps are designed at 1920×1080 or 2560×1440 and adapt to any landscape window with anchors and auto-layout
containers. No portrait or phone layouts.
**Why.** Target users run business apps on desktops and laptops.
**Status.** Superseded in part (Nov 2026): phone and tablet design sizes, including portrait, were added for the P2
"supervisor logs production from a phone" exit check (master plan section 5). An app still has one design size; desktop
apps stay landscape and responsive as described here.

## D5. Use existing component libraries behind adapters (Nov 2026)
**Decision.** Controls wrap shadcn/Radix components and other permissive libraries (Recharts, react-day-picker, cmdk,
react-useanimations). Only the control registry imports them.
**Why.** Speed and quality; replaceable later. Only MIT/Apache/BSD dependencies ship in the product.
**Status.** Active. Third-party notices must ship with every release.

## D6. Data and security live on the server (phase 3, Nov 2026)
**Decision.** A local Node server owns data access. It authenticates users (scrypt passwords, HttpOnly session cookie)
and enforces role privileges (RBAC), row filters and own-row scope (RLS) and column access (CLS) on every request.
**Why.** Browser-side rules are a simulation; anything sold to a business must enforce access on the server.
**Consequences.** The browser-only demo mode remains for the hosted demo page and simulates the same rules (not secure).
**Status.** Active. The store the server owns is PostgreSQL since D14 (it was MySQL/MariaDB); the rules themselves are unchanged.

## D7. MySQL is the default store; other sources are connectors (phase 3)
**Decision.** MySQL/MariaDB holds the system tables (`ab_*`) and new user tables. Data files (CSV/XLSX/JSON) and Google
Sheets are connectors behind one interface. SQL is kept portable to MySQL 5.7+/8.x and MariaDB 10.4+.
**Why.** Small-business shared hosting offers MySQL + PHP; the same schema can then be served by a PHP gateway.
**Status.** Superseded by D14 (18 Nov 2026): the system store and the default connection are PostgreSQL; MySQL/MariaDB stays as a
connector for customers' existing databases. The "other sources are connectors" half still holds.

## D8. Data files are copies, device-only, and travel only inside solutions (phase 3)
**Decision.** (Owner's design.) A picked file is copied into `workspace/files`; the original is never modified; one
table per sheet. To take file data online it must be packaged in a solution, and importing offers database tables or
file. "Move to database" converts a file table to a table of the default database (PostgreSQL since D14) keeping its name.
**Status.** Active.

## D9. Optimistic writes from the browser (phase 3)
**Decision.** Patch/Collect/Remove update the screen immediately after client-side pre-validation; the server decides;
refusals roll back and raise an error event.
**Why.** The formula engine is synchronous; making action formulas await the server is a large engine change.
**Consequences.** A step after a refused write (e.g. Navigate after Patch) has already run. Forms wait for the server
before reporting success.
**Status.** Active; awaiting-actions planned.

## D10. Row cap instead of query delegation, for now (phase 3)
**Decision.** Apps load up to 5,000 rows per table and warn when truncated; formulas filter in memory.
**Why.** Pushing formula filters down to the database needs the delegation layer (Query AST from Fx), not built yet.
**Status.** Superseded by D16 (P0 package D, Nov 2026): PostgreSQL tables are queried on the server with paging and exact counts;
only connectors that cannot run queries still work on their first 5,000 rows, and say so.

## D11. Attachment ids start with `att_` (phase 3)
**Decision.** Server and demo mode generate `att_<random>`; cells store the id (or a JSON array of ids).
**Why.** The runtime must recognise attachment cells without schema look-ups in every control.
**Status.** Active.

## D12. Hosted next via a PHP gateway implementing Data API v1 (planned)
**Decision.** For shared hosting, reimplement `/api/v1` in PHP over the same `ab_*` schema instead of running Node.
**Why.** Typical shared hosting has PHP + MySQL and no long-running Node processes.
**Status.** On hold: D14 moved the system store to PostgreSQL, so a gateway would need PostgreSQL hosting or its own schema port.

## D13. One formula engine for browser and server; non-delegable formulas are errors (P0, Nov 2026)
**Decision.** The formula engine (`src/fx`) is shared: the server imports it directly under Node type stripping, so it stays free of
React, the DOM and packages, uses explicit `.ts` imports and erasable TypeScript, and reaches the environment only through `FxHost`.
User-defined functions and named formulas belong to an engine instance (`createEngine`), never to a global active set. Formulas over
data-source tables are translated into Query v2 plans (`src/fx/query`, `docs/dev/query-v2.md`) that must give exactly the engine's
result; a formula over a table that cannot be translated is an **error shown in the Studio**, not a silent result over the rows that
happen to be loaded. Only a collection, or a table known to be fully loaded and small, may be evaluated in the browser (a warning).
**Why.** Million-row tables (P0 exit check 2 and 3) cannot be filtered in the browser, and a partial result looks right while being
wrong. One engine on both sides keeps table events, jobs and pushdown consistent with what makers see in the Studio. Per-instance
user functions remove the cross-app interference that the shared active set had (two app tabs, or two server requests).
**Consequences.** Some formulas that work today over 5,000 cached rows will show an error once package D switches the data layer to
plans (calculations on columns, `Concat` over a whole table, nested lookups); the error names the sub-expression and a rewrite.
Plan semantics (blanks, case, sort ties) are fixed by `query-v2.md` and a parity test; the PostgreSQL side implements them.
Supersedes architecture rule 3 ("the server never imports client code") and, once package D lands, D10.
**Status.** Active (engine sharing and translator); delegation errors visible to makers with package D.

## D14. PostgreSQL is the system database; MySQL/MariaDB is a connector (P0, Nov 2026)
**Decision.** (Owner decision of 18 Nov 2026, `docs/plan/master-plan.md` section 9.) The system store and the default data
connection are PostgreSQL 15+ (we install 17; CI and the sandbox run 16), driver `pg` (MIT). One database per install: schema `ab`
holds install-wide objects (settings, users, sessions, environment registry, licence), and each environment is one schema
`env_<id>` holding its metadata tables and its data tables (today only `env_default`). Requests carry an environment id that the
server resolves to a schema (`server/core/env-context.ts`); every statement uses fully qualified names, never `search_path`, and
pooled connections start with `search_path=pg_catalog,pg_temp`. Caches are keyed by environment. Schema changes and app/solution
imports run as one transaction (units of work, transactional DDL). Types: ids `text` (UUIDv7), timestamps `timestamptz`,
metadata documents `jsonb`, flags `boolean`, currency `numeric(19,4)`. Text conditions lowercase both sides (ICU root collation when
the server has it) and order by code point, matching the in-memory reference exactly. The MySQL connector stays for linking and
creating tables in a customer's MySQL/MariaDB; its tests run against MariaDB (`APPBUILDER_TEST_MYSQL`).
**Why.** Transactional DDL (a failed import or schema change leaves nothing behind), schemas for environments with per-environment
backup (`pg_dump --schema`), `jsonb`, `FOR UPDATE SKIP LOCKED` for the job queue (P0 package G), exact case-insensitive comparison
without collation surprises, and one well-supported database to install on Windows and Linux. The PHP gateway (D12), the only
reason for MySQL as the system store, is on hold.
**Consequences.** No migration path from a MySQL system store (there are no customers); a database with schema versions 1 to 3 is
refused. `scripts/setup-mysql.ps1` is replaced by `scripts/setup-postgres.ps1` and `scripts/setup-postgres.sh`; backups are
`pg_dump`/`pg_restore` (`docs/admin/backup-and-restore.md`). Behaviour differences from the MySQL store: case-insensitive comparison
no longer ignores accents or trailing spaces (`"cafe" <> "café"`, `"a " <> "a"`), text ordering is by code point instead of the
`utf8mb4_unicode_ci` collation, `contains` needs no LIKE escaping. The client's `rowfilter.ts` already follows the reference
(`condition.ts`), so it is in parity with the server again. Supersedes D7 and the MariaDB bundle of the master plan section 3.1.
**Status.** Active (package A of `docs/plan/p0-spec.md`).

## D15. Environments: install administrators, per-environment roles, stable-id solutions (P0, Nov 2026)
**Decision.** (P0 package E, `docs/plan/p0-spec.md`.) An environment is one schema `env_<id>` plus one workspace folder
`workspace/env/<id>/`; at most 5 per install by default (`APPBUILDER_MAX_ENVIRONMENTS`). Every request names its environment in the
`X-Appbuilder-Environment` header (`?env=` on GET links); the server checks it against the session (`ab.environment_access`) and
never trusts it blindly. Without one it uses the user's last environment (`ab.users.last_environment_id`), then Default.
Administration is split in two: the **install administrator** (`ab.users.is_install_admin`: environments, accounts, the
install-level audit `ab.audit`, administrator everywhere) and the **environment administrator** (an Administrator role in that
environment, as before). Holding a role in an environment grants access to it; revoking access removes the roles there; the access
row's `is_env_admin` mirrors the roles (kept in step by the MetaStore). Solution packages carry stable ids (the solution's and its
components'); importing where they exist is an **in-place upgrade** after a plan whose token the administrator confirms, in one
transaction, after a `backup.snapshot()` hook (package J implements it; today it takes no backup and says so). Production
environments can be locked: the router refuses `DESIGN_ROUTES` there, so they change only through solution import or deploy.
Migrations run `ab` in one transaction, then each environment in its own; a failing one is marked failed and does not block the
others.
**Why.** Power Platform's model (users per tenant, security roles per environment, managed solutions moved by ALM) without its
pain points (`docs/research/power-platform/admin-and-environments.md`): no shared free-for-all default, a small fixed number of
environments, one access list, real copies made inside the database, and a plan that shows destructive changes before they happen.
Keeping "environment administrator = Administrator role" kept every existing role, test and UI meaning, and made the 4 to 5
migration lossless (today's administrators become install administrators, so nobody loses a power they had). Upgrades match by id,
not by name, so renaming in a sandbox does not create duplicates in production; app packages stay a copy mechanism for sharing.
**Consequences.** Accounts can only be created and changed by install administrators. `POST /solutions/import` of an existing
solution answers 409 until the plan is confirmed (`asCopy` keeps the old behaviour). Attachment URLs carry `?env=`. Renaming a
table between versions is refused in an upgrade (a problem in the plan). Data files are left alone by upgrades. Copies do not take
users' roles, audit or other systems' secrets. A copied environment shares ids with its source, which is what makes deployment
between them an upgrade.
**Status.** Active.

## D16. Formulas over tables run as Query v2 on the server; the client keeps a query cache (P0 package D, Nov 2026)
**Decision.** In server mode the browser no longer loads tables to filter them. Every table formula goes through `analyze()` (D13);
its plans run as `POST /api/v1/query`, which the PostgreSQL connector executes as one SQL statement per plan with the caller's RBAC
scope, row filters (v1 semantics) and column security inside it, keyset paging (`page.size` <= 500), exact counts, aggregates
(groups <= 5,000), a statement timeout, and calculations on number columns (`+ - * /`, Abs, Round...) translated exactly. The client
caches results by plan (de-duplicated, cancelled when unwanted, overlaid with optimistic writes, refetched after writes with the old
rows kept on screen); controls page (infinite scroll, virtualised rows) and sort / search on the server. A non-delegable formula over
a table with more than 2,000 readable rows is an evaluation error; smaller tables are held whole and evaluated in the browser with a
Studio warning. Connectors without SQL pushdown (MySQL, data files, Google Sheets) answer plans with the reference executor over at
most 5,000 rows and flag `truncated`. Columns can be marked `indexed`; lookup and unique columns and the natural order always are.
**Why.** Exit checks 2 and 3 of P0: a million-row table must be usable, and a wrong partial answer is worse than an error. One
statement per plan keeps security and counts consistent; sort-key comparisons let one index per column serve filter, sort and seek.
**Consequences.** Formulas that read large tables resolve asynchronously (a property shows its previous value while loading; actions
that read large tables run step by step after the earlier writes are saved). Some formulas that worked on the first 5,000 rows are now
errors that name the sub-expression and a rewrite. `WorkspaceState.truncated` only concerns the capped connectors. Demo mode is
unchanged. Parity: 0 mismatches over 870 formulas on PostgreSQL (`docs/dev/query-v2.md` section 15).
**Status.** Active. Supersedes D10.


## D17. Organisation scopes, relationship rules and record sharing compile into the one statement (P0 package F, Nov 2026)
**Decision.** The organisation (departments as a tree, a manager per user, teams with members and an optional environment) is
install-wide in schema `ab`. Table privileges gain the scopes `team`, `manager`, `managerTree`, `department`, `departmentTree`
and a `share` scope; `rowFilter` becomes a small rule AST (compare on a column or a lookup path of at most two hops, `exists` over
a junction table with exactly one `@this` correlation, `any`) with organisation tokens (`@myDepartment`, `@myTeams`,
`@myReportsTree`, `@team:<code>` ...). One pure module, `src/platform/orgsec.ts`, builds the predicate for both the server and demo
mode. Organisation sets and shared row ids are resolved per request (cached 5 s, invalidated on change) into parameter lists;
lookup paths and junctions become `col IN (SELECT key FROM table WHERE ...)` sub-selects of the same connection, inside the one
statement of Query v1, v2, writes and counts. Team-owned rows keep the team id in `owner` (no `ownerType` column): user and team
ids come from disjoint registries, so `own` is unchanged and no data table needs a migration. A share only adds rows for users
whose role already reads (or updates) the table, like Dataverse. Unresolved tokens and invalid rules fail closed.
**Why.** The pilot needs "supervisor sees their line, plant manager the plant" and "teacher sees the students of their sections"
without custom code (master plan section 3.4), and security that search, aggregates and later flows and agents inherit. Lists for
organisation sets keep every connector and the in-memory evaluators working with no new node type; sub-selects keep relationship
rules exact and indexable without materialising per-user tables. A rule AST instead of SQL keeps rules portable (solutions name
tables and codes, not ids) and injection-free.
**Consequences.** Rules cannot cross connections (such a role grants nothing). Very large sets (a share list of 100,000 rows) travel
as one array parameter. Lookup values can only point at rows the user can read. The v2 row filter is no longer wrapped in
`COALESCE` (index use). Measured at 1,000,000 rows: 17-85 ms per scope, 66 ms for a lookup rule, about 0.4 s for a junction rule
(`docs/dev/security-engine.md`). Demo mode stores the organisation and shares in `workspace.yaml`.
**Status.** Active.

## D18. Table events, outbox and job queue in PostgreSQL; one mechanism for business logic (P0 package G, Nov 2026)

**Decision.** Server logic of a table is one mechanism, *table events*, defined per environment: before-events run inside the
write's transaction (SetField, Reject, pushed-down read-only lookups, time budget, ordered), after-events run after commit
through a durable job queue (at least once, idempotency keys, retries, dead letter). Validation rules, formula columns
(computed on write and stored) and rollup columns (recomputed from scratch by jobs, reconciled hourly) are built-in uses of
it. Every data change writes an `ab_outbox` row in the same transaction; a per-table advisory lock makes outbox ids follow
commit order per table. Jobs and schedules live in `ab_jobs` / `ab_schedules` per environment, claimed with
`FOR UPDATE SKIP LOCKED` by a worker inside the server process (LISTEN/NOTIFY plus polling, heartbeat and reaper). Cron is
parsed in-house. Event formulas are Fx evaluated on the server (`createEngine` with event natives); UI functions are refused
at save time.

**Why.** One durable path for "something changed" serves events, rollups, realtime refresh (package H) and flows (Phase 1)
without polling or lost events; PostgreSQL gives transactions, SKIP LOCKED and NOTIFY, so no broker is needed for one PC.
Recomputing rollups under a row lock is correct under concurrency where incremental updates are not.

**Consequences.** Data writes on the default database now always run in a transaction (one more round trip for the outbox
row; a row lock when a table has formula columns or before-events). Attachment files are deleted by a job after commit (fixes
the table-delete issue). Tables on other connections get events and outbox rows, but not atomically with their data.
Indexes of a column marked `indexed` are built in the background with `CREATE INDEX CONCURRENTLY`. Throughput measured at
770-960 jobs/s for trivial jobs. See `docs/dev/events-and-jobs.md`.

## D19. Realtime over one WebSocket per tab, fed by the outbox; ticks, not data; a soft lock instead of co-editing (P0 package H, Nov 2026)

**Decision.** The server keeps a realtime hub in its own process: one WebSocket per browser tab at `/api/v1/live` (library
`ws`, MIT, no other dependency), authenticated by the session cookie, with an Origin requirement as its CSRF guard. Clients
subscribe to topics per environment (`table:<id>`, `user:<me>`, `presence:<scope>`, `env`, `app:<id>`). Table-changed messages
come from package G's committed outbox rows (the outbox id is the sequence) and never carry values: changed column names the
subscriber may see, and row ids only for subscribers who may read every row; everyone else gets a "table changed" tick and
refetches through the secured query path. Forms and saves use optimistic concurrency (`ifModifiedOn`, 409). The Studio gets a
soft edit lock (first editor, take over) instead of co-editing. In-app notifications live in `ab.notifications`, with
per-user settings in `ab.user_settings`. Without a socket, clients refresh every 30 seconds. No SSE or long-poll fallback.

**Why.** One connection serves data refresh, notifications, presence and (P3) chat. Evaluating each subscriber's row filters on
every write would cost a query per subscriber per change; a tick plus a refetch costs one query per affected screen and cannot
leak rows. Feeding the hub from the outbox means pushes never precede the commit and never miss a committed change. Real
co-editing of app definitions needs operational transforms or CRDTs over the whole AppDef; a lock is enough for small teams.

**Consequences.** All realtime state is in one process: no horizontal scaling (as for sessions and caches, see the
architecture limits). A reverse proxy must pass WebSocket upgrades (documented for Caddy and nginx). Measured in the sandbox:
300 sockets, 50 changes a second for 30 s, every message delivered, p95 37 ms, under half a CPU core. A "table changed" tick
tells a reader that something in a table changed and when. See `docs/dev/live.md`.
