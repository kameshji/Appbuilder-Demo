# Architecture

Appbuilder is a desktop low-code app builder. Makers design apps on a canvas with Excel-style formulas; data lives in PostgreSQL
(the default database), external MySQL/PostgreSQL databases, data files or Google Sheets; the server decides who may see what. The decisions behind the shape are in
`/home/claude/appbuilder-demo/docs/decisions.md` (D1 to D19). This page describes the code as it is.

- **Browser**: React 19 + TypeScript, built with Vite into **one HTML file** (`dist/index.html`). Hash routes, zustand + immer for
  state, Tailwind 4 for styles.
- **Server**: Node (22.18 or newer) running TypeScript directly through type stripping (`node server/main.ts`); no build step, no
  framework. It serves the Data API under `/api/v1` and the built app from `dist/`.
- **Storage**: one PostgreSQL database (schema `ab` for install-wide objects, one schema `env_<id>` per environment with its
  metadata tables `ab_*` and its data tables; see `schema.md`) and the **workspace folder** on disk (`env/<id>/` per environment).
- **Demo mode**: the same browser build can run with no server at all, simulating the platform over IndexedDB.

What is not supported: multi-tenant hosting, horizontal scaling of the Node server (it keeps session throttling, security caches and
the files store and the realtime hub's subscriptions in process memory), real-time co-editing (the Studio has a soft edit lock instead:
one maker edits, others watch read-only, see `live.md`),
and arbitrary formulas in the request path: the server evaluates formulas only where the platform defines them (Query v2
pushdown, and table events, validation rules and formula columns; see `events-and-jobs.md`).

## Component diagram

```mermaid
flowchart TB
  subgraph Browser["Browser (one HTML file)"]
    Portal["Portal<br/>apps, tables, roles, connections"]
    Studio["Studio<br/>canvas, formula bar, properties"]
    Runtime["Runtime<br/>store, evaluator, host, player"]
    Fx["Fx engine<br/>lexer, parser, evaluator, functions"]
    Controls["UI component registry<br/>renderers (shadcn/Radix, recharts, ...)"]
    Facade["Platform facade<br/>usePlatform, tables, apps, security"]
    Remote["Remote platform<br/>server mode: row cache, optimistic writes"]
    Demo["Demo platform<br/>demo mode: simulated, IndexedDB"]
    Portal --> Facade
    Studio --> Runtime
    Runtime --> Fx
    Runtime --> Controls
    Runtime --> Facade
    Studio --> Controls
    Facade -->|"GET /api/v1/status answers"| Remote
    Facade -->|"no server"| Demo
  end

  subgraph Server["Node server (server/)"]
    Router["Router<br/>guards, limits, errors"]
    Auth["Auth<br/>login, sessions, throttle"]
    Sec["Security engine<br/>RBAC + RLS + CLS"]
    Data["DataService<br/>validate, guard, audit"]
    Meta["MetaStore<br/>ab_* repositories"]
    Conn["ConnectionManager"]
    PGc["PostgreSQL connector<br/>(default + external)"]
    MySQLc["MySQL connector<br/>(external)"]
    Filesc["Files connector"]
    Gsc["Google Sheets connector"]
    Att["Attachment store"]
    Routes["Metadata routes<br/>apps, tables, roles, solutions, files"]
    Router --> Auth
    Router --> Data
    Router --> Routes
    Router --> Att
    Data --> Sec
    Data --> Conn
    Data --> Meta
    Routes --> Meta
    Routes --> Sec
    Routes --> Conn
    Auth --> Meta
    Conn --> PGc
    Conn --> MySQLc
    Conn --> Filesc
    Conn --> Gsc
    Att --> Meta
  end

  subgraph Storage["Storage"]
    DB[("PostgreSQL<br/>schema ab + env_&lt;id&gt; per environment<br/>(ab_* tables + data tables)")]
    ExtDB[("Customer databases<br/>MySQL / MariaDB / PostgreSQL")]
    WS[("Workspace folder<br/>server.json, .secret-key,<br/>env/&lt;id&gt;/attachments, env/&lt;id&gt;/files")]
    Google[("Google Sheets API")]
  end

  Remote -->|"HTTPS JSON /api/v1<br/>cookie ab_session"| Router
  Remote <-->|"WebSocket /api/v1/live<br/>table ticks, presence, notifications"| Hub["Realtime hub<br/>(server/core/live)"]
  Hub -.->|"committed outbox rows"| Data
  Meta --> DB
  PGc --> DB
  PGc -.-> ExtDB
  MySQLc --> ExtDB
  Filesc --> WS
  Att --> WS
  Gsc --> Google
  Demo -.->|"IndexedDB"| BrowserStore[("Browser storage")]
  Demo -.->|"BroadcastChannel between tabs"| Demo
```

