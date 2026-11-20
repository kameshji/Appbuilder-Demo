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

Open the dashboard and choose **Edit**. The title becomes editable and every tile gets controls:

- **Drag** the grip at the left of the tile's title to move it. Drag the **corner handle** at the bottom right to resize it. The tile
  snaps to whole cells (the grid has 12 columns of 80-pixel rows); the tiles it lands on are pushed down and the others rise to close
  gaps, shown while you drag. Let go to keep it; press **Escape** to drop it. Mouse, touch and pen work.
- **Buttons and keys** do the same without dragging: narrower, wider, taller, shorter, move left, right, up and down, and remove.
  With the keyboard, Tab to the grip and press the arrow keys to move the tile one cell, or Shift and the arrow keys to resize it.
  The buttons push tiles out of the way but never pull the tiles below up.
- **Save** keeps the change for everyone who sees the dashboard; **Cancel** drops it.

Dragging needs a window at least 1,024 pixels wide for the dashboard area. Narrower than that, only the buttons and keys work and a note
says so. Only the 12-column layout is saved. A **tablet** (640 to 1,023 pixels) shows it in 6 columns: positions and widths are halved,
no tile is narrower than 2 of the 6 columns, a tile that no longer fits beside the others moves below them, and the tiles keep their
reading order. A **phone** (under 640 pixels) shows one column in reading order. Nothing is stored for the narrower layouts.

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
- **When someone clicks**: **Clicking opens an app** (see "Open an app from a tile" below). A tile either filters the other tiles or
  opens an app, not both.

The preview on the right (on top on a tablet) shows the tile as the dashboard will, over the dashboard's current date range and with
your own access; the dashboard's filter lists are not applied to it. Problems are listed in words at the bottom; red ones must be fixed
before **Apply** (or **Add to the dashboard**). Apply puts the tile on the dashboard; **Save** the dashboard to keep it. Cancel, the X
or Escape closes the editor without changing the tile.

Parts written outside the editor (through the API) that the editor cannot change, such as a measure over a calculation of several
columns, a condition with "one of" or nested groups, or a calculation with several operators like OEE, are shown in words and kept as
they are when you change other things. You can replace them with a simple version from the editor.

Not possible in the editor yet: colours of series, the right-hand axis of combination charts, gauge colour bands, KPI colour rules and
sparklines, colour rules of table tiles, and the dashboard's filter lists and refresh interval. These remain part of the stored
definition (`POST/PATCH /api/v1/dashboards`, see the developer page).

## Open an app from a tile

In the tile editor, under **When someone clicks**, tick **Clicking opens an app** and choose the app (only apps you may run are listed).
Clicking a point of a chart or a row of a table then opens that app in a tab. A tile without points to click (a KPI, a gauge) shows an
**Open** button in its title bar instead; table rows can also be reached with the keyboard (Tab, then Enter).

You can pass values of the clicked row to the app: group columns, the date grouping, measures and calculations. Each value goes to
the app under a parameter name you choose (by default the first group column, named after it). The app starts at the address
`#u-<app id>?screen=Detail&Machine=Press+1`, and **inside the app** the value is read with the formula `Param("Machine")`, for example in a screen's
start formula or as the filter of a list. This is the only way the app runtime takes start values, so the app has to read them: an
app that never calls `Param` simply opens as it is. Blank values are not passed. If the app is already open in a tab and values are
passed, the app in that tab starts again with the new values (unsaved input in that app is lost) and goes to the screen you chose.

**Choosing a screen.** Under the app, the **Screen** list offers the screens of that app; leave it on "The app's start screen" to open as before.
If the screen is later renamed or deleted, the editor marks it "(not in this app)" and people who click land on the start screen, with
a short notice. People without access to the app see "You do not
have access to <app>" when they click. Parameters passed this way are visible in the browser's address bar.

## Who can see a dashboard

The owner, makers and administrators can always open a dashboard. The owner and administrators can also let other **roles** open it:
choose **Who can see this dashboard** (top bar; in Edit mode a line under the top bar says it in words and has a **Change** link), tick the roles
and **Save**. The window says it in plain words, for example "The owner, makers and administrators, and people with the roles
Supervisor and Operator, can see this dashboard." Roles of makers and administrators are shown ticked and cannot be unticked.
Opening a dashboard is not the same as seeing data: every tile still counts only the rows and columns the viewer's own access allows.
There is no "everyone" option: list each role.

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

