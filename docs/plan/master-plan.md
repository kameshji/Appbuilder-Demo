# Master plan: from Studio demo to pilot-ready suite

Status: DRAFT for owner review. Nothing in here is being built yet.
Inputs: `docs/research/power-platform/`, `docs/research/building-blocks.md`, `docs/research/manufacturing.md`.

## 1. Goal

A single install (on-prem Windows PC or small Linux VPS) that gives a 20-50 person organisation:
apps, data with security by design, workflows, dashboards, internal chat, files and documents, AI agents,
and an external portal. First pilot: one Indian small manufacturer.

Pilot-ready means: installed at the customer in under an hour, used daily by at least 10 people on at least
3 apps with approvals and alerts, backed up nightly, and survivable without us on site.

## 2. Principles

1. One kernel. Every module (flows, chat, files, agents, sites) uses the same identity, security engine,
   audit log, events and job queue. No module gets its own user directory or its own permission model.
2. One language. The formula language runs in the Studio, on the server (table events, formula columns,
   flows), in sites and as agent tool conditions.
3. Security is inherited, never re-implemented. Flows, dashboards, search, chat shares and agents act as a
   user and go through the same RBAC, row and column checks as an app.
4. Restricted by default. Makers and agents get allow-lists, not open access. Nothing external is reachable
   unless an admin connected it.
5. Permissive licences only in the core (MIT, BSD, Apache-2.0, MPL as separate process). AGPL/fair-code
   projects are design references or optional separately-installed add-ons. CI enforces this.
6. One process to operate. Extra processes are optional add-ons, never required for the core.

## 3. Architecture

### 3.1 Processes

| Process | Required | Purpose |
|---|---|---|
| Appbuilder server (Node 22) | yes | API, static client, WebSocket hub, flow worker, embedding worker |
| MariaDB 11.8 LTS (bundled) or customer MySQL 8.0+ | yes | all metadata and data, job queue, vectors |
| Caddy | yes for LAN/VPS | HTTPS, reverse proxy |
| Office add-on (Collabora CODE or ONLYOFFICE, unmodified) | optional | real docx/xlsx/pptx editing |
| Local Ollama | optional | LLM for customers who keep data inside |
| LAN agent (small outbound-only service) | optional | Tally and other LAN-only systems for VPS installs |

Target footprint: 4 GB RAM for the core, 8 GB with the office add-on (estimate from research).

### 3.2 Kernel services (server)

| Service | State | Notes |
|---|---|---|
| Identity and organisation | partly exists | add departments, manager, teams; password reset; optional 2FA later |
| Security engine | exists | add relationship rules (via lookup paths), team scope, environment-keyed caches |
| Data service | exists | add query pushdown (filter, sort, page, aggregate), formula columns, exact counts; removes the 5,000-row cap |
| Fx engine as shared package | client only today | move `src/fx` to a package used by client and server; formula-to-SQL translator; non-translatable formula on a large table is an error, never a silent partial result |
| Table events | new | before-write (sync, can reject) and after-write (async) hooks; events written to an outbox in the same transaction |
| Job queue and worker | new | MySQL table, `SKIP LOCKED`; runs flows, schedules, embeddings, notifications; retries, dead-letter |
| Realtime hub | new | one WebSocket per session; chat, notifications, live data refresh, presence |
| Notifications | new | in-app, email (SMTP), WhatsApp connector; per-user preferences |
| File service | attachments exist | folders, versions, permissions by reference to the owning record or folder, text extraction |
| Connector runtime | data connectors exist | add action connectors described by JSON Schema (HTTP, email, WhatsApp, Tally, ERPNext); same schema is the agent tool definition |
| Search index | new | FULLTEXT plus embeddings; results filtered by the caller's access before ranking |
| Audit | exists | extend to flows, chat admin actions, agent turns and tool calls |
| Environments | new | one schema plus workspace folder each (Dev, Test, Prod; max about 5); downloadable backup, restore in place |
| Solutions | export/import exists | upgrade in place with previewed plan and automatic backup; Prod locked against direct edits |

