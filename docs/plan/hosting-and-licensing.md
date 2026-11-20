# Hosting several organisations, and licensing: proposal

Status: PROPOSAL for the owner (20 Nov 2026). Nothing here is built. It follows the owner decisions in
[master-plan.md](master-plan.md) section 12 and the research in [../internal/hosting-options.md](../internal/hosting-options.md).

## The fact to plan around

The product is **not multi-tenant**. One install serves one organisation: users are install-wide, the security
caches, the live hub, locks and rate counters live in one process, and [../dev/architecture.md](../dev/architecture.md)
lists multi-tenant hosting as not supported. "Environments" (dev / test / production) are not tenants: an install
administrator sees all of them.

## Two ways to host many organisations

| | A. One install per organisation, many on a server (recommended) | B. True multi-tenancy inside one install |
| --- | --- | --- |
| What it is | Each organisation gets its own server process, its own PostgreSQL database and its own workspace folder; a reverse proxy sends `<org>.<our domain>` to its process | A tenant level above environments in every table, query, cache, job, backup and file path |
| Isolation | By process and database: a bug in the product cannot show one organisation another's data | By code: every query must filter by tenant; one missed filter is a data leak between customers |
| Work | A provisioning tool (create database, workspace, service, proxy entry, first administrator invite), fleet updates and backups, a status page for us | A rewrite of the kernel's assumptions and a new security review of everything built so far |
| Cost per organisation | One Node process (memory to be MEASURED; not known today) plus its database | Lower |
| The same build as on-site | Yes: the on-site product and the hosted one are the same install | No: two modes to test |

Recommendation: **A**. It reuses everything that is tested, keeps the on-site option identical, and its weakness
(memory per organisation) is paid for by subscription revenue. B is a different product and would stop feature work for
a long time.

What A needs that does not exist: (1) the installer assumes one install per machine; (2) the server listens on
127.0.0.1 with a fixed port by default; (3) no fleet tooling (provision, update, back up, monitor, suspend); (4) no
measured memory and CPU per idle and per busy install; (5) the first-run setup refuses requests through a proxy.

## Licensing (online verification)

Proposed design, to be confirmed:

1. A small **licence service** on our side: organisations, plans, seats (Full user / Operator / External), payment
   state, and signed licence answers.
2. Each install holds an organisation key. At start and every few hours it asks the service for a **signed, short-lived
   licence answer** (organisation, plan, seats, valid-until). The server verifies the signature with a public key built
   into the release.
3. **Grace period (owner decision needed):** when the service cannot be reached, the last valid answer keeps working
   until its valid-until time (proposal: 7 days), with a visible warning for administrators. After that: read-only,
   export always works (as decided in section 9). Without any grace, an outage of our service or of a customer's line
   stops every customer at once.
4. Hosted organisations: a missed recurring payment moves the organisation to read-only after a notice period, never to
   deleted. On-site: the one-time licence does not expire, but it is still verified online (so it cannot be copied to
   a second site).
5. No personal data goes to the licence service beyond counts of seats in use.

Placement: licence passes are Phase 3 in the master plan. The licence service, the provisioning tool and the
payments connector (Razorpay, hosted pages: [../launch/payments.md](../launch/payments.md)) belong together there.

## Decisions needed from the owner

1. Approach A or B.
2. The grace period when the licence service is unreachable (0, 3, 7 or 14 days).
3. Whether "LTV" means a lifetime (one-time) licence for the on-site option.
4. Whether the hosted option may start before the outside security review (the master plan requires that review before
   going beyond one pilot).

Legal and tax points (data location, DPDP, GST on subscriptions) are for a lawyer and an accountant.