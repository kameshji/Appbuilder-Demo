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

Editing tile queries, adding new tiles and choosing viewer roles have no screen yet in this version: they are part of the stored definition
(`POST/PATCH /api/v1/dashboards`, see the developer page). Who may view: the owner, makers, administrators and the roles listed on the
dashboard.

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
