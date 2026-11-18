# Power BI, the parts a small organisation uses

Research date: 18 November 2026. Sources are Microsoft Learn pages retrieved on that date. Opinions are labelled *inference*; unconfirmed claims are labelled *unverified*.

This file covers only what a 20-50 person organisation realistically touches: a semantic model, refresh, measures, reports and dashboards, row-level security and embedding in apps — plus the separate, simpler charts and dashboards inside model-driven apps, because that's the model for Appbuilder's planned dashboards.

## 1. Semantic model

A **semantic model** (formerly "dataset"; the REST API still says datasets ([refresh data](https://learn.microsoft.com/power-bi/connect-data/refresh-data#understanding-data-refresh))) is the layer between sources and reports: tables, relationships, measures, calculated columns, hierarchies, formatting, and security roles. Reports bind to exactly one semantic model; dashboards can pin tiles from several ([reports vs dashboards](https://learn.microsoft.com/power-bi/explore-reports/end-user-reports#dashboards-versus-reports)).

### Storage modes

From [semantic model modes](https://learn.microsoft.com/power-bi/connect-data/service-dataset-modes-understand#directquery-mode) and [DirectQuery](https://learn.microsoft.com/power-bi/connect-data/desktop-directquery-about#directquery-use-cases):

| Mode | How it works | Good for | Limits |
|---|---|---|---|
| Import | Data is copied into an in-memory columnar model at refresh | Fast visuals, full DAX | Stale between refreshes; model size limits; scheduled refresh caps |
| DirectQuery | Only metadata stored; each visual sends native queries to the source | Near-real-time, very large data, source-enforced security via SSO | Only DAX/Power Query that translates to source queries; no calculated tables; source load and latency on every interaction |
| Dual (table level) | Table can be served from memory or by DirectQuery per query | Dimension tables in composite models | |
| Composite | Mix import, DirectQuery, Dual (and Direct Lake) tables in one model; typical pattern: dimensions Import/Dual, facts DirectQuery ([composite models](https://learn.microsoft.com/power-bi/transform-model/desktop-composite-models)) | | Limited relationships across sources in some combinations |
| Direct Lake | Fabric/OneLake Delta tables read directly without import ([Direct Lake web modeling](https://learn.microsoft.com/fabric/fundamentals/direct-lake-web-modeling#composite-semantic-models-with-direct-lake-and-import-storage-mode-tables)) | Fabric customers | Requires Fabric capacity; irrelevant for our market |

### Refresh

- Shared capacity (Pro): **8 scheduled refreshes per day**, quota includes API-triggered refreshes, resets at 12:01 local time; manual "Refresh now" doesn't count; each refresh must finish within **2 hours** ([refresh data](https://learn.microsoft.com/power-bi/connect-data/refresh-data#understanding-data-refresh)).
- Premium / PPU / Fabric capacity: **48 scheduled refreshes** per day, 5-hour limit, effectively unlimited via XMLA.
- DirectQuery dashboard tiles can refresh as often as every 15 minutes; automatic page refresh is available for DirectQuery reports.
- On-premises sources need the on-premises data gateway (see `connectors.md`).

## 2. Measures and DAX (concept level)

**DAX** has 200+ functions, Excel-like syntax, but is designed for relational models ([measures](https://learn.microsoft.com/power-bi/transform-model/desktop-measures#report-level-measures)).

| Concept | Meaning |
|---|---|
| Calculated column | Row-by-row expression, computed at refresh and stored; usable in slicers, axes, filters ([calculation options](https://learn.microsoft.com/power-bi/transform-model/desktop-calculations-options#calculated-columns-dax)) |
| Measure | Aggregation evaluated at query time, never stored; result depends on context; usable only as values or visual-level filters |
| Row context | "The current row" during a calculated column or iterator |
| Filter context | The set of allowed values per column coming from slicers, visual axes, report filters, relationships and formula filters; `CALCULATE` evaluates an expression in a modified filter context; `ALL`/`ALLEXCEPT` remove filters to compute totals and shares ([DAX overview](https://learn.microsoft.com/dax/dax-overview#context), [DAX basics](https://learn.microsoft.com/power-bi/transform-model/desktop-quickstart-learn-dax-basics#let's-begin)) |
| Quick measures | Generated DAX from dialogs for common calculations |

The key idea for us: a **measure is a named aggregation that the visual's grouping and the page's filters re-evaluate automatically**. One definition (`Total Sales = SUM(Sales[Amount])`) works in a card, a bar chart by month and a table by customer.

## 3. Reports vs dashboards

| | Report | Dashboard |
|---|---|---|
| Pages | One or more | One |
| Sources | One semantic model | Tiles from many reports/models |
| Interactivity | Filters, slicers, cross-highlighting, drill-down | None (focus mode per tile, unsaved) |
| Alerts | No | Yes, on certain tiles |
| Q&A natural language | With edit rights | Usually yes |
| Built in | Power BI Desktop or service | Service only, by **pinning** visuals or report pages |

Source: [dashboards for designers](https://learn.microsoft.com/power-bi/create-reports/service-dashboards#dashboards-versus-reports), [dashboards for business users](https://learn.microsoft.com/power-bi/explore-reports/end-user-dashboards#dashboards-vs-reports-for-power-bi-business-users).

## 4. Row-level security in the model

- Roles defined in Power BI Desktop with a **DAX filter per table**, e.g. static `[Region] = "West"` or dynamic `[UserEmail] = USERPRINCIPALNAME()` against a user-mapping table; filters propagate through relationships ([RLS](https://learn.microsoft.com/fabric/security/service-admin-row-level-security#define-roles-and-rules-in-power-bi-desktop)).
- Users are assigned to roles in the service, not in Desktop.
- **RLS applies only to workspace Viewers**; Admins, Members and Contributors have edit rights and are **not** filtered ([RLS in workspaces](https://learn.microsoft.com/fabric/security/service-admin-row-level-security#validate-the-role-within-the-power-bi-service)).
- Users not in any role see no data.
- "Test as role" uses your own identity, so it can't simulate another user's `USERPRINCIPALNAME()`; B2B guests may return different UPN formats; service-principal embedding returns the app id, not the user ([dynamic RLS considerations](https://learn.microsoft.com/fabric/security/service-admin-row-level-security#considerations-and-limitations-for-dynamic-rls)).
- Microsoft's guidance warns to write expressions that return **no rows** for unexpected identity values, because embedding apps can pass any string as effective identity ([RLS guidance](https://learn.microsoft.com/power-bi/guidance/rls-guidance#validate-roles)).
- For embedding "app owns data", the app passes an effective identity and roles in the embed token ([embed with RLS](https://learn.microsoft.com/power-bi/developer/embedded/cloud-rls#when-to-use-static-and-dynamic-security)).

*Inference*: this is a **second, separate** security model that must be kept in sync with Dataverse roles by hand. Data imported into a semantic model no longer carries Dataverse row security.

## 5. Embedding in apps

- Model-driven apps: Power BI **system dashboards** (embedded pages), reports embedded in **system forms** with contextual filtering by the current record, and users can pin Power BI tiles/dashboards to personal dashboards once an admin enables "Power BI visualization embedding" (off by default) ([use Power BI in model-driven apps](https://learn.microsoft.com/power-apps/maker/model-driven-apps/use-power-bi), [admin setting](https://learn.microsoft.com/power-platform/admin/use-power-bi)).
- Canvas apps: a Power BI tile control and a Power BI connector ([use Power BI](https://learn.microsoft.com/power-apps/maker/model-driven-apps/use-power-bi)).
- Viewers need Power BI licences (or the content must be in Premium/Fabric capacity) — licence specifics weren't on the pages fetched (*unverified*).

## 6. Model-driven charts and dashboards (Dataverse-native)

A different, simpler system inside Dataverse:

| | Model-driven charts/dashboards | Power BI |
|---|---|---|
| Data | Live Dataverse views (FetchXML), **respecting Dataverse security** for each user | Imported or DirectQuery semantic model with its own RLS |
| Chart definition | `savedqueryvisualization` (system) / `userqueryvisualization` (personal): aggregate + group-by over a view ([visualizations](https://learn.microsoft.com/power-apps/developer/model-driven-apps/view-data-with-visualizations-charts#web-resource-visualizations)) | DAX measures, Power Query |
| Placement | On grids (chart pane next to the view, cross-filtering the grid), forms, dashboards ([charts and grids](https://learn.microsoft.com/power-apps/developer/model-driven-apps/customize-visualizations-dashboards)) | Reports, dashboards, embeds |
| Limits | Charts over views up to **50,000 rows** ([system chart limits](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-edit-system-chart#maximum-number-of-records-displayed-in-a-chart)); dashboards up to **20 controls** (6 recommended for standard dashboards) | Model size, refresh caps |
| Dashboards | System (org-owned `SystemForm`, solution-aware) and personal (`UserForm`, shareable, but contained personal charts/views must be shared separately) ([dashboards](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-edit-dashboards), [analyze data with dashboards](https://learn.microsoft.com/power-apps/developer/model-driven-apps/analyze-data-with-dashboards), [user guide](https://learn.microsoft.com/power-apps/user/track-your-progress-with-dashboard-and-charts)) | |
| Interactive dashboards | Multi-stream or single-stream; charts act as **visual filters** over streams; global and time-frame filters ([interactive dashboards](https://learn.microsoft.com/power-apps/user/interactive-dashboards), [configure](https://learn.microsoft.com/power-apps/maker/model-driven-apps/configure-interactive-experience-dashboards#dashboard-charts)) | |
| Authoring | Chart designer in the app; FormXML for dashboards | Power BI Desktop (Windows) |

*Inference*: for a 30-person manufacturer, model-driven-style charts (live, secure, simple) cover most daily needs: OEE by line this week, open NCRs by severity, breakdowns by machine. Power BI is valuable for the monthly MIS deck and multi-source analysis — and the owner may already use Excel pivots for that.

## How to replicate on our stack (single Node server + MySQL)

### Principle: one security model, live queries, a light semantic layer

Don't build a second analytics engine. MySQL can aggregate a few million rows interactively with the right indexes; our users are 20-50.

### Semantic layer ("metrics")

```sql
ab_metrics(id, env_id, table_id, name, display_name, expr_kind ENUM('count','count_distinct','sum','avg','min','max','fx'),
           column_name NULL, filter JSON NULL /* RowCondition[] */, fx TEXT NULL, format JSON)
ab_dimensions(id, table_id, name, column_name, kind ENUM('category','date','lookup'), date_grain_default)
```

- A **metric** is our measure: `Sum of Amount where Status = "Approved"`, or a ratio of two metrics in Fx (`Metric("Good Parts") / Metric("Total Parts")`). Ratios are computed after aggregation, never by averaging ratios — the same lesson as DAX filter context.
- Dimensions include date grains (day/week/month/quarter/fiscal year with **April start** for India) and lookups (group Orders by `Customer.Region` → SQL `JOIN` on the lookup column).
- Query endpoint: `POST /api/v1/analytics/query { metrics:[...], groupBy:[...], filters:RowCondition[], dateRange, top, compareTo:'previous_period' }`. The server compiles to one SQL `SELECT ... GROUP BY` per source table, **with the caller's row predicate ANDed in and column access checked**, exactly like data queries. Result cached per (user role set, query hash) for 60 s and invalidated on writes to the table.

### Charts and dashboards

- **Chart controls** already exist in the Studio (Recharts behind adapters, D5). Add a `Chart` data binding mode: `Metric`, `GroupBy`, `Filters` properties that call the analytics endpoint (delegated), instead of formulas over loaded rows. Fx functions `Metric("Good Parts", {Line: Dropdown1.Selected})` give makers the same in formulas.
- **Dashboards**: `ab_dashboards(id, env_id, name, owner_id, shared_roles JSON, layout JSON)` with tiles (KPI card with target and trend, bar/line/pie/area, table, pivot, gauge, text). Global filter bar (date range, any dimension), cross-filtering by clicking a bar (the interactive-dashboard visual filter idea), drill to the underlying rows in a data grid (respecting RLS). System (role-shared) and personal dashboards, but no separate sharing of contained charts — tiles are part of the dashboard.
- **Scheduled snapshots**: a flow step "Render dashboard to PDF/PNG and email/WhatsApp at 8:30 every morning" — the MIS report a plant owner actually reads. Use headless Chrome if present, otherwise server-side SVG rendering of the chart specs.
- **Embedding**: dashboards appear in auto apps (`nav` item), in canvas apps (Dashboard control), and in the portal home.

### Larger data and history

- For big fact tables (sensor readings, line-wise production per minute) add **rollup tables** maintained by the flow engine (hourly/daily aggregates) and let the analytics compiler pick a rollup when the query grain allows (like Power BI aggregations). Optional; most pilots won't need it.
- **Excel / Power BI users**: expose a read-only **OData v4 feed** per table or metric query (see `dataverse.md`) so finance can pull data into Excel or Power BI Desktop with Basic auth over HTTPS, still filtered by their role. This makes us a good citizen in shops that already have Power BI, without building one.

## Where we can be better for a 20-50 person org

| Microsoft pain point | Evidence | Better design |
|---|---|---|
| Second security model (DAX RLS roles) that doesn't apply to workspace members, can't be truly tested as another user, and must be synced with Dataverse roles | [RLS](https://learn.microsoft.com/fabric/security/service-admin-row-level-security#validate-the-role-within-the-power-bi-service), [dynamic RLS](https://learn.microsoft.com/fabric/security/service-admin-row-level-security#considerations-and-limitations-for-dynamic-rls) | Analytics uses the same row/column security as apps, always, including for admins' "view as" |
| Import freshness capped at 8 refreshes/day on Pro, 2-hour refresh limit | [Refresh data](https://learn.microsoft.com/power-bi/connect-data/refresh-data#understanding-data-refresh) | Live queries; dashboards current to the last write |
| Report authoring requires Power BI Desktop (Windows) and DAX for anything non-trivial | [Dashboards vs reports](https://learn.microsoft.com/power-bi/create-reports/service-dashboards#dashboards-versus-reports), [measures](https://learn.microsoft.com/power-bi/transform-model/desktop-measures#report-level-measures) | In-browser dashboard designer; metrics defined with pickers; Fx for ratios |
| Dashboards can't be filtered; reports can't alert — two artefacts | [Dashboards vs reports](https://learn.microsoft.com/power-bi/explore-reports/end-user-dashboards#dashboards-vs-reports-for-power-bi-business-users) | One dashboard artefact with filters and threshold alerts (alerts = scheduled flow checks) |
| Model-driven charts capped at 50,000 rows and 20 controls per dashboard; personal dashboards require separately sharing charts and views | [System chart limits](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-edit-system-chart#maximum-number-of-records-displayed-in-a-chart), [visualization limits](https://learn.microsoft.com/power-apps/developer/model-driven-apps/view-data-with-visualizations-charts#web-resource-visualizations), [user guide](https://learn.microsoft.com/power-apps/user/track-your-progress-with-dashboard-and-charts) | Server-side aggregation (no row cap), tiles belong to the dashboard |
| Power BI embedding in model-driven apps off by default, separately licensed | [Admin setting](https://learn.microsoft.com/power-platform/admin/use-power-bi) | Dashboards are native |

**Not worth replicating**: DAX, Power Query M, an in-memory columnar engine, composite/Dual/Direct Lake storage modes, XMLA endpoints, Q&A natural language over models (an agent with the analytics tool does this better — see `copilot-studio.md`), paginated reports (use document templates for invoices/certificates instead), dataflows.

**Worth copying**: measures as named, context-aware aggregations; a date dimension with fiscal calendars; cross-filtering charts; drill-through to rows; KPI cards with targets; scheduled delivery; "unexpected identity returns no rows" as a security test case for our analytics compiler.

## Sources

- [Data refresh in Power BI](https://learn.microsoft.com/power-bi/connect-data/refresh-data)
- [Semantic model modes in the Power BI service](https://learn.microsoft.com/power-bi/connect-data/service-dataset-modes-understand)
- [DirectQuery in Power BI](https://learn.microsoft.com/power-bi/connect-data/desktop-directquery-about)
- [Use composite models in Power BI](https://learn.microsoft.com/power-bi/transform-model/desktop-composite-models)
- [Direct Lake in web modeling](https://learn.microsoft.com/fabric/fundamentals/direct-lake-web-modeling)
- [DAX overview](https://learn.microsoft.com/dax/dax-overview)
- [Calculation options in Power BI Desktop](https://learn.microsoft.com/power-bi/transform-model/desktop-calculations-options)
- [Create measures](https://learn.microsoft.com/power-bi/transform-model/desktop-measures)
- [Learn DAX basics](https://learn.microsoft.com/power-bi/transform-model/desktop-quickstart-learn-dax-basics)
- [Reports in Power BI](https://learn.microsoft.com/power-bi/explore-reports/end-user-reports)
- [Dashboards for business users](https://learn.microsoft.com/power-bi/explore-reports/end-user-dashboards)
- [Introduction to dashboards for designers](https://learn.microsoft.com/power-bi/create-reports/service-dashboards)
- [Row-level security with Power BI](https://learn.microsoft.com/fabric/security/service-admin-row-level-security)
- [RLS guidance](https://learn.microsoft.com/power-bi/guidance/rls-guidance)
- [Embed a report with RLS](https://learn.microsoft.com/power-bi/developer/embedded/cloud-rls)
- [Use Power BI with model-driven apps](https://learn.microsoft.com/power-apps/maker/model-driven-apps/use-power-bi)
- [Use Power BI (admin)](https://learn.microsoft.com/power-platform/admin/use-power-bi)
- [Create or edit model-driven app dashboards](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-edit-dashboards)
- [Track progress with dashboards and charts](https://learn.microsoft.com/power-apps/user/track-your-progress-with-dashboard-and-charts)
- [Customize visualizations and dashboards](https://learn.microsoft.com/power-apps/developer/model-driven-apps/customize-visualizations-dashboards)
- [Create or edit a system chart](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-edit-system-chart)
- [View data with visualizations](https://learn.microsoft.com/power-apps/developer/model-driven-apps/view-data-with-visualizations-charts)
- [Analyze data with dashboards](https://learn.microsoft.com/power-apps/developer/model-driven-apps/analyze-data-with-dashboards)
- [Use interactive dashboards](https://learn.microsoft.com/power-apps/user/interactive-dashboards)
- [Configure interactive experience dashboards](https://learn.microsoft.com/power-apps/maker/model-driven-apps/configure-interactive-experience-dashboards)