### 3.3 Modules on the kernel

| Module | Microsoft equivalent | Design in one line |
|---|---|---|
| Studio and runtime | Power Apps canvas | exists; add phone layout, components, auto-generated app from a table |
| Flows | Power Automate | visual designer (React Flow), triggers: table event, schedule, button, webhook; actions: data, condition, loop, delay, approval, notify, connector action, agent; run history; no metering |
| Approvals | Approvals | plain tables plus an inbox page, email and chat cards with approve/reject |
| Dashboards | Power BI (lite) | chart controls on the aggregate endpoint, security-trimmed; OData feed for Excel/Power BI users |
| Chat | Teams chat | built in-house on the realtime hub: channels, DMs, mentions, files, share a record/app/dashboard as a card, per-record discussion threads, search; available as a panel in every app and in the Studio |
| Files and documents | SharePoint/OneDrive + Office | document library; built-in rich-text notes (TipTap), spreadsheet import/export (SheetJS), document generation from templates (docxtemplater), PDF output; full Office editing via the optional add-on |
| Agents | Copilot Studio | agent = instructions + allow-listed tools + knowledge sources; runs as the calling user; writes need human approval; every turn audited; provider-agnostic (HF router, OpenRouter, Ollama Cloud, local Ollama); budgets per install |
| Sites | Power Pages | page builder (Puck); per-block server endpoints only, deny by default, publish-time security check; OTP sign-in for external users |
| Admin console | Admin center | environments, users, roles, connections, audit viewer, backups, logs, usage, AI budget, licence |
| Templates | Dynamics apps | Tasks, Notes, CRM-lite, and the manufacturing pack (production log + OEE, quality inspection + NCR, maintenance) |

### 3.4 How security carries across modules

| Module | Acts as | Enforcement |
|---|---|---|
| App | signed-in user | existing engine |
| Flow | flow owner, or the triggering user for button flows | engine; connection use is granted per flow by an admin |
| Dashboard | viewer | aggregates computed over rows and columns the viewer may read |
| Chat card for a record | each reader | card shows fields the reader may read; otherwise "no access" |
| Search and agent retrieval | caller | access filter before retrieval |
| Agent tool call | caller | engine, plus tool allow-list, plus approval for writes |
| Site visitor | anonymous or external role | separate deny-by-default role; no generic table API |

## 4. What we deliberately do not replicate

Solution layers and patches, managed/unmanaged distinction, connector metering and premium tiers, DAX,
Liquid, a separate BI security model, environment groups and routing, business process flows, RPA,
a full ERP (see section 6).

## 5. Build phases

Each phase ends with something usable and a written exit check.

| Phase | Contents | Exit check |
|---|---|---|
| P0 Kernel | shared Fx package, query pushdown and paging, organisation model, relationship row rules, table events and outbox, job queue, realtime hub, environments, backup/restore, installer with Caddy, MariaDB 11.8 bundle, licence CI guard | 1 million-row table usable; restore drill passes; install on a clean Windows PC in under an hour |
| P1 Automation | flow engine and designer, approvals, notifications (in-app, email), scheduled reports | purchase-approval flow with escalation runs for a week without loss |
| P2 Reach | phone layout, PDF and document generation, dashboards, WhatsApp connector, auto-generated apps | supervisor logs production from a phone; manager gets a daily OEE PDF |
| P3 Collaboration and templates | chat v1, Tasks, Notes, manufacturing pack, Tally/ERPNext connectors | PILOT STARTS |
| P4 Agents | agent runtime, "ask your data" agent, document knowledge, agent step in flows, admin AI budget | agent answers from tables and files without leaking a restricted column in a red-team test |
| P5 Documents | library versions, office add-on integration, spreadsheet control | docx/xlsx edited in browser and saved back |
| P6 Sites | page builder, external roles, OTP sign-in, security check | supplier portal published and passes the check |

Security review by an outside party before the pilot goes beyond one company.

