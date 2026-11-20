# Hosting options for a first real server (500 to 1,000 users)

Written 20 November 2026. This is an internal research note, not a promise. Prices were read from provider pages on this
date. Where a price could not be confirmed, the text says so. Check every price again before you pay.

Legal and tax points (data location rules, GST on foreign services) are questions for a lawyer or an accountant. They are
flagged here, not answered.

## The short answer

1. **Check things on a real server now:** a small Linux VPS in India, 2 vCPU and 4 GB RAM, about USD 24 a month
   (about INR 2,300). Bill by the hour and delete it when the checks are done. Before that, you can test for zero cost on your
   own PC behind a tunnel (with fake data only).
2. **Pilot of up to 1,000 users of one install:** one Linux VPS in India, 4 vCPU and 8 GB RAM to start, 16 GB if the load test
   says so. About USD 48 to 96 a month for the server, plus backups. Roughly INR 6,000 to 10,000 a month all in.
3. **Do not use a PaaS (Render, Railway, Fly.io) yet.** The server only listens on `127.0.0.1`, there is no Docker image,
   and the first-run setup refuses proxied requests. See the PaaS section.

## What the code and docs say (verified from the repository)

These facts decide the answer.

| Fact | Source |
| --- | --- |
| One Node process. Live hub subscriptions, presence, locks, session throttling, security caches and the files store are in process memory. No cluster mode. No second server on one database. | [Architecture](../dev/architecture.md), [Installation](../admin/installation.md) (not supported yet) |
| Node 22.18 or newer runs the TypeScript directly. No build step for the server. The installers bring Node 24 LTS. | [Release process](../dev/release-process.md) |
| PostgreSQL 15 or newer. The Linux installer uses PostgreSQL 17 from the PGDG repository. Schema `ab` plus one schema per environment. | [Installation](../admin/installation.md) |
| The server listens on `127.0.0.1` only. Changing `APPBUILDER_HOST` is "not supported" and makes it less safe. Caddy sits in front. | [Installation](../admin/installation.md) |
| The Linux installer was run end to end on clean Ubuntu 24.04, Ubuntu 22.04 and Debian 12 (about 40 to 50 seconds). The Windows installer has **never been run on real Windows**. | [Installation](../admin/installation.md), [Release process](../dev/release-process.md) |
| Sizing in the docs is for 20 to 50 users: 2 cores and 2 GB minimum, 4 cores and 4 GB recommended on Linux. The docs call it "our estimate ... not a load test of 50 people". | [Installation](../admin/installation.md) |
| The database pool is 10 connections (`max: 10` in `server/connectors/postgres/db.ts`). There is no environment variable for it. Idle timeout 30 s, connect timeout 10 s. | code |
| Live hub test on a 2 vCPU Xeon 2.1 GHz sandbox: 300 sockets, 50 row updates a second for 30 s, all 450,000 messages delivered, p95 37 ms, 44 % of one core, memory 185 MB to 198 MB. | [Live](../dev/live.md) |
| Limits: 20 sockets per user, 5,000 sockets per server, 200 subscriptions per socket. | [Live](../dev/live.md) |
| Job queue: one worker in the process, 8 jobs at once, 770 to 960 no-op jobs a second in a sandbox test. Table events have a 2 s budget per row. | [Events and jobs](../dev/events-and-jobs.md) |
| Dashboards: at most 4 plans at once, 10 s statement limit. With 1,000,000 rows, a restricted user's seven-tile overview loaded in about 0.5 s on the server (cold) and about 1.3 s in the browser, on 2 vCPU. | [Dashboards](../admin/dashboards.md) |
| PDFs are made inside the Node process with pdfkit. No headless browser. Limits: 500 pages, 20,000 rows, 60 s per document, bulk 2,000 records. | [PDF](../dev/pdf.md) |
| Backups: nightly install backup at 02:00. With 1,000,000 rows and 500 MB of attachments, a backup took 8.2 s and server memory grew about 17 MB. Restore as a new environment took 16.5 s. Retention keeps 7 daily, 4 weekly and 3 monthly. | [Backup and restore](../admin/backup-and-restore.md) |
| Off-site backups are **not** done by Appbuilder. Use rclone or restic, or an off-site folder that is a mounted share. | [Backup and restore](../admin/backup-and-restore.md) |
| A query loads up to 5,000 rows per table into the browser. Writes from one browser go through one ordered chain. | [Architecture](../dev/architecture.md) |
| Email goes through an SMTP relay you supply. Queued as jobs, retried up to 6 times. | [Installation](../admin/installation.md) |
| Internet exposure is supported only through `--https domain`, with two-step verification for administrators, email, off-machine backups and the hardening checklist. | [Installation](../admin/installation.md) |
| **A contradiction to fix:** the last item of the hardening checklist says not to expose the server to the internet "not even through a port forward or tunnel" until TLS and the security-model weaknesses are dealt with. The installation page says `--https domain` is supported. Decide which is true before a public pilot. | [Hardening checklist](../admin/hardening-checklist.md), [Security model](../admin/security-model.md) |

