# Dashboards (makers)

Dashboards show KPIs, gauges, trends, bars, Pareto charts and tables over your tables. Every number is computed in the database under the
viewer's own access: two people looking at the same dashboard can see different totals, and nobody sees rows or columns they could not
open in an app. Viewing: [../../help/dashboards.md](../../help/dashboards.md). Technical details: [../../dev/dashboards.md](../../dev/dashboards.md).

## Create one

Open **Dashboards** (in Dev mode or User mode). Makers see **Production overview: Create from template**:

- if your environment has the tables `ProductionLog` and `Downtime` (shape below), the dashboard uses them;
- otherwise two tables named "Production log (sample)" and "Downtime (sample)" are created first and filled with 60 days of **SAMPLE**
  data for six machines called "Sample press 1" to "Sample press 6". Delete them when you use real data.

The template has seven tiles: OEE gauge (target 85 %), Good quantity and Scrap rate KPIs compared with the previous period, Availability /
Performance / Quality by shift, Good quantity by day against the previous period, Downtime by reason (Pareto with the cumulative line and the
80 % line) and Output by machine (a table with OEE coloured below 60 % and above 85 %; click a machine to filter the other tiles).

## Change the layout

Open the dashboard and choose **Edit**. Each tile gets buttons to make it narrower, wider, taller or shorter, to move it, and to remove it;
the title becomes editable. **Save** keeps the change for everyone who sees the dashboard; **Cancel** drops it. The grid has 12 columns of
80-pixel rows on a computer and becomes a single column on a phone.

## Add or change a tile

In **Edit** mode, **Add tile** (top bar) opens the tile editor for a new tile; the pencil on a tile opens it for that tile. Everything is
chosen from lists and boxes:

- **Tile**: title, kind (bar, line, area, combination, pie, donut, scatter, heat map, gauge, bullet, KPI, funnel, Pareto, histogram,
  timeline, table or text) and table. Choosing another table clears what depended on the old table's columns.
- **Measures**: sum, average, minimum or maximum of a number column; count of rows, optionally only rows matching a condition (for
  example "Reason is Breakdown"); count of different values of a column. Each has a label, a number format (whole number, two decimals,
  currency, percent where 0.85 shows as 85 %, compact such as 12.3L) and a short name used in calculations.
- **Calculations**: one measure (or number) with +, −, × or ÷ and another measure (or number), for example Good ÷ Total. Calculations
  are worked out per result row from the measures, so a ratio is a ratio of sums. Division by zero shows a blank.
- **Group by**: one or more columns, and a date grouping (day, week, month, quarter, year, fiscal quarter, fiscal year, day of the
  week, hour of the day for date-and-time columns).
- **Rows counted**: the date column the dashboard's date range applies to (or none), and a fixed filter: conditions such as "Shift is
  A", "Minutes is at least 10", "Started on is before 1 Nov", joined by "all of these" or "any of these".
- **Sort and limit**: sort by a measure, a calculation, a group column or the date; show only the top N, optionally adding up the rest
  as one "Others" row (needs exactly one group column and no date grouping).
- **Comparison, running totals and targets**: compare with the previous period or the same period last year (needs the date column),
  running totals of measures, and targets summed from another table (optionally per value of the first group column).
- **Chart** (or **Table**): which values are drawn (measures, comparison values as dashed lines, running totals, the target), the
  category when there are several groupings, the tile's number format, stacking, upright or lying bars, minimum / maximum / target line
  for gauges, the KPI's number, what it is compared with and whether higher is better, values on the chart, and whether clicking a
  group value filters the other tiles on the same table.

The preview on the right (on top on a tablet) shows the tile as the dashboard will, over the dashboard's current date range and with
your own access; the dashboard's filter lists are not applied to it. Problems are listed in words at the bottom; red ones must be fixed
before **Apply** (or **Add to the dashboard**). Apply puts the tile on the dashboard; **Save** the dashboard to keep it. Cancel, the X
or Escape closes the editor without changing the tile.

Parts written outside the editor (through the API) that the editor cannot change, such as a measure over a calculation of several
columns, a condition with "one of" or nested groups, or a calculation with several operators like OEE, are shown in words and kept as
they are when you change other things. You can replace them with a simple version from the editor.

