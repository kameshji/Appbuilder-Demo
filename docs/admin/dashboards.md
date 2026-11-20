# Dashboards: settings and performance

Developer details: [../dev/dashboards.md](../dev/dashboards.md). Makers: [../guide/maker/dashboards.md](../guide/maker/dashboards.md).

## Settings

`PUT /api/v1/dashboards/settings` (administrators; audited `dashboard.settings`) sets the environment's defaults for every dashboard:
`locale` (default `en-IN`: 12,34,567 and lakh / crore in short numbers), `currency` (`INR`), `timeZone` (`Asia/Kolkata`; date ranges and
date-and-time buckets use it), `fiscalYearStart` (4 = April), `weekStart` (1 Monday, 7 Sunday) and `shifts` (name, start, end; a shift may
end after midnight). There is no settings screen yet.

## Security

Dashboards never bypass security: every tile is one Query v2 plan run as the viewer (row scope, row rules, shares and hidden columns,
inside the SQL statement). Who may open a dashboard (owner, makers, administrators, listed roles) decides only whether the page opens, not
what data it shows. Results are cached 20 seconds per user and dropped when the table changes; a share added or removed on a single row
may take up to 20 seconds to show on a dashboard.

## Performance

One request per dashboard refresh (`POST /api/v1/dashboards/query`), at most four plans at once on the server, each with a 10-second
statement limit (a tile that takes longer shows "The query took too long" and the others still load).

Measured with `scripts/exit-check/p2-dashboard.mjs` (sandbox: 2 vCPU Xeon 2.1 GHz, 7.8 GB RAM, PostgreSQL 16 default settings, server and
database on one machine, headless Chrome on the same machine): 1,000,000 rows in ProductionLog and 200,000 in Downtime, a "Supervisor"
role that reads only its own rows (100,000 rows, about 4,750 in the current month), the seven-tile Production overview (ten plans), median
of 5 runs, the cache dropped before each run by a write to both tables:

| Measure | Run A (machine otherwise idle) median / max ms | Run B (other work on the machine, load average about 2) | Run C (the full test suite running at the same time) |
| --- | ---: | ---: | ---: |
| Batch endpoint, cold | 478 / 535 | 619 / 727 | 926 / 1,096 |
| Batch endpoint, cached | 8 / 12 | 7 / 16 | 23 / 34 |
| Browser: full page load of the dashboard address (app start, sign-in session, definition, batch, drawing) until every tile is drawn | 1,253 / 1,526 | 1,505 / 1,635 | 1,759 / 2,402 |

Exit check 3 (six tiles under 2 s at 1,000,000 rows for a restricted user, own rows only): **passes** on this hardware by the median in
every run; under heavy competing load (run C) the slowest of five page loads took 2.4 s. About 1 s of each page load is starting the
5 MB single-file app, not the dashboard. Each
production-log plan takes about 160 ms: PostgreSQL uses either the owner index or the date index (marked Indexed), not both. What helps
when a tile is slow: mark the date column and the columns you group or filter by as Indexed in the table designer; narrow the default
range. Summary tables are not used by dashboards automatically in this version.
