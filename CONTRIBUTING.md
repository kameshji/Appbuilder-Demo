# Contributing

Thanks for helping. This page is the short version of how to work on Appbuilder. The detail is in `docs/dev/`:
[architecture](docs/dev/architecture.md), [Data API](docs/dev/data-api.md), [schema](docs/dev/schema.md),
[connectors](docs/dev/connectors.md), [security engine](docs/dev/security-engine.md), [frontend](docs/dev/frontend.md) and
[testing](docs/dev/testing.md). The reasons behind the main choices are in [docs/decisions.md](docs/decisions.md).

## Setup

You need:

- **Node 22.18 or newer** (`engines` in `package.json`). The server runs TypeScript directly through type stripping, so older Node
  versions do not work.
- **PostgreSQL 15+** for the server (17 recommended; CI runs 16). `scripts/setup-postgres.ps1` (Windows) or
  `scripts/setup-postgres.sh` (Linux) creates the role and an empty database. For development any local server and an empty UTF8
  database will do. MySQL/MariaDB is only needed to run the MySQL connector's tests.

```bash
npm install
npm run dev          # Vite dev server with the API mounted (hot reload); first run opens the setup screen
# or, as users run it:
npm run build        # typecheck + single-file build into dist/index.html
npm start            # node server/main.ts, serves dist/ and /api/v1 on http://127.0.0.1:5174
```

Skip the setup screen by giving the server the database through environment variables:
`APPBUILDER_DB_HOST`, `APPBUILDER_DB_PORT`, `APPBUILDER_DB_NAME`, `APPBUILDER_DB_USER`, `APPBUILDER_DB_PASSWORD`
(optional `APPBUILDER_DB_SSL`). Other variables: `PORT` (5174), `APPBUILDER_HOST` (127.0.0.1), `APPBUILDER_WORKSPACE` (`./workspace`,
git-ignored), `APPBUILDER_SECRET_KEY` (64 hex characters). Use throw-away databases and obviously fake passwords for development;
never commit real credentials, `workspace/` or `.env` files.

Opening `dist/index.html` without the server runs **demo mode** (browser-only simulation). It is not a security boundary.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server, API mounted through `server/vite-plugin.mjs` |
| `npm run build` | `tsc -b` then `vite build` into one file, `dist/index.html` |
| `npm start` | `node server/main.ts` |
| `npm test` | `vitest run`: unit tests plus the docs staleness tests; integration tests run only when `APPBUILDER_TEST_DB` is set |
| `npm run typecheck` | `tsc -b --noEmit` (client) and `tsc -p tsconfig.server.json` (server) |
| `npm run typecheck:server` | the server half only |
| `npm run lint` | oxlint (`react/rules-of-hooks` is an error) |
| `npm run docs:gen` | regenerate `docs/reference/*.md` from the code |
| `npm run licences` | licence allow-list gate for production dependencies; also run in CI (see [testing](docs/dev/testing.md)) |
| `npm run notices` | regenerate `THIRD-PARTY-NOTICES.md` (needs `node_modules`) |
| `node scripts/gen-animated-icons.mjs` | regenerate `src/fx/animatedIcons.ts` after upgrading `react-useanimations` |

## Code rules

- Client code: React 19 + TypeScript, `@/` alias for `src/`. Third-party UI libraries are imported only from `src/components/ui/`
  and `src/controls/`. See "Module boundaries" in [architecture](docs/dev/architecture.md).
- Server code must be erasable TypeScript: relative imports with the `.ts` extension, `import type` for types, no enums, no
  namespaces, and never `import '@/...'`. `npm run typecheck:server` enforces it.
- `src/contracts.ts` and `src/platform/http.ts` are shared contracts (the second is the Data API). Changing them changes the
  contract with the planned PHP gateway: update [data-api.md](docs/dev/data-api.md) in the same change and tell the maintainers.
- Security is enforced on the server only. Client checks are for user experience. Never put a permission check in a connector or a
  component and call it security.