A PHP gateway for shared hosting (D12) replaces the whole Server box and keeps the arrow labelled `/api/v1` unchanged; see
`data-api.md`.

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/contracts.ts` | The shared contract: `AppDef`, `ControlNode`, Fx types, `PropMeta`, `ControlType`. Changes need the architect's agreement. |
| `src/fx/` | Formula engine, shared by browser and server. No React, no DOM, explicit `.ts` imports. `index.ts` exports `fx` (`check`, `evaluate`, `referencedNames`, `renameIdentifier`, `functions`, `enums`, `parseNamedFormulas`, `setUserFunctions`, `signatureAt`, `createEngine`); `engine.ts` the per-app engine instance (`createEngine`: its own user-defined functions and named formulas); `query/` the formula-to-query translator (Query v2, see `query-v2.md`). |
| `src/controls/` | UI component registry (`index.ts`), the UI component renderers, `sets/` (Insert-pane order), `icon/` (lucide and animated icons). |
| `src/components/ui/` | shadcn-style wrappers over Radix and other libraries. |
| `src/platform/` | The platform facade (`index.ts`), `remote.ts` (server mode), `core.ts` (demo mode), `contracts.ts` (platform types), `http.ts` (Data API types, shared with the server), `query.ts` (Query v2 plan types, shared with the server and `src/fx/query`), `rowfilter.ts`, `storage.ts`. |
| `src/runtime/` | App stores (`createAppStore`: definition and runtime state; the shared `useStore` plus one per app tab), store context, evaluator, Fx host, player (`RunApp`, `RenderNode`), design sizes, autosave session. |
| `src/studio/` | The editor: canvas, formula bar, properties panel, left rail, command bar. |
| `src/portal/` | The application shell (`Portal.tsx`, `Shell.tsx`: Dev mode and User mode, app tabs in `UserMode.tsx`, `workspace.ts`), the planned-module registry (`modules.ts`) and the maker pages: home, apps, tables, data grid, roles, solutions, connections, data files, sign-in. |
| `server/core/live/`, `server/core/notifications.ts` | Realtime hub (WebSocket `/api/v1/live`: table-changed ticks from the outbox, presence, Studio locks, app and environment messages) and in-app notifications. See `live.md`. |
| `src/chat/` | Chat dock, pop-out window and their coordination; `ChatPanel.tsx` is the boundary the chat module will fill. |
| `src/router.ts`, `src/App.tsx`, `src/main.tsx` | Hash router, top-level composition, entry. |
| `server/main.ts` | Process entry: creates the app, HTTP server, static files, graceful shutdown. |
| `server/core/` | Router, auth, security engine, DataService, values, conditions, services wiring, meta store, connection manager, attachments. |
| `server/routes/meta/` | Metadata routes (apps, tables, connections, security, solutions, files), packages (YAML), seed data, legacy migration. |
| `server/connectors/{postgres,mysql,files,gsheets}/` | The connectors. `postgres/db.ts` is also the system store's pool (`SqlDb`, units of work). |
| `server/vite-plugin.mjs` | Mounts the same API handler into the Vite dev and preview servers. |
| `scripts/` | installers (`install/`: the Windows and Linux installers, their manifest and the offline bundle, see `release-process.md`; `release/`: `npm run release`, signing; `setup-postgres.ps1` and `setup-postgres.sh`: PostgreSQL role and database; `setup-offline.ps1`, `start.ps1`), `gen-animated-icons.mjs`, `gen-notices.mjs`, `docs/` (reference generators and their test), `docs-shots/` (screenshot capture, developer tool). |
| `docs/` | Documentation (see `docs/README.md` for the rules). |

## Module boundaries: who may import what

These are the rules the code follows. They are not enforced by a tool yet (oxlint has no import rules configured), so reviewers
enforce them.

```
contracts.ts   <- imported by everyone (types only)
fx             -> relative .ts files in src/fx; `import type` only from contracts.ts, platform/query.ts, platform/http.ts.
                  No React, no DOM, no packages, no runtime / studio / portal / controls / platform code (enforced by a test).
