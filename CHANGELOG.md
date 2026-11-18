# Changelog

All notable changes to Appbuilder are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Application shell with two modes, switched in the top bar: **Dev mode** (the maker portal and the Studio) and **User mode** (a "My apps" launcher with search and recently opened apps). People without the Maker or Administrator role see only User mode; makers return to the mode they used last (remembered per user in the browser). New routes: `#u`, `#u-<app id>`, `#soon-<key>`, `#chat`.
- App tabs in User mode: apps open as tabs under the top bar (the launcher is the fixed first tab), several at once; each keeps its state while you switch tabs or modes; close with the x, middle-click or Delete; open tabs come back after a reload. Every tile and tab has **Open in new window**; in Dev mode **Run** offers "Open in a tab" and "Open in new window".
- Chat dock: a chat button in the top bar and the Studio opens a resizable panel on the right (open state and width remembered) that can pop out into its own window and be brought back (BroadcastChannel, with a storage-event fallback). Chat itself is not built yet; the panel shows what it will do.
- Planned modules as menu entries with a **Soon** badge and a placeholder page each (module, what it will do, planned phase): Data model, Flows, Approvals, Dashboards, Agents, Sites, Environments, Admin console and Templates in Dev mode; Tasks, Notes, Chat, Files, Documents / Slides / Sheets, Mail, Approvals and Dashboards in User mode. One registry, `src/portal/modules.ts`.
- Phone and tablet app sizes: Desktop 1920x1080 and 2560x1440, Phone 360x800 (default), 390x844 and 412x915, Tablet 800x1280 and 1280x800, and a custom size that can now be portrait, in the New app dialog, Start with data and App settings. Start with data lays a phone app out as a list screen and a form screen. Portrait apps run at their design size, centred, in landscape windows and app tabs; the Studio viewport menu has the phone and tablet sizes.
- Documentation index in `docs/README.md`, and a decision log in `docs/decisions.md` that explains why the main choices were made.
- Third-party notices in `THIRD-PARTY-NOTICES.md`, listing every production package with its license, and `npm run notices` to regenerate it.
- README links to the documentation, and run instructions that match the current start-up steps (MySQL and the first-run setup screen).

### Changed
- Apps may be portrait: the server (`POST /api/v1/apps`, package import) and the demo platform no longer refuse a width smaller than the height (sizes stay 200 to 16000 px per side); the client asks for at least 320 px per side. Loading an app no longer swaps a portrait size into landscape.
- Each app tab has its own runtime store (`createAppStore`), evaluator cache and user-defined functions; the Studio, Preview and the standalone player use the shared store as before.
- The Studio and the portal need less width (900 px) so they fit next to the chat panel.
- Build specifications moved to `docs/internal/specs`. They are kept for history and are no longer maintained.

### Security
- First-run setup accepts only requests from this computer (checked on the connection, not on headers) and needs a one-time setup code printed in the server window; once an administrator exists the setup stays closed, also while the database is unreachable.
- `GET /status` no longer shows the database host, port and name to anyone but a signed-in administrator.
- The page's Content-Security-Policy no longer allows inline script (hashes of the app's own inline script instead).
- Linking a table that is already linked is refused, also through a second connection to the same database. Deleting a table keeps the table in the database unless you tick "Also delete the table in the database", which is offered only for tables Appbuilder created; linked tables are never dropped and removing their columns only unmaps them.
- CSV exports prefix cells that a spreadsheet would run as formulas with `'`.
- Passwords set by an administrator must be changed at the next sign-in (schema version 3). Sign-in also has a per-account backoff.
- The session cookie can be marked `Secure` (`APPBUILDER_SECURE_COOKIE=1`, or `APPBUILDER_TRUST_PROXY=1` behind an HTTPS proxy).
- The audit log records the row ids of bulk deletes, before/after of role and user changes, and schema migrations; failed audit writes are reported as errors.

### Fixed
- A user-defined function in App.Formulas was reported as "already a built-in function" when another app that defines a function with the same name had been evaluated first in the same page.
- The consent to add system columns when linking a table is now sent; MySQL tables get the missing columns (including `id`, filled with UUIDs). Without consent such tables link read-only and can be read (before, a table with `id` but without the other system columns failed on every query).
- The Default database connection can no longer be edited in the portal (edits silently reverted at the next start).
- Imported rows (CSV, new table from CSV, packages with data) belong to the importing user; administrators can give rows without owner an owner.
- The server retries an unreachable database in the background at start instead of staying unconfigured, and refuses to use a database upgraded by a newer version.

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
