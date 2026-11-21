# Load test results, November 2026 (H-L, first runs)

Harness and method: [docs/dev/load-testing.md](../dev/load-testing.md) (`node scripts/bench/load/run.mjs`). Spec:
[docs/plan/hosting-spec.md](../plan/hosting-spec.md) exit check 7.

**Caveat for every number in this file:** developer PC (Intel i7-12700K, 16 logical CPUs, 93 GB RAM, Crucial P3 1 TB
NVMe with 9 % free, Windows 11 Pro 26200, Node 26.4), **shared with two other heavy agents** (the machine's CPU was
47-84 % busy on average per measured phase, p95 88 %, most of it other work), all installs, PostgreSQL 16.11 and the load
generator on the same machine, **private PostgreSQL cluster with fsync ON** (not the shared sandbox, which runs fsync
off), no Caddy, no TLS, no systemd limits, TCP instead of Unix sockets. **These are comparisons, not capacity figures
for a server.** Exit check 7 must be run on the rented server.

## What was run

| Run | Profile and options | Result |
| --- | --- | --- |
| smoke x 4 | `smoke` (3 orgs x 10 people, 18 concurrent, 21 sockets; 35 s steady at 7.5 req/s, 12 s peak at 15 req/s) | 4 of 4 passed the smoke thresholds (the first two counted runs 175 s and 165 s, the run on the final code 156 s); an earlier debugging run is not counted |
| pilot, 2 repetitions on one fleet | `pilot --seed-days 90 --steady-s 600 --peak-s 180 --heavy-import 5000 --repeat 2` (20 orgs x 50 people = 1,000 named, 160 concurrent, 200 sockets) | completed: 52 min, 125,000 requests |
| ramp x 2 | `ramp --seed-days 30 --ramp 100,200,300,400,600,800 --ramp-step-s 90` (20 orgs x 50, 500 concurrent) | run 1 stopped at 100 req/s on the probe criterion alone (the ramp then stopped on any criterion; now only on latency, errors and live); run 2: knee between 300 and 400 req/s |

**Shortened against the spec:** steady 10 min instead of 30 (twice), peak 3 min instead of 5 (twice), 90 days of
history instead of 180, heavy import 5,000 rows instead of 10,000-20,000 (the import runs at about 33 ms a row, below);
the heavy tenant's 500-page PDF reached 402 pages in repetition 1 (402 inspections existed) and 500 in repetition 2.

## Pilot: exit check 7 as measured here

| Criterion (limit) | steady #1 | steady #2 | peak #1 (100/s) | peak #2 | heavy tenant #1 | #2 | shift change #1 | #2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| achieved req/s (target) | 50.0 (50) | 50.0 | 101.5 (100) | 101.1 | 45.4 (50) | 49.6 | 66.2 (50 + burst) | 66.3 |
| read p95 (300 ms) | 23 | 25 | 30 | 27 | 69 | 30 | 29 | 25 |
| write p95 (500 ms) | 47 | 44 | 63 | 49 | 109 | 62 | 51 | 42 |
| p99 all (1 s) | 140 | 133 | 182 | 148 | 410 | 183 | 139 | 135 |
| errors (< 0.1 %) | 0 of 30,011 | 0 of 30,001 | 0 | 0 | 0 | 0 | 0 | 0 |
| live push p95 (500 ms) | 50 | 46 | 57 | 47 | 117 | 64 | 57 | 48 |
| event-loop probe p99, worst install (100 ms) | 13 | 10 | **136** | 77 | **146** | 44 | **186** | **114** |
| memory, installs + PostgreSQL private (24 GB of a 32 GB server) | 6.3 GB | 6.4 | 6.4 | 6.4 | 6.4 | 6.4 | 6.3 | 6.3 |
| PostgreSQL connections (250) | 140 | 140 | 140 | 140 | 140 | 140 | 140 | 140 |
| idle fleet CPU, 20 installs (10 % of one core) | 4.8 % | | | | | | | |
| machine CPU busy (all work on the PC) | 61 % | 53 % | 84 % | 68 % | 84 % | 73 % | 72 % | 57 % |

