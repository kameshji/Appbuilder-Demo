# Changelog

All notable changes to Appbuilder are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.9.0] - 2026-11-21

**Accounts (ledgers and India GST) is built as a prototype on a draft specification that no practising accountant has reviewed; the product makes no compliance claim.** Also: the load-test findings, the open security findings and the known bugs carried forward from 0.8.0.

### Added
- **Accounts** (ledgers and India GST), by the owner's decision of 21 Nov 2026 to build on `docs/plan/gst-spec-draft.md` before the accountant's sign-off: chart of accounts, journals, period locks, trial balance, profit and loss, balance sheet; tax invoice, bill of supply, credit and debit notes, vouchers and purchase invoices with GST computed from dated reference data the administrator maintains (shipped empty); PDFs; 13 return summaries as data and CSV. No filing, no IRN or e-way bill generation. Schema version 15. Spec and what is not built: `docs/plan/ledgers-gst-spec.md`; draft defaults chosen: `docs/dev/ledgers-gst.md`.
- Server commands `appbuilder status --json`, `appbuilder backup create`, `appbuilder admin operator-access open|close`; the fleet tool uses them when the release has them.
- `GET /api/v1/admin/health` shows the event-loop delay (p50, p99, max for the last minute and since start) with a warning check above 100 ms, plus print-pool and table-cache counters; the load harness records them.
- Administrators see a strip under the top bar during the licence grace period (time left, what to do) and the steps out of a licence read-only state.
- `scripts/exit-check/p3-clickthrough.mjs`: a browser click-through of Accounts (also at phone width), Licences, seat passes, the form-submitted trigger, kiosk cycling, template install and widening upgrade, a Form's starting Item and every side-menu item in both modes. It fails on any page error, console error or server error. It found the nine bugs fixed below.

### Changed
- Prints (PDF layout and writing) run in a small pool of worker threads (`APPBUILDER_PRINT_WORKERS`, `APPBUILDER_PRINT_QUEUE`) and no longer hold up other requests; a full queue answers 503; the PDF bytes are unchanged.
- CSV imports parse, check and insert in slices that let other requests run; still all or nothing (`APPBUILDER_IMPORT_YIELD=off` restores the old path).
- The table list is cached per environment and refreshed after every data-model change or after 60 s; permissions are still applied per request (`APPBUILDER_TABLE_CACHE`, `APPBUILDER_TABLE_CACHE_TTL_MS`).
- An Activity can be moved to another record (or unlinked) after creation; the writer must be able to read the new record; audited as `activity.regarding`.
- Fleet: one source of truth for the PostgreSQL tools folder (recorded by `abfleet init`, detected when unset); commands wait up to 120 s for the lock; diagnostics on CI failure. The Linux CI job `fleet` now passes on Ubuntu 24.04 (41 checks; 5 need a rented server) and is a blocking job; the release now contains the licence service, which the fleet tool runs from it.

### Fixed
- Uninstalling a solution with "Delete tables" failed when a table rolled up its own child lines.
- A Form in New mode with a starting `Item` dropped that record's values for columns not in `Fields`.
- Tests: test-database drops no longer hold a suite's shutdown for more than 15 s.
- The setup screen no longer says "runs as a service" for a server started by hand with `APPBUILDER_SETUP_CODE_FILE`.
- Accounts stays on Settings after the registration is saved; switching Reference data, Ledger or Return summaries no longer briefly shows the previous list; buttons and check boxes are tap-sized on phones.
- Printed GST documents group the unit price and print the credit-note reason in words.
- The data model page no longer breaks when lookups form a cycle (cards and lines vanished after installing ERP-lite).
- A cycling kiosk screen no longer skips a date range in its first round.
- The licence and read-only strips write dates like the Licences page.

### Security
- (P3-15) MySQL / MariaDB connections over SSL check that the certificate names the host typed, IP addresses included. **A connection by a name or address its certificate does not carry is now refused.**
- (P3-16) A pack upgrade that widens a role's access lists each role and change and runs only after the administrator ticks "I accept the wider access" (enforced by the server).

### Not built or not verified
- `rekey` (needs a registry of every sealed column first) and locked SMTP settings by environment.
- Accounts: an ERP-lite sales invoice as a GST tax invoice, delivery challan fields, year-end closing, several original invoices per note; backup and restore of the Accounts tables is untested; an environment copy does not copy the books.
- Seen in the click-through, not fixed: opening the trigger card in the flow designer right after it loads can close the panel; the kiosk header says "All time" for a moment before its first answer; in the read-only state the home page still shows "Start" and "Edit" buttons (the server refuses the changes); the new-flow gallery has no "When a form is submitted" starting point.
- Nothing has run on a real phone, against Meta's real API, with a real mail provider or on a rented Linux server. No outside security review.

## [0.8.0] - 2026-11-21

**Phase 3 "Collaboration and templates" is built except ledgers and GST, and the hosting phase is built as far as it can be without a Linux server** (docs/plan/p3-spec.md and docs/plan/hosting-spec.md, with the exit check results). Chat, Tasks, Notes, solution templates with the Manufacturing, CRM and ERP-lite packs, the licence service and seat passes, the fleet tool, an isolation suite and a load-test harness. Schema version 14. Ledgers and GST wait for a practising accountant to sign docs/plan/gst-spec-draft.md. Verified on one developer PC and in CI; nothing has run on a real phone, against Meta's real API, with a real mail provider or on a rented server, and there has been no outside security review (internal review: docs/internal/security-review-p3.md).

