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
**Status.** Temporary. The delegation layer exists (D13); D10 is superseded by D13 once P0 package D (Data API v2 and the client
data layer) lands.

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