**Verdict:** every latency, error, live and resource criterion passes in every phase, with 10x margin in steady state.
The only failures are the **event-loop probe p99 of the worst install** in five short phases (60-195 s, so p99 is the
second-worst of 60-180 one-second probes). The per-install probe p99 over the whole run was 4-7 ms on every install;
the failing values are single spikes of 100-360 ms. **Meaningful on this machine?** The latency and error pass is
meaningful as a lower bound on the product's efficiency (20 installs carried the target while the machine was mostly
busy with other work). The probe failures are partly the machine (request maxima of every scenario cluster at
1.0-1.8 s at the same moments; 18 `COMMIT`s took 600-700 ms) and partly the product: in the ramp run, which records
the spikes, 12 of 12 spike seconds at 100 req/s hit one install alone, which is what a PDF print on the request's event
loop does (160-270 ms of CPU each, 1.5 prints a second across the fleet). On the server I expect the probe criterion to
fail at the spec's 100 ms p99 per install as long as prints run on the event loop; the rest should pass with margin.

## Pilot: what the numbers say

| Figure | Measured (shared PC, fsync on) |
| --- | --- |
| Requests | 125,000 in the measured phases, **0 errors**, 0 harness errors, no install restarted |
| Live | 200 sockets; **0 of 95,982 table pushes lost, 0 duplicated**; **0 of 80,200 chat pushes lost, 0 duplicated**; table tick p50/p95/p99 30/61/114 ms, chat 18/39/89 ms |
| Phone writes | 15,997 rows created, 2,348 replays with the same Idempotency-Key: all answered with the first row, **0 duplicates** |
| Flows per row change | 400 failed inspections -> 400 NCRs; 805 breakdowns -> 805 maintenance requests (routed); 1,410 flow runs succeeded; 40 failed (the daily OEE email step: no SMTP, expected) |
| Task reminders | 2,268 of 2,268 due during the run sent (stamped), pushes reached open sockets |
| CPU, steady 50 req/s | the 20 installs together **85 % of one core** (median install 4.8 %), PostgreSQL **about 57 %** (lower bound); generator 4 % |
| CPU, peak 100 req/s | installs **about 177 % of one core** together, PostgreSQL **about 120 %** |
| CPU, idle fleet | 20 installs 4.8 % of one core together (0.24 % each; the spike measured 0.2 %) |
| Busiest install | the heavy tenant: 103 % of one core at peak (the bulk import), RSS 365 MB; the others 14-21 % at peak |
| Memory | installs 165-260 MB each (235 MB mean, 4.7 GB for 20), heavy tenant 365 MB; PostgreSQL private 1.9 GB + shared_buffers 1 GB |
| PostgreSQL connections | 140 = 20 x 7 (pool 6 + LISTEN), all the time; no install ever had all 6 pooled connections active in a 5 s sample; 7 backends waiting on locks at most (2 samples), 0 lock waits over 1 s, 0 deadlocks, 0 temp files, cache hit 100 % |
| Job queue | at most 1 due job per install, oldest 0 s; outbox backlog at most 2 rows |
| Disk in 52 min | databases 589 -> 852 MB; cluster folder (with WAL) 1.09 -> 1.63 GB; install folders 9 MB -> 946 MB (photos: 5,400 uploads of 145 KB, stored as files) |
| Heavy tenant | bulk import of 5,000 rows **159-195 s** (32-39 ms per row); merged PDF of 402 / 500 pages 12.4 / 14.6 s; CSV export of the whole log 0.1-0.2 s |
| Noisy neighbour | the other 19 installs' read p95 23 -> 69 ms (#1, machine 84 % busy) and 25 -> 30 ms (#2); write p95 47 -> 107 / 44 -> 62 ms: within the spec's max(25 %, 100 ms) both times |

## Ramp (run 2)

| Target req/s | Achieved | read p95 | write p95 | p99 | errors | probe p99 worst | busiest install CPU | PostgreSQL CPU (lower bound) | machine CPU | pool full (samples) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 100.8 | 26 | 53 | 154 | 0 | 259 | 25 % | 107 % | 62 % | 0 % |
| 200 | 203.1 | 31 | 70 | 188 | 0 | 154 | 31 % | 214 % | 82 % | 0 % |
| 300 | 302.6 | 121 | 261 | 496 | 0 | 248 | 39 % | 323 % | 95 % | 0.8 % |
| 400 | 399.8 | **684** | **1,179** | **1,884** | 0.02 % | 376 | 42 % | 333 % | 98 % | 14.7 % |

**Knee: between 300 and 400 req/s for 20 installs (15-20 req/s per install), 3-4x the spec's peak.** First bottleneck:
**the machine's CPU** (98 % busy, other work included); no install's event loop was near a full core (42 % at most).
What broke first inside the product at 400 req/s:

