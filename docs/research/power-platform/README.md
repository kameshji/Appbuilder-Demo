# Microsoft Power Platform: how it works, and what Appbuilder should do instead

Research date: 18 November 2026. Primary sources are Microsoft Learn pages fetched on that date; a few news reports and forum threads are used and marked as secondary or anecdotal. Each file separates sourced facts (linked inline) from the author's opinion (labelled *inference*) and marks anything not confirmed on a fetched page as *unverified*.

Target reader: the Appbuilder team designing the next phases (flow engine, admin console with environments, dashboards, external site builder, team chat, document library, agent builder) for 20-50 person organisations, deployed as one Node 22 + MySQL/MariaDB install on an on-prem PC or a small VPS.

## Files

| File | Covers |
|---|---|
| [admin-and-environments.md](admin-and-environments.md) | Admin center, tenants, environment types, environment groups and rules, managed environments, data (DLP) policies, capacity, environment variables, admin roles and security groups, auditing and monitoring, backup/restore/copy |
| [dataverse.md](dataverse.md) | Table types and ownership, columns, relationships, computed columns, alternate keys, business rules, the full security model, plug-in pipeline, Web API, change tracking, auditing, search, long-term retention |
| [power-apps.md](power-apps.md) | Canvas vs model-driven (and how model-driven apps are generated from metadata), Power Fx, delegation, components and PCF, offline, sharing and versions, responsive layout, co-authoring, Monitor |
| [power-automate.md](power-automate.md) | Cloud flows on the Logic Apps engine, triggers, limits and request metering, expressions, run-after and scopes, child flows, approvals, desktop flows and process mining (briefly) |
| [connectors.md](connectors.md) | OpenAPI-based connectors, runtime architecture, standard/premium/custom, auth types, connections vs references, on-premises data gateway, throttling, DLP grouping |
| [alm-and-solutions.md](alm-and-solutions.md) | Managed/unmanaged solutions, layers, publishers, lifecycle operations, dependencies, env vars and references, pipelines, source control, file format |
| [power-pages.md](power-pages.md) | Site metadata in Dataverse, Liquid, lists/forms/multistep forms, authentication, web roles and table permissions, caching, design studio, security scan, licensing, known pain points (including the 2024 data exposure research) |
| [copilot-studio.md](copilot-studio.md) | The three 2026 harnesses, topics/triggers, generative orchestration, tools and MCP, multi-agent, knowledge and grounding, channels, authentication, analytics, governance, Copilot Credits |
| [power-bi-lite.md](power-bi-lite.md) | Semantic models, import vs DirectQuery, refresh caps, measures and filter context, reports vs dashboards, RLS, embedding; model-driven charts and dashboards |
| [cross-cutting.md](cross-cutting.md) | Entra ID identity, licensing concepts, request limits, telemetry, maker portal UX, Teams integration, Microsoft 365 integration points |

Every file ends with **How to replicate on our stack** (tables, services, APIs mapped to what exists in `server/` and `src/`) and **Where we can be better for a 20-50 person org**.

## Summary of what we learned