platform       -> contracts, fx values where needed. Never imports studio, portal, controls.
controls       -> contracts, components/ui, platform types and a few calls (data table, Form, attachment UI components), runtime attachment helpers
components/ui  -> third-party UI libraries, lib/utils. Nothing from the app.
runtime        -> fx, controls (registry), platform (through runtime/data.ts), contracts
studio         -> runtime, controls, fx, platform, components/ui, portal (ProfileAvatar, theme, SizePicker), chat (ChatButton)
portal         -> platform, components/ui, router, chat, runtime public pieces (RunApp, sizes, sample/store for Start with data),
                  studio (the shell mounts Studio). Not runtime or studio internals.
chat           -> components/ui, lib, portal/theme. Nothing else (the chat module will add platform).
server/**      -> server/** with relative `.ts` imports, plus `import type` from src/platform/{contracts,http,query}.ts and src/contracts.ts,
                  and the formula engine src/fx/** at run time (rule 3)
```

Specific rules:

1. **Third-party UI libraries** (Radix, recharts, react-day-picker, cmdk, react-useanimations) are imported only from
   `src/components/ui/` and `src/controls/` (decision D5). Portal and Studio use `@/components/ui/*`.
2. **Formula evaluation reaches the platform through `src/runtime/data.ts`**, a safe bridge: every call is wrapped so the runtime
   keeps working when the platform is a stub or fails (reads give empty values, writes throw a `PlatformError` that becomes a formula
   failure). The evaluator, host and store use only this bridge; `RunApp.tsx`, `session.ts` (autosave) and `attachments.ts` import
   `@/platform` directly because they need app and upload calls.
3. **The formula engine is shared; other client code is not.** The server may import `src/fx/**` at run time (relative paths,
   e.g. `import { createEngine } from '../../src/fx/index.ts'` and `import { analyze } from '../../src/fx/query/index.ts'`). So
   `src/fx` follows the server's rules: relative imports with explicit `.ts` extensions, erasable TypeScript only, no React, no DOM, no
   browser globals at import time, no packages; anything environment-specific (clipboard, launch, navigation, notifications) goes
   through the `FxHost` the caller passes. Outside `src/fx` it may only `import type` from `src/contracts.ts`,
   `src/platform/query.ts` and `src/platform/http.ts`. `/home/claude/appbuilder-demo/src/fx/layering.test.ts` enforces this and
   `server/core/fx.test.ts` loads the engine under plain Node. Apart from `src/fx`, the server uses only `import type` (erased by type
   stripping) from `src/platform/contracts.ts`, `src/platform/http.ts`, `src/platform/query.ts` and `src/contracts.ts`, and
   `import { DEFAULT_ROW_CAP, API_BASE, ... } from '../../src/platform/http.ts'`, which therefore must stay free of React, the DOM
   and the `@/` alias. Never `import '@/...'` in server code: the alias does not exist at run time. User-defined functions and named
   formulas belong to an engine instance (`createEngine({ formulas })`): create one per app definition, never share one between
   requests for different apps.
4. **Server TypeScript must be erasable**: relative imports with the `.ts` extension, `import type` for types, no enums, no
   namespaces, no parameter properties (`erasableSyntaxOnly` in `tsconfig.server.json`). Checked by `npm run typecheck:server`.
5. **Connectors know nothing about users or security**; security lives in `security.ts` and `data.ts` (see `connectors.md`).
6. **Client security code only mirrors the server** (see `security-engine.md`). Never make a client-only decision that protects data.

Known exceptions to keep in mind: a few UI components import runtime helpers (`@/runtime/attachments`, `@/runtime/AttachmentCell`) for
attachment cells, the player (`src/runtime/RunApp.tsx`) imports the Studio's `Toasts`, the Studio command bar imports
`ProfileAvatar` and `useTheme` from the portal, the animated icon (`AppIcon`) and the Studio's snapping (`studio/geo.ts`) read
the user's preferences from `src/platform/preferences.ts` (reduce motion, snap and grid), and `src/platform/samples.ts` imports the sample app from `src/runtime/sample.ts` for seeding. These
are the places where the dependency graph is not a clean layering.

## The app definition format

An app is stored as one JSON document, `AppDef` (`/home/claude/appbuilder-demo/src/contracts.ts`), in `ab_apps.definition`. In demo
mode it is a YAML file in browser storage; packages (`GET /apps/:id/package`) wrap the same structure in YAML.

```jsonc
{
  "formatVersion": 2,                 // 1 = legacy 960x600 fixed size; migrated to 2 ("fit") on load by migrateApp()
  "name": "Help desk",
  "width": 1920, "height": 1080,      // design size of every screen; landscape or portrait (phone 360x800, ...)
  "scaleMode": "responsive",          // or "fit": scale uniformly and letterbox
  "theme": { "mode": "light", "primary": "...", "radius": 8, "font": "..." },
  "dataSources": ["Tickets"],         // names of platform tables the app uses; their rows are loaded when the app opens
  "appProps": { "OnStart": "=Set(Open, true)", "Formulas": "Total = Sum(Tickets, Price);" },
  "screens": [
    {
      "id": "n_ab12",                 // stable, never shown
      "name": "Screen1",              // unique across the whole app; used in formulas
      "type": "Screen",
      "props": { "Fill": "=Color.White" },
      "children": [
        { "id": "n_cd34", "name": "Button1", "type": "Button",
          "props": { "Text": "=\"Save\"", "OnSelect": "=Patch(Tickets, Defaults(Tickets), {Title: TextInput1.Value}); Notify(\"Saved\")" },
          "children": [] }
      ]
    }
  ]
}
```

Rules:

- **Every property is a formula string that starts with `=`.** A literal is a formula too: text is `="Save"`, a number `=40`, a boolean
  `=true`, a colour `=RGBA(79, 70, 229, 1)` or `=Color.Red`, blank is `=Blank()`. There are no "plain" values, which keeps the
  evaluator uniform. A property that is missing from `props` takes the UI component's default (`PropMeta.default`, itself a formula).
- **Formulas are stored as text; today only the browser evaluates them.** The server stores and returns them. A formula can only
  affect data through the Data API with the caller's own session, so the server's security applies. The engine itself also runs on
  the server (rule 3) for the coming query pushdown, table events and jobs (P0 packages D and G).
- `ControlNode.type` is a key in the UI component registry (`controls.get(type)`); an unknown type makes the registry throw, so a
  UI component type name is part of the stored format and must never be renamed.
- `name` is unique across the whole app (not per screen) because formulas refer to UI components by bare name (`TextInput1.Value`). Renaming a
  UI component rewrites formulas with `fx.renameIdentifier` (only references, not strings or record labels).
- `children` of a `Gallery` are the **row template**, evaluated once per item with `ThisItem` in scope. Other containers (`Container`,
  `Row`, `Column`, `Grid`, `Card`, `Dialog`, `Sheet`, ...) hold direct children. Container flags are on `ControlType`
  (`isContainer`, `isTemplate`, `isOverlay`).
- `appProps.OnStart` runs when the app starts (and once at design time with table writes skipped). `appProps.Formulas` holds **named
  formulas and user-defined functions**: `Name = expr;` entries parsed by `fx.parseNamedFormulas`; a definition with parameters is a
  user-defined function.
- `dataSources` lists table names, not ids (formulas use table names too). Adding a data source loads that table's rows when the app
  opens.

## How the runtime evaluates formulas

The evaluator is `/home/claude/appbuilder-demo/src/runtime/evaluator.ts` (`Evaluator`, one instance per open app, reused and
incrementally invalidated through `getEvaluator`). Each `Evaluator` owns a formula engine instance (`evaluator.engine`, from
`createEngine()`) holding that app's user-defined functions, so apps open side by side (app tabs, Studio and preview) never see each
other's definitions; the Studio's formula bar uses the same instance for autocomplete, signature help and checks.

**Scope resolution.** `engine.evaluate(formula, scope)` asks the scope to resolve every bare identifier (`FxScope.resolve(name)`). The
evaluator's `resolveName(node, ctx, name)` looks names up in this order:

1. `ThisItem`: the current gallery row (innermost gallery of the node's context).
2. `Self` and `Parent`: a record of the UI component itself, or of its parent container.
3. `App`: `{ Width, Height, DesignWidth, DesignHeight, Name, ActiveScreen }`; `User()` (a special name for the signed-in user's record);
   `Param:<name>` (a URL query parameter).
4. A **UI component name** (`byName`): the record of that UI component (its evaluated properties and outputs, e.g. `TextInput1.Value`).
5. A **screen context variable** (`UpdateContext`) of the screen the formula lives on.
6. A **global variable** (`Set`).
7. A **collection** (`Collect`).
8. A **named formula** from `App.Formulas`.
9. A **platform table** (`isTable(name)`): its rows, from the platform cache.
10. Otherwise undefined, which the engine reports as "Name isn't recognised".

Names the maker cannot use for variables or UI components (`ThisItem`, `ThisRecord`, `Self`, `Parent`, `App`, `User`, `true`, `false`,
function names, enum names) are reserved (`reserved` in the store's rename and add logic).

**Dependency tracking.** Each evaluated property is a cache entry keyed `P|<nodeKey>|<prop>`. While a property computes, every read
is recorded in the current frame (`record(dep)`): other properties (`P|...`), outputs `o:<outKey>`, variables `v:<name>`, collections
`k:<name>`, screen context `c:<screen>:<name>`, form modes `f:<key>`, the screen size `e`, the current user `u`, platform tables `t:<name>`,
and named formulas `N|<name>`. The frame becomes the entry's forward dependencies and the reverse index (`rdeps`) is updated. When the
runtime state changes, `update(rt, env)` compares the previous and new state per key (`diffFlat`) and `invalidate(dep)` drops every
entry that transitively depends on what changed. Each node has a version number that is bumped when its entries drop; `RenderNode`
subscribes to its own node's version, so typing in one input re-renders only the UI components that read it. A definition change that does
not alter the structure (names, types, nesting) is adopted incrementally with `withApp`, which invalidates only the changed properties;
a structural change builds a new evaluator.

**Failure handling.** A formula that fails yields the property's default value and an error message shown in the Studio; it never throws
into the UI component. Circular references are detected through the evaluation stack and reported as "Circular reference" (the default value
is used). Action properties (`kind: 'action'`) are syntax-checked when read and only run when fired.

**Events and the host.** A UI component calls `fire('OnSelect')`; the store's `fire(nodeId, event, ctx)` runs the action formula through
`runFormula` in `/home/claude/appbuilder-demo/src/runtime/host.ts`. The host implements `FxHost`
(`setVar`, `updateContext`, `collect`, `clear`, `remove`, `patch`, `navigate`, `back`, `notify`, `form` operations, `select`, `setFocus`,
`launch`, `copy`, `trace`, `exit`, `refresh`) against a **copy** of the runtime state, so a failing chain leaves nothing half applied: on
success the result (`RunResult`: variables, context, collections, nav stack, toasts, outputs to merge, form modes, follow-up events,
deferred form submits, trace entries) is committed to the store in one update. Table writes (`Patch`, `Remove`, `Collect` into a
table, form submits) go to the platform. In server mode a form submit is **deferred**: the verdict arrives later, the store awaits it,
then writes `LastSubmit` or `Error` and fires `OnSuccess` or `OnFailure`. Design-time runs (`App.OnStart` while editing) set
`dryData` so no data is written.

**Data in formulas.** `src/runtime/data.ts` returns `platform.tables.rows(name)`. The row list for a table that is not loaded yet is
empty until `ensureTablesLoaded` (called from `linkPlatform()` for `app.dataSources`) brings it in; the store's `dataKey`
(`platformDataKey()`) changes whenever rows or table definitions change, which invalidates the `t:<name>` entries.

## Environments

An install has one or more environments (`docs/admin/environments.md`): the built-in Default and those an install administrator
creates. Each is a schema `env_<id>` (metadata and data tables) plus a folder `workspace/env/<id>/` (attachments, data files);
users, sessions, the registry (`ab.environments`), access (`ab.environment_access`) and the install audit (`ab.audit`) are in schema
`ab`.

- **Per request**: the browser sends `X-Appbuilder-Environment` with every call (`environmentHeaders()` in
  `src/platform/environments.ts`; attachment links carry `?env=`). The router reads it, the session resolver checks it against the
  user's access and reads the user's roles in that environment, and the handler runs inside `runInEnvironment()`. Everything below
  follows `currentEnvironment()`: MetaStore table names, the security cache, connector instances (`<env>:<connection>`), the default
  connection's schema, the attachment store and the data files folder (`ConnectorEnv.filesDir` is a getter on the current
  environment). See `schema.md` for the resolution rules.
- **Server modules**: `server/core/env-context.ts` (the context), `environments.ts` (registry and access cache, `resolveFor`, folders,
  the client's `EnvironmentDef`), `environment-ops.ts` (create, copy, update, delete, access), `install-store.ts` (schema `ab`
  repositories), `backup.ts` (the snapshot hook), `routes/meta/environments.ts` (API), `routes/meta/alm.ts` (solution plans,
  in-place upgrades, deploy).
- **Locked production**: the router refuses `DESIGN_ROUTES` (403) in a locked environment after auth, before the handler.
- **Client**: `platform.environments.select(id)` posts `/environments/:id/select`, switches the request header and reloads the
  workspace (rows of the old environment are dropped). The shell keys app tabs and recents by `<user>@<environment>` (Default keeps the
  user key), so tabs of another environment are unmounted on a switch; the top bar shows the environment's name and type colour, also
  in the Studio, which opens read-only (no autosave) in a locked environment. Admin pages: `src/portal/AdminEnvironments.tsx`,
  `src/portal/SolutionPlan.tsx`, calls in `src/portal/environmentApi.ts`.
- **Boot**: `migrate()` upgrades `ab` in one transaction, then each environment in its own (a failing one is marked failed); the
  built-in connections and the orphan-attachment sweep run per environment.

## Request lifecycles

### A query (read)

1. A formula such as `Filter(Tickets, Status = "Open")` resolves `Tickets` to `platform.tables.rows('Tickets')`.
2. In server mode the remote platform keeps a **lazy per-table cache**. For an unloaded table it returns `[]`, starts
   `POST /api/v1/query` with `{ plan: { version: 2, table: "Tickets", take: { n: 5000, from: "start" } } }` (Phase 3: the
   v1 read route is gone), and notifies subscribers when the rows arrive (the runtime's `dataKey`
   changes and formulas re-evaluate). If a write finished while the load was in flight, it re-reads (at most twice). The server's
   `truncated` flag is recorded so the UI can warn. `Filter`, `Sum`, `Sort` and the rest run in the browser over those rows.
3. **Server side** (`server/core/router.ts`, `data-routes.ts`, `data.ts`): the router checks Host, Origin and the session cookie,
   resolves the request's **environment** with the session (the header, checked against the user's access; see Environments
   above), loads the user's roles from that environment's cached roles, and runs the handler inside it; `dataRoutes` finds the table (404 if the user has no privilege on it at all);
   `DataService.query` validates the query, rejects columns the user may not read (403), ANDs the user's **row predicate** into
   `where`, narrows `select` to visible columns, asks the connector for `cap + 1` rows (cap 5000) to know whether to set `truncated`,
   and removes hidden columns from the output (`rowOut`). Dates leave as ISO text, numbers as numbers.
4. The browser converts dates to `Date` and adds `__id`. Focus events reload loaded tables older than 30 seconds.

### A write (insert, update, delete)

1. A UI component or formula calls `Patch(...)`, `Collect(...)`, a form submit, or the portal grid. This reaches
   `platform.tables.insert/update/delete`.
2. **Client pre-validation** (`src/platform/remote.ts`): required and unique columns, type coercion, and the **mirrored privileges**
   (`grantOf`, `rowOk`, `assertWritable`). A refusal throws `PlatformError` immediately and nothing changes.
3. **Optimistic apply**: the write becomes an `Op` on the table entry; the visible `rows` are recomputed as the confirmed rows with
   all in-flight ops replayed, and subscribers are notified. The UI changes at once. A new row gets a client-generated UUID `id`.
4. **Ordered send**: ops go through a serial promise chain, so the server sees writes in the order the maker made them
   (`POST .../rows`, `PATCH .../rows/:id`, `POST .../delete`).
5. **Server validation** (`data.ts`): coerces and validates every value (types, required, unique, lookup targets, attachments,
   column access), then the **RLS guard**: for update and delete the user's update or delete predicate is passed to the connector and
   applied atomically with the write (`WHERE id = ? AND <guard>`); `0` affected rows becomes 403 (the user can read the row) or 404.
   Insert needs the table's `create` privilege. Every successful write is written to `ab_audit`.
   Each write is one **unit of work** of the event and job kernel (`server/core/kernel.ts`, `events-and-jobs.md`): on the
   default database one transaction holding the before phase (table events, formula columns, validation rules: they may set
   columns or refuse with a 422 bound to a field), the change, the audit entry and the **outbox row**. After commit the outbox
   dispatcher turns the change into after-event and rollup jobs and notifies subscribers (realtime hub); the job worker runs
   them in the background.
6. **Success**: the server's row is folded into the confirmed rows (the optimistic row is replaced by what was really stored: server
   timestamps, autonumber, trimmed values) and the epoch advances.
7. **Failure (rollback)**: the op is dropped, the visible rows are recomputed without it (the optimistic change disappears) and a
   `DataErrorEvent { table, op, rowIds, error }` goes to `platform.onDataError` listeners. The runtime logs it and, in preview or the
   player, shows a toast with the server's message. A 401 anywhere (except from `/auth/login`) signs the user out.
8. `platform.tables.flush()` waits for the chain and rejects with the first error. Form submits await it so `OnSuccess` and `OnFailure`
   reflect the server's verdict.

Multi-row writes are all or nothing where the connector allows it: a multi-row delete checks every row's permission before deleting
(one transaction on PostgreSQL and MySQL), and a CSV import validates every row first and runs `replace` (delete + inserts) in one
transaction on the SQL connectors. On the files and Google Sheets connectors the delete and the insert remain two writes (see `connectors.md`).

### Sign-in

`POST /auth/login` verifies the scrypt hash (with a dummy comparison for unknown users), rotates the session, sets the `ab_session`
cookie and returns the `Session` including effective privileges. The client loads `GET /workspace` and shows the portal. Details in
`data-api.md`.

## Event and job kernel

`services.kernel` (`server/core/kernel.ts`) holds the job queue and worker (`jobs.ts`), schedules and cron (`cron.ts`), the
outbox (`outbox.ts`) and table events (`table-events.ts`, formulas in `event-fx.ts`). `createApp` starts the worker after boot
(option `jobs: false` for tests that drive it with `services.kernel.drain()`); `services.close()` stops it gracefully. One
worker per process serves every ready environment: each tick reaps jobs that lost their worker, runs the scheduler, dispatches
the outbox and claims due jobs (`FOR UPDATE SKIP LOCKED`); LISTEN `ab_jobs` / `ab_outbox` wakes it, polling is the fallback.
Every job runs inside its environment and as its identity. Admin console: Jobs and Events run log
(`src/portal/AdminJobs.tsx`); table designer: Validation rules, Formula columns, Rollups, Events (`src/portal/TableLogic.tsx`).
The request id and correlation id (`X-Request-Id` / `X-Correlation-Id` or generated; `work-context.ts`) travel from a request
into its outbox rows, jobs and run log entries.

## Server startup and shutdown

`server/main.ts` calls `createApp()` (`server/core/app.ts`), which builds the services (`services.ts`) and registers routes in this
order: auth, data, attachments, metadata routes. The router prefers the route with more literal segments; on a tie the first
registered wins. Requests starting with `/api` go to the router; everything else is served from `dist/` with an SPA fallback.

Configuration is by environment variable: `PORT` (5174), `APPBUILDER_HOST` (127.0.0.1), `APPBUILDER_WORKSPACE` (`./workspace`),
`APPBUILDER_SECRET_KEY` (64 hex characters; otherwise `workspace/.secret-key` is created), `APPBUILDER_ALLOWED_HOSTS` (extra
Host/Origin names), `APPBUILDER_SECURE_COOKIE=1` and `APPBUILDER_TRUST_PROXY=1` (Secure session cookie), and the optional
PostgreSQL bootstrap `APPBUILDER_DB_HOST/PORT (5432)/NAME/USER/PASSWORD/SSL` which skips the setup screen (and creates the
database if the role may). Without them the setup wizard calls `POST /setup/database` and the settings are saved to `workspace/server.json` with
the password sealed; `setupComplete: true` is added once the first administrator exists (`ServerConfig` in `contracts.ts`,
`loadConfig` in `config.ts`).

Boot (`services.boot()`, `app.ts`):

- A configured database that cannot be reached is never thrown: `state.unavailable` and `state.databaseError` are set,
  `GET /status` reports `setup.unavailable`, and a background timer retries with backoff (1 s doubling to 30 s,
  `retryDelayMs`) until it connects; `services.retrying()` exposes the pending retry (tests). Retrying stops for permanent
  problems (undecryptable password, incompatible schema) and on `close()`.
- A database whose schema version is above `SCHEMA_VERSION` is not used at all (`state.incompatible`, `SchemaTooNewError`):
  data routes answer 503, setup is refused, no retry.
- `migrate()` creates or completes schema `ab` in one transaction, then each environment schema in its own (a failing environment
  is marked failed, the others go on; `schema.md`); its summary is logged and audited (`schema.migrate`). Then the built-in
  connections of every ready environment are rewritten from the database settings, and an older install's `workspace/files` and
  `workspace/attachments` move into `workspace/env/default/`. A database with an old MySQL-era schema version, or not UTF8, is refused with a clear
  message.
- The system pool (`createPgDb` in `server/connectors/postgres/db.ts`, 10 connections) is shared by the MetaStore and the default
  connection (`conn_default`, through `ConnectorEnv.systemDb`); `services.transaction(fn)` runs a unit of work on it.
- While setup is needed (no `setupComplete`, or a database without users) a one-time setup code is generated
  (`services.setupCode`) and printed in a banner; `/setup/*` require it and are `loopbackOnly` routes (the router checks
  `req.socket.remoteAddress`). It rotates when the administrator is created. Tests pass `printSetupCode: false` to
  `createApp` and read `services.setupCode.current()`.

At boot the server also sweeps, in every ready environment, attachments that no row references (older than an hour, at most 5000 per
run) and purges expired sessions hourly. `SIGINT`/`SIGTERM` flush the files connector (every environment's folder), close
connections and the database pool, then exit.
`server.requestTimeout` is 10 minutes (large uploads).

## Packaging

- **Single-file build**: `npm run build` runs `tsc -b` (typecheck, no emit) and `vite build`. `vite-plugin-singlefile` inlines all
  JavaScript, CSS and the lazily loaded animated-icon modules into `dist/index.html` (about 3.8 MB). The server serves that file, so
  deploying the client is copying one file. The Vite config also mounts the API into `vite` and `vite preview` through
  `server/vite-plugin.mjs`, which loads the server core lazily so merely loading the config has no side effects.
- **Run it**: `npm run build`, then `npm start` (`node server/main.ts`). `npm run dev` runs Vite with the API mounted (hot reload).
  `scripts/setup-postgres.ps1` (Windows) and `scripts/setup-postgres.sh` (Linux) create the PostgreSQL role and database;
  `setup-offline.ps1` and `start.ps1` install and start the server on Windows.
- **Demo mode**: if `GET /api/v1/status` does not answer within 800 ms with `{ app: 'appbuilder' }`, the facade falls back to the demo
  platform (`src/platform/core.ts`), so the same `dist/index.html` also works when opened as a static file or hosted on any static
  web server. It seeds a sample workspace into IndexedDB (falling back to memory if IndexedDB fails), simulates roles for one person
  at the keyboard (**not a security boundary**), persists with a 300 ms debounce, and fails features that need the server (connections,
  data files, attachments, passwords) with "This needs the local server".
- **Packages**: apps and solutions export as YAML (`kind: appbuilder/app` or `appbuilder/solution`, `packageVersion: 1`), see
  `data-api.md`. An app package import creates new instances. A solution package carries stable ids: importing it where the
  solution or its components exist is an in-place upgrade after a confirmed plan (one transaction); `asCopy` and packages without
  a solution id create new instances.
- **Release package and installers** (P0 package L, `release-process.md`): `npm run release` builds a self-contained,
  reproducible folder and ZIP (the web app, the server sources it imports, production `node_modules`, installers,
  `SHA256SUMS`, optionally an Ed25519 signature). `scripts/install/windows/install.ps1` and `scripts/install/linux/install.sh`
  install Node.js, PostgreSQL and the service (WinSW / systemd) and optionally Caddy for HTTPS; `appbuilder update` swaps
  the app folder and rolls back on a failed health check (`server/core/update/`). Health, the rotating JSON file log,
  usage and the diagnostics bundle live in `server/core/diagnostics/`.
- Not packaged: a Docker image, MSI/WinGet packages, a PHP gateway (planned).

## Where to read next

`data-api.md` (the HTTP contract), `live.md` (the realtime WebSocket), `schema.md` (tables), `security-engine.md`, `connectors.md`,
`frontend.md` (extending the client), `testing.md`.
