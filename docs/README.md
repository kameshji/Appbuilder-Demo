# Appbuilder documentation

Appbuilder is a desktop low-code platform for small businesses: makers design apps on a drag-and-drop canvas with
Excel-style formulas, keep data in PostgreSQL, existing databases, data files or Google Sheets, and control who sees what with roles, row
filters and column security. ("Appbuilder" is a working name.)

## Status

Version **0.7.0** (Phase 2, "Reach", is done: see [CHANGELOG](../CHANGELOG.md) and [the Phase 2 spec](plan/p2-spec.md) with its
exit check results; Phase 1, "Automation", closed at 0.6.0: [the Phase 1 spec](plan/p1-spec.md); Phase 0, "Kernel", at 0.5.0:
[the Phase 0 spec](plan/p0-spec.md)). Phase 2 added phone apps (installable, offline entry, barcode and QR scanning, signature
pad), print templates and PDFs, dashboards (tile editor, TV screens, email snapshots, pinned tiles), auto apps, the templates
catalogue and the WhatsApp connector. Nothing in Phase 2 has been run on a real phone, against Meta's real API or on a hosted
server, and there has been no outside security review. The product serves ONE organisation per install; a multi-tenant cloud
product is decided but not built ([plan](plan/hosting-and-licensing.md)). Every page below describes
what exists in this version; each page says what is not supported yet. "Current" means the page was checked against the
code for 0.7.0 where Phase 2 touched it, otherwise for 0.6.0.

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
| [Data API v1 reference](dev/data-api.md) | current (v1 stays for one more phase) |
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
| Plans: [master plan](plan/master-plan.md), [Phase 0 spec](plan/p0-spec.md), [Phase 1 spec](plan/p1-spec.md), [Phase 2 spec](plan/p2-spec.md), [multi-tenant cloud, on-premises and licensing (outline)](plan/hosting-and-licensing.md) | current |
| Security reviews: [Phase 0](internal/security-review-p0.md), [Phase 1](internal/security-review-p1.md), [Phase 2](internal/security-review-p2.md) | current |
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
