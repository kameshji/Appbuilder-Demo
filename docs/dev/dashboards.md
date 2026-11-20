# Dashboards (P2 package C)

Status: first version (0.7.0 candidate). Fixed decision (p2-spec.md): dashboards are pages made of UI components on the aggregate endpoint;
security-trimmed; no separate BI model. Maker guide: [../guide/maker/dashboards.md](../guide/maker/dashboards.md); viewing:
[../help/dashboards.md](../help/dashboards.md); administration and performance: [../admin/dashboards.md](../admin/dashboards.md).

| Module | What |
| --- | --- |
| `src/charts/format.ts` | Number, currency, percent, compact (lakh / crore with `en-IN`) and date / fiscal-period formatting (Intl only) |
| `src/charts/scales.ts` | Nice linear ticks, bands, text width estimate, label fitting |
| `src/charts/palette.ts` | Colour tokens; light and dark palettes; `--viz-*` CSS variables (in `src/index.css`, kept equal by a test) |
| `src/charts/geometry.ts` | `chartScene(spec, rows)`: every chart kind as primitive marks + legend + data table + summary + interactive points; `kpiState` |
| `src/charts/svg.ts` | `renderChartSvg(spec, rows, opts)`: standalone SVG for PDFs and email (package B uses it) |
| `src/controls/display/viz.tsx` | `VizView` (React SVG over the scene: tooltips, keyboard, legend toggles, data table, PNG/SVG/CSV export) and the `Visual` UI component |
| `src/dashboards/dates.ts` | Range presets (this shift .. fiscal year to date), comparison ranges (previous period, same period last year, "to date"), range conditions in a time zone |
| `src/dashboards/measures.ts` | The measure builder: `compileQuery` (spec -> Query v2 plans) and `finishQuery` (computed measures, comparison, running totals, targets, gap filling) |
| `src/dashboards/types.ts` | `DashboardDef`, `TileDef`, `checkDashboardDef` |
| `src/dashboards/tile.ts` | tile + rows -> `ChartSpec` |
| `src/dashboards/viewer.ts` | `buildBatch` (all tiles -> one batch, filters and cross-filter) and `assemble` (answers -> tile rows / errors) |
| `src/dashboards/manufacturing.ts` | Minimal plant tables, OEE / scrap / FPY / downtime Pareto / MTTR / schedule adherence presets, the "Production overview" template, SAMPLE data |
| `src/portal/dashboards/` | `api.ts` (server and demo backends), `DashboardsPage.tsx` (list, viewer, layout editor) |
| `server/core/dashboards/` | `ddl.ts` (schema version 11 step: `ab_dashboards`, `ab_dashboard_settings`), `routes.ts` (CRUD, settings, the batch endpoint and its cache) |

`src/charts` and `src/dashboards` are shared with the server: relative imports with `.ts` extensions, no React, DOM or packages
(`src/charts/charts.test.ts` checks the chart folder).

## renderChartSvg (contract for package B)

```ts
import { renderChartSvg } from '../../../src/charts/svg.ts'   // or src/charts/index.ts
renderChartSvg(spec: ChartSpec, rows: Record<string, unknown>[], opts?: { theme?: 'light' | 'dark'; font?: string; background?: boolean }): string
```

- `spec.kind`: `bar` (grouped; `stack: 'stacked' | 'percent'`; `orientation: 'horizontal'`), `line`, `area` (with `stack`), `combo`, `pie`,
  `donut`, `scatter`, `heatmap`, `gauge`, `bullet`, `kpi`, `funnel`, `pareto`, `histogram`, `timeline`. `spec.width` / `spec.height` in CSS px
  (the SVG has width, height and the same viewBox).
- Data: `rows` are plain objects; `spec.category` names the category field, `spec.series: [{ key, label?, format?, color?, dashed?, kind?,
  axis? }]` the value fields. Numbers may be numeric text; blanks are `null` (a line breaks there unless `missing: 'connect' | 'zero'`);
  dates are `Date` or `"YYYY-MM-DD"` (`categoryType: 'date'`, `categoryGrain: 'month'` etc. for labels).
- Gauge: one row, `series[0]`, `min`, `max`, `bands: [{ from, to, status: 'good' | 'warn' | 'bad' }]`, `target`, `format: { style: 'percent' }`.
  KPI: `kpi: { label, value, base?, baseLabel?, higherIsBetter?, rules?, spark? }`.
- Formatting: `format: { style: 'number' | 'currency' | 'percent', decimals?, currency?, locale?, compact? }`, defaults `spec.defaults`
  (`{ locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' }`).
- Output: one `<svg>` element with `<title>` and `<desc>` (the chart's summary), the title and legend drawn inside, concrete colours of the
  chosen theme, text escaped; no script, no `foreignObject`, no external references, no CSS variables. Fonts: `opts.font` (default a system
  sans stack including Noto Sans Devanagari): pass the bundled PDF font family name.
- Pure and synchronous; tested in `src/charts/charts.test.ts` (well-formed, escaped, both themes, every kind).

## The measure builder

A tile's query is a `QuerySpec` (`src/dashboards/measures.ts`): table, group columns, an optional date bucket, measures (`sum`, `avg`,
`min`, `max` of a column or of a row calculation (`NumExprV2`), `count` with an optional condition, `countDistinct`), computed measures
(`CalcExpr` over measure values), a fixed filter, the column the dashboard's date range applies to, sort, top N (+ "Others"), comparison,
running totals and a target table. `compileQuery(spec, { range, filters, calendar, now })` returns:

- `main`: one aggregate plan, always `groupOrder: 'key'` (one-pass aggregation), buckets with the environment's fiscal year start, week
  start and time zone, the range as a condition (`rangeCondition`: calendar days for date columns, instants in the zone for datetimes),
  plus dashboard filters and the cross-filter;
