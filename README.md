# Appbuilder

Appbuilder is a desktop low-code app builder. You make apps in a maker portal, then design them in Studio, a drag-and-drop canvas with Excel-style formulas. Tables are stored in a MySQL or MariaDB database, and data files can be connected as data sources. Apps can use security roles, and related apps are grouped into solutions. Apps and solutions are saved as YAML packages, and a live run window shows the app as the user will see it.

## Documentation

- [Documentation index](docs/README.md): all guides and reference pages
- [Getting started](docs/guide/getting-started.md): install and first steps
- [Admin guide](docs/admin/README.md): users, roles, connections, backups and upgrades
- [Architecture](docs/dev/architecture.md): how the code is organised
- [Formula reference](docs/reference/formulas.md) and [controls reference](docs/reference/controls.md)
- [Changelog](CHANGELOG.md) and [third-party notices](THIRD-PARTY-NOTICES.md)
- [Security policy](SECURITY.md) and [contributing guide](CONTRIBUTING.md)

## Requirements

- Node.js 22.18 or newer. `npm start` runs the TypeScript server directly, which needs this version.
- A MySQL or MariaDB server for the app data, either on this PC or reachable from it.
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

The first time you open the app, a setup screen asks for the MySQL or MariaDB connection (host, port, database, user and password). On Windows, create the database and its user first with the setup script, then enter the same password in the setup screen:

```powershell
.\scripts\setup-mysql.ps1
```

The script expects a MySQL install folder, by default `%USERPROFILE%\MySQL`. Pass `-MySqlHome` if yours is elsewhere. It asks for the new user's password itself and does not save it.

Settings, read from environment variables:

- `APPBUILDER_WORKSPACE`: the workspace folder. Default: `./workspace`, next to `package.json`.
- `PORT`: the port for `npm start`. Default: `5174`.
- `APPBUILDER_HOST`: the address to listen on. Default: `127.0.0.1`.
- `APPBUILDER_SECRET_KEY`: 64 hex characters that encrypt stored connection passwords. If it is not set, a key is created in `workspace/.secret-key` on first start. Back up that key with the workspace, or the stored passwords cannot be read.
- `APPBUILDER_DB_HOST`, `APPBUILDER_DB_PORT`, `APPBUILDER_DB_NAME`, `APPBUILDER_DB_USER`, `APPBUILDER_DB_PASSWORD`, `APPBUILDER_DB_SSL`: optional database connection. When the host, name and user are set, the setup screen is skipped.

The server listens on `127.0.0.1` only by default. It is not reachable from other machines on your network.

## Offline use

After one `npm install` and one `npm run build`, `npm start` needs no internet connection when the database is on this PC. App data lives in the MySQL or MariaDB database. Data files you pick are copied into the workspace folder, and the original files are never changed. Back up both the database and the workspace folder.

### Windows quick start

From PowerShell in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-offline.ps1
```

The script checks for Node.js 22.18 or newer and git, clones or updates the repository, installs and builds it, starts the server, and opens the browser. To start an existing install later, run `scripts\start.ps1`. See `scripts/setup-offline.ps1` for the parameters (`-Path`, `-Repo`).

## Project layout

- `src/fx/`: the formula engine (lexer, parser, evaluator and the built-in functions)
- `src/controls/`: the control types that can be placed on a screen
- `src/components/ui/`: shared UI components
- `src/platform/`: apps, tables, storage, packages and solutions; the storage adapters (local folder or browser)
- `src/portal/`: the maker portal, where apps are listed and created
- `src/studio/`: the Studio editor
- `src/runtime/`: the run window and the sample app definitions
- `server/main.ts`: the server entry point, used by `npm start`
- `server/core/`: the app, configuration, sign-in, access rules (roles, row and column security), the data service and attachments
- `server/connectors/`: the MySQL or MariaDB, data file and Google Sheets connectors
- `server/routes/meta/`: the metadata API for tables, connections, apps, packages and solutions
- `docs/`: documentation (see Documentation above)

## Tests

```sh
npm test
```

This runs the Vitest suite. Type checking and linting are available with `npm run typecheck` and `npm run lint`.

## Known limits

- Runs on one PC: the server listens on 127.0.0.1 only. Hosting for several PCs (a PHP gateway on shared hosting) is planned.
- Security (sign-in, roles, row filters, column access) is enforced by the local server. The browser-only demo page simulates it and is not secure.
- Writes are optimistic: the screen updates before the server confirms; a refused write is rolled back with an error.
- Apps load up to 5,000 rows per table and warn when data is cut off.
- Connectors: MySQL/MariaDB, data files (CSV, Excel, JSON; device only) and Google Sheets. Google Sheets has not been tested against a live Google account yet.
- Verified on MariaDB 10.11; MySQL 8.4 verification is pending.
- Flows (automation) are not built yet. No installer, auto-update, built-in backup, password-reset email or two-factor sign-in yet.
- The run window needs a normal browser window. Where pop-ups are blocked, it falls back to a preview inside the page.