- **live table pushes fell behind by up to 48 s** (table tick p95 29 s over the whole ramp, 0 lost) while chat stayed
  sub-second (p95 0.6 s): table ticks wait for the outbox dispatch of the job worker, and the per-install outbox reached
  206 undispatched rows, the job queue 54 due jobs with the oldest 56 s late. Chat pushes go straight from the request.
- **lock waits on `sys_number_sequences`** (40 waits over 1 s in the log): every numbered row (inspections, NCRs,
  maintenance requests) takes the sequence row lock until its transaction commits, so numbered inserts serialise per
  sequence.
- **6 approval answers (`POST /approvals/:id/respond`) got no answer within the harness's 120 s timeout**, one in each of
  6 installs, plus 1 inspection create and 1 print (0.02 % of requests).

## Bottlenecks observed, in order

1. **The shared machine** (not the product): every latency tail and probe failure coincides with machine-wide stalls
   (CPU 72-84 % busy on average, mostly with other work, slow `COMMIT`s with fsync on a 91 %-full disk).
2. **The single event loop of a busy install**: the heavy tenant's bulk import kept its process at about one full core
   for 3 minutes; PDF generation (159 ms median, 269 ms p95 per one-page record) runs on the request's event loop (no
   worker thread in `server/**`), so a print delays every other request of that install by its own CPU time.
3. **Per-request metadata reads**: the top statement by total time is the full table registry,
   `SELECT ... FROM ab_tables ORDER BY lower(name)`: 277,538 calls (2.2 per request), 256 s of PostgreSQL time in 45
   minutes, plus parsing every table definition in Node each time (`meta.tables.list()` is not cached; 43 call sites).
   At 100 req/s that is the largest single consumer of database time.
4. **Past 300 req/s: the outbox dispatch** (live table ticks and every flow wait for it; ramp above) and the
   number-sequence row lock.
5. Not a bottleneck at this size: the pool of 6 (never saturated), PostgreSQL connections (140 of 300), memory (6-8 GB),
   locks, the job queue, live fan-out.

## Product bugs found under concurrency

At the target load (pilot): none. No deadlock, no 5xx, no lost or duplicated live message, no duplicated send or row,
no leaked connection (140 flat for 50 minutes, back to 92 when idle), no memory growth (installs' RSS flat across both
repetitions; the last sample below the maximum on every install). At 4x the target (ramp, machine saturated) one
**candidate** bug and one degradation; then findings that are not bugs but should be known:

- **Approval answers hung for over 120 s at 400 req/s** (ramp run 2, 6 of about 300 answers, 6 installs, no error
  answer, no deadlock in the log). Possibly the request waits on the NCR row or a sequence lock held by the
  approval flow's write-back under overload; not reproduced in isolation. Reproduce:
  `node scripts/bench/load/run.mjs --profile ramp --seed-days 30 --ramp 300,400 --ramp-step-s 90`, then look for
  `0 ncr_approve/respond: network: TIMEOUT` in the report's errors. Worth a look by whoever owns `approvals/service.ts`;
  it may be only queueing.
- **Live table ticks lag by tens of seconds when the job worker falls behind** (ramp 400 req/s: up to 48 s, none lost):
  by design they go through the outbox, but at overload the "live" view of a table is no longer live. Reproduce as
  above; the report's live line shows the latency.
