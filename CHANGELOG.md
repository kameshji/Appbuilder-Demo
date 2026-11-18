# Changelog

All notable changes to Appbuilder are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Documentation index in `docs/README.md`, and a decision log in `docs/decisions.md` that explains why the main choices were made.
- Third-party notices in `THIRD-PARTY-NOTICES.md`, listing every production package with its license, and `npm run notices` to regenerate it.
- README links to the documentation, and run instructions that match the current start-up steps (MySQL and the first-run setup screen).

### Changed
- Build specifications moved to `docs/internal/specs`. They are kept for history and are no longer maintained.

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
