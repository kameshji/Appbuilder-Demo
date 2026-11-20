# Security model

This page says what Appbuilder protects, how, and where protection stops. It is written for administrators and for
people evaluating the product. Every number comes from the code; the file is named next to it. The last section
([Evidence](#evidence)) says which statements are covered by automated tests, which we confirmed by running the server,
and which are read from the code only.

Scope: **server mode** (the local Node server with PostgreSQL). Version: latest `main`.

## In one paragraph

Appbuilder is a single-machine application. A Node.js server on the PC listens on `127.0.0.1`, authenticates users with
email and password, and enforces table, row and column permissions on every data request. Data lives in PostgreSQL
and in a workspace folder on the same PC. It protects well against *users of the apps* reading or changing what their
role does not allow, and against *web pages in the user's browser* attacking the local server. It does **not** protect
against someone who controls the PC or the database, has no encryption of data at rest, and has no TLS, multi-factor
sign-in or single sign-on.

## What is enforced where

| Concern | Enforced by | Where |
| --- | --- | --- |
| Who is signed in | **Server** (session cookie, checked on every request) | `server/core/auth.ts`, `router.ts` |
| Maker or Administrator needed for an action | **Server** (route level `auth: 'maker' / 'admin'`) | `server/core/router.ts` |
| Table privileges, row filters, own-row scope, column access | **Server**, in the data service and the SQL it builds | `server/core/security.ts`, `data.ts`, `attachments.ts` |
| Which apps a person may open | **Server** (`GET /apps/:id`) | `server/routes/meta/apps.ts` |
| Hiding buttons, menus and pages the person cannot use; blocking obviously invalid input early | **Browser** (a convenience mirror) | `src/portal/security.ts`, `src/runtime` |
| Formulas in apps (visibility, validation, calculations) | **Browser** | `src/fx` |

Rule of thumb: **only what the server enforces is security.** The browser shows or hides things for convenience;
anyone able to send requests to the server can bypass it, and the server then applies the real rules. Formulas run in the
browser, so a formula such as "hide this field unless the user is a manager" only hides it; the data is protected only
if the role's column access says so.

**Optimistic writes.** When an app saves a change, the browser updates the screen at once and the server decides
afterwards. If the server refuses (permission, validation, a conflict), the change is rolled back and an error is
raised, but an action formula that ran further steps after the save (for example *Navigate* after *Patch*) has already
run. Forms wait for the server before reporting success. (decision D9 in [decisions.md](../decisions.md).)

## Authentication

### Passwords

- Hashed with **scrypt**, `N=32768, r=8, p=1`, 64-byte output, a random 16-byte salt per password; stored as
  `scrypt$32768$8$1$<salt>$<hash>` in `ab_users.password_hash` (`server/core/password.ts`).
- Comparison is constant-time. An unknown email, a wrong password and a disabled account all return the same message
  ("Invalid email or password.") and take about the same time (a dummy hash is computed).
- Policy (Admin console > Sign-in and security, [details](sign-in-and-identity.md#password-policy)): a minimum length
  (default 10, 8 to 64; at most 1024), not equal to the email, not on a bundled list of about 2,000 common passwords
  (also a listed word followed by digits or symbols, or one repeated character), optionally not one of the last N
  passwords (scrypt hashes kept in `ab.password_history`, at most 24) and optionally a maximum age after which the
  password must be changed at the next sign-in. Defaults: history and maximum age off.
- No password is written to the audit log or to server logs.

### Sessions

(`server/core/auth.ts`, `server/core/security.ts`, `server/core/router.ts`)

- On sign-in the server creates a random 32-byte token (base64url) and stores only its SHA-256 hash in `ab_sessions`.
  A copy of the database therefore does not contain usable session tokens.
- The cookie is named `ab_session` and is sent as
  `HttpOnly; SameSite=Strict; Path=/; Expires=<7 days>`. We confirmed this on a running server.
  - `HttpOnly`: scripts in the page cannot read it.
  - `SameSite=Strict`: browsers do not send it with cross-site requests.
  - **`Secure`** is added when the connection is TLS, when `APPBUILDER_SECURE_COOKIE=1`, or when
    `APPBUILDER_TRUST_PROXY=1` and the request carries `X-Forwarded-Proto: https` (an HTTPS reverse proxy in front). The
    built-in server speaks plain HTTP, so on a plain loopback install the cookie is not marked `Secure`
    (`cookieIsSecure` in `server/core/router.ts`).
- **Lifetime from the policy** (Admin console > Sign-in and security): an **idle timeout** (default 7 days; each use
  extends the expiry, the database and cookie are updated at most every 10 minutes or every quarter of the timeout) and
  an **absolute lifetime** counted from sign-in however active the session is (default 30 days; 0 = none).
- A session ends on: sign-out, expiry, the user being disabled or deleted (sessions removed at once and the user is
  re-checked on every request), a password change by the user (all *other* sessions are removed), an administrator
  resetting the user's password (all the user's sessions removed). Signing in replaces the old session token of that
  browser.
- **Forced password change.** A password set by an administrator (when creating the user or with *Set password*, for
  someone else) marks the account `must_change_password`. Its sessions can only call `GET /auth/session`,
  `POST /auth/password`, `POST /auth/logout` and `GET /status`; every other route answers 403 with the code
  `password_change_required` (the router checks this before any route handler, `allowPendingPasswordChange` in
  `server/core/router.ts`). Changing the password clears the mark.
- Sessions survive a server restart (they are in the database). Expired sessions are deleted at start and then every
  hour.
- Each session row also keeps the address and browser it was created from and a random public id. People see and end
  their sessions in Settings > Profile ("Sign out everywhere else"); install administrators see and end anyone's in
  Admin console > Users. Ending a session closes its live sockets at once. A session is not *bound* to its address.
- **Rotation on privilege change**: changing the password gives this browser a new token and ends every other session;
  turning two-step verification on or off gives the session a new token in place (the old cookie stops working).
- A session whose user must set up two-step verification (policy, grace period over) is **restricted**: like the forced
  password change, every route except the enrolment ones answers 403 `mfa_enrolment_required`, and it gets no live
  connection.

### Two-step verification, reset, invitations, API keys

The full description is [Sign-in and identity](sign-in-and-identity.md). In short:

- **TOTP** (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps, one step of drift either way), 160-bit secret sealed with the
  secret box (AES-256-GCM) in `ab.user_mfa`. A code is accepted once: the last used time step is stored atomically and a
  code of the same or an earlier step is refused (replay). **Recovery codes**: 10, 16 characters each (about 79 bits),
  stored as SHA-256 hashes, single use (row lock). **Email codes** (6 digits, 10 minutes, hashed) as an alternative
  second step when email is set up and allowed. "Remember this device" sets an `ab_td` cookie sealed with the secret box
  (user, device id, expiry; tampering makes it unreadable) backed by a revocable row in `ab.trusted_devices`.
- The second step: a correct password with two-step verification on gives no session, only a 5-minute pending cookie
  (`ab_mfa`, hashed at rest) for `POST /auth/login/verify`. 5 wrong codes end the pending sign-in; 10 wrong codes in 15
  minutes lock the account's second step (policy values). Resetting the password never skips it.
- **One-time tokens** (`ab.auth_tokens`, SHA-256 at rest, single use by an atomic update): reset links (32 random bytes,
  15 minutes), administrator reset codes (12 characters, 24 hours), invitations (7 days), email change confirmations
  (24 hours). "Forgot password" answers the same whether or not the account exists, and does the per-account work after
  the answer has been sent, so timing does not tell either. A reset ends every session and remembered device.
- **Re-authentication**: changing the sign-in email, turning a second-step method off, new recovery codes, creating API
  keys and deleting an environment need a password or authenticator code from the last 10 minutes (`POST /auth/reauth`;
  403 `reauth_required` otherwise). Exporting all data (package J) uses the same check.
- **API keys** for service accounts: `abk_<prefix>_<secret>` (256-bit secret, SHA-256 at rest), Data API only, cookies
  ignored when a bearer token is present, no CSRF header needed (a bearer token is not sent by browsers on their own),
  optional expiry and IP allow-list, a rate limit per key, last use recorded.
- **Dashboard view tokens** (TV / kiosk screens, P2): `abv.<environment>.<prefix>.<secret>` (256-bit secret, SHA-256 at rest, shown
  once), bound to one dashboard and one "view as" account (the creator, or a service account chosen by an administrator, audited);
  they only read that dashboard and run its own tiles, compiled by the server, with that account's row and column security; revocable at
  once, optional expiry, rate limits, re-checked on every request ([dashboards](dashboards.md#view-tokens-tv-and-kiosk-screens)).
  The kiosk page (`#u-kiosk?t=`) keeps the token in the URL fragment, sends it only as `Authorization: Bearer` with `credentials: 'omit'`
  (no cookie, no CSRF header) and never reads the browser's session.
- **Sign-in log** (`ab.signin_log`): every sign-in, failed attempt, second step and API key failure, with reason, method,
  address and browser. Users see their own; install administrators everybody's.

### Sign-in throttle

(`LoginThrottle` and `EmailBackoff` in `server/core/auth.ts`; the numbers below are the defaults of the lockout policy in
Admin console > Sign-in and security)

- **Per email + client address: 8 failed sign-ins within 15 minutes** block further attempts for that pair with "Too many
  attempts. Try again in a few minutes." (429 `rate_limited`), even if the next password is correct. The block ends 15
  minutes after the failures. A successful sign-in clears the count.
- **Per email, from every address together** (counted over an hour): the first 9 failures cost nothing; from the 10th
  each further attempt must wait 1 s, 2 s, 4 s ... after the previous failure, at most 5 minutes; 50 failures within the
  hour block the email until the oldest is an hour old. Attempts during a wait are refused (429) **without checking the
  password**. A successful sign-in clears it.
- Changing your own password has the 8-per-15-minutes limit, counted per user.
- The counters are **in memory**: a restart clears them. Blocked attempts are recorded in the audit log
  (`auth.login_throttled`, with `perEmail: true` for the second brake).
- **Trade-off (local lockout).** Every local program connects from `127.0.0.1`, and the per-email brake ignores the
  address anyway, so anyone who can reach the port and knows an email can make that account wait: at most about 5 minutes
  per attempt, or up to an hour after 50 failures. They cannot learn the password that way, and the owner of the
  account gets in once the waits stop. We accepted this to close the previous gap: 8 guesses per email *per address*,
  with no overall limit. There is still no limit across emails (one guess for each of many accounts).

### First-run setup

(`server/core/auth.ts`, `server/core/services.ts`, `server/core/router.ts`)

Until the database is configured and the first user exists, the setup endpoints need **no sign-in**:
`POST /setup/database` and `POST /setup/admin`. They are guarded by two things that do not depend on headers:

- **This computer only.** Both routes are `loopbackOnly`: the router compares the TCP peer address of the connection
  (`req.socket.remoteAddress`) with 127.0.0.0/8, `::1` and `::ffff:127.x.y.z`, before reading the body. A request from
  another computer is refused with 403, whatever `Host` or `Origin` it sends. (Before, with `APPBUILDER_HOST=0.0.0.0`, a
  LAN client sending `Host: localhost` could create the administrator.) A request that carries proxy headers
  (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `Via`, `X-Forwarded-Host`) is refused too, even from 127.0.0.1: a reverse
  proxy on the same machine (the installers' Caddy) connects from loopback on behalf of any client. A local program could
  of course leave the headers out; that is the same as being on this computer.
- **A one-time setup code.** While setup is needed the server generates 8 random characters (alphabet without
  look-alikes, `crypto.randomInt`) at start and prints them in a banner on its console (and, with
  `APPBUILDER_SETUP_CODE_FILE`, in an owner-only file the installers point to; never in the log file). Both routes require it
  (`setupCode` in the body or the `X-Appbuilder-Setup-Code` header; case, spaces and dashes ignored; compared in
  constant time). 20 wrong codes in 15 minutes give 429 for a while; each is audited (`setup.code_rejected`). After the
  administrator is created the code is replaced by a new one that is never printed. So a local program that cannot read
  the server's console (or its log file) cannot do the setup.

Whoever passes both and calls `/setup/admin` first becomes the administrator. Afterwards:

- `/setup/admin` answers "Setup is already complete" (409).
- The server writes `"setupComplete": true` to `workspace/server.json`. From then on `/setup/database` needs an
  administrator's session (no code), **also when the database is unreachable at start**: the server then answers 409
  ("Setup is complete, but the database is not reachable right now ...") instead of offering the setup again. With
  nobody able to sign in in that state, re-pointing the database means editing `server.json` or `APPBUILDER_DB_*` on
  disk, which needs access to the PC's files anyway. Installations from before this change get the marker the first
  time the server opens a database that has users.
- If the server cannot tell whether an administrator exists (the database stops answering during the request), it
  refuses (503).

**`GET /status`** needs no sign-in and returns **state flags only**: `setup.needsDatabase`, `setup.needsAdmin`,
`setup.unavailable` (configured but not reachable; the server retries), `setup.incompatible` (schema newer than the
server, see [Upgrades](upgrades.md)), `ok`, and the caller's own session. The database host, port, name, server version
and error text (`storage`, `databaseError`) are included **only for a signed-in administrator**. The workspace payload
also shows the location only to administrators (others see "Server database").

## Request guards

(`server/core/router.ts`, covered by `server/core/unit.test.ts`)

- **CSRF header.** Every request other than `GET`/`HEAD` must carry `X-Appbuilder: 1`, otherwise 403 "Missing X-Appbuilder
  header." A web page on another site cannot add this header without a cross-origin permission the server never grants.
- **Host check (DNS rebinding).** The `Host` header must name one of the configured host names: `localhost`,
  `127.0.0.1`, `::1`, the `APPBUILDER_HOST` address unless it is a wildcard such as `0.0.0.0`, and the names in
  `APPBUILDER_ALLOWED_HOSTS` (`allowedHostList` in `server/core/config.ts`). Otherwise 403 "Requests must be made to a
  configured host name."
- **Origin check.** If an `Origin` header is sent it must name one of those hosts with the same host and port as `Host`,
  otherwise 403 "Cross-origin requests are not allowed." (`Origin: null` is refused too, as is
  `Sec-Fetch-Site: cross-site`.)
- **Important limit:** the Host and Origin checks read *headers the client supplies*. They stop a web page in your browser
  (which cannot forge them); they do **not** stop a program or another computer that sets the headers itself, and the
  server never treats them as proof that a request is local: the only "this computer" check is the TCP peer address,
  used for the setup routes. That is why the address must stay `127.0.0.1`
  ([Installation](installation.md#changing-the-listening-address-is-not-supported)).
- **Body limits.** JSON bodies: **2 MB** (`JSON_LIMIT_BYTES`), 413 above that. Raw uploads: **25 MB** by default; data files
  25 MB, app and table-from-CSV imports 25 MB, solution packages 40 MB. Attachment uploads are read up to 200 MB at the
  route and then refused if they exceed the column's limit (25 MB by default; see [Attachments](#attachments)). JSON requests must be `Content-Type: application/json` (415
  otherwise). A request may take at most 10 minutes (`server/main.ts`).
- **Errors** never include stack traces, SQL or secrets: unexpected errors become "Internal server error." and are logged
  on the server.
- Static files (the web app) are served without the Host check; they contain no data. Requests with `..`, hidden
  (`.`-prefixed), empty or backslash path parts are refused (`server/core/static.ts`).

## Realtime connection (WebSocket)

(`server/core/live/hub.ts`, covered by `server/core/live.integration.test.ts` and `server/core/live/hub.test.ts`; details in
`docs/dev/live.md`)

- **Same guards as HTTP, plus a required Origin.** The upgrade to `/api/v1/live` passes the same Host and Origin checks as
  every request, and an `Origin` header is required and must be this origin. This replaces the `X-Appbuilder` header rule
  (browsers cannot add headers to a WebSocket handshake): a page on another site would send its own Origin, which a script
  cannot change, so it is refused (cross-site WebSocket hijacking). The session cookie (`SameSite=Strict`, `HttpOnly`) is
  then checked like on every request; an account that must change its password cannot connect.
- **Every subscription is checked** against the user's access to the environment it names and to the table, app or scope;
  the checks run again after every role, user or table change, and subscriptions that are no longer allowed end.
- **Table messages never carry data**: no values, no hidden column names, and row ids only to people who may read every row
  of the table; everyone else gets a "table changed" signal and refetches through the normal, secured query.
- **Ending a session ends its sockets at once**: signing out, changing the password, an administrator disabling or deleting
  the account or resetting its password close them immediately.
- **Limits**: 20 sockets per user, 5,000 per server, 200 subscriptions per socket, 16 KB per message, a message-rate limit,
  a 1 MB outbound buffer (a client that does not read is disconnected), a heartbeat that drops dead connections.
- **Presence is need-to-know**: avatars go only to people who may run that app (or read that table); "who is online" only to
  administrators. Anyone can hide their own presence (Settings > Notifications).

## Notifications

- Notifications are per user (`ab.notifications`); the API only ever reads and changes the caller's own.
- `SendNotification` (and `POST /api/v1/notifications/send`): any signed-in user may notify a person who may enter the same
  environment, by user id or email; asking for someone outside it answers like an unknown person (no directory probing).
  Limited to 30 a minute and 300 an hour per sender. Links must be links inside Appbuilder (`#...`), never another site.
- Disabled accounts receive nothing; a kind a user switched off is not stored for them.

## Security headers and Content-Security-Policy

All API responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN`
and `Cache-Control: no-store`. The HTML page is served with:

```
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';
                         script-src 'self' 'sha256-<hash of each inline script>'; connect-src 'self';
                         object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
```

(`htmlCsp` in `server/core/router.ts`; `cspForHtmlFile` in `server/core/static.ts`.) The web app is one HTML file with
its JavaScript inline (vite-plugin-singlefile). When serving an HTML file the server computes the SHA-256 of every inline
`<script>` element's text and lists exactly those hashes in `script-src`; the result is cached per file and recomputed
when the file's modification time or size changes (a new build). **`script-src` has no `'unsafe-inline'`**, so a script
injected into the page (an inline `<script>`, an event-handler attribute, a `javascript:` URL) does not run. Effects
otherwise unchanged: the page can load only its own resources, **cannot load images from other sites** and cannot send
requests to other sites, so an app cannot phone home through the browser.

`style-src` keeps `'unsafe-inline'`. We tried without it: the built page then logs CSP violations at once (the inlined
stylesheet is a `<style>` element, and React and Radix set `style` attributes at run time for positions and sizes, which
hashes cannot cover). Injected CSS can restyle the page but cannot run script. We verified the built app under the new
policy in headless Chrome: setup wizard, sign-in, portal pages, the Studio, a running app and the forced password change,
with no CSP violation in the console.

## Secrets at rest

(`server/core/secrets.ts`, `server/core/meta-store.ts`, `server/core/config.ts`)

- Database passwords of connections, the default database password in `workspace/server.json`, and Google
  service-account keys are encrypted with **AES-256-GCM**: a fresh random 12-byte IV per value, a 16-byte
  authentication tag, stored as `v1:<iv>:<tag>:<ciphertext>` (base64). Tampering or the wrong key is detected and the
  value is refused.
- The 32-byte key comes from `APPBUILDER_SECRET_KEY` (64 hex characters) or, by default, from `workspace/.secret-key`
  (created on first start, never overwritten). **The key is on the same machine, usually the same folder, as the data it
  protects.** The encryption protects against a stolen *database dump* (`ab_connections.secret_sealed`) or a stolen copy
  of `server.json` **without** the key. It does not protect against someone who can read the workspace folder, or the
  running server's memory or environment.
- Secrets are never returned by the API (a connection shows only "has secret"), are removed from error messages, and are
  not in the audit log. Solution packages contain connection settings but **never** passwords or keys.
- Losing `.secret-key` makes every sealed secret unreadable. See [Backup and restore](backup-and-restore.md).
- `server.json`, `.secret-key` and attachment files are created with owner-only permissions (`0600`) on Linux and macOS.
  **On Windows that setting has no effect**; rely on the folder's permissions.
- Not encrypted: the database's own files, the rows in your tables, data files, attachments, and `pg_dump` backups. These
  are as readable as the operating system and database permissions let them be.

## Data access and SQL

- Row filters, own-row scope and column access are turned into conditions that are **part of the SQL query**, not
  applied to the result afterwards (for the PostgreSQL and MySQL connectors). Writes are guarded the same way (an `UPDATE` carries the
  row condition), so a row changed or removed by someone else in the meantime does not slip through.
- Values are sent to the database as query parameters; table and column names are validated (`^[A-Za-z_][A-Za-z0-9_]*$`)
  and quoted, and every table name carries its schema. Tests feed values such as `x' OR 1=1; DROP TABLE t_orders; --` and
  `'; DROP TABLE x; -- \ % $1 ?` through the query builders (`server/connectors/mysql/sql.test.ts`,
  `server/connectors/postgres/postgres.integration.test.ts`).
- PostgreSQL connections never carry per-request state: every pooled connection starts with `search_path=pg_catalog,pg_temp`,
  so objects created in `public` cannot shadow built-in functions and an unqualified name fails instead of reaching another
  schema. A PostgreSQL connection added by an administrator cannot name Appbuilder's own schemas (`ab`, `env_*`).
- **Tables whose names start with `ab_` are never exposed or used for user data**: they are hidden from the list of
  linkable tables, and any attempt to use one is refused ("Tables starting with "ab_" are reserved for the platform").
- **One registration per physical table.** Linking a source that is already linked (same connection, or another
  connection to the same host, port and database, or the same spreadsheet) is refused with 409 naming the existing table,
  so a maker cannot get a second copy with fresh default privileges. Already linked tables are not listed.
- **Linked tables are never dropped or altered by removals.** Only tables Appbuilder created (`managed` in the table
  definition, or data-file tables) may be dropped, and only when `dropSource=1` is sent explicitly; the portal offers it as
  an unticked box. Removing a column of a linked table only unmaps it.
- **Linked tables lacking system columns** are read-only unless the maker consented to adding them, and no query names a
  column the source does not have (`missingSystem` in the table definition). Without an `owner` column, Own-scope roles
  get nothing.
- A user who may not know a table exists gets "does not exist" (404), and a row they may not see gets "Row not found",
  not "not allowed", so existence is not revealed.
- **Queries (Data API v2):** filters, search, sorting, paging, counts and aggregates run in PostgreSQL with RBAC, the row scope and
  row filters ANDed into the one statement, and a plan naming a hidden column anywhere (select, filter, sort, search, grouping,
  measures) is refused (403), so aggregates cannot leak hidden values or other users' rows. Limits: pages of at most 500 rows, at
  most 5,000 rows without paging, 5,000 groups, a 15 s statement timeout. The v1 query still returns at most **5,000 rows**
  (`DEFAULT_ROW_CAP`); CSV export is capped at 1,000,000 rows. These are performance limits, applied after the user's own filters.
- **Organisation scopes, relationship rules and shares are part of the same statement** (P0 package F). The sets a
  scope needs (the user's department members, reporting line, team members, rows shared with them) are worked out on the
  server for each request from a directory cached for at most 5 seconds and dropped when the organisation or a share
  changes in this process; they travel as one parameter list. Rules through lookups and related rows become
  `column IN (SELECT ... FROM <table of the same connection> WHERE ...)` sub-selects inside the query, never SQL text from
  the rule. The same predicate guards updates and deletes in the database and is checked (WITH CHECK) on the row as it will
  be written, with the sub-selects answered by the database. Counts, totals, search, CSV export, attachment access and the
  explainer use it too. On a 1,000,000-row table the first page with an exact count takes 20-400 ms per scope or rule
  (`docs/dev/security-engine.md`, Performance).
- **Lookups never reveal rows you cannot read.** Display values of lookups are read by the browser through the normal
  query, so an unreadable row shows its id only. Writing a lookup value checks that **you can read** the target row; an
  unreadable row is answered exactly like a missing one ("no row with id ..."), so lookups cannot be used to probe for
  rows or to link to them (fixed in P0 package F; before, only existence was checked).
- **CSV exports are neutralised against formula injection** (OWASP): in `GET /tables/:id/csv` and in the download of a
  CSV data file, a text cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading `'`, so a spreadsheet
  shows it as text instead of running it. Plain numbers (`-5`, `+1.5e3`) and number/boolean cells are left as they are
  (`csvSafeText` in `server/core/values.ts`). The `'` stays in the file: importing such an export again keeps it in the
  value. XLSX data files are written with typed cells by ExcelJS, so text never becomes a formula. Google Sheets writes
  use `RAW` mode, so values you save into a sheet are never turned into formulas (`server/connectors/gsheets/index.ts`).

- **Computed columns are computed by the system.** A formula column's value, and a rollup's total over related rows,
  are calculated without the reader's row or column security and stored in the row. Whoever can see the computed
  column sees the result, even when it summarises rows or columns they cannot open (a rollup "Total of order lines"
  shows the sum of every line, also lines in rows hidden from the reader). This is by design: limit the computed column
  in the table's column security when that matters. The rollup editor and the formula column editor say so.
- **Summary tables** (data model designer) are readable only by roles that may read every row and every used column of
  their source; **reporting views** apply the base table's row and column security.
- **The directory.** Who a non-administrator sees in the Users system table and in every picker built on it is set
  per environment ([Directory visibility](users-and-roles.md#directory-visibility): everyone, same department, or
  administrators only); people without access to the environment are never listed.
- **Collaboration rows follow the record.** A comment, activity, follow, tag or file link can only be created about a
  record the writer can read; mentioning someone who cannot read the record is refused; notifications go only to people
  who can read it.

## Outbound connections

Appbuilder connects out to hosts administrators type in: database connections (and their introspection) and the SMTP
relay. Always refused: link-local addresses (`169.254.0.0/16`, `fe80::/10`, where cloud metadata services live), the
unspecified address (`0.0.0.0`, `::`), multicast and broadcast, and metadata host names (`metadata.google.internal`).
Names are resolved and every address is checked; an IPv6 address that carries an IPv4 address (IPv4-mapped in any
notation such as `::ffff:a9fe:a9fe`, IPv4-compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) is judged as that IPv4
address (since 0.6.0). Loopback and private networks are allowed (an on-premises database and
mail relay live there); set `APPBUILDER_OUTBOUND_PRIVATE=deny` to refuse them too. The SMTP client connects to the
address it checked; the database drivers resolve the name again when they connect, so a DNS answer that changes in
between is not caught for database connections. Connection hosts can only be set by administrators.

**HTTP connections (P1)** are stricter, because flows and events call them with data from users: every request and every
redirect must go to a host on the connection's allow-list (required; `*` refused), loopback and private addresses need
the connection's "allow private network addresses" switch, a host name is refused when any address it resolves to is
refused, and the resolved address is pinned and connected to directly, so DNS rebinding between the check and the
connection is not possible. Redirects from https to http are refused, sensitive headers are dropped when a redirect
changes host, responses are size- and time-limited, TLS certificates are verified unless the administrator turns that off
for the connection. Secrets of a connection never leave the server and are replaced by `[hidden]` if an API echoes them.
Who may use a connection is a per-connection grant ("use", "manage"); see [connections](connections.md#connection-access).
Inbound webhooks are verified by a path token and an HMAC signature with replay protection ([webhook
security](webhook-security.md)). Scheduled reports compute every recipient's data with that recipient's own access unless
an administrator chooses a service account (audited).

## Attachments

(`server/core/attachments.ts`, `attachment-store.ts`)

- Files are stored on disk under random 32-character hexadecimal keys; names from clients never reach a path. The
  database (`ab_attachments`) records the table, column, row, original name, declared type, size and SHA-256.
- **Permissions are the row's permissions.** To download or list an attachment the user must be allowed to read the row
  *and* see the column. To upload or delete, they must be allowed to update the row and have *Update* access to the
  column. Otherwise: "Attachment not found" or "not allowed".
- Size: the column's *maximum size* (at most 25 MB), otherwise 25 MB. A column's *accepted types* are checked against the
  type the client declares.
- Downloads are served with `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self';
  style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`, so an uploaded
  HTML or SVG file cannot run script in Appbuilder's origin.
- No virus scanning. The declared file type is the client's word.
- Unreferenced attachments (row or table gone) older than 1 hour are removed at server start (at most 5,000 per run).

## Audit log

Changes are recorded in `ab_audit`: who, when, what. Bulk deletes list the row ids (up to 1,000 per entry, the count is
always complete); role changes carry a before/after diff of every changed field and table privilege; user creation,
disabling, role changes and password resets have their own entries; schema migrations are recorded. Reads are not. Not
tamper-evident: anyone with database write access can alter it, and an audit write that fails does not fail the request:
it is logged on the console as `ERROR audit write failed (<action>): <reason>` and not retried. Details, actions and SQL
queries are on the [Audit log](audit-log.md) page.

## Demo mode is not secure

The browser-only demo (no server, data in the browser's IndexedDB) simulates roles so people can try the product.
There is no sign-in, the switch-user list in the avatar menu lets the person pick any user, and rules are applied by the same browser code the
person controls. Anyone can change them or read all the data in the browser's storage. Never use demo mode for real
data.

## Threat model

**Who we assume:** a small business with one PC running Appbuilder. The administrator is trusted. Makers are trusted
(see their powers [here](users-and-roles.md#what-makers-and-administrators-can-do)). Ordinary users are not trusted
beyond their role. Web pages the user visits are not trusted.

**Appbuilder is designed to resist:**

| Threat | Defence |
| --- | --- |
| An ordinary user reading or changing data beyond their role (including by calling the API directly) | Server-side table, row and column rules on every request |
| An ordinary user doing admin or maker actions | Route-level sign-in levels |
| A malicious web page making the browser call the local server (CSRF, DNS rebinding, cross-site cookie use) | `SameSite=Strict`, `X-Appbuilder` header, Host and Origin checks |
| Script injected into the portal page | CSP `script-src` with hashes, no `'unsafe-inline'` |
| Another computer, or a local program without access to the server console, taking over the first-run setup | Loopback-only setup routes (TCP peer address), one-time setup code, setup locked once an administrator exists |
| Guessing passwords through the sign-in form | scrypt, uniform errors, 8-per-15-minutes throttle per email and address, exponential per-email backoff, common-password list, optional two-step verification |
| A stolen password | Two-step verification (TOTP or email codes), required by policy for administrators or everyone; new-device email; sign-in log |
| Guessing or replaying second-step codes | 5 wrong codes per pending sign-in, account second-step lock, a TOTP step used once, recovery codes single use |
| Learning which emails have accounts | Same answer and timing for "forgot password" and sign-in whether or not the account exists |
| Reusing a reset, invitation or confirmation link | Single use (atomic), short expiry, hashed at rest, newer links revoke older ones |
| A leaked API key | Only the Data API, its environment and its roles; expiry, IP allow-list, rate limit, revocation, last use visible |
| A leaked dashboard view token, or a token used as a query API | One dashboard's own tiles only (plans compiled by the server from the stored definition; plans from the client refused), as its fixed account under that account's security; expiry, revocation, disabled or demoted account stops it, rate limits, last use visible (P2) |
| Dashboard email snapshots showing a recipient data they cannot read | Computed per recipient with the recipient's own access; recipients who cannot open the dashboard get nothing (P2) |
| Spreadsheet formulas planted in data and opened from a CSV export | Leading `'` on formula-like text cells |
| An older server corrupting a database upgraded by a newer one | Downgrade guard: the database is not used at all |
| Theft of a database dump | Password hashes, hashed session tokens, encrypted connection secrets (key kept elsewhere) |
| Uploaded files running script | Sandboxed CSP and `nosniff` on downloads |
| SQL injection through values and names | Parameters, identifier validation and quoting |
| A user widening their own access through the organisation (choosing a manager, joining a team, giving rows away) | Departments, managers and organisation fields: install administrators only; teams: administrators; giving a row to a team: only a team of one's own, and the Update rules must still cover the row afterwards |
| A share opening a table to someone with no access to it | Shares only add rows for users whose role already reads (or updates) the table; never Delete |
| A rule or token that does not resolve opening rows (no department, a deleted team, a removed column) | Fail closed: an unresolved value never matches; a rule that no longer fits the table makes the role grant nothing |
| An environment administrator reaching install-wide work (backups, mail, install log retention) through schedules | Custom schedules only for job types marked safe; schedules of install-wide jobs need an install administrator |
| An administrator account used to reach cloud metadata or link-local services | Outbound policy: link-local, metadata, unspecified and multicast targets refused for connections and SMTP |
| A maker turning an HTTP connection into an open proxy or an SSRF tool (internal addresses, redirects, DNS rebinding) | Required host allow-list on every hop, private networks only by the administrator's switch, pinned DNS answers, https->http refused (P1) |
| Connection secrets leaking through action outputs, errors, logs or the API | Secrets sealed, never returned; every secret value redacted from outputs and errors; activity rows keep no payloads (P1) |
| A maker using a connection they were not given, or a user getting report data they cannot read | Per-connection "use" grants checked when attaching; reports run as each recipient (P1) |
| Forged or replayed webhook calls | Path token (hash stored), HMAC-SHA256 signature with timestamp tolerance, replay table, rate and size limits (P1) |
| A maker's flow acting with more rights than the maker has (run as an administrator, a service account, or another flow's identity) | Run-as owner by default; service accounts only by administrators (confirmed, audited); a flow that runs as a service account changes only by an administrator; child flows only if the saver, the owner and (at run time) the run-as identity may run them; owners change only by administrators (P1) |
| A formula on the server stalling or exhausting the one server process (catastrophic regular expressions, loops over millions of rows, gigabytes of text) | Nested-repeat patterns refused on the server; one evaluation stops after 30 s or about 50 MB / 3 million rows built (P1) |
| Flows triggering each other without end, or a burst of runs | Change chains stop at 8 levels, a flow ignores its own changes by default, per-flow and per-environment run limits (runs wait, nothing is dropped), the kill switch (P1) |
| Approval answers by the wrong person, twice, or without a required comment | Only a pending assignment of the current stage answers (row lock, decisions immutable); email links single use, bound to the person, need a session; required comments also in bulk answers; the requester never approves their own request, also not through a delegation (P1) |
| Restoring or seeing deleted rows one may not see (recycle bin) | Restore needs delete and see on the rows, checked again at restore time; the Deleted view, `DeletedRows` and batch details only for rows the caller could delete and can see; deleting for good: administrators (P1) |
| A crafted OpenAPI document (alias bombs, remote references) | Size cap (2 MB), expanded-size cap (500,000 values), local `$ref` only (P1) |
| A crafted backup archive (path traversal, links, oversized members) | Only regular files are read, paths checked, members read into memory capped, every file checked against the manifest's SHA-256 |
| A zip bomb uploaded as a workbook (data file, model import) | The ZIP directory is checked first: at most 256 MB unpacked, 200x compression, 10,000 parts, no ZIP64 |
| Hostile DBML text freezing the designer | Lines over 4,000 characters skipped, texts over 2 MB refused |

**Not defended (by design or not yet built):**

- **Anyone who controls the PC.** An administrator of the operating system, or malware running as the user, can read the
  workspace folder (including `.secret-key`), the database files, the process memory and the environment, and can
  change the code. Anyone with the database login can read and change all data, **and the audit log**.
- **Other users of the same PC.** Every local account can reach `127.0.0.1:5174` and the sign-in page; during the first
  run, those who can read the server's console or log file can also complete the setup.
- **The network.** No TLS: if the port were reachable, passwords and sessions would be visible. Do not expose it.
- **Physical access** to the PC or to unencrypted backups. Use disk encryption (BitLocker) and protect backups.
- **A compromised maker.** A maker can list and link every not-yet-linked table in a connected database and so read it,
  drop tables Appbuilder created, and change columns of writable linked tables.
- **Weak passwords** beyond the length rule and the common-password list (no breach-corpus lookup: the list is small and
  offline). Turn on two-step verification for administrators at least.
- **Email as a second factor** is only as strong as the mailbox: anyone who reads the user's email can use the code.
- **The Google service-account key** is stored encrypted, but with a key on the same machine; whoever gets both can use
  the key against Google (it grants access to the sheets shared with it).

## Explicit limitations

- Single machine; no network, multi-server or high-availability use.
- No TLS by default on localhost, and none at all in the built-in server.
- No single sign-on and no passkeys (P3.5). Two-step verification is TOTP or email codes. Password reset by email needs
  the SMTP relay (Admin console > Email); without it administrators create one-time reset codes.
- Login, second-step and reset counters are in memory (per server process, cleared by a restart).
- **No rate limiting other than the sign-in, second-step, reset and invitation throttles, the API key limit, the
  dashboard view token limits, the setup-code limit, SendNotification and the realtime connection limits**: other API calls are not limited; a
  signed-in user can send as many requests as the PC can handle. The per-email sign-in brake can be triggered by anyone
  who knows an email (see [Sign-in throttle](#sign-in-throttle)).
- Row filters are checked on writes too: a new row must match the filter of a role that grants Create, and a changed
  row must still match the Update rule afterwards (administrators bypass). A permitted update may move a row out of the
  user's *read* visibility (see [Users and roles](users-and-roles.md#known-limits-of-row-filters)).
- Makers can link any table of a connected database that is not linked yet (no per-connection permission), and can drop
  tables and columns that Appbuilder created. Sharing the database with other applications exposes those applications'
  tables to makers.
- Writes from the browser are optimistic (see above).
- Pages hold at most 500 rows; a list read without paging, and a grouping, at most 5,000 (larger requests are refused with a
  message, not truncated). Tables on MySQL, data file and Google Sheets connections are queried over their first 5,000 rows.
- Data is not encrypted at rest. Backups are encrypted only when a passphrase is set (Admin console > Backups).
- **Export environment data** gives an environment administrator every row of every table of the environment (after a
  recent sign-in, audited). Row and column security do not apply to it, as they do not apply to administrators.
- The audit log is not tamper-proof and does not record reads. It has a viewer and an optional retention (off by
  default); the sign-in log keeps 180 days and the email delivery log 90 days by default.
- The Content-Security-Policy allows inline style (not inline script).
- Anyone who may open an app can read its definition.
- Rows of linked tables that existed before linking have no owner until an administrator assigns one.
- The organisation directory and shares are cached per server process for at most 5 seconds: a change made by another
  server process, or directly in the database, applies within that time (changes through this server apply at once).
- With directory visibility "everyone" (the default), any signed-in user can list the names and emails of the active
  people of the environment and its teams (`GET /api/v1/org`, for share pickers); with "same department" or
  "administrators only" less. The names of the people a row they can read is shared with, and of the people on its
  timeline, are always shown to readers of that row.
- Formula columns and rollups show results computed over data the reader may not see (see Data access).
- Outbound policy: database drivers resolve host names themselves (DNS rebinding between the check and the connection
  is not caught for database connections).
- Rules can only use tables of the same connection; tables on data files and Google Sheets cannot use lookup or
  related-rows rules (such a role grants nothing).
- No integrity check of the workspace folder (backups are verified, the live folder is not).
- Realtime state (subscriptions, presence, Studio locks) lives in the one server process. The Studio lock is a soft lock:
  without a live connection it cannot be checked (the Studio then says so and the last save wins). A "table changed"
  signal reveals to anyone who may read a table that something in it changed and when (not what).
- In-app notifications cannot be recalled by the sender; notification email follows each person's choices (no WhatsApp yet).
- Formulas on the server: the regular-expression guard refuses nested repeats only (other super-linear patterns are not
  caught), and one native call (one regular expression, one sort) cannot be interrupted by the evaluation budget.
- Webhooks: a slow request body holds a connection until the server's request timeout (10 minutes; behind Caddy, the
  proxy's). Whether an environment id exists can be told from the answer time.
- Makers can read the saved definition of every flow and change every approval policy (makers are trusted; changes to a
  policy apply to new requests only). The HTTP connector's host allow-list is the boundary of what flows can reach.
- Recycle bin: deleted rows stay in the database and in backups until they are purged (30 days by default for new
  tables); use "delete for good" (administrators) when data must really be erased.
- Loop protection stops chains of changes at 8 levels: two flows that write each other's tables still make up to 8 rows
  per row a person wrote.

## Evidence

| Statement | Evidence |
| --- | --- |
| scrypt parameters and hash format | Test: `unit.test.ts` ("hashes with scrypt"); code `password.ts` |
| Password policy | Test: `unit.test.ts` ("enforces the policy"); run |
| Throttle: 8 failures, 15 minutes | Test: `unit.test.ts` ("throttles after 8 failures"); run (9th attempt answered 429) |
| Same message for unknown, wrong and disabled | Test: `integration.test.ts` ("login errors are uniform"); run |
| Session cookie flags and 7-day expiry | **Run** (curl `Set-Cookie`); `Secure` with `APPBUILDER_SECURE_COOKIE` / trusted proxy: tests `hardening.test.ts`, `hardening.integration.test.ts` |
| Setup only from loopback, setup code, setup locked after the admin / while the database is unreachable | Tests: `hardening.test.ts` (a LAN client with `Host: localhost` gets 403), `hardening.integration.test.ts` |
| Anonymous `/status` without database details | Tests: `integration.test.ts`, `hardening.integration.test.ts` |
| WebSocket upgrade needs this Origin, an allowed Host and a session; forced password change refused | Test: `live.integration.test.ts` ("upgrade: Origin is required ...", "logout, password change and disabling ...") |
| A restricted user's socket never receives a hidden column name or a foreign row id | Tests: `live/hub.test.ts` (leak rule), `live.integration.test.ts` ("LEAK: ..."); run: `scripts/docs-shots/live.mjs` (three browsers, frames inspected) |
| Socket limits, rate limit, slow consumer dropped | Test: `live.integration.test.ts` ("limits ...", "inbound rate limit ...", "slow consumer ...") |
| Stale save answers 409 without revealing hidden columns | Test: `live.integration.test.ts` ("a stale save answers 409 ...") |
| Forced password change (`password_change_required`) | Tests: `hardening.test.ts` (router), `hardening.integration.test.ts`, `routes/meta/hardening.test.ts`; run in headless Chrome |
| Per-email login backoff | Test: `hardening.test.ts` |
| Phase 1 re-check: IPv4 inside IPv6, address encodings, userinfo and IDN tricks, header injection, prototype pollution, regular expressions with nested repeats, the evaluation budget, OpenAPI bombs; child-flow privilege escalation, drafts, owners, run-as, resubmit, locked production for flows and approval policies, bulk answers, approver races, delegation to the requester, trigger storms and the environment run limit, notification HTML escaping, webhook enumeration, OAuth secrets never answered or audited | Tests: `security-p1.test.ts`, `security-p1.integration.test.ts`; review: `docs/internal/security-review-p1.md` |
| Phase 0 re-check: environment selection, Query v2 plan and cursor tampering, hidden-column inference, collaboration spoofing, system-table writes, outbound hosts | Tests: `security-p0.integration.test.ts`, `security-p0.test.ts`; review: `docs/internal/security-review-p0.md` |
| Schedule policy, log retention, directory visibility, export environment data | Test: `phase-close.integration.test.ts` |
| Re-link refused (also through a second connection), linked tables never dropped, columns only unmapped | Tests: `routes/meta/connections.test.ts`, `routes/meta/hardening.test.ts`, `hardening.integration.test.ts` (PostgreSQL) |
| CSV formula escaping, XLSX text cells | Tests: `hardening.test.ts`, `routes/meta/hardening.test.ts` |
| Audit: bulk delete ids, role/user diffs, failures logged | Test: `routes/meta/hardening.test.ts` |
| Downgrade guard, boot retry, migration summary in the audit log | Test: `hardening.integration.test.ts` (PostgreSQL) |
| A failed import or schema change leaves nothing behind (units of work) | Test: `transactions.integration.test.ts` (PostgreSQL) |
| Sliding expiry, 10-minute touch interval | **Code only** (`auth.ts`); no test |
| Sessions removed on disable, password change, reset | Test: `integration.test.ts` ("password change rotates sessions"), `security.test.ts`; run |
| Sessions survive restart; throttle does not | Run |
| CSRF header, Host and Origin checks, body limits | Tests: `unit.test.ts` "router guards"; run (also for spoofed Host on `0.0.0.0`) |
| Security headers on API | Test: `unit.test.ts` (nosniff, referrer, no-store); X-Frame-Options by run |
| HTML Content-Security-Policy (hashes, no inline script) | Test: `hardening.test.ts` (`serveStatic`); built app run in headless Chrome without CSP violations |
| AES-256-GCM, key file mode, env key, tamper detection | Test: `unit.test.ts` "SecretBox" |
| Secrets never returned, removed from errors | Test: `connections.test.ts` ("never returns the secret"); run |
| Lost key makes saved password unreadable | Run |
| RBAC, RLS, CLS and role union | Tests: `unit.test.ts` "security engine", `integration.test.ts`; run on all worked examples |
| `ab_` tables never exposed | Run and code (`sql.ts`, `util.ts`); tested in `connections.test.ts` ("skip registered and system tables") |
| Attachment permissions and sandbox CSP | Test: `integration.test.ts` (attachments) |
| Row filters checked on create and update (WITH CHECK) | Server and demo tests (`demo.test.ts`) |
| Audit actions and contents | Run and code |
| Windows ignores file modes | Code comment in `secrets.ts`; not tested on Windows |