Not possible in the editor yet: colours of series, the right-hand axis of combination charts, gauge colour bands, KPI colour rules and
sparklines, colour rules of table tiles, the dashboard's filter lists, refresh interval and viewer roles. These remain part of the stored
definition (`POST/PATCH /api/v1/dashboards`, see the developer page). Who may view: the owner, makers, administrators and the roles
listed on the dashboard.

## The minimal plant tables

| Table | Column (formula name) | Type |
| --- | --- | --- |
| ProductionLog | LoggedOn | date and time (indexed) |
| | Shift | choice A / B / C (indexed) |
| | Machine | text (indexed) |
| | Good, Scrap | whole numbers (good units first time; scrapped units) |
| | PlannedMin, RunMin | whole numbers: planned production time and run time of the entry, in minutes |
| | IdealCycleSec | decimal: ideal cycle time of the item in seconds |
| Downtime | StartedOn | date and time (indexed) |
| | Machine | text (indexed) |
| | Reason | choice: Breakdown, Changeover, No material, No operator, Planned maintenance, Other |
| | Minutes | whole number |
| WorkOrders (schedule adherence) | DueDate, CompletedOn | dates |
| | Status | choice: Planned, Released, Running, Done, Cancelled |

The data model designer's "Manufacturing basics" starter holds a production log with lookups to machines and work orders; the dashboard
template groups by a text `Machine` column, so add the columns above to it, or keep a separate log in this shape.

## Measure definitions

All ratios are computed from **sums** over the rows in the range (never by averaging per-row ratios):

| Measure | Definition | Source |
| --- | --- | --- |
| Availability | run time / planned production time = sum(RunMin) / sum(PlannedMin) | [OEE.com, Calculating OEE](https://www.oee.com/calculating-oee/) |
| Performance | (ideal cycle time x total count) / run time = sum(IdealCycleSec x (Good + Scrap) / 60) / sum(RunMin) | OEE.com |
| Quality | good count / total count = sum(Good) / sum(Good + Scrap) | OEE.com |
| OEE | Availability x Performance x Quality | OEE.com; OEE is among the KPIs of ISO 22400-2 |
| Scrap rate | sum(Scrap) / sum(Good + Scrap) | common definition |
| First-pass yield | units good the first time / units started = sum(Good) / sum(Good + Scrap), with Good excluding reworked units | common definition |
| Downtime Pareto | sum(Minutes) by Reason, largest first, with the cumulative share | |
| MTTR | breakdown minutes / number of breakdowns | [UpKeep, MTBF and MTTR](https://www.upkeep.com/blog/improve-reliability-with-mtbf-and-mttr) |
| Schedule adherence | work orders done by their due date / work orders due (cancelled ones left out) | common definition |

MTBF (operating time / number of failures) needs numbers from two tables in one measure, which this version cannot combine: not provided.

## Dates, fiscal year and shifts

The date range applies to each tile's date column. Presets: this shift, today, yesterday, this week, last week, last 7 / 30 / 90 days, this
month, last month, this quarter, this fiscal year, fiscal year to date, last 12 months, all time. They follow the environment's dashboard
settings (administrators): time zone (default Asia/Kolkata), first month of the fiscal year (default April: FY2026-27 runs from 1 April
2026 to 31 March 2027), first day of the week (Monday) and the shift pattern (A 06:00-14:00, B 14:00-22:00, C 22:00-06:00). A comparison
with the previous period covers only the elapsed part of a running period: this month so far against last month up to the same day and
hour.

## The Visual UI component (apps)

The Studio's **Visual** UI component draws every chart kind of dashboards inside a canvas app from a table formula (like Chart): `Items`,
`Kind` ("Bar", "Line", "Area", "Combo", "Pie", "Donut", "Scatter", "Heatmap", "Gauge", "Bullet", "Kpi", "Funnel", "Pareto", "Histogram",
"Timeline"), `CategoryField`, `ValueFields`, `Stack` ("None", "Stacked", "Percent"), `Horizontal`, `NumberFormat` ("Number", "Currency",
"Percent"), `Target`, `Min`, `Max`, `OnSelect` with the clicked row in `Selected`. The existing Chart UI component is unchanged.
