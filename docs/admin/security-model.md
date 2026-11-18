# Security model

This page says what Appbuilder protects, how, and where protection stops. It is written for administrators and for
people evaluating the product. Every number comes from the code; the file is named next to it. The last section
([Evidence](#evidence)) says which statements are covered by automated tests, which we confirmed by running the server,
and which are read from the code only.

Scope: **server mode** (the local Node server with MySQL/MariaDB). Version: latest `main`.

## In one paragraph

Appbuilder is a single-machine application. A Node.js server on the PC listens on `127.0.0.1`, authenticates users with
email and password, and enforces table, row and column permissions on every data request. Data lives in MySQL/MariaDB
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
- Policy: 10 to 1024 characters, not equal to the email. Nothing else (see
  [Users and roles](users-and-roles.md#passwords-and-policy)).
- No password is written to the audit log or to server logs.

### Sessions

(`server/core/auth.ts`, `server/core/security.ts`, `server/core/router.ts`)

- On sign-in the server creates a random 32-byte token (base64url) and stores only its SHA-256 hash in `ab_sessions`.
  A copy of the database therefore does not contain usable session tokens.
- The cookie is named `ab_session` and is sent as
  `HttpOnly; SameSite=Strict; Path=/; Expires=<7 days>`. We confirmed this on a running server.
  - `HttpOnly`: scripts in the page cannot read it.
  - `SameSite=Strict`: browsers do not send it with cross-site requests.
  - **`Secure` is added only when the connection is TLS.** The built-in server speaks plain HTTP only, so in practice
    the cookie is never marked `Secure`.
- **Lifetime 7 days, sliding**: each use extends the expiry to 7 days from now, but the database and cookie are updated
  at most every 10 minutes.
- A session ends on: sign-out, expiry, the user being disabled or deleted (sessions removed at once and the user is
  re-checked on every request), a password change by the user (all *other* sessions are removed), an administrator
  resetting the user's password (all the user's sessions removed). Signing in replaces the old session token of that
  browser.
- Sessions survive a server restart (they are in the database). Expired sessions are deleted at start and then every
  hour.
- A session is not tied to an IP address or browser. There is no limit on the number of sessions per user and no screen
  to list them.

### Sign-in throttle

(`LoginThrottle` in `server/core/auth.ts`)

- **8 failed sign-ins within 15 minutes** for the same *email + client address* block further attempts for that pair,
  with "Too many attempts. Try again in a few minutes.", even if the next password is correct. The block ends 15 minutes
  after the failures. A successful sign-in clears the count.
- Changing your own password has the same limit, counted per user.
- The counters are **in memory**: a restart clears them. Blocked attempts are recorded in the audit log
  (`auth.login_throttled`).
- Limits of this design: because every local program connects from `127.0.0.1`, the "client address" is the same for
  everyone on the PC, so (a) a local program can lock a known email out by failing 8 times, and (b) it can try 8 passwords
  per email per 15 minutes for *each different email*, with no overall limit. It is a brake on guessing, not an account
  lockout system.

### First-run setup

Until the database is configured, and until the first user exists, the setup endpoints need **no sign-in**:
`POST /setup/database` and `POST /setup/admin` (`server/core/auth.ts`). Whoever calls `/setup/admin` first becomes the
administrator. Afterwards `/setup/admin` returns "Setup is already complete" and `/setup/database` needs an
administrator. **One more case:** if the saved database cannot be reached when the server starts (database stopped,
`.secret-key` replaced), the server behaves as unconfigured and `/setup/database` is open again, so anyone who can reach
the port could point Appbuilder at a different database. Keep the database running before the server starts, and do not
expose the port.

`GET /status` also needs no sign-in and tells any caller which database server, host, port and database name is in use.

## Request guards

(`server/core/router.ts`, covered by `server/core/unit.test.ts`)

- **CSRF header.** Every request other than `GET`/`HEAD` must carry `X-Appbuilder: 1`, otherwise 403 "Missing X-Appbuilder
  header." A web page on another site cannot add this header without a cross-origin permission the server never grants.
- **Host check (DNS rebinding).** The `Host` header must be `localhost`, `127.0.0.1` or `::1`, otherwise 403 "Requests
  must be made to localhost."
- **Origin check.** If an `Origin` header is sent it must name the same host and port, otherwise 403 "Cross-origin
  requests are not allowed." (`Origin: null` is refused too, as is `Sec-Fetch-Site: cross-site`.)
- **Important limit:** the Host and Origin checks read *headers the client supplies*. They stop a web page in your browser
  (which cannot forge them); they do **not** stop a program or another computer that sets the headers itself. That is why
  the address must stay `127.0.0.1` ([Installation](installation.md#changing-the-listening-address-is-not-supported)).
- **Body limits.** JSON bodies: **2 MB** (`JSON_LIMIT_BYTES`), 413 above that. Raw uploads: **25 MB** by default; data files
  25 MB, app and table-from-CSV imports 25 MB, solution packages 40 MB. Attachment uploads are read up to 200 MB at the
  route and then refused if they exceed the column's limit (25 MB by default; see [Attachments](#attachments)). JSON requests must be `Content-Type: application/json` (415
  otherwise). A request may take at most 10 minutes (`server/main.ts`).
- **Errors** never include stack traces, SQL or secrets: unexpected errors become "Internal server error." and are logged
  on the server.
- Static files (the web app) are served without the Host check; they contain no data. Requests with `..`, hidden
  (`.`-prefixed), empty or backslash path parts are refused (`server/core/static.ts`).

## Security headers and Content-Security-Policy

All API responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN`
and `Cache-Control: no-store`. The HTML page is served with:

```
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';
                         script-src 'self' 'unsafe-inline'; connect-src 'self'
```

(`HTML_CSP` in `server/core/router.ts`; set by `server/core/static.ts`.) Effects: the page can load only its own
resources, **cannot load images from other sites** and cannot send requests to other sites, so an app cannot phone home
through the browser. Weakness: `script-src` and `style-src` allow `'unsafe-inline'` because the web app is built as one
file with inline script, so the CSP is a weaker defence against injected script than a strict policy would be.

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
- Not encrypted: the database's own files, the rows in your tables, data files, attachments, and `mysqldump` backups. These
  are as readable as the operating system and database permissions let them be.

## Data access and SQL

- Row filters, own-row scope and column access are turned into conditions that are **part of the SQL query**, not
  applied to the result afterwards (for the MySQL connector). Writes are guarded the same way (an `UPDATE` carries the
  row condition), so a row changed or removed by someone else in the meantime does not slip through.
- Values are sent to the database as query parameters; table and column names are validated (`^[A-Za-z_][A-Za-z0-9_]*$`)
  and quoted. A test feeds `x' OR 1=1; DROP TABLE t_orders; --` through the query builder
  (`server/connectors/mysql/sql.test.ts`).
- **Tables whose names start with `ab_` are never exposed or used for user data**: they are hidden from the list of
  linkable tables, and any attempt to use one is refused ("Tables starting with "ab_" are reserved for the platform").
- A user who may not know a table exists gets "does not exist" (404), and a row they may not see gets "Row not found",
  not "not allowed", so existence is not revealed.
- **Row cap:** the server returns at most **5,000 rows** per query (`DEFAULT_ROW_CAP`); apps are told when results were
  truncated. CSV export is capped at 1,000,000 rows. This is a performance limit, not a security feature, and applies
  after the user's own filters.
- Formulas in the exported CSV are **not** neutralised: a cell whose text starts with `=`, `+`, `-` or `@` will be
  evaluated if the file is opened in Excel. Google Sheets writes use `RAW` mode, so values you save into a sheet are
  never turned into formulas (`server/connectors/gsheets/index.ts`).

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

Changes are recorded in `ab_audit`: who, when, what. Reads are not. Not tamper-evident: anyone with database write access
can alter it, and an audit write that fails is logged and **ignored**, not retried. Details, actions and SQL queries
are on the [Audit log](audit-log.md) page.

## Demo mode is not secure

The browser-only demo (no server, data in the browser's IndexedDB) simulates roles so people can try the product.
There is no sign-in, "Run as user" lets the person pick any user, and rules are applied by the same browser code the
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
| Guessing passwords through the sign-in form | scrypt, uniform errors, 8-per-15-minutes throttle |
| Theft of a database dump | Password hashes, hashed session tokens, encrypted connection secrets (key kept elsewhere) |
| Uploaded files running script | Sandboxed CSP and `nosniff` on downloads |
| SQL injection through values and names | Parameters, identifier validation and quoting |

**Not defended (by design or not yet built):**

- **Anyone who controls the PC.** An administrator of the operating system, or malware running as the user, can read the
  workspace folder (including `.secret-key`), the database files, the process memory and the environment, and can
  change the code. Anyone with the database login can read and change all data, **and the audit log**.
- **Other users of the same PC.** Every local account can reach `127.0.0.1:5174` and the sign-in and setup pages.
- **The network.** No TLS: if the port were reachable, passwords and sessions would be visible. Do not expose it.
- **Physical access** to the PC or to unencrypted backups. Use disk encryption (BitLocker) and protect backups.
- **A compromised maker.** A maker can read every table in the connected database through linking, and drop tables.
- **Weak passwords.** Only the length rule exists.
- **The Google service-account key** is stored encrypted, but with a key on the same machine; whoever gets both can use
  the key against Google (it grants access to the sheets shared with it).

## Explicit limitations

- Single machine; no network, multi-server or high-availability use.
- No TLS by default on localhost, and none at all in the built-in server.
- No multi-factor sign-in, no single sign-on, no password reset by email (administrators reset passwords).
- **No rate limiting other than the sign-in throttle**: other API calls are not limited; a signed-in user can send as
  many requests as the PC can handle.
- Row filters and the Own scope control what is read, changed and deleted but **do not check the values written**
  (see [Users and roles](users-and-roles.md#known-limits-of-row-filters)).
- Makers can bypass table privileges by re-linking a table, and can drop tables and columns.
- Writes from the browser are optimistic (see above).
- Query results are capped at 5,000 rows.
- Data is not encrypted at rest; backups are not encrypted.
- The audit log is not tamper-proof, does not record reads, and has no viewer or retention.
- The Content-Security-Policy allows inline script and style.
- Unauthenticated `GET /status` reveals database host, port and name to local callers.
- Anyone who may open an app can read its definition.
- No built-in backup, no integrity check of the workspace, no check when an older version is run against a newer
  database.

## Evidence

| Statement | Evidence |
| --- | --- |
| scrypt parameters and hash format | Test: `unit.test.ts` ("hashes with scrypt"); code `password.ts` |
| Password policy | Test: `unit.test.ts` ("enforces the policy"); run |
| Throttle: 8 failures, 15 minutes | Test: `unit.test.ts` ("throttles after 8 failures"); run (9th attempt answered 429) |
| Same message for unknown, wrong and disabled | Test: `integration.test.ts` ("login errors are uniform"); run |
| Session cookie flags and 7-day expiry | **Run** only (curl `Set-Cookie`); no test |
| Sliding expiry, 10-minute touch interval | **Code only** (`auth.ts`); no test |
| Sessions removed on disable, password change, reset | Test: `integration.test.ts` ("password change rotates sessions"), `security.test.ts`; run |
| Sessions survive restart; throttle does not | Run |
| CSRF header, Host and Origin checks, body limits | Tests: `unit.test.ts` "router guards"; run (also for spoofed Host on `0.0.0.0`) |
| Security headers on API | Test: `unit.test.ts` (nosniff, referrer, no-store); X-Frame-Options by run |
| HTML Content-Security-Policy | **Run** only (curl); no test |
| AES-256-GCM, key file mode, env key, tamper detection | Test: `unit.test.ts` "SecretBox" |
| Secrets never returned, removed from errors | Test: `connections.test.ts` ("never returns the secret"); run |
| Lost key makes saved password unreadable | Run |
| RBAC, RLS, CLS and role union | Tests: `unit.test.ts` "security engine", `integration.test.ts`; run on all worked examples |
| `ab_` tables never exposed | Run and code (`sql.ts`, `util.ts`); tested in `connections.test.ts` ("skip registered and system tables") |
| Attachment permissions and sandbox CSP | Test: `integration.test.ts` (attachments) |
| Row filters not applied to written values; Maker re-link bypass | **Run** only; no test (these are limitations) |
| Setup endpoints open while unconfigured | Run |
| Audit actions and contents | Run and code |
| Windows ignores file modes | Code comment in `secrets.ts`; not tested on Windows |