## 6. Market position (from research, not yet verified by us)

ERPNext (free, GPL, Indian, MariaDB) already covers most manufacturing ERP functions; NocoBase and Budibase
are heading to the same suite with AI. We do not win by rebuilding ERP modules, chat, docs or BI; those are
table stakes. The differentiators to protect: the Excel-formula canvas maker experience, a one-click
on-prem install, and security that flows, search and AI inherit. For the pilot: connect to Tally or
ERPNext for masters and accounting, and own the shop floor, approvals and collaboration around it.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Scope: eight products, one builder | phases with exit checks; pilot after P3; no phase starts before the previous exit check passes |
| Prompt injection through table or document content | agent runs as user, read tools by default, writes need approval, no outbound tools unless allow-listed |
| Company data sent to LLM providers | per-install switch: off / approved provider / local Ollama; shown to the admin in plain words |
| Small open models unreliable at tool use | few, well-described tools per agent; evaluation set before shipping; model is a setting |
| Licence contamination | CI allow-list; AGPL only as unmodified separate add-ons; lawyer review before first sale |
| Support load of on-prem installs | backup, logs, updater and a diagnostics bundle in P0 |
| MySQL 8.4 untested, MariaDB 10.4 lacks SKIP LOCKED | bundle MariaDB 11.8; support MySQL 8.0+ and MariaDB 10.6+ |

## 8. Decisions needed from the owner

1. Database floor: bundle MariaDB 11.8 and drop support below MySQL 8.0 / MariaDB 10.6?
2. ERP stance for the pilot: connect to Tally/ERPNext (recommended) or build our own inventory and sales apps?
3. Agents before or after the pilot starts (plan says after, as P4)?
4. Office editing: optional add-on (recommended) or mandatory part of the install?
5. Which "Odysseus" project was meant (research found the AGPL `odysseus-dev/odysseus`; usable as design reference only)?
6. Product name and licence model (one licence per install with modules is the proposal).

## 9. Owner decisions, 18 Nov 2026 (supersede the sections above where they differ)

Decided:
- Auto apps are in: generate a working app from table metadata (list, detail form, related lists, dashboard),
  then convertible into a normal editable canvas app. Goes in P2.
- We build our own CRM, ERP and other templates. Other systems are data sources only (import/connect).
- Data model designer is in: visual schema canvas with relationships and schema patterns. Goes in P0/P2.
- Documents, slides and sheets: our own simple editors (preview plus rich-text-level edits), not an embedded
  office suite. The office add-on is dropped from the plan.
- Agents stay at P4, after users know the product by hand.
- Identity and security (MFA, single sign-on, sessions) come before the agent runtime.
- Email module and per-user licence passes are wanted; design options are under discussion.

Also decided (18 Nov 2026):
- System database: PostgreSQL. MySQL/MariaDB and SQL Server become connectors for customer data only.
  The MySQL system store and its tests are ported in P0, before anything new is built on the database.
  This supersedes decision 8.1 and the MariaDB bundle in section 3.1.
- Email: a mail client inside the suite on the customer's existing mailboxes, plus a sending relay for
  notifications and login codes. No hosted mailboxes for now. The email address is the account key.
- Licensing: signed licence file verified offline; passes assigned by the admin (Full user, Operator,
  External); seat-band pricing per install; soft enforcement (grace period, then read-only, export always works);
  a small licence portal on our side.

Still open: statutory accounting stance (own ledgers vs Tally exchange), product name, which Odysseus project.

Revised phase order: P0 Kernel (incl. database decision, data model designer core, identity basics: reset,
TOTP, sessions) -> P1 Automation -> P2 Reach (phone, PDF, dashboards, auto apps) -> P3 Collaboration and
templates (chat, Tasks, Notes, manufacturing pack, CRM/ERP-lite templates, licence passes) = PILOT ->
P3.5 Identity advanced (single sign-on in and out, passkeys, enforced MFA policies) -> P4 Agents ->
P5 Documents, slides, sheets, mail client -> P6 Sites.
