# Appbuilder

Appbuilder is a desktop low-code app builder. You make apps in a maker portal, then design them in Studio, a drag-and-drop canvas with Excel-style formulas. Tables are stored as local CSV files. Apps can use security roles, and related apps are grouped into solutions. Apps and solutions are saved as YAML packages, and a live run window shows the app as the user will see it.

## Requirements

- Node.js 20 or newer
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

Settings, read from environment variables:

- `APPBUILDER_WORKSPACE`: the workspace folder. Default: `./workspace`, next to `package.json`.
- `PORT`: the port for `npm start`. Default: `5174`.

The server listens on `127.0.0.1` only. It is not reachable from other machines on your network.

## Offline use

After one `npm install` and one `npm run build`, `npm start` needs no internet connection. All data lives in the workspace folder as `.csv` and `.yaml` files. You can back that folder up, copy it, or open the CSV files in Excel.

### Windows quick start

From PowerShell in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-offline.ps1
```

The script checks for Node.js 20 or newer and git, clones or updates the repository, installs and builds it, starts the server, and opens the browser. To start an existing install later, run `scripts\start.ps1`. See `scripts/setup-offline.ps1` for the parameters (`-Path`, `-Repo`).

## Project layout

- `src/fx/`: the formula engine (lexer, parser, evaluator and the built-in functions)
- `src/controls/`: the control types that can be placed on a screen
- `src/components/ui/`: shared UI components
- `src/platform/`: apps, tables, storage, packages and solutions; the storage adapters (local folder or browser)
- `src/portal/`: the maker portal, where apps are listed and created
- `src/studio/`: the Studio editor
- `src/runtime/`: the run window and the sample app definitions
- `server/`: the Node server (`index.mjs`) and the workspace file API (`handler.mjs`, with path checks in `pathGuard.mjs`)
- `docs/`: design specs and notes

## Tests

```sh
npm test
```

This runs the Vitest suite. Type checking and linting are available with `npm run typecheck` and `npm run lint`.

## Known limits

- Security roles are enforced on this machine only.
- Flows are not built yet.
- Only the Local CSV connector works.
- The run window needs a normal browser window. Where pop-ups are blocked, it falls back to a preview inside the page.