- `compare` (when asked and the tile has a date column and the range is bounded): the same plan over `comparisonRange` (previous period: whole
  months shift by months, other ranges by their length; same period last year: 12 months back). When `now` falls inside the range, only
  the elapsed part is compared (this month to date vs last month to the same day and time);
- `target`: `sum(valueCol)` of a targets table, per key column when the tile is grouped.

`finishQuery` then works on the aggregated rows only: fills missing buckets of the range (blank, so lines break), evaluates computed
measures per row (division by zero is blank; ratios are ratios of sums, never averages of ratios), aligns the comparison by group key or,
for buckets, by position (`<id>__cmp`), adds targets (`__target`) and running totals (`<id>__run`), and sorts / cuts by a computed measure
(plans cannot see computed measures). Every step is unit-tested end to end through the reference executor (`dashboards.test.ts`).

## Storage and API

`ab_dashboards (id, name, owner_id, roles jsonb, def jsonb, created_on, modified_on)`; `ab_dashboard_settings (k, v)` with key `defaults`.
Routes (all signed-in users unless noted; writes are design routes, refused in a locked production environment):

| Route | |
| --- | --- |
| `GET /dashboards`, `GET /dashboards/:id` | dashboards I may view: owner, a listed viewer role, makers and administrators (others: 404) |
| `POST /dashboards` | makers and administrators: `{ name?, def, roles? }` (`checkDashboardDef`; unknown roles 422) |
| `PATCH /dashboards/:id`, `DELETE /dashboards/:id` | the owner (a maker) or an administrator; audited `dashboard.create/update/delete` |
| `GET /dashboards/settings`, `PUT /dashboards/settings` | locale, currency, time zone, fiscal year start, week start, shifts; PUT administrators, audited |
| `POST /dashboards/query` | `{ queries: [{ id, plan }] (1-40), timeoutMs? }` -> `{ results: [{ id, ok, rows, count?, truncated?, filtered?, cached?, ms, error? }], ms }` |

The batch runs each plan through `DataService.queryV2` **as the caller** (row scope, row rules, shares, column security, in the statement),
four at a time (`QUERY_CONCURRENCY`), each with a statement timeout of at most 10 s (`TILE_TIMEOUT_MS`; the server's own limit still
applies). A failing plan (403 hidden column, 404 unknown or invisible table, 422 malformed, 503 timeout) is that tile's result; the batch
answers 200. `filtered: true` when the caller's read predicate on the table is not "every row": the viewer shows "Based on the rows you can see".

**Cache.** Results are kept 20 s (`CACHE_TTL_MS`, at most 2,000 entries) under a key of environment, user id, table id, the caller's
read predicate on the table, the caller's visible columns and the plan. A committed change to the table (or to a table a lookup path reads)
drops its entries at once (the live change feed `onTableChange`). Role changes change the predicate or the visible columns, so they never
reuse an entry. Not covered within the 20 s: a share granted or revoked on a single row (the predicate text does not change); writes that
bypass the outbox (bulk SQL loads).

**Not done:** automatic use of summary tables (the rule would be: same source, plan groups and filters only on the summary's group columns,
measures sum / count / min / max of summarised columns, and the reader reads every source row; restricted users therefore never qualify);
the "create summary table" hint; kiosk / TV tokens; scheduled email snapshots; dashboards in solutions; the Dashboard UI component and saved
visuals; personal pinned tiles and the Home page; pivot tables.

## Viewer

`DashboardsPage.tsx` (`#u-dashboards`, `#u-dashboards?d=<id>`, both modes): `buildBatch` compiles every tile (filters apply to tiles whose
table has the column; a cross-filter from a tile with `crossFilter` applies to the OTHER tiles on the same table), one `POST
/dashboards/query`, `assemble` -> tiles. Refresh on: range / filter / cross-filter change, the auto-refresh interval (visible tab only),
and a live `table:<id>` message for any table of the dashboard (debounced 400 ms). The previous rows stay on screen until the new ones
arrive (no flicker); a request superseded by a newer one is ignored. The grid is 12 columns of 80 px rows and one column (in layout order)
below 640 px of width. Edit mode (owner / administrator): title, width / height / position steps and remove per tile, Save.

Demo mode: definitions in `localStorage` (`appbuilder-dashboards`), every plan through `platform.tables.query` (reference executor over the
rows the demo user may read); the template creates the two SAMPLE tables in the browser.

## Tests

| Test | What |
| --- | --- |
| `src/fx/query/aggregates.test.ts` | reference semantics of the plan extensions, bucket arithmetic, time zones, validator refusals |
| `server/connectors/postgres/query-v2-aggregates.integration.test.ts` | 285-plan parity reference vs PostgreSQL in four time zones; one-pass statement check |
| `src/charts/charts.test.ts` | formatting (Indian grouping, lakh / crore, fiscal labels), scales, every chart kind in its box, legend / selection, KPI rules, renderChartSvg |
| `src/dashboards/dashboards.test.ts` | presets, shifts past midnight, comparisons (to date), the measure builder end to end, OEE against hand computation, template, viewer batch |
| `server/core/dashboards/dashboards.integration.test.ts` | the batch as administrator / own-rows user / row-rule user / no access, hidden columns, cache per user and its invalidation, CRUD and roles, settings |
| `scripts/exit-check/p2-dashboard.mjs` | exit check 3 at 1,000,000 rows (API and browser), cross-filter, keyboard, data table, phone width |
| `scripts/docs-shots/dashboards.mjs` | template, layout editing by clicking and persistence, range and filter, demo mode |
