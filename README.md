# Appbuilder

Appbuilder is a desktop low-code app builder. You make apps in a maker portal, then design them in Studio, a drag-and-drop canvas with Excel-style formulas. Tables are stored in a PostgreSQL database; existing PostgreSQL and MySQL/MariaDB databases, Google Sheets and data files can be connected as data sources. Apps can use security roles, and related apps are grouped into solutions. Apps and solutions are saved as YAML packages, and a live run window shows the app as the user will see it.

## Documentation

- [Documentation index](docs/README.md): all guides and reference pages
- [Getting started](docs/guide/getting-started.md): install and first steps
- [Admin guide](docs/admin/README.md): users, roles, connections, backups and upgrades
- [Architecture](docs/dev/architecture.md): how the code is organised
- [Formula reference](docs/reference/formulas.md) and [UI components reference](docs/reference/ui-components.md)
- [Changelog](CHANGELOG.md) and [third-party notices](THIRD-PARTY-NOTICES.md)
- [Security policy](SECURITY.md) and [contributing guide](CONTRIBUTING.md)

## Install (Windows or Linux)

Download a release (`appbuilder-<version>.zip`), unpack it, and run one script. It installs Node.js, PostgreSQL 17,
Appbuilder as a service and, if you ask for it, HTTPS with Caddy:

```powershell
# Windows, in an elevated PowerShell
powershell -ExecutionPolicy Bypass -File .\scripts\install\windows\install.ps1            # add -Https Lan -OpenFirewall for the office network
```

```bash
# Ubuntu 22.04/24.04, Debian 12
sudo bash scripts/install/linux/install.sh                                                  # add --https domain --domain apps.example.com
```

Then create the first administrator at `http://localhost:5174/` with the setup code the installer points to. Details,
offline installs and sizing: [Installation](docs/admin/installation.md). Updates: `appbuilder update <zip>`
([Upgrades](docs/admin/upgrades.md)). Build a release yourself with `npm run release`
([Release process](docs/dev/release-process.md)).

## Requirements (running from source)

- Node.js 22.18 or newer. `npm start` runs the TypeScript server directly, which needs this version.
- PostgreSQL 15 or newer (17 recommended) for the app data, either on this PC or reachable from it.
- git (used by the Windows setup script)

## Run it

```sh
npm install
npm run dev        # development server with hot reload: http://localhost:5173
```

Or build once and run the built app:

```sh
npm run build
npm start          # http://localhost:5174
```

`npm start` runs `server/main.ts`, which serves the built app and its API.

### First run and the database

The first time you open the app, a setup screen asks for the PostgreSQL connection (host, port 5432, database, user and password) and the one-time setup code printed in the server window. Create the database and its own role first with the setup script, then enter the same password in the setup screen:

```powershell
winget install --id PostgreSQL.PostgreSQL.17 -e --interactive   # if PostgreSQL is not installed yet
.\scripts\setup-postgres.ps1                                    # Linux: scripts/setup-postgres.sh
```

The script finds PostgreSQL (or tells you how to install it), asks for the superuser password and the new `appbuilder` role's password without showing or saving them, and creates the role and a database `appbuilder` owned by it. See [Installation](docs/admin/installation.md#prepare-the-database).

Settings, read from environment variables:

- `APPBUILDER_WORKSPACE`: the workspace folder. Default: `./workspace`, next to `package.json`.
- `PORT`: the port for `npm start`. Default: `5174`.
- `APPBUILDER_HOST`: the address to listen on. Default: `127.0.0.1`.
- `APPBUILDER_SECRET_KEY`: 64 hex characters that encrypt stored connection passwords. If it is not set, a key is created in `workspace/.secret-key` on first start. Back up that key with the workspace, or the stored passwords cannot be read.
- `APPBUILDER_DB_HOST`, `APPBUILDER_DB_PORT` (5432), `APPBUILDER_DB_NAME`, `APPBUILDER_DB_USER`, `APPBUILDER_DB_PASSWORD`, `APPBUILDER_DB_SSL`: optional PostgreSQL connection. When the host, name and user are set, the setup screen is skipped.

The server listens on `127.0.0.1` only by default. It is not reachable from other machines on your network.

## Offline use

After one `npm install` and one `npm run build`, `npm start` needs no internet connection when the database is on this PC. App data lives in the PostgreSQL database. Data files you pick are copied into the workspace folder, and the original files are never changed. Back up both the database (`pg_dump`) and the workspace folder ([Backup and restore](docs/admin/backup-and-restore.md)).

### Windows quick start

From PowerShell in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-offline.ps1
```

The script checks for Node.js 22.18 or newer and git, clones or updates the repository, installs and builds it, starts the server, and opens the browser. To start an existing install later, run `scripts\start.ps1`. See `scripts/setup-offline.ps1` for the parameters (`-Path`, `-Repo`).

## Project layout

- `src/fx/`: the formula engine (lexer, parser, evaluator and the built-in functions)
- `src/controls/`: the UI component types that can be placed on a screen
- `src/components/ui/`: shared UI components
- `src/platform/`: apps, tables, storage, packages and solutions; the storage adapters (local folder or browser)
- `src/portal/`: the maker portal, where apps are listed and created
- `src/studio/`: the Studio editor
- `src/runtime/`: the run window and the sample app definitions
- `server/main.ts`: the server entry point, used by `npm start`
- `server/core/`: the app, configuration, sign-in, access rules (roles, row and column security), the data service and attachments
- `server/connectors/`: the PostgreSQL (default database and external), MySQL/MariaDB (external), data file and Google Sheets connectors
- `server/routes/meta/`: the metadata API for tables, connections, apps, packages and solutions
- `docs/`: documentation (see Documentation above)

## Tests

```sh
npm test
```

This runs the Vitest suite. Integration tests run when `APPBUILDER_TEST_DB` (a sandbox PostgreSQL URL) and `APPBUILDER_TEST_MYSQL` (a sandbox MySQL/MariaDB URL for the MySQL connector) are set; see [testing](docs/dev/testing.md). Type checking and linting are available with `npm run typecheck` and `npm run lint`.

## Known limits

- The server listens on 127.0.0.1 only; other PCs reach it through the HTTPS reverse proxy (Caddy) the installers set up on request. A PHP gateway for shared hosting is planned.
- Security (sign-in, roles, row filters, column access) is enforced by the local server. The browser-only demo page simulates it and is not secure.
- Writes are optimistic: the screen updates before the server confirms; a refused write is rolled back with an error.
- Formulas over tables run in the database (filter, search, sort, paging, exact counts, totals), so tables of a million rows work; a
  formula that can't run there is an error on large tables, never a partial result. MySQL, data file and Google Sheets tables are
  queried over their first 5,000 rows.
- Connectors: PostgreSQL, MySQL/MariaDB, data files (CSV, Excel, JSON; device only) and Google Sheets. Google Sheets has not been tested against a live Google account yet.
- Verified on PostgreSQL 16 (the MySQL connector on MariaDB 10.11). One environment per install for now.
- Flows (automation) are not built yet. Updates are installed by `appbuilder update` from a release file you bring (no automatic download). The Windows installer has not yet been run on a real Windows machine (see [Release process](docs/dev/release-process.md#what-was-tested)).
- The run window needs a normal browser window. Where pop-ups are blocked, it falls back to a preview inside the page.
