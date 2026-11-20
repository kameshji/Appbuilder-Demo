# Phase 2 (Reach) specification

Status: **DONE** (20 Nov 2026, version 0.7.0; started 19 Nov 2026). Exit check results and what is carried forward are at the end. Phase 1 closed at 0.6.0 (`p1-spec.md`).

## Exit check

1. A supervisor logs production from an Android phone browser on a plant Wi-Fi: opens the app from the home
   screen icon, scans a barcode or QR code, takes a photo, saves; a save made while the connection is down is
   kept and sent when it returns, with a visible status and no duplicate.
2. A manager receives a daily OEE PDF by email, generated from a print template, and can print an inspection
   report from a record.
3. A dashboard with at least six tiles (KPIs, trend, bar, table, OEE gauge) loads in under two seconds on a
   1,000,000-row table for a restricted user, showing only that user's rows.
4. "Create app from table" produces a working list/detail/edit app for desktop and phone in one click, and the
   result opens in the Studio as a normal editable app.
5. A screen template, a UI component template, an app template and a data model template are installed from
   the catalogue with the binding step and the plan screen, without changing anything that existed.
6. A WhatsApp message (template message) is sent from a flow through the connector against a recorded mock of
   the provider API; opt-in is recorded; nothing is sent without opt-in.
7. Docs, security re-check, P0 and P1 exit checks still pass.

## Fixed decisions

- Phone = the same web app in the phone browser, installable as a PWA. No native app in this phase.
- Offline scope: an outbox of pending creates/updates per device for apps marked "works offline (entry)"; reads
  use the last loaded data for the screens visited; conflicts use the existing row-version check. No offline
  formula evaluation of server-delegated queries beyond cached results. Stated plainly in the UI.
- PDF is generated on the server from print templates (HTML/CSS subset laid out by our own renderer or a
  permissively licensed library; no headless browser dependency in the install). Fonts bundled with licences
  (Latin + Devanagari).
- Dashboards are pages made of UI components on the aggregate endpoint; security-trimmed; no separate BI model.
- Templates follow the rules in `master-plan.md` section 11.3.
- WhatsApp: Meta WhatsApp Business Cloud API through the connector actions framework; template messages and
  session replies; opt-in store; no unofficial APIs.

## Work packages

| # | Package | Wave |
|---|---|---|
| A | Phone experience: responsive runtime and shell for phone sizes, PWA, touch behaviour of every UI component, camera/photo, barcode/QR scan, location, offline entry outbox, phone test matrix | 1 |
| B | Documents out: print templates and designer, server PDF renderer, `Print`/`GeneratePdf` in apps and flows, email attachments, scheduled report PDFs, docx generation from templates | 1 |
| C | Dashboards: dashboard pages, chart and KPI components, filters and drill-down, OEE helpers, date dimension use, pinned tiles on Home, scheduled snapshot | 1 |
| D | Auto apps (generate from table/model, convertible) and the templates catalogue mechanics with the first built-in templates (UI component, screen, app, data model kinds) | 2 |
| E | WhatsApp connector, opt-in store, notification channel, message templates; SMS as a second provider-neutral channel if cheap | 2 |
| F | Phase close: gaps, security re-check, docs sweep, exit check, 0.7.0 | 3 |

## Exit check results (package F, 20 Nov 2026)

`node scripts/exit-check/p2.mjs` on one developer PC (Windows 11, Node 26.4.0, sandbox PostgreSQL 16.11 with fsync off), three full runs by the package and a fourth on the final tree (all seven checks PASS; the table shows the fourth).

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | A supervisor logs production from a phone: home screen icon, scan, photo, save; an offline save is kept and sent once | PASS (emulated) | `p2-phone.mjs`: 124 checks in about 104 s (Chrome phone emulation, a fake camera playing a generated Code 128 and QR video, emulated network drops) |
| 2 | A manager receives a daily OEE PDF by email from a print template, and prints an inspection report from a record | PASS | `p2-pdf.mjs`: 18 checks against a fake SMTP server; PDFs of 21,183 and 16,116 bytes. Text extraction was not checked on this PC (no `pdftotext`) |
| 3 | A six-tile dashboard loads in under two seconds on 1,000,000 rows for a restricted user, showing only that user's rows | PASS | `p2-dashboard.mjs`: 7 tiles over 1,000,000 production rows and 200,000 downtime rows; the user sees 4,916 own rows; API batch cold median 489 ms (max 514), browser navigation to every tile drawn median 945 ms (max 998), cached 9 ms (final run; earlier runs: 504 to 621 ms and 1,030 to 1,060 ms). Supporting: tile editor 24, layout 77, screens 44 checks |
| 4 | "Create app from table" produces a working app for desktop and phone that opens in the Studio as a normal app | PASS | `p2-autoapp.mjs`: 48 checks, including a lookup picked by typing from a 2,500-row table |
| 5 | A screen, a UI component, an app and a data model template are installed with the binding step and the plan screen, without changing anything that existed | PASS | `p2-templates.mjs`: 31 checks; 243 existing items compared byte for byte before and after |
| 6 | A WhatsApp template message is sent from a flow against a recorded mock; opt-in is recorded; nothing is sent without opt-in | PASS (mock) | `p2-whatsapp.mjs`: 15 checks against a fake Graph API modelled on Meta's documentation; nothing was recorded from a real account |
| 7 | Docs, security re-check, P0 and P1 exit checks still pass | PASS | `p0.mjs`: every automated check passes (1,000,000 rows through the API: first page + count 109 ms, indexed filter 15 ms, sorted page 15 ms, grouped aggregate 227 ms; 29 browser checks; restore drill 55 s); `p1.mjs`: 9 of 9 rows; docs link and naming tests pass after `npm run docs:gen`; `docs/internal/security-review-p2.md`: 12 findings, all fixed |

These timings come from a developer PC with a sandbox database and are NOT production numbers. Not covered by any check: a real Android or iOS phone ([../dev/phone-test-script.md](../dev/phone-test-script.md) has never been run), a real WhatsApp Business account, a real mail provider, a hosted server over real HTTPS, more than one concurrent user (no load test exists), an outside security review.

One unexplained event: in the first of the three runs the restore drill hung for about 450 s after the restored server started; it did not happen again in eight further drills. The drill now has a request timeout and prints the server output when it fails.

## Carried forward

- Owner actions: real-device test script; a Meta account to confirm the WhatsApp points listed in `docs/dev/whatsapp.md`; the release signing key (template integrity rests on it); an outside security review; a decision on service-account print templates (any signed-in person can print any record of the table through one; documented, not changed).
- Deferred by the owner: dashboards' use of summary tables, the pivot table, cold-start offline.
- Not built: Linked mode for UI component and screen templates; SMS; kiosk cycling of ranges or pages; choosing a screen for drill-through; sorting lists by a lookup column; a shared schedule-fields component (the snapshot screen copies the reports' fields).
- Not verified in a browser: template uninstall, upgrade and Linked mode; the WhatsApp admin screens; service-account view tokens.
- Security residuals: `docs/internal/security-review-p2.md` (offline replay after 60 s, a flow can re-opt-in a number after STOP, no per-address connection limit in the server).
- Multi-tenancy for the cloud product is decided but not specified or built ([hosting-and-licensing.md](hosting-and-licensing.md)); everything in Phases 0 to 2 assumes one organisation and one server process.
