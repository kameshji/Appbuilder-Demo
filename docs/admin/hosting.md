# Hosting: many installs on one server

For the operator of a hosted Appbuilder: one Linux server that runs one install per organisation, each with its own
process, database and role, folder and secret key, behind one reverse proxy (Caddy) with a host name per organisation.
The design is in [the hosting specification](../plan/hosting-spec.md). This page covers what one install offers for that
(packages H-A and H-C). The fleet tool `abfleet`, which creates, updates, backs up and suspends installs, comes in a later
package and uses exactly these settings and commands.

An on-premises install does not need any of this: with none of the settings below it behaves as before.

## The settings of one install

Each install reads its settings from its environment. With `APPBUILDER_ENV_FILE=/srv/appbuilder/<org>/instance.env` the
server and every command load that file first (lines `KEY=value`, `#` comments; a variable already set in the process wins).

| Variable | Hosted value | What it does |
| --- | --- | --- |
| `APPBUILDER_HOSTED` | `1` | The hosted profile: the defaults below switch to the hosted values, and outbound connections to loopback and private networks are always refused (`APPBUILDER_OUTBOUND_PRIVATE=deny`; another value stops the server at start). |
| `APPBUILDER_PUBLIC_URL` | `https://<host>.<domain>` | The **locked** public address. Every link the install generates starts with it: invitation, reset and email-change links, approval answer links, unsubscribe links, notification and report links, dashboard snapshot links, webhook and WhatsApp callback addresses. Admin console > Email shows it and refuses another one. Its host is added to the allowed host names, and (hosted) to `APPBUILDER_OUTBOUND_DENY`. An `https://` address turns on `__Host-` cookies and `Secure`. Required with `APPBUILDER_HOSTED=1`. |
| `APPBUILDER_SOCKET` | `/run/appbuilder/<org>/http.sock` | Listen on this Unix domain socket instead of a TCP port. A stale socket file is removed at start; one a running server answers on stops the second server. The file is removed when the server stops. |
| `APPBUILDER_SOCKET_MODE` | `660` (default) | The socket's permission bits: the install's user and the proxy's group. Rights for others are refused. |
| `PORT`, `APPBUILDER_HOST` | `7101` to `7199`, `127.0.0.1` | The fallback without sockets: one port per install on loopback. |
| `APPBUILDER_SETUP` | `closed` (hosted default) | `/api/v1/setup/*` answers 404, also before setup; no setup code is printed. Setup is done with the commands below. |
| `APPBUILDER_DB_POOL` | `6` (hosted default; 10 otherwise) | Connections of the system database pool. With the job worker's LISTEN connection, a backup and the commands, set `ALTER DATABASE ... CONNECTION LIMIT 12`. |
| `APPBUILDER_JOBS_POLL_MS` | `5000` (hosted default; 1000 otherwise) | The job worker's polling fallback. Database notifications still wake it at once; an idle install used 0.2 % of a core instead of 0.3 % in the measurements. |
| `APPBUILDER_INSTANCE_DIR` | `/srv/appbuilder/<org>` | The one folder the install writes to. The workspace, `APPBUILDER_LOG_DIR`, `APPBUILDER_BACKUP_DIR` and `APPBUILDER_SETUP_CODE_FILE` must be inside it, or the server does not start. In Admin console > Backups a backup or off-site folder outside it is refused, and the PostgreSQL tools folder cannot be set (it names programs the server runs; set `APPBUILDER_PG_BIN` instead). |
| `APPBUILDER_WORKSPACE` | `/srv/appbuilder/<org>/workspace` | As on-premises: `server.json`, `.secret-key`, environments' files, logs. |
| `APPBUILDER_BACKUP_DIR` | `/srv/appbuilder/<org>/backups` | As on-premises. |
| `APPBUILDER_OUTBOUND_DENY` | `*.<domain>`, the server's own public addresses (the install's own host is added by itself) | Comma-separated host names (`*.domain` allowed) or addresses nothing may connect to. Set `*.<domain>` so a connector, database connection or flow aimed at a sibling install is refused by name, and add the server's public IPv4 and IPv6 addresses. Without them such a call would go out to the server's public address and come back in through the proxy with TLS and host routing, as any outside client's request does: not a path around isolation, but nothing a hosted install needs. |
| `APPBUILDER_READ_ONLY` | not set | `1` or `suspended`, `payment`, `maintenance`, `licence`: read-only from start (see [Read-only](#read-only)); `APPBUILDER_READ_ONLY_MESSAGE` adds one line. |
| `APPBUILDER_SHUTDOWN_MS` | `15000` (hosted default; 5000 otherwise) | How long a stopping server waits before it exits. Longer than the job worker's 10 seconds of grace, so running jobs are handed back cleanly. |
| `APPBUILDER_TRUST_PROXY`, `APPBUILDER_SECURE_COOKIE` | `1` (hosted defaults) | As on-premises behind a reverse proxy. |
| `APPBUILDER_DB_HOST` ... or `server.json` | the install's own database and role | As on-premises (`appbuilder seed-config` seals the password). |

Check an environment before starting: `appbuilder hosting-check` prints the effective settings and every problem (exit
code 1 with problems). The server refuses to start with the same problems.

## First-run setup without the setup screen

Over the proxy the setup screen is never offered. On the server, as the install's user, with its environment:

```bash
appbuilder seed-config --workspace /srv/appbuilder/o1/workspace --db-name ab_o1 --db-user ab_o1 < password-file
appbuilder migrate                                         # creates the schema, then exits
appbuilder admin invite --email it@acme.example --name "Asha Rao"
```

`admin invite` creates an install administrator **without a password** and emails a one-time invitation (valid 7 days)
with the locked public address; the person chooses a password when opening it. Nothing secret is printed. Without a mail
relay it refuses, unless you add `--print-link`, which prints the link (treat it like a password). Both commands work with
the server stopped or running, and are recorded in the install audit log with source `cli`.

## Health

`GET /api/v1/health` answers `{"status":"ok"}` (200), `starting` or `degraded` (503) to anyone, nothing more: no version,
host or database. Over a socket: `curl --unix-socket /run/appbuilder/o1/http.sock http://localhost/api/v1/health`, or
`appbuilder health` (it uses `APPBUILDER_SOCKET` when set). The socket appears only after the database is open and
migrated, so the proxy never reaches a half-started install.

## Stopping

On `SIGTERM` the install stops accepting connections, closes idle ones, closes the live connections, gives running jobs
10 seconds (the rest are handed back for the next start), closes the database and exits (at the latest after
`APPBUILDER_SHUTDOWN_MS`).

## Read-only

One state with a reason: `suspended` (by the operator), `payment` (unpaid), `maintenance`, `licence` (the licence
could not be verified for more than 3 days; set by the licence client, see [Licensing](licensing.md)). Set it with `appbuilder read-only on --reason suspended [--message "..."]`
(applied by a running server within 5 seconds, no restart), end it with `appbuilder read-only off`, see it with
`appbuilder read-only status`. Writes are refused, reads, sign-in and exports work; the details are in
[Operations](operations.md#read-only-installs).

## Licence

Every hosted install gets `APPBUILDER_LICENCE_URL=https://licence.<domain>`, `APPBUILDER_LICENCE_ID` and
`APPBUILDER_LICENCE_KEY_FILE` (an install key from `licence-service key issue <org>`, in a file readable only by the
install's user). The install checks at start and every 6 hours and sends only its seat counts. The licence service runs
on the same server as its own process and database (`node server/licence-service/main.ts serve`, behind Caddy as
`licence.<domain>` with `APPBUILDER_LICENCE_TRUST_PROXY=1`); the commands, the grace and what it does not resist are in
[Licensing](licensing.md). A licence that becomes unpaid or suspended in the licence service makes the install read-only
with that reason (`payment` / `suspended`) after the notice; `appbuilder read-only on` stays the immediate switch.

## Cookies

With an `https://` public address every Appbuilder cookie carries the `__Host-` prefix, so one install's pages cannot set a
cookie another install receives (`a.<domain>` and `b.<domain>` are the same site to a browser). When you switch an existing
install to it, people sign in once more and a remembered device asks for the second step once; nothing else changes.

## Isolation evidence

`node scripts/exit-check/h-isolation.mjs` (developers and CI; [testing](../dev/testing.md#isolation-suite-hosting-exit-check-2))
starts three installs with these settings behind a host-routing proxy and attacks one from another: host names and
forwarding headers, cookies, sessions, API keys, view tokens, every kind of email link, tickets, the live socket, database
roles (including a check that a database created without `REVOKE ... FROM PUBLIC` is detected), outbound connections,
folders, backups and the read-only state. It is evidence for the release gate, not a security review; an outside review is
still wanted. Database roles must be created as it does: `NOSUPERUSER NOCREATEDB NOCREATEROLE`, `CONNECTION LIMIT 12`,
`statement_timeout` 60 s, the database owned by the role with `REVOKE ALL ... FROM PUBLIC` and `GRANT CONNECT, TEMPORARY`
to the role, and once per cluster `REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC`. A role can still change its
own `statement_timeout` in a session (PostgreSQL has no per-role ceiling); the connection limit holds.

Known open finding: a database connection to a host *name* that resolves to the server itself is refused when saved or
tested but can still be used to list tables, which connects to that address (see the security model, "Outbound
connections"). Until it is fixed, keep PostgreSQL's `pg_hba.conf` to password authentication for the install roles on
127.0.0.1 (never `trust`), and do not run other unauthenticated services on the server's loopback.

The fleet's mail relay: hosted installs refuse loopback and private addresses, so a relay on the server itself
(`127.0.0.1:25`) is refused too. Use a relay on a public address, or a later package adds a narrow exception for it.

## The fleet tool

`abfleet` (packages H-D to H-K) creates, updates, backs up, limits, suspends and deletes installs with exactly these
settings and commands, plus the systemd template unit `appbuilder@<id>`, one OS user `ab-<id>` per install, the Caddy
site per host name, and database roles prepared as the isolation suite requires. The operator's runbook (day one,
every day, an update, a restore, an incident) is [Fleet operations](fleet-operations.md). It has not run on a rented
server yet.

What the fleet tool needs from an install and does not find as a server command, and does through its agent instead
(`scripts/fleet/agent.ts`, the install's own modules run as the install's user): an install backup made from the
command line (the archive engine), the fleet's mail relay saved before the first invitation, and the time-boxed
operator access account with the announcement to the administrators. The secret key cannot be rotated: the server has
no command that re-seals the stored secrets ([Fleet operations](fleet-operations.md#an-incident)).

## Not part of this yet

Listening on a Unix socket, the socket's permissions and the clean stop are tested on Linux (continuous integration); on
Windows only the TCP variant runs. The fleet's own Linux parts (template unit, OS users, Caddy) run in the CI job
`fleet` only.
