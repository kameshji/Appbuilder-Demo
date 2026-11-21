# Appbuilder documentation

Appbuilder is a desktop low-code platform for small businesses: makers design apps on a drag-and-drop canvas with
Excel-style formulas, keep data in PostgreSQL, existing databases, data files or Google Sheets, and control who sees what with roles, row
filters and column security. ("Appbuilder" is a working name.)

## Status

Version **0.9.0** (Phase 3, "Collaboration and templates", is built; Accounts (ledgers and India GST) is a prototype on a draft no accountant has reviewed: see [CHANGELOG](../CHANGELOG.md) and
[the Phase 3 spec](plan/p3-spec.md) with its exit check results; the hosting phase is partly built: [hosting spec](plan/hosting-spec.md);
Phase 2 closed at 0.7.0, Phase 1 at 0.6.0, Phase 0 at 0.5.0). Phase 3 added chat, tasks and notes, solution templates with the
Manufacturing, CRM and ERP-lite packs (no tax is computed anywhere), licensing with seat passes, the fleet tool for hosting several
organisations on one server (one install each), an isolation suite and a load-test harness. Nothing has been run on a real phone,
against Meta's real API, with a real mail provider or on a rented server, and there has been no outside security review.
Every page below describes what exists in this version; each page says what is not supported yet.

## For customers

| Guide | Who it is for | Status |
| --- | --- | --- |
| [Getting started](guide/getting-started.md) | Anyone installing it on a Windows PC (one installer script) | current |
| [Signing in, two-step verification, forgotten password](guide/signing-in.md) | Everyone using the server | current |
| [Your settings](guide/settings.md) | Everyone | current |
| [Maker guide](guide/maker/README.md): [apps](guide/maker/apps.md), [the Studio](guide/maker/studio.md), [formulas](guide/maker/formulas.md), [data](guide/maker/data.md), [data model designer](guide/maker/data-model.md), [core data model](guide/maker/core-data-model.md), [security for makers](guide/maker/security-for-makers.md), [solutions](guide/maker/solutions.md), [flows](guide/maker/flows.md), [connections and actions](guide/maker/connections-and-actions.md), [webhooks](guide/maker/webhooks.md), [approvals](guide/maker/approvals.md), [scheduled reports](guide/maker/scheduled-reports.md), [notifications](guide/maker/notifications.md) | People who build apps and tables | current |
| [Admin guide](admin/README.md): installation (Windows and Linux installers, offline, HTTPS, email with Microsoft 365 / Google Workspace), operations (services, logs, health, health email and heartbeat, diagnostics), users and roles, sign-in and identity, organisation, reference data, environments, connections (and HTTP / Email actions, access, email limits), webhook security, [flows](admin/flows.md) (run-as, kill switch, limits), [approvals](admin/approvals.md), backup and restore, disaster recovery, upgrades, audit log, jobs | The person who runs it | current |
| [Phone apps](guide/maker/phone-apps.md), [print templates](guide/maker/print-templates.md), [dashboards](guide/maker/dashboards.md); admin: [phones](admin/phones.md), [printing](admin/printing.md), [dashboards](admin/dashboards.md); dev: [phone](dev/phone.md), [PDF engine](dev/pdf.md), [dashboards](dev/dashboards.md); [real-device test script](dev/phone-test-script.md) | Makers, administrators, developers | current (Phase 2 wave 1) |
| [WhatsApp in flows](guide/maker/whatsapp.md); admin: [WhatsApp](admin/whatsapp.md) (connection, webhook, opt-ins, message log, notifications) | Makers, administrators | current (tested against a mock only) |
| [Chat](help/chat.md) for everyone; [chat for teams](guide/chat.md); [tasks](help/tasks.md) and [tasks for makers](guide/maker/tasks.md); the [Manufacturing pack](guide/maker/manufacturing-pack.md) (solution template) and [shop floor on your phone](help/shop-floor-phone.md) | Everyone, makers | current (Phase 3; phone parts checked in emulation only) |
| Solution templates: the [CRM pack](guide/maker/crm-pack.md) (leads, opportunities, quotes without tax, pipeline dashboard, phone app) and the [ERP-lite pack](guide/maker/erp-lite-pack.md) (stock that never goes below zero, purchase and sales cycles, commercial invoices that are not tax invoices) | Makers, administrators | current (no tax is computed anywhere) |
| [Licensing and seat passes](admin/licensing.md): online licence check, 3 days of grace, passes, the licence service command line | Operators, administrators | current (not used with a real customer yet) |
| [Fleet operations](admin/fleet-operations.md): the fleet tool `abfleet` for hosting up to 20 organisations on one Linux server (not yet run on a rented server) | Operators | current |
| [Hosting: many installs on one server](admin/hosting.md): socket listening, the locked public URL, closed setup, read-only installs | Operators | current (Linux-only parts run in CI, not on a server yet) |
| [Chat for administrators](admin/chat.md): retention, moderation, export, what administrators can and cannot see | Administrators | current (Phase 3 package A, server only) |
| [Templates](guide/maker/templates.md): the built-in catalogue of UI component, screen, app and data model templates (binding, plan, Copy and Linked, uninstall); dev: [templates](dev/templates.md) | Makers, developers | current (Phase 2) |
| [Help centre for end users](help/index.md): signing in, finding apps, lists and forms, records, notifications, approvals (quick start for approvers), scheduled emails | People who use the apps | current |
| [Security model](admin/security-model.md) and [hardening checklist](admin/hardening-checklist.md) | Admins and buyers evaluating it | current |
| [UI components reference](reference/ui-components.md) | Makers (generated from the code) | current (generated) |
| [Formula reference](reference/formulas.md) | Makers (generated from the code) | current (generated) |
| [Connector actions reference](reference/connector-actions.md) | Makers (generated from the code) | current (generated) |
| [Flows reference](reference/flows.md): every trigger and step kind | Makers (generated from the code) | current (generated) |
| [Approvals reference](reference/approvals.md): types, approver references, escalation, step outputs | Makers (generated from the code) | current (generated) |
| [Troubleshooting](guide/troubleshooting.md) | Everyone | current |

