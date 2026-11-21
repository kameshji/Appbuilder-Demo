# Hosting phase: a managed fleet of installs, and licensing

Status: **PARTLY BUILT** (version 0.8.0, 21 Nov 2026): see "Status at version 0.8.0" at the end; nothing has run on a real server. (Written 20 Nov 2026 as a proposal.) Inputs: [master-plan.md](master-plan.md)
sections 12 to 14, [hosting-and-licensing.md](hosting-and-licensing.md), [../decisions.md](../decisions.md) (D14, D15, D20,
D22, D24 to D26, D32, D38, D43, D45 to D47), the security reviews of Phases 0 to 2, and a measuring spike
(`scripts/bench/mt-spike.mjs`; "Measurements" below). Order agreed by the owner: this specification, then this phase, then
Phase 3.

**The decision this phase builds (orchestrator, 20 Nov 2026, delegated by the owner):** for at most 20 organisations of 20 to
50 people (4 or 5 makers each) on **one server**, every organisation gets **its own install**: its own server process, its
own PostgreSQL database and role, its own workspace folder and secret key, behind one reverse proxy with a host name per
organisation (`<org>.<domain>`). The owner's goal: "a completed product I can ask 20 organisations at most to use in a paid
pilot". Why this and not true multi-tenancy in the product:

- isolation comes from the operating system and PostgreSQL (process, database, role, files), not from new product code;
  the kernel does not change and Phases 0 to 2 need no tenancy re-review;
- a product bug cannot show one organisation another's data: there is no code path that holds two organisations;
- hosted and on-premises are the same build, the same installer core and the same updater;
- it reaches a paid pilot soonest.

True multi-tenancy stays a documented later option (appendix A), reversible because an install's export archive can later be
imported as a tenant.

## Goal

One Linux server runs up to 20 Appbuilder installs, created, updated, backed up, suspended and deleted by one operator tool
without manual steps, each reachable over HTTPS on its own host name, isolated from the others by test, each verifying its
licence online with 3 days of grace. On-premises keeps today's single install on Windows or Linux, with the same licence
check.

## Non-goals (this phase)

- Tenancy inside one install (appendix A); more than one process per install; high availability.
- An operator web console (the CLI comes first; the console is a later package, MT-style "designed, not built").
- Open self-service sign-up, custom domains per organisation, a second region.
- Gateway subscriptions (invoice first; see the licensing decisions).
- Windows as a hosting platform. **Linux (Ubuntu 22.04/24.04 LTS, systemd) is the hosting target.** Windows stays the
  single-install on-premises platform it is today.
- Phase 3 content. Licence passes (seat passes) are pulled into this phase.
- Any claim of compliance or certification; contract, data-protection, tax and GST points are for a lawyer and an
  accountant.

## Defaults chosen so agents can build without waiting (owner may change)

| # | Question | Default chosen | Cost of changing later |
| --- | --- | --- | --- |
| DC-1 | OS account per install or one shared | **One system user per install** (`ab-<org>`) | none: shared would be the weaker choice |
| DC-2 | Database server | **One PostgreSQL 17 cluster with one database and one role per install** (not one cluster each) | a cluster per install would be a provisioning change |
| DC-3 | How installs listen | **A Unix socket per install** (`/run/appbuilder/<org>/http.sock`), not TCP ports; TCP on 127.0.0.1 as a fallback option | small: the server gains a socket option either way |
| DC-4 | TLS | **Caddy with automatic HTTPS per host name** (`<org>.<domain>`, HTTP-01, one certificate each); a local CA (`tls internal`) in tests | a wildcard certificate by DNS challenge needs a DNS provider token |
| DC-5 | Operator tool | **A CLI `abfleet` on the server, run as root by the operator**; web console later | the console reuses the CLI's library |
| DC-6 | Licence service | **A separate small process and database on the same server** (`licence.<domain>`), same code base, its own unit | moving it to another machine is a DNS change |
| DC-7 | Payments | **Invoice and bank transfer; the operator records "paid until" in the licence service**; Razorpay later (licensing section) | additive package |
| DC-8 | Organisation creation | **By the operator** (`abfleet create`), with the first administrator invited by a one-time email link | open sign-up later |
| DC-9 | Makers' HTTP connectors, database connections and flows | **Allowed**, with every hosted install forced to `APPBUILDER_OUTBOUND_PRIVATE=deny` and the fleet's extra refusals (threat model) | a per-install setting |
| DC-10 | Region | **One region (India)**; provider chosen by the owner when the server is rented | a second server is a second fleet |
| DC-11 | First load target | **20 installs x 50 named users (1,000), 150 concurrent people, 200 live sockets, 50 requests/s sustained across the fleet, 100/s peak** | numbers only |
| DC-12 | Smallest server for the target (estimate, no load test yet) | **8 vCPU, 32 GB RAM, 400 GB NVMe** (sizing section); exit check 7 confirms or corrects it | a different plan |
| DC-13 | Suspension | **Read-only by default** (sign-in and export work); "stopped" (unit off, proxy shows a notice) on request | both exist |
| DC-14 | Deleted organisation | **Export first, kept 30 days by the operator off-machine, then destroyed**; fleet backups age out after 14 days | numbers |
| DC-15 | What "lifetime" on-premises includes | **Perpetual use of every version released during paid maintenance years; security fixes for the current minor during them** | contract wording (lawyer) |
| DC-16 | On-premises offline beyond 3 days | **No special licence** (owner decided 3 days) | an extended-grace flag is additive |
| DC-17 | Seat passes | **Full user** (everything), **Operator** (runs apps, phone apps, approvals, dashboards; no Studio, data model, flow designer), **External** (reserved for Phase 6 portals: counted, not assignable yet) | pass rules are data |
| DC-18 | Job polling of an idle install | **`APPBUILDER_JOBS_POLL_MS=5000` in hosted installs**: measured idle CPU fell from 0.3 % to 0.2 % of a core per install; LISTEN/NOTIFY still wakes work at once, polling is only the fallback | a setting that already exists; no product change needed |

## Measurements (spike, 20 Nov 2026)

**Caveat for every number:** developer PC (Intel i7-12700K, 8 performance + efficiency cores, 16 threads, 93 GB RAM,
Windows 11, Node 26.4) shared with other work; sandbox PostgreSQL 16.11 with **fsync off**, default settings. Comparisons,
not capacity figures. No load test of any size exists yet. Re-run: `node scripts/bench/mt-spike.mjs <part>`.