### What has NOT been load-tested

- No test with 50 real users, let alone 500 or 1,000. The docs say so in several places (installation, support runbooks).
- No test of many users opening apps at once (each app open loads its tables, up to 5,000 rows each).
- No test of the 10-connection pool under many concurrent writes plus dashboards plus a backup.
- No test of PDF generation or bulk jobs running while people work.
- No test over a slow or distant network (the live test used the same machine).
- Numbers above come from a 2 vCPU sandbox with PostgreSQL on the same machine. They are good signs, not a capacity promise.

## The two meanings of "500 to 1,000 users"

| | (a) One organisation, 500 to 1,000 named users | (b) 500 to 1,000 users over several small organisations |
| --- | --- | --- |
| What it means for this product | One install, one Node process, one database. Maybe 50 to 150 people online at once. | One install per organisation. The product is not multi-tenant. Environments are for dev, test and prod of one organisation. Users, sessions and the install audit are install-wide. |
| What drives the size | Concurrency on one process. The single-process limit is the risk. | The number of installs. Each install is small (20 to 50 people). |
| Hosting shape | One bigger server. | Many small servers, or many installs on one host. |
| Main cost | The server itself. | Your time. Each install needs its own domain, certificate, backups, updates and monitoring. There is no fleet tooling. |
| Biggest unknown | Does one Node event loop hold 100 to 150 active people? Needs a load test. | Can two installs share one machine? The installer uses fixed names and paths (`appbuilder` service, `/opt/appbuilder`, port 5174, database `appbuilder`). It assumes one install per machine. Several installs on one host would be manual and untested. |

**Reading (b) changes the answer like this.** Do not buy one big server. Buy one small server per organisation (4 GB each,
about USD 24 or INR 2,300 a month at the India providers below). Twenty organisations would be about INR 46,000 a month in
servers alone. The honest cost is the work of keeping twenty installs updated and backed up. If you expect this reading,
the product needs fleet tooling (or multi-tenancy) before it needs any particular host. Neither exists today.

The rest of this note is written for reading (a), because that is what a "pilot" means with the current product.

## Sizing estimate for one install of 500 to 1,000 named users

**This is an estimate from the architecture. No load test exists.**

Assumptions: 1,000 named users, 10 to 15 percent online together (100 to 150 people), each with one or two tabs (one live
socket per tab), mostly reading, some writing. A few dashboards. A few PDF runs an hour. The nightly backup.

| Part | Estimate | Reasoning |
| --- | --- | --- |
| CPU | 4 vCPU | Node uses one core for JavaScript. PostgreSQL, Caddy, backups and the OS need the others. More than 4 cores helps PostgreSQL and backups, not the Node event loop. Fast cores matter more than many cores. |
| RAM | 8 GB to start, 16 GB comfortable | Node: 0.3 to 1 GB. PostgreSQL: shared buffers 2 GB or more, plus connections. The rest is the operating system cache, which is what makes dashboards fast. Backups were light on memory in the test. |
| Disk | 100 to 200 GB NVMe or SSD | Database (about 1 GB per million rows of a typical 20-column table), attachments, and backups. The docs advise 20 GB plus 3 times the database size. Move backups to another disk or off the machine. |
| Network | Small | The app is one 5 MB cached file. API traffic is small JSON. Live messages are small and uncompressed. A few TB a month is far more than needed. |
| Sockets | 150 to 300 | Well below the 5,000 limit. 300 sockets were tested at 44 % of one core under a heavy write load. |

PostgreSQL settings (estimates, the installer does not tune them; apply for a 16 GB machine and halve for 8 GB):

