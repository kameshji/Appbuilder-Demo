# Phase 0 (Kernel) specification

Status: **DONE** (18 Nov 2026, version 0.5.0), with exit check 5 (installer) reported by package L. Owner approved "proceed
phase by phase" on 18 Nov 2026.
Source of truth for scope: `master-plan.md` sections 3, 5, 9, 10. This file splits P0 into work packages,
fixes the cross-package contracts, and records the exit check.

## Exit check (all must pass before P1 starts)

1. Full test suite green on PostgreSQL in CI; MySQL connector tests still green as an external connector.
2. A table with 1,000,000 rows is usable: paged grid, server-side filter/sort/search, exact count, aggregates.
3. A formula that cannot be pushed down on a large table is a visible error, never a silent partial result.
4. Backup, wipe, restore drill passes by script.
5. Clean install on a Windows PC by one script in under an hour (PostgreSQL included), HTTPS optional step.
6. Password reset, two-step verification (TOTP) and session list work end to end.
7. Second environment can be created, switched to, and deleted; data is isolated.
8. Docs updated: guide, admin, dev, reference, CHANGELOG; decisions.md records the changes.

## Fixed decisions

- System database: PostgreSQL 15+ (bundle 17 where we install it; sandbox/CI on 16). Driver: `pg` (MIT).
- No migration path from MySQL system stores (no customers yet). MySQL/MariaDB stays as a connector.
- Layout: schema `ab` holds install-wide objects (users, sessions, organisation, environments, licence,
  install settings). Each environment is one schema `env_<slug>` holding its metadata (apps, tables, roles,
  connections, solutions, audit, jobs, events) and its data tables. Requests carry an environment id; the
  server resolves it to a schema; all caches are keyed by environment.
- Users are install-wide; roles and privileges are per environment (as in Power Platform).
- Schema changes run inside transactions (transactional DDL). Solution import is all-or-nothing.
- Row ids stay UUIDv7 text; timestamps `timestamptz`; metadata documents `jsonb`.
- The formula engine (`src/fx`) is shared: the server may import it. It must stay free of DOM/React imports
  and use explicit `.ts` import extensions so Node can run it directly. This replaces architecture rule 3
  and decision D10 (5,000-row cap).
- Data API v2 query: `filter` (Condition AST, extended), `sort`, `page` (keyset cursor + size), `search`,
  `select`, `count: exact`, and `aggregate` (group by + sum/avg/min/max/count). v1 remains for one phase.
- Jobs: table `jobs` per environment, claimed with `FOR UPDATE SKIP LOCKED`; events: table `outbox` written
  in the same transaction as the data change; worker loop inside the server process.
- Realtime: one WebSocket endpoint `/api/v1/live` authenticated by the session cookie; topics per
  environment; server pushes table-changed, notification and presence messages.

## Work packages

| # | Package | Depends on | Notes |
|---|---|---|---|
| A | PostgreSQL port of the system store and default data connection; setup wizard, scripts, CI | - | wave 1 |
| B | Shared Fx engine + formula-to-Query translator (pure library, tests) | - | wave 1 |
| C | Licence allow-list check in CI | - | wave 1 |
| D | Data API v2: pushdown query, paging, count, aggregates; client data layer and controls use it; delegation errors | A, B | wave 2 |
| E | Environments for real: schema per environment, create/switch/delete, environment-keyed caches | A | wave 2 |
| F | Organisation model (departments, manager, teams) and relationship row rules, team scope | A | wave 3 |
| G | Table events (before/after), outbox, job queue and worker, schedules | A, B | wave 3 |
| H | Realtime hub, live data refresh, in-app notification plumbing | A | wave 3 |
| I | Identity basics: password reset (SMTP relay settings), TOTP + recovery codes, session list/revoke | A | wave 4 |
| J | Backup/restore (pg_dump per environment + attachments), admin console pages, restore drill script | A, E | wave 4 |
| K | Data model designer (visual schema canvas, relationships, patterns, reporting views) | D | wave 4 |
| N | Core data model: system tables per environment (people, collaboration, files, logging, reference), polymorphic regarding links, timeline component | F, G, H | wave 4 |
| L | Installer: one script for Windows and Linux (PostgreSQL, service, Caddy), updater, diagnostics bundle | A, J | wave 5 |
| M | Phase close: rename "controls" to "UI components" in UI and docs, docs sweep, exit-check run, security re-check of new surface | all | wave 5 |

