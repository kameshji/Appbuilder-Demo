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
| Dashboards | Power BI (lite) | chart UI components on the aggregate endpoint, security-trimmed; OData feed for Excel/Power BI users |
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
| P0 Kernel (done, 0.5.0) | PostgreSQL system store (bundled where we install it; MySQL/MariaDB stays as a connector), shared Fx package, query pushdown and paging, organisation model, relationship row rules, table events and outbox, job queue, realtime hub, environments, backup/restore, identity basics (reset, TOTP, sessions), data model designer core, core data model, installer with Caddy, licence CI guard | 1 million-row table usable; restore drill passes; install on a clean Windows PC in under an hour |
| P1 Automation | flow engine and designer, approvals, notifications (in-app, email), scheduled reports | purchase-approval flow with escalation runs for a week without loss |
| P2 Reach | phone layout, PDF and document generation, dashboards, WhatsApp connector, auto-generated apps, template catalogue (UI component, screen, app and data model templates) | supervisor logs production from a phone; manager gets a daily OEE PDF |
| P3 Collaboration and templates | chat v1, Notes, solution templates (manufacturing pack, CRM, ERP-lite), licence passes, Tally/ERPNext connectors (Tasks shipped early, in P0) | PILOT STARTS |
| P3.5 Identity advanced | single sign-on in and out, passkeys, enforced MFA policies beyond P0's | sign-in with the company identity provider on the pilot's accounts |
| P4 Agents | agent runtime, "ask your data" agent, document knowledge, agent step in flows, admin AI budget | agent answers from tables and files without leaking a restricted column in a red-team test |
| P5 Documents | library versions, office add-on integration, spreadsheet UI component | docx/xlsx edited in browser and saved back |
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

## 10. Owner decisions, 18 Nov 2026 (later)

- ERP templates carry their own ledgers and GST. Before building them: a verified GST calculation spec
  (CGST/SGST/IGST by place of supply, HSN/SAC rates, rounding, reverse charge, credit notes, e-invoice and
  e-way bill thresholds) checked against official sources and reviewed by a practising accountant.
  Tally exchange is an optional connector, built when a customer asks.
- "Appbuilder" is a working name only; a coined name is needed (trademark and domain check before use).
- Agent layer: deferred; to be planned in a separate discussion. Odysseus dropped as a reference.
- Phone and tablet app sizes are in (presets below).
- Shell has two modes: Dev mode (build) and User mode (use). In User mode an app opens as a tab inside the
  shell, like a browser tab, or in a separate window. Chat is a dock panel in the shell and the Studio and
  can pop out into its own window. All planned modules appear in the menus as "coming soon".

App size presets (logical pixels, scale to fit): Desktop 1920x1080, 2560x1440; Phone 360x800 (default),
390x844, 412x915; Tablet 800x1280 portrait, 1280x800 landscape.

## 11. Owner decisions, 18 Nov 2026 (evening)

### 11.1 Naming
"Controls" become "UI components" in all user-facing text and docs. Code identifiers stay. Done as a sweep
at the end of P0 (package M).

### 11.2 Core data model (our "CDS"), package N in P0 wave 4
Every environment gets a set of system tables out of the box, so sharing, chat, mentions, activity and
logging work the same in every app. Makers can read them, look up to them and add their own columns, but
cannot delete them or change system columns.

| Group | Tables |
|---|---|
| People and organisation | User, Department, Team, Team member, Role, Role assignment (read-only projections of the install-wide and security data) |
| Collaboration | Activity (base for Task, Call, Meeting, Email log), Comment, Mention, Share, Follow, Notification, Tag, Tag link |
| Files | Document (file library entry), Document version, Attachment link |
| Communication (filled later by chat and mail) | Channel, Channel member, Message, Message reaction |
| Logging | Audit entry, Sign-in log, Job run, Flow run, Event run (read-only) |
| Reference | Currency, Unit of measure, Country/State, Calendar, Holiday, Number sequence, Setting |
| Common business model (shared by CRM and ERP templates; installed with them, not forced) | Account, Contact, Address, Product, Price list, Tax code |

Rules: polymorphic "regarding" link (table id + row id) on Activity, Comment, Mention, Share, Follow, Tag
link and Attachment link, so any row of any table gets a timeline, comments, followers and files without
per-table work. Security: a collaboration row is visible only to users who can read the row it is about.

### 11.3 Templates marketplace
Template kinds and what "use" does:

| Kind | Use action | Depends on |
|---|---|---|
| UI component (single or composite, e.g. address block, approval bar) | insert a copy into the current screen | optional data slots |
| Screen (list-detail, dashboard, wizard, login-style landing) | add as a new screen of the current app | data slots |
| App | create a new app | tables (installed or mapped) |
| Data model (tables, relationships, sample data optional) | create tables | - |
| Flow, dashboard, role set, theme, document template | add to the environment | tables |
| Solution (CRM, ERP, manufacturing pack) | install as a versioned solution | everything inside |

Rules that keep installs from breaking anything:
1. Nothing existing is ever overwritten. Name clashes are resolved before install (map to an existing table,
   or install under a new name).
2. Data slots: a template declares the tables/columns it needs; a binding step maps each slot to an existing
   table/column or creates it. Unmapped required slots block the install.
3. Every install shows the same plan screen as solution import (new, changed, nothing removed) and runs in
   one transaction; a pre-install backup is taken when backups exist.
4. Two modes: Copy (yours to edit, no updates) and Linked (versioned solution; updates arrive as an
   upgrade-in-place plan; local changes to linked parts are listed and kept or replaced by choice).