## For developers

| Document | Status |
| --- | --- |
| [Architecture](dev/architecture.md) | current |
| [Frontend: UI components, Fx functions, the Studio store, the platform facade](dev/frontend.md) | current |
| [Database schema (system store, environments, JIT and collation notes)](dev/schema.md) | current |
| [Data API reference](dev/data-api.md) | current (the v1 read route was removed in Phase 3; reads use Query v2) |
| [Query v2: the endpoint and formula-to-query translation](dev/query-v2.md) | current |
| [Security engine: roles, row and column security, organisation scopes, sharing](dev/security-engine.md) | current |
| [Authentication and identity](dev/auth.md) | current |
| [Table events, outbox, jobs and schedules](dev/events-and-jobs.md) | current |
| [Realtime: live data refresh, presence, notifications](dev/live.md) | current |
| [Data model designer: relationships, plans, reporting views and their security](dev/data-model.md) | current |
| [Core data model: system tables, the regarding rule, NextNumber](dev/core-data-model.md) | current |
| [Backups: archive format, engine, restore](dev/backup.md) | current |
| [Release process: building, signing, the installers and the updater](dev/release-process.md) | current |
| [Flows](dev/flows.md): the runtime (tables, execution, guarantees, triggers, security, ALM) and the designer | current |
| [Approvals](dev/approvals.md) (routing, security, email links, flows, the visual editor) | current |
| [Chat: server, HTTP and live API](dev/chat.md) | current (Phase 3 packages A and B) |
| [Tasks: reminders, digest, repeats, shares, shared schedule fields](dev/tasks.md) | current |
| [Notes: the editor, the server sanitiser, sharing, record cards](dev/notes.md); for people: [Notes](help/notes.md), [notes for teams](guide/notes.md) | current |
| [Ledgers and India GST (Accounts)](dev/ledgers-gst.md); for people: [Accounts](guide/accounts.md); administrators: [setup and period locks](admin/accounts.md). A prototype on a draft specification not yet reviewed by a practising accountant | prototype |
| [Balances kept in the same transaction](dev/balances.md) (stock that cannot go below zero); [licensing in the code](dev/licensing.md) | current |
| [Load testing the hosted fleet](dev/load-testing.md) (`node scripts/bench/load/run.mjs`); results: [November 2026](internal/load-test-2026-11.md) | current (a developer PC, not a server) |
| [Hosting support in the server](dev/hosting.md): rules for links, cookies, outbound connections, classifying routes and job types; `node scripts/exit-check/h-isolation.mjs` runs the cross-instance isolation suite (evidence for the release gate, not a security review) | current |
| [Solution templates (authoring)](dev/solution-templates.md): writing a pack (format 2): tables, tokens, apps, flows, approvals, dashboards, print templates, roles, number sequences, reference and SAMPLE rows, dependencies, upgrades, the pack test | current |
| [Templates catalogue](dev/templates.md): package format, slots and binding, integrity, plan and install paths, Linked upgrades, uninstall | current |
| [WhatsApp connector](dev/whatsapp.md): connection, actions, opt-in store, webhook, notification channel; what is unverified without a Meta account | current |
| [Auto apps](dev/auto-apps.md): generating a list / detail / edit app from tables (desktop and phone) | current |
| [Recycle bin](dev/recycle-bin.md): deleted rows kept and restored (batches, the live-row predicate, restore rules, purge) | current |
| [Writing a connector](dev/connectors.md) (tables and actions: HTTP, Email, webhooks in) | current |
| [Notification delivery: channels, email, digests, unsubscribe](dev/notifications-delivery.md) | current |
| [Testing](dev/testing.md) | current |
| [Decision log](decisions.md) | current |
| [Changelog](../CHANGELOG.md) | current |
| [Third-party notices](../THIRD-PARTY-NOTICES.md) | current (generated by `npm run notices`) |
| Plans: [master plan](plan/master-plan.md), [Phase 0 spec](plan/p0-spec.md), [Phase 1 spec](plan/p1-spec.md), [Phase 2 spec](plan/p2-spec.md), [GST calculation specification (draft, awaiting the accountant's sign-off)](plan/gst-spec-draft.md), [Phase 3 spec (proposed defaults)](plan/p3-spec.md), [multi-tenant cloud, on-premises and licensing (outline)](plan/hosting-and-licensing.md), [hosting phase: a managed fleet of installs, and licensing (proposed)](plan/hosting-spec.md) | current |
| Security reviews: [Phase 0](internal/security-review-p0.md), [Phase 1](internal/security-review-p1.md), [Phase 2](internal/security-review-p2.md), [Phase 3 and hosting](internal/security-review-p3.md) | current |
| Build specs used while developing earlier phases | [internal/specs](internal/specs) (historical, not maintained) |

## Documentation rules
1. Docs live in this repository and change in the same commit as the behaviour they describe.
2. Reference pages that can be generated are generated (`npm run docs:gen`); a test fails when they are stale.
3. Every page says what is not supported yet. No page describes a feature that does not exist.
4. Plain English, short sentences, task-first ("To add a table, ..."). Screenshots live in `docs/images/` and are
   regenerated by the scripts in `scripts/docs-shots/` (need `puppeteer-core` and a local Chrome).
5. Security statements must match the code and the security tests; when they change, the security model page changes.
6. Links are checked: `scripts/docs-links.test.ts` fails on a relative link or image that points nowhere.
7. "UI components", never "controls", in anything a person reads (`scripts/naming.test.ts` guards string tables and
   the generated reference); code identifiers (`src/controls`, `ControlType`) keep their names.
