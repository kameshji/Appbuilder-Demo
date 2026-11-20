# Handover prompt (20 Nov 2026)

Paste everything below the line into a new Claude Code session opened in a clone of
`https://github.com/kameshji/Appbuilder-Demo` (branch `main`).

---

You are continuing an existing project. Read before doing anything: `docs/plan/master-plan.md` (sections 9-11
hold the owner's decisions and supersede earlier sections), `docs/plan/p2-spec.md`, `docs/plan/p1-spec.md`,
`docs/plan/p0-spec.md`, `docs/README.md`, `docs/decisions.md` (D1-D34), `CHANGELOG.md`, `CONTRIBUTING.md`,
`docs/dev/architecture.md`, `docs/dev/testing.md`, `docs/launch/BRIEF.md`.

## What this is
"Appbuilder" (working name; real name undecided) is a self-hosted Power Platform-style suite for organisations
of 20-50 people, one install on a Windows PC / Linux server / VPS. Owner: a solo founder in India; first pilot
target is a small Indian manufacturer. Stack: Node 22.18+ running TypeScript directly (type stripping, explicit
`.ts` imports, erasable syntax only), PostgreSQL 15+ as the system database (schema `ab` install-wide, one
schema `env_<slug>` per environment), React 19 + Vite single-file client, own formula engine (`src/fx`, shared
by client and server), hand-written shadcn-style components, vitest. Permissive licences only (`npm run
licences` gate).

## State at handover
- `main` is at the commit "P2 wave 1" (version 0.6.0 + Unreleased), CI green, 1,987 tests, schema version 11.
- Done: Phase 0 (kernel: PostgreSQL, Query v2 with security inside SQL, environments, organisation model and
  row rules, events/jobs, live hub, identity, backup/restore, data model designer, core data model, installers,
  updater), Phase 1 (flows runtime + visual designer, approvals, connector actions, HTTP/email/webhooks,
  notification delivery, scheduled reports, recycle bin, admin recovery CLI), Phase 2 wave 1 (phone PWA with
  offline entry outbox and barcode scanning, print templates + PDF engine, dashboards).
- Launch workspace (`docs/launch/`, `docs/help/`, `website/`) is written and committed. The owner has asked
  that NO further marketing, sales, research or website work be done; core product only.
- No agents are running. Nothing is uncommitted.

## Owner's standing rules
1. Core product work only. Keep the app bug-free: a smaller fully tested scope beats a wider untested one;
   anything unverified must be listed in the report, never shipped silently.
2. Delegate: simple tasks to the smallest model, moderately complex to a mid model, complex to the strongest;
   the main session plans, reviews, merges. Give each agent exclusive file ownership; tell agents never to
   `git commit/push` (the orchestrator commits) and never to kill processes they did not start.
3. Work phase by phase; update docs at the end of each package and phase (guide, admin, dev, reference via
   `npm run docs:gen`, CHANGELOG, decisions.md, the phase spec). Stop and report when a wave is done.
4. Be blunt and honest with the owner; no flattery; state what was verified by running versus only by reading.
5. User-facing word is "UI components", never "controls" (a test enforces it).
6. Never enter or store the owner's real passwords or keys. Legal, tax and security claims are for a lawyer,
   a CA and an outside reviewer; never claim compliance or certification.
7. Commit messages end with the attribution lines the session specifies.

## How to verify (every merge)
`npm run typecheck`; full `npx vitest run` with `APPBUILDER_TEST_DB` (PostgreSQL URL; the role needs CREATEDB)
and `APPBUILDER_TEST_MYSQL` (MariaDB URL for the external connector tests) set, twice when agents worked in
parallel; `npm run licences`; `npm run build`; the relevant `scripts/exit-check/*.mjs`; then push and confirm
the GitHub Actions run is green (CI differs from a local sandbox: `en_US` collation, non-superuser role,
`localhost` may resolve to IPv6). Schema rule: any new table bumps `SCHEMA_VERSION` with an independent
upgrade step (see `docs/dev/schema.md`).

## What remains, in order

### A. Phase 2 wave 1 gaps (do first; each with tests)
Dashboards (`docs/dev/dashboards.md`): visual tile query editor (the measure builder has no UI: tile queries
are API-only — highest priority), drag-and-drop layout and tablet breakpoints, viewer roles UI, settings screen
(fiscal year, week start, shifts, time zone), dashboards in solutions and environment copy, TV/kiosk mode with
revocable view tokens, scheduled email snapshot, pivot table, drill-through to an app screen, pin tiles to
Home / My dashboard, summary-table use, MTBF.
Phone (`docs/dev/phone.md`, matrix in `src/phone/touch.ts`): bottom sheets with search for Dropdown / ComboBox
/ PersonPicker, native date/time pickers on touch, `inputmode` on NumberInput, Dialog/Sheet as bottom sheets,
DataTable card layout with column priority, sticky form save bar, signature pad, Studio phone preview frames
and "check on phone" QR, per-table "available offline" with a row cap, form drafts across reloads, cold-start
offline, QR fallback decoder (iPhone has no built-in reader), end-to-end tests for outbox conflict and
rejection, touch review of Visual / Chart / PrintButton.
PDF (`docs/dev/pdf.md`): replace the PDF engine's own chart renderer with `renderChartSvg` from `src/charts`
(needs an SVG-to-PDF step), Web Share on phones, click-test the timeline "Document" button, confirm the
`png-js` licence exception in `scripts/licence-exceptions.json` (owner decision).

### B. Phase 2 wave 2 (`docs/plan/p2-spec.md`)
D: auto apps (generate a list/detail/edit app for desktop and phone from a table or the data model, opens as a
normal editable app) and the templates catalogue mechanics (kinds: UI component, screen, app, data model; data
slots with a binding step; plan screen; Copy vs Linked; rules in master-plan section 11.3) with first built-ins.
E: WhatsApp connector (Meta WhatsApp Business Cloud API through the connector actions framework, template
messages, opt-in store, notification channel; tested against a recorded mock), SMS optional.

### C. Phase 2 wave 3 (close)
Security re-check of all Phase 2 surface (service worker, offline store, PDF generation as caller, dashboards
batch endpoint, templates install, WhatsApp), docs sweep, `scripts/exit-check/p2.mjs` covering the seven exit
checks in `p2-spec.md`, re-run the P0 and P1 exit checks, version 0.7.0.

### D. Later phases (master plan)
P3: chat (built in-house on the live hub; chat dock placeholder exists in `src/chat`), Tasks/Notes polish,
manufacturing pack and CRM/ERP templates (ERP templates carry their own ledgers and GST — a verified GST
calculation spec reviewed by a practising accountant is required first), licence passes (signed offline
licence file; Full user / Operator / External; seat bands), Tally exchange (optional connector), payments
connector family (design in `docs/launch/payments.md`: Razorpay first, hosted pages only).
P3.5: single sign-on in and out, passkeys, enforced MFA policies. P4: AI agents (to be planned with the owner
first; act as the calling user, tool allow-lists, approval for writes). P5: simple document / slide / sheet
editors (own, not an embedded office suite), mail client on existing mailboxes. P6: external portal sites.
A launch-plan recommendation the owner has NOT yet decided: cut the pilot scope to a "pilot-minimum"
(`docs/launch/launch-plan.md`).

### E. Open items that need the owner (do not act without him)
- Create the first administrator on his PC install (Appbuilder 0.5.0 as Windows services, PostgreSQL 17 on
  port 5433; setup code in `C:\ProgramData\Appbuilder\workspace\setup-code.txt`); then update that install to
  the current release with the updater (first real Windows updater test); HTTPS option, uninstall and the
  offline bundle are untested on Windows.
- Run `docs/dev/phone-test-script.md` (32 checks) on real Android and iPhone devices: nothing has been tested
  on real phones.
- Create the release signing key (`npm run release:keygen`; private key never in the repo); releases are
  unsigned today.
- Outside security review before any customer install beyond one pilot; the internal reviews are in
  `docs/internal/security-review-p0.md` and `-p1.md` with residual risks.
- Product name, pricing, entity and timing (he is serving notice at an employer with a no-moonlighting policy
  until about end of January 2027; `docs/launch/legal-essentials.md` says a lawyer must read his contract,
  especially IP assignment, before his last working day; no commercial activity before then).
- `SECURITY.md` contact, response times and safe-harbour wording.

## Known limits worth remembering
Single server process only (live hub, locks, rate counters in memory). External connectors (MySQL, files,
Google Sheets) are capped at 5,000 rows and hard-delete. Formula columns and rollups can show totals over rows
a reader cannot see (documented, warned in the editors). Demo mode (static build without a server) lacks
validation rules, events, flows, approvals, PDFs. Windows: only install was exercised.

Start by confirming `main` is green, then propose the plan for section A to the owner before launching agents.