- `shared_buffers` 2 to 4 GB.
- `effective_cache_size` 8 to 10 GB.
- `work_mem` 16 to 32 MB. `maintenance_work_mem` 512 MB.
- `max_connections` 100 is plenty. The app holds 10 of them.
- `random_page_cost` 1.1 for SSD. `checkpoint_timeout` 15 min. `wal_compression` on.
- Leave autovacuum on. Mark the columns people filter and group by as Indexed in the table designer (the dashboards page says this).
- For recovery to a point in time, WAL archiving is not set up by Appbuilder. See the backup page.

### Architectural risks at this size

1. **One Node process, one event loop.** A slow formula, a huge import or a large PDF in the same process delays every
   user. The server cannot be scaled out. The way up is a faster core, not more servers.
2. **In-memory hub.** If the process restarts, every socket reconnects at once and every open table resyncs (a refetch).
   With 150 people that is a burst of queries. Plan restarts (updates) for quiet hours.
3. **Pool of 10 database connections, not configurable.** Writes hold a connection for a whole transaction. Dashboards run
   up to 4 queries of up to 10 s. The backup holds a long snapshot transaction. Under load, requests queue for a connection.
   This is the first thing to watch.
4. **PDF and bulk jobs in-process.** A 500-page PDF or a 2,000-record bulk run uses the same event loop as the live users.
   Eight jobs run at once. No separate worker process exists.
5. **5,000-row loads on app open.** A busy morning with 150 people opening apps that read big tables is a spike in both
   PostgreSQL and bandwidth. Not measured.
6. **Row-level security cost.** Row predicates are added into every query. The docs list "which row-rule shapes are expensive
   at scale" as an open question.
7. **Backups on the same disk and the same machine.** A backup during working hours competes for I/O. A disk failure loses
   data and backups together unless they are copied off.
8. **No high availability.** One server is a single point of failure. Restore from backup is the recovery plan (tested: 20 s
   drill on a tiny data set; a real data set will take longer).
9. **Latency.** Writes from one browser are sent one after another. A server far from the users makes each save slower. See
   the latency note below.
10. **Shared CPU VPS plans.** On cheap plans another customer can use your core. For a single-threaded server this shows up as
    random slowness.

### What a load test should measure

Run it on the same plan you will buy, with the data size you expect, with the browser far away (not on the server).

- Concurrency steps: 25, 50, 100, 150, 250 simulated users doing a realistic mix (open app, read tables, save a row, open a
  dashboard, a few PDFs).
- Per step: API latency p50, p95, p99; error rate; Node CPU, event-loop lag and RSS; PostgreSQL CPU, active connections and
  waiting-for-connection time (the pool of 10); disk I/O; live message latency; reconnect time after a restart.
- Row counts: 10,000, 1 million and 5 million rows in the biggest table, with row-level rules on.
- Heavy jobs: a 500-page PDF, a 2,000-record bulk PDF, a CSV import and a rollup backfill while the 100-user mix runs.
- The nightly backup and the restore time at the real data size, while 50 users work.
- A server restart with 150 sockets connected.
- The existing scripts to start from: `scripts/load/live-load.mjs`, `scripts/exit-check/p2-dashboard.mjs`,
  `scripts/drill/restore-drill.mjs`. They measure single features, not a mixed day.

## Options compared

Prices checked on 20 November 2026. Conversions use about INR 96 per USD (the latest dated source I found was July 2026; no
November rate could be confirmed) and an assumed INR 110 per euro. Prices exclude tax unless stated. GST and card payment
rules for foreign providers are a question for your accountant.

### Single VPS

