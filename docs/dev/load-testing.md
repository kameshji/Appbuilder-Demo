# Load testing the hosted fleet (H-L)

The load test for exit check 7 of [the hosting phase](../plan/hosting-spec.md): many real installs of this tree on one
machine, each with its own PostgreSQL database and role, the Manufacturing pack, people, months of history, and virtual
people working through the product's own HTTP API and live sockets. Results of the runs on the developer PC:
[docs/internal/load-test-2026-11.md](../internal/load-test-2026-11.md).

```
node scripts/bench/load/run.mjs                      smoke: 3 organisations x 10 people, 155-175 s here, CI-safe
node scripts/bench/load/run.mjs --profile pilot      the target: 20 x 50, 160 concurrent, 200 sockets, 50 req/s 30 min, 100 req/s 5 min
node scripts/bench/load/run.mjs --profile ramp       steps of load until a service level breaks
```

No new dependencies: Node's `http`, `pg` and `ws` (both already dependencies of the server). Nothing to install.

Before / after runs on the same tree: `--install-env APPBUILDER_PRINT_WORKERS=0,APPBUILDER_TABLE_CACHE=off,APPBUILDER_IMPORT_YIELD=off`
gives every install the old behaviour (prints on the request loop, no table list cache, imports without slices);
`--heavy-import 2000` makes the heavy tenant's import large enough to see.

## What it starts, and what it never touches

| Part | Where | Notes |
| --- | --- | --- |
| A private PostgreSQL cluster | `127.0.0.1:5401` (5400-5409 allowed, `--pg-port`), data under `.sandbox/load/run-*` | `initdb` + `pg_ctl` from `.sandbox/pg/pgsql/bin` (`APPBUILDER_LOAD_PG_BIN`); stopped and deleted at the end |
| N installs (`node server/main.ts`) | `127.0.0.1:5411...` (5410-5499, `--base-port`) | hosted settings, one database + role each (below) |
| The load generator, the samplers | this process; one PowerShell loop on Windows for process figures | |