Each package ends with: tests, typecheck, build, a real run of the affected flows, and its docs.

## Exit check results (package M, 18 Nov 2026)

`node scripts/exit-check/p0.mjs` against a freshly started server on an empty database (PostgreSQL 16, sandbox), 151 s:

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Test suite green on PostgreSQL in CI; MySQL connector tests green | see evidence | `.github/workflows/ci.yml`; locally the full suite passes twice on PostgreSQL 16 + MariaDB (package M report) |
| 2 | 1,000,000 rows through the API | PASS | first page + exact count 71 ms; indexed filter 8 ms; indexed filter + count of 250,000 206 ms; non-indexed filter 8 ms; sorted page 7 ms; search + count 26 ms; exact count 70 ms; grouped aggregate 387 ms; whole-table sum 99 ms; 20 pages by cursor 8 ms each (all under their limits, median of 3) |
| 2 | Headless browser: portal grid and an app DataTable on that table | PASS | 29 checks of `scripts/bench/browser-check.mjs` (exact count, paging by scroll, server sort and search, Dropdown type-ahead, Studio delegation messages) |
| 3 | A formula that cannot be pushed down is an error, not partial data | PASS | translator: `not-delegable-expression` on `Len(Note)`, no plan sent; an unpaged query of 250,000 rows is a 422 ("ask for it page by page") |
| 4 | Backup, wipe, restore drill by script | PASS | `scripts/drill/restore-drill.mjs`: 10 steps, 25.9 s (backup + verification 1.0 s, restore 3.2 s) |
| 5 | Clean install on Windows by one script in under an hour | see evidence | package L (installer) reports its own evidence |
| 6 | Password reset, TOTP and session list end to end | PASS | reset by emailed link (fake SMTP relay), sign-in with the new password; TOTP enrolled, the password alone answers `mfa_required`, the code signs in; session list (2), ending the other session signs it out |
| 7 | Second environment: create, write, isolate, delete | PASS | row visible there, 404 in Default, Default's table 404 there; deleted, schema dropped |
| 8 | Docs updated | done | guide, admin, dev, reference (regenerated), CHANGELOG 0.5.0, decisions D24; `scripts/docs-links.test.ts` finds no broken link |

## What moved, and what is carried forward to Phase 1

Moved during Phase 0: Tasks and Mentions (planned for P3) shipped with the core data model (N); identity basics and the
data model designer core were pulled into P0; templates are split between P2 (catalogue, UI component / screen / app / data
model templates) and P3 (solution templates); identity advanced is P3.5 (master plan section 5).

Carried forward (open items, none blocks the exit check):

- Validation rules (table events) in demo mode: there is no event storage or evaluator in the browser store; not a small
  change (gap 2f). Delete behaviours are enforced in demo mode.
- Relationships removed from a solution package are not removed by an upgrade (packages do not say "no relationships"
  apart from "older package"); changes and additions are carried.
- Directory visibility exists in server mode only (demo mode has one user at a time).
- Export environment data: choosing tables, other formats, ZIP64 (exports over 4 GB).
- Security residuals (docs/internal/security-review-p0.md): `uuid` override for ExcelJS (`npm audit`, not exploitable
  here), DNS rebinding for database connections, unsigned backup archives, download tickets in URLs, outside review.
- Data API v1 stays for one more phase (decided in P0), then goes.
- Installer evidence (exit check 5) and the server logs / usage pages: package L.
- Screenshots: the walkthrough (`scripts/docs-shots/capture.mjs`, Studio with the "UI components" wording) and the events
  and jobs pages (`events.mjs`, with the new schedule editor and the rollup warning) were refreshed; the Users page's
  directory visibility and the Backups page's export panel have no screenshot yet, and the other capture scripts
  (backups, identity, environments, organisation, data model, core data model, live) were not re-run.