### One install

| What | Measured |
| --- | --- |
| Working set, idle after start (Windows) | 153 MB (private 147 MB) |
| After 500 writes (25 at once), 300 Query v2 pages with exact count, 3 environments | 226 MB (private 224 MB) |
| 50 parallel queries (pool of 10) | 79 ms for all, median 72 ms each; memory 228 MB |
| Database connections: idle / after use | 3 / 11 (system pool 10 + the job worker's LISTEN connection) |
| Query v2 page with exact count over HTTP, sequential | 15.5 ms median |
| Start-up on an empty database (creates schema `ab` and `env_default`) to a healthy answer | 2.4 s median (max 2.5 s, 10 installs started one after another) |
| Disk of an empty install: database / workspace | 14.6 MB / about 1 KB (attachments and logs grow from there) |

### Ten installs on one machine (ports 5290 to 5299, one database each, all set up, no users active)

| Idle for 60 s, 15 s after start | Job polling 1 s (today's default) | Job polling 5 s |
| --- | ---: | ---: |
| Node CPU per install (median) / all 10 | 0.3 % / 2.8 % of one core | 0.2 % / 1.5 % |
| PostgreSQL CPU, whole cluster (baseline without installs: 0.2 % and 0.8 %) | 0.3 % | not measurable (the summed CPU of the postgres processes fell: backends ended during the window) |
| Working set per install (median) / all 10 | 123 MB / 1,230 MB | 123 MB / 1,228 MB |

(The second run overlapped a 2-second docs test run on the same PC.)
| Database connections per install / all 10 | 3 / 30 | 3 / 30 |

Idle installs do not keep a server busy: 20 would use about 6 % of one core. The worker's per-environment tick (appendix A)
is about 8 ms per environment per second, small for an install with 1 to 5 environments. The polling interval already has a
setting (`APPBUILDER_JOBS_POLL_MS`); DC-18 records what the hosted default should be.

### Database roles (PostgreSQL 16)

| Test | Result |
| --- | --- |
| A role owning database A, with PostgreSQL's default grants, connects to database B and to `postgres` | **connected** (PUBLIC has CONNECT on every new database) |
| After `REVOKE ALL ON DATABASE ... FROM PUBLIC` and `GRANT CONNECT, TEMPORARY ... TO <own role>` | B: **refused** ("permission denied for database"); own database: connected; `postgres`: still connected until revoked there too |
| `ALTER DATABASE ... CONNECTION LIMIT 2` | the third connection is refused ("too many connections for database") |

The Linux installer already revokes PUBLIC on its database (`scripts/install/linux/install.sh` lines 303-304); the fleet tool
must also revoke CONNECT on `postgres` and `template1` from PUBLIC. Every role can still read the cluster-wide catalogues
(`pg_database`, `pg_roles`): database and role names are visible to every install, so they are opaque ids, never
organisation names.

### Connections for 20 installs

20 installs x (pool 10 + 1 LISTEN) = **220 connections** at worst, above PostgreSQL's default `max_connections` of 100. At
this size an install needs far fewer: the measured idle install holds 3 and 50 parallel queries were served by 10 in 79 ms.
Chosen: **pool 6 per hosted install** (a new setting `APPBUILDER_DB_POOL`, default 10 for on-premises), per-database
`CONNECTION LIMIT 12` (pool + LISTEN + backup + admin CLI), `max_connections = 300`. No pooler (PgBouncer) is needed at 20
installs.

### Sizing for 20 organisations x 50 people (estimate)

| Part | Estimate | From |
| --- | --- | --- |
| Install processes | 20 x 0.25 to 0.5 GB = 5 to 10 GB | measured 153 MB idle, 226 MB after light use; a busy day with PDFs and imports is not measured (assume up to 2x) |
| PostgreSQL | `shared_buffers` 4 GB, about 250 backends x 10 to 20 MB, OS cache for the rest: 8 to 12 GB | PostgreSQL defaults; 1,000 users' data is small (a few GB) |
| Caddy, licence service, operator tool, OS | 1 to 2 GB | |
| CPU | 8 vCPU: each install's event loop uses one core while busy; 150 concurrent people across 20 installs rarely need more than 3 or 4 busy at once; PostgreSQL and backups take the rest | hosting-options.md (4 vCPU for one install of 1,000) |
| Disk | 20 x (data 2 to 5 GB + attachments 5 to 10 GB) + local backups for 7 days, NVMe: 400 GB | assumptions; quota per install below |

**Smallest server that should carry the target: 8 vCPU, 32 GB RAM, 400 GB NVMe** (DC-12). With no load test this is an
estimate; exit check 7 runs the target on the rented server and the number is corrected from it.

## Exit checks

All scripted (`scripts/exit-check/hosting*.mjs`, run by `node scripts/exit-check/hosting.mjs`). Each check says where it can
run: **local** (this Windows PC, installs started directly as processes on 127.0.0.1, PostgreSQL in the sandbox), **CI**
(Linux GitHub runner: systemd-less, processes started directly, Caddy binary), or **server** (a rented Linux server or a
Linux VM with systemd: the unit template, OS users, systemd limits, real certificates). There is no Docker and no WSL
distribution on this PC, so everything that needs systemd or Linux users waits for CI or the server.

1. **Provisioning without a manual step** (CI, server; local with processes): `abfleet create` 20 times; every install
   answers on `https://<org>.<test-domain>` with a certificate from the test's local CA (Caddy `tls internal`), its first
   administrator signs in through the emailed one-time link (fake SMTP), and creates a table and an app.
2. **Cross-instance isolation suite** (local for the HTTP, database and outbound parts; server for OS users, file permissions
   and systemd): as organisation A's administrator, as A's maker and as an anonymous client, try to reach B: Host header and
   `X-Forwarded-Host` tricks through the proxy, A's session cookie, remembered-device and MFA cookies sent to B's host, A's
   API key, kiosk view token, webhook and WhatsApp callback URLs, email links (reset, invitation, approval, unsubscribe) used
   at B, A's database role connecting to B's database and to `postgres`, A's process reading B's workspace, backups and
   logs, A's HTTP connector, database connection, SMTP relay and flows aimed at B's socket or port, PostgreSQL's address,
   Caddy's admin API, the licence service's internal address, the host's other services and cloud metadata. Pass: every
   attempt refused, nothing of B readable, writable or inferable. **Release gate for the hosted server.**
3. **Fleet update with a canary and a forced failure** (CI, server): `abfleet update <release>` updates the canary install,
   waits for health and a smoke script, then the rest in batches; one install is made to fail its health check: it alone is
   rolled back to the previous release and reported; the others run the new release.
4. **Per-organisation backup and restore** (local, CI): the scheduled backup of every install reaches the off-machine target
   (a second folder or an S3-compatible test server in the test); one organisation is restored in place and as a copy; every
   other install's database checksums and folders are unchanged and their users stay signed in.
5. **Lifecycle** (local, CI): suspend (read-only: writes refused with `install_read_only`, reads, sign-in and export work),
   resume, stop and start, export (verified archive), delete (after export: no database, role, OS user, folder, unit,
   proxy entry, backup or log of the organisation remains; a scan proves it).
6. **Licence check with 3 days of grace** (local, clock-driven): valid -> normal; the licence service unreachable -> works
   with an administrator banner for 72 hours; after 72 hours -> read-only, export works; service back -> writable; a tampered
   or replayed answer refused; a clock set back detected; seats over the licence warn and never lock existing people out;
   one licence used by two installs flagged.
7. **Load test at 20 organisations x 50 users** (server; a reduced local run first, reported with its caveats): 30 minutes
   at 50 requests/s spread over 20 installs (reads, writes, app opens, dashboards, PDFs, flows), 200 live sockets, then 5
   minutes at 100/s. Pass: read p95 <= 300 ms, write p95 <= 500 ms, p99 <= 1 s, errors < 0.1 %, live tick p95 <= 500 ms,
   each install's event loop lag p99 <= 100 ms, total memory <= 75 % of the server, PostgreSQL connections <= 250, idle fleet
   (no users) <= 10 % of one core in total (measured: about 0.3 % per idle install). The report lists CPU, memory and connections per install.
8. **One install misbehaving does not take the others down** (server; CPU and memory parts locally): install A runs a CPU
   loop (formula budget exhausted repeatedly, PDF of 500 pages), grows memory until its limit, and fills its disk quota;
   A is throttled, restarted by systemd or refused writes; the other installs' p95 latency stays within max(25 %, 100 ms) of
   their baseline and none of them restarts.
9. **On-premises unchanged** (local, CI): the single-install Windows and Linux installers and the Phase 0, 1 and 2 exit
   checks (`p0.mjs`, `p1.mjs`, `p2.mjs`) pass unchanged; an existing 0.7.0 install updates in place with the updater and rolls
   back.
10. **Secrets rotation** (local): `abfleet rotate <org> db-password|secret-key` rotates one install's database password
    (sealed again in its `server.json`) and its secret key (every sealed value re-sealed), and the install keeps working.
11. **Docs and security**: an operator guide, the incident procedure, a security re-check of the fleet design
    (`docs/internal/security-review-hosting.md`), decisions recorded, version 0.8.0.

## Fixed decisions and contracts

### 1. Instance layout on disk (Linux)

```
/opt/appbuilder/releases/<version>/        one unpacked, verified release per version; root-owned, read-only (0755 dirs, 0644 files)
/opt/appbuilder/current -> releases/<v>    the release new installs start on
/srv/appbuilder/<org>/                     one folder per install, owner ab-<org>, mode 0750
    app -> /opt/appbuilder/releases/<v>    the release THIS install runs (switched by the updater)
    app.previous -> releases/<v-1>         for rollback
    instance.env                           root:ab-<org> 0640 (PORT or socket, workspace, public URL, limits)
    workspace/                             server.json (database password sealed), .secret-key, env/<id>/..., logs/
    backups/                               this install's local backups (also copied off the machine)
/run/appbuilder/<org>/http.sock            the install's socket (owned ab-<org>, group caddy, 0660)
/etc/appbuilder/fleet.json                 the registry: org id, host name, state, release, limits (root 0600)
/var/log/appbuilder-fleet/audit.jsonl      the operator audit, append-only (root 0600, chattr +a)
```

- `<org>` is an opaque id (`o` + 8 base32 characters); the host name label is separate (registry), because database, role
  and user names are visible to every install (measurements).
- On-premises installs keep today's layout (`/opt/appbuilder/app`, `/var/lib/appbuilder`); the updater learns the releases
  folder for fleet installs only.

### 2. Processes, sockets and the unit template

- **One systemd template unit** `appbuilder@.service`, instance name = org id: `User=ab-%i`, `EnvironmentFile=/srv/appbuilder/%i/instance.env`,
  `WorkingDirectory=/srv/appbuilder/%i`, `ExecStart=<node> /srv/appbuilder/%i/app/server/main.ts`, the hardening of today's
  unit (`ProtectSystem=strict`, `ReadWritePaths=/srv/appbuilder/%i /run/appbuilder/%i`, `ProtectHome`, `PrivateTmp`,
  `NoNewPrivileges`, no capabilities), plus per-install limits (section 4). `Restart=on-failure`, `RestartSec=5`,
  `StartLimitBurst=5` in 10 minutes (then the operator is alerted).
- **The server listens on a Unix socket** when `APPBUILDER_SOCKET` is set (new, small change in `server/main.ts`: `server.listen(path)`),
  else on `APPBUILDER_HOST:PORT` as today. With sockets no install can open another's TCP port, and loopback ports are not
  needed. Fallback: TCP ports 7101 to 7199 on 127.0.0.1, one per install (DC-3).
- Caddy (group member of every socket) is the only process that talks to the sockets.

### 3. Reverse proxy

`abfleet` writes `/etc/caddy/fleet.d/<org>.caddy` from a template and reloads Caddy:

```
<host>.<domain> {
	header Strict-Transport-Security "max-age=31536000"
	request_body { max_size 60MB }
	reverse_proxy unix//run/appbuilder/<org>/http.sock {
		header_up Host {host}
		header_up -X-Forwarded-Host
	}
}
```

- Caddy routes only exact host names it has a site for; an unknown or internal host name gets no route (a catch-all site
  answers 404 without proxying). The upstream receives only the canonical host; `X-Forwarded-Host` is removed.
- The install's `APPBUILDER_ALLOWED_HOSTS` is its one host name, `APPBUILDER_TRUST_PROXY=1`, `APPBUILDER_SECURE_COOKIE=1`.
- Caddy's admin API stays on its default local address and is refused by every install's outbound policy (threat model).
- Limits per site: request body 60 MB (above the largest route limit, 40 MB solution packages), connection and request rate
  limits per client address are a Caddy setting documented with numbers chosen in the load test.

### 4. Resource limits per install

| Resource | Limit (default chosen, owner may change) | How |
| --- | --- | --- |
| Memory | `MemoryHigh=1G`, `MemoryMax=1.5G` | systemd; Node heap `--max-old-space-size=1024` |
| CPU | `CPUQuota=200%`, `CPUWeight=100` | systemd (an install never takes more than 2 cores) |
| Tasks, files | `TasksMax=256`, `LimitNOFILE=8192` | systemd |
| Database connections | pool 6, `ALTER DATABASE ... CONNECTION LIMIT 12`, `ALTER ROLE ... CONNECTION LIMIT 12` | PostgreSQL |
| Statement time | `ALTER ROLE ... SET statement_timeout = '60s'`, `idle_in_transaction_session_timeout = '5min'` | PostgreSQL (the product's own query timeout stays shorter) |
| Disk | a per-install XFS project quota (or an ext4 project quota) on `/srv/appbuilder/<org>` of 25 GB; database size watched by `abfleet status` with a warning at 80 % of the plan | filesystem; PostgreSQL has no per-database quota |
| Logs | the server's rotating file log in `workspace/logs` (D25: rotated by size) plus journald with `LogRateLimitIntervalSec` | existing |
| Outbound | `APPBUILDER_OUTBOUND_PRIVATE=deny` and the fleet refusals (threat model) | product setting |

### 5. Provisioning: first-run setup done by the tool, safely

Today the first administrator is created through `/setup/admin`, a loopback-only route that refuses proxied requests and
needs the setup code. The tool does not use it through the proxy. Instead (new CLI commands of the server, run by `abfleet`
as the install's user before the unit starts):

1. `seed-config` (exists, D25) seals the generated database password into `server.json`.
2. `node server/main.ts migrate` (new): creates the schema, then exits.
3. `node server/main.ts admin invite --email <e> --name <n>` (new, beside the existing `admin` recovery commands): creates the
   first install administrator **without a password** and an invitation token (D20's single-use `invite` tokens), marks setup
   complete, prints nothing secret; the invitation email goes through the fleet's mail relay with the install's public URL.
4. `APPBUILDER_PUBLIC_URL=https://<host>.<domain>` (new, locks the public address used in email links, webhooks and
   WhatsApp callback URLs; the Admin console shows it read-only) and `APPBUILDER_SETUP=closed` (new: `/setup/*` answers 404
   in hosted installs, also before setup is complete).

### 6. The fleet tool `abfleet`

Root CLI on the server, a library under `server/fleet/` (TypeScript like the server, no new dependency), every command
audited to `/var/log/appbuilder-fleet/audit.jsonl` (who: the sudo user; what; which org; result).

| Command | Does |
| --- | --- |
| `create <host> --admin <email> [--plan <p>]` | org id, OS user, folders, database and role (no superuser, CREATEDB or CREATEROLE; CONNECT only to its own database; limits), sealed config, secret key, migrate, administrator invitation, licence registration, unit enabled and started, proxy entry, health check. Idempotent; on failure everything created is removed |
| `suspend <org> [--stop]` / `resume <org>` | read-only (`APPBUILDER_READ_ONLY=1`, restart) or stopped (unit off; Caddy serves a notice page) |
| `export <org>` | an install backup archive (D22 format) plus a checksum, copied off the machine |
| `delete <org> --confirm <host>` | export first (refuses without a verified export), stop, remove unit, proxy entry, database, role, OS user, folders, local backups; writes a removal report (scan of catalogue, users, folders, Caddy and systemd for the id) |
| `update <release> [--canary <org>] [--batch 5]` | verify the release (signature and checksums, D25) once, unpack to `releases/<v>`, then per install: pre-update backup, switch `app`, restart, health and smoke check, roll back that install on failure (the existing updater's steps, with the service control and probe injected per instance) |
| `backup [--all]` | per install, nightly by default: the install's own backup service (D22) to `backups/`, then a verified copy off the machine (rclone or restic to an S3-compatible bucket; documented, configured by the operator) |
| `restore <org> <archive> [--as-copy <host>]` | the install restore CLI (D22) for one install |
| `status` | per install: state, release, health, uptime, memory, CPU, connections, database and folder size, last backup, licence state, users and seats |
| `rotate <org> db-password\|secret-key` | new database password sealed; secret key rotation re-seals every sealed value (new server command `rekey`) |
| `access <org> --reason <text> --hours <n>` | operator access (section 8) |

The operator web console is a later package; it will call the same library.

### 7. Licensing

- **Licence service** (DC-6): its own process (`appbuilder-licence.service`), database `ab_licence`, host `licence.<domain>`.
  Holds organisations, plans, seat counts per pass, "paid until", and installs (install id, licence id, last check, version).
  Code lives in this repository (`server/licence/`), shares the HTTP and crypto code.
- **Check**: each install sends `{ licenceId, installId, version, seats: { full, operator, external } }` at start and every
  6 hours; the answer is signed (Ed25519; the public key ships in the release next to the release keys):
  `{ licenceId, installId, status, seats, paidUntil, issuedAt, validUntil, serverTime, nonce }`. Only seat counts travel, no
  personal data.
- **Grace**: the install works normally while `now < lastValidAnswer.issuedAt + 72 h`; administrators see a banner from the
  first failed check; then **read-only** (writes refused with `licence_read_only`; sign-in, reads, export and the licence
  retry work); a fresh answer restores writing. A clock earlier than the latest time seen by more than 5 minutes counts as
  expired until a fresh answer. Two install ids alternating on one licence are flagged to the operator; after 7 days the
  older one gets `duplicate` (read-only there).
- **Read-only mode** is one router gate shared by licence expiry, `abfleet suspend` and non-payment; background jobs that
  write data pause; notifications about the state continue.
- **On-premises lifetime licences** use the same check and grace; the lifetime is a `paidUntil` of "never" for use, with
  maintenance years for updates (DC-15).
- **Seat passes inside the product** (DC-17): `ab.users.pass` (`full`, `operator`, `external`), assigned by install
  administrators in Admin console > Users; the router refuses Studio, data model and flow designer routes to Operator
  passes (a `pass: 'full'` route flag next to `auth: 'maker'`). Enforcement is soft: over the licensed count, 14 days of
  warnings, then no new assignments; nobody is locked out. Counts are reported in each licence check.
- **Payments** (DC-7): for at most 20 organisations, invoices (GST status with an accountant) and bank transfer; the operator
  records `paidUntil`; 14 days overdue -> read-only with notice, never deletion. The Razorpay connector package (design in
  [../launch/payments.md](../launch/payments.md)) later adds subscription links, webhooks that set `paidUntil`
  automatically, receipts and retries; it needs the company and its bank account first (payments.md 9.2).

### 8. Operator access to an install

- The operator has root on the server and therefore can read everything; this is stated to customers in the terms. The
  product-level rule is about doing it **visibly**: `abfleet access <org> --reason --hours <= 4` creates a time-boxed
  service account in that install with the administrator role, a one-time sign-in link, writes the operator audit and the
  install's own audit (`install.operator_access`), and emails the install's administrators at once. The account is
  disabled and its sessions removed at expiry (a scheduled job and the next `abfleet` run both check).
- Direct database or file access by the operator is for incidents only and is written to the operator audit by hand
  (`abfleet note <org> <text>`); the incident procedure says when.

### 9. Observability

`abfleet status` (above); each install's health endpoint (D25) through its socket; the server's JSON-lines log per install;
health alerts (D30) of each install go to its administrators and, for install-level failures, to the operator's address set
by `abfleet` (`APPBUILDER_OPERATOR_EMAIL`). A daily fleet summary email to the operator: failed backups, installs near limits,
licence problems, restarts.

### 10. Backups

Per install, nightly: the install's own backup (one archive, verified, D22) into `backups/`, copied off the machine and
verified there; retention grandfather-father-son as today; a monthly restore test of one random install into a scratch
database (`abfleet restore --test`). The PostgreSQL cluster itself gets a nightly `pg_dumpall --globals-only` (roles) for
rebuilding. WAL archiving and point-in-time recovery are documented as the next step, not built.

### 11. Installers and the updater

- `scripts/install/linux/install.sh --fleet` prepares a server once: Node, PostgreSQL 17 with the fleet settings
  (`max_connections 300`, `shared_buffers 4GB`, revoked PUBLIC on `postgres` and `template1`, listening on the Unix socket and
  127.0.0.1 only), Caddy with the `fleet.d` import and a catch-all 404 site, the template unit, `abfleet`. It creates no
  install.
- The updater (`server/core/update/apply.ts`) gains a "releases folder" mode: stage once into `releases/<v>`, switch the
  install's `app` link, restart, probe, roll back the link. `ServiceControl` and `probe` are already injected, so one updater
  serves both layouts.
- On-premises single installs (Windows and Linux) are unchanged.

## Threat model for the fleet

What a compromised install (a customer's administrator, or an attacker with their account, or a product bug inside one
install) could reach, and the safeguard. Items marked **confirmed** were checked in the code or by a test in this spike.

| # | Path | Today | Safeguard in this phase |
| --- | --- | --- | --- |
| 1 | Reading another install's files (workspace, secret key, backups, logs) | each install would run as the same `appbuilder` user if installed twice | one OS user per install (DC-1), folders 0750, `ProtectSystem=strict` with only its own folder writable, `ProtectHome`; the release folder root-owned and read-only |
| 2 | Connecting to another install's database | **confirmed**: PostgreSQL's default PUBLIC CONNECT lets any role connect to any database; after REVOKE it is refused | REVOKE on every install database and on `postgres` / `template1`; per-role and per-database connection limits; opaque names (catalogues are readable by all roles) |
| 3 | Reaching another install's HTTP server or the host's services from a connector, a database connection, SMTP or a flow | **confirmed** (`net-policy.ts` lines 9-11, `actions/outbound.ts` line 113): loopback and private networks are ALLOWED by default; `APPBUILDER_OUTBOUND_PRIVATE=deny` refuses them, also over a connection's own "allow private network" opt-in | every hosted install runs with `deny`; installs listen on Unix sockets, which no outbound path of the product opens; PostgreSQL listens only on its socket and 127.0.0.1 (refused by `deny`); the server's own public address is added to a new `APPBUILDER_OUTBOUND_DENY` list (a connector to it would otherwise hairpin through Caddy, which is only the public route anyway); DNS rebinding for database connections stays a documented residual (D24) |
| 4 | Host header tricks through the proxy | Caddy routes by site; the install checks Host and Origin against its own allow-list (`router.ts` `originProblem`) | exact sites only, catch-all 404, `X-Forwarded-Host` dropped, the install's allow-list has its one host |
| 5 | Cookies across sub-domains | **confirmed** host-only: the session cookie has no `Domain` (`router.ts` lines 307-311; `identity/util.ts` lines 112-113 for the device and MFA cookies), `SameSite=Strict`, `HttpOnly` | add the `__Host-` prefix in hosted installs, because `a.<domain>` and `b.<domain>` are the same site: a page on A could otherwise set a `Domain=<domain>` cookie that B receives (cookie tossing); B's Origin check already refuses requests made from A's pages |
| 6 | Email links, webhook and WhatsApp callback URLs, scheduled report and snapshot links | **confirmed**: built from the install's configured public URL (`identity/mail.ts` brand, `actions/webhooks.ts` line 160, `notifications-delivery.ts` lines 227-345, `approvals/service.ts` line 947, `reports.ts` line 406, `dashboards/snapshots.ts` lines 228-229); reset links fall back to the request's allowed Host (`identity/routes.ts` lines 81-86) | `APPBUILDER_PUBLIC_URL` set by the tool and locked; tokens are only valid in the database that issued them |
| 7 | Kiosk view tokens, PWA manifests and the service worker | **confirmed**: the manifest uses relative `start_url` and scope `/` (`pwa.ts` lines 213-214, 327, 340); kiosk tokens are looked up in the install's own database (`dashboards/tokens.ts`) | each install is its own origin, so the browser keeps service workers, IndexedDB (offline store) and caches apart; nothing hard-codes a host |
| 8 | Hard-coded hosts or one-origin assumptions | found: the default port 5174 (`config.ts` line 18; `update/cli.ts` lines 243, 276 probe health on it), the setup route's loopback rule, the CLI's single `install.json` | per-instance `PORT`/socket in `instance.env`; the CLI tools read the instance env; `/setup/*` closed in hosted installs |
| 9 | Noisy neighbour: CPU loops, memory growth, disk fill, connection exhaustion | one process shares nothing but the machine; formula budgets are 30 s / 50 MB (D30) | systemd CPU and memory limits, disk project quotas, PostgreSQL connection limits and `statement_timeout` per role; exit check 8 |
| 10 | The shared release folder | | root-owned, read-only to every install; the updater verifies signatures before unpacking (D25) |
| 11 | The shared PostgreSQL cluster | one superuser | installs never get superuser, CREATEDB or CREATEROLE; extensions (pg_trgm) created by the tool per database; a SQL injection in one install reaches only its own database and the readable catalogues |
| 12 | The shared mail relay | per-install SMTP settings today | hosted installs send through the fleet relay with a per-install sender and a daily cap (setting); a customer may configure their own relay instead |
| 13 | Operator access | root can read everything | section 8: time-boxed, audited, announced to the install's administrators |
| 14 | A compromised install's reach | | its own database, its own folder, the internet (outbound to public addresses, as any SaaS customer could), the cluster's catalogue names; NOT other databases, folders, sockets, PostgreSQL superuser, Caddy's admin API, the licence database or the operator audit |
| 15 | The licence service | new public endpoint | separate process, database and user; rate limits per address; answers signed with a key kept only on the licence host (encrypted at rest, like the release key) |

**Hosted testers start before an outside security review (risk accepted by the owner, D46).** With a fleet, that review
mostly concerns each install (as for an on-premises customer) and the fleet tool. Compensating safeguards in this phase:
the cross-instance suite as a release gate (exit check 2); a second, independent review (agent or person) of every change to
`server/fleet/`, the unit template, the Caddy template and the outbound policy; two canary installs owned by us with marker
data that a nightly job searches for in every other install's reachable data and outbound logs; the operator audit with a
weekly report; and a written incident procedure (`docs/admin/incident-procedure.md`: detect, contain by `abfleet suspend
--stop`, notify affected organisations, keep evidence; legal timelines from a lawyer). The tester terms say plainly that no
outside review has happened yet ([../launch/tester-terms-draft.md](../launch/tester-terms-draft.md), for a lawyer).

## Work packages

Model tiers: **strongest** (security-critical or cross-cutting), **mid** (well-specified building), **small** (docs,
scripts). Ownership hints name files a package owns; others change them only through it.

| # | Package | Wave | Depends on | Tier | Owns (hints) | Must prove |
| --- | --- | --- | --- | --- | --- | --- |
| H-A | Server options for many installs: Unix socket listening, `APPBUILDER_DB_POOL`, `APPBUILDER_PUBLIC_URL` (locked), `APPBUILDER_SETUP=closed`, `APPBUILDER_READ_ONLY`, `APPBUILDER_OUTBOUND_DENY`, `__Host-` cookies when secure, CLI `migrate` and `admin invite`, CLI tools reading a per-instance env | 1 | - | mid | `server/main.ts`, `config.ts`, `router.ts` cookie names, `update/cli.ts`, `identity/admin-cli.ts` | P0-P2 exit checks unchanged; each option by test |
| H-B | Cross-instance isolation suite built FIRST (local part: two to three installs as processes, HTTP, cookies, tokens, links, database roles, outbound; server part: OS users, permissions, systemd) | 1 | - (cases fill in as packages land) | strongest | `scripts/exit-check/hosting-isolation.mjs`, `server/fleet/test/**` | exit check 2 |
| H-C | Read-only gate (shared by licence, suspension, payment) and pausing of writing jobs | 1 | - | mid | `router.ts` gate, `kernel.ts` pause | every write route refused, export works |
| H-D | Fleet library and `abfleet create / status / suspend / resume / delete / export`, registry, operator audit, the unit template, Caddy site template, OS user and folder setup, database and role with REVOKEs and limits | 2 | A | strongest | `server/fleet/**`, `scripts/install/linux/fleet/**` | exit checks 1 and 5 |
| H-E | Fleet updates with canary, batches and per-install rollback on the releases folder (reuse `update/apply.ts`) | 2 | D | mid | `server/core/update/**` releases mode, `server/fleet/update.ts` | exit check 3 |
| H-F | Backups off the machine, per-install restore, monthly restore test, globals dump | 2 | D | mid | `server/fleet/backup.ts`, backup docs | exit check 4 |
| H-G | Licence service (process, database, signed answers, organisations, plans, seats, paid-until, duplicate installs) and the install's licence client with 72-hour grace and clock checks | 2 | C | strongest | `server/licence/**`, `server/core/licence.ts` | exit check 6 |
| H-H | Seat passes in the product: `ab.users.pass`, Admin console > Users, route flag for Full user routes, soft enforcement, counts to the licence | 3 | G | mid | `meta-store.ts` users column (one step), `src/portal/Users.tsx` pass picker | Operator pass refused from the Studio by test |
| H-I | Resource limits and noisy-neighbour proof: systemd limits, disk quotas, PostgreSQL role settings, polling interval default (DC-18), fleet mail relay caps | 3 | D | mid | unit template limits, `server/fleet/limits.ts` | exit check 8 |
| H-J | Operator access (`abfleet access`), secrets rotation (`rotate`, server `rekey`), canary installs and marker search | 3 | D | strongest | `server/fleet/access.ts`, `server/core/secrets.ts` rekey | exit check 10; access audited and announced |
| H-K | `install.sh --fleet` server preparation (PostgreSQL settings, Caddy, template unit, `abfleet`) and the CI job that runs the fleet checks on Linux | 3 | D | mid | `scripts/install/linux/install.sh`, `.github/workflows/ci.yml` fleet job | a clean Ubuntu runner provisions 3 installs |
| H-L | Load-test harness for the fleet (20 installs, mixed day, sockets) and the run on the rented server | 4 | D, I | mid | `scripts/load/fleet-load.mjs` | exit check 7 |
| H-M | Tester on-boarding: invitation email text, first-run checklist in the product, tester terms acceptance record, operator guide, incident procedure | 4 | D, G | small | `docs/admin/fleet.md`, `docs/admin/incident-procedure.md` | a tester goes from email to app unaided |
| H-N | Phase close: security re-check of the fleet (`docs/internal/security-review-hosting.md`), docs sweep, `scripts/exit-check/hosting.mjs`, decisions, version 0.8.0 | 5 | all | strongest | | exit checks 1 to 11 |

Wave 1 packages run in parallel and need nothing from the owner. H-B starts in wave 1 and each later package lands with its
cases. Every package ends with tests, typecheck, build, a real run of the changed paths and its docs.

**Size estimate (honest):** 14 packages, 5 of them strongest-tier. Phase 2 had 6; this is about twice Phase 2 by count, but
most packages are operations code outside the kernel and change little of the product (H-A, H-C and H-H touch it; nothing
in Phases 0 to 2 needs re-review beyond those). The longest are H-D (the fleet library) and H-G (the licence service).
Several checks need a Linux server with systemd: they wait for CI or the rented server (the owner rents nothing before the
product is about 70 % complete, master plan section 12; a Linux VM or a CI runner covers everything except the load test).

**What can be cut for a first tester cohort of 2 to 5 organisations, without weakening isolation:** the canary-and-batch
logic of H-E (update one by one), the monthly restore test (keep the nightly verified backup), disk project quotas (watch
sizes instead), the fleet summary email, H-L on the rented server (a reduced run is enough below 5 installs), the External
pass. **Never cut:** H-B, one OS user and one database role per install with the REVOKEs, `APPBUILDER_OUTBOUND_PRIVATE=deny`,
the closed setup route, `__Host-` cookies, verified off-machine backups, the licence grace logic, the audited operator access.

## Risks and open questions for the owner

| # | Risk or question | Recommendation |
| --- | --- | --- |
| 1 | 20 updates per release, 20 migrations, 20 backups: operations load on a solo founder | the fleet tool does them in one command with a canary; the daily summary email reports only exceptions |
| 2 | One server is a single point of failure for every customer | accept for a paid pilot; nightly verified off-machine backups; a documented rebuild of the server from backups, tested once before the first tester |
| 3 | The sizing is an estimate | exit check 7 on the rented server before the first paying organisation |
| 4 | Makers' outbound connectors for testers (abuse, mail reputation) | allowed with `deny` for private networks and a per-install mail cap (DC-9); revisit after the first month |
| 5 | Custom domains per organisation | later; a Caddy site per domain is the same mechanism |
| 6 | Isolation tiers for a larger customer | a dedicated server or on-premises install; the same build |
| 7 | When to move to true multi-tenancy | when the fleet passes about 50 to 100 installs or the operations load says so (appendix A) |
| 8 | What "lifetime" on-premises includes; offline beyond 3 days | DC-15 and DC-16; wording by a lawyer |
| 9 | Outside security review | book it before the first paying organisation; the fleet narrows it to one install plus the fleet tool |
| 10 | Linux-only parts cannot be proven on this Windows PC | a CI job on Ubuntu (H-K) and, before testers, a run on the rented server |

## What Phase 3 must wait for, and what can proceed in parallel

**I agree with the premise: with a fleet, Phase 3 features need no tenancy work.** Each install is one organisation, exactly
as Phases 0 to 2 were built and reviewed. Phase 3 can therefore proceed **in parallel** with this phase, with two
conditions: (1) licence passes are built here (H-H), so Phase 3's own licence-pass item is done by this phase; (2) any new
server setting or background loop added in Phase 3 follows the hosted rules of this spec (configurable intervals, no
hard-coded host or port, works read-only). Chat, Notes, the manufacturing pack, CRM and ERP-lite templates and the Tally
and ERPNext connectors do not wait. Payments (Phase 3) can wait for the company and bank account (payments.md 9.2).

## Appendix A: true multi-tenancy later (designed, not built)

Recorded so the decision is documented and reversible. **Recommendation: stay with the fleet until about 50 to 100
organisations or until the operations load says otherwise; then build true multi-tenancy, starting with the isolation test
harness.**

### A.1 The two approaches compared

| | 20 organisations | Thousands of organisations |
| --- | --- | --- |
| **Fleet (one install per organisation)** | 20 processes x 150 to 230 MB (measured) = 3 to 5 GB; 20 databases with pools of 6 (about 140 connections); no kernel change; isolation by OS and database; 20 updates, migrations and backups per release (one command) | thousands of processes and databases: several servers, a pooler, fleet orchestration across machines; per-install overhead dominates (an idle install: memory and polling) |
| **True multi-tenancy** | one process; one database; about 22 work packages that change the kernel (tenant context, schema split, identity per tenant, tenant-keyed caches, per-tenant keys, fair job queue, isolation suite of every route, re-review of Phases 0 to 2) before a pilot | the only economical shape; needs multi-process, cells (several databases) and the shared-state work below |

Moving later: each install's export archive (D22) is imported as a tenant; host names stay; users get new sessions.

### A.2 Data layout measured for in-product tenancy (same caveats)

Schema per environment, built by the product's own DDL: one environment is 430 relations empty (65 metadata tables, 21
system tables, 19 views, 320 indexes, 5 sequences), about 713 `pg_class` rows with TOAST and 8 maker tables, 6.3 MB of empty
catalogue and data. In one database:

| Environment schemas | 6 | 61 | 501 |
| --- | ---: | ---: | ---: |
| `pg_class` / `pg_attribute` rows | 4,707 / 25,108 | 43,867 / 224,208 | 357,147 / 1,817,014 |
| catalogue / database size | 25 / 45 MB | 154 / 390 MB | 1,105 / 3,161 MB |
| new connection + first query | 24 + 1.7 ms | 26 + 2.3 ms | 27 + 4.9 ms |
| job worker tick over every environment, empty queues | 36 ms | 473 ms | 4,053 ms |
| one-statement migration across all | 6 ms | 47 ms | 301 ms |
| pg_dump of one schema / of everything | 0.23 / 0.4 s | 0.59 / 3.4 s | 2.8 s / fails (lock table) |

Catalogue cache per connection: about 0.09 MB per schema touched (46 MB after 500). A shared table with `tenant_id` (enforced
predicate) was as fast as schema per tenant (page 0.5 ms, count 0.3, aggregate 0.9, point 0.2); row-level security added
about 0.3 ms (three round trips) and fails closed, but neither can hold maker tables, whose columns differ per tenant.
Database per tenant: `CREATE DATABASE` from a template 1.26 s median, 13.8 MB each, a pool each. Two findings also matter for
large single installs today: the job worker's tick is O(environments) even when idle, and one snapshot of every
environment (today's install backup, `backup/engine.ts` line 242) hits PostgreSQL's lock table at roughly 110 environments
with default settings.

Layout recommended then: tenant schemas above environment schemas in one database (isolation by construction; about 300
environment schemas per database), cells of several databases beyond, a shared fair job queue (`ab.jobs` with tenant ids)
and wake-up rows instead of the per-environment tick.

### A.3 Multi-process: in-process state today

Class P: per-process is fine; S: must be shared; I: per-process cache that must be invalidated across processes.

| State | Where | Class |
| --- | --- | --- |
| Live sockets, subscriptions | `live/hub.ts` 186-188 | P |
| Table-change fan-out (listeners run only in the process that dispatched the outbox row) | `outbox.ts` 189-197, `live/changes.ts` 32 | S |
| App and environment change messages | `router.ts` 345, `live/wiring.ts` | S |
| Presence, Studio locks, sequences | `live/hub.ts` 189-195, 437 | S |
| Session revocation feed | `live/session-events.ts` 16 | S |
| Security caches (roles and tables per environment, organisation, shares; 5 s) | `security.ts` 264, 300, 322 | I |
| Environment registry (2 s), connector instances, table events, flow rules and documents, dashboard results (20 s) | `environments.ts` 48, `connections.ts` 30, `table-events.ts` 279, `flows/index.ts` 134, `flows/engine.ts` 264, 310, `dashboards/batch.ts` 42 | I |
| Login throttle and email backoff (evict half at 10,000 keys) | `auth.ts` 72-140 | S |
| Identity counters, API key and kiosk token buckets, webhook / WhatsApp / notification limiters, connector breaker and rate | `identity/index.ts` 78, `identity/api-keys.ts` 93, `dashboards/tokens.ts` 77, `actions/webhooks.ts` 130, `whatsapp/webhook.ts` 58, `notifications.ts` 79, `actions/service.ts` 167 | S |
| Export and backup download tickets, pending backup passphrases | `export-data.ts` 221, `backup/service.ts` 205-207 | S |
| Attachment row lock | `attachments.ts` 55 | S |
| Files connector store and its write timer | `connectors/files/index.ts` 94-95, 205, 298 | S (single writer only) |
| DNS pins, OAuth token cache, last-writer memory, CSP cache | `actions/outbound.ts` 150, `identity/oauth-token.ts` 79, `live/changes.ts` 65, `static.ts` 48 | P |
| Job worker, outbox dispatch, approval / flow / snapshot sweeps, timers | `jobs.ts` 246-249, `outbox.ts` 132, `approvals/service.ts` 844, `flows/engine.ts` 1617, `dashboards/snapshots.ts` 397, `services.ts` 472, 512 | P (row locks and SKIP LOCKED already make them safe) |

### A.4 Shared mechanisms measured

LISTEN/NOTIFY (listeners in one Node process): 1 / 4 / 8 listeners at 200 notifications/s p95 1.0 / 1.2 / 1.7 ms, at 2,000/s
p95 5.5 / 8.4 / 29.4 ms, all delivered; payload limit 7,999 bytes; notifications sent while a listener is disconnected are
lost (0 of 100), so a reconnecting process catches up from the outbox id (the live client already resyncs by sequence);
commits that notify serialise (16 writers: 12,524 commits/s with NOTIFY, 18,364 without). Job fairness (one shared queue, 8
workers, a tenant with 10,000 jobs ahead of 20 tenants with 10 each): FIFO made the small tenants wait 9.9 s at p95; a fair
claim (oldest head job per tenant per round, at most 2 running per tenant) 0.29 s, at 1.0 ms per claim; it must also be
work-conserving (fill idle slots), which the prototype was not. With fan-out by NOTIFY and shared or invalidated state, a
reverse proxy needs no stickiness for WebSockets.

## Status at version 0.8.0 (21 Nov 2026)

Built and tested as far as a Windows developer PC and GitHub's Linux runners allow: H-A, H-B, H-C, H-D, H-E, H-F, H-G, H-H, H-I (limits written, not tested under pressure), H-J (the secret key cannot be rotated: the server has no rekey command), H-K (installer syntax-checked only), H-L (harness and local runs). Not done: H-M (tester on-boarding and incident procedure) and H-N (phase close), which need the rented server.

| Exit check | State |
| --- | --- |
| 1 Twenty installs created by the tool on HTTPS | Three created locally with no manual step (`h-fleet.mjs`); HTTPS by host name is the CI job `fleet`; twenty on a real server: not done |
| 2 Cross-instance isolation | PASS locally (112 of 113; the socket check needs Linux) and in the CI job `isolation`; OS users and file permissions need the server |
| 3 Fleet update with a canary and a forced failure | PASS locally |
| 4 Per-organisation backup and restore | PASS locally |
| 5 Suspend, resume, export, delete | PASS locally |
| 6 Licence grace on a driven clock | PASS (`h-licence.mjs` 19 checks) |
| 7 Load test at 20 x 50 | Reduced local run: latency, error and live-delivery limits met; the per-install event-loop limit failed in short phases; must be rerun on the server ([results](../internal/load-test-2026-11.md)) |
| 8 One misbehaving install does not take the others down | Not done (needs systemd limits on the server) |
| 9 On-premises path and Phase 0 to 2 checks unchanged | PASS (`p2.mjs` with P0 and P1) |
| 10 Secret rotation | Database password and licence key: PASS locally; secret key: not possible yet |
| 11 Docs and a security re-check | `docs/internal/security-review-p3.md`; runbook `docs/admin/fleet-operations.md` |

Measured locally (not capacity figures): 165 to 260 MB per install under load, 140 database connections for 20 installs, the idle fleet about 5 % of one core. The estimate of 8 vCPU / 32 GB for 20 organisations is supported by the local run and must be confirmed on the server.
