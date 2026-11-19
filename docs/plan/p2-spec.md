# Phase 2 (Reach) specification

Status: IN PROGRESS (started 19 Nov 2026). Phase 1 closed at 0.6.0 (`p1-spec.md`).

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