Ports 5174 and 5433 (the owner's install and PostgreSQL 17) and the shared sandbox PostgreSQL on 5435 are refused by
construction. Every process the harness starts is registered and killed on exit, on failure and on Ctrl-C (SIGINT,
SIGTERM); every `ab_load_*` database and role is dropped, the cluster is stopped and its folder removed (`--keep` keeps
the folder and logs for a look). A cluster left by a killed run is stopped at the next start (only clusters under
`.sandbox/load`). Reports are kept in `.sandbox/load/reports/<profile>-<time>.md` and `.json`.

### The installs

Each install is provisioned as the fleet tool will provision it (spec section 5): `createInstallDatabase` of the isolation
suite (`scripts/fleet/testing/fleet.mjs`: no superuser, CONNECT only to its own database, PUBLIC revoked, `CONNECTION
LIMIT 12`, `statement_timeout 60s`), `seed-config` (sealed password), `migrate`, `admin invite --print-link`, then the
server with `APPBUILDER_HOSTED=1` (pool 6, job polling 5 s, trusted proxy, `__Host-` cookies, outbound private deny,
setup closed), a locked `https://orgNN.load.test.invalid` public URL, its own instance folder and secret key, and the
unit's heap limit (`--max-old-space-size=1024`). Windows has no Unix sockets for the server, so installs listen on TCP
(the spec's fallback, DC-3). There is no proxy process: the harness sends what Caddy would send (`Host`,
`X-Forwarded-Proto: https`, `X-Forwarded-For` with a different client address per person, so sign-in throttles and rate
limits see people, not the harness).

### The cluster's settings (a small fleet server)

`max_connections 300`, `shared_buffers 1GB` (the spec's 4 GB for a 32 GB server, scaled for a shared PC),
`effective_cache_size 8GB`, `work_mem 8MB`, `maintenance_work_mem 256MB`, `wal_buffers 16MB`, `max_wal_size 4GB`,
`checkpoint_timeout 15min`, `random_page_cost 1.1`, **`fsync on`, `synchronous_commit on`** (unlike the shared sandbox,
which runs fsync off; `--fsync off` to compare), `log_min_duration_statement 250`, `log_lock_waits on`,
`deadlock_timeout 1s`, `log_checkpoints on`, `log_temp_files 0`, `pg_stat_statements` when the binaries have it.

## Day zero of each organisation (lib/seed.mjs)

Through the API, as the administrator and the people would: the Manufacturing pack (plan, install, SAMPLE rows: the
business model first), people with the pack's roles (`composition()`: for 50 people 1 administrator, 1 plant manager,
3 supervisors, 3 quality, 2 maintenance, 40 operators; the administrator, the plant manager and the first supervisor are
makers), a team per supervisor, the inspectors' manager, 8 machines, then the history **imported by the people who own
it** (`POST /data/:table/import` as each operator, inspector and technician): production rows per machine and shift for
`--seed-days` days (Sundays off), stoppages, inspections (4 a day, 4 % failed), open NCRs, closed and open maintenance
requests, tasks, the chat channels and their history, a scheduled report (daily, PDF), and finally the pack's flows
switched on. The one write outside the API: `must_change_password = false` for the people the administrator created (as
the exit checks do). `--crm` also installs the CRM pack.

## The day (lib/scenarios.mjs, profiles.mjs)

An open arrival process (Poisson, seeded: the same seed gives the same sequence) at the phase's target request rate,
over a fixed set of **concurrent people** per organisation (`--active`; one plant manager, one supervisor, one technician,
two inspectors when there are two (an NCR's approver is never its inspector nor its sender), the rest operators), each doing one action at a time. The action rate is the request rate divided by the
mix's mean requests per action (1.54).

| Action | Per 100 | Who | Requests |
| --- | ---: | --- | --- |
| `open_app`: the first screens of the person's app (Query v2, filters on dates and codes, sorts, exact counts, pages of 20 to 50) | 20 | everyone | 2 |
| `phone_log`: Shop floor entry from a phone: client row id and `Idempotency-Key` as the offline outbox sends; 15 % resent with the same key (a lost answer), 10 % with a photo (220 x 220 noise PNG, 145 KB) | 18 | operators | 1.25 |
| `record_view`: a record and its related list | 12 | everyone | 2 |
| `chat`: a message to the plant channel, delivered live to every member's sockets | 10 | everyone | 1 |
| `next_page`: the next keyset page or a search | 8 | not operators | 1 |
| `dashboard`: every tile of the role's dashboard in one batch (`POST /dashboards/query`, compiled with the viewer's own `buildBatch`) | 7 | supervisors, plant manager, quality, administrator | 1 |
| `inbox`: the bell and My tasks | 6 | everyone | 2 |
| `inspection`: Inspection phone app: result, a photo, defects when it fails (the NCR flow) | 5 | quality | 2.1 |
| `downtime`: a stoppage; a quarter are breakdowns (the maintenance request and routing flows) | 4 | operators | 1 |
| `task`: a task for a colleague with a reminder in 1-2 minutes (the reminders job fires during the run) | 3 | not operators | 1 |
| `print`: the inspection report of a record, then the PDF downloaded | 2 | quality, supervisors, plant manager | 2 |
| `sign_in`: a new device: sign-in without a cookie, the session and `/workspace` | 2 | everyone | 2 |
| `ncr_send`: an open NCR gets its disposition and goes for approval (the approval flow) | 1.5 | quality | 2 |
| `ncr_approve`: the first pending approval answered | 1.5 | quality, plant manager | 1.5 |

**Why these numbers.** The spec's target (DC-11) is 150 concurrent people and 50 requests/s across the fleet: one
request every 3 s per concurrent person, or one action every 5 s. That is busier than a person really is (a phone entry
every few minutes, a screen opened now and then): the target is a conservative ceiling, and the mix keeps the shape of a
plant day: phones writing all shift, people reading lists, records and dashboards, chat as the plant's radio, few prints.
The think time is therefore derived, not chosen: concurrent people / action rate (8 per organisation at 50 req/s on 20
installs: 4.9 s on average, exponential gaps).

**Background and special phases.** During `steady`, every organisation runs its scheduled report and the pack's daily
OEE PDF flow by hand in turn (`background` seconds apart, staggered). `burst` (shift change): every operator of every
organisation (40 x 20 in the pilot) logs the shift within the window, on top of the base rate. `noisy`: organisation 1
runs a bulk import (`--heavy-import` rows of production), a merged PDF of `--heavy-pdf` inspection reports (the 500-page
document) and a CSV export of its whole production log while the others work at the base rate; the phase lasts as long
as the heavy work. `peak`: twice the rate. `idle`: no users and the sockets closed (exit check 7's idle fleet CPU).

| Profile | Orgs x people | Concurrent | Sockets | Phases |
| --- | --- | ---: | ---: | --- |
| `smoke` | 3 x 10 | 18 | 21 | warmup 8 s, steady 35 s at 7.5/s, noisy 15 s+ (400-row import, 30-page PDF), burst 12 s, peak 12 s at 15/s, drain, idle 12 s |
| `pilot` | 20 x 50 | 160 | 200 | warmup 60 s at 25/s, steady 30 min at 50/s, noisy 3 min+ (10,000 rows: about 5 minutes at 33 ms a row; 500 pages), burst 60 s, peak 5 min at 100/s, drain, idle 60 s |
| `ramp` | 20 x 50 | 500 | 200 | warmup, then 90 s steps at 50, 100, 150, 200, 300, 400, 600, 800 req/s until read p95, write p95, p99, errors or live push p95 breaks (the event-loop probe is reported but does not stop the ramp: one print moves an install's p99 over 100 ms at any load) |

`--repeat N` measures the phases N times on the same fleet (variance between runs without provisioning again).

## What it measures (lib/sampler.mjs, lib/track.mjs)

| Figure | How |
| --- | --- |
| Latency per scenario and step | from the first byte written to the last byte read, per phase; classes `read`, `write`, `job` (prints, background runs), `auth`, `heavy` (the heavy tenant: not in the service levels) |
| Error rate | 5xx, network errors, and any status a scenario does not expect (409 is expected where two people race for one NCR or approval; 429 for a chat sender over 30 a minute) |
| Live push latency | phone write sent -> the row id on every subscriber socket that gets row ids (`table:` topic); chat send -> every member's socket (`chat:` topic); lost = an expected push that never came (and no "table changed" tick covered it), duplicates = the same seq twice on one socket |
| Task reminders | reminders due during the run stamped `ReminderSentOn`, and task notifications pushed to open sockets |
| Event-loop lag per install | from outside: the harness probes an unknown `/api/v1` route (answered 404 without the database) every second, an upper bound of the loop delay at 1 s resolution. From inside: every install's own measure in `GET /admin/health` (`process.eventLoop`, p50 / p99 / max over the last minute and since start, `server/core/diagnostics/event-loop.ts`), sampled every 30 s and reported per install ("Server event-loop delay") with the print pool and table cache counters |
| CPU and memory per install, PostgreSQL, the harness, the machine | every 5 s: Windows `Win32_Process` (one long-lived PowerShell loop), Linux `/proc`; PostgreSQL = the postmaster and its children (a lower bound: a backend that ends between samples loses its last interval) |
| PostgreSQL | connections by database and state, backends waiting on locks, ungranted locks (5 s); per install the job queue (due, running, dead, age of the oldest due job) and the outbox backlog (15 s); slow statements, lock waits over 1 s, deadlocks, temporary files and checkpoints from the log; the top statements from `pg_stat_statements`; commits, rollbacks and the cache hit ratio from `pg_stat_database` |
| Sockets the server counts, RSS it reports | `GET /admin/health` of every install every 30 s |
| Disk growth | database sizes, the cluster folder (WAL included), the install folders (attachments, logs) before and after |
| Integrity | phone rows answered 200 that are missing, the same entry stored twice, replays answered with another row, failed inspections -> NCRs, breakdowns -> maintenance requests, flow runs by state, failed flows, dead jobs, installs that exited |

## Reading the report

1. **Caveat and machine.** Every report starts with the caveat; on a shared PC the machine's CPU column in the phase table
   says whether other work saturated it (above about 70 % the latencies include waiting behind other programs).
2. **Exit check 7** per phase (steady, peak, the heavy-tenant window, the shift change) against the spec's numbers; the
   memory row is computed against the server the fleet would run on (`--server-ram-gb`, default 32: DC-12), not this
   PC. The smoke profile has looser thresholds of its own (read p95 600 ms, write p95 1 s, p99 2.5 s, errors 1 %, live
   1 s, probe 250 ms) because 3 installs and 300 requests make a small, noisy sample; it passes only with no lost or
   duplicated push and no duplicated row.
3. **Scenarios**, **live delivery**, **per install** (CPU, RSS, probe, connections, job queue), **totals over time**,
   **PostgreSQL**, **noisy neighbour** (the other installs' p95 in the heavy window against steady: the spec's
   max(25 %, 100 ms) of exit check 8), **integrity**, grouped **errors**, **disk**, and for the ramp the steps with the
   knee and the first bottleneck the harness names (machine CPU, one install's event loop, the pool of 6, PostgreSQL
   CPU, lock waits, or the generator itself).
4. The exit code: 0 when the profile's thresholds pass, 1 when they fail, 2 when the run could not complete.

## Being a good neighbour on a shared PC

Provisioning runs 3 installs at a time (`--parallel`); at most 256 actions are in flight (`maxInflight`); a person does
one action at a time. The generator is one Node process (its CPU and event-loop delay are in the report). Free memory
is checked before anything starts (about 0.35 GB per install + 2 GB).

## On the rented server

Run the pilot as is on the server with the fleet's real PostgreSQL settings (`shared_buffers 4GB`) from a second machine
if possible (the generator then no longer shares the CPU), or here with `--server-ram-gb` set to the server's RAM. Add
`--steady-s 1800 --peak-s 300` (the defaults of `pilot`). What this harness cannot show on Windows: Unix sockets, Caddy,
TLS, systemd limits (exit check 8), Linux's scheduler and fsync costs.

## Results so far

[docs/internal/load-test-2026-11.md](../internal/load-test-2026-11.md): smoke 4 of 4 passed; the pilot (shortened: 2 x 10
min steady, 2 x 3 min peak, 90 days of history) passed every latency, error, live and resource criterion of exit check 7
on the shared PC, failed only the per-install event-loop probe p99 in short phases; the ramp's knee was 300-400 req/s
with the PC's CPU saturated.