- **Bulk import is about 33 ms per row** (`POST /data/:table/import`, `server/core/data.ts` `importCsv`: `buildRow` runs
  the pack's before-event rules row by row, awaited one at a time, before the single insert). 10,000 rows take about 5
  minutes and keep the install's event loop near 100 % meanwhile. Reproduce: smoke profile, `--heavy-import 2000`
  (66 s on the PC).
- **The "Quality and maintenance" dashboard of the Manufacturing pack shows tiles the Quality role cannot read**
  (`MaintenanceRequests`, `PMTasks`: 404 "Table does not exist" per tile for every Quality viewer). Reproduce: any
  profile; the report's dashboard line lists the failed tiles.
- **`report.run` jobs end `dead` ("Email is not set up on this server.") and the daily OEE flow fails** on hosted
  installs without SMTP; with `APPBUILDER_OUTBOUND_PRIVATE=deny` a loopback relay is refused, so the fleet relay
  (spec threat model row 12) is needed before scheduled reports work hosted.
- Harness note (not product): in the pilot run no NCR approval was answered (750 sent, 0 answered) because only one
  inspector was among the concurrent people and the policy rightly never asks the inspector who raised or sent an NCR;
  the active set now holds two inspectors (smoke and ramp: answered).
- Harness note (not product): signing in with a session cookie replaces that session and closes its live sockets
  (4401); the harness's "new device" sign-in sends no cookie.
- Tooling note (not product): `scripts/fleet/testing/fleet.mjs` starts its private cluster with `spawnSync(pg_ctl start)`
  and piped output; on Windows the postmaster inherits the pipe and the call waits for its 90 s timeout (the load harness
  uses `stdio: 'ignore'`: start in 3 s instead of 125 s).

## Tuning recommendations

| Recommendation | Basis |
| --- | --- |
| Keep pool 6 per install; `CONNECTION LIMIT 12`; `max_connections 300` | measured: never more than 6 active of 6, 7 connections per install, 140 for 20 |
| Keep job polling at 5 s (DC-18) | measured: idle 0.24 % of a core per install; queues empty at 100 req/s (LISTEN/NOTIFY does the work); the backlog seen at 400 req/s is CPU, not polling |
| Alert on outbox backlog and job age per install (`abfleet status`): over 100 undispatched rows or a due job older than 30 s means live views and flows are late | measured at the knee |
| Cache the table registry per environment (invalidate on metadata change) | measured: the largest database consumer (2.2 full reads per request) |
| Run PDF generation and CSV import row checks off the request loop (worker thread or a job), or cap them per install | measured: 1 core for minutes on one install; prints 160-270 ms of loop time each |
| Expose the event-loop delay in `/api/v1/admin/health` (`perf_hooks.monitorEventLoopDelay`, p50/p99/max since start) | the server has none; the harness can only probe from outside |
| PostgreSQL: `shared_buffers` 4 GB on a 32 GB server or 2 GB on 16 GB, `wal_compression on`, put WAL on the NVMe, keep fsync on | assumed (hit ratio 100 % with 1 GB here; data is small) |
| Per-install limits: `MemoryHigh=1G` / `MemoryMax=1.5G` leave 3-4x headroom over the measured 235-365 MB; `CPUQuota=200%` is never reached by normal use (one install peaked at 1 core) | measured (memory, CPU here); limits themselves untested (Windows) |
| Caddy rate limit per client address: 20 req/s with burst 60 is far above one person (the busiest person here made one request every 3 s) | assumed from the measured per-person rate |

## Smallest server on this evidence

At the pilot target the fleet used about 1.8 cores (installs) + 1.2-2 cores (PostgreSQL, a lower bound) at 100 req/s,
and 6.4 GB plus shared buffers of memory, on a machine whose cores are faster than a typical cloud vCPU. **I would rent
4 dedicated vCPU / 16 GB / 200 GB NVMe for the first 5-10 organisations and 8 vCPU / 32 GB / 400 GB NVMe (DC-12) for 20**,
which leaves about 2x CPU headroom at the 100 req/s peak and 3x memory headroom; on this PC the knee was 300-400 req/s
with most of 16 threads (much of it other work) in use, so 8 vCPU should keep the knee above 150 req/s (assumed, not measured). Not measured and to re-measure on the
server: the same pilot for 30 + 5 minutes with Caddy and TLS in front, Unix sockets, systemd limits (exit check 8),
PostgreSQL CPU exactly (Linux `/proc` does it), fsync and commit latency of the provider's disk, and disk growth over a
week (photos dominate: about 0.75 GB per 5,000 uploads).

## Numbers that replace estimates in hosting-spec.md (measured here, same caveats)

| Spec line | Estimate | Measured on the PC |
| --- | --- | --- |
| Install processes (sizing) | 20 x 0.25 to 0.5 GB | 20 x 165-260 MB under the pilot load (mean 235 MB, 4.7 GB in all); a heavy tenant 365 MB |
| PostgreSQL memory | 8 to 12 GB | 1.9 GB private + shared_buffers (1 GB here) for 20 installs and 0.85 GB of data |
| CPU | 8 vCPU, "3 or 4 busy at once" | 50 req/s: 0.85 core (installs) + 0.6 core (PostgreSQL, lower bound); 100 req/s: 1.8 + 1.2 cores |
| Connections | 220 at worst, pool 6 chosen | 140 (20 x 7), constant |
| Idle fleet | about 6 % of one core for 20 | 4.8 % for 20 |
| Disk | 400 GB | 0.85 GB of databases for 20 x 90 days of history; photos grow about 0.75 GB per 5,000 |
