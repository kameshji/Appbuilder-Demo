# Power Apps

Research date: 18 November 2026. Sources are Microsoft Learn pages retrieved on that date. Opinions are labelled *inference*; unconfirmed claims are labelled *unverified*.

Appbuilder's Studio is already a canvas-app builder. This file focuses on what we can learn from Microsoft's two app types, and what the next layers (model-driven generation, delegation, components, offline, versioning, co-authoring, debugging) should look like on our stack.

## 1. Two app types

| | Canvas app | Model-driven app |
|---|---|---|
| Starting point | A blank screen; the maker places controls and writes formulas | The data model; the app is assembled from table metadata |
| Layout | Maker-controlled (absolute positions, or auto-layout containers) | Generated, responsive, consistent across apps |
| Logic | Power Fx in every property | Business rules, JavaScript on forms, plug-ins, flows |
| Data | Any connector (Dataverse, SharePoint, SQL, Excel...) | Dataverse only |
| Strength | Pixel control, task-specific UIs, mobile | Many tables, many records, back-office CRUD, consistency |
| Security | Data source security plus app sharing | Dataverse security roles; app access granted by role |

Microsoft describes model-driven apps as a selection of Dataverse components (tables, charts, dashboards) delivered together with security roles so the same app can serve several departments ([interface design overview](https://learn.microsoft.com/power-apps/maker/model-driven-apps/app-interface-design-overview)). The two worlds meet through **custom pages** (a canvas page inside a model-driven app) and canvas components reused there ([canvas components](https://learn.microsoft.com/power-apps/maker/canvas-apps/create-component)).

## 2. How model-driven apps are generated from metadata

A model-driven app is a record (`appmodule`) listing *components*. The glossary splits components into data (tables, relationships, columns), UI (site map, forms, views), logic (flows, business process flows, business rules) and visualisation (charts, dashboards, Power BI tiles) ([glossary](https://learn.microsoft.com/power-apps/maker/model-driven-apps/model-driven-app-glossary#component)).

| Component | Stored as | What it defines |
|---|---|---|
| Site map | XML per app | Navigation: areas → groups → subareas; each subarea points at a table, dashboard, URL or custom page ([create app / site map](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-edit-app#configure-the-site-map)) |
| Form | `systemform`, XML layout | Tabs → sections → columns/fields, subgrids, quick views; types main, quick create, quick view, card |
| View | `savedquery`, FetchXML + layout XML | Column list, sort, filter for a grid; public views, personal views |
| Chart | `savedqueryvisualization` | Aggregation over a view (bar, line, pie, funnel...) |
| Dashboard | `systemform` of type dashboard | Grid of charts, views, Power BI tiles |
| Business process flow | Its own table per BPF | Stages with required steps shown as a bar across the top of the form |
| Command bar | Ribbon XML / modern commanding with Power Fx | Buttons on grids and forms |

When the app opens, the client (Unified Interface) reads this metadata and renders grids, forms and navigation generically; every table gets list, form, search, sort, filter, bulk edit, export to Excel, and related-record tabs for free. By default all of a table's forms, views, charts and dashboards are included when the table is added to the app, and the maker unticks what they don't want ([create app](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-edit-app#configure-the-site-map)). App components can also be added and removed through the `AddAppComponents` / `RemoveAppComponents` Web API actions ([model-driven apps by code](https://learn.microsoft.com/power-apps/developer/model-driven-apps/create-manage-model-driven-apps-using-code#add-or-remove-components-from-your-model-driven-app)). The classic app, form and view designers were deprecated in October 2023 in favour of modern designers ([add/edit components](https://learn.microsoft.com/power-apps/maker/model-driven-apps/add-edit-app-components)).

**Business process flows** guide a user through stages (for example Qualify → Develop → Propose → Close), each with steps that may be required before moving on. Each BPF is backed by its own Dataverse table holding the active stage and traversed path per record; a BPF missing its table breaks solution import ([web service errors](https://learn.microsoft.com/power-apps/developer/data-platform/reference/web-service-error-codes#microsoft-dataverse-errors)).

*Inference*: the model-driven idea — "a table should come with a decent list and form without anyone designing them" — is the most valuable thing here for a small company. The XML-heavy implementation is not.

## 3. Power Fx

Power Fx is a strongly typed, declarative, functional language with Excel syntax. Properties are cells whose formulas recalculate automatically, and the same language is used imperatively in behaviour properties such as `OnSelect` ([Power Fx overview](https://learn.microsoft.com/power-platform/power-fx/overview)). Microsoft is extracting it from canvas apps into an open-source repository and reusing it in Dataverse formula columns, low-code plug-ins/functions, Copilot Studio, model-driven commanding and Power Pages. Appbuilder's Fx (decision D3) follows the same design.

## 4. Delegation and its limits

This is the biggest design lesson in Power Apps.

- A formula over a data source is **delegated** when Power Fx can translate it into the source's query language. If **any** part of the expression is not translatable, **none** of it is delegated ([delegation overview](https://learn.microsoft.com/power-apps/maker/canvas-apps/delegation-overview)).
- A non-delegated query fetches the first **500** rows (configurable 1 to **10,000** under "Data row limit") and evaluates locally. Results can therefore be silently wrong: a `Filter` won't find row 501; an `Average` averages the first 500 rows ([nondelegable limits](https://learn.microsoft.com/power-apps/maker/canvas-apps/delegation-overview#nondelegable-limits)).
- Studio shows a warning (blue underline / yellow triangle) only when it detects a non-delegable formula. Microsoft's own advice is to set the limit to 1 while testing so problems become visible.
- What delegates depends on the connector. Never-delegable functions include `FirstN`, `Last`, `LastN`, `Choices`, `Concat`, `Collect`/`ClearCollect`, `GroupBy`/`Ungroup` ([query limitations](https://learn.microsoft.com/power-apps/maker/canvas-apps/delegation-overview#query-limitations)). `UpdateIf`/`RemoveIf` only simulate delegation up to the row limit.
- Dataverse-specific: `CountRows` returns a cached value, aggregates are limited to 50,000 rows, `FirstN` unsupported, `In` limited by a 15-table join limit ([Dataverse connector](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections/connection-common-data-service#power-apps-delegable-functions-and-operations-for-dataverse)).
- SharePoint-specific: `IsBlank` doesn't delegate but `= Blank()` does (with different semantics for empty strings); `StartsWith` on lookup subfields doesn't ([SharePoint connector](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections/connection-sharepoint-online#power-apps-delegable-functions-and-operations-for-sharepoint)).
- Excel connector: effectively the row limit, nothing delegates ([performance considerations](https://learn.microsoft.com/power-apps/maker/canvas-apps/app-performance-considerations#specific-data-sources)).
- Delegated galleries page in chunks of 100 rows ([small data payloads](https://learn.microsoft.com/power-apps/maker/canvas-apps/small-data-payloads#use-delegation)).

Appbuilder today: up to 5,000 rows per table loaded into the browser, filtered in memory, truncation warning (D10). Same class of problem, at a larger limit.

## 5. Components

| Kind | Who builds it | How | Scope |
|---|---|---|---|
| Canvas component | Maker | Built in Studio from controls, with custom input/output properties | One app, or many through a **component library** (a special app whose components others import; updates are offered to consuming apps) ([canvas components](https://learn.microsoft.com/power-apps/maker/canvas-apps/create-component)) |
| Code component (PCF) | Developer | TypeScript class + `ControlManifest.Input.xml` declaring namespace, type `field` or `dataset`, properties and resources; lifecycle `init`, `updateView`, `getOutputs`, `destroy`; built with the Power Platform CLI (`pac pcf init`) and shipped in a solution ([code components](https://learn.microsoft.com/power-apps/developer/component-framework/custom-controls-overview)) | Model-driven and canvas apps |

PCF details: a dataset component gets records, sorted ids, column metadata and paging from the host; `notifyOutputChanged` tells the host new outputs are ready; updates require bumping the manifest version and the maker reopening the app ([canvas code components](https://learn.microsoft.com/power-apps/developer/component-framework/component-framework-for-canvas-apps#update-existing-code-components), [dataset sample](https://learn.microsoft.com/power-apps/developer/component-framework/sample-controls/data-set-component-canvas)). Custom events beyond `OnChange` are listed as a future feature in the tutorial ([tutorial](https://learn.microsoft.com/power-apps/developer/component-framework/tutorial-create-canvas-dataset-component#define-the-dataset-properties)).

## 6. Offline

- Works only in the native **Power Apps Mobile** players (iOS, Android, Windows); canvas apps in a browser cannot run offline ([offline apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/offline-apps)).
- For Dataverse apps: **offline-first** — once enabled, the app always reads and writes a local copy and syncs in the background with conflict detection, even when online ([offline overview](https://learn.microsoft.com/power-apps/mobile/canvas-mobile-offline-overview)).
- An **offline profile** says which tables and which rows (user's rows, team rows, BU rows, related rows, custom filter) to download, with a sync interval per table; each table may link to at most 15 others ([setup](https://learn.microsoft.com/power-apps/mobile/canvas-mobile-offline-setup#create-an-offline-profile)).
- Not supported offline: non-Dataverse connectors (SharePoint etc.), virtual and elastic tables, Power Automate flows, embedded apps, custom pages, apps in Teams ([limitations](https://learn.microsoft.com/power-apps/mobile/limitations-canvas-apps)).
- Non-Dataverse apps get `SaveData`/`LoadData` to device storage (1 MB in Teams).

## 7. Sharing, versioning, publishing

- Every save creates a version; one version is **Live**. Restoring an old version creates a new version, which must then be published ([save and publish](https://learn.microsoft.com/power-apps/maker/canvas-apps/save-publish-app#identify-and-manage-app-versions), [restore](https://learn.microsoft.com/power-apps/maker/canvas-apps/restore-an-app)).
- Users with the app open get "a new version is coming" and "refresh to use the latest version" notifications on the web, but not in Teams, Power BI, SharePoint forms or web parts ([in-app notifications](https://learn.microsoft.com/power-apps/maker/canvas-apps/save-publish-app#in-app-notifications-for-new-versions)).
- **Sharing** a canvas app grants run (user) or edit/re-share (co-owner) to people or Entra security groups. It does not share the data: the maker must separately grant Dataverse roles, Excel/SharePoint permissions, flows, gateways and connections ([share app](https://learn.microsoft.com/power-apps/maker/canvas-apps/share-app)). Model-driven apps are shared through security roles.
- **Source**: canvas apps are stored as `.msapp` packages; Git integration exports human-readable `.pa.yaml` files (`App.pa.yaml`, one per screen, one per component) on publish; only `.pa.yaml` under `\Src` is stable for source control ([canvas Git integration](https://learn.microsoft.com/power-platform/alm/git-integration/canvas-apps-git-integration)).

## 8. Responsive layout

Canvas apps default to a fixed design size with "scale to fit". For responsive apps Microsoft says: turn off scale-to-fit, lock aspect ratio and lock orientation, and build with **horizontal and vertical auto-layout containers** (children don't set X/Y; space is divided by "fill portions", alignment can stretch); use `Parent.Width`-style formulas and the screen's `Size` breakpoints (`ScreenSize.Small` 1 to `ExtraLarge` 4) ([responsive layouts](https://learn.microsoft.com/power-apps/maker/canvas-apps/create-responsive-layout#adapting-layout-for-device-size-and-orientation), [building responsive apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/build-responsive-apps#auto-layout-containers), [guidelines](https://learn.microsoft.com/power-apps/guidance/coding-guidelines/responsive-design-guidelines)). Appbuilder already has anchors and auto-layout containers (D4).

## 9. Co-authoring

Two modes ([coauthoring](https://learn.microsoft.com/power-apps/maker/canvas-apps/copresence-power-apps-studio)):

- **Copresence** (default): you see who else has the app open; only the first person can edit.
- **Coauthoring** (opt-in per app): real-time multi-editor with avatars on the tree view and controls; up to 10 coauthors. While several makers edit, search, save-as, undo/redo, cut and version switching are disabled; renames, copy/paste and AI/geospatial controls can misbehave; two people can edit the same control and overwrite each other; the locale is locked to the first editor's.

Appbuilder today: last write wins, no presence (architecture.md).

## 10. Monitor and diagnostics

**Live monitor** streams events from a Studio session or a published app session: formula evaluations, network requests with size and duration, errors, throttling, and for model-driven apps page loads with custom script time attribution ([Live monitor overview](https://learn.microsoft.com/power-apps/maker/monitor-overview), [canvas](https://learn.microsoft.com/power-apps/maker/monitor-canvasapps), [model-driven](https://learn.microsoft.com/power-apps/maker/monitor-modelapps#events-monitored)). A maker can join a user's session to see what they see. Studio also has an **App checker** for formula errors and accessibility, and a variables panel ([isolate issues](https://learn.microsoft.com/troubleshoot/power-platform/power-apps/create-and-use-apps/isolate-canvas-app-issues)).

## How to replicate on our stack (single Node server + MySQL)

### A. "Auto apps": model-driven generation without XML

Add a second app kind, `kind: 'auto'`, whose definition is a small JSON document instead of screens:

```jsonc
{
  "kind": "auto", "name": "Quality", "theme": {...},
  "nav": [ { "group": "Inspections", "items": [ { "table": "Inspections", "view": "open" }, { "table": "NCRs" } ] },
           { "group": "Reports", "items": [ { "dashboard": "qc-overview" } ] } ],
  "tables": { "Inspections": { "views": ["open", "all"], "form": "default", "bpf": "inspection-stages" } }
}
```

and per-table UI metadata stored on `TableDef` (or a new `ab_table_ui` table):

| Microsoft | Ours | Notes |
|---|---|---|
| View (`savedquery`) | `views: [{ id, name, columns, sort, filter: RowCondition[] }]` | Reuse `RowCondition` (already used for RLS) as the filter language; server applies it ANDed with RLS |
| Main form | `form: { sections: [{ title, columns: 1|2, fields: [...] }], related: [{ table, lookup }] }` | Generated by default from column order; editable by drag-and-drop |
| Quick create | Same form schema with `compact: true` | |
| Chart, dashboard | See `power-bi-lite.md` | |
| Site map | `nav` above | |
| Business process flow | `stages: [{ name, requiredFields, entryCondition }]` on the table, stage stored in a system column `_stage` | Simple; no separate table per BPF |
| Command bar | `commands: [{ label, icon, fx, visibleFx }]` using our Fx | |

The runtime renders auto apps with a fixed set of generic React screens (list, form, dashboard) using the existing controls (data table, form, charts), so the **same security, attachments and formula engine** apply. Crucially, offer **"Convert to canvas"**: generate a canvas `AppDef` from the auto app so makers can customise beyond the generic layout. This gives makers a 5-minute app on day one and the Studio when they outgrow it — which Microsoft never offers (canvas and model-driven are separate worlds joined only through custom pages).

### B. Delegation (replaces D10)

Build the Query AST that D10 anticipates:

1. `fx` gets a `toQuery(expr, tableSchema)` pass that walks `Filter`, `Sort`, `SortByColumns`, `Search`, `LookUp`, `First`, `CountRows`, `CountIf`, `Sum`/`Average`/`Min`/`Max`, `Distinct`, `FirstN`, `GroupBy` over a platform table and produces `{ where, orderBy, top, select, aggregate, groupBy }`, the same JSON the `/data/:table/query` endpoint already accepts (extend it).
2. Predicates: comparisons, `And`/`Or`/`Not`, `in` lists, `StartsWith`, `EndsWith`, `in` substring, `IsBlank`, date functions on columns (`Year(Date)`), arithmetic on columns, and **any sub-expression that doesn't reference `ThisRecord`** (evaluated client-side to a constant first). That covers almost everything makers write.
3. Since we own both ends (one SQL dialect family: MySQL/MariaDB), we can delegate far more than Microsoft does across 1,000 connectors, including `GroupBy`, `Distinct`, `FirstN`, `Concat` (as `GROUP_CONCAT`) and lookups (`LookUp(Customers, Id = ThisRecord.CustomerId).Name` → `JOIN`).
4. For the files and Google Sheets connectors, run the same AST in the connector in memory over the full data set (they're small), so results are never silently partial.
5. Make non-delegable cases **errors in Studio, not warnings**, unless the table is known small (< row cap) or the maker explicitly wraps it in `Local(...)`. Show the generated query in the Monitor.
6. Galleries and data tables page through `nextCursor` (see `dataverse.md`) in chunks of 100.

### C. Components

- **Canvas components** (low-code): a `ComponentDef` in `AppDef.components[]` with custom input properties (data/function kinds), output properties and events, rendered by `RenderNode` like a container. **Component libraries** = components in a solution, versioned; consuming apps pin a version and get an "update available" prompt.
- **Code components**: a manifest JSON (`name, version, properties: PropMeta[], events, dataset?: boolean`) plus an ES module default-exporting a React component `({ props, dataset, emit, platform }) => JSX`. Loaded from `workspace/components/<name>@<version>/index.js`, sandboxed in an iframe unless signed by an admin. Distributed in solutions. This reuses our control registry contract (`PropMeta`, `ControlType`) instead of inventing a second lifecycle like PCF's `init/updateView/getOutputs/destroy`.

### D. Offline (later)

Offline matters for the shop floor (see sector research). The cleanest path: an **offline profile per app** = list of tables with a `RowCondition[]` filter; the runtime stores those rows in IndexedDB (we already have IndexedDB code in demo mode), queues writes as the existing optimistic `Op`s, and replays them through the same ordered send chain when online. Conflict rule: server `modified_on` check per row; conflicts surface in a "sync issues" panel. Use the change feed endpoint for incremental download. Works in a browser/PWA and in the planned Capacitor shell — unlike Microsoft, which requires the native player.

### E. Versions, publishing, sharing

- `ab_app_versions(app_id, version_no, definition, saved_by, saved_on, published)`; `ab_apps.published_version`. Players load the published version; Studio loads the latest draft. Restore = copy an old version into a new draft. Keep the last N (e.g. 50) versions plus all published ones.
- Notify open players over the existing session (SSE or polling `/apps/:id/version`) — "A new version is available, reload".
- Sharing: app access is already role-based (`ab_roles.apps`). Keep it: **sharing an app = picking roles**, and the share dialog shows the table privileges those roles grant and warns if the app uses a table the role can't read. One place, not five.
- Source control: our app definition is already JSON/YAML text; export `app.yaml` plus one file per screen in solution exports for clean diffs.

### F. Co-authoring

Don't build full real-time co-authoring yet. Build **copresence with a lock**: `ab_app_locks(app_id, user_id, since, heartbeat)`; the second maker opens read-only with "Kamal is editing — request control". Saves check the base version and refuse a stale write (fixes last-write-wins). Real-time merge (CRDT over the app JSON) can come much later if ever; Microsoft's own feature disables undo and search while active, which shows how hard it is.

### G. Monitor

Add a Monitor panel to Studio and an opt-in "debug session" for the player: the runtime already records `trace` entries and every platform call goes through `src/runtime/data.ts` and `remote.ts`. Stream events (formula evaluated with duration, data query with generated query and row count, write with server verdict, navigation, errors) to a side panel; for a published app, a user can click "Share session with maker" which relays events through the server over SSE. Include an App checker: unused variables, non-delegable formulas, controls without accessible labels, screens unreachable by `Navigate`.

## Where we can be better for a 20-50 person org

| Microsoft pain point | Evidence | Better design |
|---|---|---|
| Two app types that don't convert; a small business must pick canvas (flexible, slow to build) or model-driven (fast, Dataverse-only, premium) up front | [Model-driven design](https://learn.microsoft.com/power-apps/maker/model-driven-apps/app-interface-design-overview) | Auto apps with one-click "convert to canvas", same data and security |
| Delegation silently returns partial results; warnings depend on connector; 500/10,000-row cliffs | [Delegation overview](https://learn.microsoft.com/power-apps/maker/canvas-apps/delegation-overview) | One SQL backend, broad delegation, errors not warnings, cursor paging |
| Sharing the app doesn't share data; makers must align roles, connections, flows, gateways separately | [Share app](https://learn.microsoft.com/power-apps/maker/canvas-apps/share-app) | Access by role; the share dialog validates table access |
| Offline only in native mobile players and Dataverse only | [Offline apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/offline-apps), [limitations](https://learn.microsoft.com/power-apps/mobile/limitations-canvas-apps) | IndexedDB-based offline in the browser/PWA and shell, on our tables |
| Co-authoring disables undo and search, risks overwrites | [Coauthoring limitations](https://learn.microsoft.com/power-apps/maker/canvas-apps/copresence-power-apps-studio#limitations-of-coauthoring) | Lock-based single editor with stale-write protection; simple and safe |
| Code components need the CLI, an XML manifest, a solution import and an app reopen to update | [Code components](https://learn.microsoft.com/power-apps/developer/component-framework/custom-controls-overview) | Drop an ES module + JSON manifest into a component folder or solution; hot-reload in Studio |
| Model-driven UI defined in XML (FormXml, FetchXML, ribbon XML, site map XML) | [App components](https://learn.microsoft.com/power-apps/maker/model-driven-apps/add-edit-app-components) | JSON metadata, our own condition language, Fx for commands |

**Not worth replicating**: business process flows as separate tables per process, multiple form types (main/quick create/quick view/card) beyond main + compact, personal views at first, ribbon XML, the "scale to fit" phone canvas (we're desktop-first by D4), `SaveData`/`LoadData` device storage APIs, `.msapp` packaging, environment-specific "Live monitor session joining" infrastructure beyond a simple relay.

**Worth copying**: Power Fx's spreadsheet model (done), auto-layout containers (done), component libraries with versioned updates, the "set the row limit to 1 while testing" trick (as a Studio toggle "Strict delegation"), version history with Live marker, offline profiles as declarative filters, Monitor's per-request view.

## Sources

- [Model-driven app interface design overview](https://learn.microsoft.com/power-apps/maker/model-driven-apps/app-interface-design-overview)
- [Model-driven app glossary](https://learn.microsoft.com/power-apps/maker/model-driven-apps/model-driven-app-glossary)
- [Add or edit model-driven app components](https://learn.microsoft.com/power-apps/maker/model-driven-apps/add-edit-app-components)
- [Create a model-driven app (classic) / site map](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-edit-app)
- [Design model-driven apps (classic app designer)](https://learn.microsoft.com/power-apps/maker/model-driven-apps/design-custom-business-apps-using-app-designer)
- [Create and manage model-driven apps using code](https://learn.microsoft.com/power-apps/developer/model-driven-apps/create-manage-model-driven-apps-using-code)
- [Web service error codes (BPF entities)](https://learn.microsoft.com/power-apps/developer/data-platform/reference/web-service-error-codes)
- [Power Fx overview](https://learn.microsoft.com/power-platform/power-fx/overview)
- [Delegation overview](https://learn.microsoft.com/power-apps/maker/canvas-apps/delegation-overview)
- [Understand data sources for canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/working-with-data-sources)
- [Connect to Dataverse (delegation)](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections/connection-common-data-service)
- [Connect to SharePoint (delegation)](https://learn.microsoft.com/power-apps/maker/canvas-apps/connections/connection-sharepoint-online)
- [App performance considerations](https://learn.microsoft.com/power-apps/maker/canvas-apps/app-performance-considerations)
- [Small data payloads](https://learn.microsoft.com/power-apps/maker/canvas-apps/small-data-payloads)
- [Canvas component overview](https://learn.microsoft.com/power-apps/maker/canvas-apps/create-component)
- [Code components](https://learn.microsoft.com/power-apps/developer/component-framework/custom-controls-overview)
- [Manifest element](https://learn.microsoft.com/power-apps/developer/component-framework/manifest-schema-reference/manifest)
- [Code components for canvas apps](https://learn.microsoft.com/power-apps/developer/component-framework/component-framework-for-canvas-apps)
- [Canvas dataset component tutorial](https://learn.microsoft.com/power-apps/developer/component-framework/tutorial-create-canvas-dataset-component)
- [Dataset component sample](https://learn.microsoft.com/power-apps/developer/component-framework/sample-controls/data-set-component-canvas)
- [Develop offline-capable canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/offline-apps)
- [Mobile offline for canvas apps overview](https://learn.microsoft.com/power-apps/mobile/canvas-mobile-offline-overview)
- [Set up mobile offline](https://learn.microsoft.com/power-apps/mobile/canvas-mobile-offline-setup)
- [Mobile offline limitations](https://learn.microsoft.com/power-apps/mobile/limitations-canvas-apps)
- [Save and publish canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/save-publish-app)
- [Restore a canvas app](https://learn.microsoft.com/power-apps/maker/canvas-apps/restore-an-app)
- [Share a canvas app](https://learn.microsoft.com/power-apps/maker/canvas-apps/share-app)
- [Source control for canvas apps](https://learn.microsoft.com/power-platform/alm/git-integration/canvas-apps-git-integration)
- [Create responsive layouts](https://learn.microsoft.com/power-apps/maker/canvas-apps/create-responsive-layout)
- [Building responsive canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/build-responsive-apps)
- [Responsive design guidelines](https://learn.microsoft.com/power-apps/guidance/coding-guidelines/responsive-design-guidelines)
- [Coauthoring and copresence](https://learn.microsoft.com/power-apps/maker/canvas-apps/copresence-power-apps-studio)
- [Live monitor overview](https://learn.microsoft.com/power-apps/maker/monitor-overview)
- [Debugging canvas apps with Live monitor](https://learn.microsoft.com/power-apps/maker/monitor-canvasapps)
- [Debug a model-driven app with Live monitor](https://learn.microsoft.com/power-apps/maker/monitor-modelapps)
- [Isolate issues in canvas apps](https://learn.microsoft.com/troubleshoot/power-platform/power-apps/create-and-use-apps/isolate-canvas-app-issues)