| Provider and plan | Specs | Price per month | Source and note |
| --- | --- | --- | --- |
| Hetzner CPX22, Helsinki | 2 vCPU, 4 GB, 80 GB NVMe, 20 TB traffic | EUR 16.99 (about INR 1,900) | [Hetzner CPX page](https://www.hetzner.com/cloud/regular-performance/), excl. VAT, page says price includes IPv4. Germany and Finland, not India. |
| Hetzner CPX32, Helsinki | 4 vCPU, 8 GB, 160 GB | EUR 30.49 (about INR 3,400) | same page |
| Hetzner CPX42, Helsinki | 8 vCPU, 16 GB, 320 GB | EUR 59.49 (about INR 6,500) | same page |
| Hetzner CPX22 / CPX32 / CPX42, Singapore | as above, 1 / 2 / 3 TB traffic | EUR 26.99 / 49.49 / 93.99 | same page. Nearest Hetzner site to India. |
| DigitalOcean Basic, Bangalore | 2 vCPU, 4 GB, 80 GB, 4,000 GiB | USD 24 (about INR 2,300) | [DigitalOcean pricing](https://www.digitalocean.com/pricing/droplets). The page confirms a Bangalore datacentre but shows no per-region price. Basic droplets are shared CPU. |
| DigitalOcean Basic | 4 vCPU, 8 GB, 160 GB, 5,000 GiB | USD 48 (about INR 4,600) | same page |
| DigitalOcean Basic | 8 vCPU, 16 GB, 320 GB, 6,000 GiB | USD 96 (about INR 9,200) | same page |
| AWS Lightsail, Mumbai | Medium: 2 vCPU, 4 GB, 80 GB | USD 24 (about INR 2,300) | [Lightsail bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html). Public IPv4 included. The IPv6-only plan is USD 4 cheaper, so IPv4 is about USD 4. Large 8 GB is only 2 vCPU at USD 44. |
| AWS Lightsail | Xlarge: 4 vCPU, 16 GB, 320 GB | USD 84 (about INR 8,100) | same page. Memory-optimised 2 vCPU, 16 GB is USD 74. |
| Lightsail transfer in Mumbai | half the usual allowance | | [AWS pricing summary](https://aws.amazon.com/lightsail/pricing). Mumbai plans include half the data transfer of the standard bundles. |
| Hostinger KVM 2 | 2 vCPU, 8 GB, 100 GB NVMe, 8 TB | INR 779 on a 24-month prepaid term (INR 18,696 upfront), renews at INR 1,199 | [Hostinger India](https://www.hostinger.com/in/pricing/vps-hosting). Only the 24-month term was shown. The page does not say whether servers are in India. GST not mentioned. |
| Hostinger KVM 4 | 4 vCPU, 16 GB, 200 GB NVMe, 16 TB | INR 1,099 intro (INR 26,376 upfront), renews at INR 2,399 | same page |
| Akamai (Linode), Mumbai | Shared 2 GB about USD 12; 4 GB about USD 24; dedicated 4 GB about USD 43 | not confirmed | Only third-party listings found ([search result](https://www.akamai.com/cloud/pricing/asia-pacific) pointed to Akamai's page, but no Mumbai table was readable). Check on Akamai's own page. |
| Utho (India) | plan names and prices unclear | **could not be confirmed** | Third-party listings conflict and the vendor page gave no price. Ask Utho. |
| Vultr, Bangalore | 2 vCPU, 4 GB shown at about USD 20 on a comparison page | **could not be confirmed** for Bangalore | [Vultr](https://www.vultr.com/products/regular-performance-compute/) lists Bangalore but showed no price. |
| E2E Networks (India) | CPU plans listed, tables not readable | **could not be confirmed** | [E2E pricing](https://www.e2enetworks.com/pricing). Currency of the tables was unclear (INR or USD). Reserved IP USD 3 a month and snapshots USD 0.05 per GB a month were shown. |
| OVH | not researched | not confirmed | |

Notes on single VPS options:

- **Latency from India.** India to Hetzner Finland or Germany is typically over 120 ms round trip, to Singapore about 50 to
  90 ms, and within India under 30 ms. These are my assumptions, not measurements. Measure from your users' networks with
  `ping` before you choose. Saves are sent one after another, so distance shows up directly.
- **Data location.** An Indian customer may ask where the data sits. India-region choices: DigitalOcean Bangalore, Lightsail
  Mumbai, Akamai Mumbai, Vultr Bangalore, E2E, Utho. Hetzner has no Indian site. Whether the law requires Indian hosting for
  your customers is **a question for a lawyer**. For context only: the Digital Personal Data Protection Rules 2025 were
  notified in November 2025 with an 18-month phase-in, and reports describe a permissive default on cross-border transfers
  with possible restrictions later, and stricter treatment of "significant data fiduciaries". See for example
  [SFLC.in](https://sflc.in/dpdp-rules-2025-significant-data-fiduciaries-and-data-transfers/). I read secondary summaries,
  not the official text. Do not rely on this.
- **Compliance claims.** I make no claim about any provider's certifications. If a customer asks, use the provider's own
  compliance page.
- **IPv4 cost.** Hetzner, DigitalOcean and Lightsail IPv4 is inside the plan price. Fly.io charges USD 2 a month for a
  dedicated IPv4. Phones and Let's Encrypt need IPv4 in practice, so do not choose IPv6-only plans.
- **Egress.** All the plans above include terabytes. Not a concern at this size. Lightsail Mumbai has half the allowance.
- **Backups and snapshots.** Provider snapshots are a second layer, not a replacement for the app's own backups. Prices for
  Hetzner and DigitalOcean backup add-ons were not confirmed. Fly.io volume snapshots are USD 0.08 per GB a month (see the Fly source below).
- **Hostinger's 24-month prepay** is a large commitment for a pre-revenue founder and is not "try it and delete it".

### Hyperscaler VM with managed PostgreSQL (AWS, Azure, GCP; Mumbai)

- **Fit:** It does not fit today. The Linux installer installs PostgreSQL on the same machine. Running against a remote
  database is "not supported yet" through the installers (installation page, last section). You would install from source
  with `APPBUILDER_DB_*`, and the backup tool needs `pg_dump` of the same or newer major version.
- **Cost, confirmed:** DigitalOcean's managed PostgreSQL is USD 15.15 (1 GB), 30.45 (2 GB), 60.90 (4 GB, 2 vCPU), 122.10
  (8 GB, 4 vCPU) a month, plus storage at USD 0.215 per GB ([DigitalOcean databases](https://www.digitalocean.com/pricing/managed-databases)).
  That is the app server price again, or more.
- **Cost, not confirmed:** AWS RDS for PostgreSQL in Mumbai and Azure Database for PostgreSQL in Central India. The pricing
  pages I could read did not show regional tables. Use the AWS Pricing Calculator and the Azure Retail Prices API. As a
  rule of thumb (not confirmed here), managed PostgreSQL plus an app VM costs two to three times a single VPS.
- **Benefit:** automatic backups and point-in-time recovery, patching. It does not remove the single Node process.
- **Verdict:** not now. Revisit when a customer demands managed backups with point-in-time recovery.

### PaaS (Render, Railway, Fly.io)

**They do not fit today. This is a code-level reason, not a price reason.**

- The server binds `127.0.0.1` only and `APPBUILDER_HOST` is unsupported. A PaaS routes traffic to the container's public
  interface, so it would never reach the server.
- There is no Docker image. "Not packaged: a Docker image" (architecture and installation pages).
- The first-run setup must come from the machine itself, without proxy headers. A PaaS has no shell on the loopback address
  in that sense.
- It needs `pg_dump` and a workspace folder for attachments and backups. This needs a persistent disk on one instance.
- Single instance only. That fits, but zero-downtime deploys across two instances are not allowed.

For reference, prices read on 20 November 2026:

| Provider | What | Price | Source |
| --- | --- | --- | --- |
| Render | Web service 2 CPU, 4 GB / 8 GB; Postgres 1 CPU 2 GB / 2 CPU 8 GB; disk | USD 85 / 135; USD 40 / 100; disk USD 0.25 per GB a month; Pro workspace USD 25 | [Render pricing](https://render.com/pricing.md). Regions not confirmed. |
| Railway | Hobby USD 5 (includes USD 5 usage), Pro USD 20; memory about USD 10 per GB a month, CPU about USD 20 per vCPU a month; volume about USD 0.15 per GB; egress USD 0.05 per GB | 4 GB and 2 vCPU would be about USD 80 before the database. Hobby volume limit is 5 GB. | [Railway pricing](https://railway.com/pricing). Regions not confirmed. |
| Fly.io | shared-cpu-2x, 2 GB USD 13.39; performance-2x, 4 GB USD 66; volume USD 0.15 per GB; snapshot USD 0.08 per GB; dedicated IPv4 USD 2; egress USD 0.12 per GB for India and Africa; Managed Postgres from USD 38 | | [Fly.io pricing](https://docs.fly.io/about/pricing). Mumbai not confirmed on the page. |

A PaaS would also cost more than a VPS for the same CPU and memory. Not worth building an image and changing the listener
for a first pilot.

### Your own PC behind a tunnel (zero cost test)

- **Cloudflare Tunnel.** `cloudflared` makes an outbound connection and gives a public HTTPS name. It needs a domain managed
  by Cloudflare. I read Cloudflare's docs ([Tunnel](https://developers.cloudflare.com/tunnel/)); they did not state the price
  or WebSocket support on the pages I could read. From general knowledge, not confirmed here: the tunnel is free and passes
  WebSockets. **Check both** on Cloudflare's site before relying on it. Cloudflare terminates the HTTPS, so the server
  sees the traffic as a proxy.
- **Tailscale Funnel.** The [Funnel page](https://tailscale.com/kb/1223/funnel) says it is in beta, limits ports to 443, 8443 and 10000, has
  bandwidth limits it does not number, and only serves names under your `ts.net` tailnet name (no custom domain). WebSocket
  support is not mentioned. It is fine for a phone test of HTTPS and the camera, less so for anything else.
- **How it would work here.** Run from the source folder (`npm ci`, `npm run build`, `npm start`) because the Windows
  installer has never been run on real Windows. Set `APPBUILDER_ALLOWED_HOSTS` to the public name and
  `APPBUILDER_SECURE_COOKIE=1`. Point the tunnel at `127.0.0.1:5174` (not at Caddy). Do the first-run setup on the PC
  itself at `http://localhost:5174`, before exposing anything. Check that the top bar does not say "Live updates paused".
- **Risks.** The PC must stay on. Home internet in India is often behind carrier NAT and has no static IP (a tunnel solves
  this). Upload speed is low. Sleep and Windows updates will break tests. And the hardening checklist says not to expose the
  server through a tunnel. Use **fake data only**, no real users, and shut the tunnel when done.
- **Verdict:** good for a day of "does HTTPS, the phone camera and email work", not for a pilot.

## Recommendation 1: check features that need a real server, now

**Goal:** HTTPS, phones on the internet, email, PDFs, dashboards, a real domain. Cheapest sensible, easy to throw away.

**Server:** DigitalOcean Bangalore, Basic droplet, 2 vCPU, 4 GB, 80 GB, USD 24 a month (about INR 2,300). Billed by the hour, so a
two-week test costs about USD 12. Alternative at the same price: AWS Lightsail Mumbai Medium. The cheaper Hetzner CPX22 in Helsinki
(EUR 16.99, about INR 1,900) is fine for feature checks but is far from India, so the app will feel slow on phones and
that would mislead you.

Steps:

1. Create the VPS with the **Ubuntu 24.04** image (the installer's best-tested system). Add your SSH key, no password login.
2. Buy or use a domain. Make an A record, for example `test.yourdomain` to the server's IPv4 address. (Domain price not
   researched.)
3. Log in by SSH. Allow SSH first: `sudo ufw allow OpenSSH`.
4. Download the release ZIP, check its SHA-256 against the value you built, unzip it.
5. Run the installer with HTTPS and the firewall rule (from the installation page):
   `sudo bash appbuilder-<version>/scripts/install/linux/install.sh --https domain --domain test.yourdomain --acme-email you@example.com --ufw`
   Then `sudo ufw enable`.
6. Do the first-run setup through an SSH tunnel: `ssh -L 5174:127.0.0.1:5174 user@server`, then open
   `http://localhost:5174/`, use the code from `sudo appbuilder setup-code`. Create the administrator. Turn on two-step
   verification.
7. Set up email (Admin console > Email). The simplest relay is a Google Workspace or Microsoft 365 mailbox with the app
   password or OAuth method in the installation page. Send a test email. (Whether the provider allows outbound SMTP ports from a
   new VPS was not checked. Port 587 usually works; port 25 is often blocked.)
8. Open `https://test.yourdomain/` on a phone. Check sign-in, add to home screen, camera, a PDF, a dashboard.
9. Turn on a backup test (Backups > Schedule > Restore test) and do one restore drill. Delete the droplet when done.

**Cost:** about USD 24 a month while it runs (about INR 2,300), pro-rated by the hour. Domain extra. Use fake data only.
Free first step: the PC-and-tunnel test above.

## Recommendation 2: a pilot of up to 1,000 users of one install

**Server:** DigitalOcean Bangalore, 4 vCPU and 8 GB, 160 GB, USD 48 a month (about INR 4,600). Start here, because the docs'
own sizing is far below this and 100 to 150 active people are an estimate. If the load test shows memory pressure or slow
PostgreSQL, resize to 8 vCPU and 16 GB at USD 96 (about INR 9,200). Equal alternative: Lightsail Mumbai Xlarge, 4 vCPU and 16 GB,
USD 84 (about INR 8,100). Shared CPU is a risk for a single-threaded server. Dedicated-CPU plans cost more and were not priced
in this note.

Steps:

1. Create a VPS with Ubuntu 24.04. Turn on the provider's automatic backups or weekly snapshots (price not confirmed).
2. Point a domain at it (`apps.yourdomain`). Open ports 22, 80 and 443 only.
3. Install with `--https domain --domain apps.yourdomain --acme-email ... --ufw`. Do the first-run setup through the SSH
   tunnel. Create two administrators. Require two-step verification for administrators.
4. Tune PostgreSQL as in the sizing section. Restart PostgreSQL.
5. Set email (Admin console > Email) and the public address. Turn on the health email and the **heartbeat** (healthchecks.io
   or Uptime Kuma) so you are told when the server is down.
6. Move backups off the machine. Set the Appbuilder backup folder to a second volume if the provider offers one, and run
   `rclone sync` after the nightly 02:00 backup to an object store of a different provider. Prefer a target with versioning or
   object lock. Encrypt backups with a passphrase and keep it and `.secret-key` apart from the backups. Object-storage
   prices were not researched.
7. **Run the load test** (section above) on this server before inviting real users. Record the numbers in this folder.
8. Go through the [hardening checklist](../admin/hardening-checklist.md) and resolve the tunnel and internet contradiction.
9. Restore drill on a spare small VPS once a month during the pilot. See [Disaster recovery](../admin/disaster-recovery.md).
10. Update with `appbuilder update <zip>` in a quiet hour, after a backup.

**Rough monthly cost:** server USD 48 (about INR 4,600), backups or snapshots about USD 10 (assumed, about INR 1,000),
off-site object storage about USD 5 (assumed, about INR 500), domain and monitoring free to INR 100. Total **about USD 65
(about INR 6,200)**. With the 16 GB step: about USD 115 to 125 (about INR 11,000 to 12,000). GST or tax on top is a question
for your accountant.

If the pilot is reading (b) (many small organisations), do not do this. Use Recommendation 1's small server once per
organisation, and plan the operations work.

## What I would not do yet

- **Kubernetes or Docker orchestration.** There is no Docker image, and the app cannot run as more than one process.
  Kubernetes would add cost and work and give nothing.
- **Multi-region or multi-server.** The in-memory hub, locks and throttles make a second process wrong, not just slow.
- **A load balancer or autoscaling.** Same reason.
- **Managed PostgreSQL on a hyperscaler.** Costs two to three times more (rule of thumb, unconfirmed), and the installers do
  not support a remote database.
- **A PaaS.** The listener and the setup rules block it (see above).
- **Windows server hosting.** The Windows installer has never run on real Windows.
- **Hostinger 24-month prepay.** Cheap per month, but a large lock-in before you know the load. Its server location is not
  confirmed.
- **Calling this production for paying customers** before: a load test, a restore drill on real data, a decision on the
  internet-exposure contradiction, and a lawyer's answer on data location.

## Three biggest uncertainties

1. **Capacity.** Whether one Node process and a pool of 10 database connections hold 100 to 150 active people. No load test.
2. **Which meaning of "users" is real.** If it is many small organisations, the cost is operations work, and no tooling exists.
3. **Legal and tax.** Data location expectations, the DPDP position, and GST on foreign hosting. All for a lawyer and an accountant.

## What was verified, from where

| Kind | Items |
| --- | --- |
| **From the code and repository docs** | Single process and in-memory state; 127.0.0.1 listener and unsupported `APPBUILDER_HOST`; no Docker image; pool size 10; sockets, jobs, PDF, dashboard and backup numbers and limits; Linux installer behaviour (systemd, PostgreSQL 17, Caddy, `--https domain`, `--ufw`); Windows installer not run on Windows; no load test exists; the checklist contradiction. |
| **From the web (20 November 2026)** | Hetzner CPX prices and traffic (hetzner.com); DigitalOcean droplet and managed database prices (digitalocean.com); Lightsail bundle prices and Mumbai half-transfer note (AWS docs); Hostinger India plans (hostinger.com); Render, Railway and Fly.io prices; Tailscale Funnel limits. |
| **From web search only, weak sources** | USD to INR rate (July 2026); Akamai and Vultr prices (third-party listings); Utho and E2E (not usable); DPDP summaries (law-firm and advocacy articles). |
| **Assumed, not checked** | Euro to rupee rate; network latency from India; Cloudflare Tunnel being free and carrying WebSockets; provider backup add-on prices; object storage prices; domain prices; outbound SMTP port rules at each provider; all sizing and PostgreSQL settings; the "two to three times" managed database rule of thumb; whether shared CPU plans are noisy in practice. |
