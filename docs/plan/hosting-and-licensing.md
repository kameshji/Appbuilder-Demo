# Multi-tenant cloud, on-premises installs and licensing

Status: DECIDED in outline by the owner on 20 Nov 2026 ([master-plan.md](master-plan.md) sections 12 and 13). NOT yet
specified in detail and NOT built. The hosting research is in [../internal/hosting-options.md](../internal/hosting-options.md).

## Decisions

| Question | Decision |
| --- | --- |
| Cloud | True multi-tenancy inside the product (tens of thousands of users expected) |
| On-premises | One organisation per install, lifetime licence |
| Licence check | Online; 3 days of grace when the licence service cannot be reached, then read-only (export always works) |
| First customers | Invited testers (start-ups and companies), then subscriptions per N seats |
| Outside security review | Not required before hosted testers start (risk accepted by the owner) |

## Where the product is today

One install serves one organisation. Users are install-wide; the security caches, the live hub, locks, rate counters and
session throttling live in the memory of ONE server process ([../dev/architecture.md](../dev/architecture.md) lists
multi-tenant hosting and more than one server process as not supported); the database pool is 10 connections; no load
test exists at any size. Every feature of Phases 0 to 2 was built and security-reviewed on that assumption.

## What true multi-tenancy needs (outline of a new phase, to be specified)

1. **A tenant (organisation) above environments.** Today: schema `ab` (install-wide) + one schema per environment.
   Proposed shape to evaluate first: users, sessions, roles, environments, audit, settings, licence and files become
   tenant-scoped; each tenant's environments keep their own schemas (isolation by schema stays, as today, instead of a
   tenant column on every data row). To be measured: PostgreSQL with thousands of schemas (catalogue size, backup,
   migration time across all tenants), versus several databases, versus a tenant column.
2. **Every request resolves a tenant first** (by host name such as `<org>.<domain>`), before the session: sign-in,
   password reset, API keys, webhooks, kiosk tokens, email links, the service worker and PWA manifests, the live
   socket. A session of one tenant must be worthless in another.
3. **Per-tenant everything that is keyed per install today:** security and connection caches, rate limits, job queue
   fairness (one tenant's bulk job must not starve the others), storage quotas, the outbound network policy, secrets
   (a key per tenant), backups and restore per tenant, export and deletion of one tenant.
4. **More than one server process.** Tens of thousands of users do not fit one Node process: the live hub, locks, rate
   counters and caches need a shared mechanism (PostgreSQL LISTEN/NOTIFY or advisory locks first; an extra service only
   if measurement demands it), workers separated from web processes (PDFs and bulk jobs out of the request path),
   connection pooling sized and proven.
5. **A control plane:** tenant sign-up and provisioning, plans and seats, suspension, billing state (payments connector:
   [../launch/payments.md](../launch/payments.md)), an operator console for us with audited access.
6. **Proof:** a tenant-isolation test suite (every route, as tenant A, against tenant B's ids), a security re-review of
   Phases 0 to 2 under the new model, and load tests (none exist today).
7. **On-premises keeps working from the same code** as a single-tenant mode, so one product is tested, not two.

This is larger than any phase so far and changes the kernel that everything else stands on. Recommended order: write
the specification with a spike that measures item 1 and item 4, then build it BEFORE Phase 3's chat and templates packs
(each feature built before it must later be made tenant-aware and re-reviewed).

## Licensing

1. A licence service on our side: organisations, plans, seats (Full user / Operator / External), payment state, signed
   short-lived licence answers.
2. An install (on-premises) or the cloud control plane verifies the signature with a public key built into the release.
   On-premises asks at start and every few hours.
3. **Grace: 3 days.** When the service cannot be reached, the last valid answer keeps working for 3 days with a visible
   warning to administrators; after that read-only, export always works.
4. On-premises lifetime licences do not expire but are still verified online (so one licence cannot run two sites).
   Consequence to state to buyers: an on-premises site that loses its internet for more than 3 days becomes read-only.
5. Hosted tenants: a missed payment moves the tenant to read-only after a notice period, never to deleted.
6. Only seat counts go to the licence service, no personal data.

## Open points for the owner

1. When to do the multi-tenancy phase: before Phase 3 (recommended above) or after.
2. A written statement to testers that the service has had no outside security review yet (a lawyer should word the
   tester terms; storing other companies' data brings contract and data-protection duties).
3. Pricing per seat and the seat bands.

Legal and tax points (data location, DPDP, GST on subscriptions, tester terms) are for a lawyer and an accountant.