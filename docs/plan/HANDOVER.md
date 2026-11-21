# Handover (state at version 0.8.0, 21 Nov 2026)

Read first: `docs/plan/master-plan.md` (sections 9 to 16 are the owner's decisions), `docs/plan/p3-spec.md` and `docs/plan/hosting-spec.md` (each ends with its results and what is carried forward), `docs/decisions.md` (D1 to D65), `CHANGELOG.md`, `docs/dev/testing.md`, `docs/internal/security-review-p3.md`.

## Where it stands

- `main` is at version 0.8.0. Phases 0, 1 and 2 are closed. Phase 3 is built except package L (ledgers and GST), which waits for a practising accountant to sign `docs/plan/gst-spec-draft.md`.
- Hosting is one install per organisation on one Linux server (owner's goal: a paid pilot of at most 20 organisations of 20 to 50 people). Built: server options, the read-only gate, the isolation suite, the licence service and seat passes, the fleet tool `abfleet`, a load-test harness. Not done: anything that needs a rented server (H-M, H-N, exit checks 1, 7 and 8 for real).
- Nothing has run on a real phone, against Meta's real API, with a real mail provider or on a rented server. No outside security review.

## How to verify

`npm run typecheck`, `npm run lint`, full `npx vitest run` with `APPBUILDER_TEST_DB` and `APPBUILDER_TEST_MYSQL` (twice), `npm run licences`, `npm run build`, then `node scripts/exit-check/p3.mjs` (runs every Phase 3 and local hosting check and the Phase 2 regression with P0 and P1). CI has three jobs: `test`, `isolation`, `fleet`.

## What remains, in order

1. Owner: rent the Linux server when ready; then run the fleet installer, `abfleet init`, the isolation suite, the pilot load profile and exit checks 1, 7 and 8 there; write H-M (tester on-boarding, incident procedure) and close the hosting phase.
2. From the load test: move PDF generation and CSV imports off the request loop; cache the table list query; report event-loop delay in the health endpoint.
3. Server commands the fleet tool wants: `rekey`, `backup create`, locked SMTP settings, `admin operator-access`, `status --json`.
4. Open security findings: MySQL over SSL host verification; pack upgrades that widen a role's access must say so.
5. Known bugs and unbuilt items: the "Carried forward" list at the end of `docs/plan/p3-spec.md`.
6. Package L after the accountant's sign-off. Then the master plan's later phases (single sign-on and passkeys, AI agents, documents, sites).

## Needs the owner

Real-device phone test (`docs/dev/phone-test-script.md`); a Meta account; a mail provider; the release signing key and the licence signing key; a lawyer for `docs/launch/tester-terms-draft.md` and the employment contract; an accountant for the GST draft; an outside security review; a decision on D12 (PHP gateway); product name, pricing and entity.

## Working rules that held up

Agents get exclusive file ownership and never commit; the orchestrator verifies and commits. Tests that create databases need 30 s limits; browser scripts wait for layout to settle and for exact text; no test assumes a fixed number of built-in templates, schedules or routes; always check against the minified production build; never touch ports 5174 or 5433 on the owner's PC.