5. Install target can be a sandbox environment first, then "Deploy to" production.
6. Uninstall removes apps, flows and roles; tables with data are kept unless the admin ticks delete, typed
   confirmation.
7. Templates carry a minimum platform version and a signature; the built-in catalogue ships with the
   install (works offline); an online catalogue comes later.
8. Templates cannot contain connection secrets, users or run-as-system events without an explicit admin
   approval step.

Phase placement: catalogue mechanics and the UI component / screen / app / data model kinds in P2;
solution templates (manufacturing pack, CRM, ERP) in P3.

## 12. Owner decisions, 20 Nov 2026 (supersede the sections above where they differ)

- **Customers are several small organisations (2 to 50 people each), not one large one.** Two ways to buy:
  **hosted** (we run it; recurring payment) and **on-site** (one server at the customer's site, one-time payment;
  the owner's words: "LTV option"; whether that means a lifetime licence is to be confirmed).
- **Licensing is verified online.** A server needs the internet to verify its licence and the organisation it belongs
  to. Offline is for data entry on phones, never for licensing. This supersedes "signed licence file verified offline"
  in section 9. Open: how long a server keeps working when the licence service cannot be reached (see
  `hosting-and-licensing.md`; the plan proposes a stated grace period so a customer's plant does not stop when our
  service or their line is down).
- **No cold-start offline on phones** (opening an app with no connection after the browser session ended). D32 stands.
- **QR codes on iPhone:** use a permissively licensed (Apache-2.0) decoder library; say so in the UI component
  documentation.
- **Deferred:** dashboards' automatic use of summary tables, and the pivot table.
- **No scope cut:** the full phase order stands; the "pilot-minimum" of the launch plan is not adopted.
- **Hosting:** no server is rented until the product is about 70% complete (the owner wrote "7-%"; 70% assumed).
  Development continues on the sandbox.
- **png-js licence exception:** approved (`scripts/licence-exceptions.json`).

How hosted, multi-organisation operation is to be built is proposed in `hosting-and-licensing.md` and is NOT yet
approved; nothing in it is built.

## 13. Owner decisions, 20 Nov 2026 (later; supersede section 12 where they differ)

- **It is a platform, and the cloud product is truly multi-tenant.** Tens of thousands of users are expected. Cloud
  customers share one hosted service with tenant isolation built into the product; the fleet-of-installs approach
  ("A" in `hosting-and-licensing.md`) is rejected for the cloud.
- **On-premises stays single-organisation:** one organisation installs the server and uses the desktop and phone apps
  on its own servers, under a lifetime ("LTV") licence.
- **Go-to-market:** controlled testing first with invited start-ups and companies; those who like it subscribe at a
  price for N seats.
- **Licence grace period:** 3 days when the licence service cannot be reached, no more.
- **Hosted customers may start before the outside security review.** This supersedes the master plan's "security
  review by an outside party before the pilot goes beyond one company" for the hosted testers. The risk is accepted by
  the owner: until that review, isolation between tenants rests on internal review and tests only.

Multi-tenancy is a new phase that is not in the phase table of section 5. Its outline is in
`hosting-and-licensing.md`; it must be specified (like p0-spec.md) and approved before it is built.

## 14. Owner decisions, 20 Nov 2026 (evening)

- **Multi-tenancy is built before Phase 3.** Order: specification (`multi-tenancy-spec.md`), then the multi-tenancy phase, then Phase 3.
- **Service-account print templates stay as they are** (any signed-in person can print any record of the table through one: the documented purpose of a service account).
- **Tester terms:** a draft is written for a lawyer to review before launch (`../launch/tester-terms-draft.md`); it is not legal advice and must not be used unreviewed.

## 15. Owner decisions, 20 Nov 2026 (night; supersede sections 13 and 14 where they differ)

- **Nothing launches before the owner's last working day** at his employer. There is no launch pressure; the instruction is to make the product complete and working.
- **The target to build for now is one server:** 10 to 20 paying organisations, each with 20 to 50 people (4 to 5 makers, the rest users), about 200 to 1,000 named users in all. "Tens of thousands of users" is 3 to 4 years away and must not drive what is built now.
- **Still fixed:** true multi-tenancy inside the product for the cloud; one organisation per install with a lifetime licence on-premises, from the same code; online licence check with 3 days of grace.
- **Consequence for the multi-tenancy phase:** tenant isolation at full strength, sized for one server process; more than one server process, sharding and large-scale load are designed for but not built (`multi-tenancy-spec.md`).
- **Way of working:** keep building without waiting for approvals; where a question is open, the recommended default is chosen, recorded as "default chosen, owner may change", and reported at the end of each wave.

## 16. Decision delegated by the owner, 20 Nov 2026: hosting is a managed fleet of installs

The owner asked the orchestrator to choose between true multi-tenancy and one install per organisation, with one goal: a completed product that at most 20 organisations can use in a paid pilot. **Chosen: one install per organisation on the same server** (its own server process, its own PostgreSQL database and workspace, one reverse proxy with a host name per organisation). This supersedes "true multi-tenancy" in sections 13 and 15 for this stage.

Reasons: isolation by process and database needs no change to the kernel and no re-review of Phases 0 to 2; a product bug cannot show one organisation another's data; hosted and on-premises are the same build; it is the shortest route to a paid pilot. Cost: a provisioning and fleet tool, more memory per organisation (to be measured), and operations work per instance. True multi-tenancy stays a documented later option (appendix of `hosting-spec.md`) for when the number of organisations makes a fleet too costly to run.

Default chosen, owner may change.
