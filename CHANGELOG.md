# Changelog

All notable changes to Appbuilder are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Installers, release packages, updater, health and diagnostics** (P0 package L, decision D25; exit check 5):
  - **`npm run release`**: a versioned, self-contained, reproducible release folder and ZIP (web app, the server sources it
    imports run by Node's type stripping, production `node_modules`, installers, licence list, `release.json`/`VERSION`,
    `RELEASE-NOTES.md`, `SHA256SUMS`). **`npm run release:keygen`** / **`release:sign`**: Ed25519 signatures over
    `SHA256SUMS` with a vendor key kept outside the repository (docs/dev/release-process.md).
  - **Windows installer** `scripts/install/windows/install.ps1` (Windows PowerShell 5.1 and 7, elevated, idempotent, `-WhatIf`):
    its own Node.js, PostgreSQL 17 from the EDB binaries (or an existing one), role and database with a generated password
    sealed into `server.json` (the setup wizard skips its database step), the service **Appbuilder** (WinSW) under
    `NT SERVICE\Appbuilder` with restart on failure and rolled logs, tight folder ACLs, optional HTTPS with Caddy as a second
    service (LAN with its own CA, or a domain with Let's Encrypt), firewall only with `-OpenFirewall`, Start-menu entry,
    `appbuilder.cmd`, offline installs from a bundle (`-Offline`), `uninstall.ps1` (keeps data unless `-RemoveData` and a
    typed confirmation). **Not yet run on Windows**: parsed, linted for 5.1, unit-tested and dry-run on PowerShell 7.
  - **Linux installer** `scripts/install/linux/install.sh` (Ubuntu 22.04/24.04, Debian 12): Node.js tarball, PostgreSQL 17
    from PGDG (or the distribution's, or an existing one), a system user, a hardened systemd unit, Caddy from its apt
    repository, optional ufw rules, `--offline`, `--dry-run`, `uninstall.sh`. Run end to end on all three systems.
  - Every download is pinned with its checksum and licence in `scripts/install/manifest.txt`, https only;
    `scripts/install/prepare-offline.mjs` prepares offline bundles.
  - **Updater** `appbuilder update <zip|folder>`: checks checksums and the signature against the installed release's keys,
    refuses downgrades, an older schema or a too-old Node.js, stops the service, swaps the app folder (keeps
    `app.previous`), lets the server migrate (with its pre-migration backup), waits for the health check and rolls the app
    folder back by itself when it fails; the database restore is offered, not automatic. **Admin console > Updates**: the
    installed release, upload and check a release ZIP, release notes, the command that installs it, the update history.
  - **Health**: `GET /api/v1/health` (ok / starting / degraded only, for anyone) and the detailed health for install
    administrators (database, clock skew, environments, disk space, backup age, job queue, email, live sockets, versions).
  - **File log**: every log line also goes as JSON (with request, correlation and job ids) to `workspace/logs/appbuilder.log`,
    rotated by size; log level setting. **Admin console > Server logs** (health, filters, follow, download, level) and
    **Usage** (users, storage, tables and row counts, job statistics) replace their "Soon" pages.
  - **Diagnostics bundle** (Admin console > Server logs, or `appbuilder diagnostics`, also when the server is down): logs,
    versions, configuration, health, schema versions, recent failures and a release integrity check, with secrets removed.
  - Command-line tools of an installed server: `appbuilder version | health | update | verify-release | diagnostics |
    restore` (docs/admin/operations.md).

### Changed
- The first-run setup refuses requests that came through a reverse proxy (proxy headers), also from 127.0.0.1.
- The setup code can also be written to a file (`APPBUILDER_SETUP_CODE_FILE`, set by the installers) and is never written
  to the server's log file.
- docs/admin/installation.md is rewritten around the installers (sizing, LAN versus internet, HTTPS, offline); new
  docs/admin/operations.md and docs/dev/release-process.md; docs/admin/upgrades.md covers the updater and rolling back.

## [0.5.0] - 2026-11-18

**Phase 0 "Kernel" is done** (docs/plan/p0-spec.md, with the exit check results). In one paragraph: Appbuilder now runs on
**PostgreSQL** with one schema per **environment** (create, copy, switch, delete, lock production, deploy solutions between
them, upgrade in place); tables of a **million rows** are usable because filters, sorting, search, counts and totals run in
the database through **Query v2**, with security inside the same statement, and a formula that cannot run there is an
error, never a partial result; an **organisation model** (departments, managers, teams) drives row scopes, relationship
rules and record sharing; **table events, validation rules, formula columns, rollups, a job queue and schedules** run on
the server; a **realtime hub** refreshes screens live and carries notifications and presence; **identity basics** (email
relay, password reset, invitations, two-step verification, sessions, API keys); verified **backups and restores** with a
drill; a visual **data model designer**; and a **core data model** of system tables (people, comments, tasks, files,
reference data) with record timelines. Package M closed the phase: "controls" are now called **UI components** everywhere
a person reads, nine gaps were closed, the new surface was reviewed for security (docs/internal/security-review-p0.md),
and the documentation was checked end to end.

**PostgreSQL replaces MySQL/MariaDB as Appbuilder's database** (P0 package A, decision D14). There is no
migration from a MySQL installation: install PostgreSQL, run `scripts/setup-postgres.ps1` (or `.sh`) and start with an empty
database; carry apps and tables over as solution packages with data.

### Added
- **Phase close** (P0 package M, decision D24):
  - **Export environment data** (Admin console > Backups, environment administrators): every table of the environment as
    CSV files in one streamed ZIP with an attachments list and a manifest; after a recent sign-in, audited
    (docs/admin/backup-and-restore.md).
  - **Directory visibility** per environment (Admin console > Users): everyone, the same department, or administrators only
    see people in the Users table, person pickers, @mentions and the share dialog (docs/admin/users-and-roles.md).
  - **Your own schedules** on the Jobs page (create, edit, delete for job types that are safe to schedule), the
    **audit retention** switch on the Audit log page, and nightly **sign-in log** (180 days) and **email delivery log**
    (90 days) retention (docs/admin/jobs.md).
  - Solution **upgrade in place** carries unique pairs, reporting views (re-created), date dimensions (refilled), summary
    tables (new measures, schedule, refresh) and relationship changes; a first install fills date dimensions and schedules
    summaries; **environment copies** keep summary schedules and fill date dimensions (docs/guide/maker/solutions.md).
  - Demo mode enforces **delete behaviours** (restrict, cascade, set blank) in the browser, with the server's rules.
  - The portal grid's **lookup editor** searches the target table on the server as you type (server mode).
  - `scripts/exit-check/p0.mjs`: the Phase 0 exit check against a fresh server (a million rows through the API and in a
    headless browser, the delegation error, the restore drill, reset + TOTP + sessions with a fake SMTP relay, a second
    environment). `docs/guide/settings.md` (your settings), `docs/internal/security-review-p0.md`.
  - Tests: `scripts/naming.test.ts` (no "control" in user-facing text), `scripts/docs-links.test.ts` (no broken link or
    missing image in the docs), and the security, gap and upgrade suites listed in docs/dev/testing.md.
- **Core data model** (P0 package N, decision D23; docs/guide/maker/core-data-model.md, docs/admin/reference-data.md,
  docs/dev/core-data-model.md). Every environment now has **34 system tables**, listed under Dev mode > Tables >
  **System tables**: people and organisation (Users, Departments, Teams, Team members, Roles, Role assignments, as
  read-only views with a directory rule), collaboration (Activities, Comments, Mentions, Follows, Tags, Tag links, and
  Shares / Notifications views), files (Documents, Document versions, Attachment links; every existing attachment is
  linked at the upgrade), communication placeholders (Channels, Channel members, Messages, Message reactions), logging
  views (Audit entries, Sign-in log, Job runs, Event runs; Flow runs placeholder) and reference data (Currencies with
  INR as default, Units of measure, Countries, States with the Indian GST state codes, Calendars, Holidays, Number
  sequences, Settings with an April financial year). Collaboration rows follow the **regarding rule**: visible only
  to people who can read the record they are about, compiled into the SQL of every read (leak tests). Makers can add
  columns to most system tables; they cannot rename or delete them. New UI components **Record timeline**, **Person
  picker**, **Tag input** and **Activity list**; **Avatar** takes a `User`, **Avatar group** `Users`. User mode pages
  **Tasks** (list and board, quick add) and **Mentions**; @mentions notify (bell, click-through to the record with
  `?record=`, read by `Param("record")`). Formula functions `Comments`, `Activities`, `MyTasks`, `Mentions`, `Setting`,
  `Convert` (delegated), `NextNumber` (gap-free, in the save's transaction), `AddComment`, `AddActivity`, `Follow`,
  `Unfollow`, `Tag`, `Untag`, `RecordId`; lookup paths such as `createdBy.FullName` in formulas and Query v2 (`via`).
  A column default `=NextNumber("Invoices")` numbers new rows. The **common business model** (Accounts, Contacts,
  Addresses, Tax codes, Products, Price lists) is an optional solution package (`GET /api/v1/templates/business-model`).
  Routes `/collab/timeline`, `/collab/mentionable`, `/collab/follow`, `/collab/tags`, `/collab/my-tasks`,
  `/collab/mentions`; job `collab.notify`, nightly schedule "Collaboration orphan sweep". Solutions export custom columns
  of system tables, never the tables or the collaboration rows; environment copies with data include them. Demo mode
  has the same tables, components and pages. Schema version stays 7 (provisioning is idempotent and runs at every start).
- **Backup and restore** (P0 package J, decision D22; docs/admin/backup-and-restore.md, docs/admin/disaster-recovery.md,
  docs/dev/backup.md). **Admin console > Backups** (no longer "Soon"): install backups (accounts, settings, every
  environment, attachments, data files) and environment backups, each one archive (`.abbak`, tar) from **one consistent
  database snapshot** (pg_dump with an exported snapshot, or the **built-in exporter** when pg_dump is missing or older than
  the server), with a manifest of row counts and sha256 checksums, **verified after every backup**. Optional **passphrase
  encryption** (AES-256-GCM, scrypt) and an explicit "include the encryption key" option. **Schedules** (nightly install
  backup at 02:00, per-environment schedules, misfire run once) as jobs; **grandfather-father-son retention** (7 daily,
  4 weekly, 3 monthly; automatic backups 30 days; pinning); **off-site folder** copy with verification. **Restore** an
  environment as a new environment (default) or in place (typed confirmation, safety backup, environment "Restoring",
  one transaction: a failure keeps the old data), or **selected tables** (as new tables or replacing rows, with a plan);
  **browse** a table of a backup read-only; older backups are migrated, newer ones refused. **Automatic backups before**
  solution upgrades in place, environment deletes, in-place restores and server schema upgrades (the amber "No backup was
  taken" warnings are gone; a failed backup stops the change unless the administrator proceeds). **Restore test** job,
  backup **health** on every Admin console page and in environment details, notifications when a backup fails or is older
  than 36 hours. **Download** (recent sign-in) and **upload** of archives; every action in the install audit log.
  **Install restore** from the command line: `node server/main.ts restore <archive>` (checks, one transaction, key
  handling, migration). **Restore drill** `scripts/drill/restore-drill.mjs` (seed, backup, wipe, restore, compare).
  Schema version 7 adds `ab.backups` and `ab.backup_ops`. New dependency: `pg-copy-streams` (MIT).
- **Data model designer** (P0 package K, decision D21; docs/guide/maker/data-model.md, docs/dev/data-model.md): Dev mode >
  Data model is live. A diagram of every table (type icons; badges for required, unique, indexed, lookup, formula,
  rollup) with crow's-foot relationship lines, pan, zoom, minimap, layered auto-layout, coloured areas, search, filter by
  solution, system tables shown read-only on request, shared or personal positions. Edits go into a **draft** per user
  and environment with undo and redo: tables, columns (inline rename, retype, flags, delete), and relationships drawn by
  dragging one table onto another (one-to-many, one-to-one, many-to-many with a junction table and unique pair,
  hierarchy with loop prevention, required parent). **Review changes** shows the plan (row counts, destructive items in
  red, data conversion pre-checks, index builds) and applies it in one transaction after the pre-change backup.
  **Delete behaviours** (restrict, cascade, set blank) are enforced by the server; cascades respect the deleting user's
  permissions and write events and outbox rows. **Patterns**: master-detail, reference data, hierarchy, many-to-many,
  party model, status workflow, document numbering, audit trail, approval-ready; star schema and snowflake (reporting
  views secured through the source table), date dimension (fiscal year, India April-March by default), summary table
  refreshed by a job; manufacturing, CRM and inventory starters. **Model checks** panel. **Import** from Excel/CSV
  (inferred keys and relationships), from a PostgreSQL/MySQL connection (tables and foreign keys, link or copy) and from
  DBML; **export** PNG, SVG, DBML and a solution "data model" package. Relationships travel in solutions and environment
  copies. Schema version 7: `ab_relationships`, `ab_model_layouts`, `ab_model_drafts`; existing lookups become explicit
  relationships.
- **Identity basics** (P0 package I, decision D20; docs/admin/sign-in-and-identity.md, docs/guide/signing-in.md,
  docs/dev/auth.md). **Two-step verification**: authenticator apps (TOTP, RFC 6238; QR code and key), 10 single-use
  recovery codes, email codes, "remember this device for 30 days", a code used once only. **Policy** in Admin console >
  Sign-in and security: two-step verification required for administrators or everyone (install-wide or per environment)
  with a grace period and forced setup at sign-in; session idle timeout and absolute lifetime; password minimum length,
  a common-password list, history and maximum age; the lockout values; the **sign-in log**. **Email** (Admin console >
  Email): SMTP relay (STARTTLS / TLS, AUTH PLAIN / LOGIN, password encrypted), test email, delivery log, queued delivery
  with retries; branded system emails. **Forgot password** (emailed link, 15 minutes; or an administrator's one-time reset
  code without email), **invitations** (7-day link instead of a temporary password; resend, revoke), **email change**
  confirmed by the new address. **Sessions**: list and end your own (Settings > Profile, "Sign out everywhere else");
  administrators see and end anyone's; new-device sign-in email; session rotation on password and two-step changes.
  **Re-authentication** before changing the sign-in email, turning two-step verification off, new recovery codes,
  creating API keys and deleting an environment. **Service accounts and API keys** (Admin console > Service accounts):
  `Authorization: Bearer` on the Data API, keys shown once and hashed, expiry, IP allow-list, rate limit, last use.
  Schema version 7 (tables `ab.user_mfa`, `auth_tokens`, `trusted_devices`, `password_history`, `signin_log`, `mail_log`,
  `api_keys`). New dependency: `qrcode-generator` (MIT).
- **Live updates, presence and in-app notifications** (P0 package H, decision D19). One WebSocket per tab
  (`/api/v1/live`, docs/dev/live.md): data tables, galleries, charts and labels refresh within a moment when someone else
  changes a table (from package G's outbox, after the commit), without flicker and keeping the scroll position; forms keep
  unsaved edits and show "This record was changed by <name>" with Reload / Keep mine; running apps show who else has them open
  and "Update available" when a maker saves a newer version. Without the connection pages refresh every 30 seconds and say
  "Live updates paused". Demo mode keeps the tabs of one browser in sync (BroadcastChannel).
- **Optimistic concurrency on row updates**: `PATCH /api/v1/data/:table/rows/:id` accepts `ifModifiedOn`; a stale save answers 409
  with the current row and who changed it. Forms send it.
- **Notifications**: the bell in the top bar and the Studio (unread badge, list, mark read, mark all read, delete, click-through
  to the deep link), toasts while Appbuilder is in front, desktop notifications in the background; Settings > Notifications is
  real (per kind, desktop notifications, do-not-disturb hours, hide my presence). API `/api/v1/notifications` (list, unread
  count, read, read-all, delete, settings, send); server service `services.notifications.notify()` (used by table events'
  NotifyUser). New formula function `SendNotification(user, title [, body] [, link])` (rate-limited).
- **Studio soft lock**: the first maker edits an app, others open it read-only and see the saves as they happen; "Take over
  editing"; avatars of the other makers. Administration > Users shows who is online.
- New tables `ab.notifications` and `ab.user_settings`; new dependency `ws` (MIT) for the WebSocket server.
- **Table events, validation rules, formula columns and rollups** (P0 package G, decision D18): new table designer tabs.
  Validation rules (a formula that must be true, a message, a field) refuse a save from every app, the grid, imports and the
  API. Before-save events change the record (`SetField`) or refuse it (`Reject`) and can read other tables; after-save events
  change rows (`Patch`, `Collect`, `Remove`), `NotifyUser`, `EnqueueJob` in the background, retried on failure. Formula columns
  are calculated on save and stored (recalculated in the background when the formula changes; also in demo mode); rollups
  count or total related rows and stay correct under concurrent saves. Formula check by the server as you type, **Test run**
  against a sample row, and a run log of every run, refusal and failure.
- **Job queue and schedules**: durable background jobs in PostgreSQL with retries, dead letter, crash recovery and a worker
  inside the server; built-in schedules for outbox / run log / job retention, audit retention (off by default), attachment
  orphan sweep and rollup reconcile. Admin console > **Jobs** (queue health, failed and dead jobs with retry and cancel,
  schedules with on/off, retention days and Run now) and **Events run log**. About 800-950 trivial jobs per second.
- Table logic travels with solutions: validation rules, events, formula columns and rollups (and table sharing settings)
  are exported with their tables, listed as new / changed / removed in the upgrade plan, and copied with environments.
  Events that run as the system need an administrator's explicit confirmation on import and are audited.
- Schema version **6** (organisation, notifications, record sharing, events and jobs): a version 5 server refuses the upgraded
  database.
- **Outbox**: every data change is recorded in the same transaction, in commit order per table, for the realtime hub and
  flows (`services.kernel.outbox.subscribe`).
- **Organisation** (P0 package F, decision D17): departments (a tree with stable codes), a manager, job title, phone and
  employee code per user, and teams (members; every environment or one). Admin console > **Departments** (tree editor),
  **Teams**, **Org chart**, and Users shows and edits the new fields. **Import users from CSV** with department and manager
  columns: preview with the problems per line, all or nothing, passwords never imported; new users get a one-time temporary
  password shown once and must change it. `User()` gains `Department`, `DepartmentCode`, `Manager`, `JobTitle` and `Teams`.
- **New row scopes** for roles: Team (rows of the user's teams and team-owned rows), Direct reports, Reporting line,
  Department and Department tree, each with a plain-language description in the role editor.
- **Relationship rules**: row rules can follow lookup columns ("Section > Teacher is the current user") and look at related rows
  in a junction table ("an Enrolment exists for this student in a section I teach"), with new values such as the current
  user's department, teams, manager or reports, or a team / department by code. The role editor has a rule builder.
- **Record sharing**: per table (table designer > Settings) owners and roles with the new **Share** privilege share single
  rows with people or teams for reading or for reading and changing: the table grid's row menu > *Share...*, and in formulas
  `Share(record, userOrTeam, access)`, `Unshare(record, userOrTeam)`, `SharedWith(record)`. Tables can also let rows be
  owned by teams.
- **Who can see this row?** (Security roles, and the grid's row menu): every user with read, update or delete access to one
  row and why. **Test as user** now says why each table's rows are visible.
- All of it runs inside the one SQL statement of every query, count, aggregate, search, export and write check (1,000,000 rows:
  17-85 ms per scope, under 0.5 s for a junction rule; `scripts/bench/orgsec-bench.mjs`), and identically in demo mode (one shared
  test corpus for both).
- **Large tables work** (P0 package D, decision D16): with the local server, formulas over tables run in the database. Filter,
  Search, Sort, LookUp, FirstN/LastN, CountRows/CountIf, Sum/Average/Min/Max, Distinct and GroupBy totals become one query
  (`POST /api/v1/query`, Data API v2) with the user's roles, row filters and column access applied in the same statement: exact
  counts, keyset paging, aggregates. Calculations on number columns are translated too (`Filter(Orders, Qty * Price > 1000)`,
  `Sum(Orders, Qty * Price)`, Round/RoundUp/RoundDown/Abs, `Year(Date) = 2026`), with the engine's results (0 mismatches over 870
  formulas on PostgreSQL). A 1,000,000-row table: first page 42 ms, indexed filters 5-190 ms, deep sorted pages 7 ms, exact count
  51 ms, grouped totals 0.4-0.5 s (`docs/dev/query-v2.md` section 15).
- **Data table, gallery, dropdown and combo box over large tables**: rows load page by page as you scroll (only the rows in view are
  drawn), the exact row count is shown, header sort and the search box run on the server, a dropdown over a large table searches as
  you type. The portal's table grid pages, sorts and searches on the server and shows the exact count.
- **Studio delegation diagnostics**: the formula bar says **Runs on server**, **Runs in browser** or **Can't run** for table
  formulas (hover for the steps), underlines the part that can't run, and the error list and data warnings list them.
- **Indexed columns**: a column setting **Indexed** (server mode) keeps filtering, sorting (both directions) and text search by that
  column fast; lookup and unique columns and the natural row order are always indexed. Text search on indexed columns uses a
  trigram index when PostgreSQL's `pg_trgm` extension is available.
- `scripts/bench/seed-million.mjs` (loads 1,000,000 rows and measures the queries) and `scripts/bench/browser-check.mjs` (drives the
  app in a headless browser at that size).
- **Environments** (P0 package E): an install now has the built-in Default plus up to four more environments (production,
  sandbox, developer; `APPBUILDER_MAX_ENVIRONMENTS` changes the limit), each its own database schema `env_<id>` and folder
  `workspace/env/<id>/` with its own tables, rows, apps, roles, connections, solutions, data files, attachments and audit log.
  Admin console > Environments: create (empty, with the sample, or copied from another environment, schema only or with data,
  copied inside the database in one transaction; connections to other systems lose their secrets), details with sizes, rename,
  change type, lock, delete after typing the name, and an Access tab. Every request names its environment
  (`X-Appbuilder-Environment`, or `?env=` on links) and the server checks it against the user's access; every cache is per
  environment. The top bar shows the environment's name and a type badge (production red, sandbox amber, developer blue) and a
  line in that colour, also in the Studio; switching reloads the workspace, closes the other environment's app tabs and is
  remembered on your account. A failing environment migration marks only that environment failed.
- **Install administrators and environment roles**: account and install management (environments, users, passwords, the
  install-level audit log `ab.audit`) needs an install administrator; roles and everything inside an environment its
  administrators. Admin console > Audit log has an *Install* tab for install administrators.
- **Solutions between environments**: solution packages carry stable ids. Importing one where it exists is an **in-place
  upgrade** after a plan (new, changed and removed apps, tables, columns and roles; dropped tables and columns in red) that you
  confirm, in one transaction. **Deploy to...** on a solution page exports and imports into another environment in one step.
  A pre-upgrade backup hook is in place (it takes no backup yet and says so). *Import as a copy* keeps the old behaviour.
- **Locked production environments**: apps, tables, columns, roles, solutions and data files change only by importing or
  deploying a solution (server-enforced, 403); the Studio opens apps there read-only with a banner.
- PostgreSQL system store (driver `pg`): schema `ab` for install-wide objects (settings, users, sessions, the environment
  registry, a licence placeholder) and one schema per environment (`env_default`) for roles, privileges, tables, apps,
  connections, solutions, data files, attachments, audit and the data tables. Every statement uses fully qualified names; pooled
  connections start with `search_path=pg_catalog,pg_temp` and `TimeZone=UTC`, so nothing can leak between requests. Schema
  version 4.
- The request's environment is resolved per request (`server/core/env-context.ts`, today always `default`); the security cache and
  connector instances are kept per environment. Ready for creating and switching environments (package E).
- Units of work with transactional DDL: creating, changing and deleting tables and columns, linking tables, and importing apps and
  solutions run in one transaction on the default database, so a failure leaves no table, column, row, definition, privilege or
  audit entry behind.
- `postgres` connector: the default database, and external PostgreSQL databases (with a `schema` setting; the system schemas are
  refused). Condition pushdown with exact parity to the in-memory reference (162-case parity test, case-insensitive comparison with
  the ICU root collation, code point ordering, no LIKE escaping), transactions, system columns, linking with consent.
- `scripts/setup-postgres.ps1` (Windows) and `scripts/setup-postgres.sh` (Linux): find PostgreSQL (or print the `winget install
  --id PostgreSQL.PostgreSQL.17 -e --interactive` command), ask for passwords without echoing them, create the role `appbuilder`
  and a UTF8 database owned by it; the new password reaches the server only as a SCRAM-SHA-256 verifier.
- Setup wizard: PostgreSQL defaults (port 5432), a *Use SSL* box, and clear messages for a wrong password, a missing database, a
  missing `pg_hba.conf` entry, a role that may not create schemas (with the command to fix it) and a database that is not UTF8.
- The Connections page offers PostgreSQL connections (host, port, database, user, password, schema, SSL).
- Formula-to-query translator (Query v2, P0 package B): `analyze()` in `src/fx/query` turns formulas over data-source tables
  (`Filter`, `Search`, `Sort`, `SortByColumns`, `LookUp`, `First`/`Last`/`FirstN`/`LastN`, `CountRows`, `CountIf`, `Sum`/`Average`/
  `Min`/`Max`, `Distinct`, `GroupBy` with totals, `ShowColumns`/`DropColumns`, `in`/`exactin`, `StartsWith`/`EndsWith`, `IsBlank`,
  date comparisons with `Today()`/`Now()`/`DateAdd`) into query plans, with a residual formula for the browser part, structured
  diagnostics for what can't run on the server and `explain()` text for the Studio. Plan types in `src/platform/query.ts`, semantics
  in `docs/dev/query-v2.md`, a reference executor, keyset cursor helpers and a parity test of about 650 generated formulas. Not used
  by the data layer yet (package D).
- `createEngine()` (`fx.createEngine`): independent formula engine instances, each with its own user-defined functions and named
  formulas.
- Top bar laid out like Power Platform: chat button, **environment picker** and your **avatar** last. The avatar (initials, colour derived from your account or chosen in Settings) shows your name and email on hover; its menu has Profile settings, Settings, Change password and Sign out, and in demo mode the switch-user list (which moved here from the old user menu).
- Environments as a real API in both backends (`platform.environments.list/current/select`, `GET /api/v1/environments`, also in `GET /workspace`): today one built-in **Default** environment of type Production. The picker remembers your choice per user; administrators get **Manage environments**. Creating environments arrives with P0.
- **Settings** page (`#settings`, `#settings-<section>`), opened from your name and gear at the bottom of the left menu (Dev and User mode) or from the avatar menu (also in the Studio); Back, x or Esc return to where you were. Real today: display name, avatar colour, change password, sign out; theme light / dark / system; reduce motion; mode at start; chat dock side and whether it reopens; Studio default app size, snap and grid size; export my settings and clear local data; links to the Admin console; About with version, server and database versions (administrators) and the third-party notices. Shown as **Soon** with their phase: sessions and two-step verification (P0), passkeys and single sign-on (P3.5), date / number / week / time-zone formats and interface language (not scheduled; formulas use fixed formats today), density, notifications (P1), chat messages (P3) and AI data sharing (P4).
- One per-user preferences store in the browser (`src/platform/preferences.ts`, `appbuilder-prefs:<userId>`), shaped so it can move to the server later.
- **Admin console** (`#admin`, administrators) is now a real page with its own navigation: **Environments** (the Default environment with its database and schema version; New environment disabled until P0; the planned types), **Users** (the primary place for user management, with roles, active / disabled, no password, must change password and last sign-in), **Licences** (current state "Development build, no licence file", the planned passes with preview counts derived from roles, assigning passes and uploading a licence file marked Soon, P3), **Audit log** (filter by action, user and date, 50 per page) and Backups, Server logs and Usage as Soon (P0).
- `PATCH /api/v1/auth/profile`: anyone signed in can change their own display name (and nothing else); audited as `user.profile`.
- `GET /api/v1/audit` (administrators): one page of the audit log, newest first, with filters.
- `GET /status` gives a signed-in administrator the server version, Node.js version, database version and schema version.
- Application shell with two modes, switched in the top bar: **Dev mode** (the maker portal and the Studio) and **User mode** (a "My apps" launcher with search and recently opened apps). People without the Maker or Administrator role see only User mode; makers return to the mode they used last (remembered per user in the browser). New routes: `#u`, `#u-<app id>`, `#soon-<key>`, `#chat`.
- App tabs in User mode: apps open as tabs under the top bar (the launcher is the fixed first tab), several at once; each keeps its state while you switch tabs or modes; close with the x, middle-click or Delete; open tabs come back after a reload. Every tile and tab has **Open in new window**; in Dev mode **Run** offers "Open in a tab" and "Open in new window".
- Chat dock: a chat button in the top bar and the Studio opens a resizable panel on the right (open state and width remembered) that can pop out into its own window and be brought back (BroadcastChannel, with a storage-event fallback). Chat itself is not built yet; the panel shows what it will do.
- Planned modules as menu entries with a **Soon** badge and a placeholder page each (module, what it will do, planned phase): Data model, Flows, Approvals, Dashboards, Agents, Sites and Templates in Dev mode; Tasks, Notes, Chat, Files, Documents / Slides / Sheets, Mail, Approvals and Dashboards in User mode. One registry, `src/portal/modules.ts`.
- Phone and tablet app sizes: Desktop 1920x1080 and 2560x1440, Phone 360x800 (default), 390x844 and 412x915, Tablet 800x1280 and 1280x800, and a custom size that can now be portrait, in the New app dialog, Start with data and App settings. Start with data lays a phone app out as a list screen and a form screen. Portrait apps run at their design size, centred, in landscape windows and app tabs; the Studio viewport menu has the phone and tablet sizes.
- Documentation index in `docs/README.md`, and a decision log in `docs/decisions.md` that explains why the main choices were made.
- Third-party notices in `THIRD-PARTY-NOTICES.md`, listing every production package with its license, and `npm run notices` to regenerate it.
- README links to the documentation, and run instructions that match the current start-up steps (PostgreSQL and the first-run setup screen).

### Changed
- **"Controls" are now "UI components"** in the Studio (Insert pane, search, properties, formula bar), the portal, settings,
  error messages, the formula reference and all documentation. The UI components reference moved to
  `docs/reference/ui-components.md` (the old page is a redirect). Code names (`src/controls`, `ControlType`), stored app
  definitions and the formula language did not change; `Reset`, `Select` and `SetFocus` show `component` as their argument.
- PostgreSQL connections start with `jit=off`: row-security predicates over many tables made JIT compilation take
  seconds per statement (core data model, P0 package N). Kept after measuring at package M: the collaboration predicate
  takes 42 s with JIT and 0.5 s without, aggregates are neutral (docs/dev/schema.md).
- Version 0.5.0 (was 0.5.0-dev).
- `createdBy` and `owner` of every table are lookups to the Users system table (were plain text ids).
- Deleting a row now applies the delete behaviour of every relationship pointing at its table. Lookups that existed
  before version 7: a **required** lookup now refuses the parent's delete while children exist (409); an **optional**
  lookup is cleared on the children (before, children kept the id of a row that no longer existed). Change either in
  the data model designer.
- Settings > Profile: Active sessions, two-step verification, email change and sign-in history are real (were "Soon");
  passkeys and single sign-on stay "Soon" (P3.5). Admin console > Users: invitations, reset codes, sessions and two-step
  reset in the row menu; service accounts are listed on their own page.
- Passwords on a list of common passwords are refused (`server/core/identity/common-passwords.txt`, from SecLists, MIT).
- Deleting an environment needs a recent password or authenticator code (`reauth_required`).
- Every data write on the default database is one transaction with its outbox row; updates of tables with formula columns
  or before-events lock the row. Marking a column **Indexed** builds its indexes in the background (no write lock).
- Forms show a refusal from the server (validation rule, event) under the field it names; calculated columns are read-only in
  forms and the grid, and rollup totals refresh shortly after a save.
- Query v2 no longer wraps the row filter in `COALESCE`, so owner, lookup and id indexes serve security predicates (own scope on
  1,000,000 rows: 285 ms -> 17 ms).
- `rowFilter` entries may now be rule nodes (`exists`, `any`) besides column conditions; scopes accept the organisation values.
- **Formulas that can't be turned into a database query are errors on large tables** (more than 2,000 rows you can see), never a
  result computed from part of the rows. The message names the part and suggests a rewrite. Smaller tables are loaded whole and
  evaluated in the browser as before, with a Studio warning. Demo mode is unchanged.
- The 5,000-row limit is gone for PostgreSQL tables (and the "Only the first 5,000 rows are loaded" banner with it). Tables on MySQL,
  data file and Google Sheets connections are queried over their first 5,000 rows, with a warning.
- Actions that read large tables (`Set(n, CountRows(Filter(...)))`) wait for the server; each `;` step sees the saved writes of the
  steps before it.
- Schema version 5. Opening a version 4 database converts it without losing anything: administrators become install
  administrators, everybody keeps access to Default, and `workspace/attachments` and `workspace/files` move into
  `workspace/env/default/`. Attachment URLs carry `?env=<environment>`.
- Creating, deleting, renaming and disabling accounts and setting other people's passwords need an install administrator;
  environment administrators assign roles.
- Importing a solution that already exists (same id) upgrades it after a confirmed plan instead of creating copies
  (`POST /solutions/import` answers 409 without `confirm`); `asCopy: true` and packages exported before 0.5 still create copies.
- **Database: PostgreSQL 15+ instead of MySQL/MariaDB** for the system tables and the default connection. MySQL/MariaDB stays as
  a connector for existing customer databases only. `APPBUILDER_DB_PORT` defaults to 5432; `GET /status` and `/workspace` report
  `storage.kind: 'postgres'`. Text conditions now compare exactly after lowercasing (no accent or trailing-space folding as with
  `utf8mb4_unicode_ci`) and sort by code point, which agrees with the browser's row filters.
- Backups use `pg_dump` / `pg_restore` (`docs/admin/backup-and-restore.md`, with the drill we ran).
- Only a PostgreSQL connection can be the default store for new tables.
- Tests: `APPBUILDER_TEST_DB` is now a PostgreSQL URL; the MySQL connector's tests use `APPBUILDER_TEST_MYSQL`. CI runs a
  PostgreSQL 16 and a MariaDB 10.11 service.
- The formula engine is shared with the server: `src/fx` uses explicit `.ts` imports and erasable TypeScript only and loads under
  plain Node (`server/core/fx.test.ts`); a test enforces that it imports nothing from React, the runtime, Studio, portal, controls or
  platform code. Architecture rule 3 and decision D13 describe the new boundary.
- User-defined functions belong to each app's engine instance instead of one shared active set that every app re-registered before
  evaluating; the Studio's formula bar, Advanced properties and checks use the app's own engine.
- User management moved from Security roles to **Admin console > Users**; Security roles keeps the roles and links to Users and back. The Environments menu entry is gone: environments live in the Admin console and the top-bar picker.
- The theme can follow the operating system; the quick toggle in the top bar and the Studio stays.
- The first administrator's sign-in through the setup wizard now counts as their last sign-in.
- Apps may be portrait: the server (`POST /api/v1/apps`, package import) and the demo platform no longer refuse a width smaller than the height (sizes stay 200 to 16000 px per side); the client asks for at least 320 px per side. Loading an app no longer swaps a portrait size into landscape.
- Each app tab has its own runtime store (`createAppStore`), evaluator cache and user-defined functions; the Studio, Preview and the standalone player use the shared store as before.
- The Studio and the portal need less width (900 px) so they fit next to the chat panel.
- Build specifications moved to `docs/internal/specs`. They are kept for history and are no longer maintained.

### Security
- Phase 0 security review (package M, docs/internal/security-review-p0.md): only job types marked safe can be scheduled by
  environment administrators, and schedules of install-wide work (backups, mail, install log retention) need an install
  administrator (before, any environment administrator could schedule any job); uploaded workbooks are checked for zip
  bombs before they are unpacked; database connections and the SMTP relay refuse link-local, cloud-metadata, unspecified
  and multicast addresses (`APPBUILDER_OUTBOUND_PRIVATE=deny` refuses private networks too); `GET /api/v1/org` lists only
  people with access to the environment (it listed every active user of the install); crafted backup archives cannot make
  the restore read huge members into memory; hostile DBML text is bounded. Formula columns and rollups are documented as
  computed by the system, with a warning in their editors.
- Realtime connection (package H): the upgrade passes the HTTP Host/Origin checks and requires this Origin (cross-site
  WebSocket hijacking), then the session cookie; forced-password-change sessions cannot connect. Table messages carry no
  values, no hidden column names, and row ids only for people who may read every row; sockets close at once on sign-out,
  password change, disabling or deletion of the account; limits per user, per server, per message and per second; slow
  clients are disconnected instead of buffered.
- Table events read and write with the permissions of the person who saved; only administrators can make one run as the
  system, and that is audited. Formulas of events are checked when saved (no UI functions on the server) and run with a time
  budget, row and query limits, a loop guard and a depth cap. Threat model in `docs/dev/events-and-jobs.md`.
- A lookup value can only point at a row the user can read; an unreadable row is refused like a missing one (before, a user
  could link to, and probe for, rows of tables they could not read).
- First-run setup accepts only requests from this computer (checked on the connection, not on headers) and needs a one-time setup code printed in the server window; once an administrator exists the setup stays closed, also while the database is unreachable.
- `GET /status` no longer shows the database host, port and name to anyone but a signed-in administrator.
- The page's Content-Security-Policy no longer allows inline script (hashes of the app's own inline script instead).
- Linking a table that is already linked is refused, also through a second connection to the same database. Deleting a table keeps the table in the database unless you tick "Also delete the table in the database", which is offered only for tables Appbuilder created; linked tables are never dropped and removing their columns only unmaps them.
- CSV exports prefix cells that a spreadsheet would run as formulas with `'`.
- Passwords set by an administrator must be changed at the next sign-in (schema version 3). Sign-in also has a per-account backoff.
- The session cookie can be marked `Secure` (`APPBUILDER_SECURE_COOKIE=1`, or `APPBUILDER_TRUST_PROXY=1` behind an HTTPS proxy).
- The audit log records the row ids of bulk deletes, before/after of role and user changes, and schema migrations; failed audit writes are reported as errors.

### Fixed
- A grouped Query v2 aggregate over Comments or Activities by a non-administrator failed ("table does not exist").
- Two refreshes of one summary table at the same time could insert its groups twice.
- Reading a reporting view tried to build an index on the view in the background, logging an error each time.
- Re-importing an unchanged solution listed reporting tables as changed (definitions read back from the database have
  their keys in another order).
- The data model designer's demo-mode plan said delete behaviours were enforced "by the server only".
- The Studio in a locked production environment let you make local edits that were never saved: the canvas, properties and
  formula bar are now truly read-only there (and while another maker holds the edit lock).
- Deleting a table removed its attachment files before the change was saved; a failed delete lost the files. Files are now
  deleted by a background job after the change commits (P0 package G).
- A user-defined function in App.Formulas was reported as "already a built-in function" when another app that defines a function with the same name had been evaluated first in the same page.
- The consent to add system columns when linking a table is now sent; MySQL tables get the missing columns (including `id`, filled with UUIDs). Without consent such tables link read-only and can be read (before, a table with `id` but without the other system columns failed on every query).
- The Default database connection can no longer be edited in the portal (edits silently reverted at the next start).
- Imported rows (CSV, new table from CSV, packages with data) belong to the importing user; administrators can give rows without owner an owner.
- The server retries an unreachable database in the background at start instead of staying unconfigured, and refuses to use a database upgraded by a newer version.

### Removed
- MySQL/MariaDB as the system store, `scripts/setup-mysql.ps1`, the MySQL-era schema upgrades (versions 2 and 3) and their tests.

## [0.3.0] - 2026-11-17

Phase 3: a shared database, connections to other data sources, and access rules enforced on the server.

### Added
- MySQL or MariaDB is the default store for app data. The first run opens a setup screen that asks for the database connection. On Windows, `scripts/setup-mysql.ps1` creates the database and its own user.
- Data connectors: MySQL or MariaDB, data files (CSV, XLSX and JSON), and Google Sheets. The Google Sheets connector is still in progress.
- Attachments: files can be attached to records.
- A versioned data API (v1) and a metadata API on the local server, which the portal and Studio use to manage tables, connections, apps, packages and solutions.
- Known gap: MySQL 8.4 has not yet been verified. MariaDB 10.11 has been tested.

### Changed
- Table data now lives in the database instead of CSV files in the workspace folder. A data file you pick is copied into the workspace folder and the original is never changed.
- The local server (`npm start`) serves the app and its API on `127.0.0.1`.

### Security
- Sign-in is checked on the server. Passwords are stored with scrypt, and the session cookie is HttpOnly.
- The server checks access on every request: role permissions, row filters with own-row scope, and column access.
- The browser-only demo mode simulates these rules and does not enforce them.

## [0.2.0] - 2026-11-17

Phase 2: the maker portal, workspace files, the full control set and the debug run window.

### Added
- Maker portal, where you list, create and open apps.
- Tables stored as CSV files in a workspace folder, with a sample workspace that has Contacts and Orders tables.
- A full set of controls for screens, including an animated icon control with an icon picker.
- Responsive desktop Studio layout.
- Debug run window, which shows the app the way its users will see it. Where pop-ups are blocked, it falls back to a preview inside the page.
- Windows scripts for offline setup and start (`scripts/setup-offline.ps1` and `scripts/start.ps1`).

### Changed
- A missing data file is read quietly rather than raising an error.

### Fixed
- Date differences (`DateDiff`) count hour, minute and second boundaries on the local clock. Calculations no longer fail in time zones with half-hour offsets, such as India Standard Time.

## [0.1.0] - 2026-11-17

The first Studio prototype.

### Added
- Studio editor: a drag-and-drop canvas for designing app screens, with Excel-style formulas through the Fx formula engine.
- Shared control components and a runtime that runs the designed app.

### Fixed
- Dropdowns now open in Preview.
- Build configuration paths for TypeScript are corrected.