1. **The environment is Microsoft's unit of everything** (security, region, backup, policy, ALM), and most admin complexity exists to manage *many* of them: environment groups, rules galleries, routing, managed environments. A 30-person company needs Production plus one Test copy. Model an environment as a MySQL schema + workspace subfolder in one process, with downloadable backups — something Microsoft explicitly can't offer.
2. **Dataverse's security model is the right shape and too many mechanisms.** Privilege check then row access check, cumulative roles, column security — Appbuilder already does this with `none/own/all` scopes, row filters and per-role column access. Microsoft is adding "filtered" row ownership in preview, which is our `rowFilter`. Add teams and a single "department" scope; add sharing and hierarchy only on demand; ship a "why can X see this row?" explainer.
3. **Logic is fragmented across six mechanisms** (business rules, classic workflows, .NET plug-ins, low-code plug-ins, Dataverse functions, flows) and **three formula languages** (Power Fx, WDL in flows, DAX/Liquid/FetchXML elsewhere). Our biggest advantage is one formula engine (Fx) everywhere. That requires running Fx on the server — the most important architectural decision implied by this research (`src/fx` is DOM-free and can be imported by the server with an explicit exception to architecture rule 3, or moved to a shared package).
4. **Delegation is Power Apps' worst trap**: non-delegable formulas silently evaluate over the first 500-10,000 rows. Because we own one SQL backend, we can delegate far more (including GroupBy, Distinct, lookups as joins) and make non-delegable cases errors, not warnings. This replaces D10's 5,000-row cap.
5. **Model-driven apps prove that "a table should come with a list and a form for free".** Build "auto apps" from table metadata, with one-click conversion to a canvas app — Microsoft never bridges the two app types.
6. **Cloud flows are Logic Apps with action metering.** The engine is at-least-once, has a 30-day run cap, polling triggers that flood after re-enable and webhook triggers that drop events, auto-disables failing or idle flows, and meters every action. A durable MySQL-backed engine inside our process with an outbox for table triggers, Fx expressions, approvals as plain tables, and no metering is both simpler and better behaved.
7. **Connectors are OpenAPI wrappers behind API Management with a premium paywall**; shared SQL credentials were effectively reusable by any app user until secure implicit connections arrived in 2024. Keep credentials server-side only, add action connectors with JSON-Schema operations (they double as agent tools), and an outbound-only on-prem agent (needed anyway for Tally).
8. **Solutions use layers and "top wins"**, uninstalling a managed solution deletes its data, and patches are discouraged but present. Our import currently always creates new copies; the minimum viable ALM is upgrade-in-place with a previewed plan, automatic backup first, and production apps locked from edits.
9. **Power Pages' security model is reasonable but easy to misconfigure**: open registration + Global table permissions + an all-columns Web API leaked millions of records in 2024 (news reports of AppOmni research). Its cache serves changes made outside the site up to 15 minutes late. Build block-scoped endpoints (no generic public table API), default deny, typed confirmation for public grants, a publish-time security lint, and write-through cache invalidation.
10. **Copilot Studio now has three harnesses** (Microsoft Copilot, Customer Conversation, standard), with per-feature credit rates on one and token-based billing from first build on another; good SharePoint grounding effectively needs Microsoft 365 Copilot licences. Our agent builder should be one runtime, provider-agnostic (including local Ollama), with tools that always run as the end user through our security engine, permission-filtered RAG stored in MySQL, MCP support, and budgets in rupees.
11. **Power BI brings a second security model** (DAX RLS that doesn't apply to workspace members) and refresh caps (8/day on Pro). Live, security-trimmed aggregate queries over MySQL with a light metrics layer cover a small org's dashboards; expose an OData feed for those who already use Power BI.
12. **Licensing is the product's biggest tax on small customers**: seeded vs premium, per user, per app (end-of-sale from January 2026 in some channels), pay-as-you-go via Azure, Process per flow, capacity add-ons, Pages capacity, Copilot Credits, and the free on-ramps (Dataverse for Teams, unmanaged developer environments) are being deprecated in November 2026.

## What to replicate, what to skip, what to do better

| Area | Replicate | Skip | Do better |
|---|---|---|---|
| Environments | Production/Test split; per-environment membership; copy with background jobs and outbound messages paused | Default free-for-all environment, environment groups, rules gallery, regions, CMK, Lockbox, VNet, trial environments | Environment = MySQL schema + folder; max ~5; downloadable SQL backups with any retention; restore in place |
| Admin and governance | One admin console; audit log; usage stats; sharing limits | Managed-environments licensing gate; two overlapping DLP engines; Purview/App Insights split | Governance always on; one connector allowlist per environment; one real-time audit viewer; one "Add person" dialog |
| Environment variables | Definition + default + per-environment value; prompt on import | Azure Key Vault dependency; 1-hour propagation | Secrets sealed with the install key; values read at request time |
| Data model | Lookups with cascade options, alternate (composite unique) keys, change tracking with tokens, audit with per-row retention, file/image columns | Elastic tables, activity-party, currency exchange, irreversible ownership choice, FetchXML | One Fx formula column type; rollups maintained in the write transaction; cursor paging and exact counts; reversible archive tables |
| Security | Privilege check then row check; cumulative roles; column access; teams | Parent:Child BU depth, position hierarchy, access team templates, per-row column sharing | Scopes + row filters + column access on one role screen; "why can X see this row?" and "view as" from day one |
| Server logic | Before/after events inside the write transaction; async after-events | Business rules as a separate system; .NET plug-ins; PreValidation/PreOperation/MainOperation numbering | One table-events mechanism using server-side Fx; UI rules stay as control properties |
| Apps | Spreadsheet-style formulas (done), auto-layout (done), component libraries, version history with Live marker, Monitor | Business process flows as tables, ribbon XML, phone canvas, `.msapp` | Auto apps from metadata with convert-to-canvas; broad delegation with errors not warnings; lock-based single editor; offline in browser/PWA |
| Flows | Triggers with conditions, run-after + try/catch scopes, retries with backoff, typed manual inputs/outputs, approval types, per-step run history | WDL, action metering, performance profiles, RPA, process mining, 30-day cap | Durable MySQL engine in-process; outbox-based table triggers; Fx expressions; never silently auto-disable; configurable retention |
| Connectors | OpenAPI import, operation schemas, webhook/poll trigger contracts, connection references in solutions, outbound-only agent | APIM hosting, certification marketplace, Business/Non-Business mixing, premium tier | All connectors included; credentials never leave the server; per-role operation grants; cross-platform self-updating agent |
| ALM | Locked vs editable mode per environment; stable component ids; dependency closure; deployment history | Layers, patches, staged upgrades, publishers/prefixes, managed properties | Upgrade-in-place with a previewed plan (schema diff, conflicts, destructive changes) and automatic pre-apply backup; Git-friendly YAML folder export |
| External sites | Relationship-scoped table access (mine / my org / related / all), page permissions, list/form/wizard blocks, captcha, private-by-default | Liquid, web templates, two data models, generic public Web API, per-visitor licensing | Block-scoped endpoints; publish-time security lint; write-through cache; local + OTP auth built in; dealer/vendor portal first |
| Agents | Description-driven tool choice, user-scoped retrieval, citations, MCP tools (Streamable HTTP), per-agent budgets, transcript retention | Topics/trigger phrases, voice, 20 bot channels, computer use, tenant graph grounding, harness zoo | One provider-agnostic runtime (incl. local models); tools run as the end user; permission-filtered hybrid RAG in MySQL; costs in INR; agents exposed as MCP |
| Analytics | Named measures with context, fiscal (April) date dimension, cross-filtering, drill to rows, KPI cards, scheduled delivery | DAX, M, in-memory engine, storage modes, XMLA, paginated reports | Live, security-trimmed SQL aggregates; one dashboard artefact with filters and alerts; OData feed for Excel/Power BI users |
| Identity and licensing | Least-privilege admin roles, MFA for admins, SSO option | Entra dependence, PIM, B2B guest model, per-user/per-app/PAYG licensing, request entitlements | Local accounts + OTP + optional OIDC; kiosk/shift accounts with PIN; one signed licence per install; protective rate limits only |
| Maker UX and collaboration | Environment switcher, pinned left nav, start-from-data, right-side panels, Ctrl+K search; apps/approvals/agents inside chat | Six separate portals; "go to Solutions to do it properly" | One portal; solution membership shown on every object; sector templates on Home; chat as a first-class host for apps, approvals and agents |

## Most important open decisions for the team

1. **Server-side Fx** (needed by table events, flows, formula columns, site conditions, agent tool validation). Decide how the server imports `src/fx` without breaking architecture rule 3.
2. **Delegation layer** (Query AST from Fx) to retire D10's row cap; it also powers analytics and agent table tools.
3. **Environment = schema per environment** vs a single schema with `env_id` columns. This research recommends schema-per-environment (clean backup/copy/restore, no cross-environment leaks), with security caches keyed by environment from day one.
4. **Upgrade-in-place solution import** with stable component ids — changes the "import always creates new instances" rule in architecture.md.
5. **Public exposure model** for sites and agents on an on-prem install (separate listener/host, reverse tunnel or VPS).

## Sources

Each file lists its own sources. Principal entry points:

- [Power Platform environments overview](https://learn.microsoft.com/power-platform/admin/environments-overview)
- [Important changes (deprecations) coming in Power Platform](https://learn.microsoft.com/power-platform/important-changes-coming)
- [Security concepts in Dataverse](https://learn.microsoft.com/power-platform/admin/wp-security-cds)
- [Delegation overview](https://learn.microsoft.com/power-apps/maker/canvas-apps/delegation-overview)
- [Limits of automated, scheduled, and instant flows](https://learn.microsoft.com/power-automate/limits-and-config)
- [Connectors architecture](https://learn.microsoft.com/connectors/connector-architecture)
- [Solution concepts](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm)
- [Power Pages security best practices](https://learn.microsoft.com/power-pages/security/security-best-practices)
- [Harnesses in Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/harnesses-overview)
- [Data refresh in Power BI](https://learn.microsoft.com/power-bi/connect-data/refresh-data)
- [Licensing overview for Power Platform](https://learn.microsoft.com/power-platform/admin/pricing-billing-skus)
- News (secondary): [The Register on Power Pages misconfigurations, 15 Nov 2024](https://www.theregister.com/2024/11/15/microsoft_power_pages_misconfigurations/)