**Dashboards > Settings** (top right of the dashboard list) shows these values to everyone and lets **administrators** change them:
time zone, the month the fiscal year starts in, the first day of the week, locale (how numbers are written, such as `en-IN` for
12,34,567 or `en-US` for 1,234,567), currency (a three-letter code such as INR or USD) and up to six shifts, each with a name, a start
and an end time. A shift that runs past midnight (22:00 to 06:00) needs **Ends the next day** ticked. Problems are explained under the
field (for example "A ends before it starts. Tick "Ends the next day" if it runs past midnight, or correct the times."), and nothing is
sent until they are fixed. Overlapping shifts are only a warning: "This shift" then picks the first in the list. The settings apply to every
dashboard of the environment. In demo mode they are kept in the browser.

## TV and kiosk screens

To show a dashboard on a screen where nobody signs in (a TV on the shop floor, a wall display), open it and choose **Screens** (top bar;
the owner while a maker, and administrators; needs the server). Give the screen a label, choose when the token stops working and, as an
administrator, whose view the screen shows: **Me** (exactly what you see) or a **service account**. Choose **Create view token**. Any
warning comes first, in amber: as an administrator "Me" means every row, so for a screen in a shared place choose a service account with
a narrow role (its role must be in **Who can see this dashboard**). Then copy the address (**Copy address**) and open it in the screen's
browser, full screen. The address and token are shown **only this once**.

The screen shows the dashboard full size with no menus, no sign-in and no links into the app, refreshes on the dashboard's own interval
(every minute when it has none), keeps the last data on screen through a network drop, and hides the mouse pointer. It always uses the
dashboard's own date range and no filters. Whoever has the address sees what the token's account sees, until you **Revoke** the token
(Screens, the token's row: the screen then says "This screen's view token does not work" at its next refresh and shows no data) or it
expires. Details and the remaining risks: [../../admin/dashboards.md](../../admin/dashboards.md#view-tokens-tv-and-kiosk-screens).

## Cycling through ranges and pages

A screen can rotate by itself. In the **Screens** dialog, under **Cycling (optional)**, tick **Cycle**, choose how often (5 seconds to an hour),
which date ranges to go through (Today, Last 7 days, ...) and how many pages to split the tiles into. The address that you copy then has
the settings after the token; leave it off and the screen shows the dashboard as before. Each step shows one range and one page, with
"Page 2 of 3" and dots in the top bar. If the connection drops, the screen keeps rotating through what it already has and shows the small
note; it asks for the rest when the connection is back. The token is unchanged: it still shows only this dashboard.

## Email snapshots

**Email** (top bar of a dashboard; needs the server and email set up) sends the dashboard as a PDF on a schedule. **New snapshot**: a
name, when (daily, weekdays, weekly, monthly, hourly or only by hand, with a time and time zone, like scheduled reports), the
recipients (makers and administrators can add people and teams; everyone else can subscribe only themselves), the date range (the
dashboard's own or another preset) and the dashboard's filter values. **Each recipient gets the dashboard computed with their own
access**; someone who cannot open the dashboard gets nothing, and **History** says why for every recipient. **Send now** sends at once
("Send me a copy" when you are only a recipient); **Pause** stops the schedule; **Edit** and the bin icon change or delete it. Every
email has an unsubscribe link.

## Pinned tiles ("My dashboard")

The pin icon on a tile (when viewing, not on text tiles) pins it to **My dashboard**, a small grid at the top of **My apps** (User mode)
and of the Dev mode home page. Pinned tiles show your own data (each is computed with your access, with its dashboard's date range and
no filters), link to their dashboard, can be moved earlier or later with the arrows and unpinned with the cross. At most 24. When a
dashboard or tile is deleted, or you can no longer open the dashboard, the pin shows "No longer available" with **Remove**. Pins are
yours alone and are kept on the server (in demo mode, in the browser).

## The Visual UI component (apps)

The Studio's **Visual** UI component draws every chart kind of dashboards inside a canvas app from a table formula (like Chart): `Items`,
`Kind` ("Bar", "Line", "Area", "Combo", "Pie", "Donut", "Scatter", "Heatmap", "Gauge", "Bullet", "Kpi", "Funnel", "Pareto", "Histogram",
"Timeline"), `CategoryField`, `ValueFields`, `Stack` ("None", "Stacked", "Percent"), `Horizontal`, `NumberFormat` ("Number", "Currency",
"Percent"), `Target`, `Min`, `Max`, `OnSelect` with the clicked row in `Selected`. The existing Chart UI component is unchanged.