### Added
- **Fleet tool** (`abfleet`, hosting up to 20 organisations on one Linux server): create, status, suspend / resume, export, delete with a verified scan, canary updates with per-install rollback, encrypted off-machine backups with restore and a monthly restore test, resource limits, time-boxed audited operator access announced to the organisation's administrators, secrets rotation, a daily summary; the fleet installer `scripts/fleet/install.sh` and a CI job that does not pass yet (it stops at `abfleet init` on the runner). Not yet run on a real server; the secret key cannot be rotated yet.
- **Load test harness** (`scripts/bench/load`): real installs with their own databases, the Manufacturing pack, months of history, phone writes, live connections, prints, flows and a heavy tenant; smoke, pilot and ramp profiles. First runs on a developer PC: the 20 organisations x 50 people target met the latency, error and live-delivery limits; the per-install event-loop limit failed in short phases (prints and imports run on the request loop).
- **CRM pack** (built-in solution template): leads converted to account, contact and opportunity; opportunities and quotes with a discount approval; a printable quote; a pipeline dashboard; touchpoints logged as activities; a desktop and a phone app. Quotes carry no tax.
- **ERP-lite pack** (built-in solution template): stock by item and location, purchase requests and orders with approvals, goods receipts, sales orders, deliveries, commercial invoices marked as not tax invoices, a stores phone app with scanning and offline entry. No tax is computed anywhere.
- **Balances kept in the same transaction.** A table can keep the running sum of another table's rows and refuse a change that would take it below a floor (stock that cannot go below zero, also under simultaneous issues). Declared in packs for now.
- **Licensing.** A licence service (`node server/licence-service/main.ts`) with organisations, plans, seats, payment state, install keys and signed answers, and an audited operator command line. Installs verify their licence online every 6 hours, keep working for 72 hours without the service with a warning naming the exact time, then go read-only until the next valid answer; a clock set back does not extend this. An install with no licence configured works as before.
- **Seat passes.** Full user, Operator (no Dev mode, enforced on the server) and External (not assignable yet), assigned in Admin console > Users; over-seat warnings, never lockouts; only counts go to the licence service.
- **Dashboards and flows.** Drill-through can open a named screen of an app. Kiosk screens can cycle through date ranges and pages. New flow trigger **When a form is submitted**, for the submitter, validated by the server against the committed write, exactly once even when replayed from the offline outbox.
- **Error boundaries.** A failing UI component, tile, app tab, Studio, chat dock or page now shows a message in its place instead of blanking the whole app.
- **Notes.** A Notes page in User mode with rich text (headings, lists, checklists, tables, images, files), autosave with a conflict choice, mentions that notify, record cards that show each reader only what they may see, and sharing with people and teams to read or edit. A quick note button in the header; notes about a record appear on its timeline. Every note body is cleaned on the server by a strict allow-list. Online only.
- **Chat: cards, discussions, approvals.** Share to chat for records, apps and dashboards; approval cards in a personal Approvals conversation, answered through the approvals service and updated live; a timeline event per approval answer; record Discussions in the chat panel; editing your own comment on the timeline. Chat uses the page's single live connection; chat mentions appear on the Mentions page; deep links load the messages around an old message.
- **Flows.** Create a row can set the owner (an administrator's flow can give it to the person who triggered the run); Notify can target roles and teams; the approval step takes an optional requester.
- **Templates.** List headers in packs; system column names refused up front; uninstall keeping tables also keeps empty pack tables a kept table looks up; environment copies with data carry the install register.
- **Hosting: isolation suite** (`node scripts/exit-check/h-isolation.mjs`, and a CI job): three real installs side by side, 113 checks of host routing, cookies, tokens and links, database roles, outbound connections, files and the read-only state. The Admin console shows a locked public address read-only.
- **Chat is live.** Open and private channels, direct and group conversations with threads, reactions, files, mentions, typing and per-reader record, app and dashboard cards, in the dock, its own window or full screen on a phone, live across tabs and recovering after a dropped connection. Admin console > Chat: who creates channels, retention per kind, read-only people, reported messages, conversation metadata, and the export of one conversation with a typed reason that its members are told about.
- **Tasks.** Reminders fire once (also across a restart) and a daily overdue digest; repeating tasks; sharing a task with people; My tasks works at phone width. New system table `ActivityShares` and Activities columns for notes (no schema version change). One shared schedule and recipient editor for Reports, dashboard Snapshots and task repeats.
- **Manufacturing pack** (built-in solution template 1.0.0): 16 tables, 7 apps (3 phone apps with offline entry), 10 flows, 3 dashboards on the OEE measures, 6 print templates, 5 roles, fictional SAMPLE data you can remove. The daily OEE PDF is a scheduled flow and needs an Email connection.
- **Hosting (packages H-A, H-C).** An install can listen on a Unix socket, lock its public address (`APPBUILDER_PUBLIC_URL`, used for every generated link; `__Host-` cookies over https), close the setup screen and be set up with `appbuilder migrate` / `admin invite`, and use hosted defaults (pool 6, job polling 5 s, outbound to private networks always refused). New read-only state (`appbuilder read-only on|off`): writes answer 503 `install_read_only` while reads, sign-in and exports keep working and a banner explains why; background jobs that change data wait. On-premises installs are unchanged unless configured.
- **Chat server**: channels, direct and group conversations, threads, reactions, files, record / app / dashboard cards resolved per reader, mentions and chat notifications, search, retention, moderation, reports, and an audited export announced in the conversation (`/api/v1/chat/*`, live topics `chat:<id>`).
- **Solution templates** (Templates > Solutions): a whole working set (tables, desktop and phone apps, flows, approvals, dashboards, print templates, roles, number sequences) installs as a versioned solution in one step after a backup, upgrades in place with your changes kept or replaced, and **Remove sample data** removes only the sample rows. The common business model is in the catalogue and is installed first by the templates that need it. New built-in example: **Visitor log**. Flows brought by a template arrive turned off; an administrator switches them on.
- **Sort by a lookup.** Lists can be sorted by a lookup column's name on the server (DataTable headers, the phone card Sort by, auto apps). A record the viewer cannot read sorts as blank; a hidden name column is refused; tables on MySQL, data files and Google Sheets say they cannot be sorted this way.
- Plans: a GST calculation specification draft for a practising accountant to review (docs/plan/gst-spec-draft.md); nothing of ledgers or GST is built before the sign-off.

### Fixed
- **The whole app could go blank after many rows changed at once** (for example Remove sample data with several apps open). Two lists that showed the same lookup could overwrite each other's name for a record forever while their data was refreshing, an endless re-render. A refreshing or failed answer now only fills names not known yet, and a complete answer never overwrites a newer one. Present since 0.7.0.

### Removed
- **Breaking:** the Data API v1 read route `POST /api/v1/data/:table/query` is removed (404). Use `POST /api/v1/query` with a Query v2 plan. The row write routes are unchanged. The browser's small-table cache and offline answers use Query v2.

### Security
- External PostgreSQL and MySQL connections connect only to addresses the outbound policy checked: the driver never asks DNS itself, and every later connection is resolved and checked again (closes DNS rebinding; this also closes the residual risk noted in the Phase 0 review).
- A refused stock movement no longer shows the quantity, or item and location names, to people who may not read them.
- Operator passes apply on the live connection and in the sign-in answer, a pass change takes effect on open sessions at once, and flow webhooks and connection custom actions need a Full user pass, also for administrators.
- The hosted outbound deny list also refuses hosts that resolve to a listed host's address.
- Chat moderation can no longer remove the lines Appbuilder writes into a conversation (an export announcement cannot be hidden); an edit share on a note or task no longer allows assigning it to someone else; task reminders and the overdue digest no longer name a task about a record its owner can no longer read; the approvals page sanitises stored comments again before showing them; the error-boundary test hook does nothing in production builds.
- Internal review of everything added since 0.7.0: docs/internal/security-review-p3.md (19 findings: 10 fixed, 2 open, 7 accepted; two passes; internal only, no outside audit). Open: MySQL over SSL does not check that the certificate names the host; a pack upgrade does not say when a role's access widens.
- **Self-approval through a flow.** An approval asked by a flow is now on behalf of the person whose change or button press started it: that person (and the flow's identity) is never asked, and the fallback is their manager. Before, the person who caused a request (for example an NCR raised from their own failed inspection) could approve it.
- A database connection whose host name resolves to a loopback, private or otherwise refused address is no longer stored, and every use of an external database connection checks its host again (found by the isolation suite: it was refused on save and test but stayed usable through other routes).
- The sign-in throttle keys on the client address behind the trusted proxy (it keyed on the proxy, so anyone could lock a known account out for everyone). Hosted installs refuse socket-path and localhost database and mail hosts, and backup or tools folders outside the install's own directory.
- The communication system tables were writable through the data API (any user could create channels or add members with any role), and environment administrators read every message through Query v2. Chat tables are now written by the chat service only and read by membership for everyone, administrators included. Nothing wrote to these tables before, so nothing was exposed.

### Known gaps
- Chat: no presence dots; WhatsApp for chat is untested. Notes: online only; printing uses the browser; record cards do not open the record.
- Manufacturing pack: one photo per inspection; the daily OEE PDF still reads role assignments by formula and needs an Email connection.
- Packs: CRM call logging from the phone needs a connection; ERP-lite has no sample stock and its install by clicking was not checked in a browser; balances are packs-only; a refusal states the available quantity only to people who may read the balance table; uninstall with delete can fail when a parent has a rollup over its own lines (the packs avoid rollups).
- Licensing: no top-bar banner for the grace warning (a notification and the Admin console show it); the Admin licence page and the Users pass column were not clicked through; not tamper-proof against whoever runs an on-premises server.
- Render errors are logged to the browser console only (the server has no endpoint for them).
- Hosting: Unix-socket behaviour, per-install OS users, file permissions between installs and resource limits are tested in CI or need a real Linux server; a mail relay on the same machine is refused by the hosted outbound policy. The fleet tool and the licence service are not built yet.
- Solution templates: scheduled reports and Word print templates cannot go in a pack; environment copies do not carry the install register; a dependency's tables cannot be chosen in the install dialog; deploying a pack's solution to another environment is untested.

## [0.7.0] - 2026-11-20

**Phase 2 "Reach" is done** (docs/plan/p2-spec.md, with the exit check results): phone apps with offline entry, print templates and PDFs, dashboards with TV screens and email snapshots, auto apps, the templates catalogue, the WhatsApp connector. Schema version 13. Verified on one developer PC and in CI; nothing was run on a real phone, against Meta's real API or on a hosted server, and there has been no outside security review (internal review: docs/internal/security-review-p2.md).

### Added
- **Phone apps.** Apps designed at phone or tablet size run full width on phones and scroll vertically; safe areas and the on-screen keyboard are handled; small UI components get 44 px touch areas; open apps become a switcher at phone width. App cards have an "Open on a phone" QR code, and each app can be added to the home screen (web app manifest and a service worker that caches only the application shell). New UI components Barcode scanner and Scan input (the browser's barcode reader, or a built-in reader for EAN, Code 128, Code 39 and ITF; keyboard scanners). Form image fields gain Take photo. New functions `Device()`, `Location()`, `UpdateLocation()`. Apps marked "Works offline (entry)" keep creates, changes and photos made without a connection in an encrypted outbox and send them in order exactly once when the connection returns. Tested in Chrome's phone emulation only; the real-device script is `docs/dev/phone-test-script.md`.
- **Print templates and PDF.** Dev mode > Print templates designs PDF documents from a record, a query or a formula (tables with totals and groups, repeated sections, approval history, photos, charts, Code 128 and QR codes, letterhead, "Page X of Y", Indian or international number formats, Hindi shaped correctly). Documents are generated on the server with the access of whoever prints. Apps get `Print`, `GeneratePdf`, `GenerateDocx` and a Print button; flows get "Generate a document"; scheduled reports can attach a PDF; bulk generation; six built-in templates; Word (.docx) templates without PDF conversion.
- **Dashboards.** Live in Dev and User mode: KPI tiles, OEE gauge, trends, bars, Pareto and tables computed in the database as the viewer, one request per refresh, cached briefly and refreshed live. Date ranges follow the environment's fiscal year, week start, time zone and shifts. A Production overview template with OEE, scrap, first-pass yield, downtime Pareto, MTTR and schedule adherence comes with labelled sample data. A new Visual UI component brings every chart kind to apps. Query v2 gains count distinct, date buckets, key-ordered grouping and top N with Others.

- **Dashboards: a visual tile editor.** In edit mode, **Add tile** and the pencil on a tile open it: table, kind, title, measures (sum / average / minimum / maximum, count with a condition, count of different values), simple calculations, grouping and date grouping, the date-range column, a fixed filter, sort, top N + Others, comparison, running totals, targets and chart options, with a live preview through the dashboard's own query path. Parts written through the API that the editor cannot edit (row calculations, nested conditions, calculations with several operators, series styling) are shown in words and kept.
- **Phones: phone-style inputs.** Dropdown, ComboBox and PersonPicker open as bottom sheets with search; DatePicker, DateRangePicker and TimePicker use the phone's own pickers; NumberInput picks the right keypad and has a +/- button; Dialog and Sheet become bottom sheets at phone width. DataTable shows cards below 600 px on touch (new **Phone card columns** property); Form gets a save bar that stays above the keyboard; Alert's dismiss button and the Visual's points and legend have 44 px touch areas; the Print button shows a busy state. Verified in Chrome's phone emulation only, not on real devices.
- **PDF charts match dashboards.** Charts in PDF documents are drawn by the dashboards' chart renderer (still sharp vectors, Hindi labels shaped correctly). The engine can draw all 15 chart kinds; print templates still offer bar, line, pie and gauge. On phones, Print offers Share and Download once the PDF is ready.
- **Studio: phone preview.** Preview shows phone and tablet apps in a device frame (phone 360x800, 390x844, 412x915; tablet 800x1280; rotate) with the touch rules and the phone layout applied. A new **Check on phone** button shows a QR code of the app's phone address (not in demo mode). Not yet clicked through in a browser.

- **Dashboards: layout, access and settings.** Tiles are moved and resized by dragging (mouse, touch, pen; step buttons and arrow keys as the keyboard alternative), with a 6-column tablet layout below 1024 px. **Who can see this** chooses the viewer roles. A tile can open an app and pass the clicked values (`Param`). Administrators get a Settings screen for fiscal year, week start, shifts, time zone, locale and currency.
- **Dashboards on the server** (schema version 12): dashboards travel in solutions and environment copies; **view tokens** for a TV or kiosk (one dashboard, shown as one fixed account under its own row and column security, revocable, optional expiry, rate-limited); **scheduled email snapshots** (a PDF computed for each recipient with their own access); MTBF helpers.
- **Phones: signature, offline tables, drafts.** New **Signature pad** UI component and Form `SignatureFields` (a PNG in an image column, saved offline like a photo; `Patch(..., {Col: Pad.FileToken})` works). Offline-entry apps can mark tables **Available offline** (2,000 rows by default, at most 10,000, optional filter), downloaded as the signed-in user and used offline for dropdowns, type-ahead, lookups and lists. Unsaved forms survive a reload as an encrypted draft. The Android Back gesture closes bottom sheets. Chrome phone emulation only.

- **Dashboards: screens for the wall, email and Home.** **Screens** creates and revokes TV / kiosk view tokens; a new token is shown once, with its warnings and a ready-made address that shows the dashboard full screen without sign-in and without cookies. **Email** schedules PDF snapshots (send now, history per recipient; each recipient gets their own access, people who cannot open the dashboard get nothing). Tiles can be pinned to **My dashboard** on My apps and the Dev home (per person, at most 24, computed with your own access).

- **Auto apps.** **Create app** on a table's page and the Tables page, **From a table** and **From the data model** on the Apps page, and Home's Start with data generate a working list / detail / edit app for desktop (1920x1080) or phone (360x800): search, sort and server paging, a form, Delete with confirmation (Undo when the table keeps deleted rows), related lists with + Add, the timeline, and a home screen for several tables. The dialog previews the screens and lists everything it cannot handle. The result is an ordinary app in the Studio.
- **Templates catalogue** (Dev mode > Templates; schema version 13): built-in UI component, screen, app and data model templates, bound to your tables in a binding step (type mismatches and name clashes explained, resolved by mapping or another name), installed after the solution plan screen in one transaction with a pre-install backup; nothing existing is overwritten. Copy for all kinds; Linked (versioned, upgrade plan with local changes kept or replaced) for apps and data models. Uninstall keeps tables with data unless an administrator confirms.
- **WhatsApp connector** (Meta WhatsApp Business Cloud API; schema version 13): send approved template messages and 24-hour-window replies from flows; nothing is sent to a number without a current opt-in (recorded with source, evidence and full history; STOP and START keywords, Hindi included). Signed webhook for delivery statuses and inbound messages, a message log for administrators, and WhatsApp as a notification channel. Tested against a mock built from Meta's documentation only: no real account has been used. Your business remains responsible for consent and template approval.
- **QR codes on iPhone.** QR codes are scanned with the camera on browsers without a built-in reader, such as iPhone Safari, using the bundled open-source decoder jsQR (Apache-2.0). Data Matrix still needs a browser with a built-in reader or a handheld scanner. Adds about 130 kB (47 kB gzip) to the app file.

- **Lookups work on tables of any size.** The Form's lookup field is a search box that asks the server as you type (a bottom sheet on touch, also for choice fields); DataTable, phone cards and Gallery templates (`ThisItem.Customer.Name`) show the record's name, fetched in batches as the viewer, never the id ("Not available" for records you cannot see). List search finds rows by a lookup's name; sorting by a lookup is shown as unavailable. Auto apps list lookup columns and use the new picker.

### Changed
- Notifications (toasts) appear at the bottom centre, no longer the bottom right where they covered the buttons of side panels and tiles.

### Fixed
- **Live updates stopped for everyone after a table, role or solution change.** The realtime hub re-checked subscriptions inside the finished transaction of the change, every check failed, and browsers lost their subscriptions (new tables then showed `Name isn't recognised` in the Studio until a reload). The re-check now runs outside the transaction, and only a real refusal ends a subscription. Present since 0.5.0.
- Backup: archives handed to queued restore or verify jobs are closed when the job cannot start (a file handle left to the garbage collector is an error on Node 24 and later and could stop the server).
- Chart legends that did not fit on one line dropped the remaining series (seen in a narrow PDF chart); they now wrap onto up to three lines.
- The record timeline's **Document** button listed print templates of other tables when the timeline's Table property was blank; it now offers only templates of the record's table.
- **Approvals and Dashboards no longer switch the shell to User mode when opened from the Dev menu.** Both pages are in both menus; they now stay in the mode you are in, and the mode switch still works from them.
- The flow email step sent a field the Email action refused.
- The service worker answered navigations to `/api/` addresses (PDF previews, attachments opened in a tab, the unsubscribe page) with the app shell.

- **Windows: backups made with pg_dump failed their own verification** ("pg_restore output ended inside a COPY block"), which also blocked solution upgrades, deploys and environment deletes that take a backup first. `pg_restore` on Windows ends lines with CR LF; the backup reader now accepts both line endings. Found by the first full test run on Windows.
- **A request body over the size limit could end in a connection error instead of the "too large" message** (always on a Windows server, occasionally on Linux). After the 413 answer the server now reads and discards the rest of the upload for at most 5 seconds or 64 MB before dropping the connection.
- Tests: four tests that only passed on Linux (a path built from a URL, the executable bit of an extracted file, single-word host names that Windows resolves slowly) now pass on Windows too.

### Security
- Request bodies are read only after the session and sign-in level are checked (no buffering of large bodies for anonymous clients); phone offline data of one person is locked as soon as another signs in on the same page, and kept answers are stored under keyed names instead of the request text; every sign-out path deletes the phone's offline data.
- Print: PNGs over 40 megapixels are left out, Word templates are checked as ZIPs before unpacking, PDF metadata can no longer inject XMP elements, made-up file tokens answer within 10 s instead of 90 s.
- Dashboards: snapshots run at most hourly and a recipient's "run now" at most once a minute; app install manifests answer 404 to people without access.
- WhatsApp: "+cc (0)..." numbers normalise to one number, every host of Meta's domains is refused for HTTP connections, nobody but the webhook can record consent as "inbound keyword"; live subscriptions whose re-check failed are checked again until it succeeds.
- Internal review of all Phase 2 surface: docs/internal/security-review-p2.md (12 findings, all fixed; internal only, no outside audit).

### Known gaps in this wave
- Dashboards: drill-through opens an app, not a chosen screen; the kiosk page does not cycle ranges or pages; a kiosk address holds its token (browser history of the screen); the tile editor cannot edit row calculations, nested conditions or series styling.
- Auto apps: lists cannot be sorted by a lookup column; generated colours do not follow a dark app theme.
- Templates: Linked mode is not offered for UI component and screen templates; uninstall, upgrade and Linked were tested through the API, not in a browser.
- WhatsApp: unverified against Meta's real API (list in `docs/dev/whatsapp.md`); no SMS.
- Phones: nothing is tested on real devices; Data Matrix needs a browser with a built-in reader; no cold-start offline (owner decision); no Android back-button handling for bottom sheets; the save bar moves when the offline strip appears.
- Print templates offer only four of the 15 chart kinds the PDF engine can draw.

## [0.6.0] - 2026-11-19

**Phase 1 "Automation" is done** (docs/plan/p1-spec.md, with the exit check results). In one paragraph: Appbuilder now
automates work. **Flows** start when a row changes, on a schedule, from a button in an app, on a signed web request or
when an approval is decided, and run durable steps (conditions, loops, data changes, delays, approvals, email,
notifications, HTTP calls, connector actions, child flows) that survive restarts, each step once; makers build them on a
**visual designer** by clicking, with templates, drafts, versions and test runs shown on the canvas. **Approvals** (single,
first to respond, everyone, quorum, sequential stages, amount thresholds, all edited visually) are answered from an inbox,
the bell or an email link, with delegation, reminders and escalation. **Connector actions** (an HTTP connector with
OpenAPI import and a strict outbound policy, an Email connector), **incoming webhooks**, **notification email** with
per-person channels and digests, and **scheduled reports** reach outside the app. A **recycle bin** keeps deleted rows
restorable for 30 days on new tables. Flows, approval policies and connection
references travel in **solutions** and deploy between environments with a plan screen that maps connections and people.
Package E closed the phase: nine gaps closed, the new surface reviewed for security with eight fixes
(docs/internal/security-review-p1.md), the documentation checked end to end, and the exit check run.

### Added
- **Phase close** (P1 package E):
  - **Approvals: a visual editor** for policies and the flow step (no JSON for anything in the maker guide): approver
    pickers (person, role, team, department, department head, manager N levels up, manager chain by levels or until a job
    title or role), stages (add, reorder, any / all / quorum, a condition builder, a due date per stage), threshold rules
    with a condition builder over the request's fields, answers (label, kind, comment required), the escalation target;
    "Advanced" shows the same definition as JSON. **Per-stage due dates** (`dueMinutes` on stages and rules; escalation
    re-armed per stage). The flow step may carry its own threshold rules and answers.
  - **Plan screen mapping** for Deploy and Import: choose the target connection for each connection the flows use (blocked
    until chosen), map or explicitly leave unmapped each person the approval policies name, allow service-account flows,
    turn new flows on.
  - **Run again from a completed step** of a finished run (top-level steps; earlier results reused; the designer says why
    not for steps inside containers).
  - **Admin console > Flows**: the kill switch with its state, the environment's run limit, every flow with its state,
    health and an on/off switch.
  - **Health email and heartbeat** (Admin console > Server logs): a daily summary and alerts at once (degraded server,
    failed backup, dead jobs, failing flows) to install administrators as "Server health" notifications, and an optional
    ping address for an outside uptime monitor while the server is healthy.
  - **SMTP with OAuth 2.0 (XOAUTH2)** for Microsoft 365 (client credentials or refresh token) and Google Workspace (refresh
    token), no new dependency; docs/admin/installation.md lists what works with each provider.
  - Dynamic content of the flow designer lists the approval step's `Status`, `Approvers`, `Comments` and the fields of the
    "When an approval is decided" trigger.
  - `scripts/exit-check/p1.mjs` (the Phase 1 exit check); `server/core/security-p1*.test.ts`.

- **Recycle bin for deleted rows** (decision D31; schema version 10; `docs/dev/recycle-bin.md`): tables in the default
  database can keep deleted rows for N days (new tables 30, existing tables off; Settings > Recycle bin). Deleted rows
  vanish from every query, report, export, rollup and timeline but can be restored: the **Undo** toast after a delete, the
  grid's **Deleted** view, the formulas `DeletedRows(Table)` and `Restore(row or batch)`. Each delete is one batch that also
  undoes its cascades, cleared (set blank) links, comments, tags, follows and shares; a restore checks the permission again,
  unique values and parents. Table events and flow triggers get an opt-in `restore` operation. The hourly job
  `data.recycle-purge` deletes expired batches for good; administrators can delete a batch or a table's whole bin for good
  (Empty now, with a typed confirmation). MySQL, external PostgreSQL databases, data files and Google Sheets still delete
  for good. Export environment data can include deleted rows (a tick).

### Fixed
- `RunFlow` from an app waits for the app's pending writes (a record just written with `Patch` exists when the flow reads it).
- A flow's notify step no longer sends a second notification or email after a crash or retry (idempotency key per
  recipient).

### Security
- The outbound address policy judges IPv6 addresses that carry an IPv4 address (IPv4-mapped in any notation, compatible,
  NAT64, 6to4) as that IPv4 address (`[::ffff:169.254.169.254]` was treated as public).
- A flow may only call a child flow that the saver, its owner and (at run time) its run-as identity may run.
- Approval policies are read-only in a locked production environment.
- OpenAPI import refuses documents whose YAML aliases expand to more than 500,000 values (memory exhaustion).
- On the server, regular expressions with nested repeats are refused, and one formula evaluation stops after 30 s or
  about 50 MB / 3 million rows built.
- Only the flow's current owner or an administrator resubmits its runs.
- Recycle bin: the details of a deletion batch (its row ids, who deleted) are given only to someone who sees one of its
  rows; row ids are trimmed to those.

### Added (packages A to D)
- **Approvals** (P1 package C, decision D29; exit check 3, and exit check 1 against the real service): requests from
  flows (the step "Start and wait for an approval" with `policy`, `fields`, `quorum`, `stages`, `dueMinutes`, `reminders`,
  `escalation`; outputs `Outcome`, `Status`, `Responses`, `Approvers`, `Comments`), from apps (`RequestApproval(...)`,
  `Approvals(record)`, `MyApprovals()`, the **Approvals panel** UI component) and the API (`/approvals`). Types: single,
  first to respond, everyone, quorum (N of M), sequential stages with conditions, amount threshold rules; approvers by
  person, role, team, department, department head, manager, manager chain (N levels, or until a job title or role);
  custom answers and "Need more info" (back to the requester, then resumes); self-approval prevention with fallback to the
  manager or administrators (and why, in the history); separation of duties; reusable **policies** (in solutions, people by
  email, flagged in the plan when missing). Delegation (out of office, at assignment, retroactive, back when it ends),
  reminders, escalation (manager, person, next stage, automatic approve/reject recorded as the system, expire), reassign,
  cancel/withdraw, expiry; comments and files on a request; full history and audit; decisions immutable. **Approvals
  page** in User mode (To approve with bulk answers, Sent by me, All for administrators, Delegations, Policies and
  settings), usable at phone width; bell notifications deep-link to it; **emails with Approve / Reject buttons** that open
  a confirmation page (signed, single-use, expiring links in the URL fragment; the answer is a POST with a session).
  Security: requester, people asked, delegates, administrators, and the new privilege "Approvals: view" for readers of
  the record; approvers who cannot read the record see only the declared details. The record timeline shows approvals.
  The flow trigger **When an approval is decided** (`approvalDecided`). Six system tables in the new group **Approvals**.
  Schema version 9. Docs: `docs/guide/maker/approvals.md`, `docs/admin/approvals.md`, `docs/dev/approvals.md`,
  `docs/help/quick-start-approver.md` (real page), `docs/reference/approvals.md` (generated); headless run and screenshots
  `scripts/docs-shots/approvals.mjs`.
- **Locked out: `appbuilder admin`** recovery commands on the server machine (`list`, `reset-password` with a one-time
  15-minute code, `reset-mfa`, `make-install-admin`), working with the server running or stopped, refusing without the
  workspace's secret key, audited with source `cli` and the OS user; `appbuilder setup-code` prints the setup code of a
  server installed as a service.
- **Error references**: every API answer carries `X-Request-Id` (errors also `error.requestId`); error messages in the app
  show "Reference: ..." with a copy button so support can find the request in the server log.
- The User mode menu and header work at phone width (menu drawer below the md breakpoint).

### Changed
- The setup screen says where the setup code is: the server window, or (installed as a service) the setup-code file with
  the command to read it (`/status` tells only which, never the path).

- **Flows: the visual designer** (P1 package B, decision D28; exit check 2, `scripts/exit-check/p1-designer.mjs`): flows are
  built on a canvas by clicking, no JSON. Trigger card on top, step cards joined by lines, containers (condition branches
  side by side, switch cases, for each, do until, scope) as collapsible regions, "+" between any two steps and inside
  containers, drag to move steps (also between containers; run after and references are checked), multi-select,
  copy/paste (also between flows), duplicate, undo/redo, zoom, pan, minimap, fit, search, full keyboard use, run-after
  settings drawn as labelled connectors, notes on steps, renames that update every formula. A step picker by group
  (Control, Data, Approvals, Notifications, Connectors with the connections you may use and their actions, Advanced),
  recently used first. Step panels with table and column pickers, typed values (lookups by search, choices, dates), the
  field mapping of Add / Update a row with the required columns first, a filter builder for List rows and Get a row, a
  condition builder, people and team pickers, durations, a rich text email body, inputs generated from an action's JSON
  Schema (nested, with a raw JSON view), a child flow's typed inputs, retry policy, time limit and run after. **Dynamic
  content** everywhere, typed: the trigger's row (lookups one step away, the row before a change), manual inputs, a pasted
  web request sample, earlier steps' outputs (by table, approval, action output schema, a pasted HTTP response),
  variables, loop items. Formula fields with suggestions and the server's check under each field (Studio wording,
  "Runs on server" / "Can't run" for table reads). Trigger panels: table changes (columns, condition builder, coalescing,
  own changes), schedules (presets, cron, the next five runs in the time zone), typed manual inputs, and **web requests:
  create, rotate and revoke the flow's webhook in the designer** (address and secret shown once, signing instructions).
  Flow settings: run as (service account for administrators, confirmed), concurrency, limits, variables, connection
  references, run permissions. **Drafts**: changes are saved as the flow's draft on the server (`ab_flows.draft`,
  `GET|PUT|DELETE /flows/:id/draft`) and **Publish** makes them the running version; a live problem list (click to go to
  the field); publishing and turning on wait for zero errors; version history with a visual diff and restore; read-only in
  locked production environments; the Studio's soft edit lock. **Test** with a sample trigger (an existing row, a recent
  real trigger, a form), simulated by default ("run for real" asks); runs shown on the canvas (status, duration, attempts,
  each step's inputs/outputs/error, loop iteration pager, live), any earlier run on the canvas, run again from the failed
  step. **New flow** gallery with ten working templates (`src/flows/templates/`, validated against the server validator)
  and an empty-state walkthrough; "Advanced: definition" JSON view with two-way sync. Entry points: **Automate** in the
  table designer, **Run a flow** (inserts `RunFlow(...)` with typed inputs) for behaviour properties in the Studio.
  `POST /flows/schedule-preview`; `GET /flows/catalog` says whether approvals are available. Docs: maker guide rewritten
  around the designer (screenshots: `scripts/docs-shots/flow-designer.mjs`), `docs/dev/flows.md` ("Designer").
- **Flows: the runtime** (P1 package A, decision D27; exit check 1): flow definitions with versions and restore
  (`ab_flows`, `ab_flow_versions`), triggers on table changes (from the outbox, with condition, changed columns, coalescing),
  schedules (cron or every N minutes, time zones), manual runs with typed inputs (`POST /flows/:id/run`, the new formula
  function `RunFlow(flow, inputs [, {Wait, Timeout, Result}])` in apps) and web requests (`services.flows.triggerWebhook`
  for package D's webhook route); steps condition, switch, for each (sequential or parallel), do until, scope (try/catch
  with run-after), set variable, compose, get/list/create/update/delete a row (as the run-as identity), approval (package C's
  service; stub interface here), delay, notify, email, connector action, HTTP request, child flow, terminate, respond, wait
  for a callback; retries per step, step and run time limits, cancel, resubmit from the start or the failed step, dry-run
  test runs; run-as owner / triggering user / service account (administrators, confirmed, audited); run permissions per flow
  or for every flow; kill switch; rate and fan-out limits; loop protection; failure notifications with a daily digest;
  retention; run history with per-step inputs and outputs (secrets redacted), live; the **Flow runs** system table is now a
  view over the run history; flows in solutions (connection mapping in the plan, new flows arrive turned off),
  environment copies (turned off) and restores (in-flight runs cancelled). **Dev mode > Flows** is live: list with health,
  JSON editor with validation, run now, test run, run history and detail, versions, permissions. Docs:
  `docs/dev/flows.md`, `docs/guide/maker/flows.md`, `docs/admin/flows.md`, `docs/reference/flows.md` (generated).
  Schema version 8 (shared with package D).
- **Connector actions, webhooks in, notification email, scheduled reports** (P1 package D, decision D26; exit check 4):
  - **Actions framework** (`services.actions`): actions with JSON Schema inputs and outputs, validation, input/output caps,
    per-connection rate limit, concurrency cap and circuit breaker (state on the Connections page), an idempotency store
    (24 h) for non-idempotent external actions, secrets redacted from every output and error, an activity log without
    payloads, and **"use" / "manage" grants** per connection (deny by default; attaching to flows and events needs "use").
  - **HTTP connector**: base URL, required host allow-list (no open proxy), auth none / API key (header or query) / basic /
    bearer / OAuth 2.0 client credentials (cached, refreshed on 401), built-in `request` action with templated paths;
    **custom actions** by form and **OpenAPI 3 import** (subset), carried in solutions without secrets. Own outbound
    client: every hop re-checked, resolved addresses pinned (DNS rebinding), private networks per-connection opt-in,
    https->http redirects refused, response size and time limits, TLS verification on.
  - **Email connector** `send`: to/cc/bcc, HTML (sanitised) and text, reply-to, attachments by id or generated, environment
    sending limits (`APPBUILDER_EMAIL_PER_HOUR`/`_PER_DAY`), the **mail suppression list** (Admin console > Email).
  - **`RunConnector`** in table after-events is real: connections are attached to the event by a maker with "use" and run as
    the event's identity.
  - **Webhooks in**: `POST /api/v1/hooks/:env/:flowId/:token` with an HMAC-SHA256 signature, timestamp tolerance, replay
    table, body cap, content types, rate limit, rotate/revoke, audit; hands the verified payload to the flow runtime.
  - **Notification delivery**: channels per kind and person (in the app, email right away or as an hourly/daily digest;
    WhatsApp shown as P2), quiet hours for email in the person's time zone, administrator defaults and locks, a
    per-recipient email limit, branded emails with deep links, a signed one-click unsubscribe link, and a delivery log
    ("why did I get this"). Settings > Notifications rebuilt.
  - **Scheduled reports** (Dev mode and User mode "Scheduled reports"): a table query built by clicking (columns, filters,
    sort, group and totals) or a formula, a schedule with time zone, recipients computed **each with their own access**
    (a service account only by administrators, warned and audited), inline HTML table + CSV attachment (formula injection
    guarded), skip-or-send when empty, unsubscribe, history; runs as `report.run` jobs.
  - Connections page: HTTP and Email connections, **Details** with Tables / Actions / Access / Activity, a "Test action"
    form generated from the schema. Reference page `docs/reference/connector-actions.md` generated by `npm run docs:gen`.
  - Schema version 8 (package D tables: actions, webhooks, reports per environment; suppressions, deliveries, digest queue).
- **Installers, release packages, updater, health and diagnostics** (P0 package L, decision D25; exit check 5):
  - **`npm run release`**: a versioned, self-contained, reproducible release folder and ZIP (web app, the server sources it
    imports run by Node's type stripping, production `node_modules`, installers, licence list, `release.json`/`VERSION`,
    `RELEASE-NOTES.md`, `SHA256SUMS`). **`npm run release:keygen`** / **`release:sign`**: Ed25519 signatures over
    `SHA256SUMS` with a vendor key kept outside the repository (docs/dev/release-process.md).
  - **Windows installer** `scripts/install/windows/install.ps1` (Windows PowerShell 5.1 and 7, elevated, idempotent, `-WhatIf`):
    its own Node.js, PostgreSQL 17 from the EDB binaries (or an existing one), role and database with a generated password
    sealed into `server.json` (the setup wizard skips its database step), the service **Appbuilder** (WinSW) under
    `NT SERVICE\Appbuilder` with restart on failure and rolled logs, tight folder ACLs, optional HTTPS with Caddy as a second
    service (LAN with its own CA, or a domain with Let's Encrypt), firewall only with `-OpenFirewall`, Start-menu entry,
    `appbuilder.cmd`, offline installs from a bundle (`-Offline`), `uninstall.ps1` (keeps data unless `-RemoveData` and a
    typed confirmation). **Not yet run on Windows**: parsed, linted for 5.1, unit-tested and dry-run on PowerShell 7.
  - **Linux installer** `scripts/install/linux/install.sh` (Ubuntu 22.04/24.04, Debian 12): Node.js tarball, PostgreSQL 17
    from PGDG (or the distribution's, or an existing one), a system user, a hardened systemd unit, Caddy from its apt
    repository, optional ufw rules, `--offline`, `--dry-run`, `uninstall.sh`. Run end to end on all three systems.
  - Every download is pinned with its checksum and licence in `scripts/install/manifest.txt`, https only;
    `scripts/install/prepare-offline.mjs` prepares offline bundles.
  - **Updater** `appbuilder update <zip|folder>`: checks checksums and the signature against the installed release's keys,
    refuses downgrades, an older schema or a too-old Node.js, stops the service, swaps the app folder (keeps
    `app.previous`), lets the server migrate (with its pre-migration backup), waits for the health check and rolls the app
    folder back by itself when it fails; the database restore is offered, not automatic. **Admin console > Updates**: the
    installed release, upload and check a release ZIP, release notes, the command that installs it, the update history.
  - **Health**: `GET /api/v1/health` (ok / starting / degraded only, for anyone) and the detailed health for install
    administrators (database, clock skew, environments, disk space, backup age, job queue, email, live sockets, versions).
  - **File log**: every log line also goes as JSON (with request, correlation and job ids) to `workspace/logs/appbuilder.log`,
    rotated by size; log level setting. **Admin console > Server logs** (health, filters, follow, download, level) and
    **Usage** (users, storage, tables and row counts, job statistics) replace their "Soon" pages.
  - **Diagnostics bundle** (Admin console > Server logs, or `appbuilder diagnostics`, also when the server is down): logs,
    versions, configuration, health, schema versions, recent failures and a release integrity check, with secrets removed.
  - Command-line tools of an installed server: `appbuilder version | health | update | verify-release | diagnostics |
    restore` (docs/admin/operations.md).

### Changed
- The first-run setup refuses requests that came through a reverse proxy (proxy headers), also from 127.0.0.1.
- The setup code can also be written to a file (`APPBUILDER_SETUP_CODE_FILE`, set by the installers) and is never written
  to the server's log file.
- docs/admin/installation.md is rewritten around the installers (sizing, LAN versus internet, HTTPS, offline); new
  docs/admin/operations.md and docs/dev/release-process.md; docs/admin/upgrades.md covers the updater and rolling back.

## [0.5.0] - 2026-11-18

**Phase 0 "Kernel" is done** (docs/plan/p0-spec.md, with the exit check results). In one paragraph: Appbuilder now runs on
**PostgreSQL** with one schema per **environment** (create, copy, switch, delete, lock production, deploy solutions between
them, upgrade in place); tables of a **million rows** are usable because filters, sorting, search, counts and totals run in
the database through **Query v2**, with security inside the same statement, and a formula that cannot run there is an
error, never a partial result; an **organisation model** (departments, managers, teams) drives row scopes, relationship
rules and record sharing; **table events, validation rules, formula columns, rollups, a job queue and schedules** run on
the server; a **realtime hub** refreshes screens live and carries notifications and presence; **identity basics** (email
relay, password reset, invitations, two-step verification, sessions, API keys); verified **backups and restores** with a
drill; a visual **data model designer**; and a **core data model** of system tables (people, comments, tasks, files,
reference data) with record timelines. Package M closed the phase: "controls" are now called **UI components** everywhere
a person reads, nine gaps were closed, the new surface was reviewed for security (docs/internal/security-review-p0.md),
and the documentation was checked end to end.

**PostgreSQL replaces MySQL/MariaDB as Appbuilder's database** (P0 package A, decision D14). There is no
migration from a MySQL installation: install PostgreSQL, run `scripts/setup-postgres.ps1` (or `.sh`) and start with an empty
database; carry apps and tables over as solution packages with data.

### Added
- **Phase close** (P0 package M, decision D24):
  - **Export environment data** (Admin console > Backups, environment administrators): every table of the environment as
    CSV files in one streamed ZIP with an attachments list and a manifest; after a recent sign-in, audited
    (docs/admin/backup-and-restore.md).
  - **Directory visibility** per environment (Admin console > Users): everyone, the same department, or administrators only
    see people in the Users table, person pickers, @mentions and the share dialog (docs/admin/users-and-roles.md).
  - **Your own schedules** on the Jobs page (create, edit, delete for job types that are safe to schedule), the
    **audit retention** switch on the Audit log page, and nightly **sign-in log** (180 days) and **email delivery log**
    (90 days) retention (docs/admin/jobs.md).
  - Solution **upgrade in place** carries unique pairs, reporting views (re-created), date dimensions (refilled), summary
    tables (new measures, schedule, refresh) and relationship changes; a first install fills date dimensions and schedules
    summaries; **environment copies** keep summary schedules and fill date dimensions (docs/guide/maker/solutions.md).
  - Demo mode enforces **delete behaviours** (restrict, cascade, set blank) in the browser, with the server's rules.
  - The portal grid's **lookup editor** searches the target table on the server as you type (server mode).
  - `scripts/exit-check/p0.mjs`: the Phase 0 exit check against a fresh server (a million rows through the API and in a
    headless browser, the delegation error, the restore drill, reset + TOTP + sessions with a fake SMTP relay, a second
    environment). `docs/guide/settings.md` (your settings), `docs/internal/security-review-p0.md`.
  - Tests: `scripts/naming.test.ts` (no "control" in user-facing text), `scripts/docs-links.test.ts` (no broken link or
    missing image in the docs), and the security, gap and upgrade suites listed in docs/dev/testing.md.
- **Core data model** (P0 package N, decision D23; docs/guide/maker/core-data-model.md, docs/admin/reference-data.md,
  docs/dev/core-data-model.md). Every environment now has **34 system tables**, listed under Dev mode > Tables >
  **System tables**: people and organisation (Users, Departments, Teams, Team members, Roles, Role assignments, as
  read-only views with a directory rule), collaboration (Activities, Comments, Mentions, Follows, Tags, Tag links, and
  Shares / Notifications views), files (Documents, Document versions, Attachment links; every existing attachment is
  linked at the upgrade), communication placeholders (Channels, Channel members, Messages, Message reactions), logging
  views (Audit entries, Sign-in log, Job runs, Event runs; Flow runs placeholder) and reference data (Currencies with
  INR as default, Units of measure, Countries, States with the Indian GST state codes, Calendars, Holidays, Number
  sequences, Settings with an April financial year). Collaboration rows follow the **regarding rule**: visible only
  to people who can read the record they are about, compiled into the SQL of every read (leak tests). Makers can add
  columns to most system tables; they cannot rename or delete them. New UI components **Record timeline**, **Person
  picker**, **Tag input** and **Activity list**; **Avatar** takes a `User`, **Avatar group** `Users`. User mode pages
  **Tasks** (list and board, quick add) and **Mentions**; @mentions notify (bell, click-through to the record with
  `?record=`, read by `Param("record")`). Formula functions `Comments`, `Activities`, `MyTasks`, `Mentions`, `Setting`,
  `Convert` (delegated), `NextNumber` (gap-free, in the save's transaction), `AddComment`, `AddActivity`, `Follow`,
  `Unfollow`, `Tag`, `Untag`, `RecordId`; lookup paths such as `createdBy.FullName` in formulas and Query v2 (`via`).
  A column default `=NextNumber("Invoices")` numbers new rows. The **common business model** (Accounts, Contacts,
  Addresses, Tax codes, Products, Price lists) is an optional solution package (`GET /api/v1/templates/business-model`).
  Routes `/collab/timeline`, `/collab/mentionable`, `/collab/follow`, `/collab/tags`, `/collab/my-tasks`,
  `/collab/mentions`; job `collab.notify`, nightly schedule "Collaboration orphan sweep". Solutions export custom columns
  of system tables, never the tables or the collaboration rows; environment copies with data include them. Demo mode
  has the same tables, components and pages. Schema version stays 7 (provisioning is idempotent and runs at every start).
- **Backup and restore** (P0 package J, decision D22; docs/admin/backup-and-restore.md, docs/admin/disaster-recovery.md,
  docs/dev/backup.md). **Admin console > Backups** (no longer "Soon"): install backups (accounts, settings, every
  environment, attachments, data files) and environment backups, each one archive (`.abbak`, tar) from **one consistent
  database snapshot** (pg_dump with an exported snapshot, or the **built-in exporter** when pg_dump is missing or older than
  the server), with a manifest of row counts and sha256 checksums, **verified after every backup**. Optional **passphrase
  encryption** (AES-256-GCM, scrypt) and an explicit "include the encryption key" option. **Schedules** (nightly install
  backup at 02:00, per-environment schedules, misfire run once) as jobs; **grandfather-father-son retention** (7 daily,
  4 weekly, 3 monthly; automatic backups 30 days; pinning); **off-site folder** copy with verification. **Restore** an
  environment as a new environment (default) or in place (typed confirmation, safety backup, environment "Restoring",
  one transaction: a failure keeps the old data), or **selected tables** (as new tables or replacing rows, with a plan);
  **browse** a table of a backup read-only; older backups are migrated, newer ones refused. **Automatic backups before**
  solution upgrades in place, environment deletes, in-place restores and server schema upgrades (the amber "No backup was
  taken" warnings are gone; a failed backup stops the change unless the administrator proceeds). **Restore test** job,
  backup **health** on every Admin console page and in environment details, notifications when a backup fails or is older
  than 36 hours. **Download** (recent sign-in) and **upload** of archives; every action in the install audit log.
  **Install restore** from the command line: `node server/main.ts restore <archive>` (checks, one transaction, key
  handling, migration). **Restore drill** `scripts/drill/restore-drill.mjs` (seed, backup, wipe, restore, compare).
  Schema version 7 adds `ab.backups` and `ab.backup_ops`. New dependency: `pg-copy-streams` (MIT).
- **Data model designer** (P0 package K, decision D21; docs/guide/maker/data-model.md, docs/dev/data-model.md): Dev mode >
  Data model is live. A diagram of every table (type icons; badges for required, unique, indexed, lookup, formula,
  rollup) with crow's-foot relationship lines, pan, zoom, minimap, layered auto-layout, coloured areas, search, filter by
  solution, system tables shown read-only on request, shared or personal positions. Edits go into a **draft** per user
  and environment with undo and redo: tables, columns (inline rename, retype, flags, delete), and relationships drawn by
  dragging one table onto another (one-to-many, one-to-one, many-to-many with a junction table and unique pair,
  hierarchy with loop prevention, required parent). **Review changes** shows the plan (row counts, destructive items in
  red, data conversion pre-checks, index builds) and applies it in one transaction after the pre-change backup.
  **Delete behaviours** (restrict, cascade, set blank) are enforced by the server; cascades respect the deleting user's
  permissions and write events and outbox rows. **Patterns**: master-detail, reference data, hierarchy, many-to-many,
  party model, status workflow, document numbering, audit trail, approval-ready; star schema and snowflake (reporting
  views secured through the source table), date dimension (fiscal year, India April-March by default), summary table
  refreshed by a job; manufacturing, CRM and inventory starters. **Model checks** panel. **Import** from Excel/CSV
  (inferred keys and relationships), from a PostgreSQL/MySQL connection (tables and foreign keys, link or copy) and from
  DBML; **export** PNG, SVG, DBML and a solution "data model" package. Relationships travel in solutions and environment
  copies. Schema version 7: `ab_relationships`, `ab_model_layouts`, `ab_model_drafts`; existing lookups become explicit
  relationships.
- **Identity basics** (P0 package I, decision D20; docs/admin/sign-in-and-identity.md, docs/guide/signing-in.md,
  docs/dev/auth.md). **Two-step verification**: authenticator apps (TOTP, RFC 6238; QR code and key), 10 single-use
  recovery codes, email codes, "remember this device for 30 days", a code used once only. **Policy** in Admin console >
  Sign-in and security: two-step verification required for administrators or everyone (install-wide or per environment)
  with a grace period and forced setup at sign-in; session idle timeout and absolute lifetime; password minimum length,
  a common-password list, history and maximum age; the lockout values; the **sign-in log**. **Email** (Admin console >
  Email): SMTP relay (STARTTLS / TLS, AUTH PLAIN / LOGIN, password encrypted), test email, delivery log, queued delivery
  with retries; branded system emails. **Forgot password** (emailed link, 15 minutes; or an administrator's one-time reset
  code without email), **invitations** (7-day link instead of a temporary password; resend, revoke), **email change**
  confirmed by the new address. **Sessions**: list and end your own (Settings > Profile, "Sign out everywhere else");
  administrators see and end anyone's; new-device sign-in email; session rotation on password and two-step changes.
  **Re-authentication** before changing the sign-in email, turning two-step verification off, new recovery codes,
  creating API keys and deleting an environment. **Service accounts and API keys** (Admin console > Service accounts):
  `Authorization: Bearer` on the Data API, keys shown once and hashed, expiry, IP allow-list, rate limit, last use.
  Schema version 7 (tables `ab.user_mfa`, `auth_tokens`, `trusted_devices`, `password_history`, `signin_log`, `mail_log`,
  `api_keys`). New dependency: `qrcode-generator` (MIT).
- **Live updates, presence and in-app notifications** (P0 package H, decision D19). One WebSocket per tab
  (`/api/v1/live`, docs/dev/live.md): data tables, galleries, charts and labels refresh within a moment when someone else
  changes a table (from package G's outbox, after the commit), without flicker and keeping the scroll position; forms keep
  unsaved edits and show "This record was changed by <name>" with Reload / Keep mine; running apps show who else has them open
  and "Update available" when a maker saves a newer version. Without the connection pages refresh every 30 seconds and say
  "Live updates paused". Demo mode keeps the tabs of one browser in sync (BroadcastChannel).
- **Optimistic concurrency on row updates**: `PATCH /api/v1/data/:table/rows/:id` accepts `ifModifiedOn`; a stale save answers 409
  with the current row and who changed it. Forms send it.
- **Notifications**: the bell in the top bar and the Studio (unread badge, list, mark read, mark all read, delete, click-through
  to the deep link), toasts while Appbuilder is in front, desktop notifications in the background; Settings > Notifications is
  real (per kind, desktop notifications, do-not-disturb hours, hide my presence). API `/api/v1/notifications` (list, unread
  count, read, read-all, delete, settings, send); server service `services.notifications.notify()` (used by table events'
  NotifyUser). New formula function `SendNotification(user, title [, body] [, link])` (rate-limited).
- **Studio soft lock**: the first maker edits an app, others open it read-only and see the saves as they happen; "Take over
  editing"; avatars of the other makers. Administration > Users shows who is online.
- New tables `ab.notifications` and `ab.user_settings`; new dependency `ws` (MIT) for the WebSocket server.
- **Table events, validation rules, formula columns and rollups** (P0 package G, decision D18): new table designer tabs.
  Validation rules (a formula that must be true, a message, a field) refuse a save from every app, the grid, imports and the
  API. Before-save events change the record (`SetField`) or refuse it (`Reject`) and can read other tables; after-save events
  change rows (`Patch`, `Collect`, `Remove`), `NotifyUser`, `EnqueueJob` in the background, retried on failure. Formula columns
  are calculated on save and stored (recalculated in the background when the formula changes; also in demo mode); rollups
  count or total related rows and stay correct under concurrent saves. Formula check by the server as you type, **Test run**
  against a sample row, and a run log of every run, refusal and failure.
- **Job queue and schedules**: durable background jobs in PostgreSQL with retries, dead letter, crash recovery and a worker
  inside the server; built-in schedules for outbox / run log / job retention, audit retention (off by default), attachment
  orphan sweep and rollup reconcile. Admin console > **Jobs** (queue health, failed and dead jobs with retry and cancel,
  schedules with on/off, retention days and Run now) and **Events run log**. About 800-950 trivial jobs per second.
- Table logic travels with solutions: validation rules, events, formula columns and rollups (and table sharing settings)
  are exported with their tables, listed as new / changed / removed in the upgrade plan, and copied with environments.
  Events that run as the system need an administrator's explicit confirmation on import and are audited.
- Schema version **6** (organisation, notifications, record sharing, events and jobs): a version 5 server refuses the upgraded
  database.
- **Outbox**: every data change is recorded in the same transaction, in commit order per table, for the realtime hub and
  flows (`services.kernel.outbox.subscribe`).
- **Organisation** (P0 package F, decision D17): departments (a tree with stable codes), a manager, job title, phone and
  employee code per user, and teams (members; every environment or one). Admin console > **Departments** (tree editor),
  **Teams**, **Org chart**, and Users shows and edits the new fields. **Import users from CSV** with department and manager
  columns: preview with the problems per line, all or nothing, passwords never imported; new users get a one-time temporary
  password shown once and must change it. `User()` gains `Department`, `DepartmentCode`, `Manager`, `JobTitle` and `Teams`.
- **New row scopes** for roles: Team (rows of the user's teams and team-owned rows), Direct reports, Reporting line,
  Department and Department tree, each with a plain-language description in the role editor.
- **Relationship rules**: row rules can follow lookup columns ("Section > Teacher is the current user") and look at related rows
  in a junction table ("an Enrolment exists for this student in a section I teach"), with new values such as the current
  user's department, teams, manager or reports, or a team / department by code. The role editor has a rule builder.
- **Record sharing**: per table (table designer > Settings) owners and roles with the new **Share** privilege share single
  rows with people or teams for reading or for reading and changing: the table grid's row menu > *Share...*, and in formulas
  `Share(record, userOrTeam, access)`, `Unshare(record, userOrTeam)`, `SharedWith(record)`. Tables can also let rows be
  owned by teams.
- **Who can see this row?** (Security roles, and the grid's row menu): every user with read, update or delete access to one
  row and why. **Test as user** now says why each table's rows are visible.
- All of it runs inside the one SQL statement of every query, count, aggregate, search, export and write check (1,000,000 rows:
  17-85 ms per scope, under 0.5 s for a junction rule; `scripts/bench/orgsec-bench.mjs`), and identically in demo mode (one shared
  test corpus for both).
- **Large tables work** (P0 package D, decision D16): with the local server, formulas over tables run in the database. Filter,
  Search, Sort, LookUp, FirstN/LastN, CountRows/CountIf, Sum/Average/Min/Max, Distinct and GroupBy totals become one query
  (`POST /api/v1/query`, Data API v2) with the user's roles, row filters and column access applied in the same statement: exact
  counts, keyset paging, aggregates. Calculations on number columns are translated too (`Filter(Orders, Qty * Price > 1000)`,
  `Sum(Orders, Qty * Price)`, Round/RoundUp/RoundDown/Abs, `Year(Date) = 2026`), with the engine's results (0 mismatches over 870
  formulas on PostgreSQL). A 1,000,000-row table: first page 42 ms, indexed filters 5-190 ms, deep sorted pages 7 ms, exact count
  51 ms, grouped totals 0.4-0.5 s (`docs/dev/query-v2.md` section 15).
- **Data table, gallery, dropdown and combo box over large tables**: rows load page by page as you scroll (only the rows in view are
  drawn), the exact row count is shown, header sort and the search box run on the server, a dropdown over a large table searches as
  you type. The portal's table grid pages, sorts and searches on the server and shows the exact count.
- **Studio delegation diagnostics**: the formula bar says **Runs on server**, **Runs in browser** or **Can't run** for table
  formulas (hover for the steps), underlines the part that can't run, and the error list and data warnings list them.
- **Indexed columns**: a column setting **Indexed** (server mode) keeps filtering, sorting (both directions) and text search by that
  column fast; lookup and unique columns and the natural row order are always indexed. Text search on indexed columns uses a
  trigram index when PostgreSQL's `pg_trgm` extension is available.
- `scripts/bench/seed-million.mjs` (loads 1,000,000 rows and measures the queries) and `scripts/bench/browser-check.mjs` (drives the
  app in a headless browser at that size).
- **Environments** (P0 package E): an install now has the built-in Default plus up to four more environments (production,
  sandbox, developer; `APPBUILDER_MAX_ENVIRONMENTS` changes the limit), each its own database schema `env_<id>` and folder
  `workspace/env/<id>/` with its own tables, rows, apps, roles, connections, solutions, data files, attachments and audit log.
  Admin console > Environments: create (empty, with the sample, or copied from another environment, schema only or with data,
  copied inside the database in one transaction; connections to other systems lose their secrets), details with sizes, rename,
  change type, lock, delete after typing the name, and an Access tab. Every request names its environment
  (`X-Appbuilder-Environment`, or `?env=` on links) and the server checks it against the user's access; every cache is per
  environment. The top bar shows the environment's name and a type badge (production red, sandbox amber, developer blue) and a
  line in that colour, also in the Studio; switching reloads the workspace, closes the other environment's app tabs and is
  remembered on your account. A failing environment migration marks only that environment failed.
- **Install administrators and environment roles**: account and install management (environments, users, passwords, the
  install-level audit log `ab.audit`) needs an install administrator; roles and everything inside an environment its
  administrators. Admin console > Audit log has an *Install* tab for install administrators.
- **Solutions between environments**: solution packages carry stable ids. Importing one where it exists is an **in-place
  upgrade** after a plan (new, changed and removed apps, tables, columns and roles; dropped tables and columns in red) that you
  confirm, in one transaction. **Deploy to...** on a solution page exports and imports into another environment in one step.
  A pre-upgrade backup hook is in place (it takes no backup yet and says so). *Import as a copy* keeps the old behaviour.
- **Locked production environments**: apps, tables, columns, roles, solutions and data files change only by importing or
  deploying a solution (server-enforced, 403); the Studio opens apps there read-only with a banner.
- PostgreSQL system store (driver `pg`): schema `ab` for install-wide objects (settings, users, sessions, the environment
  registry, a licence placeholder) and one schema per environment (`env_default`) for roles, privileges, tables, apps,
  connections, solutions, data files, attachments, audit and the data tables. Every statement uses fully qualified names; pooled
  connections start with `search_path=pg_catalog,pg_temp` and `TimeZone=UTC`, so nothing can leak between requests. Schema
  version 4.
- The request's environment is resolved per request (`server/core/env-context.ts`, today always `default`); the security cache and
  connector instances are kept per environment. Ready for creating and switching environments (package E).
- Units of work with transactional DDL: creating, changing and deleting tables and columns, linking tables, and importing apps and
  solutions run in one transaction on the default database, so a failure leaves no table, column, row, definition, privilege or
  audit entry behind.
- `postgres` connector: the default database, and external PostgreSQL databases (with a `schema` setting; the system schemas are
  refused). Condition pushdown with exact parity to the in-memory reference (162-case parity test, case-insensitive comparison with
  the ICU root collation, code point ordering, no LIKE escaping), transactions, system columns, linking with consent.
- `scripts/setup-postgres.ps1` (Windows) and `scripts/setup-postgres.sh` (Linux): find PostgreSQL (or print the `winget install
  --id PostgreSQL.PostgreSQL.17 -e --interactive` command), ask for passwords without echoing them, create the role `appbuilder`
  and a UTF8 database owned by it; the new password reaches the server only as a SCRAM-SHA-256 verifier.
- Setup wizard: PostgreSQL defaults (port 5432), a *Use SSL* box, and clear messages for a wrong password, a missing database, a
  missing `pg_hba.conf` entry, a role that may not create schemas (with the command to fix it) and a database that is not UTF8.
- The Connections page offers PostgreSQL connections (host, port, database, user, password, schema, SSL).
- Formula-to-query translator (Query v2, P0 package B): `analyze()` in `src/fx/query` turns formulas over data-source tables
  (`Filter`, `Search`, `Sort`, `SortByColumns`, `LookUp`, `First`/`Last`/`FirstN`/`LastN`, `CountRows`, `CountIf`, `Sum`/`Average`/
  `Min`/`Max`, `Distinct`, `GroupBy` with totals, `ShowColumns`/`DropColumns`, `in`/`exactin`, `StartsWith`/`EndsWith`, `IsBlank`,
  date comparisons with `Today()`/`Now()`/`DateAdd`) into query plans, with a residual formula for the browser part, structured
  diagnostics for what can't run on the server and `explain()` text for the Studio. Plan types in `src/platform/query.ts`, semantics
  in `docs/dev/query-v2.md`, a reference executor, keyset cursor helpers and a parity test of about 650 generated formulas. Not used
  by the data layer yet (package D).
- `createEngine()` (`fx.createEngine`): independent formula engine instances, each with its own user-defined functions and named
  formulas.
- Top bar laid out like Power Platform: chat button, **environment picker** and your **avatar** last. The avatar (initials, colour derived from your account or chosen in Settings) shows your name and email on hover; its menu has Profile settings, Settings, Change password and Sign out, and in demo mode the switch-user list (which moved here from the old user menu).
- Environments as a real API in both backends (`platform.environments.list/current/select`, `GET /api/v1/environments`, also in `GET /workspace`): today one built-in **Default** environment of type Production. The picker remembers your choice per user; administrators get **Manage environments**. Creating environments arrives with P0.
- **Settings** page (`#settings`, `#settings-<section>`), opened from your name and gear at the bottom of the left menu (Dev and User mode) or from the avatar menu (also in the Studio); Back, x or Esc return to where you were. Real today: display name, avatar colour, change password, sign out; theme light / dark / system; reduce motion; mode at start; chat dock side and whether it reopens; Studio default app size, snap and grid size; export my settings and clear local data; links to the Admin console; About with version, server and database versions (administrators) and the third-party notices. Shown as **Soon** with their phase: sessions and two-step verification (P0), passkeys and single sign-on (P3.5), date / number / week / time-zone formats and interface language (not scheduled; formulas use fixed formats today), density, notifications (P1), chat messages (P3) and AI data sharing (P4).
- One per-user preferences store in the browser (`src/platform/preferences.ts`, `appbuilder-prefs:<userId>`), shaped so it can move to the server later.
- **Admin console** (`#admin`, administrators) is now a real page with its own navigation: **Environments** (the Default environment with its database and schema version; New environment disabled until P0; the planned types), **Users** (the primary place for user management, with roles, active / disabled, no password, must change password and last sign-in), **Licences** (current state "Development build, no licence file", the planned passes with preview counts derived from roles, assigning passes and uploading a licence file marked Soon, P3), **Audit log** (filter by action, user and date, 50 per page) and Backups, Server logs and Usage as Soon (P0).
- `PATCH /api/v1/auth/profile`: anyone signed in can change their own display name (and nothing else); audited as `user.profile`.
- `GET /api/v1/audit` (administrators): one page of the audit log, newest first, with filters.
- `GET /status` gives a signed-in administrator the server version, Node.js version, database version and schema version.
- Application shell with two modes, switched in the top bar: **Dev mode** (the maker portal and the Studio) and **User mode** (a "My apps" launcher with search and recently opened apps). People without the Maker or Administrator role see only User mode; makers return to the mode they used last (remembered per user in the browser). New routes: `#u`, `#u-<app id>`, `#soon-<key>`, `#chat`.
- App tabs in User mode: apps open as tabs under the top bar (the launcher is the fixed first tab), several at once; each keeps its state while you switch tabs or modes; close with the x, middle-click or Delete; open tabs come back after a reload. Every tile and tab has **Open in new window**; in Dev mode **Run** offers "Open in a tab" and "Open in new window".
- Chat dock: a chat button in the top bar and the Studio opens a resizable panel on the right (open state and width remembered) that can pop out into its own window and be brought back (BroadcastChannel, with a storage-event fallback). Chat itself is not built yet; the panel shows what it will do.
- Planned modules as menu entries with a **Soon** badge and a placeholder page each (module, what it will do, planned phase): Data model, Flows, Approvals, Dashboards, Agents, Sites and Templates in Dev mode; Tasks, Notes, Chat, Files, Documents / Slides / Sheets, Mail, Approvals and Dashboards in User mode. One registry, `src/portal/modules.ts`.
- Phone and tablet app sizes: Desktop 1920x1080 and 2560x1440, Phone 360x800 (default), 390x844 and 412x915, Tablet 800x1280 and 1280x800, and a custom size that can now be portrait, in the New app dialog, Start with data and App settings. Start with data lays a phone app out as a list screen and a form screen. Portrait apps run at their design size, centred, in landscape windows and app tabs; the Studio viewport menu has the phone and tablet sizes.
- Documentation index in `docs/README.md`, and a decision log in `docs/decisions.md` that explains why the main choices were made.
- Third-party notices in `THIRD-PARTY-NOTICES.md`, listing every production package with its license, and `npm run notices` to regenerate it.
- README links to the documentation, and run instructions that match the current start-up steps (PostgreSQL and the first-run setup screen).

### Changed
- **"Controls" are now "UI components"** in the Studio (Insert pane, search, properties, formula bar), the portal, settings,
  error messages, the formula reference and all documentation. The UI components reference moved to
  `docs/reference/ui-components.md` (the old page is a redirect). Code names (`src/controls`, `ControlType`), stored app
  definitions and the formula language did not change; `Reset`, `Select` and `SetFocus` show `component` as their argument.
- PostgreSQL connections start with `jit=off`: row-security predicates over many tables made JIT compilation take
  seconds per statement (core data model, P0 package N). Kept after measuring at package M: the collaboration predicate
  takes 42 s with JIT and 0.5 s without, aggregates are neutral (docs/dev/schema.md).
- Version 0.5.0 (was 0.5.0-dev).
- `createdBy` and `owner` of every table are lookups to the Users system table (were plain text ids).
- Deleting a row now applies the delete behaviour of every relationship pointing at its table. Lookups that existed
  before version 7: a **required** lookup now refuses the parent's delete while children exist (409); an **optional**
  lookup is cleared on the children (before, children kept the id of a row that no longer existed). Change either in
  the data model designer.
- Settings > Profile: Active sessions, two-step verification, email change and sign-in history are real (were "Soon");
  passkeys and single sign-on stay "Soon" (P3.5). Admin console > Users: invitations, reset codes, sessions and two-step
  reset in the row menu; service accounts are listed on their own page.
- Passwords on a list of common passwords are refused (`server/core/identity/common-passwords.txt`, from SecLists, MIT).
- Deleting an environment needs a recent password or authenticator code (`reauth_required`).
- Every data write on the default database is one transaction with its outbox row; updates of tables with formula columns
  or before-events lock the row. Marking a column **Indexed** builds its indexes in the background (no write lock).
- Forms show a refusal from the server (validation rule, event) under the field it names; calculated columns are read-only in
  forms and the grid, and rollup totals refresh shortly after a save.
- Query v2 no longer wraps the row filter in `COALESCE`, so owner, lookup and id indexes serve security predicates (own scope on
  1,000,000 rows: 285 ms -> 17 ms).
- `rowFilter` entries may now be rule nodes (`exists`, `any`) besides column conditions; scopes accept the organisation values.
- **Formulas that can't be turned into a database query are errors on large tables** (more than 2,000 rows you can see), never a
  result computed from part of the rows. The message names the part and suggests a rewrite. Smaller tables are loaded whole and
  evaluated in the browser as before, with a Studio warning. Demo mode is unchanged.
- The 5,000-row limit is gone for PostgreSQL tables (and the "Only the first 5,000 rows are loaded" banner with it). Tables on MySQL,
  data file and Google Sheets connections are queried over their first 5,000 rows, with a warning.
- Actions that read large tables (`Set(n, CountRows(Filter(...)))`) wait for the server; each `;` step sees the saved writes of the
  steps before it.
- Schema version 5. Opening a version 4 database converts it without losing anything: administrators become install
  administrators, everybody keeps access to Default, and `workspace/attachments` and `workspace/files` move into
  `workspace/env/default/`. Attachment URLs carry `?env=<environment>`.
- Creating, deleting, renaming and disabling accounts and setting other people's passwords need an install administrator;
  environment administrators assign roles.
- Importing a solution that already exists (same id) upgrades it after a confirmed plan instead of creating copies
  (`POST /solutions/import` answers 409 without `confirm`); `asCopy: true` and packages exported before 0.5 still create copies.
- **Database: PostgreSQL 15+ instead of MySQL/MariaDB** for the system tables and the default connection. MySQL/MariaDB stays as
  a connector for existing customer databases only. `APPBUILDER_DB_PORT` defaults to 5432; `GET /status` and `/workspace` report
  `storage.kind: 'postgres'`. Text conditions now compare exactly after lowercasing (no accent or trailing-space folding as with
  `utf8mb4_unicode_ci`) and sort by code point, which agrees with the browser's row filters.
- Backups use `pg_dump` / `pg_restore` (`docs/admin/backup-and-restore.md`, with the drill we ran).
- Only a PostgreSQL connection can be the default store for new tables.
- Tests: `APPBUILDER_TEST_DB` is now a PostgreSQL URL; the MySQL connector's tests use `APPBUILDER_TEST_MYSQL`. CI runs a
  PostgreSQL 16 and a MariaDB 10.11 service.
- The formula engine is shared with the server: `src/fx` uses explicit `.ts` imports and erasable TypeScript only and loads under
  plain Node (`server/core/fx.test.ts`); a test enforces that it imports nothing from React, the runtime, Studio, portal, controls or
  platform code. Architecture rule 3 and decision D13 describe the new boundary.
- User-defined functions belong to each app's engine instance instead of one shared active set that every app re-registered before
  evaluating; the Studio's formula bar, Advanced properties and checks use the app's own engine.
- User management moved from Security roles to **Admin console > Users**; Security roles keeps the roles and links to Users and back. The Environments menu entry is gone: environments live in the Admin console and the top-bar picker.
- The theme can follow the operating system; the quick toggle in the top bar and the Studio stays.
- The first administrator's sign-in through the setup wizard now counts as their last sign-in.
- Apps may be portrait: the server (`POST /api/v1/apps`, package import) and the demo platform no longer refuse a width smaller than the height (sizes stay 200 to 16000 px per side); the client asks for at least 320 px per side. Loading an app no longer swaps a portrait size into landscape.
- Each app tab has its own runtime store (`createAppStore`), evaluator cache and user-defined functions; the Studio, Preview and the standalone player use the shared store as before.
- The Studio and the portal need less width (900 px) so they fit next to the chat panel.
- Build specifications moved to `docs/internal/specs`. They are kept for history and are no longer maintained.

### Security
- Phase 0 security review (package M, docs/internal/security-review-p0.md): only job types marked safe can be scheduled by
  environment administrators, and schedules of install-wide work (backups, mail, install log retention) need an install
  administrator (before, any environment administrator could schedule any job); uploaded workbooks are checked for zip
  bombs before they are unpacked; database connections and the SMTP relay refuse link-local, cloud-metadata, unspecified
  and multicast addresses (`APPBUILDER_OUTBOUND_PRIVATE=deny` refuses private networks too); `GET /api/v1/org` lists only
  people with access to the environment (it listed every active user of the install); crafted backup archives cannot make
  the restore read huge members into memory; hostile DBML text is bounded. Formula columns and rollups are documented as
  computed by the system, with a warning in their editors.
- Realtime connection (package H): the upgrade passes the HTTP Host/Origin checks and requires this Origin (cross-site
  WebSocket hijacking), then the session cookie; forced-password-change sessions cannot connect. Table messages carry no
  values, no hidden column names, and row ids only for people who may read every row; sockets close at once on sign-out,
  password change, disabling or deletion of the account; limits per user, per server, per message and per second; slow
  clients are disconnected instead of buffered.
- Table events read and write with the permissions of the person who saved; only administrators can make one run as the
  system, and that is audited. Formulas of events are checked when saved (no UI functions on the server) and run with a time
  budget, row and query limits, a loop guard and a depth cap. Threat model in `docs/dev/events-and-jobs.md`.
- A lookup value can only point at a row the user can read; an unreadable row is refused like a missing one (before, a user
  could link to, and probe for, rows of tables they could not read).
- First-run setup accepts only requests from this computer (checked on the connection, not on headers) and needs a one-time setup code printed in the server window; once an administrator exists the setup stays closed, also while the database is unreachable.
- `GET /status` no longer shows the database host, port and name to anyone but a signed-in administrator.
- The page's Content-Security-Policy no longer allows inline script (hashes of the app's own inline script instead).
- Linking a table that is already linked is refused, also through a second connection to the same database. Deleting a table keeps the table in the database unless you tick "Also delete the table in the database", which is offered only for tables Appbuilder created; linked tables are never dropped and removing their columns only unmaps them.
- CSV exports prefix cells that a spreadsheet would run as formulas with `'`.
- Passwords set by an administrator must be changed at the next sign-in (schema version 3). Sign-in also has a per-account backoff.
- The session cookie can be marked `Secure` (`APPBUILDER_SECURE_COOKIE=1`, or `APPBUILDER_TRUST_PROXY=1` behind an HTTPS proxy).
- The audit log records the row ids of bulk deletes, before/after of role and user changes, and schema migrations; failed audit writes are reported as errors.

### Fixed
- A grouped Query v2 aggregate over Comments or Activities by a non-administrator failed ("table does not exist").
- Two refreshes of one summary table at the same time could insert its groups twice.
- Reading a reporting view tried to build an index on the view in the background, logging an error each time.
- Re-importing an unchanged solution listed reporting tables as changed (definitions read back from the database have
  their keys in another order).
- The data model designer's demo-mode plan said delete behaviours were enforced "by the server only".
- The Studio in a locked production environment let you make local edits that were never saved: the canvas, properties and
  formula bar are now truly read-only there (and while another maker holds the edit lock).
- Deleting a table removed its attachment files before the change was saved; a failed delete lost the files. Files are now
  deleted by a background job after the change commits (P0 package G).
- A user-defined function in App.Formulas was reported as "already a built-in function" when another app that defines a function with the same name had been evaluated first in the same page.
- The consent to add system columns when linking a table is now sent; MySQL tables get the missing columns (including `id`, filled with UUIDs). Without consent such tables link read-only and can be read (before, a table with `id` but without the other system columns failed on every query).
- The Default database connection can no longer be edited in the portal (edits silently reverted at the next start).
- Imported rows (CSV, new table from CSV, packages with data) belong to the importing user; administrators can give rows without owner an owner.
- The server retries an unreachable database in the background at start instead of staying unconfigured, and refuses to use a database upgraded by a newer version.

### Removed
- MySQL/MariaDB as the system store, `scripts/setup-mysql.ps1`, the MySQL-era schema upgrades (versions 2 and 3) and their tests.

## [0.3.0] - 2026-11-17

Phase 3: a shared database, connections to other data sources, and access rules enforced on the server.

### Added
- MySQL or MariaDB is the default store for app data. The first run opens a setup screen that asks for the database connection. On Windows, `scripts/setup-mysql.ps1` creates the database and its own user.
- Data connectors: MySQL or MariaDB, data files (CSV, XLSX and JSON), and Google Sheets. The Google Sheets connector is still in progress.
- Attachments: files can be attached to records.
- A versioned data API (v1) and a metadata API on the local server, which the portal and Studio use to manage tables, connections, apps, packages and solutions.
- Known gap: MySQL 8.4 has not yet been verified. MariaDB 10.11 has been tested.

### Changed
- Table data now lives in the database instead of CSV files in the workspace folder. A data file you pick is copied into the workspace folder and the original is never changed.
- The local server (`npm start`) serves the app and its API on `127.0.0.1`.

### Security
- Sign-in is checked on the server. Passwords are stored with scrypt, and the session cookie is HttpOnly.
- The server checks access on every request: role permissions, row filters with own-row scope, and column access.
- The browser-only demo mode simulates these rules and does not enforce them.

## [0.2.0] - 2026-11-17

Phase 2: the maker portal, workspace files, the full control set and the debug run window.

### Added
- Maker portal, where you list, create and open apps.
- Tables stored as CSV files in a workspace folder, with a sample workspace that has Contacts and Orders tables.
- A full set of controls for screens, including an animated icon control with an icon picker.
- Responsive desktop Studio layout.
- Debug run window, which shows the app the way its users will see it. Where pop-ups are blocked, it falls back to a preview inside the page.
- Windows scripts for offline setup and start (`scripts/setup-offline.ps1` and `scripts/start.ps1`).

### Changed
- A missing data file is read quietly rather than raising an error.

### Fixed
- Date differences (`DateDiff`) count hour, minute and second boundaries on the local clock. Calculations no longer fail in time zones with half-hour offsets, such as India Standard Time.

## [0.1.0] - 2026-11-17

The first Studio prototype.

### Added
- Studio editor: a drag-and-drop canvas for designing app screens, with Excel-style formulas through the Fx formula engine.
- Shared control components and a runtime that runs the designed app.

### Fixed
- Dropdowns now open in Preview.
- Build configuration paths for TypeScript are corrected.