- Never log or return passwords, secret keys, SQL text or stack traces. Error messages are written for makers (plain English).
- Qualify every table with its schema and never rely on `search_path`; keep the MySQL connector's SQL portable (MySQL 5.7+/8,
  MariaDB 10.4+): see [schema](docs/dev/schema.md) and [connectors](docs/dev/connectors.md).

## Dependency rule

Appbuilder is sold, so every production dependency must be **permissive**: MIT, ISC, BSD-2/3-Clause, 0BSD, Apache-2.0, BlueOak-1.0.0,
CC0-1.0, Unlicense, Python-2.0/PSF-2.0 or Zlib (CC-BY-4.0 for data and fonts only). `npm run licences` enforces this in CI.

- No GPL, LGPL, AGPL, SSPL, BUSL, Elastic, Commons Clause, Sustainable Use ("fair-code") or unlicensed code in the product, and nothing
  from `/ee/` or `/enterprise/` folders or `@univerjs-pro`. Packages such as n8n, NocoDB, Directus, Handsontable, tldraw and pm2 are
  blocked by name.
- AGPL tools are allowed only as **separate, unmodified, optional add-ons** that the user installs themselves and that we talk to
  over a network or process boundary. Never import them, bundle them or ship a modified copy.
- **Ask before adding an MPL-2.0 package.** It is allowed by the gate, but it is file-level copyleft: we may use it unmodified, never
  patch it in place.
- Dual-licensed packages are fine when one side is on the list; the gate records which side we rely on.
- If the gate fails, replace the package. An entry in `scripts/licence-exceptions.json` needs a written reason and a named
  approver, and is reviewed like code. Run `npm run notices` and commit `THIRD-PARTY-NOTICES.md` when production dependencies change.

## Branches and commits

The repository does not enforce these yet; this is the working convention.

- Branch from the main branch: `feature/<short-name>`, `fix/<short-name>`, `docs/<short-name>`. One topic per branch.
- Commit messages: a short imperative summary (about 70 characters or less), for example `Refuse unique columns on non-empty tables`,
  then a blank line and a body that explains **why**. Reference the decision (`D7`) when a change follows or alters one.
- Keep commits focused: a code change and its tests and docs belong together. Do not mix formatting sweeps with behaviour changes.
- Do not commit `dist/`, `node_modules/`, `workspace/` or any `*.local` file (all git-ignored).
- Add a line under `## [Unreleased]` in `CHANGELOG.md` for any change a user or admin would notice. Security fixes go under
  `### Security`.

## Documentation rules

From [docs/README.md](docs/README.md):

1. Docs live in the repository and change in the same commit as the behaviour they describe.
2. Generated pages are never edited by hand. Change the code or the hand-written part in `scripts/docs/` and run `npm run docs:gen`;
   a test fails when a page is stale.
3. Every page says what is not supported. No page describes a feature that does not exist.
4. Plain English, short sentences. Developer pages quote real file paths.
5. Security statements must match the code and the security tests. If you change `server/core/security.ts` or how it is enforced,
   update [security-engine.md](docs/dev/security-engine.md) in the same commit.
6. Adding a control needs a one-line description in `scripts/docs/controls.ts`; adding an Fx function needs a category in
   `scripts/docs/formulas.ts`.

## Definition of done

A change is done when all of these are true:

1. `npm run typecheck` passes (client and server).
2. `npm test` passes, including the docs staleness tests. New behaviour has tests; a bug fix has a test that failed before.
3. If you touched the database layer, the connectors, `data.ts`, `security.ts` or any route: the integration tests pass against a real
   PostgreSQL (`APPBUILDER_TEST_DB`) and, for the MySQL connector, MariaDB (`APPBUILDER_TEST_MYSQL`); see [testing](docs/dev/testing.md).
4. `npm run lint` shows no new errors.
5. The docs are updated: the matching page in `docs/dev/` (and `docs/guide` or `docs/admin` if a maker or admin would notice), the
   generated references (`npm run docs:gen`, committed), and `CHANGELOG.md` where relevant.
6. UI changes were checked by hand in the Studio and the portal, in light and dark themes, and (if shared code changed) in demo mode.
7. No secrets, personal data or real customer data in code, tests, fixtures or screenshots.
