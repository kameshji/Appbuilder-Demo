# Phase 0 (Kernel) specification

Status: IN PROGRESS. Owner approved "proceed phase by phase" on 18 Nov 2026.
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
| L | Installer: one script for Windows and Linux (PostgreSQL, service, Caddy), updater, diagnostics bundle | A, J | wave 5 |
| M | Phase close: docs sweep, exit-check run, security re-check of new surface | all | wave 5 |

Each package ends with: tests, typecheck, build, a real run of the affected flows, and its docs.
