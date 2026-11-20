# Dashboards: settings and performance

Developer details: [../dev/dashboards.md](../dev/dashboards.md). Makers: [../guide/maker/dashboards.md](../guide/maker/dashboards.md).

## Settings

`PUT /api/v1/dashboards/settings` (administrators; audited `dashboard.settings`) sets the environment's defaults for every dashboard:
`locale` (default `en-IN`: 12,34,567 and lakh / crore in short numbers), `currency` (`INR`), `timeZone` (`Asia/Kolkata`; date ranges and
date-and-time buckets use it), `fiscalYearStart` (4 = April), `weekStart` (1 Monday, 7 Sunday) and `shifts` (name, start, end; a shift may
end after midnight). Dashboards > Settings shows the time zone, fiscal year start, week start, shifts, locale and currency to everyone; administrators can change them (`PUT /api/v1/dashboards/settings`).

## Security

Dashboards never bypass security: every tile is one Query v2 plan run as the viewer (for a view token: the token's account; for an email
snapshot: each recipient) (row scope, row rules, shares and hidden columns,
inside the SQL statement). Who may open a dashboard (owner, makers, administrators, listed roles) decides only whether the page opens, not
what data it shows. Results are cached 20 seconds per user and dropped when the table changes; a share added or removed on a single row
may take up to 20 seconds to show on a dashboard.

## View tokens (TV and kiosk screens)

A view token lets a screen without a signed-in person show one dashboard. The owner of the dashboard (while a maker) or an administrator
creates it (`POST /api/v1/dashboards/<id>/tokens`, with a label and an optional expiry), copies it once (it is never shown again: only
a SHA-256 hash is stored) and opens the screen's address with the token in the part after `#`. Revoking it (`DELETE
.../tokens/<token id>`) stops it at the screen's next refresh. Created, revoked and service-account tokens are in the audit log
(`dashboard.token.create`, `dashboard.token.revoke`, `dashboard.token.run_as_service`); the list shows when each token was last used.

**Whose data the screen shows.** Every token shows the dashboard **as one account**, fixed when it is made: the person who creates it,
or a service account an administrator chooses. Each tile runs with that account's own row and column security, checked on every
request. A token made by an administrator therefore shows every row: for a screen in a shared place (a shop floor, a reception), make a
service account with a narrow role, add that role to the dashboard's viewer roles, and choose it as the token's account. The token stops
working when it is revoked or expires, when that account is disabled or loses access to the environment, and when the account can no
longer open the dashboard (for example, its role is removed from the viewer roles). A token can do two things only: read its dashboard's
definition and run that dashboard's own tiles (with a date range, the dashboard's filter values and a cross-filter); it is not a key to
the rest of the API. At most 120 requests a minute per token and 20 active tokens per dashboard; 30 wrong tokens from one address in
5 minutes block that address for a while. A locked production environment keeps showing token dashboards.

**The screen (kiosk page).** Owners and administrators create and revoke tokens on the dashboard (**Screens**); the screen opens
`<public address>/#u-kiosk?t=<token>`. That page runs without the app's shell and without signing in: it does not read the browser's
session, so it shows the token's view even when someone else is signed in to the same browser, and its two requests (`GET
/api/v1/dashboards/kiosk`, `POST /api/v1/dashboards/kiosk/query`) are sent without cookies and without the CSRF header, with the token only
in `Authorization: Bearer`. It does not store the token anywhere (no browser storage; the tab title is the dashboard's name, never the
token). A revoked, expired or wrong token, an account that can no longer open the dashboard, or a deleted dashboard clears the screen to
a full-page message, and the page keeps asking every minute or two. The service worker serves the page's shell from its cache like any
page and never caches the API.

What each party can learn from a running screen:

- **Someone looking at the screen** sees the dashboard as the token's account sees it, its name and when it was last updated; not the
  token (the address bar is normally hidden in full-screen mode, but if it is shown, the token is in it).
- **The screen browser's history, bookmarks and session restore** keep the whole address with the token: anyone who can use that
  browser can copy it. Use a browser profile that only the screen uses.
- **The server's and a proxy's logs** see `/` and the two API paths, never the token (the part after `#` is not sent and it is not in
  `Referer`); the server keeps the token only as a hash. `Authorization` headers are not logged by Appbuilder; check that a reverse
  proxy in front of it does not log them either.
- **A person signed in to the same browser** keeps their own session (the kiosk page neither uses nor changes it), but they can read the
  screen tab's address, so they can learn the token. They cannot use their own session to widen what the screen shows.

**What remains a risk.**

- Whoever has the token sees what its account sees, from anywhere the server is reachable, until it is revoked or expires: treat it like
  a password, prefer an expiry, revoke tokens of screens that are gone.
- The token is in the screen browser's address (history, bookmarks, a photographed or shared screen address). The part after `#` is
  never sent to the server, so it is not in server or proxy logs, but anyone with access to that browser can read it.
- Restoring an environment backup in place brings back the tokens as they were at backup time, including ones revoked since: revoke
  them again after such a restore.
- The rate limit, the failure counter and "last used" are kept in the server process (cleared by a restart).
- What a viewer sees on the screen follows the account's access at the moment of the request; results are cached 20 seconds like any
  dashboard.

## Solutions and environment copies

Dashboards travel in solutions (component kind `dashboard`): the definition and the viewer roles (matched by role id, then by name; a
role that is in neither place is left out and the plan says so; so is a table the tiles read that is not there). In a locked production
environment dashboards change only by importing or deploying a solution. An environment copy takes the dashboards and the dashboard
settings, never view tokens or email snapshots: make new tokens for screens that should show the copy.

## Email snapshots

`POST /api/v1/dashboards/<id>/snapshots` schedules a dashboard by email (the scheduled reports' schedules and recipient rules). Each
recipient's copy is computed **with that recipient's own access** and attached as a PDF; a recipient who cannot open the dashboard
gets nothing and the run history (`GET .../snapshots/<id>/runs`) says why. People who are not makers or administrators can only
subscribe themselves; every email has an unsubscribe link. Email must be set up (Admin console > Email); without a public address the
email has no link to the dashboard and no unsubscribe link.

The **Email** button on a dashboard is the screen for this (list, create, edit, pause, delete, "Send now", the history per recipient).

## Pinned tiles

People can pin tiles of dashboards they can open to "My dashboard" (My apps and the Dev home). The list is a personal setting in
`ab.user_settings` (key `dashboard-pins:<environment>`, ids only, at most 24); nobody can read or change another person's pins, and a pin
of a dashboard someone can no longer open says only "No longer available". The pinned tiles are computed with the person's own access
through the normal dashboard query endpoint. Not audited, not in solutions or environment copies.

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
